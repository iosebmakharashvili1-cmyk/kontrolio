/* ============================================================
   კონტროლიორების რუკა — script.js
   ------------------------------------------------------------
   DATA LAYER backend API-ს იძახებს (/api/reports, /api/activity).

   STOPS მასივი იტვირთება stops.js-დან. ერთი-და-იმავე-სახელის
   წყვილები (ერთი ფიზიკური გაჩერების ორი მიმართულება) გაერთიანებულია
   ერთ ჩანაწერში — `id` არის რეპორტინგის გასაღები (შესაძლოა
   კომპოზიტური, "id1+id2"), ხოლო `ids` შეიცავს ორიგინალ TTC
   stop-id(ebს), მომავალში მოსვლის დროების საპოვნელად:
   { id, ids: [...], name, lat, lng, types: ["bus","minibus"], routes: [...] }
   ============================================================ */

const STOPS_BY_ID = {};
STOPS.forEach((s) => (STOPS_BY_ID[s.id] = s));

/* ---------- DATA LAYER (backend API) ---------- */
const API_BASE = "/api";
let reportsCache = {};

async function refreshReportsFromServer() {
  try {
    const res = await fetch(`${API_BASE}/reports`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    reportsCache = await res.json();
    return true;
  } catch (err) {
    console.error("reports fetch failed:", err);
    return false;
  }
}

function getReport(stopId) {
  return reportsCache[stopId] || null;
}

async function setReport(stopId, status, stopName) {
  const res = await fetch(`${API_BASE}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stopId, status, stopName }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const saved = await res.json();
  reportsCache[stopId] = { status: saved.status, ts: saved.ts };
  return reportsCache[stopId];
}

async function fetchActivity() {
  try {
    const res = await fetch(`${API_BASE}/activity`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("activity fetch failed:", err);
    return null;
  }
}

/* ---------- დროის ფორმატირება ---------- */
function timeAgo(ts) {
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "ახლახანს";
  if (min < 60) return `${min} წუთის წინ`;
  const hrs = Math.floor(min / 60);
  return `${hrs} საათის წინ`;
}

function clockTime(ts) {
  return new Intl.DateTimeFormat("ka-GE", {
    timeZone: "Asia/Tbilisi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function typeLabel(types) {
  const hasBus = types.includes("bus");
  const hasMini = types.includes("minibus");
  if (hasBus && hasMini) return "ავტობუსი + მინი";
  if (hasMini) return "მინიავტობუსი";
  return "ავტობუსი";
}

/* ---------- რუკის ინიციალიზაცია ---------- */
const map = L.map("map", {
  zoomControl: false,
  attributionControl: true,
  maxZoom: 19,
  zoomSnap: 0.5,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 90,
  easeLinearity: 0.2,
}).setView([41.7151, 44.8271], 12.5);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

/* 2000+ გაჩერებაა — ცალ-ცალკე მარკერების ნაცვლად, ვაჯგუფებთ
   კლასტერებად. კლასტერის ფერი აჯამებს მის შიგნით არსებულ
   სტატუსებს: წითელი, თუ შიგნით კონტროლიორია; მწვანე, თუ
   ყველაზე "ცხელი" სტატუსი თავისუფალია; სხვა შემთხვევაში ლურჯი. */
const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 55,
  disableClusteringAtZoom: 17,
  iconCreateFunction: (cluster) => {
    const childMarkers = cluster.getAllChildMarkers();
    const hasInspector = childMarkers.some((m) => m.options.reportStatus === "inspector");
    const hasClear = childMarkers.some((m) => m.options.reportStatus === "clear");

    let cls = "clusterIcon";
    if (hasInspector) cls += " clusterIcon--alert";
    else if (hasClear) cls += " clusterIcon--clear";

    return L.divIcon({
      html: `<div class="${cls}">${childMarkers.length}</div>`,
      className: "",
      iconSize: [38, 38],
    });
  },
});
map.addLayer(clusterGroup);

/* ---------- მარკერების შექმნა/განახლება ---------- */
const markers = {}; // stopId -> L.marker

const BUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/>
  <path d="M4 11h16"/>
  <circle cx="7.5" cy="19" r="1.5"/>
  <circle cx="16.5" cy="19" r="1.5"/>
</svg>`;

function statusClass(report) {
  if (!report) return "stopMarker--unknown";
  return report.status === "inspector" ? "stopMarker--inspector" : "stopMarker--clear";
}

function buildIcon(report) {
  return L.divIcon({
    className: "",
    html: `<div class="stopMarker ${statusClass(report)}">${BUS_SVG}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function renderAllMarkers() {
  STOPS.forEach((stop) => {
    const report = getReport(stop.id);
    const icon = buildIcon(report);

    if (markers[stop.id]) {
      markers[stop.id].setIcon(icon);
      markers[stop.id].options.reportStatus = report ? report.status : null;
    } else {
      const marker = L.marker([stop.lat, stop.lng], {
        icon,
        reportStatus: report ? report.status : null,
      });
      marker.on("click", () => openSheet(stop.id));
      markers[stop.id] = marker;
      clusterGroup.addLayer(marker);
    }
  });
  if (clusterGroup.refreshClusters) clusterGroup.refreshClusters();
}

function refreshMarker(stopId) {
  const report = getReport(stopId);
  const marker = markers[stopId];
  if (marker) {
    marker.setIcon(buildIcon(report));
    marker.options.reportStatus = report ? report.status : null;
    if (clusterGroup.refreshClusters) clusterGroup.refreshClusters(marker);
  }
}

/* ---------- Bottom sheet (გაჩერების შეტყობინება) ---------- */
const overlay = document.getElementById("overlay");
const sheet = document.getElementById("sheet");
const sheetStopName = document.getElementById("sheetStopName");
const sheetStatusLine = document.getElementById("sheetStatusLine");
const btnInspector = document.getElementById("btnInspector");
const btnClear = document.getElementById("btnClear");
const sheetClose = document.getElementById("sheetClose");

let activeStopId = null;

function renderSheetInfo(stopId) {
  const stop = STOPS_BY_ID[stopId];
  const report = getReport(stopId);

  const routesLine = stop.routes && stop.routes.length
    ? `მარშრუტები: ${stop.routes.join(", ")}`
    : "";

  sheetStopName.textContent = stop.name;
  sheetStatusLine.innerHTML = [
    typeLabel(stop.types),
    routesLine,
    report
      ? `ბოლო შეტყობინება: ${report.status === "inspector" ? "კონტროლიორი დგას" : "თავისუფალია"} — ${timeAgo(report.ts)}`
      : "ჯერ არავის შეუტყობინებია",
  ].filter(Boolean).join("<br>");
}

function openSheet(stopId) {
  activeStopId = stopId;
  renderSheetInfo(stopId);
  overlay.classList.remove("hidden");
  sheet.classList.remove("hidden");
}

function closeSheet() {
  overlay.classList.add("hidden");
  sheet.classList.add("hidden");
  activeStopId = null;
}

function setActionButtonsDisabled(disabled) {
  btnInspector.disabled = disabled;
  btnClear.disabled = disabled;
}

async function handleReportClick(status, successMsg) {
  if (!activeStopId) return;
  const stopId = activeStopId;
  const stop = STOPS_BY_ID[stopId];
  setActionButtonsDisabled(true);
  try {
    await setReport(stopId, status, stop ? stop.name : "");
    refreshMarker(stopId);
    showToast(successMsg);
    closeSheet();
  } catch (err) {
    showToast("შეცდომა — სცადე ისევ 🙁");
  } finally {
    setActionButtonsDisabled(false);
  }
}

btnInspector.addEventListener("click", () => {
  handleReportClick("inspector", "მადლობა! მონიშნულია — კონტროლიორი დგას 🔴");
});

btnClear.addEventListener("click", () => {
  handleReportClick("clear", "მადლობა! მონიშნულია — თავისუფალია 🟢");
});

sheetClose.addEventListener("click", closeSheet);
overlay.addEventListener("click", closeSheet);

/* ---------- About sheet ---------- */
const aboutBtn = document.getElementById("aboutBtn");
const aboutOverlay = document.getElementById("aboutOverlay");
const aboutSheet = document.getElementById("aboutSheet");
const aboutClose = document.getElementById("aboutClose");

aboutBtn.addEventListener("click", () => {
  aboutOverlay.classList.remove("hidden");
  aboutSheet.classList.remove("hidden");
});
function closeAbout() {
  aboutOverlay.classList.add("hidden");
  aboutSheet.classList.add("hidden");
}
aboutClose.addEventListener("click", closeAbout);
aboutOverlay.addEventListener("click", closeAbout);

/* ---------- Activity feed ----------
   მუდმივად ჩატანილი პანელია — დესკტოპზე sidebar, მუდმივად ღია;
   მობილურზე ქვედა drawer, header-ზე tap-ით იხსნება/იხურება.
   Poll-ი მუდმივად მუშაობს ფონში, ღია/დახურული რეჟიმის
   მიუხედავად. */
const activityPanel = document.getElementById("activityPanel");
const activityHeader = document.getElementById("activityHeader");
const activityPeek = document.getElementById("activityPeek");
const activityList = document.getElementById("activityList");

function formatActivityText(entry) {
  if (entry.status === "inspector") {
    return `${entry.stopName} გაჩერებაზე კონტროლიორი გამოჩნდა (${clockTime(entry.ts)})`;
  }
  return `${entry.stopName} გაჩერება თავისუფალია`;
}

function renderActivityList(entries) {
  if (!entries || entries.length === 0) {
    activityList.innerHTML = `<p class="activityEmpty">დღეს ჯერ არავის შეუტყობინებია</p>`;
    activityPeek.textContent = "დღეს ჯერ არავის შეუტყობინებია";
    return;
  }

  activityList.innerHTML = entries
    .map((entry) => {
      const dotClass = entry.status === "inspector" ? "activityItem__dot--inspector" : "activityItem__dot--clear";
      return `
        <div class="activityItem">
          <span class="activityItem__dot ${dotClass}"></span>
          <div class="activityItem__body">
            <div class="activityItem__text">${formatActivityText(entry)}</div>
            <div class="activityItem__time">${timeAgo(entry.ts)}</div>
          </div>
        </div>`;
    })
    .join("");

  activityPeek.textContent = `${formatActivityText(entries[0])} · ${timeAgo(entries[0].ts)}`;
}

async function loadAndRenderActivity() {
  const entries = await fetchActivity();
  if (entries) renderActivityList(entries);
}

activityHeader.addEventListener("click", () => {
  activityPanel.classList.toggle("expanded");
});

loadAndRenderActivity();
setInterval(loadAndRenderActivity, 10 * 1000);

/* ---------- Toast ---------- */
const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ---------- ძებნა ---------- */
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function renderSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    searchResults.classList.remove("show");
    searchResults.innerHTML = "";
    return;
  }

  const matches = STOPS.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8);

  if (matches.length === 0) {
    searchResults.innerHTML = `<div class="searchResult searchResult--empty">გაჩერება არ მოიძებნა</div>`;
  } else {
    searchResults.innerHTML = matches
      .map((s) => {
        const meta = [typeLabel(s.types), s.routes.length ? s.routes.join(", ") : null]
          .filter(Boolean)
          .join(" · ");
        return `<div class="searchResult" data-id="${s.id}">${s.name}<small>${meta}</small></div>`;
      })
      .join("");
  }
  searchResults.classList.add("show");
}

function goToStop(stopId) {
  const stop = STOPS_BY_ID[stopId];
  const marker = markers[stopId];
  if (!stop || !marker) return;

  searchResults.classList.remove("show");
  searchInput.value = stop.name;
  searchInput.blur();

  if (clusterGroup.zoomToShowLayer) {
    clusterGroup.zoomToShowLayer(marker, () => openSheet(stopId));
  } else {
    map.setView([stop.lat, stop.lng], 18);
    openSheet(stopId);
  }
}

const debouncedRenderSearchResults = debounce(renderSearchResults, 250);
searchInput.addEventListener("input", (e) => debouncedRenderSearchResults(e.target.value));
searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim()) renderSearchResults(searchInput.value);
});

searchResults.addEventListener("click", (e) => {
  const item = e.target.closest(".searchResult[data-id]");
  if (!item) return;
  goToStop(item.dataset.id);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".searchWrap")) searchResults.classList.remove("show");
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchResults.classList.remove("show");
    searchInput.blur();
  }
});

/* ---------- პერიოდული სინქრონიზაცია სერვერთან ----------
   სხვისი შეტყობინებები ავტომატურად გამოჩნდება ყველას რუკაზე,
   ყოველ 15 წამში ერთხელ poll-ის წყალობით. დღის გასუფთავებას
   (23:30-ზე) სერვერი თავად ამუშავებს. */
async function pollAndRender() {
  const ok = await refreshReportsFromServer();
  if (ok) {
    renderAllMarkers();
    if (activeStopId) renderSheetInfo(activeStopId);
  }
}

setInterval(pollAndRender, 15 * 1000);

/* ---------- გაშვება ---------- */
(async function init() {
  await refreshReportsFromServer();
  renderAllMarkers();
})();
