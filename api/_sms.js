// All SMS leave from here. Provider logic is carried over from the previous api/send-sms.js:
//   SMS_PROVIDER = textme | 019 | twilio (default textme), SMS_USERNAME, SMS_API_TOKEN, SMS_SENDER,
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM.
const { pipeline } = require("./_redis");
const { K, addLog, addNotification, getUser } = require("./_data");
const { optOutUrl } = require("./_optout");
const { cmd } = require("./_redis");
const { mobilePhone } = require("./_validate");
const { ipKey, shortHash, RATE_SCRIPT } = require("./_guard");
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
const CAP_GLOBAL_DAY = 500;
// Reset and verification codes draw on a budget of their own, so requesting codes for someone's
// number cannot use up the daily allowance that their booking texts and reminders depend on.
const CODE_CAP_PHONE_DAY = 6;
const CODE_CAP_IP_DAY = 20;
const CODE_CAP_GLOBAL_DAY = 150;
const SEND_TIMEOUT_MS = 6000;

function smsConfig() {
  const provider = String(process.env.SMS_PROVIDER || "textme").toLowerCase().trim();
  const sender = String(process.env.SMS_SENDER || "Ilay").trim().slice(0, 11);
  let configured = false;
  if (PROVIDERS[provider]) configured = !!(process.env.SMS_USERNAME && process.env.SMS_API_TOKEN);
  else if (provider === "twilio") configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
  return { provider, sender, configured };
}

const smsConfigured = () => smsConfig().configured;

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

const rateCmd = (key, sec) => ["EVAL", RATE_SCRIPT, 1, key, sec];

// Returns the refusal reason, or null when the message may go out. Crossing the site-wide cap tells
// the admin once: the atomic counter passes the limit+1 value exactly one time.
async function dailyCapRefusal(ctx, phone, { ipCap = false, codeBudget = false } = {}) {
  const day = todayYmd();
  const prefix = codeBudget ? "codecap" : "cap";
  const limits = codeBudget ? { p: CODE_CAP_PHONE_DAY, i: CODE_CAP_IP_DAY, g: CODE_CAP_GLOBAL_DAY } : { p: CAP_PHONE_DAY, i: CAP_IP_DAY, g: CAP_GLOBAL_DAY };
  const cmds = [rateCmd(K(ctx, `${prefix}:g:${day}`), 172800), rateCmd(K(ctx, `${prefix}:p:${shortHash(phone)}:${day}`), 172800)];
  if (ipCap) cmds.push(rateCmd(K(ctx, `${prefix}:i:${ipKey(ctx.req)}:${day}`), 172800));
  const [g, p, i] = (await pipeline(cmds)).map(Number);
  if (g === limits.g + 1) {
    await addNotification(ctx, {
      type: "sms_cap", title: "הגעת למכסת ה-SMS היומית", message: codeBudget ? "שליחת קודי האימות נעצרה עד מחר." : "שליחת הודעות SMS נעצרה עד מחר. התורים ממשיכים להיקבע כרגיל."
    });
  }
  if (g > limits.g) return { reason: "הגעת למכסת ההודעות היומית של האתר", siteCap: true };
  if (p > limits.p || (ipCap && i > limits.i)) return { reason: "הגעת למכסת ההודעות היומית" };
  return null;
}

// Lifetime counters behind the "remaining in package" figure; the log history alone is trimmed.
async function countResult(ctx, category, parts, result, { retried = false } = {}) {
  const key = K(ctx, "smsstats");
  const cmds = [];
  if (result.ok) {
    cmds.push(["HINCRBY", key, "partsTotal", parts], ["HINCRBY", key, "delivered", 1], ["HINCRBY", key, "parts_" + category, parts]);
    if (retried) cmds.push(["HINCRBY", key, "failed", -1]);
  } else if (!retried) cmds.push(["HINCRBY", key, "failed", 1]);
  await pipeline(cmds);
}

