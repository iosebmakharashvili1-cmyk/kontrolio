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
  if ((hostname === "localhost" || hostname === "127.0.0.1") && port !== "3000") {
    return `http://${hostname}:3000/api`;
  }
  return "/api";
})();
let reportsCache = {};

/* ---------- სესიის იდენტიფიკატორი ----------
   ერთი და იგივე sid გამოიყენება heartbeat-ისთვის (ონლაინ მთვლელი) და
   report-ების დადასტურების დათვლისთვის. sessionStorage-ში ცოცხლობს
   მხოლოდ ტაბის გახსნის განმავლობაში — მუდმივი იდენტიფიკატორი არაა. */
function getSid() {
  let sid = sessionStorage.getItem("_kontrolio_sid");
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    sessionStorage.setItem("_kontrolio_sid", sid);
  }
  return sid;
}

async function refreshReportsFromServer() {
  try {
    const res = await fetch(`${API_BASE}/reports?sid=${encodeURIComponent(getSid())}`, { cache: "no-store" });
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

/* inspector report-ი 2 საათზე უფრო ძველია და "clear" არ მოჰყოლია — stale */
const STALE_MS = 2 * 60 * 60 * 1000;
function isStale(report) {
  if (!report || report.status !== "inspector") return false;
  return Date.now() - report.ts > STALE_MS;
}

async function setReport(stopId, status, stopName) {
  const res = await fetch(`${API_BASE}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stopId, status, stopName, sid: getSid() }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const saved = await res.json();
  reportsCache[stopId] = {
    status: saved.status,
    ts: saved.ts,
    confirmCount: saved.confirmCount,
    reportsToday: saved.reportsToday,
    viewerCount: (reportsCache[stopId] && reportsCache[stopId].viewerCount) || 0,
  };
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
    .filter((a) => a !== null && a.minutes >= 0)
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
  if (minutes < 0) return "ახლა";
  if (minutes === 0) return "0 წთ";
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

/* სერვისის დღის გასაღები (თბილისის დროით) — server-ის serviceDayKey-ის
   იგივე ლოგიკა, "დღეს დაეხმარე X ადამიანს"-ის localStorage-ბაკეტისთვის. */
function tbilisiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function typeLabel(types) {
  const hasBus = types.includes("bus");
  const hasMini = types.includes("minibus");
  if (hasBus && hasMini) return "ავტობუსი + მინი";
  if (hasMini) return "მინიავტობუსი";
  return "ავტობუსი";
}

/* innerHTML-ში ჩასასმელი ნებისმიერი დინამიური სტრინგი (server-ის,
   TTC-ის, ან ჩვენი stops.js-ის მონაცემიდანაც) ამით ვატარებთ —
   defense-in-depth, რომ ერთმა "feed" ცვლილებამ მომავალში
   ისევ XSS არ გამოაჩინოს. */
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ============================================================
   THEME SYSTEM (light / dark)
   ------------------------------------------------------------
   - ავტომატური: ღამით (00:00–07:00) dark, დანარჩენი light
   - ხელით toggle localStorage-ში ინახება
   - ბნელი რუკა მიიღწევა CSS filter-ით (style.css-ში)
   ============================================================ */
const THEME_KEY = "kontrolio-theme";
const THEME_MANUAL_KEY = "kontrolio-theme-manual";

function getSystemTheme() {
  return isNightTime() ? "dark" : "light";
}

function getSavedTheme() {
  if (localStorage.getItem(THEME_MANUAL_KEY) === "true") {
    return localStorage.getItem(THEME_KEY) || "light";
  }
  return getSystemTheme();
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeIcon(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  localStorage.setItem(THEME_MANUAL_KEY, "true");
  setTheme(next);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById("themeIcon");
  if (!icon) return;
  icon.setAttribute("data-lucide", theme === "dark" ? "moon" : "sun");
  if (window.lucide) lucide.createIcons();
}

/* ---------- რუკის ინიციალიზაცია ---------- */
const map = L.map("map", {
  zoomControl: false,
  attributionControl: true,
  maxZoom: 19,
  zoomSnap: 0,               // 0 რთავს იდეალურად გლუვ (fractional) ზუმს თაჩპედზე და სქროლზე
  zoomDelta: 1,              // + და - ღილაკები სტანდარტულად 1 სრულ დონეს დააზუმებს (ბევრად ბუნებრივია)
  wheelPxPerZoomLevel: 100,  // რამდენად სწრაფად დაზუმოს მაუსის ბორბალმა (რაც მეტია რიცხვი, მით უფრო რბილია)
  zoomAnimation: true,
  markerZoomAnimation: true,
  fadeAnimation: true
}).setView([41.7151, 44.8271], 12.5);

L.control.zoom({ position: "bottomright" }).addTo(map);

/* გაჩერების არჩევისას მისი მარშრუტების ხაზები ჩნდება ამ pane-ში —
   ტაილებზე მაღლა, მარკერებზე დაბლა. */
map.createPane("routeHighlightPane");
map.getPane("routeHighlightPane").style.zIndex = 450;
map.getPane("routeHighlightPane").style.pointerEvents = "none";

/* ---------- Tile layers ---------- */
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

/* ---------- "ჩემი ლოკაცია" ---------- */
let userLocationMarker = null;

/* შენახული ლოკაცია localStorage-ში — მომდევნო ვიზიტზე ავტომატურად
   გამოჩნდეს, სანამ ბრაუზერისგან ახალი, ცოცხალი პოზიცია მოვა. */
const USER_LOCATION_KEY = "kontrolio-user-location";

function saveUserLocation(lat, lng) {
  try {
    localStorage.setItem(USER_LOCATION_KEY, JSON.stringify({ lat, lng, ts: Date.now() }));
  } catch (_) {}
}

function loadSavedUserLocation() {
  try {
    const raw = localStorage.getItem(USER_LOCATION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.lat !== "number" || typeof data.lng !== "number") return null;
    return data;
  } catch (_) {
    return null;
  }
}

function showUserLocation(lat, lng, { persist = true } = {}) {
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
  if (persist) saveUserLocation(lat, lng);
}

/* გვერდის ჩატვირთვისას წინა სესიის ლოკაცია მაშინვე ვაჩვენოთ
   (marker-ის სახით, ცენტრირების გარეშე), შემდეგ კი ცოცხალი
   პოზიციით განვაახლოთ თუ ბრაუზერი დართავს. */
function restoreSavedUserLocation() {
  const saved = loadSavedUserLocation();
  if (!saved) return;
  showUserLocation(saved.lat, saved.lng, { persist: false });
}

function tryAutoUpdateUserLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      showUserLocation(pos.coords.latitude, pos.coords.longitude);
    },
    () => {
      /* წყნარად ჩავარდეს — მომხმარებელს შენახული ლოკაცია მაინც უჩანს */
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5 * 60 * 1000 }
  );
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

/* ---------- კლასტერები ---------- */
const CLUSTER_COLORS = {
  inspector: "var(--red)",
  stale: "#d97706",
  clear: "var(--green)",
  unknown: "var(--bus-blue)",
};
/* რიგითობა განსაზღვრავს pie slice-ების თანმიმდევრობას */
const CLUSTER_STATUS_ORDER = ["inspector", "stale", "clear", "unknown"];

const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 55,
  disableClusteringAtZoom: 17,
  iconCreateFunction: (cluster) => {
    const childMarkers = cluster.getAllChildMarkers();

    /* თითოეული სტატუსის მარკერების დათვლა კლასტერში.
       "unknown" ფერად არ ითვლება — ისევე, როგორც თავდაპირველ ვერსიაში,
       მისი არსებობა pie-ს არ ცვლის და მხოლოდ მაშინ ჩანს (ლურჯად),
       თუ კლასტერში საერთოდ არაფერია მონიშნული. */
    const counts = { inspector: 0, stale: 0, clear: 0 };
    childMarkers.forEach((m) => {
      const s = m.options.reportStatus;
      if (s in counts) counts[s] += 1;
    });
    const coloredTotal = counts.inspector + counts.stale + counts.clear;
    const presentStatuses = CLUSTER_STATUS_ORDER.filter((s) => s !== "unknown" && counts[s] > 0);

    let bg;
    let extraCls = "";
    if (presentStatuses.length === 0) {
      /* არცერთი მონიშნული გაჩერება — ძველებურად ლურჯი */
      bg = CLUSTER_COLORS.unknown;
    } else if (presentStatuses.length === 1) {
      /* ერთი ფერი — მარტივი მთლიანი წრე, ისე როგორც ადრე იყო */
      const only = presentStatuses[0];
      bg = CLUSTER_COLORS[only];
      if (only === "inspector") extraCls = " clusterIcon--alert";
    } else {
      /* რამდენიმე ფერი ერთ არეალში — conic-gradient pie, პროპორციული
         წილებით, რომ თითოეული სტატუსი ვიზუალურად ჩანდეს */
      let acc = 0;
      const stops = presentStatuses.map((s) => {
        const from = (acc / coloredTotal) * 360;
        acc += counts[s];
        const to = (acc / coloredTotal) * 360;
        return `${CLUSTER_COLORS[s]} ${from}deg ${to}deg`;
      });
      bg = `conic-gradient(${stops.join(", ")})`;
      if (counts.inspector > 0) extraCls = " clusterIcon--alert";
    }

    return L.divIcon({
      html: `<div class="clusterIcon${extraCls}" style="background:${bg};"><span>${childMarkers.length}</span></div>`,
      className: "",
      iconSize: [38, 38],
    });
  },
});
map.addLayer(clusterGroup);

/* ---------- მარკერები ---------- */
const markers = {};

const BUS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6z"/>
  <path d="M4 11h16"/>
  <circle cx="7.5" cy="19" r="1.5"/>
  <circle cx="16.5" cy="19" r="1.5"/>
</svg>`;

function statusClass(report) {
  if (!report) return "stopMarker--unknown";
  if (isStale(report)) return "stopMarker--stale";
  return report.status === "inspector" ? "stopMarker--inspector" : "stopMarker--clear";
}

/* ვიზუალური სტატუსი — ეს ის ფერია, რასაც მომხმარებელი მარკერზე რეალურად ხედავს
   (inspector/clear/stale/unknown), განსხვავებით report.status-გან, რომელიც
   stale-ს არ ითვალისწინებს. კლასტერების შეღებვა სწორედ ამაზეა დამოკიდებული. */
function visualStatus(report) {
  if (!report) return "unknown";
  if (isStale(report)) return "stale";
  return report.status === "inspector" ? "inspector" : "clear";
}

function buildIcon(report, isSelected) {
  const cls = `stopMarker ${statusClass(report)}${isSelected ? " stopMarker--selected" : ""}`;
  return L.divIcon({
    className: "",
    html: `<div class="${cls}">${BUS_SVG}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function renderAllMarkers() {
  STOPS.forEach((stop) => {
    const report = getReport(stop.id);
    const icon = buildIcon(report, stop.id === selectedStopId);

    if (markers[stop.id]) {
      markers[stop.id].setIcon(icon);
      markers[stop.id].options.reportStatus = visualStatus(report);
    } else {
      const marker = L.marker([stop.lat, stop.lng], {
        icon,
        reportStatus: visualStatus(report),
      });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openSheet(stop.id);
      });
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
    marker.setIcon(buildIcon(report, stopId === selectedStopId));
    marker.options.reportStatus = visualStatus(report);
    if (clusterGroup.refreshClusters) clusterGroup.refreshClusters(marker);
  }
}

/* ============================================================
   მარშრუტების ხაზები რუკაზე (ROUTES routes.js-დან)
   ------------------------------------------------------------
   გაჩერებაზე დაჭერისას მისი ყველა მარშრუტი ჩნდება რუკაზე — სუფთა
   ფერადი ხაზით, თხელი თეთრი halo-თი (Google Maps transit style).
   თითოეული ხაზისთვის გაჩერებასთან ახლოს ჩნდება პატარა "აბი"
   ნომრით; თუ რამდენიმე მარშრუტი ერთი და იმავე გზით გადის, მათი
   ნომრები ერთ აბშივ ჯგუფდება — ცალკეული ხაზები აღარ ერევა.
   მონიშვნა რჩება მანამ, სანამ სხვა გაჩერებას არ ავირჩევთ. ----- */
let selectedStopId = null;
let visibleRouteNums = new Set();
const routeHighlightLayer = L.layerGroup([], { pane: "routeHighlightPane" }).addTo(map);

const ROUTE_LINE_COLOR = {
  bus: "#2ec4b6",
  minibus: "#1f6fd6",
  seasonal: "#a855f7",
};

function drawRouteLine(dirGeom, type, isSeasonal) {
  const color = isSeasonal ? ROUTE_LINE_COLOR.seasonal : ROUTE_LINE_COLOR[type];
  const halo = L.polyline(dirGeom.coords, {
    pane: "routeHighlightPane",
    color: "#ffffff",
    weight: 6.5,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  });
  const line = L.polyline(dirGeom.coords, {
    pane: "routeHighlightPane",
    color,
    weight: 4,
    opacity: 1,
    lineCap: "round",
    lineJoin: "round",
    dashArray: isSeasonal ? "1 7" : null,
    interactive: false,
  });
  halo.addTo(routeHighlightLayer);
  line.addTo(routeHighlightLayer);
}

function clearRouteHighlight() {
  routeHighlightLayer.clearLayers();
}

function stopRouteNums(stop) {
  const seen = new Set();
  const out = [];
  [...(stop.routesBus || []), ...(stop.routesMinibus || []), ...(stop.routesSeasonal || [])].forEach(
    (rn) => {
      if (!seen.has(rn)) {
        seen.add(rn);
        out.push(rn);
      }
    }
  );
  return out;
}

/* ერთი route_num-ის ორივე მიმართულება ვხატავთ — stops.js-ში
   გაჩერებები უკვე ორივე-მიმართულებიანი წყვილებია გაერთიანებული,
   ამიტომ ეს არქიტექტურულად თანმიმდევრულია.
   ნომრები განზრახ აღარ იწერება ხაზებზე — 5-8 გადამკვეთი
   მარშრუტის დროს ტექსტი ყოველთვის გადატვირთული გამოიყურება.
   რუკა სუფთა ფერადი ხაზებით რჩება (ტიპი ფერით იკითხება), ზუსტი
   ნომრები ჩანს sheet-ის chip-ებში — chip-ზე დაჭერით კონკრეტული
   მარშრუტი ერთფრადად ირთვება/ითიშება რუკაზე. */
function highlightRoutesForStop(stop) {
  clearRouteHighlight();
  if (typeof ROUTES === "undefined") return;

  stopRouteNums(stop).forEach((rn) => {
    if (!visibleRouteNums.has(rn)) return;
    const route = ROUTES[rn];
    if (!route) return;
    route.dirs.forEach((d) => drawRouteLine(d, route.type, route.seasonal));
  });
}

function selectStop(stopId) {
  const prev = selectedStopId;
  if (prev === stopId) return;
  selectedStopId = stopId;
  const stop = STOPS_BY_ID[stopId];
  visibleRouteNums = stop ? new Set(stopRouteNums(stop)) : new Set();
  if (prev) refreshMarker(prev);
  if (stopId) refreshMarker(stopId);
}

function deselectStop() {
  if (!selectedStopId) return;
  const prev = selectedStopId;
  selectedStopId = null;
  clearRouteHighlight();
  hidePeek();
  refreshMarker(prev);
}

function renderRouteMapNote(stop) {
  const el = document.getElementById("sheetRouteMapNote");
  if (!el) return;
  const hasSeasonal = (stop.routesSeasonal || []).length > 0;
  const seasonalHint = hasSeasonal
    ? `<span class="routeMapNote__swatch" style="background:${ROUTE_LINE_COLOR.seasonal}"></span>წყვეტილი ხაზი სეზონურია (ეროვნული გამოცდები). `
    : "";
  el.innerHTML = `${seasonalHint}დააჭირეთ მარშრუტს რუკაზე ჩასართავად/გამოსართავად — <button type="button" class="routeMapNote__reset" id="sheetRouteShowAll">ყველას ჩვენება</button>`;

  const resetBtn = document.getElementById("sheetRouteShowAll");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      visibleRouteNums = new Set(stopRouteNums(stop));
      highlightRoutesForStop(stop);
      renderRouteChips(stop);
    });
  }
}

/* ცარიელ ადგილას დაჭერისას მონიშვნა იხსნება */
map.on("click", () => {
  deselectStop();
});

/* ---------- Bottom sheet ---------- */
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
const sheetPeek = document.getElementById("sheetPeek");
const sheetPeekName = document.getElementById("sheetPeekName");
const sheetPeekMain = document.getElementById("sheetPeekMain");
const sheetPeekDeselect = document.getElementById("sheetPeekDeselect");

let activeStopId = null;

function renderStatusBanner(report) {
  if (!report) {
    sheetStatusBanner.className = "statusBanner statusBanner--unknown";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--unknown"></span> სტატუსი უცნობია';
    sheetCaption.textContent = "ჯერ არავის შეუტყობინებია";
    return;
  }
  if (report.status === "inspector" && isStale(report)) {
    sheetStatusBanner.className = "statusBanner statusBanner--stale";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--stale"></span> შესაძლოა აღარ არის';
    sheetCaption.textContent = `ბოლო შეტყობინება: ${timeAgo(report.ts)} (2 სთ-ზე მეტია)`;
    return;
  }
  if (report.status === "inspector") {
    sheetStatusBanner.className = "statusBanner statusBanner--inspector";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--inspector"></span> კონტროლიორი დგას';
  } else {
    sheetStatusBanner.className = "statusBanner statusBanner--clear";
    sheetStatusBanner.innerHTML = '<span class="statusDot statusDot--clear"></span> თავისუფალია';
  }
  sheetCaption.textContent = buildCaptionText(report);
}

/* ---------- სანდოობის დონე (verification, არა raw report-count) ----------
   რამდენმა დამოუკიდებელმა სესიამ დაადასტურა იგივე სტატუსი მოკლე
   დროში — ეს ცვლის აღქმულ სანდოობას, არა თავად "ჯილდოს". */
function trustLabel(confirmCount) {
  if (confirmCount >= 4) return "მაღალი სანდოობა ✓✓";
  if (confirmCount >= 2) return "დადასტურებულია ✓";
  return null; // ერთი შეტყობინება — ჯერ დაუდასტურებელია, ეს ნორმალურია
}

function buildCaptionText(report) {
  const parts = [`ბოლო შეტყობინება: ${timeAgo(report.ts)}`];
  const trust = trustLabel(report.confirmCount || 1);
  if (trust) parts.push(trust);
  if (report.reportsToday > 1) parts.push(`დღეს ${report.reportsToday} შეტყობინება ამ გაჩერებაზე`);
  return parts.join(" · ");
}

function renderRouteChips(stop) {
  const buildChip = (r, cls, extraAttrs = "") => {
    const active = visibleRouteNums.has(r);
    return `<button type="button" class="routeChip routeChip--${cls}${active ? "" : " routeChip--off"}" data-route="${escapeHtml(r)}" ${extraAttrs}>${escapeHtml(r)}</button>`;
  };
  const busChips = (stop.routesBus || []).map((r) => buildChip(r, "bus"));
  const miniChips = (stop.routesMinibus || []).map((r) => buildChip(r, "minibus"));
  const seasonalChips = (stop.routesSeasonal || []).map((r) =>
    buildChip(r, "seasonal", `title="სეზონური — ეროვნული გამოცდები"`)
  );
  const all = [...busChips, ...miniChips, ...seasonalChips];
  sheetRouteChips.innerHTML = all.length
    ? all.join("")
    : `<span class="routeChip routeChip--empty">მარშრუტი უცნობია</span>`;

  sheetRouteChips.querySelectorAll("button.routeChip[data-route]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rn = btn.dataset.route;
      if (visibleRouteNums.has(rn)) {
        visibleRouteNums.delete(rn);
      } else {
        visibleRouteNums.add(rn);
      }
      btn.classList.toggle("routeChip--off", !visibleRouteNums.has(rn));
      highlightRoutesForStop(stop);
    });
  });
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
        <span class="routeChip ${chipClass}">${escapeHtml(a.route)}</span>
        <span class="arrivalItem__direction">${escapeHtml(a.direction || "—")}</span>
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
  renderRouteMapNote(stop);
}

/* გაჩერების მონიშვნა (მარკერზე ring + რუკაზე მარშრუტების ხაზები)
   რჩება მანამ, სანამ სხვა გაჩერებას არ ავირჩევთ — sheet-ის დახურვა
   ("ჩაკეცვა") ამას არ შლის, მხოლოდ პანელს მალავს. */
function showPeek(stopId) {
  const stop = STOPS_BY_ID[stopId];
  if (!stop) return;
  sheetPeekName.textContent = stop.name;
  sheetPeek.classList.remove("hidden");
}

function hidePeek() {
  sheetPeek.classList.add("hidden");
}

function openSheet(stopId) {
  const stop = STOPS_BY_ID[stopId];
  if (!stop) return;
  activeStopId = stopId;
  if (stopId !== selectedStopId) {
    selectStop(stopId);
    highlightRoutesForStop(stop);
  }
  hidePeek();
  renderSheetInfo(stopId);
  overlay.classList.remove("hidden");
  sheet.classList.remove("hidden");
  // ARRIVALS დროებით გამორთულია — TTC-ის ნებართვის მოლოდინში
  // loadArrivalsForStop(stopId, STOPS_BY_ID[stopId]);
}

/* "ჩაკეცვა" — sheet იმალება, მაგრამ პატარა ზოლი გაჩერების სახელით
   და ამოსაწევი ისრით რჩება ეკრანის ბოლოში. მასზე დაჭერით isev
   იხსნება სრული პანელი. მონიშვნა და ხაზები რუკაზე ხელუხლებელია. */
function closeSheet() {
  overlay.classList.add("hidden");
  sheet.classList.add("hidden");
  activeStopId = null;
  if (selectedStopId) showPeek(selectedStopId);
}

sheetPeekMain.addEventListener("click", () => {
  if (selectedStopId) openSheet(selectedStopId);
});

sheetPeekDeselect.addEventListener("click", () => {
  deselectStop();
});

function setActionButtonsDisabled(disabled) {
  btnInspector.disabled = disabled;
  btnClear.disabled = disabled;
}

const REPORT_RADIUS_M = 1000; // 1 კმ

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function handleReportClick(status, successMsg) {
  if (!activeStopId) return;
  if (isNightTime()) {
    showToast("ღამის 00:00 – 07:00 შეტყობინება შეუძლებელია");
    return;
  }
  const stopId = activeStopId;
  const stop = STOPS_BY_ID[stopId];
  setActionButtonsDisabled(true);

  /* ლოკაციის შემოწმება */
  try {
    const pos = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000 })
    );
    const dist = haversineDistance(pos.coords.latitude, pos.coords.longitude, stop.lat, stop.lng);
    if (dist > REPORT_RADIUS_M) {
      showToast(`შენ ამ გაჩერებიდან ${Math.round(dist)}მ-ში ხარ — მხოლოდ 1კმ რადიუსში შეიძლება მონიშვნა`);
      setActionButtonsDisabled(false);
      return;
    }
  } catch {
    showToast("ლოკაციის წვდომა საჭიროა მონიშვნისთვის 📍");
    setActionButtonsDisabled(false);
    return;
  }

  try {
    await setReport(stopId, status, stop ? stop.name : "");
    refreshMarker(stopId);
    closeSheet();

    recordMyContribToday(stopId);
    const contrib = incrementContribution();
    renderContribSection();
    renderCommunitySection();
    if (contrib.leveledUp) {
      showToast(`🎉 ახალი დონე: ${contrib.tier.emoji} ${contrib.tier.label}!`);
    } else {
      showToast(successMsg);
    }
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

/* ---------- Night mode (00:00 – 07:00) ---------- */
function getTbilisiHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tbilisi",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  return parseInt(parts.find((p) => p.type === "hour").value) % 24;
}

function isNightTime() {
  const h = getTbilisiHour();
  return h >= 0 && h < 7;
}

const nightOverlay = document.getElementById("nightOverlay");
const nightClose   = document.getElementById("nightClose");

nightClose.addEventListener("click", () => {
  nightOverlay.classList.add("hidden");
});

function checkNightMode() {
  if (isNightTime()) {
    nightOverlay.classList.remove("hidden");
  }
}

/* ---------- Menu ---------- */
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

/* ---------- Theme toggle ---------- */
const themeBtn = document.getElementById("themeBtn");
if (themeBtn) {
  themeBtn.addEventListener("click", toggleTheme);
}

/* ---------- Activity toggle (mobile) ---------- */
const activityBtn = document.getElementById("activityBtn");
activityBtn.addEventListener("click", () => {
  activityPanel.classList.toggle("show");
});

/* ---------- Activity feed ---------- */
const activityPanel = document.getElementById("activityPanel");
const activityHeader = document.getElementById("activityHeader");
const activityPeek = document.getElementById("activityPeek");
const activityList = document.getElementById("activityList");

function formatActivityText(entry) {
  const name = escapeHtml(entry.stopName);
  if (entry.status === "inspector") {
    return `${name} გაჩერებაზე კონტროლიორი გამოჩნდა (${clockTime(entry.ts)})`;
  }
  return `${name} გაჩერება თავისუფალია`;
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

/* რუკაზე კლიკით და touch-ით activity panel-ის დახურვა */
map.getContainer().addEventListener("click", () => {
  activityPanel.classList.remove("show");
});

(function () {
  let touchStartY = 0;
  map.getContainer().addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  map.getContainer().addEventListener("touchend", (e) => {
    if (!activityPanel.classList.contains("show")) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (dy > -30) activityPanel.classList.remove("show");
  }, { passive: true });
})();

loadAndRenderActivity();
setInterval(loadAndRenderActivity, 10 * 1000);

/* ============================================================
   წვლილის ქულა / ბეჯები
   ------------------------------------------------------------
   განზრახ ფულადი/ნივთიერი ჯილდო არ არის — ეს ხელს შეუწყობდა
   spam-შეტყობინებებს ცრუ ინფორმაციით. ნაცვლად ამისა, ლოკალურ
   (device-ზე, localStorage) მიღწევებს ვითვლით — სუფთა
   რეპუტაციული მოტივაცია, ანონიმურობის დარღვევის გარეშე.
   ============================================================ */
const CONTRIB_KEY = "kontrolio-contrib-count";

const CONTRIB_TIERS = [
  { min: 0,   emoji: "🌱", label: "ახალბედა" },
  { min: 5,   emoji: "🔍", label: "დამკვირვებელი" },
  { min: 15,  emoji: "🧭", label: "მეგზური" },
  { min: 30,  emoji: "⭐", label: "გამოცდილი" },
  { min: 60,  emoji: "🏅", label: "ექსპერტი" },
  { min: 100, emoji: "👑", label: "ლეგენდა" },
];

function getContribCount() {
  return parseInt(localStorage.getItem(CONTRIB_KEY), 10) || 0;
}

function tierIndexFor(count) {
  let idx = 0;
  for (let i = 0; i < CONTRIB_TIERS.length; i++) {
    if (count >= CONTRIB_TIERS[i].min) idx = i;
  }
  return idx;
}

function incrementContribution() {
  const oldCount = getContribCount();
  const newCount = oldCount + 1;
  localStorage.setItem(CONTRIB_KEY, String(newCount));
  const oldTier = tierIndexFor(oldCount);
  const newTier = tierIndexFor(newCount);
  return { count: newCount, leveledUp: newTier > oldTier, tier: CONTRIB_TIERS[newTier] };
}

function renderContribSection() {
  const emojiEl = document.getElementById("contribEmoji");
  const tierEl = document.getElementById("contribTier");
  const countEl = document.getElementById("contribCount");
  const barEl = document.getElementById("contribProgressBar");
  const nextEl = document.getElementById("contribNext");
  const todayEl = document.getElementById("contribToday");
  if (!emojiEl) return;

  const count = getContribCount();
  const idx = tierIndexFor(count);
  const tier = CONTRIB_TIERS[idx];
  const next = CONTRIB_TIERS[idx + 1];

  emojiEl.textContent = tier.emoji;
  tierEl.textContent = tier.label;
  countEl.textContent = count === 0
    ? "ჯერ არ გაგიგზავნია შეტყობინება"
    : `${count} შეტყობინება გაგზავნილი`;

  if (next) {
    const span = next.min - tier.min;
    const progressed = count - tier.min;
    barEl.style.width = `${Math.min(100, Math.round((progressed / span) * 100))}%`;
    nextEl.textContent = `${next.min - count} შეტყობინება დარჩა შემდეგ დონემდე: ${next.emoji} ${next.label}`;
  } else {
    barEl.style.width = "100%";
    nextEl.textContent = "მიაღწიე ყველაზე მაღალ დონეს — მადლობა წვლილისთვის! 👑";
  }

  if (todayEl) {
    const { helped, reportCount } = computeHelpedToday();
    if (reportCount === 0) {
      todayEl.textContent = "";
    } else if (helped > 0) {
      todayEl.textContent = `🙌 დღეს დაეხმარე მინიმუმ ${helped} ადამიანს (${reportCount} შეტყობინებით)`;
    } else {
      todayEl.textContent = `📍 დღეს გაგზავნე ${reportCount} შეტყობინება — მალე გამოჩნდება რამდენს დაეხმარები`;
    }
  }
}

/* ---------- "დღეს დაეხმარე X ადამიანს" — პირადი (device-ზე) ტრეკინგი ----------
   ინახავს, რომელ გაჩერებებზე შენ თვითონ შეატყობინე დღეს. ეს არასდროს
   იგზავნება სერვერზე პირადობასთან დაკავშირებული სახით — მხოლოდ
   localStorage-შია, ერთი დღით (Tbilisi calendar day). "დახმარებულების"
   რიცხვი მიახლოებითია: რამდენმა სხვა სესიამ ნახა ეს კონკრეტული სტატუსი,
   სანამ ის აქტიური იყო. */
const MY_CONTRIB_TODAY_KEY = "kontrolio-my-contrib-today";

function getMyContribToday() {
  const today = tbilisiDateKey();
  try {
    const raw = localStorage.getItem(MY_CONTRIB_TODAY_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.date === today && Array.isArray(data.stopIds)) return data;
    }
  } catch (_) {}
  return { date: today, stopIds: [], reportCount: 0 };
}

function recordMyContribToday(stopId) {
  const data = getMyContribToday();
  if (!data.stopIds.includes(stopId)) data.stopIds.push(stopId);
  data.reportCount = (data.reportCount || 0) + 1;
  try {
    localStorage.setItem(MY_CONTRIB_TODAY_KEY, JSON.stringify(data));
  } catch (_) {}
  return data;
}

function computeHelpedToday() {
  const data = getMyContribToday();
  let helped = 0;
  data.stopIds.forEach((id) => {
    const r = reportsCache[id];
    if (r && typeof r.viewerCount === "number") helped += r.viewerCount;
  });
  return { helped, reportCount: data.reportCount || 0 };
}

/* ---------- საზოგადოების დღევანდელი აქტივობა (menu drawer) ----------
   citywide ჯამი გამოთვლილია client-ზე, reportsToday ველიდან, რომელიც
   უკვე მოდის GET /api/reports-ის ყოველი აქტიური გაჩერებისთვის. */
function renderCommunitySection() {
  const el = document.getElementById("communityStats");
  if (!el) return;
  const entries = Object.values(reportsCache);
  if (entries.length === 0) {
    el.textContent = "დღეს ჯერ არავის შეუტყობინებია";
    return;
  }
  const totalReports = entries.reduce((sum, r) => sum + (r.reportsToday || 0), 0);
  const activeStops = entries.length;
  el.textContent = `დღეს გაგზავნილია ${totalReports} შეტყობინება ${activeStops} გაჩერებაზე`;
}

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
        return `<div class="searchResult" data-id="${s.id}">${escapeHtml(s.name)}<small>${escapeHtml(meta)}</small></div>`;
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

/* ---------- პერიოდული სინქრონიზაცია სერვერთან ---------- */
async function pollAndRender() {
  const ok = await refreshReportsFromServer();
  if (ok) {
    renderAllMarkers();
    if (activeStopId) renderSheetInfo(activeStopId);
    renderCommunitySection();
    renderContribSection();
  }
}

setInterval(pollAndRender, 15 * 1000);

/* ---------- ონლაინ მომხმარებლების badge ----------
   (გადმოტანილი index.html-ის ინლაინ <script>-დან — CSP-ში script-src
   'unsafe-inline'-ს განზრახ არ ვტოვებთ, ამიტომ ეს გარეშე ფაილში
   უნდა იყოს, რომ არ დაბლოკოს.) */
(function () {
  const countEl = document.getElementById("onlineCount");
  if (!countEl) return;

  async function beat() {
    try {
      const r = await fetch(`${API_BASE}/heartbeat?sid=${encodeURIComponent(getSid())}`);
      if (!r.ok) return;
      const { online } = await r.json();
      countEl.textContent = online;
    } catch (_) {}
  }

  beat();
  setInterval(beat, 20 * 1000);
})();

/* ---------- გაშვება ---------- */
(async function init() {
  checkNightMode();
  await refreshReportsFromServer();
  renderAllMarkers();
  renderContribSection();
  renderCommunitySection();

  const initialTheme = getSavedTheme();
  setTheme(initialTheme);

  /* წინა ვიზიტის ლოკაცია მაშინვე ვაჩვენოთ, შემდეგ ცოცხალი
     პოზიციით ჩუმად განვაახლოთ თუ ბრაუზერი დართავს */
  restoreSavedUserLocation();
  tryAutoUpdateUserLocation();

  lucide.createIcons();

  /* თუ ავტო-რეჟიმში ვართ, ყოველ წუთში ერთხელ ვამოწმებთ დროს */
  setInterval(() => {
    if (localStorage.getItem(THEME_MANUAL_KEY) !== "true") {
      const sys = getSystemTheme();
      const current = document.documentElement.getAttribute("data-theme") || "light";
      if (sys !== current) setTheme(sys);
    }
  }, 60 * 1000);
})();
