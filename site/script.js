/* ============================================================
   კონტროლიორების რუკა — script.js
   ------------------------------------------------------------
   DATA LAYER backend API-ს იძახებს (/api/reports, /api/activity).

   STOPS მასივი იტვირთება stops.js-დან. ერთი-და-იმავე-სახელის
   წყვილები (ერთი ფიზიკური გაჩერების ორი მიმართულება) გაერთიანებულია
   ერთ ჩანაწერში — `id` არის რეპორტინგის გასაღები (შესაძლოა
   კომპოზიტური, "id1+id2"), ხოლო `ids` შეიცავს ორიგინალ TTC
   stop-id(ebს), მომავალში მოსვლის დროების საპოვნელად:
   { id, ids: [...], name, lat, lng, types: ["bus","minibus"],
     routesBus: [...], routesMinibus: [...] }
   ============================================================ */

const STOPS_BY_ID = {};
STOPS.forEach((s) => (STOPS_BY_ID[s.id] = s));

/* ---------- DATA LAYER (backend API) ---------- */
const API_BASE = (() => {
  const { hostname, port } = window.location;
  // Live Server (5500) ან სხვა dev სერვერი — Node-ს port 3000-ზე ვიძახებთ
  if ((hostname === "localhost" || hostname === "127.0.0.1") && port !== "3000") {
    return `http://${hostname}:3000/api`;
  }
  return "/api";
})();
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

/* ---------- მოსვლის დროები (TTC API, server-ის მეშვეობით) ---------- */
function extractArrivals(rawResponse) {
  const list = Array.isArray(rawResponse) ? rawResponse : [];
  if (!list.length) return [];

  const now = Date.now();
  return list
    .map((item) => {
      const route = item.shortName != null ? String(item.shortName) : "?";
      const direction = item.headsign != null ? String(item.headsign) : "";
      const isRealtime = item.realtime === true;
      const minutes = isRealtime
        ? item.realtimeArrivalMinutes
        : item.scheduledArrivalMinutes;
      if (typeof minutes !== "number") return null;
      const etaMs = now + minutes * 60000;
      return { route, direction, etaMs, isRealtime, minutes };
    })
    .filter((a) => a !== null && a.minutes >= 0) // 0 წთ ("ახლა") ჩავრთოთ, მხოლოდ გასულები გამოვრიცხოთ
    .sort((a, b) => a.etaMs - b.etaMs);
}

