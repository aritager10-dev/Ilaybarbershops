/* =====================================================================
   ILAY BARBERSHOP - CORE (SERVER API CLIENT, STATE, REVENUE)
   Data lives on the server (api/router.js). The browser keeps only an in-memory copy.
   ===================================================================== */
const DAYS_HEB = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "מוצ״ש"];

// Removes everything earlier versions stored in the browser: cached user lists, sessions, old
// portfolio lists (including the previous default photos). Nothing personal is kept locally any more.
(function purgeLegacyBrowserData() {
  try {
    ["ilay_portfolio_list_v5", "ilay_portfolio_ts", "ilay_logged_client_v1", "ilay_saved_admin_label"].forEach(k => localStorage.removeItem(k));
    ["ilay_site_cfg", "ilay_services_v2", "ilay_weekly_hours", "ilay_appointments_clean_v1", "ilay_registered_users_v1", "ilay_sms_logs_v1", "ilay_admin_notifs_v1", "ilay_state_ts", "ilay_data_epoch"]
      .forEach(k => { localStorage.removeItem(k); localStorage.removeItem("test__" + k); });
  } catch (_) {}
  try { if (window.indexedDB) indexedDB.deleteDatabase("IlayBarbershopPortfolioDB"); } catch (_) {}
})();

// --- מצב בדיקות: נתונים נפרדים לגמרי. דורש התחברות לניהול, והשרת הוא שאוכף את זה. ---
// הפעלה: הוסף ?test=1 לכתובת (או כפתור בניהול). יציאה: ?test=0 או כפתור "יציאה" בפס העליון.
let TEST_MODE = (() => {
  try {
    const p = new URLSearchParams(window.location.search).get("test");
    if (p === "1") localStorage.setItem("ilay_test_mode", "1");
    if (p === "0") localStorage.removeItem("ilay_test_mode");
    return localStorage.getItem("ilay_test_mode") === "1";
  } catch (_) { return false; }
})();
function setTestMode(on) {
  try { on ? localStorage.setItem("ilay_test_mode", "1") : localStorage.removeItem("ilay_test_mode"); } catch (_) {}
  const url = new URL(window.location.href);
  url.searchParams.delete("test");
  window.location.href = url.toString();
}

function showTestModeBar() {
  const bar = document.createElement("div");
  bar.id = "testModeBar";
  bar.setAttribute("role", "status");
  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#f59e0b;color:#111;font:600 14px/1.3 system-ui,sans-serif;padding:8px 14px;display:flex;gap:10px;align-items:center;justify-content:center;direction:rtl;flex-wrap:wrap;";
  bar.innerHTML = '<span>מצב בדיקות: תורים, הודעות וסטטיסטיקה כאן נפרדים מהיומן האמיתי. הודעות SMS כן נשלחות באמת.</span><button type="button" style="background:#111;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit">יציאה ממצב בדיקות</button>';
  bar.querySelector("button").onclick = () => setTestMode(false);
  document.body.appendChild(bar);
  document.body.style.paddingTop = (bar.offsetHeight || 38) + "px";
  window.dispatchEvent(new Event("resize"));
}

const DEFAULT_PORTFOLIO = [
  "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1621607512214-68297480165e?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1622286342621-4bd786c2447c?auto=format&fit=crop&w=600&q=80"
];

// --- Escaping helpers used at every render sink. ---
function esc(v) {
  return String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function sanitizeStr(str, maxLen = 120) {
  if (typeof str !== "string") return "";
  return esc(str.slice(0, maxLen)).trim();
}
// For values going to the server: plain text, validated there. Not HTML-encoded.
function plainStr(str, maxLen = 120) { return String(str === null || str === undefined ? "" : str).trim().slice(0, maxLen); }
// Safe to place inside an inline onclick string.
const safeId = x => String(x === null || x === undefined ? "" : x).replace(/[^\w-]/g, "").slice(0, 60);
const TIME_RE = /^\d{1,2}:\d{2}$/;
const safeTime = t => (TIME_RE.test(String(t)) ? String(t) : "");
const safeStatus = s => (["pending", "confirmed", "canceled"].includes(s) ? s : "pending");

// Image sources are limited to the default photos' host, this site's photo endpoint and local previews.
const SAFE_IMG_RE = /^(https:\/\/images\.unsplash\.com\/[\w\-./?=&%]+|\/api\/photo\/ph_[a-f0-9]{24}(\?test=1)?|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/;
function isSafeImgSrc(src) { return typeof src === "string" && src.length < 3000000 && SAFE_IMG_RE.test(src); }

function toIsraeliLocalPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("972")) return "0" + digits.slice(3);
  return digits.startsWith("0") ? digits : "0" + digits;
}

