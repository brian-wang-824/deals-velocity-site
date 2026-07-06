const REFRESH_INTERVAL_MINUTES = 10;
const PAGE_SIZE = 25;
const POLL_FOR_NEW_DATA_MS = 60_000; // check for a fresh deals.json every minute
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const POST_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  ...(LOCAL_TIME_ZONE ? { timeZone: LOCAL_TIME_ZONE } : {}),
});
const HAS_DOCUMENT = typeof document !== "undefined";

let allDeals = [];
let scrapedAtIso = null;
let currentPage = 1;
let countdownTimer = null;

const els = HAS_DOCUMENT
  ? {
      search: document.getElementById("search"),
      sort: document.getElementById("sort"),
      dealsList: document.getElementById("deals-list"),
      pagination: document.getElementById("pagination"),
      resultsMeta: document.getElementById("results-meta"),
      lastUpdated: document.getElementById("last-updated"),
      nextRefresh: document.getElementById("next-refresh"),
    }
  : {};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatRelativeTime(iso) {
  if (!iso) return "unknown";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

function getPostTimeMs(iso) {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function formatPostTime(iso) {
  const time = getPostTimeMs(iso);
  if (time === Number.NEGATIVE_INFINITY) return "unknown";
  return POST_TIME_FORMATTER.format(new Date(time));
}

function sortDealsByNewest(deals) {
  return deals
    .map((deal, index) => ({ deal, index }))
    .sort((a, b) => {
      const aTime = getPostTimeMs(a.deal.posted_time);
      const bTime = getPostTimeMs(b.deal.posted_time);
      if (aTime !== bTime) return bTime - aTime;
      return a.index - b.index;
    })
    .map(({ deal }) => deal);
}

function velocityBadgeClass(label) {
  const map = {
    surging: "velocity-surging",
    hot: "velocity-hot",
    warming: "velocity-warming",
    slow: "velocity-slow",
    flat: "velocity-flat",
    cooling: "velocity-cooling",
    "needs second scrape": "velocity-pending",
  };
  return map[label] || "velocity-flat";
}

function formatDiscount(value) {
  if (value == null || Number.isNaN(Number(value)) || Number(value) <= 0) return "";
  return `-${Math.round(Number(value))}%`;
}

function formatVelocity(value) {
  if (value == null || Number.isNaN(Number(value))) return "pending";
  return `${Number(value).toFixed(1)}/hr`;
}

function formatDelta(value) {
  if (value == null || Number.isNaN(Number(value))) return "pending";
  const amount = Number(value);
  if (amount > 0) return `+${amount}`;
  return `${amount}`;
}

function renderMetricIcon(type) {
  const icons = {
    votes: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 7.2 7.8 2h1.4l-.5 4.2h4.1l-1.4 7.2H4.2V7.2h1.1Z"/><path d="M2.2 7.2h2v6.2h-2z"/></svg>`,
  };
  return icons[type] || "";
}

function momentumChipClass(d) {
  if (d.vote_delta == null || Number.isNaN(Number(d.vote_delta))) return "momentum-pending";
  const delta = Number(d.vote_delta);
  if (delta > 0) return "momentum-positive";
  if (delta < 0) return "momentum-negative";
  return "momentum-flat";
}

function renderMomentumChip(d) {
  const hasDelta = d.vote_delta != null && !Number.isNaN(Number(d.vote_delta));
  const hasVelocity = d.recent_velocity != null && !Number.isNaN(Number(d.recent_velocity));
  const label = hasDelta || hasVelocity
    ? `${formatDelta(d.vote_delta)} | ${formatVelocity(d.recent_velocity)}`
    : "pending";

  return `<span class="momentum-chip ${momentumChipClass(d)}">${escapeHtml(label)}</span>`;
}

function renderPriceLine(d, discount) {
  const currentPrice = d.price ? escapeHtml(d.price) : "See deal";
  const referencePrice = d.original_price ? escapeHtml(d.original_price) : "";

  return `
    <div class="deal-price-row">
      <span class="deal-price">${currentPrice}</span>
      ${referencePrice ? `<span class="deal-reference-price">${referencePrice}</span>` : ""}
      ${discount ? `<span class="deal-discount">${discount}</span>` : ""}
    </div>`;
}

function renderPostedTime(d) {
  const formatted = formatPostTime(d.posted_time);
  if (formatted === "unknown") {
    return `<p class="deal-posted-time">Posted unknown</p>`;
  }

  return `<p class="deal-posted-time">Posted <time datetime="${escapeHtml(d.posted_time)}">${escapeHtml(formatted)}</time></p>`;
}

function renderVoteMetric(d) {
  return `<span class="deal-metric metric-votes">${renderMetricIcon("votes")}<strong>${d.votes ?? 0}</strong></span>`;
}

function applyFiltersAndSort() {
  const q = els.search.value.trim().toLowerCase();
  const sort = els.sort.value;

  let filtered = allDeals;
  if (q) {
    filtered = filtered.filter(
      (d) => d.title.toLowerCase().includes(q) || (d.store || "").toLowerCase().includes(q)
    );
  }
  let sorted = [...filtered];
  if (sort === "votes") sorted.sort((a, b) => b.votes - a.votes);
  else if (sort === "posted") sorted = sortDealsByNewest(filtered);
  // "velocity" (default) keeps the server-computed order from deals.json

  return sorted;
}

function renderDeals() {
  const filtered = applyFiltersAndSort();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  const end = Math.min(start + pageItems.length, filtered.length);

  els.resultsMeta.textContent = filtered.length
    ? `Showing ${start + 1}-${end} of ${filtered.length} deals`
    : "No matching deals";

  if (pageItems.length === 0) {
    els.dealsList.innerHTML = `<p class="col-span-full py-16 text-center text-sm text-zinc-500">No deals match your filters.</p>`;
  } else {
    els.dealsList.innerHTML = pageItems.map(renderDealCard).join("");
  }

  renderPagination(totalPages);
}

function renderDealCard(d) {
  const discount = formatDiscount(d.discount_percentage);

  return `
    <article class="deal-card group">
      <div class="relative aspect-square overflow-hidden border-b border-zinc-800 bg-zinc-900">
        <img src="${escapeHtml(d.image_url || "")}" alt="" loading="lazy"
             class="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
      </div>
      <div class="flex min-h-40 flex-col gap-3 p-3">
        <div class="deal-title-row">
          <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener"
             class="line-clamp-3 text-sm font-semibold leading-5 text-zinc-100 transition hover:text-emerald-300">
            ${escapeHtml(d.title)}
          </a>
          <div class="deal-signal-stack">
            <span class="velocity-badge ${velocityBadgeClass(d.velocity_label)}">${escapeHtml(d.velocity_label)}</span>
            ${renderMomentumChip(d)}
          </div>
        </div>
        <div class="deal-bottom-row">
          <div class="min-w-0">
            ${renderPriceLine(d, discount)}
            <p class="truncate text-xs text-zinc-500">${escapeHtml(d.store || "Unknown store")}</p>
            ${renderPostedTime(d)}
          </div>
          ${renderVoteMetric(d)}
        </div>
      </div>
    </article>`;
}

function renderPagination(totalPages) {
  if (totalPages <= 1) {
    els.pagination.innerHTML = "";
    return;
  }
  const buttons = [];
  for (let p = 1; p <= totalPages; p++) {
    buttons.push(
      `<button data-page="${p}" class="rounded-md px-3 py-1 text-sm transition ${
        p === currentPage
          ? "bg-emerald-300 text-zinc-950"
          : "border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600"
      }">${p}</button>`
    );
  }
  els.pagination.innerHTML = buttons.join("");
  els.pagination.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPage = Number(btn.dataset.page);
      renderDeals();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function renderCountdown() {
  if (!scrapedAtIso) return;
  const nextRefresh = new Date(new Date(scrapedAtIso).getTime() + REFRESH_INTERVAL_MINUTES * 60_000);

  clearInterval(countdownTimer);
  function tick() {
    const msLeft = nextRefresh - Date.now();
    els.lastUpdated.textContent = `Updated ${formatRelativeTime(scrapedAtIso)}`;
    if (msLeft <= 0) {
      els.nextRefresh.textContent = "Refreshing shortly...";
      return;
    }
    const mins = Math.floor(msLeft / 60_000);
    const secs = Math.floor((msLeft % 60_000) / 1000);
    els.nextRefresh.textContent = `Next refresh in ${mins}m ${secs}s`;
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function loadDeals({ silent = false } = {}) {
  try {
    const res = await fetch(`/data/deals.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const isNewSnapshot = data.scraped_at !== scrapedAtIso;
    allDeals = data.deals || [];
    scrapedAtIso = data.scraped_at;

    if (!silent || isNewSnapshot) {
      renderDeals();
    }
    renderCountdown();
  } catch (err) {
    if (!silent) {
      els.dealsList.innerHTML = `<p class="col-span-full py-16 text-center text-sm text-red-300">Couldn't load deals data. Try refreshing the page.</p>`;
    }
    console.error("Failed to load deals.json", err);
  }
}

if (HAS_DOCUMENT) {
  els.search.addEventListener("input", () => {
    currentPage = 1;
    renderDeals();
  });
  els.sort.addEventListener("change", () => {
    currentPage = 1;
    renderDeals();
  });

  loadDeals();
  setInterval(() => loadDeals({ silent: true }), POLL_FOR_NEW_DATA_MS);
}

if (typeof module !== "undefined") {
  module.exports = {
    formatPostTime,
    getPostTimeMs,
    sortDealsByNewest,
  };
}
