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
  };
  return map[label] || "velocity-flat";
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

  if (pageItems.length === 0) {
    els.dealsList.innerHTML = `<p class="text-center text-gray-500 py-12">No deals match your filters.</p>`;
  } else {
    els.dealsList.innerHTML = pageItems
      .map(
        (d) => `
      <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener"
         class="flex gap-3 rounded-lg border border-gray-200 bg-white p-3 hover:border-gray-300 hover:shadow-sm transition">
        <img src="${escapeHtml(d.image_url || "")}" alt="" loading="lazy"
             class="h-16 w-16 rounded-md object-cover bg-gray-100 flex-shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <p class="text-sm font-medium truncate">${escapeHtml(d.title)}</p>
            <span class="velocity-badge ${velocityBadgeClass(d.velocity_label)} flex-shrink-0">${escapeHtml(d.velocity_label)}</span>
          </div>
          <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(d.store || "")}</p>
          <div class="flex items-center gap-3 mt-1 text-xs text-gray-600">
            <span>${d.price ? escapeHtml(d.price) : ""}</span>
            ${d.discount_percentage ? `<span class="text-green-700">-${d.discount_percentage}%</span>` : ""}
            <span>👍 ${d.votes}</span>
            <span>💬 ${d.comments}</span>
            ${d.recent_velocity != null ? `<span>${d.recent_velocity}/hr</span>` : ""}
          </div>
        </div>
      </a>`
      )
      .join("");
  }

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  if (totalPages <= 1) {
    els.pagination.innerHTML = "";
    return;
  }
  const buttons = [];
  for (let p = 1; p <= totalPages; p++) {
    buttons.push(
      `<button data-page="${p}" class="px-3 py-1 rounded-md text-sm ${
        p === currentPage ? "bg-gray-900 text-white" : "bg-white border border-gray-300"
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
      els.nextRefresh.textContent = "Refreshing shortly…";
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
      els.dealsList.innerHTML = `<p class="text-center text-red-600 py-12">Couldn't load deals data. Try refreshing the page.</p>`;
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