// --- Dates follow Israel time, as the server does, wherever the browser happens to be. ---
const IL_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
function ilParts(ms = Date.now()) {
  const o = {};
  IL_FMT.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) };
}
function israelDayIdx() { return ilParts().dow; }
function israelNowMinutes() { const p = ilParts(); return p.h * 60 + p.mi; }
function ilDateForDayIdx(dayIdx) {
  const p = ilParts();
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + ((Number(dayIdx) - p.dow + 7) % 7)));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function getFormattedDateForDayIdx(dayIdx) {
  const t = ilDateForDayIdx(dayIdx);
  return `${String(t.d).padStart(2, "0")}/${String(t.m).padStart(2, "0")}`;
}
function getTargetTimestamp(dayIdx, timeStr) {
  const t = ilDateForDayIdx(dayIdx);
  const [hh, mm] = String(timeStr || "12:00").split(":").map(Number);
  const wall = Date.UTC(t.y, t.m - 1, t.d, hh || 0, mm || 0);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = ilParts(guess);
    guess = wall - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess);
  }
  return guess;
}
const ymdNum = o => o.y * 10000 + o.m * 100 + o.d;
const apptYmdNum = a => { const p = ilParts(Number(a.startsAtMs) || 0); return ymdNum(p); };

// What the calendar board shows: today and the next six days, one slot per weekday.
function calendarAppointments() {
  const from = ymdNum(ilDateForDayIdx(israelDayIdx()));
  const p = ilParts();
  const end = new Date(Date.UTC(p.y, p.m - 1, p.d + 6));
  const to = end.getUTCFullYear() * 10000 + (end.getUTCMonth() + 1) * 100 + end.getUTCDate();
  return appointments.filter(a => { const n = apptYmdNum(a); return n >= from && n <= to; });
}
// What "this week" means in the statistics: the current Sunday-to-Saturday week.
function currentWeekAppointments() {
  const p = ilParts();
  const s = new Date(Date.UTC(p.y, p.m - 1, p.d - p.dow));
  const e = new Date(Date.UTC(p.y, p.m - 1, p.d - p.dow + 6));
  const num = t => t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  return appointments.filter(a => { const n = apptYmdNum(a); return n >= num(s) && n <= num(e); });
}

function compressImageFile(file) {
  return new Promise(resolve => {
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const maxDim = 540;
      let w = img.width || 480, h = img.height || 640;
      if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(objUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.68));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.readAsDataURL(file);
    };
    img.src = objUrl;
  });
}

// --- State. These values only show until the server answers (the loading screen covers that moment). ---
let siteConfig = {
  title: "ILAY BARBERSHOP",
  subtitle: "תספורת נקייה, אווירה טובה וסטייל שיושב בול.",
  slotInterval: 30,
  slotBuffer: 0,
  reminderHoursBefore: 3,
  smsPackageQuota: 1500
};

let SERVICES = [
  { name: "תספורת קלאסי", price: 70, duration: "30 דק'", desc: "דירוג (מולט, טייפר, בארסט ועוד..) עם גזירות ואפשרות להוסיף פנס לבחירה." },
  { name: "תספורת מוגזם", price: 90, duration: "45 דק'", desc: "לא הסתפרת הרבה זמן ורוצה לעשות שינוי, תספורת גזירות מלאה." },
  { name: "תספורת קלאסי + זקן", price: 80, duration: "35 דק'", desc: "דירוג נקי (מולט, טייפר, בארסט ועוד) עם גזירות, פנס לבחירה וסידור זקן מדויק." },
  { name: "תספורת מוגזם + זקן", price: 100, duration: "50 דק'", desc: "שינוי לוק מלא בגזירות ודירוג למי שלא הסתפר הרבה זמן, כולל עיצוב וסידור זקן." }
];

let weeklySchedule = [
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "21:00" },
  { active: true, start: "09:00", end: "15:00" },
  { active: false, start: "19:30", end: "22:00" }
];

