/* ============================================================
   kontrolio-api — server.js
   ------------------------------------------------------------
   მონაცემები ინახება ერთ JSON ფაილში (data/store.json):
     { reports: { [stopId]: {status, ts, reportDate} },
       activity: [ {stopName, status, ts, reportDate}, ... ] }
   in-memory ქეშით წასაკითხი სიჩქარისთვის და ატომური ჩაწერით
   (temp ფაილი + rename).

   "სერვის დღე" იშლება ყოველდღე 23:30 საათზე (თბილისის დროით),
   ღამის 00:00-ის ნაცვლად.

   ენდპოინტები:
   GET  /api/reports   -> { stopId: {status, ts}, ... }  (მხოლოდ მიმდინარე სერვის-დღის)
   POST /api/reports   -> { stopId, status, stopName } ქმნის/ანახლებს ჩანაწერს + activity-ს
   GET  /api/activity  -> [ {stopName, status, ts}, ... ]  (უახლესი წინ, მხოლოდ დღევანდელი)
   GET  /api/health    -> { ok: true }
   ============================================================ */

const express = require("express");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const MAX_ACTIVITY_ENTRIES = 500;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- გაჩერებების სახელების lookup (server-side, client-ს არ ვუჯეროთ) ----------
   stopNames.json არის { stopId: "სახელი" } — გენერირებულია stops.js-ის იმავე
   მონაცემიდან. POST /api/reports-ში stopName-ს client-დან არ ვიღებთ, რომ
   ვინმემ თვითნებური (და, კიდევ უარესი, HTML/JS-შემცველი) ტექსტი არ ჩაგვინერგოს
   Activity feed-ში. */
let STOP_NAMES = {};
try {
  STOP_NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, "stopNames.json"), "utf8"));
  console.log(`stopNames.json ჩაიტვირთა — ${Object.keys(STOP_NAMES).length} გაჩერება`);
} catch (err) {
  console.error("stopNames.json ჩატვირთვა ჩავარდა — Activity-ში გამოჩნდება generic სახელები:", err.message);
}

/* ---------- in-memory state, დისკზე სარეზერვო ასლით ---------- */
let store = { reports: {}, activity: [] };

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      store = {
        reports: parsed.reports || {},
        activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      };
    }
  } catch (err) {
    console.error("store.json წაკითხვა ჩავარდა, ვაგრძელებთ ცარიელით:", err.message);
    store = { reports: {}, activity: [] };
  }
}

function persistStore() {
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store), "utf8");
  fs.renameSync(tmpFile, DATA_FILE); // ატომური ჩანაცვლება
}

loadStore();

/* ---------- "სერვის დღის" გასაანგარიშებელი ლოგიკა ----------
   ნაცვლად ჩვეული კალენდარული თარიღისა (რომელიც 00:00-ზე იცვლება),
   ჩვენი "დღე" იცვლება 23:30-ზე. */
const CUTOFF_HOUR = 23;
const CUTOFF_MINUTE = 30;

function tbilisiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function serviceDayKey(date = new Date()) {
  const p = tbilisiParts(date);
  const afterCutoff =
    p.hour > CUTOFF_HOUR || (p.hour === CUTOFF_HOUR && p.minute >= CUTOFF_MINUTE);

  if (!afterCutoff) {
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  }
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

function msUntilNextCleanupWindow() {
  const p = tbilisiParts();
  const secondsSinceMidnight = p.hour * 3600 + p.minute * 60 + p.second;
  const targetSeconds = CUTOFF_HOUR * 3600 + CUTOFF_MINUTE * 60; // 23:30
  let diff = targetSeconds - secondsSinceMidnight;
  if (diff <= 0) diff += 24 * 3600;
  return diff * 1000;
}

function cleanupOldData() {
  const current = serviceDayKey();
  let removed = 0;

  for (const stopId of Object.keys(store.reports)) {
    if (store.reports[stopId].reportDate !== current) {
      delete store.reports[stopId];
      removed++;
    }
  }

  const beforeLen = store.activity.length;
  store.activity = store.activity.filter((a) => a.reportDate === current);
  removed += beforeLen - store.activity.length;

  if (removed > 0) {
    persistStore();
    console.log(`[cleanup] წაიშალა ${removed} ძველი ჩანაწერი (${new Date().toISOString()})`);
  }
}

function scheduleCleanup() {
  setTimeout(() => {
    cleanupOldData();
    scheduleCleanup();
  }, msUntilNextCleanupWindow());
}

/* ---------- Express app ---------- */
const app = express();

// nginx არის ერთადერთი proxy ჩვენსა და client-ს შორის (docker network-ში) —
// ეს საჭიროა, რომ req.ip ნამდვილ ვიზიტორის IP-ს აღმოაჩენდეს
// X-Forwarded-For-დან, და არა nginx-ის საკუთარ docker-internal მისამართს.
app.set("trust proxy", 1);

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const VALID_STATUSES = new Set(["inspector", "clear"]);

/* ---------- Rate limiting ----------
   ორ ფენად: ზოგადი ჭერი ყველა /api-ზე (ბოროტმოქმედული scripting-ის წინააღმდეგ),
   და მკაცრი ჭერი მხოლოდ POST /api/reports-ზე (spam-ი ცრუ შეტყობინებებით). */
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", generalLimiter);

const reportsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "ძალიან ხშირი შეტყობინებები — სცადე რამდენიმე წუთში" },
});

