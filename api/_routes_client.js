// Public, account and client endpoints.
const crypto = require("crypto");
const { cmd, pipeline, parseJson, hashValues } = require("./_redis");
const { HttpError, sendJson, clearCookie } = require("./_http");
const { enforceLimit, overLimit, ipKey, shortHash } = require("./_guard");
const V = require("./_validate");
const A = require("./_auth");
const D = require("./_data");
const { K } = D;
const { sendTracked, templates } = require("./_sms");
const S = require("./_appts");
const { maybeRunReminders } = require("./_reminders");
const { DAYS_HEB, heTime, heDate } = require("./_time");
const { servePhoto } = require("./_photos");

const ok = (ctx, data = {}) => sendJson(ctx.res, 200, { ok: true, ...data });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

// --- Public ---
// Only the fields listed here ever reach anonymous visitors. Busy slots carry no name, phone or appointment id.
async function buildPublicSnapshot(ctx, v) {
  const [config, appts] = await Promise.all([D.getConfig(ctx), D.allAppts(ctx)]);
  const now = Date.now();
  const horizon = now + 8 * 86400 * 1000;
  const c = config.siteConfig;
  return {
    v,
    at: now,
    siteConfig: { title: c.title, subtitle: c.subtitle, slotInterval: c.slotInterval, slotBuffer: c.slotBuffer },
    services: config.services,
    weeklySchedule: config.weeklySchedule,
    portfolio: config.portfolio,
    busy: appts
      .filter(a => a.status !== "canceled" && a.startsAtMs > now && a.startsAtMs < horizon)
      .map(a => ({ dayIdx: a.dayIdx, time: a.time, dateStr: a.dateStr }))
  };
}

async function getPublic(ctx) {
  const [rawPub, ver, gate] = await cmd("MGET", K(ctx, "pub"), K(ctx, "ver"), K(ctx, "remgate"));
  const v = Number(ver) || 0;
  let snap = parseJson(rawPub);
  if (!snap || snap.v !== v || Date.now() - snap.at > SNAPSHOT_MAX_AGE_MS) {
    snap = await buildPublicSnapshot(ctx, v);
    await cmd("SET", K(ctx, "pub"), JSON.stringify(snap), "EX", 3600);
  }
  await maybeRunReminders(ctx, gate);
  const { at, ...payload } = snap;
  sendJson(ctx.res, 200, { ok: true, test: ctx.test, ...payload }, ctx.test ? "no-store" : PUBLIC_CACHE);
}

const getPhoto = (ctx) => servePhoto(ctx, ctx.params[0]);
const testCheck = ctx => ok(ctx, { test: ctx.test });

// --- Account ---
function selfView(u) { return { username: u.username, phone: u.phone, marketingOptIn: u.marketingOptIn === true }; }

async function register(ctx) {
  await enforceLimit(ctx.ns, "register", ipKey(ctx.req), 10, 3600);
  const b = ctx.body;
  const username = V.clientName(b.fullName);
  const phone = V.mobilePhone(b.phone);
  if (!phone) throw V.bad("נא להזין מספר טלפון נייד תקין");
  const password = V.password(b.password);
  if (b.consent !== true) throw V.bad("כדי להירשם צריך לאשר את תנאי השימוש ומדיניות הפרטיות");

  const credHash = await A.hashPassword(password);
  const uid = D.newId("usr");
  const nameKey = username.toLowerCase();
  if (Number(await cmd("HSETNX", K(ctx, "idx:phone"), phone, uid)) !== 1) {
    throw new HttpError(409, "מספר טלפון זה כבר רשום! לא ניתן לפתוח חשבון כפול – נא להתחבר.", { code: "phone_taken" });
  }
  if (Number(await cmd("HSETNX", K(ctx, "idx:name"), nameKey, uid)) !== 1) {
    await cmd("HDEL", K(ctx, "idx:phone"), phone);
    throw new HttpError(409, "השם המלא הזה כבר רשום במערכת! לא ניתן לפתוח חשבון כפול.", { code: "name_taken" });
  }
  const now = Date.now();
  const user = { id: uid, username, phone, marketingOptIn: b.marketingOptIn === true, consentAt: now, createdAt: heDate(now), lastActiveAt: now };
  await pipeline([["HSET", K(ctx, "users"), uid, JSON.stringify(user)], ["SET", K(ctx, `ucred:${uid}`), credHash]]);
  await A.startClientSession(ctx, uid);
  await D.addNotification(ctx, { type: "new_user", title: "לקוח חדש נרשם למועדון", message: `${username} (${phone}) פתח חשבון חדש באתר.`, uid, pushMessage: "לקוח חדש פתח חשבון באתר" });
  ok(ctx, { user: selfView(user) });
}

