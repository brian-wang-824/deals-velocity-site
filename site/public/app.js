const REFRESH_INTERVAL_MINUTES = 10;
const PAGE_SIZE = 25;
const POLL_FOR_NEW_DATA_MS = 60_000; // check for a fresh deals.json every minute

let allDeals = [];
let scrapedAtIso = null;
let currentPage = 1;
let countdownTimer = null;

const els = {
  search: document.getElementById("search"),
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

function formatDelta(value) {
  if (value == null || Number.isNaN(Number(value))) return "pending";
  const amount = Number(value);
  if (amount > 0) return `+${amount}`;
  return `${amount}`;
}

function renderMetricIcon(type) {
  const icons = {
    votes: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 7.2 7.8 2h1.4l-.5 4.2h4.1l-1.4 7.2H4.2V7.2h1.1Z"/><path d="M2.2 7.2h2v6.2h-2z"/></svg>`,
    comments: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.2h11v7.4h-5L5.2 14v-3.4H2.5V3.2Z"/></svg>`,
    velocity: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 10.8h2.1l1.7-5.6 3.1 7.7 2-4.1h2.3v1.8h-1.2l-3.3 3.2-2.7-6.6-1 3.6h-3z"/></svg>`,
    delta: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6 14 13H2L8 2.6Z"/></svg>`,
  };
  return icons[type] || "";
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

function applyFiltersAndSort() {
  const q = els.search.value.trim().toLowerCase();
  const sort = els.sort.value;

  let filtered = allDeals;
  if (q) {
    filtered = filtered.filter(
      (d) => d.title.toLowerCase().includes(q) || (d.store || "").toLowerCase().includes(q)
    );
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
          <span class="velocity-badge ${velocityBadgeClass(d.velocity_label)} shrink-0">${escapeHtml(d.velocity_label)}</span>
        </div>
        <div class="mt-auto space-y-3">
          <div>
            ${renderPriceLine(d, discount)}
            <p class="truncate text-xs text-zinc-500">${escapeHtml(d.store || "Unknown store")}</p>
          </div>
          <div class="grid grid-cols-4 gap-2 border-t border-zinc-800 pt-3 text-xs">
            <span class="deal-metric metric-votes">${renderMetricIcon("votes")}<strong>${d.votes ?? 0}</strong><small>votes</small></span>
            <span class="deal-metric metric-comments">${renderMetricIcon("comments")}<strong>${d.comments ?? 0}</strong><small>comments</small></span>
            <span class="deal-metric metric-velocity">${renderMetricIcon("velocity")}<strong>${formatVelocity(d.recent_velocity)}</strong><small>velocity</small></span>
            <span class="deal-metric metric-delta">${renderMetricIcon("delta")}<strong>${formatDelta(d.vote_delta)}</strong><small>delta</small></span>
          </div>
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
