// When customers can book. Every date is closed unless the owner opened it.
//   1. A rule for that exact date: open with hours, or explicitly closed.
//   2. Otherwise a weekly rule for its weekday, if that weekday is opened "every week".
//   3. Otherwise closed.
// Dates are Israel-time YYYY-MM-DD strings. Weekdays are worked out from the date itself, never from "now",
// so the same weekday in two different weeks can never be confused.
const { HttpError } = require("./_http");
const { isYmd, todayYmd, addDays, dowOfYmd, epochFor, wallClockExists } = require("./_time");

const HORIZON_DAYS = 30;       // Customers can book today and the next 29 days.
const MAX_DATE_RULES = 400;
const MAX_FUTURE_DAYS = 366;   // How far ahead the owner can set a rule or place a manual appointment.
const DEFAULT_HOURS = { start: "10:00", end: "20:00" }; // Suggestions for the admin UI. They open nothing.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const bad = reason => new HttpError(400, reason);
const isTime = v => typeof v === "string" && TIME_RE.test(v);
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const validHours = (start, end) => isTime(start) && isTime(end) && toMin(start) < toMin(end);

function defaults() {
  return { weekly: Array.from({ length: 7 }, () => ({ open: false, ...DEFAULT_HOURS })), dates: {} };
}

// Whatever is stored, the result has the full shape, and anything unreadable counts as closed.
function normalize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== "object") return out;
  if (Array.isArray(raw.weekly)) {
    raw.weekly.slice(0, 7).forEach((d, i) => {
      if (d && validHours(d.start, d.end)) out.weekly[i] = { open: d.open === true, start: d.start, end: d.end };
    });
  }
  if (raw.dates && typeof raw.dates === "object") {
    for (const [date, rule] of Object.entries(raw.dates)) {
      if (!isYmd(date) || !rule) continue;
      if (rule.open === true && validHours(rule.start, rule.end)) out.dates[date] = { open: true, start: rule.start, end: rule.end };
      else out.dates[date] = { open: false };
    }
  }
  return out;
}

function effectiveDay(av, date) {
  const rule = av.dates[date];
  if (rule) return rule.open ? { open: true, source: "date", start: rule.start, end: rule.end } : { open: false, source: "date" };
  const week = av.weekly[dowOfYmd(date)];
  if (week && week.open) return { open: true, source: "weekly", start: week.start, end: week.end };
  return { open: false, source: "default" };
}

// Only what the booking screen needs: no rules, no reasons, nothing about closed days.
function publicOpenDays(av, now = Date.now()) {
  const today = todayYmd(now);
  const out = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const date = addDays(today, i);
    const day = effectiveDay(av, date);
    if (day.open) out.push({ date, start: day.start, end: day.end });
  }
  return out;
}

const stepOf = site => Math.max(10, (Number(site.slotInterval) || 30) + (Number(site.slotBuffer) || 0));

// Same grid the booking UI renders.
function slotOnGrid(site, day, time) {
  const target = toMin(time);
  const end = toMin(day.end);
  const step = stepOf(site);
  for (let cur = toMin(day.start); cur < end; cur += step) if (cur === target) return true;
  return false;
}

function assertBookable(av, site, date, time, now = Date.now()) {
  const today = todayYmd(now);
  if (date < today) throw bad("השעה הזו כבר עברה, נא לבחור שעה אחרת");
  if (date > addDays(today, HORIZON_DAYS - 1)) throw bad(`אפשר לקבוע תור עד ${HORIZON_DAYS} ימים קדימה. נא לבחור תאריך קרוב יותר.`);
  const day = effectiveDay(av, date);
  if (!day.open) throw bad("ביום הזה המספרה סגורה. אפשר לבחור יום אחר.");
  if (!slotOnGrid(site, day, time) || !wallClockExists(date, time)) throw bad("השעה הזו לא זמינה לקביעת תור");
  if (epochFor(date, time) <= now) throw bad("השעה הזו כבר עברה, נא לבחור שעה אחרת");
}