async function resolveIdent(ctx, ident) {
  const phone = V.mobilePhone(ident);
  if (phone) {
    const uid = await cmd("HGET", K(ctx, "idx:phone"), phone);
    if (uid) return uid;
  }
  return cmd("HGET", K(ctx, "idx:name"), V.text(ident, 40).toLowerCase());
}

async function login(ctx) {
  const ident = typeof ctx.body.ident === "string" ? ctx.body.ident.trim().slice(0, 60) : "";
  const pw = typeof ctx.body.password === "string" ? ctx.body.password.slice(0, 200) : "";
  const generic = new HttpError(401, "פרטי ההתחברות שגויים או שהמשתמש אינו רשום", { code: "bad_credentials" });
  const uid = ident ? await resolveIdent(ctx, ident) : null;
  // The counter follows the account, so switching between phone and name does not buy extra attempts.
  const throttleId = uid || "ident:" + ident.toLowerCase();
  await A.assertNotLocked(ctx, "login", throttleId);
  const stored = uid ? await cmd("GET", K(ctx, `ucred:${uid}`)) : null;
  let valid = false;
  if (stored) valid = await A.verifyPassword(pw, stored);
  else await A.burnVerify(pw);
  if (!valid) {
    await A.recordFailure(ctx, "login", throttleId);
    throw generic;
  }
  const user = await D.getUser(ctx, uid);
  if (!user) throw generic;
  user.lastActiveAt = Date.now();
  await pipeline([["HSET", K(ctx, "users"), uid, JSON.stringify(user)]]);
  await A.clearFailures(ctx, "login", throttleId);
  await A.startClientSession(ctx, uid);
  ok(ctx, { user: selfView(user) });
}

async function logout(ctx) {
  await A.endClientSession(ctx);
  ok(ctx);
}

// --- Password reset by SMS: the reply and its timing are the same whether or not the account exists. ---
const RESET_TTL = 600;
const RESET_MAX_ATTEMPTS = 5;
const RESET_FLOOR_MS = 1500;
const codeHash = (phone, salt, code) => crypto.createHash("sha256").update(`${salt}|${phone}|${code}`).digest("hex");

async function resetRequest(ctx) {
  const started = Date.now();
  const phone = V.mobilePhone(ctx.body.phone);
  if (phone) {
    const overPhone = await overLimit(ctx.ns, "resetp", shortHash(phone), 3, 3600);
    const overIp = await overLimit(ctx.ns, "reseti", ipKey(ctx.req), 10, 3600);
    if (!overPhone && !overIp) {
      const uid = await cmd("HGET", K(ctx, "idx:phone"), phone);
      if (uid) {
        const user = await D.getUser(ctx, uid);
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        const salt = crypto.randomBytes(16).toString("hex");
        await pipeline([
          ["SET", K(ctx, `reset:${phone}`), JSON.stringify({ salt, hash: codeHash(phone, salt, code) }), "EX", RESET_TTL],
          ["DEL", K(ctx, `resetatt:${phone}`)]
        ]);
        await sendTracked(ctx, { phone, name: user ? user.username : "", message: templates.resetCode(code), logMessage: "קוד לאיפוס סיסמה (התוכן לא נשמר)", category: "reset", uid, ipCap: true });
      }
    }
  }
  const wait = RESET_FLOOR_MS - (Date.now() - started);
  if (wait > 0) await sleep(wait);
  ok(ctx, { message: "אם המספר רשום אצלנו, נשלח אליו קוד לאיפוס הסיסמה." });
}

