/* ============================================================
   kontrolio-api — server.js
   ------------------------------------------------------------
   მონაცემები ინახება ერთ JSON ფაილში (data/reports.json),
   in-memory ქეშით წასაკითხი სიჩქარისთვის და ატომური ჩაწერით
   (temp ფაილი + rename), რომ ჩაწერის შუაში crash-მა ფაილი არ
   დააფუჭოს.

   ამ ამოცანისთვის (ერთი სტატუსი თითო გაჩერებაზე, ყოველდღე
   იშლება) ეს გაცილებით მარტივი და სტაბილურია, ვიდრე native
   SQLite მოდული (better-sqlite3), რომელსაც Docker build-ის დროს
   ნატივი კომპილაცია სჭირდება და ხშირად ეგენერირებს build
   პრობლემებს სხვადასხვა Node/CPU არქიტექტურაზე. თუ მომავალში
   საჩერებების ისტორიის შენახვა/ანალიტიკა დაგვინდება, მარტივად
   გადავინაცვლებთ Postgres/SQLite-ზე — ეს ფაილი მხოლოდ
   "DATA LAYER" სექციას ეხება.

   ენდპოინტები:
   GET  /api/reports  -> { stopId: {status, ts}, ... }  (მხოლოდ დღევანდელი)
   POST /api/reports  -> { stopId, status } ქმნის/ანახლებს ჩანაწერს
   GET  /api/health   -> { ok: true }
   ============================================================ */

const express = require("express");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "reports.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- in-memory state, დისკზე სარეზერვო ასლით ---------- */
// ფორმატი: { [stopId]: { status: "inspector"|"clear", ts: number, reportDate: "YYYY-MM-DD" } }
let store = {};

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (err) {
    console.error("reports.json წაკითხვა ჩავარდა, ვაგრძელებთ ცარიელით:", err.message);
    store = {};
  }
}

function persistStore() {
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store), "utf8");
  fs.renameSync(tmpFile, DATA_FILE); // ატომური ჩანაცვლება
}

loadStore();

/* ---------- თბილისის თარიღი, server-ის timezone-ის მიუხედავად ---------- */
function tbilisiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function msUntilNextTbilisiCleanupWindow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tbilisi",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const secondsSinceMidnight = get("hour") * 3600 + get("minute") * 60 + get("second");
  const targetSeconds = 5 * 60; // 00:05 თბილისის დროით
  let diff = targetSeconds - secondsSinceMidnight;
  if (diff <= 0) diff += 24 * 3600;
  return diff * 1000;
}

function cleanupOldReports() {
  const today = tbilisiDateKey();
  let removed = 0;
  for (const stopId of Object.keys(store)) {
    if (store[stopId].reportDate !== today) {
      delete store[stopId];
      removed++;
    }
  }
  if (removed > 0) {
    persistStore();
    console.log(`[cleanup] წაიშალა ${removed} ძველი ჩანაწერი (${new Date().toISOString()})`);
  }
}

function scheduleCleanup() {
  setTimeout(() => {
    cleanupOldReports();
    scheduleCleanup();
  }, msUntilNextTbilisiCleanupWindow());
}

/* ---------- Express app ---------- */
const app = express();
app.use(express.json());

// მსუბუქი CORS — სასარგებლო, თუ API ცალკე origin-იდან გამოძახდება
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  // Cloudflare-ს ნაცემან cache-ში არ "ჩარჩეს" ეს დინამიური მონაცემები
  res.header("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const VALID_STATUSES = new Set(["inspector", "clear"]);

app.get("/api/reports", (req, res) => {
  const today = tbilisiDateKey();
  const out = {};
  for (const [stopId, rec] of Object.entries(store)) {
    if (rec.reportDate === today) {
      out[stopId] = { status: rec.status, ts: rec.ts };
    }
  }
  res.json(out);
});

app.post("/api/reports", (req, res) => {
  const { stopId, status } = req.body || {};

  if (typeof stopId !== "string" || !stopId.trim()) {
    return res.status(400).json({ error: "stopId is required" });
  }
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'status must be "inspector" or "clear"' });
  }

  const ts = Date.now();
  const reportDate = tbilisiDateKey();

  store[stopId] = { status, ts, reportDate };
  persistStore();

  res.json({ stopId, status, ts });
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`kontrolio-api listening on :${PORT}`);
  cleanupOldReports();
  scheduleCleanup();
});
