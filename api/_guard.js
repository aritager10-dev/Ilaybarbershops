// בדיקות משותפות לפונקציות השרת: מקור הבקשה והגבלת קצב.
// הערה: בלי מערכת התחברות בצד השרת אין הגנה מלאה; זה מצמצם שימוש לרעה מבחוץ.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const rateMap = new Map();

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

function allowedOrigins(req) {
  const host = req.headers.host || "";
  const list = [`https://${host}`];
  if (/^localhost(:\d+)?$/.test(host)) list.push(`http://${host}`);
  String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(o => list.push(o));
  return list;
}

// דורש Origin (או Referer) מהאתר עצמו. בקשה בלי שניהם נדחית.
function originAllowed(req) {
  const allowed = allowedOrigins(req);
  const origin = req.headers.origin;
  if (origin) return allowed.includes(origin);
  const ref = req.headers.referer || req.headers.referrer;
  if (ref) { try { return allowed.includes(new URL(ref).origin); } catch (_) { return false; } }
  return false;
}

function rateLimited(key, max) {
  const now = Date.now();
  const arr = (rateMap.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateMap.set(key, arr);
  if (rateMap.size > 5000) rateMap.clear();
  return arr.length > max;
}

module.exports = { originAllowed, rateLimited, clientIp };
