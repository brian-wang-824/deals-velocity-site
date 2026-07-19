-- Immutable deal snapshots are public; compact velocity state is private.
-- A publication row is inserted only after both Storage objects exist, so
-- readers can never discover a snapshot that has not finished uploading.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('deal-snapshots', 'deal-snapshots', true, 2097152, array['application/json']::text[]),
  ('deal-state', 'deal-state', false, 2097152, array['application/gzip']::text[])
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.deal_data_publications (
  version text primary key,
  parent_version text,
  scraped_at timestamptz not null unique,
  snapshot_path text not null unique,
  state_path text not null unique,
  snapshot_sha256 text not null,
  state_sha256 text not null,
  deal_count integer not null,
  published_at timestamptz not null default now(),
  constraint deal_data_version_is_sha256
    check (version ~ '^[0-9a-f]{64}$'),
  constraint deal_data_snapshot_sha256_valid
    check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  constraint deal_data_state_sha256_valid
    check (state_sha256 ~ '^[0-9a-f]{64}$'),
  constraint deal_data_version_matches_snapshot
    check (version = snapshot_sha256),
  constraint deal_data_parent_version_valid
    check (parent_version is null or parent_version ~ '^[0-9a-f]{64}$'),
  constraint deal_data_parent_version_is_not_self
    check (parent_version is null or parent_version <> version),
  constraint deal_data_snapshot_path_valid
    check (snapshot_path ~ '^v1/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{64}\.json$'),
  constraint deal_data_state_path_valid
    check (state_path ~ '^v1/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{64}\.json\.gz$'),
  constraint deal_data_count_nonnegative
    check (deal_count >= 0)
);

create index if not exists deal_data_publications_scraped_at_idx
  on public.deal_data_publications (scraped_at desc);

alter table public.deal_data_publications enable row level security;

-- Supabase projects can have permissive default grants for new public tables.
-- Remove them before opting the browser into only the harmless pointer fields.
revoke all on table public.deal_data_publications from public, anon, authenticated;
grant select (
  version,
  scraped_at,
  snapshot_path,
  snapshot_sha256,
  deal_count,
  published_at
) on table public.deal_data_publications to anon;

create policy "Deal publication pointers are publicly readable"
  on public.deal_data_publications
  for select
  to anon
  using (true);

grant select, insert, delete on table public.deal_data_publications to service_role;

-- Storage objects intentionally have no anon/authenticated policies. Public
-- bucket object GETs are available through Storage's public URL, while list,
-- upload, update, and delete operations still require the service role. The
-- private deal-state bucket has no unauthenticated read path at all.

create or replace function public.register_deal_data_publication(
  target_version text,
  target_parent_version text,
  target_scraped_at timestamptz,
  target_snapshot_path text,
  target_state_path text,
  target_snapshot_sha256 text,
  target_state_sha256 text,
  target_deal_count integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.deal_data_publications%rowtype;
  latest_version text;
  latest_scraped_at timestamptz;
begin
  if target_version is null
     or target_scraped_at is null
     or target_snapshot_path is null
     or target_state_path is null
     or target_snapshot_sha256 is null
     or target_state_sha256 is null
     or target_deal_count is null then
    raise exception 'Publication metadata cannot contain null values.';
  end if;

  -- Serialize publishers even if a workflow is manually dispatched while the
  -- scheduled run is still finishing.
  perform pg_advisory_xact_lock(hashtext('deal_data_publications'));

  select * into existing
  from public.deal_data_publications
  where version = target_version;

  if found then
    if existing.parent_version is not distinct from target_parent_version
       and existing.scraped_at = target_scraped_at
       and existing.snapshot_path = target_snapshot_path
       and existing.state_path = target_state_path
       and existing.snapshot_sha256 = target_snapshot_sha256
       and existing.state_sha256 = target_state_sha256
       and existing.deal_count = target_deal_count then
      return false;
    end if;
    raise exception 'Publication version already exists with different metadata.';
  end if;

  select version, scraped_at into latest_version, latest_scraped_at
  from public.deal_data_publications
  order by scraped_at desc
  limit 1;

  if latest_version is distinct from target_parent_version then
    raise exception 'Publication parent does not match the current version.';
  end if;

  if latest_scraped_at is not null and target_scraped_at <= latest_scraped_at then
    raise exception 'Publication is not newer than the current snapshot.';
  end if;

  insert into public.deal_data_publications (
    version,
    parent_version,
    scraped_at,
    snapshot_path,
    state_path,
    snapshot_sha256,
    state_sha256,
    deal_count
  ) values (
    target_version,
    target_parent_version,
    target_scraped_at,
    target_snapshot_path,
    target_state_path,
    target_snapshot_sha256,
    target_state_sha256,
    target_deal_count
  );

  return true;
end;
$$;

revoke all on function public.register_deal_data_publication(
  text, text, timestamptz, text, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.register_deal_data_publication(
  text, text, timestamptz, text, text, text, text, integer
) to service_role;
