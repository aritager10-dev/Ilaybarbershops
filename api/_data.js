// Redis layout (every key below is prefixed with "test:" in test mode):
//   cfg:site, cfg:services, cfg:schedule, cfg:portfolio   JSON config (defaults apply until saved)
//   ver                         counter bumped on every data change; drives polling
//   pub                         cached public snapshot
//   appts (hash id->JSON)       appointments
//   phoneappts:<phone> (set)    appointment ids per phone
//   slot:<date>:<HH:MM>         double-booking lock, value "<apptId>|<ms>"
//   users (hash id->JSON)       accounts WITHOUT credentials
//   ucred:<uid>                 scrypt hash, read only by login and never serialized to a response
//   idx:phone, idx:name (hash)  uniqueness indexes -> uid
//   sess:<sha256>, usess:<uid>  client sessions
//   umsgs:<uid> (list)          the client's own messages to the barber
//   smslogs, notifs (hash)      admin history
//   photo:<id>                  portfolio image
//   rl:*, fail:*, cap:*, reset:*, remgate, maint, remlock:*   counters and locks
// Admin sessions (asess:*) are never namespaced: test mode itself requires one.
const crypto = require("crypto");
const { cmd, pipeline, hashValues, parseJson } = require("./_redis");
const DEFAULTS = require("./_defaults");
const { heTime, heDate, heDateTime } = require("./_time");

const K = (ctx, name) => ctx.ns + name;
const newId = prefix => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const bump = ctx => cmd("INCR", K(ctx, "ver"));

async function getConfig(ctx) {
  const [site, services, schedule, portfolio, ver] = await cmd("MGET", K(ctx, "cfg:site"), K(ctx, "cfg:services"), K(ctx, "cfg:schedule"), K(ctx, "cfg:portfolio"), K(ctx, "ver"));
  return {
    siteConfig: { ...DEFAULTS.siteConfig, ...(parseJson(site) || {}) },
    services: parseJson(services) || DEFAULTS.services,
    weeklySchedule: parseJson(schedule) || DEFAULTS.weeklySchedule,
    portfolio: parseJson(portfolio) || [],
    v: Number(ver) || 0
  };
}

async function getAppt(ctx, id) { return parseJson(await cmd("HGET", K(ctx, "appts"), id)); }
async function allAppts(ctx) { return hashValues(await cmd("HGETALL", K(ctx, "appts"))); }

function saveApptCmds(ctx, appt, prevPhone) {
  const cmds = [["HSET", K(ctx, "appts"), appt.id, JSON.stringify(appt)]];
  if (appt.phone) cmds.push(["SADD", K(ctx, `phoneappts:${appt.phone}`), appt.id]);
  if (prevPhone && prevPhone !== appt.phone) cmds.push(["SREM", K(ctx, `phoneappts:${prevPhone}`), appt.id]);
  return cmds;
}

async function getUser(ctx, uid) { return parseJson(await cmd("HGET", K(ctx, "users"), uid)); }

// Accounts never carry credentials, so a user object is always safe to send to the admin UI.
function publicUser(u) {
  return { id: u.id, username: u.username, phone: u.phone, marketingOptIn: u.marketingOptIn === true, consentAt: u.consentAt || null, createdAt: u.createdAt || "", lastActiveAt: u.lastActiveAt || null };
}

// The push payload never carries phone numbers or names: an ntfy topic is readable by anyone who knows it.
// Nothing is sent unless NTFY_TOPIC is set.
async function pushNtfy(ctx, title, message) {
  const topic = String(process.env.NTFY_TOPIC || "").trim();
  if (!topic) return;
  try {
    const strip = s => String(s || "").replace(/\+?\d[\d\s-]{7,}\d/g, "[טלפון]").slice(0, 300);
    await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title: (ctx.test ? "[בדיקה] " : "") + strip(title).slice(0, 100), message: strip(message), priority: 4, click: `https://${ctx.host}/admin.html` }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (_) { /* A push failure must never affect the booking. */ }
}

// title/message are the admin-facing text; pushTitle/pushMessage are the PII-free text for ntfy.
async function addNotification(ctx, n) {
  const now = Date.now();
  const notif = {
    id: newId("ntf"), type: n.type, title: n.title, message: n.message, apptId: n.apptId || null,
    dayIdx: n.dayIdx === undefined ? null : n.dayIdx, uid: n.uid || null, read: false, createdAt: now,
    timeStr: `${heTime(now)} ${heDate(now)}`
  };
  await pipeline([["HSET", K(ctx, "notifs"), notif.id, JSON.stringify(notif)], ["INCR", K(ctx, "ver")]]);
  await pushNtfy(ctx, n.pushTitle || n.title, n.pushMessage || "יש עדכון חדש ביומן");
  return notif;
}

async function addLog(ctx, entry) {
  const now = Date.now();
  const log = {
    id: entry.id || newId("sms"), phone: entry.phone || "", name: entry.name || "", message: entry.message || "",
    category: entry.category || "booking", channel: entry.channel || "sms", parts: entry.parts || 0,
    status: entry.status, reason: entry.reason || "", apptId: entry.apptId || null, uid: entry.uid || null,
    noRetry: entry.noRetry === true, createdAt: now, time: heDateTime(now)
  };
  await pipeline([["HSET", K(ctx, "smslogs"), log.id, JSON.stringify(log)], ["INCR", K(ctx, "ver")]]);
  return log;
}

const byNewest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
const withoutUid = o => { const { uid, ...rest } = o; return rest; };

// Full admin view. Credentials are stored under separate keys and so cannot appear here.
async function adminState(ctx) {
  const [appts, users, logs, notifs, cfg] = await pipeline([
    ["HGETALL", K(ctx, "appts")], ["HGETALL", K(ctx, "users")], ["HGETALL", K(ctx, "smslogs")], ["HGETALL", K(ctx, "notifs")],
    ["MGET", K(ctx, "cfg:site"), K(ctx, "cfg:services"), K(ctx, "cfg:schedule"), K(ctx, "cfg:portfolio"), K(ctx, "ver")]
  ]);
  return {
    v: Number(cfg[4]) || 0,
    siteConfig: { ...DEFAULTS.siteConfig, ...(parseJson(cfg[0]) || {}) },
    services: parseJson(cfg[1]) || DEFAULTS.services,
    weeklySchedule: parseJson(cfg[2]) || DEFAULTS.weeklySchedule,
    portfolio: parseJson(cfg[3]) || [],
    appointments: hashValues(appts),
    registeredUsers: hashValues(users).map(publicUser),
    smsLogs: hashValues(logs).sort(byNewest).slice(0, 300).map(withoutUid),
    adminNotifications: hashValues(notifs).sort(byNewest).slice(0, 120).map(withoutUid)
  };
}

module.exports = { K, newId, bump, getConfig, getAppt, allAppts, saveApptCmds, getUser, publicUser, addNotification, addLog, adminState, byNewest };
