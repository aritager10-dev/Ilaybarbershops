// Vercel Serverless Function: שליחת SMS דרך ספק ישראלי.
// הסודות נשמרים רק במשתני הסביבה של Vercel:
//   SMS_PROVIDER   = textme | 019 | twilio   (ברירת מחדל: textme)
//   SMS_USERNAME   = שם המשתמש בחשבון הספק (TextMe / 019)
//   SMS_API_TOKEN  = הטוקן מהקונסול של הספק (TextMe / 019)
//   SMS_SENDER     = שם שולח מאומת, עד 11 תווים באנגלית/ספרות (ברירת מחדל: Ilay)
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM  (רק אם משתמשים ב-Twilio)
//   ALLOWED_ORIGINS = רשימת דומיינים מופרדת בפסיקים (אופציונלי, למשל https://ilay.co.il)

const PROVIDERS = {
  textme: { label: "TextMe", url: "https://my.textme.co.il/api" },
  "019": { label: "019 SMS", url: "https://019sms.co.il/api" }
};

const TEXTME_ERRORS = {
  1: "שגיאת פורמט בבקשה",
  2: "חסר שדה חובה",
  9: "מספר טלפון לא תקין",
  515: "שם השולח לא מאומת אצל הספק",
  989: "ההודעה ריקה או ארוכה מדי",
  998: "שגיאה לא ידועה אצל הספק"
};

const MAX_LEN = 600;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 40;
const rateMap = new Map();

function cfg() {
  const provider = String(process.env.SMS_PROVIDER || "textme").toLowerCase().trim();
  const sender = String(process.env.SMS_SENDER || "Ilay").trim().slice(0, 11);
  let configured = false;
  if (PROVIDERS[provider]) configured = !!(process.env.SMS_USERNAME && process.env.SMS_API_TOKEN);
  else if (provider === "twilio") configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  return { provider, sender, configured };
}

function originAllowed(req) {
  const origin = req.headers.origin || "";
  if (!origin) return true; // אותו דומיין (חלק מהדפדפנים לא שולחים Origin ב-same-origin)
  const host = req.headers.host || "";
  if (origin === `https://${host}` || origin === `http://${host}`) return true;
  const extra = String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (rateMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateMap.set(ip, arr);
  return arr.length > RATE_MAX;
}

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  if (!d.startsWith("0")) d = "0" + d;
  return /^05\d{8}$/.test(d) ? d : null; // רק ניידים ישראליים
}

async function sendViaTextmeFamily(provider, sender, phoneLocal, message) {
  const body = {
    sms: {
      user: { username: process.env.SMS_USERNAME },
      source: sender,
      destinations: { phone: phoneLocal.slice(1) }, // פורמט 5xxxxxxxx
      message
    }
  };
  const res = await fetch(PROVIDERS[provider].url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + process.env.SMS_API_TOKEN
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  const status = Number(data.status);
  if (res.ok && status === 0) return { ok: true, reason: `נשלח (${PROVIDERS[provider].label})`, id: data.shipment_id };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "טוקן API שגוי או לא מורשה" };
  const reason = TEXTME_ERRORS[status] || data.message || `שגיאת ספק (HTTP ${res.status})`;
  return { ok: false, reason, code: Number.isFinite(status) ? status : undefined };
}

async function sendViaTwilio(phoneLocal, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + auth },
    body: new URLSearchParams({ To: "+972" + phoneLocal.slice(1), From: process.env.TWILIO_FROM, Body: message }).toString()
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, reason: "נשלח (Twilio)", id: data.sid } : { ok: false, reason: data.message || `Twilio HTTP ${res.status}` };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { provider, sender, configured } = cfg();

  if (req.method === "GET") {
    return res.status(200).json({
      configured,
      provider: PROVIDERS[provider]?.label || provider,
      sender,
      reason: configured ? undefined : "חסרים משתני סביבה ב-Vercel (SMS_USERNAME / SMS_API_TOKEN)"
    });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, reason: "Method not allowed" });
  if (!originAllowed(req)) return res.status(403).json({ ok: false, reason: "מקור לא מורשה" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ ok: false, reason: "יותר מדי הודעות, נסה שוב בעוד כמה דקות" });

  if (!configured) return res.status(503).json({ ok: false, reason: "ספק SMS לא מוגדר ב-Vercel" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const phone = normalizePhone(body && body.to);
  const message = String((body && body.message) || "").trim();
  if (!phone) return res.status(400).json({ ok: false, reason: "מספר נייד לא תקין" });
  if (!message || message.length > MAX_LEN) return res.status(400).json({ ok: false, reason: "הודעה ריקה או ארוכה מדי" });

  try {
    const result = PROVIDERS[provider]
      ? await sendViaTextmeFamily(provider, sender, phone, message)
      : provider === "twilio"
        ? await sendViaTwilio(phone, message)
        : { ok: false, reason: "SMS_PROVIDER לא נתמך" };
    if (!result.ok) console.error("[send-sms] failed", { provider, code: result.code, reason: result.reason });
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    console.error("[send-sms] network error", err && err.message);
    return res.status(502).json({ ok: false, reason: "אין חיבור לספק ה-SMS" });
  }
};
