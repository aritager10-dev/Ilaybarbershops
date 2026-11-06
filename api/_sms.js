// All SMS leave from here. Provider logic is carried over from the previous api/send-sms.js:
//   SMS_PROVIDER = textme | 019 | twilio (default textme), SMS_USERNAME, SMS_API_TOKEN, SMS_SENDER,
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM.
const { pipeline } = require("./_redis");
const { K, addLog, addNotification } = require("./_data");
const { mobilePhone } = require("./_validate");
const { ipKey, shortHash } = require("./_guard");
const { todayYmd, DAYS_HEB } = require("./_time");

const PROVIDERS = {
  textme: { label: "TextMe", url: "https://my.textme.co.il/api" },
  "019": { label: "019 SMS", url: "https://019sms.co.il/api" }
};
const TEXTME_ERRORS = {
  1: "שגיאת פורמט בבקשה", 2: "חסר שדה חובה", 9: "מספר טלפון לא תקין",
  515: "שם השולח לא מאומת אצל הספק", 989: "ההודעה ריקה או ארוכה מדי", 998: "שגיאה לא ידועה אצל הספק"
};
const MAX_LEN = 600;
const CAP_PHONE_DAY = 15;
const CAP_IP_DAY = 40;
const SEND_TIMEOUT_MS = 6000;

function smsConfig() {
  const provider = String(process.env.SMS_PROVIDER || "textme").toLowerCase().trim();
  const sender = String(process.env.SMS_SENDER || "Ilay").trim().slice(0, 11);
  let configured = false;
  if (PROVIDERS[provider]) configured = !!(process.env.SMS_USERNAME && process.env.SMS_API_TOKEN);
  else if (provider === "twilio") configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  return { provider, sender, configured };
}

function smsStatus() {
  const { provider, sender, configured } = smsConfig();
  return { configured, provider: PROVIDERS[provider] ? PROVIDERS[provider].label : provider, sender, reason: configured ? undefined : "חסרים משתני סביבה ב-Vercel (SMS_USERNAME / SMS_API_TOKEN)" };
}

async function sendViaTextmeFamily(provider, sender, phoneLocal, message) {
  const res = await fetch(PROVIDERS[provider].url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + process.env.SMS_API_TOKEN },
    body: JSON.stringify({ sms: { user: { username: process.env.SMS_USERNAME }, source: sender, destinations: { phone: phoneLocal.slice(1) }, message } }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch (_) {}
  const status = Number(data.status);
  if (res.ok && status === 0) return { ok: true, reason: `נשלח (${PROVIDERS[provider].label})` };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "טוקן API שגוי או לא מורשה" };
  return { ok: false, reason: TEXTME_ERRORS[status] || data.message || `שגיאת ספק (HTTP ${res.status})` };
}

async function sendViaTwilio(phoneLocal, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + auth },
    body: new URLSearchParams({ To: "+972" + phoneLocal.slice(1), From: process.env.TWILIO_FROM, Body: message }).toString(),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, reason: "נשלח (Twilio)" } : { ok: false, reason: data.message || `Twilio HTTP ${res.status}` };
}

async function rawSend(phone, message) {
  const { provider, sender, configured } = smsConfig();
  if (!configured) return { ok: false, reason: "ספק SMS לא מוגדר ב-Vercel" };
  try {
    if (PROVIDERS[provider]) return await sendViaTextmeFamily(provider, sender, phone, message);
    if (provider === "twilio") return await sendViaTwilio(phone, message);
    return { ok: false, reason: "SMS_PROVIDER לא נתמך" };
  } catch (_) {
    console.error("[sms] network error");
    return { ok: false, reason: "אין חיבור לספק ה-SMS" };
  }
}

const calcParts = t => { const n = String(t || "").length; return !n ? 0 : n <= 70 ? 1 : Math.ceil(n / 67); };

async function overDailyCaps(ctx, phone, withIpCap) {
  const day = todayYmd();
  const pKey = K(ctx, `cap:p:${shortHash(phone)}:${day}`);
  const cmds = [["SET", pKey, "0", "NX", "EX", 172800], ["INCR", pKey]];
  if (withIpCap) {
    const iKey = K(ctx, `cap:i:${ipKey(ctx.req)}:${day}`);
    cmds.push(["SET", iKey, "0", "NX", "EX", 172800], ["INCR", iKey]);
  }
  const res = await pipeline(cmds);
  return Number(res[1]) > CAP_PHONE_DAY || (withIpCap && Number(res[3]) > CAP_IP_DAY);
}