// Sends one message, logs it and reports a failure to the admin. Never throws: a failed
// SMS must not fail the booking that triggered it.
// opts.logMessage replaces the stored text (reset codes are never written to the log).
async function sendTracked(ctx, opts) {
  try {
    const phone = mobilePhone(opts.phone);
    const message = String(opts.message || "");
    let result;
    let refusal = null;
    if (!phone) result = { ok: false, reason: "מספר נייד לא תקין" };
    else if (!message || message.length > MAX_LEN) result = { ok: false, reason: "הודעה ריקה או ארוכה מדי" };
    else if ((refusal = smsConfigured() ? await dailyCapRefusal(ctx, phone, opts) : null)) result = { ok: false, reason: refusal.reason };
    else result = await rawSend(phone, message);
    if (!result.ok) console.error("[sms] failed", { category: opts.category, reason: result.reason });

    await addLog(ctx, {
      phone: phone || String(opts.phone || ""), name: opts.name, message: opts.logMessage || message, category: opts.category,
      parts: calcParts(message), status: result.ok ? "sent" : "failed", reason: result.reason, apptId: opts.apptId, uid: opts.uid, noRetry: !!opts.logMessage
    });
    await countResult(ctx, opts.category, calcParts(message), result);
    // Without a provider there is nothing to alert about: the status box says so, and every booking would ring otherwise.
    if (!result.ok && smsConfigured() && !(refusal && refusal.siteCap)) {
      await addNotification(ctx, {
        type: "sms_failed", title: "כישלון בשליחת SMS", message: `הודעה אל ${opts.name || ""} (${phone || opts.phone}) נכשלה: ${result.reason}`,
        apptId: opts.apptId, uid: opts.uid
      });
    }
    return result;
  } catch (_) {
    console.error("[sms] tracking error");
    return { ok: false, reason: "שגיאה בשליחת ההודעה" };
  }
}

// Appointment texts. An appointment booked by an account whose phone was never proven gets none,
// so nobody can use the site to send texts to a number that is not theirs.
async function sendApptSms(ctx, appt, message, category, extra = {}) {
  if (appt.noSms) return { ok: false, reason: "הטלפון לא אומת" };
  return sendTracked(ctx, { phone: appt.phone, name: appt.name, message, category, apptId: appt.id, ...extra });
}