async function resetConfirm(ctx) {
  await enforceLimit(ctx.ns, "resetc", ipKey(ctx.req), 20, 3600);
  const fail = new HttpError(400, "הקוד שגוי או שפג תוקפו. אפשר לבקש קוד חדש.", { code: "bad_code" });
  const newPassword = V.password(ctx.body.newPassword);
  const phone = V.mobilePhone(ctx.body.phone);
  const code = String(ctx.body.code || "").trim();
  if (!phone || !/^\d{6}$/.test(code)) throw fail;
  const record = parseJson(await cmd("GET", K(ctx, `reset:${phone}`)));
  if (!record) throw fail;
  const attKey = K(ctx, `resetatt:${phone}`);
  const [, attempts] = await pipeline([["SET", attKey, "0", "NX", "EX", RESET_TTL], ["INCR", attKey]]);
  if (Number(attempts) > RESET_MAX_ATTEMPTS) {
    await cmd("DEL", K(ctx, `reset:${phone}`));
    throw fail;
  }
  const given = Buffer.from(codeHash(phone, record.salt, code));
  if (!crypto.timingSafeEqual(given, Buffer.from(record.hash))) throw fail;
  const uid = await cmd("HGET", K(ctx, "idx:phone"), phone);
  if (!uid) throw fail;
  const credHash = await A.hashPassword(newPassword);
  await pipeline([
    ["SET", K(ctx, `ucred:${uid}`), credHash],
    ["DEL", K(ctx, `reset:${phone}`)],
    ["DEL", attKey]
  ]);
  await A.revokeAllClientSessions(ctx, uid);
  await A.clearFailures(ctx, "login", uid);
  ok(ctx, { message: "הסיסמה עודכנה. אפשר להתחבר עם הסיסמה החדשה." });
}

// --- Authenticated client ---
async function requireClient(ctx) {
  const sess = await A.loadClientSession(ctx);
  const user = sess ? await D.getUser(ctx, sess.uid) : null;
  if (!user) throw new HttpError(401, "נדרשת התחברות");
  ctx.client = user;
  return user;
}

function ownView(a) {
  return {
    id: a.id, dayIdx: a.dayIdx, dateStr: a.dateStr, time: a.time, startsAtMs: a.startsAtMs, createdAt: a.createdAt,
    name: a.name, phone: a.phone, srvIdx: a.srvIdx, price: a.price, service: a.service, note: a.note,
    status: a.status, movedCount: a.movedCount, reminderSent: a.reminderSent === true, confirmedAt: a.confirmedAt || null
  };
}

async function ownAppts(ctx, phone) {
  const ids = await cmd("SMEMBERS", K(ctx, `phoneappts:${phone}`));
  if (!ids || !ids.length) return [];
  const raw = await cmd("HMGET", K(ctx, "appts"), ...ids);
  return (raw || []).map(r => parseJson(r)).filter(a => a && a.phone === phone);
}

async function getMe(ctx) {
  // ?soft=1 is the page-load probe: being logged out is a normal answer there, not an error.
  const soft = new URL(ctx.req.url, "http://internal").searchParams.get("soft") === "1";
  const sess = soft ? await A.loadClientSession(ctx) : null;
  if (soft && !sess) return ok(ctx, { user: null, appointments: [], messages: [] });
  const user = await requireClient(ctx);
  const [appts, msgs] = await Promise.all([ownAppts(ctx, user.phone), cmd("LRANGE", K(ctx, `umsgs:${user.id}`), 0, 49)]);
  ok(ctx, { user: selfView(user), appointments: appts.map(ownView), messages: (msgs || []).map(m => parseJson(m)).filter(Boolean) });
}