async function fetchArrivals(ids) {
  try {
    const res = await fetch(`${API_BASE}/arrivals?ids=${encodeURIComponent(ids.join(","))}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    const stopsArr = Array.isArray(data.stops) ? data.stops : [];
    const all = stopsArr.flatMap((raw) => extractArrivals(raw));
    all.sort((a, b) => a.etaMs - b.etaMs);
    return all.slice(0, 4);
  } catch (err) {
    console.error("arrivals fetch failed:", err);
    return [];
  }
}

function formatEta(etaMs) {
  const minutes = Math.round((etaMs - Date.now()) / 60000);
  if (minutes <= 0) return "ახლა";
  if (minutes < 60) return `${minutes} წთ`;
  return clockTime(etaMs);
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

/* ---------- "ჩემი ლოკაცია" ---------- */
let userLocationMarker = null;

function showUserLocation(lat, lng) {
  if (userLocationMarker) {
    userLocationMarker.setLatLng([lat, lng]);
  } else {
    userLocationMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: '<div class="userDot"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);
  }
}

const LocateControl = L.Control.extend({
  options: { position: "bottomright" },
  onAdd: function () {
    const btn = L.DomUtil.create("button", "leaflet-control locateBtn");
    btn.type = "button";
    btn.title = "ჩემი ლოკაცია";
    btn.setAttribute("aria-label", "ჩემი ლოკაცია");
    btn.innerHTML = "📍";
    L.DomEvent.disableClickPropagation(btn);

    btn.addEventListener("click", () => {
      if (!navigator.geolocation) {
        showToast("გეოლოკაცია მხარდაუჭერელია 🙁");
        return;
      }
      btn.disabled = true;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          showUserLocation(latitude, longitude);
          map.setView([latitude, longitude], 16);
          btn.disabled = false;
        },
        () => {
          showToast("ლოკაციის წვდომა ვერ მოხერხდა 🙁");
          btn.disabled = false;
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    return btn;
  },
});
map.addControl(new LocateControl());

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
const sheetStatusBanner = document.getElementById("sheetStatusBanner");
const sheetCaption = document.getElementById("sheetCaption");
const sheetRouteChips = document.getElementById("sheetRouteChips");
const arrivalsList = document.getElementById("arrivalsList");
const btnInspector = document.getElementById("btnInspector");
const btnClear = document.getElementById("btnClear");
const sheetClose = document.getElementById("sheetClose");

let activeStopId = null;

function renderStatusBanner(report) {
  if (!report) {
    sheetStatusBanner.className = "statusBanner statusBanner--unknown";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--unknown"></span> სტატუსი უცნობია';
    sheetCaption.textContent = "ჯერ არავის შეუტყობინებია";
    return;
  }
  if (report.status === "inspector") {
    sheetStatusBanner.className = "statusBanner statusBanner--inspector";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--inspector"></span> კონტროლიორი დგას';
  } else {
    sheetStatusBanner.className = "statusBanner statusBanner--clear";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--clear"></span> თავისუფალია';
  }
  sheetCaption.textContent = `ბოლო შეტყობინება: ${timeAgo(report.ts)}`;
}

function renderRouteChips(stop) {
  const busChips = (stop.routesBus || []).map(
    (r) => `<span class="routeChip routeChip--bus">${r}</span>`
  );
  const miniChips = (stop.routesMinibus || []).map(
    (r) => `<span class="routeChip routeChip--minibus">${r}</span>`
  );
  const all = [...busChips, ...miniChips];
  sheetRouteChips.innerHTML = all.length
    ? all.join("")
    : `<span class="routeChip routeChip--empty">მარშრუტი უცნობია</span>`;
}

function renderArrivalsList(arrivals, stop) {
  if (!arrivals || arrivals.length === 0) {
    arrivalsList.innerHTML = `<p class="arrivalsNote">ამ გაჩერებისთვის მონაცემი ვერ მოიძებნა</p>`;
    return;
  }
  arrivalsList.innerHTML = arrivals
    .map((a) => {
      const isMinibus = (stop.routesMinibus || []).includes(a.route);
      const chipClass = isMinibus ? "routeChip--minibus" : "routeChip--bus";
      const realtimeBadge = a.isRealtime
        ? `<span class="arrivalItem__realtime" title="რეალური დრო">●</span>`
        : `<span class="arrivalItem__scheduled" title="განრიგით">○</span>`;
      return `
      <div class="arrivalItem">
        <span class="routeChip ${chipClass}">${a.route}</span>
        <span class="arrivalItem__direction">${a.direction || "—"}</span>
        <span class="arrivalItem__time">${realtimeBadge}${formatEta(a.etaMs)}</span>
      </div>`;
    })
    .join("");
}

async function loadArrivalsForStop(stopId, stop) {
  arrivalsList.innerHTML = `<p class="arrivalsNote">იტვირთება...</p>`;
  const arrivals = await fetchArrivals(stop.ids && stop.ids.length ? stop.ids : [stop.id]);
  if (activeStopId === stopId) renderArrivalsList(arrivals, stop);
}

function renderSheetInfo(stopId) {
  const stop = STOPS_BY_ID[stopId];
  const report = getReport(stopId);

  sheetStopName.textContent = stop.name;
  renderStatusBanner(report);
  renderRouteChips(stop);
}

function openSheet(stopId) {
  activeStopId = stopId;
  renderSheetInfo(stopId);
  overlay.classList.remove("hidden");
  sheet.classList.remove("hidden");
  loadArrivalsForStop(stopId, STOPS_BY_ID[stopId]);
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
  handleReportClick("inspector", "მადლობა! კონტროლიორი მონიშნულია");
});

btnClear.addEventListener("click", () => {
  handleReportClick("clear", "მადლობა! თავისუფალი მონიშნულია");
});

sheetClose.addEventListener("click", closeSheet);
overlay.addEventListener("click", closeSheet);

/* ---------- Burger menu ---------- */
const menuBtn = document.getElementById("menuBtn");
const menuOverlay = document.getElementById("menuOverlay");
const menuDrawer = document.getElementById("menuDrawer");
const menuClose = document.getElementById("menuClose");

function openMenu() {
  menuOverlay.classList.remove("hidden");
  menuDrawer.classList.remove("hidden");
}
function closeMenu() {
  menuOverlay.classList.add("hidden");
  menuDrawer.classList.add("hidden");
}
menuBtn.addEventListener("click", openMenu);
menuClose.addEventListener("click", closeMenu);
menuOverlay.addEventListener("click", closeMenu);

/* ---------- Activity toggle (mobile) ---------- */
const activityBtn = document.getElementById("activityBtn");
activityBtn.addEventListener("click", () => {
  activityPanel.classList.toggle("show");
});

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
  if (window.innerWidth < 768) {
    activityPanel.classList.toggle("show");
  }
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
        const allRoutes = [...(s.routesBus || []), ...(s.routesMinibus || [])];
        const meta = [typeLabel(s.types), allRoutes.length ? allRoutes.join(", ") : null]
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
  lucide.createIcons();
})();