app.get("/api/reports", (req, res) => {
  const current = serviceDayKey();
  const out = {};
  for (const [stopId, rec] of Object.entries(store.reports)) {
    if (rec.reportDate === current) {
      out[stopId] = { status: rec.status, ts: rec.ts };
    }
  }
  res.json(out);
});

app.post("/api/reports", reportsLimiter, (req, res) => {
  const { stopId, status } = req.body || {};

  if (typeof stopId !== "string" || !stopId.trim()) {
    return res.status(400).json({ error: "stopId is required" });
  }
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'status must be "inspector" or "clear"' });
  }
  if (Object.keys(STOP_NAMES).length > 0 && !Object.prototype.hasOwnProperty.call(STOP_NAMES, stopId)) {
    return res.status(400).json({ error: "unknown stopId" });
  }

  const ts = Date.now();
  const reportDate = serviceDayKey();
  // client-ის stopName-ს არ ვუჯერებთ — სახელს ჩვენივე lookup-დან ვიღებთ,
  // რომ ვინმემ თვითნებური/მავნე ტექსტი არ ჩაგვინერგოს Activity feed-ში.
  const safeName = STOP_NAMES[stopId] || "გაჩერება";

  store.reports[stopId] = { status, ts, reportDate };

  store.activity.push({ stopName: safeName, status, ts, reportDate });
  if (store.activity.length > MAX_ACTIVITY_ENTRIES) {
    store.activity = store.activity.slice(-MAX_ACTIVITY_ENTRIES);
  }

  persistStore();
  res.json({ stopId, status, ts });
});

app.get("/api/activity", (req, res) => {
  const current = serviceDayKey();
  const todays = store.activity.filter((a) => a.reportDate === current);
  const recent = todays.slice(-100).reverse(); // უახლესი წინ
  res.json(recent.map((a) => ({ stopName: a.stopName, status: a.status, ts: a.ts })));
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------- მოსვლის დროების proxy (TTC API) ----------
   ბრაუზერიდან პირდაპირ ამ API-ზე წვდომა CORS-ის გამო ვერ
   მუშაობს — server-ი შუამავლობს და ბრაუზერისმაგვარ header-ებს
   ამატებს (TTC ალბათ Referer/Origin-ს ამოწმებს).
   ერთი გაჩერება შესაძლოა 1 ან 2 ID-ს შეიცავდეს (გაერთიანებული
   წყვილი) — ორივეს ვითხოვთ და ერთად ვაბრუნებთ. */
const TTC_BASE = "https://transit.ttc.com.ge/pis-gateway/api/v2/stops";
const TTC_HEADERS = {
  Accept: "application/json",
  Referer: "https://transit.ttc.com.ge/",
  Origin: "https://transit.ttc.com.ge",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};
if (process.env.TTC_COOKIE) {
  TTC_HEADERS["Cookie"] = process.env.TTC_COOKIE;
}
if (process.env.TTC_API_KEY) {
  TTC_HEADERS["X-api-key"] = process.env.TTC_API_KEY;
}
if (!process.env.TTC_COOKIE || !process.env.TTC_API_KEY) {
  console.warn(
    "[arrivals] TTC_COOKIE/TTC_API_KEY env ცვლადები არ არის დაყენებული — " +
      "მოსვლის დროების ფუნქცია სავარაუდოდ არ მუშაობს. იხილე api/.env.example."
  );
}

app.get("/api/arrivals", async (req, res) => {
  const idsParam = req.query.ids;
  if (typeof idsParam !== "string" || !idsParam.trim()) {
    return res.status(400).json({ error: "ids query param is required" });
  }
  const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
  if (ids.length === 0) {
    return res.status(400).json({ error: "no valid ids" });
  }

  const results = await Promise.allSettled(
    ids.map((id) =>
      fetch(
        `${TTC_BASE}/${encodeURIComponent(id)}/arrival-times?locale=ka&ignoreScheduledArrivalTimes=false`,
        { headers: TTC_HEADERS }
      ).then(async (r) => {
        if (!r.ok) throw new Error(`upstream ${r.status} for ${id}`);
        const json = await r.json();
        console.log(`[ttc-raw] stop ${id}:`, JSON.stringify(json).slice(0, 500));
        return json;
      })
    )
  );

  const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const errors = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));

  if (ok.length === 0) {
    console.error("[arrivals] ttc upstream failed:", errors);
    return res.status(502).json({ error: "ttc upstream failed", details: errors });
  }

  res.json({ stops: ok });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`kontrolio-api listening on :${PORT}`);
  cleanupOldData();
  scheduleCleanup();
});