// Public page: busy placeholders without personal data, plus the visitor's own appointments.
// Admin page: everything. registeredUsers and smsLogs stay empty on the public page.
let appointments = [];
let registeredUsers = [];
let smsLogs = [];
let adminNotifications = [];
let smsStats = {};
const DEFAULT_PORTFOLIO_IDS = DEFAULT_PORTFOLIO.map((_, i) => "def:" + i);
let portfolioIds = [...DEFAULT_PORTFOLIO_IDS];
let portfolioList = [...DEFAULT_PORTFOLIO];

function portfolioEntryUrl(entry) {
  const def = /^def:(\d+)$/.exec(String(entry));
  if (def) return DEFAULT_PORTFOLIO[Number(def[1])] || null;
  const url = `/api/photo/${safeId(entry)}` + (TEST_MODE ? "?test=1" : "");
  return isSafeImgSrc(url) ? url : null;
}
function setPortfolioFromServer(list) {
  const entries = Array.isArray(list) && list.length ? list : DEFAULT_PORTFOLIO_IDS;
  portfolioIds = entries.filter(e => portfolioEntryUrl(e));
  portfolioList = portfolioIds.map(portfolioEntryUrl);
}

// --- Server API. Always resolves; failures come back as { ok: false, reason } for the existing toasts. ---
async function api(path, { method = "GET", body } = {}) {
  const url = "/api" + path + (TEST_MODE ? (path.includes("?") ? "&" : "?") + "test=1" : "");
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok === true;
    if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/admin/login") && typeof window.onApiUnauthorized === "function") window.onApiUnauthorized(path);
    return { ok, status: res.status, data, reason: data.reason || (ok ? "" : `שגיאת שרת (${res.status})`) };
  } catch (_) {
    return { ok: false, status: 0, data: {}, reason: "אין חיבור לשרת. בדקו את האינטרנט ונסו שוב." };
  }
}
const apiPost = (path, body = {}) => api(path, { method: "POST", body });

// --- התראות בזמן אמת ---
function playAlertTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch (_) {}
}

function notifyDataUpdated() { if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated(); }