async function ownAppt(ctx) {
  const user = await requireClient(ctx);
  const id = ctx.params[0];
  const appt = V.isId(id) ? await D.getAppt(ctx, id) : null;
  // Same reply for "does not exist" and "belongs to someone else".
  if (!appt || appt.phone !== user.phone) throw new HttpError(404, "התור לא נמצא");
  return { user, appt };
}

function assertUpcoming(appt) {
  if (appt.status === "canceled") throw new HttpError(409, "התור כבר בוטל");
  if (appt.startsAtMs < Date.now() - 2 * 3600 * 1000) throw new HttpError(409, "התור הזה כבר עבר");
}

function parseSlotRequest(body) {
  const dayIdx = V.intIn(body.dayIdx, 0, 6);
  if (dayIdx === null || !V.isTime(body.time)) throw V.bad("נא לבחור יום ושעה");
  return { dayIdx, time: body.time };
}

function serviceFrom(config, srvIdxRaw) {
  const srvIdx = V.intIn(srvIdxRaw, 0, config.services.length - 1);
  if (srvIdx === null) throw V.bad("נא לבחור שירות מהמחירון");
  const srv = config.services[srvIdx];
  // Price always comes from the stored price list, never from the request.
  return { srvIdx, price: srv.price, service: `${srv.name} • ${srv.price} ₪`, name: srv.name };
}

const slotTakenError = () => new HttpError(409, "השעה הזו נתפסה כרגע, נא לבחור שעה אחרת", { code: "slot_taken" });

async function createAppointment(ctx) {
  const user = await requireClient(ctx);
  await enforceLimit(ctx.ns, "book", shortHash(user.id), 20, 86400, "הגעת למספר התורים האפשרי ליום אחד. אפשר לפנות לעילי בטלפון.");
  const { dayIdx, time } = parseSlotRequest(ctx.body);
  const config = await D.getConfig(ctx);
  const srv = serviceFrom(config, ctx.body.srvIdx);
  const date = S.assertClientSlot(config, dayIdx, time);
  const appt = {
    id: D.newId("ap"), createdAt: Date.now(), name: user.username, phone: user.phone, srvIdx: srv.srvIdx,
    price: srv.price, service: srv.service, note: V.text(ctx.body.note, 120), status: "pending", movedCount: 0, reminderSent: false, source: "client"
  };
  S.placeAt(appt, dayIdx, date, time);
  if (!(await S.acquireSlot(ctx, date, time, appt.id))) throw slotTakenError();
  await pipeline([...D.saveApptCmds(ctx, appt), ["INCR", K(ctx, "ver")]]);
  await D.addNotification(ctx, {
    type: "new_booking", title: "תור חדש נקבע באתר!", message: `${appt.name} (${appt.phone}) קבע תור ל${srv.name} ${S.describeSlot(appt)}.`,
    apptId: appt.id, dayIdx, uid: user.id, pushMessage: `תור חדש: ${S.describeSlot(appt)}`
  });
  const sms = await sendTracked(ctx, { phone: appt.phone, name: appt.name, message: templates.clientBooked(ctx, appt), category: "booking", apptId: appt.id, uid: user.id, ipCap: true });
  ok(ctx, { appointment: ownView(appt), smsSent: sms.ok });
}

