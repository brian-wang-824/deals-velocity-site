const REFRESH_INTERVAL_MINUTES = 10;
const PAGE_SIZE = 25;
const POLL_FOR_NEW_DATA_MS = 60_000; // check for a fresh deals.json every minute

let allDeals = [];
let scrapedAtIso = null;
let currentPage = 1;
let countdownTimer = null;

const els = {
  search: document.getElementById("search"),
  velocityFilter: document.getElementById("velocity-filter"),
  sort: document.getElementById("sort"),
  dealsList: document.getElementById("deals-list"),
  pagination: document.getElementById("pagination"),
  resultsMeta: document.getElementById("results-meta"),
  lastUpdated: document.getElementById("last-updated"),
  nextRefresh: document.getElementById("next-refresh"),
};

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

function applyFiltersAndSort() {
  const q = els.search.value.trim().toLowerCase();
  const velocity = els.velocityFilter.value;
  const sort = els.sort.value;

  let filtered = allDeals;
  if (q) {
    filtered = filtered.filter(
      (d) => d.title.toLowerCase().includes(q) || (d.store || "").toLowerCase().includes(q)
    );
  }
  if (velocity !== "all") {
    filtered = filtered.filter((d) => d.velocity_label === velocity);
  }

  const sorted = [...filtered];
  if (sort === "votes") sorted.sort((a, b) => b.votes - a.votes);
  else if (sort === "comments") sorted.sort((a, b) => b.comments - a.comments);
  else if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === "posted") sorted.sort((a, b) => (b.posted_time || "").localeCompare(a.posted_time || ""));
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
    <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener" class="deal-card group">
      <div class="relative aspect-square overflow-hidden border-b border-zinc-800 bg-zinc-900">
        <img src="${escapeHtml(d.image_url || "")}" alt="" loading="lazy"
             class="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
        ${discount ? `<span class="absolute left-2 top-2 rounded bg-emerald-400 px-2 py-1 text-xs font-bold text-zinc-950">${discount}</span>` : ""}
      </div>
      <div class="flex min-h-40 flex-col gap-3 p-3">
        <div class="flex items-start justify-between gap-2">
          <p class="line-clamp-3 text-sm font-semibold leading-5 text-zinc-100">${escapeHtml(d.title)}</p>
          <span class="velocity-badge ${velocityBadgeClass(d.velocity_label)} shrink-0">${escapeHtml(d.velocity_label)}</span>
        </div>
        <div class="mt-auto space-y-3">
          <div>
            <p class="text-xl font-semibold text-white">${d.price ? escapeHtml(d.price) : "See deal"}</p>
            <p class="truncate text-xs text-zinc-500">${escapeHtml(d.store || "Unknown store")}</p>
          </div>
          <div class="grid grid-cols-3 gap-2 border-t border-zinc-800 pt-3 text-xs">
            <span><strong>${d.votes ?? 0}</strong><small>votes</small></span>
            <span><strong>${d.comments ?? 0}</strong><small>talk</small></span>
            <span><strong>${formatVelocity(d.recent_velocity)}</strong><small>velocity</small></span>
          </div>
        </div>
      </div>
    </a>`;
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

els.search.addEventListener("input", () => {
  currentPage = 1;
  renderDeals();
});
els.velocityFilter.addEventListener("change", () => {
  currentPage = 1;
  renderDeals();
});
els.sort.addEventListener("change", () => {
  currentPage = 1;
  renderDeals();
});

loadDeals();
setInterval(() => loadDeals({ silent: true }), POLL_FOR_NEW_DATA_MS);