// Sends one message, logs it and reports a failure to the admin. Never throws: a failed
// SMS must not fail the booking that triggered it.
// opts.logMessage replaces the stored text (reset codes are never written to the log).
async function sendTracked(ctx, opts) {
  try {
    const phone = mobilePhone(opts.phone);
    const message = String(opts.message || "");
    let result;
    if (!phone) result = { ok: false, reason: "מספר נייד לא תקין" };
    else if (!message || message.length > MAX_LEN) result = { ok: false, reason: "הודעה ריקה או ארוכה מדי" };
    else if (await overDailyCaps(ctx, phone, opts.ipCap === true)) result = { ok: false, reason: "הגעת למכסת ההודעות היומית" };
    else result = await rawSend(phone, message);
    if (!result.ok) console.error("[sms] failed", { category: opts.category, reason: result.reason });

    await addLog(ctx, {
      phone: phone || String(opts.phone || ""), name: opts.name, message: opts.logMessage || message, category: opts.category,
      parts: calcParts(message), status: result.ok ? "sent" : "failed", reason: result.reason, apptId: opts.apptId, uid: opts.uid, noRetry: !!opts.logMessage
    });
    if (!result.ok) {
      await addNotification(ctx, {
        type: "sms_failed", title: "כישלון בשליחת SMS", message: `הודעה אל ${opts.name || ""} (${phone || opts.phone}) נכשלה: ${result.reason}`,
        apptId: opts.apptId, uid: opts.uid, pushMessage: "הודעת SMS נכשלה, פרטים בממשק הניהול"
      });
    }
    return result;
  } catch (_) {
    console.error("[sms] tracking error");
    return { ok: false, reason: "שגיאה בשליחת ההודעה" };
  }
}

// Blocks phishing through admin free text: links may point only to this site.
function hasForeignLink(message, host) {
  const own = String(host || "").toLowerCase().split(":")[0];
  const extra = String(process.env.ALLOWED_ORIGINS || "").toLowerCase().split(",").map(s => s.trim().replace(/^https?:\/\//, "").split(/[/:]/)[0]).filter(Boolean);
  const found = String(message || "").match(/(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?)/gi) || [];
  return found.some(l => {
    const h = l.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
    return !(h === own || extra.includes(h));
  });
}

async function retryLog(ctx, log) {
  const phone = mobilePhone(log.phone);
  let result;
  if (log.noRetry || !phone) result = { ok: false, reason: "אי אפשר לשלוח שוב את ההודעה הזו" };
  else if (hasForeignLink(log.message, ctx.host)) result = { ok: false, reason: "קישורים מותרים רק לאתר של המספרה" };
  else if (await overDailyCaps(ctx, phone, false)) result = { ok: false, reason: "הגעת למכסת ההודעות היומית" };
  else result = await rawSend(phone, log.message);
  log.status = result.ok ? "sent" : "failed";
  log.reason = result.reason;
  await pipeline([["HSET", K(ctx, "smslogs"), log.id, JSON.stringify(log)], ["INCR", K(ctx, "ver")]]);
  return result;
}

// --- Templates. Names are reduced to letters so an account name cannot smuggle a link into a text. ---
const smsName = n => String(n || "").replace(/[^\p{L}\p{M}\s'׳"״-]/gu, "").trim().slice(0, 40);
const siteUrl = ctx => `https://${ctx.host}/#personal-area`;
const when = a => ({ day: DAYS_HEB[a.dayIdx], date: a.dateStr, time: a.time, name: smsName(a.name) });
const templates = {
  clientBooked(ctx, a) { const w = when(a); return `היי ${w.name}, התור שלך ל-Ilay Barbershop נקבע ליום ${w.day} (${w.date}) בשעה ${w.time}. לצפייה ואישור הגעה באזור האישי: ${siteUrl(ctx)}`; },
  clientMoved(ctx, a) { const w = when(a); return `היי ${w.name}, מועד התור שלך ב-Ilay Barbershop עודכן ליום ${w.day} (${w.date}) בשעה ${w.time}.`; },
  adminBooked(ctx, a) { const w = when(a); return `היי ${w.name}, נקבע לך תור ב-Ilay Barbershop ליום ${w.day} (${w.date}) בשעה ${w.time}. לאישור הגעה: ${siteUrl(ctx)}`; },
  adminMoved(ctx, a) { const w = when(a); return `אהלן ${w.name}, עדכון מ-Ilay Barbershop: התור שלך הוזז ליום ${w.day} (${w.date}) בשעה ${w.time}. לאישור הגעה: ${siteUrl(ctx)}`; },
  adminCanceled(ctx, a) { const w = when(a); return `אהלן ${w.name}, הודעה מ-Ilay Barbershop: התור שלך ליום ${w.day} (${w.date}) בשעה ${w.time} בוטל. לקביעת מועד חדש היכנס לאתר.`; },
  reminder(ctx, a) { const w = when(a); return `אהלן ${w.name}, תזכורת מ-Ilay Barbershop: התור שלך ליום ${w.day} (${w.date}) מתקיים בשעה ${w.time}. האם אתה מאשר הגעה? לאישור הגעה מהיר היכנס לאזור האישי: ${siteUrl(ctx)}`; },
  resetCode(code) { return `קוד איפוס הסיסמה שלך ב-Ilay Barbershop: ${code}. הקוד תקף ל-10 דקות. אם לא ביקשת, אפשר להתעלם.`; },
  test() { return "בדיקת SMS מ-Ilay Barbershop. אם קיבלת את זה, ההודעות עובדות."; }
};

module.exports = { smsStatus, sendTracked, retryLog, hasForeignLink, templates, smsName };