async function moveAppointment(ctx) {
  const { user, appt } = await ownAppt(ctx);
  await enforceLimit(ctx.ns, "move", shortHash(user.id), 20, 86400);
  assertUpcoming(appt);
  const { dayIdx, time } = parseSlotRequest(ctx.body);
  const config = await D.getConfig(ctx);
  const srv = serviceFrom(config, ctx.body.srvIdx);
  const date = S.assertClientSlot(config, dayIdx, time);
  const prev = { date: appt.date, time: appt.time };
  const sameSlot = prev.date === date && prev.time === time;
  if (!sameSlot && !(await S.acquireSlot(ctx, date, time, appt.id))) throw slotTakenError();
  S.placeAt(appt, dayIdx, date, time);
  Object.assign(appt, { srvIdx: srv.srvIdx, price: srv.price, service: srv.service, status: "pending", movedCount: (Number(appt.movedCount) || 0) + 1, reminderSent: false });
  delete appt.confirmedAt;
  await pipeline([...D.saveApptCmds(ctx, appt), ["INCR", K(ctx, "ver")]]);
  if (!sameSlot) await S.releaseSlot(ctx, prev.date, prev.time, appt.id);
  await D.addNotification(ctx, {
    type: "moved", title: "לקוח שינה מועד תור", message: `${appt.name} הזיז את התור ל${S.describeSlot(appt)}.`,
    apptId: appt.id, dayIdx, uid: user.id, pushMessage: `תור הוזז: ${S.describeSlot(appt)}`
  });
  const sms = await sendTracked(ctx, { phone: appt.phone, name: appt.name, message: templates.clientMoved(ctx, appt), category: "move", apptId: appt.id, uid: user.id, ipCap: true });
  ok(ctx, { appointment: ownView(appt), smsSent: sms.ok });
}

async function logIncoming(ctx, user, text, apptId) {
  await D.addLog(ctx, { phone: user.phone, name: user.username, message: text, category: "incoming", parts: 0, status: "received", reason: "התקבל מהלקוח", apptId, uid: user.id, noRetry: true });
}

async function confirmAppointment(ctx) {
  const { user, appt } = await ownAppt(ctx);
  await enforceLimit(ctx.ns, "appt", shortHash(user.id), 60, 3600);
  assertUpcoming(appt);
  appt.status = "confirmed";
  appt.confirmedAt = heTime();
  await pipeline([...D.saveApptCmds(ctx, appt), ["INCR", K(ctx, "ver")]]);
  await logIncoming(ctx, user, `אישור הגעה לתור ביום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}`, appt.id);
  await D.addNotification(ctx, {
    type: "confirmed", title: "אישור הגעה התקבל!", message: `${appt.name} אישר הגעה לתור ביום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}.`,
    apptId: appt.id, dayIdx: appt.dayIdx, uid: user.id, pushMessage: `אישור הגעה: יום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}`
  });
  ok(ctx, { appointment: ownView(appt) });
}

async function cancelAppointment(ctx) {
  const { user, appt } = await ownAppt(ctx);
  await enforceLimit(ctx.ns, "appt", shortHash(user.id), 60, 3600);
  assertUpcoming(appt);
  appt.status = "canceled";
  appt.canceledAt = Date.now();
  await pipeline([...D.saveApptCmds(ctx, appt), ["INCR", K(ctx, "ver")]]);
  await S.releaseSlot(ctx, appt.date, appt.time, appt.id);
  await logIncoming(ctx, user, `ביטול תור ליום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}`, appt.id);
  await D.addNotification(ctx, {
    type: "canceled", title: "לקוח ביטל תור באתר", message: `${appt.name} (${appt.phone}) ביטל את התור ליום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}.`,
    apptId: appt.id, dayIdx: appt.dayIdx, uid: user.id, pushMessage: `תור בוטל: יום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}`
  });
  ok(ctx, { appointment: ownView(appt) });
}