// A manual appointment may land on a closed day (the barber knows his own schedule), but it still needs a real date.
function adminSlotProblem(date, time, now = Date.now()) {
  if (!isYmd(date) || !isTime(time)) return "יום או שעה לא תקינים";
  const today = todayYmd(now);
  if (date < today) return "אי אפשר לשבץ תור בתאריך שעבר";
  if (date > addDays(today, MAX_FUTURE_DAYS)) return "התאריך רחוק מדי";
  if (!wallClockExists(date, time)) return "השעה הזו לא קיימת בתאריך הזה בגלל מעבר לשעון קיץ";
  return null;
}

// Body: { weekly?: seven rows, dates?: { "YYYY-MM-DD": { open: true, start, end } | { open: false } | null } }.
// A date set to null goes back to the weekly rule. Sending only what changed means two devices cannot overwrite each other.
function applyPatch(current, raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("weekly" in raw || "dates" in raw)) throw bad("בקשה לא תקינה");
  const next = { weekly: current.weekly.map(d => ({ ...d })), dates: { ...current.dates } };

  if ("weekly" in raw) {
    if (!Array.isArray(raw.weekly) || raw.weekly.length !== 7) throw bad("שעות שבועיות לא תקינות");
    next.weekly = raw.weekly.map(d => {
      if (!d || typeof d !== "object") throw bad("שעות שבועיות לא תקינות");
      if (d.open === true && !validHours(d.start, d.end)) throw bad("שעת הסיום חייבת להיות אחרי שעת הפתיחה");
      return validHours(d.start, d.end) ? { open: d.open === true, start: d.start, end: d.end } : { open: false, ...DEFAULT_HOURS };
    });
  }

  if ("dates" in raw) {
    if (!raw.dates || typeof raw.dates !== "object" || Array.isArray(raw.dates)) throw bad("תאריכים לא תקינים");
    const entries = Object.entries(raw.dates);
    if (entries.length > MAX_DATE_RULES) throw bad("יותר מדי תאריכים בבקשה אחת");
    const today = todayYmd(now);
    const last = addDays(today, MAX_FUTURE_DAYS);
    for (const [date, rule] of entries) {
      if (!isYmd(date)) throw bad("תאריך לא תקין");
      if (rule === null) { delete next.dates[date]; continue; }
      if (date < today) throw bad("אי אפשר לשנות תאריך שכבר עבר");
      if (date > last) throw bad("אפשר לקבוע תאריכים עד שנה קדימה");
      if (!rule || typeof rule !== "object") throw bad("תאריך לא תקין");
      if (rule.open === true) {
        if (!validHours(rule.start, rule.end)) throw bad("שעת הסיום חייבת להיות אחרי שעת הפתיחה");
        next.dates[date] = { open: true, start: rule.start, end: rule.end };
      } else if (rule.open === false) {
        next.dates[date] = { open: false };
      } else {
        throw bad("תאריך לא תקין");
      }
    }
    if (Object.keys(next.dates).length > MAX_DATE_RULES) throw bad(`אפשר לשמור עד ${MAX_DATE_RULES} תאריכים`);
  }
  return next;
}

// Rules for dates that have passed do nothing any more. Returns null when there is nothing to drop.
function pruned(av, now = Date.now()) {
  const today = todayYmd(now);
  const keep = Object.entries(av.dates).filter(([date]) => date >= today);
  if (keep.length === Object.keys(av.dates).length) return null;
  return { weekly: av.weekly, dates: Object.fromEntries(keep) };
}

module.exports = { HORIZON_DAYS, MAX_DATE_RULES, MAX_FUTURE_DAYS, DEFAULT_HOURS, defaults, normalize, effectiveDay, publicOpenDays, slotOnGrid, assertBookable, adminSlotProblem, applyPatch, pruned };
