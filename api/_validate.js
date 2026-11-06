// Server-side validation. Every value from a browser passes through here; unknown fields are dropped.
const { HttpError } = require("./_http");

const bad = reason => new HttpError(400, reason);
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Plain text only: no control characters, and no HTML/JS metacharacters as defense in depth
// (every render sink also escapes).
function text(v, max) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/[<>`\\]/g, "").trim().slice(0, max).trim();
}

function isId(v) { return typeof v === "string" && ID_RE.test(v); }
function isTime(v) { return typeof v === "string" && TIME_RE.test(v); }

function localDigits(raw) {
  let d = String(raw === null || raw === undefined ? "" : raw).replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (d && !d.startsWith("0")) d = "0" + d;
  return d;
}
// Israeli mobile, the only kind that can receive SMS.
function mobilePhone(raw) { const d = localDigits(raw); return /^05\d{8}$/.test(d) ? d : null; }
// Admin-entered customers may also have a landline; SMS to those fails gracefully and is logged.
function anyPhone(raw) { const d = localDigits(raw); return /^0\d{8,9}$/.test(d) ? d : null; }

function price(v) {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || typeof v === "boolean" || !Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

function intIn(v, min, max) {
  if (v === "" || v === null || v === undefined || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function hasLinkLike(s) {
  return /(https?:\/\/|www\.)/i.test(s) || /[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/|\b)/i.test(s);
}

function clientName(raw) {
  const name = text(raw, 40);
  if (name.replace(/[^a-zA-Z֐-׿]/g, "").length < 2) throw bad("נא להזין שם מלא תקין");
  if (hasLinkLike(name)) throw bad("נא להזין שם מלא תקין");
  return name;
}

function password(raw) {
  if (typeof raw !== "string" || raw.length < 8) throw bad("נא לבחור סיסמה בת 8 תווים לפחות");
  if (raw.length > 128) throw bad("הסיסמה ארוכה מדי");
  return raw;
}

function services(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 30) throw bad("מחירון לא תקין");
  return list.map(s => {
    const p = s && typeof s === "object" ? price(s.price) : null;
    const name = s && text(s.name, 45);
    if (!name || p === null) throw bad("שירות במחירון לא תקין");
    return { name, price: p, duration: text(s.duration, 25) || "30 דק'", desc: text(s.desc, 140) };
  });
}

// Only these keys can ever exist in the stored config.
function siteConfigPatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("הגדרות לא תקינות");
  const out = {};
  if ("title" in raw) out.title = text(raw.title, 50) || "ILAY BARBERSHOP";
  if ("subtitle" in raw) out.subtitle = text(raw.subtitle, 90);
  const ints = { slotInterval: [5, 240], slotBuffer: [0, 60], reminderHoursBefore: [1, 48], smsPackageQuota: [1, 1000000] };
  for (const k of Object.keys(ints)) {
    if (k in raw) {
      const n = intIn(raw[k], ints[k][0], ints[k][1]);
      if (n === null) throw bad("ערך לא תקין בהגדרות");
      out[k] = n;
    }
  }
  if ("barberPhone" in raw) {
    const p = mobilePhone(raw.barberPhone);
    if (!p) throw bad("מספר הטלפון של הספר לא תקין");
    out.barberPhone = p;
  }
  return out;
}

module.exports = { text, isId, isTime, mobilePhone, anyPhone, price, intIn, hasLinkLike, clientName, password, services, siteConfigPatch, bad };