const allowedLinkHosts = host => {
  const own = String(host || "").toLowerCase().split(":")[0];
  const extra = String(process.env.ALLOWED_ORIGINS || "").toLowerCase().split(",").map(s => s.trim().replace(/^https?:\/\//, "").split(/[/:]/)[0]).filter(Boolean);
  return { own, extra };
};

// Blocks phishing through admin free text: links may point only to this site.
function hasForeignLink(message, host) {
  const { own, extra } = allowedLinkHosts(host);
  const found = String(message || "").match(/(https?:\/\/[^\s]+|www\.[^\s]+|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?)/gi) || [];
  return found.some(l => {
    const h = l.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
    return !(h === own || extra.includes(h));
  });
}

// A failed broadcast may be retried only while its recipient still wants marketing, and only if its text has the
// format the law requires (logs from before that format do not).
async function broadcastRetryRefusal(ctx, log, phone) {
  if (!String(log.message).startsWith(BROADCAST_PREFIX + "\n")) return "ההודעה הזו נשלחה בפורמט ישן. אפשר לשלוח הודעה חדשה.";
  const uid = await cmd("HGET", K(ctx, "idx:phone"), phone);
  const user = uid ? await getUser(ctx, uid) : null;
  if (!user || user.marketingOptIn !== true || user.phoneVerified !== true) return "הלקוח לא מאשר כרגע קבלת דיוור, ולכן ההודעה לא נשלחה שוב";
  return null;
}

async function retryLog(ctx, log) {
  const phone = mobilePhone(log.phone);
  let result;
  let marketingRefusal = null;
  if (log.noRetry || !phone) result = { ok: false, reason: "אי אפשר לשלוח שוב את ההודעה הזו" };
  else if (log.category === "broadcast" && (marketingRefusal = await broadcastRetryRefusal(ctx, log, phone))) result = { ok: false, reason: marketingRefusal };
  else if (hasForeignLink(log.message, ctx.host)) result = { ok: false, reason: "קישורים מותרים רק לאתר של המספרה" };
  else {
    const refusal = await dailyCapRefusal(ctx, phone);
    result = refusal ? { ok: false, reason: refusal.reason } : await rawSend(phone, log.message);
  }
  await countResult(ctx, log.category, calcParts(log.message), result, { retried: true });
  log.status = result.ok ? "sent" : "failed";
  log.reason = result.reason;
  await pipeline([["HSET", K(ctx, "smslogs"), log.id, JSON.stringify(log)], ["INCR", K(ctx, "ver")]]);
  return result;
}

// --- Templates. Names are reduced to letters so an account name cannot smuggle a link into a text. ---
const smsName = n => String(n || "").replace(/[^\p{L}\p{M}\s'׳"״-]/gu, "").trim().slice(0, 40);
// A stored service reads "name • price ₪"; the text gets the name. With no dots left it cannot spell a web address.
const smsService = s => String(s || "").split(" • ")[0].normalize("NFKC").replace(/[.\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
const siteUrl = ctx => `https://${ctx.host}/#personal-area`;
const BROADCAST_PREFIX = "פרסומת: Ilay Barbershop";

const TEMPLATES_KEY = "cfg:smsTemplates";
const TEMPLATE_MAX_LEN = 500;
const FIELD_LABELS = { "שם": "שם הלקוח", "יום": "יום", "תאריך": "תאריך", "שעה": "שעה", "שירות": "שירות", "קישור": "קישור לאתר", "קוד": "קוד" };
// The longest each value can get, to refuse a text that could pass the send limit once it is filled in. The link depends on the host.
const FIELD_MAX_LEN = { "שם": 40, "יום": 5, "תאריך": 5, "שעה": 5, "שירות": 80, "קוד": 6 };
const APPT_FIELDS = ["שם", "יום", "תאריך", "שעה", "שירות", "קישור"];
// The default wording is exactly what the site has always sent. The name on a registration form is whatever a stranger
// typed, so the texts that go out from that form (codes, already-registered) have no {שם}: nobody can word a text to a number that is not theirs.
const SMS_TEMPLATES = {
  clientBooked: { title: "קביעת תור ע״י לקוח", hint: "נשלחת ללקוח שקבע תור באתר.", fields: APPT_FIELDS, text: "היי {שם}, התור שלך ל-Ilay Barbershop נקבע ליום {יום} ({תאריך}) בשעה {שעה}. לצפייה ואישור הגעה באזור האישי: {קישור}" },
  clientMoved: { title: "הזזת תור ע״י לקוח", hint: "נשלחת ללקוח שהזיז את התור שלו באתר.", fields: APPT_FIELDS, text: "היי {שם}, מועד התור שלך ב-Ilay Barbershop עודכן ליום {יום} ({תאריך}) בשעה {שעה}." },
  adminBooked: { title: "קביעת תור ע״י הספר", hint: "נשלחת ללקוח כשאתה מוסיף לו תור ביומן.", fields: APPT_FIELDS, text: "היי {שם}, נקבע לך תור ב-Ilay Barbershop ליום {יום} ({תאריך}) בשעה {שעה}. לאישור הגעה: {קישור}" },
  adminMoved: { title: "הזזת תור ע״י הספר", hint: "נשלחת ללקוח כשאתה מזיז לו תור ביומן.", fields: APPT_FIELDS, text: "אהלן {שם}, עדכון מ-Ilay Barbershop: התור שלך הוזז ליום {יום} ({תאריך}) בשעה {שעה}. לאישור הגעה: {קישור}" },
  adminCanceled: { title: "ביטול תור ע״י הספר", hint: "נשלחת ללקוח כשאתה מבטל לו תור ביומן.", fields: APPT_FIELDS, text: "אהלן {שם}, הודעה מ-Ilay Barbershop: התור שלך ליום {יום} ({תאריך}) בשעה {שעה} בוטל. לקביעת מועד חדש היכנס לאתר." },
  reminder: { title: "תזכורת לפני תור", hint: "נשלחת ללקוח לפני התור, לפי מספר השעות שבהגדרות.", fields: APPT_FIELDS, text: "אהלן {שם}, תזכורת מ-Ilay Barbershop: התור שלך ליום {יום} ({תאריך}) מתקיים בשעה {שעה}. האם אתה מאשר הגעה? לאישור הגעה מהיר היכנס לאזור האישי: {קישור}" },
  verifyCode: { title: "קוד אימות בהרשמה", hint: "נשלחת למי שנרשם לאתר. בלי הקוד אי אפשר להשלים הרשמה, לכן הוא חובה.", fields: ["קוד"], required: ["קוד"], text: "קוד האימות שלך ב-Ilay Barbershop: {קוד}. הקוד תקף ל-10 דקות." },
  resetCode: { title: "קוד לאיפוס סיסמה", hint: "נשלחת למי ששכח סיסמה. בלי הקוד אי אפשר לאפס, לכן הוא חובה.", fields: ["קוד"], required: ["קוד"], text: "קוד איפוס הסיסמה שלך ב-Ilay Barbershop: {קוד}. הקוד תקף ל-10 דקות. אם לא ביקשת, אפשר להתעלם." },
  alreadyRegistered: { title: "הודעה למי שכבר רשום", hint: "נשלחת כשמישהו מנסה להירשם עם מספר שכבר יש לו חשבון.", fields: ["קישור"], text: "כבר יש לך חשבון ב-Ilay Barbershop עם המספר הזה. אפשר להיכנס באתר, או לאפס סיסמה במסך הכניסה." },
  test: { title: "הודעת בדיקה", hint: "נשלחת לטלפון שלך מהכפתור \"שליחת SMS בדיקה\".", fields: ["קישור"], text: "בדיקת SMS מ-Ilay Barbershop. אם קיבלת את זה, ההודעות עובדות." }
};

// System messages keep their fixed wording: they are not offered for editing, and an older saved edit is ignored.
const LOCKED_TEMPLATES = new Set(["verifyCode", "resetCode", "alreadyRegistered", "test"]);
const isTemplateKey = key => typeof key === "string" && Object.prototype.hasOwnProperty.call(SMS_TEMPLATES, key) && !LOCKED_TEMPLATES.has(key);
const defaultTemplateText = key => SMS_TEMPLATES[key].text;

// One pass over the template only, so a value is never read again: a customer named "{קוד}" stays "{קוד}".
// A function replacer, so "$&" in a value means nothing either.
function fillTemplate(text, values) {
  return String(text).replace(/\{([^{}]*)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole));
}

// Plain text with line breaks. Invisible format characters go too: one inside "evil.com" would hide it from the link check.
function cleanTemplateText(raw) {
  return String(raw).replace(/\r\n?/g, "\n").replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029<>`\\]|\p{Cf}/gu, "").trim();
}

// Judged on the text as it could go out, so "{שם}.com" counts: a customer called Dan would make it dan.com.
function templateHasForeignLink(key, text, host) {
  const probes = {};
  SMS_TEMPLATES[key].fields.forEach(f => { probes[f] = f === "קישור" ? `https://${host}/#personal-area` : "aa1"; });
  const shown = fillTemplate(text, probes).normalize("NFKC");
  if (hasForeignLink(shown, host)) return true;
  // Phones also turn "אתר.com" and bare IP addresses into links, which the free-text check does not look for.
  const { own, extra } = allowedLinkHosts(host);
  return shown.split(/\s+/).some(token => {
    if (!/[\p{L}\p{N}]\.[a-z]{2,}/iu.test(token) && !/\d{1,3}(\.\d{1,3}){3}/.test(token)) return false;
    const h = token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/^https?:\/\//i, "").split(/[/?#:]/)[0].replace(/[^\p{L}\p{N}]+$/u, "").toLowerCase();
    return !(h === own || extra.includes(h));
  });
}

// The Hebrew reason the text cannot be used for this message, or null. Run on saving and again before sending a stored text.
function templateProblem(key, text, host) {
  const { fields, required = [] } = SMS_TEMPLATES[key];
  if (!text) return "ההודעה לא יכולה להיות ריקה";
  if (text.length > TEMPLATE_MAX_LEN) return `ההודעה ארוכה מדי: ${text.length} תווים, והמקסימום הוא ${TEMPLATE_MAX_LEN}.`;
  const used = [...text.matchAll(/\{([^{}]*)\}/g)].map(m => m[1]);
  const unknown = used.find(name => !fields.includes(name));
  const list = fields.map(f => `{${f}}`).join(" ");
  if (unknown !== undefined) return `אי אפשר להשתמש ב-{${unknown}} בהודעה הזו. אפשר רק: ${list}`;
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ""))) return `סוגריים מסולסלים מותרים רק סביב שדה מהרשימה: ${list}`;
  const missing = required.find(name => !used.includes(name));
  if (missing) return `חובה להשאיר את {${missing}} בהודעה, אחרת הלקוח לא יקבל את הקוד.`;
  if (templateHasForeignLink(key, text, host)) return "קישורים מותרים רק לאתר של המספרה. אם יש נקודה צמודה לשדה או למילה באנגלית, נא להוסיף אחריה רווח.";
  const longest = used.reduce((n, name) => n - name.length - 2 + (name === "קישור" ? `https://${host}/#personal-area`.length : FIELD_MAX_LEN[name]), text.length);
  if (longest > MAX_LEN) return `עם השם והפרטים ההודעה עלולה להגיע ל-${longest} תווים, והמקסימום לשליחה הוא ${MAX_LEN}. נא לקצר.`;
  return null;
}

// Never throws and never returns a broken text: a stored wording that cannot be used, or a read that fails, sends the default.
async function currentTemplateText(ctx, key) {
  if (LOCKED_TEMPLATES.has(key)) return SMS_TEMPLATES[key].text;
  try {
    const stored = await cmd("HGET", K(ctx, TEMPLATES_KEY), key);
    if (typeof stored === "string" && !templateProblem(key, stored, ctx.host)) return stored;
  } catch (_) {
    console.error("[sms] could not read templates");
  }
  return SMS_TEMPLATES[key].text;
}

async function renderTemplate(ctx, key, values) {
  const text = await currentTemplateText(ctx, key);
  const out = fillTemplate(text, values);
  return text !== SMS_TEMPLATES[key].text && hasForeignLink(out, ctx.host) ? fillTemplate(SMS_TEMPLATES[key].text, values) : out;
}

const apptValues = (ctx, a) => ({ "שם": smsName(a.name), "יום": DAYS_HEB[a.dayIdx], "תאריך": a.dateStr, "שעה": a.time, "שירות": smsService(a.service), "קישור": siteUrl(ctx) });

const templates = {
  clientBooked: (ctx, a) => renderTemplate(ctx, "clientBooked", apptValues(ctx, a)),
  clientMoved: (ctx, a) => renderTemplate(ctx, "clientMoved", apptValues(ctx, a)),
  adminBooked: (ctx, a) => renderTemplate(ctx, "adminBooked", apptValues(ctx, a)),
  adminMoved: (ctx, a) => renderTemplate(ctx, "adminMoved", apptValues(ctx, a)),
  adminCanceled: (ctx, a) => renderTemplate(ctx, "adminCanceled", apptValues(ctx, a)),
  reminder: (ctx, a) => renderTemplate(ctx, "reminder", apptValues(ctx, a)),
  alreadyRegistered: ctx => renderTemplate(ctx, "alreadyRegistered", { "קישור": siteUrl(ctx) }),
  verifyCode: (ctx, code) => renderTemplate(ctx, "verifyCode", { "קוד": code }),
  resetCode: (ctx, code) => renderTemplate(ctx, "resetCode", { "קוד": code }),
  test: ctx => renderTemplate(ctx, "test", { "קישור": siteUrl(ctx) }),
  // Section 30A format, not editable: the law sets the opening and the way out. Replies reach the owner's phone, and the owner removes the customer in the admin; the link needs no login.
  broadcast(ctx, text, phone) {
    return `${BROADCAST_PREFIX}\n${text}\nלהסרה: ${optOutUrl(ctx, phone)} או השב/י הסר`;
  }
};

// What the admin editor needs: every message with its current wording, and sample values for the live preview.
async function templateCatalog(ctx) {
  const flat = await cmd("HGETALL", K(ctx, TEMPLATES_KEY));
  const stored = {};
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) stored[flat[i]] = flat[i + 1];
  return {
    maxLength: TEMPLATE_MAX_LEN,
    sample: { "שם": "דני כהן", "יום": "שלישי", "תאריך": "12/05", "שעה": "10:30", "שירות": "תספורת גבר", "קישור": siteUrl(ctx), "קוד": "123456" },
    templates: Object.keys(SMS_TEMPLATES).filter(isTemplateKey).map(key => {
      const t = SMS_TEMPLATES[key];
      const edited = Object.prototype.hasOwnProperty.call(stored, key);
      return { key, title: t.title, hint: t.hint, defaultText: t.text, text: edited ? stored[key] : t.text, edited, required: t.required || [], fields: t.fields.map(token => ({ token, label: FIELD_LABELS[token] })) };
    })
  };
}

module.exports = {
  smsStatus, smsConfigured, sendTracked, sendApptSms, retryLog, hasForeignLink, templates, smsName, MAX_LEN,
  TEMPLATES_KEY, TEMPLATE_MAX_LEN, SMS_TEMPLATES, templateCatalog, isTemplateKey, defaultTemplateText, cleanTemplateText, templateProblem, fillTemplate
};
