// Redis layout (every key below is prefixed with "test:" in test mode):
//   cfg:site, cfg:services, cfg:schedule, cfg:portfolio   JSON config (defaults apply until saved)
//   ver                         counter bumped on every data change; drives polling
//   pub                         cached public snapshot
//   appts (hash id->JSON)       appointments
//   phoneappts:<phone> (set)    appointment ids per phone
//   slot:<date>:<HH:MM>         double-booking lock, value "<apptId>|<ms>"
//   users (hash id->JSON)       accounts WITHOUT credentials
//   ucred:<uid>                 scrypt hash, read only by login and never serialized to a response
//   idx:phone (hash)            phone uniqueness -> uid
//   regpending:<phone>          registration waiting for its SMS code (hashed password and code, 10 minutes)
//   smsstats (hash)             lifetime SMS counters; the history hash is trimmed, these are not
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
  return { id: u.id, username: u.username, phone: u.phone, phoneVerified: u.phoneVerified === true, marketingOptIn: u.marketingOptIn === true, consentAt: u.consentAt || null, createdAt: u.createdAt || "", lastActiveAt: u.lastActiveAt || null };
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

function flatToCounters(flat) {
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]) || 0;
  return out;
}

// Commands that remove a deleted person's traces from the admin history. Notifications are matched by
// account, appointment, phone or name, since those written for barber actions name the customer too.
async function scrubLogCmds(ctx, user) {
  const logs = hashValues(await cmd("HGETALL", K(ctx, "smslogs")));
  return logs.filter(l => l.phone === user.phone || l.uid === user.id).map(l => ["HDEL", K(ctx, "smslogs"), l.id]);
}
async function scrubNotifCmds(ctx, user, apptIds = []) {
  const ids = new Set(apptIds);
  const has = (n, needle) => needle && (String(n.title).includes(needle) || String(n.message).includes(needle));
  const notifs = hashValues(await cmd("HGETALL", K(ctx, "notifs")));
  return notifs.filter(n => n.uid === user.id || ids.has(n.apptId) || has(n, user.phone) || has(n, user.username)).map(n => ["HDEL", K(ctx, "notifs"), n.id]);
}

// Full admin view. Credentials are stored under separate keys and so cannot appear here.
async function adminState(ctx) {
  const [appts, users, logs, notifs, stats, cfg] = await pipeline([
    ["HGETALL", K(ctx, "appts")], ["HGETALL", K(ctx, "users")], ["HGETALL", K(ctx, "smslogs")], ["HGETALL", K(ctx, "notifs")], ["HGETALL", K(ctx, "smsstats")],
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
    adminNotifications: hashValues(notifs).sort(byNewest).slice(0, 120).map(withoutUid),
    smsStats: flatToCounters(stats)
  };
}

module.exports = { K, newId, bump, getConfig, getAppt, allAppts, saveApptCmds, getUser, publicUser, addNotification, addLog, adminState, byNewest, scrubLogCmds, scrubNotifCmds };
