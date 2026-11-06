// All booking dates are computed in Israel time; Vercel functions run in UTC.
const TZ = "Asia/Jerusalem";
const DAYS_HEB = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "מוצ״ש"];
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short"
});

function parts(ms) {
  const o = {};
  fmt.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, dow: WD[o.weekday] };
}
const pad = n => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function todayYmd(now = Date.now()) { const p = parts(now); return ymd(p.y, p.m, p.d); }

function addDays(dateYmd, n) {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function epochFor(dateYmd, timeStr) {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess);
    guess = wall - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - guess);
  }
  return guess;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A real calendar date, so "2026-02-30" does not pass.
function isYmd(v) {
  const m = typeof v === "string" ? YMD_RE.exec(v) : null;
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}

function dowOfYmd(dateYmd) {
  const [y, m, d] = dateYmd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// False only for the hour the clocks skip when summer time starts.
function wallClockExists(dateYmd, timeStr) {
  const p = parts(epochFor(dateYmd, timeStr));
  return ymd(p.y, p.m, p.d) === dateYmd && `${pad(p.h)}:${pad(p.mi)}` === timeStr;
}

function dateStrOf(dateYmd) { const [, m, d] = dateYmd.split("-"); return `${d}/${m}`; }
function heTime(ms = Date.now()) { return new Date(ms).toLocaleTimeString("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }); }
function heDate(ms = Date.now()) { return new Date(ms).toLocaleDateString("he-IL", { timeZone: TZ }); }
function heDateTime(ms = Date.now()) { return new Date(ms).toLocaleString("he-IL", { timeZone: TZ }); }

module.exports = { DAYS_HEB, parts, todayYmd, addDays, isYmd, dowOfYmd, wallClockExists, epochFor, dateStrOf, heTime, heDate, heDateTime };