async function sendMessage(ctx) {
  const user = await requireClient(ctx);
  await enforceLimit(ctx.ns, "msg", shortHash(user.id), 20, 3600, "נשלחו יותר מדי הודעות, נסו שוב מאוחר יותר");
  const text = V.text(ctx.body.text, 160);
  if (!text) throw V.bad("נא להקליד הודעה");
  await logIncoming(ctx, user, text, null);
  const listKey = K(ctx, `umsgs:${user.id}`);
  await pipeline([["LPUSH", listKey, JSON.stringify({ text, createdAt: Date.now() })], ["LTRIM", listKey, 0, 49]]);
  await D.addNotification(ctx, { type: "client_msg", title: `הודעה חדשה מ-${user.username}`, message: `${user.username} (${user.phone}): "${text}"`, uid: user.id, pushTitle: "הודעה חדשה מלקוח", pushMessage: "נכנסה הודעה חדשה בממשק הניהול" });
  ok(ctx);
}

async function setMarketing(ctx) {
  const user = await requireClient(ctx);
  await enforceLimit(ctx.ns, "acct", shortHash(user.id), 30, 3600);
  if (typeof ctx.body.optIn !== "boolean") throw V.bad("בקשה לא תקינה");
  user.marketingOptIn = ctx.body.optIn;
  await pipeline([["HSET", K(ctx, "users"), user.id, JSON.stringify(user)], ["INCR", K(ctx, "ver")]]);
  ok(ctx, { user: selfView(user) });
}

// Removes the account and everything tied to it. Past appointments stay only as anonymous
// rows for the revenue statistics; future ones are canceled and their slots freed.
async function deleteAccount(ctx) {
  const user = await requireClient(ctx);
  await enforceLimit(ctx.ns, "acct", shortHash(user.id), 30, 3600);
  const appts = await ownAppts(ctx, user.phone);
  const now = Date.now();
  const cmds = [];
  let canceled = 0;
  for (const a of appts) {
    const future = a.status !== "canceled" && a.startsAtMs > now;
    if (future) { await S.releaseSlot(ctx, a.date, a.time, a.id); canceled++; }
    if (future || a.status === "canceled") cmds.push(["HDEL", K(ctx, "appts"), a.id]);
    else {
      a.name = "לקוח שנמחק"; a.phone = ""; a.note = "";
      cmds.push(["HSET", K(ctx, "appts"), a.id, JSON.stringify(a)]);
    }
  }
  const [logs, notifs] = await pipeline([["HGETALL", K(ctx, "smslogs")], ["HGETALL", K(ctx, "notifs")]]);
  hashValues(logs).filter(l => l.phone === user.phone || l.uid === user.id).forEach(l => cmds.push(["HDEL", K(ctx, "smslogs"), l.id]));
  hashValues(notifs).filter(n => n.uid === user.id || (typeof n.message === "string" && n.message.includes(user.phone))).forEach(n => cmds.push(["HDEL", K(ctx, "notifs"), n.id]));
  cmds.push(
    ["DEL", K(ctx, `phoneappts:${user.phone}`)], ["DEL", K(ctx, `umsgs:${user.id}`)], ["DEL", K(ctx, `ucred:${user.id}`)],
    ["DEL", K(ctx, `reset:${user.phone}`)], ["HDEL", K(ctx, "users"), user.id],
    ["HDEL", K(ctx, "idx:phone"), user.phone], ["HDEL", K(ctx, "idx:name"), user.username.toLowerCase()],
    ["INCR", K(ctx, "ver")]
  );
  await pipeline(cmds);
  await A.revokeAllClientSessions(ctx, user.id);
  clearCookie(ctx.req, ctx.res, ctx.test ? "ilay_sid_test" : "ilay_sid");
  await D.addNotification(ctx, { type: "account_deleted", title: "לקוח מחק את החשבון שלו", message: canceled ? `חשבון נמחק ו-${canceled} תורים עתידיים בוטלו.` : "חשבון לקוח נמחק.", pushMessage: "לקוח מחק את החשבון שלו" });
  ok(ctx);
}

module.exports = {
  getPublic, getPhoto, testCheck, register, login, logout, resetRequest, resetConfirm, getMe, createAppointment, moveAppointment,
  confirmAppointment, cancelAppointment, sendMessage, setMarketing, deleteAccount
};