// Runs fn every intervalMs, but only while the tab is visible; also right when it becomes visible again.
function pollWhileVisible(fn, intervalMs) {
  let running = false;
  const tick = async () => {
    if (document.hidden || running) return;
    running = true;
    try { await fn(); } finally { running = false; }
  };
  setInterval(tick, intervalMs);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

// --- Public site sync ---
let lastPublicVersion = null;
let busySlots = [];
let myAppointments = [];

function rebuildClientAppointments() {
  const mine = myAppointments.filter(a => a.status !== "canceled");
  // A busy row at the visitor's own slot is their own appointment, shown from the fuller record instead.
  const others = busySlots.filter(b => !mine.some(o => Number(o.dayIdx) === Number(b.dayIdx) && o.time === b.time));
  appointments = [
    ...others.map((b, i) => ({ id: "busy_" + i, busy: true, dayIdx: b.dayIdx, time: b.time, dateStr: b.dateStr, status: "pending" })),
    ...myAppointments
  ];
}

async function fetchPublicState() {
  const r = await api("/public");
  if (!r.ok) return false;
  const d = r.data;
  const changed = d.v !== lastPublicVersion;
  if (!changed) return false;
  lastPublicVersion = d.v;
  siteConfig = { ...siteConfig, ...d.siteConfig };
  SERVICES = d.services;
  weeklySchedule = d.weeklySchedule;
  setPortfolioFromServer(d.portfolio);
  busySlots = Array.isArray(d.busy) ? d.busy : [];
  rebuildClientAppointments();
  return true;
}

// --- Admin sync: the arrays stay global as before; a save sends only what differs from the last server copy. ---
let adminSnapshot = null;
let pollUpdateInProgress = false;
let lastAdminVersion = null;
let pendingApplies = 0;
let applyQueue = Promise.resolve();
const ADMIN_CONFIG_KEYS = ["title", "subtitle", "slotInterval", "slotBuffer", "reminderHoursBefore", "smsPackageQuota", "barberPhone"];

function applyAdminState(state, { fromPoll = false } = {}) {
  const knownNotifs = adminSnapshot ? new Set(adminSnapshot.adminNotifications.map(n => n.id)) : null;
  adminSnapshot = JSON.parse(JSON.stringify(state));
  lastAdminVersion = state.v;
  siteConfig = { ...siteConfig, ...state.siteConfig };
  SERVICES = state.services;
  weeklySchedule = state.weeklySchedule;
  appointments = state.appointments;
  registeredUsers = state.registeredUsers;
  smsLogs = state.smsLogs;
  adminNotifications = state.adminNotifications;
  smsStats = state.smsStats || {};
  setPortfolioFromServer(state.portfolio);
  pollUpdateInProgress = fromPoll;
  notifyDataUpdated();
  pollUpdateInProgress = false;
  if (fromPoll && knownNotifs) {
    const fresh = state.adminNotifications.filter(n => !knownNotifs.has(n.id));
    if (fresh.length) {
      playAlertTone();
      if (typeof window.onLiveNotificationReceived === "function") window.onLiveNotificationReceived(fresh[0]);
    }
  }
}

function collectionDiff(current, previous, pick) {
  const prevById = new Map(previous.map(x => [x.id, JSON.stringify(pick(x))]));
  const curIds = new Set(current.map(x => x.id));
  const upsert = current.filter(x => prevById.get(x.id) !== JSON.stringify(pick(x))).map(pick);
  const remove = previous.filter(x => !curIds.has(x.id)).map(x => x.id);
  return upsert.length || remove.length ? { upsert, remove } : null;
}

function buildAdminDiff() {
  const snap = adminSnapshot;
  const diff = {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const appts = collectionDiff(appointments, snap.appointments, a => a);
  const users = collectionDiff(registeredUsers, snap.registeredUsers, u => ({ id: u.id, username: u.username, phone: u.phone }));
  const logs = collectionDiff(smsLogs, snap.smsLogs, l => l);
  const notifs = collectionDiff(adminNotifications, snap.adminNotifications, n => ({ id: n.id, read: n.read === true }));
  if (appts) diff.appointments = appts;
  if (users) diff.users = users;
  if (logs) diff.logs = logs;
  if (notifs) diff.notifications = notifs;
  if (!same(SERVICES, snap.services)) diff.services = SERVICES;
  if (!same(weeklySchedule, snap.weeklySchedule)) diff.weeklySchedule = weeklySchedule;
  const cfg = {};
  ADMIN_CONFIG_KEYS.forEach(k => { if (!same(siteConfig[k], snap.siteConfig[k])) cfg[k] = siteConfig[k]; });
  if (Object.keys(cfg).length) diff.siteConfig = cfg;
  return diff;
}

async function flushAdminDiff() {
  if (!adminSnapshot) return { ok: false, reason: "הנתונים עדיין נטענים" };
  const diff = buildAdminDiff();
  if (!Object.keys(diff).length) return { ok: true, conflicts: [], sms: {} };
  const r = await apiPost("/admin/apply", diff);
  if (!r.ok) {
    if (typeof window.onCoreError === "function") window.onCoreError(r.reason);
    // Drop the rejected local change by returning to what the server holds.
    if (r.status !== 401) await refreshAdminState();
    return { ok: false, reason: r.reason, conflicts: [], sms: {} };
  }
  applyAdminState(r.data.state);
  const conflicts = r.data.conflicts || [];
  if (conflicts.length && typeof window.onCoreError === "function") window.onCoreError(conflicts[0].reason);
  return { ok: conflicts.length === 0, conflicts, sms: r.data.sms || {} };
}

// Same name as before, for the admin code that calls it after changing the arrays.
// Saves run one at a time, in order.
function broadcastCloudState() {
  pendingApplies++;
  const run = applyQueue.then(flushAdminDiff).finally(() => { pendingApplies--; });
  applyQueue = run.catch(() => {});
  return run;
}

async function refreshAdminState(opts) {
  const r = await api("/admin/state");
  if (r.ok && !(opts && opts.fromPoll && pendingApplies > 0)) applyAdminState(r.data.state, opts);
  return r.ok;
}

async function pollAdminVersion() {
  if (pendingApplies > 0) return;
  const r = await api("/admin/version");
  if (r.ok && r.data.v !== lastAdminVersion) await refreshAdminState({ fromPoll: true });
}

async function resetMainCalendar(opts = {}) {
  const r = await apiPost("/admin/reset", { clearClients: !!opts.clearClients, confirm: opts.confirm });
  if (r.ok) applyAdminState(r.data.state);
  return r;
}

async function savePortfolioEntries(list) {
  const r = await apiPost("/admin/portfolio", { list });
  if (r.ok) { setPortfolioFromServer(r.data.portfolio); notifyDataUpdated(); }
  return r;
}

// --- SMS (all sending happens on the server) ---
async function checkSmsServerStatus() {
  const r = await api("/admin/sms/status");
  return r.ok ? r.data : { configured: false, reason: r.reason };
}

async function retryFailedSmsLog(logId) {
  const r = await apiPost("/admin/sms/retry", { id: logId });
  if (r.ok) applyAdminState(r.data.state);
  return r.ok && r.data.sent === true;
}

async function checkAndSendUpcomingReminders() {
  const r = await apiPost("/admin/reminders");
  if (r.ok) applyAdminState(r.data.state);
  return r;
}

// The WhatsApp link opens on the barber's device; the server only records that it happened.
function logWhatsappSend(phone, name, message, apptId) {
  smsLogs.unshift({ id: "wa_" + Date.now(), phone: toIsraeliLocalPhone(phone), name, message, category: "reminder", channel: "whatsapp", parts: 0, status: "sent", reason: "נשלח ב-WhatsApp", apptId });
  return broadcastCloudState();
}

// Confirms test mode with the server. Without an admin session the page stays in the real namespace.
async function resolveTestMode() {
  if (!TEST_MODE) return;
  const r = await api("/test/check");
  if (r.ok && r.data.test === true) { showTestModeBar(); return; }
  TEST_MODE = false;
  try { localStorage.removeItem("ilay_test_mode"); } catch (_) {}
  if (typeof window.onCoreError === "function") window.onCoreError(r.status === 403 ? "מצב בדיקות זמין רק אחרי כניסה לניהול." : r.reason);
}

// --- חישוב סטטיסטיקות חכם: ממוצע יומי -> שבועי -> חודשי (ללקוחות ולהכנסות) ---
function computeComprehensiveAnalytics(selectedDayFilter = null) {
  const todayIdx = selectedDayFilter !== null ? Number(selectedDayFilter) : israelDayIdx();

  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  let weeklyRevenueActual = 0;

  const weekAppts = currentWeekAppointments();
  const activeAppts = weekAppts.filter(a => a.status !== "canceled");
  activeAppts.forEach(a => {
    const d = Number(a.dayIdx);
    const price = Number(a.price) || 70;
    if (d >= 0 && d < 7) {
      dayTotals[d] += price;
      dayCounts[d] += 1;
      weeklyRevenueActual += price;
    }
  });

  const activeWorkdaysInWeek = weeklySchedule.filter(d => d.active).length || 6;
  const daysWithActualBookings = dayCounts.filter(c => c > 0).length;
  const divisorDays = daysWithActualBookings > 0 ? daysWithActualBookings : activeWorkdaysInWeek;

  // חישוב שרשרת לקוחות/תורים: יומי -> שבועי -> חודשי
  const todayAppts = dayCounts[todayIdx] || 0;
  const weekApptsActual = activeAppts.length;
  const avgClientsPerDayRaw = weekApptsActual / divisorDays;
  const avgClientsPerDay = Math.round(avgClientsPerDayRaw * 10) / 10;
  const projectedWeeklyClients = Math.round(avgClientsPerDayRaw * activeWorkdaysInWeek);
  const projectedMonthlyClients = Math.round(projectedWeeklyClients * 4.3);

  // חישוב שרשרת כסף והכנסות: יומי -> שבועי -> חודשי
  const todayRevenue = dayTotals[todayIdx] || 0;
  const avgDailyRevenue = Math.round(weeklyRevenueActual / divisorDays);
  const projectedWeeklyRevenue = Math.round(avgDailyRevenue * activeWorkdaysInWeek);
  const projectedMonthlyRevenue = Math.round(projectedWeeklyRevenue * 4.3);

  const confirmedAppts = activeAppts.filter(a => a.status === "confirmed").length;
  const pendingAppts = activeAppts.filter(a => !a.status || a.status === "pending").length;
  const canceledAppts = weekAppts.filter(a => a.status === "canceled").length;

  // לקוחות רשומים
  const totalClients = registeredUsers.length;
  const visitCountsByPhone = {};
  appointments.filter(a => a.status !== "canceled").forEach(a => {
    const p = toIsraeliLocalPhone(a.phone);
    visitCountsByPhone[p] = (visitCountsByPhone[p] || 0) + 1;
  });

  // הודעות SMS
  // Lifetime counters from the server; the log list in the browser is only the recent history.
  const smsDelivered = smsStats.delivered || 0;
  const smsFailed = Math.max(0, smsStats.failed || 0);
  const totalPartsUsed = smsStats.partsTotal || 0;
  const byCategory = {
    booking: smsStats.parts_booking || 0, move: smsStats.parts_move || 0, cancel: smsStats.parts_cancel || 0,
    reminder: smsStats.parts_reminder || 0, broadcast: smsStats.parts_broadcast || 0
  };

  const quota = Number(siteConfig.smsPackageQuota) || 1000;
  const remaining = Math.max(0, quota - totalPartsUsed);

  return {
    revenue: {
      todayRevenue,
      avgDailyRevenue,
      weeklyRevenueActual,
      projectedWeeklyRevenue,
      projectedMonthlyRevenue,
      dayTotals,
      dayCounts
    },
    appts: {
      todayAppts,
      avgClientsPerDay,
      weekApptsActual,
      projectedWeeklyClients,
      projectedMonthlyClients,
      activeWorkdaysInWeek,
      confirmedAppts,
      pendingAppts,
      canceledAppts,
      apptsByDay: dayCounts
    },
    clients: {
      totalClients,
      visitCountsByPhone
    },
    messages: {
      smsDelivered,
      smsFailed,
      totalPartsUsed,
      quota,
      remaining,
      byCategory
    }
  };
}

// --- מנוע תלת-מימד ריאליסטי (Three.js) ---
function initRealistic3DBarberScene() {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas || !window.THREE) return;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const warmLight = new THREE.PointLight(0xffdf8e, 2.1, 35); warmLight.position.set(6, 8, 9); scene.add(warmLight);
  const coolLight = new THREE.PointLight(0x60a5fa, 1.3, 35); coolLight.position.set(-7, -5, 8); scene.add(coolLight);

  const sc = document.createElement("canvas"); sc.width = 512; sc.height = 512;
  const ctx = sc.getContext("2d"); ctx.fillStyle = "#f8fafc"; ctx.fillRect(0, 0, 512, 512);
  const drawBand = (off, col) => {
    ctx.fillStyle = col;
    for (let y = -512; y < 1024; y += 256) {
      ctx.beginPath(); ctx.moveTo(0, y + off); ctx.lineTo(512, y + 512 + off);
      ctx.lineTo(512, y + 512 + off + 68); ctx.lineTo(0, y + off + 68); ctx.closePath(); ctx.fill();
    }
  };
  drawBand(0, "#c1121f"); drawBand(128, "#1d3557");
  const poleTex = new THREE.CanvasTexture(sc);
  poleTex.wrapS = THREE.RepeatWrapping; poleTex.wrapT = THREE.RepeatWrapping; poleTex.repeat.set(1, 1.85);

  const coreMat = new THREE.MeshStandardMaterial({ map: poleTex, roughness: 0.25, metalness: 0.1 });
  const glassMat = new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, shininess: 160 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.18 });

  function makePole() {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 3.1, 40), coreMat);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.53, 0.53, 3.14, 40), glassMat);
    const topD = new THREE.Mesh(new THREE.SphereGeometry(0.47, 32, 20), goldMat); topD.position.y = 1.72;
    const botD = new THREE.Mesh(new THREE.SphereGeometry(0.47, 32, 20), goldMat); botD.position.y = -1.72;
    g.add(core, glass, topD, botD); g.userData = { core }; return g;
  }

  const cfgs = [
    { x: -5.4, y: 1.7, z: -1.8, scale: 0.9, rotZ: 0.18 },
    { x: 5.5, y: -1.7, z: -1.4, scale: 0.94, rotZ: -0.18 }
  ];
  const poles = cfgs.map(c => { const p = makePole(); scene.add(p); return { group: p, ...c }; });

  function resize() {
    const w = window.innerWidth, h = window.innerHeight, mob = w < 680;
    camera.aspect = w / h; camera.position.z = mob ? 16.2 : 13.8; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    poles.forEach((p, i) => {
      p.group.position.set(cfgs[i].x * (mob ? 0.36 : 1), cfgs[i].y, p.z);
      p.group.scale.setScalar(p.scale * (mob ? 0.76 : 1));
      p.group.rotation.z = p.rotZ;
    });
  }
  resize(); window.addEventListener("resize", resize);

  (function anim() {
    requestAnimationFrame(anim);
    if (document.body.classList.contains("acc-no-anim")) return;
    const t = performance.now() * 0.001;
    poleTex.offset.y -= 0.0036;
    poles.forEach((p, i) => {
      p.group.userData.core.rotation.y += 0.014;
      p.group.position.y = cfgs[i].y + Math.sin(t * 1.15 + i) * 0.2;
    });
    renderer.render(scene, camera);
  })();
}
