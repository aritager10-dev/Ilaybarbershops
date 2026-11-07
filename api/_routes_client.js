// Public, account and client endpoints.
const crypto = require("crypto");
const { cmd, pipeline, parseJson } = require("./_redis");
const { HttpError, sendJson, clearCookie } = require("./_http");
const { enforceLimit, overLimit, bumpCounter, ipKey, shortHash } = require("./_guard");
const V = require("./_validate");
const A = require("./_auth");
const D = require("./_data");
const { K } = D;
const { sendTracked, sendApptSms, smsConfigured, templates } = require("./_sms");
const S = require("./_appts");
const { maybeRunReminders } = require("./_reminders");
const { DAYS_HEB, heTime, heDate, todayYmd, isYmd } = require("./_time");
const { HORIZON_DAYS, publicOpenDays } = require("./_availability");
const { servePhoto } = require("./_photos");
const { findOptOutUser } = require("./_optout");

const ok = (ctx, data = {}) => sendJson(ctx.res, 200, { ok: true, ...data });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

// Calendar-flooding limits.
const MAX_ACTIVE_APPTS = 2;      // Upcoming appointments per account and per phone.
const MAX_BOOKINGS_IP_DAY = 15;  // New bookings per IP per day.
const MAX_BOOKINGS_DAY = 200;    // New client bookings per day, whole site. A barber working alone stays far below this.
const MAX_ACCOUNTS_IP_DAY = 20;  // Account creation requests per IP per day.

// --- Public ---
// Only the fields listed here ever reach anonymous visitors. Busy slots carry no name, phone or appointment id.
async function buildPublicSnapshot(ctx, v) {
  const [config, appts] = await Promise.all([D.getConfig(ctx), D.allAppts(ctx)]);
  const now = Date.now();
  const horizon = now + (HORIZON_DAYS + 2) * 86400 * 1000;
  const c = config.siteConfig;
  return {
    v,
    at: now,
    siteConfig: { title: c.title, subtitle: c.subtitle, slotInterval: c.slotInterval, slotBuffer: c.slotBuffer },
    services: config.services,
    openDays: publicOpenDays(config.availability, now),
    horizonDays: HORIZON_DAYS,
    portfolio: config.portfolio,
    busy: appts
      .filter(a => a.status !== "canceled" && a.date && a.startsAtMs > now && a.startsAtMs < horizon)
      .map(a => ({ date: a.date, time: a.time }))
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

const getPhoto = ctx => servePhoto(ctx, ctx.params[0]);
const testCheck = ctx => ok(ctx, { test: ctx.test });

// --- Account ---
function selfView(u) { return { username: u.username, phone: u.phone, marketingOptIn: u.marketingOptIn === true }; }

const phoneTaken = () => new HttpError(409, "המספר הזה כבר רשום. אפשר להתחבר או לאפס סיסמה.", { code: "phone_taken" });

async function createAccount(ctx, { username, phone, credHash, marketingOptIn, marketingConsentAt, phoneVerified }) {
  const uid = D.newId("usr");
  if (Number(await cmd("HSETNX", K(ctx, "idx:phone"), phone, uid)) !== 1) throw phoneTaken();
  const now = Date.now();
  const user = { id: uid, username, phone, phoneVerified, marketingOptIn: marketingOptIn === true, ...(marketingOptIn === true ? { marketingConsentAt: marketingConsentAt || now } : {}), consentAt: now, createdAt: heDate(now), lastActiveAt: now };
  await pipeline([["HSET", K(ctx, "users"), uid, JSON.stringify(user)], ["SET", K(ctx, `ucred:${uid}`), credHash]]);
  await A.startClientSession(ctx, uid);
  await D.addNotification(ctx, { type: "new_user", title: "לקוח חדש נרשם למועדון", message: `${username} (${phone}) פתח חשבון חדש באתר.`, uid });
  return user;
}

const CODE_TTL = 600;
const CODE_MAX_ATTEMPTS = 5;
const codeHash = (phone, salt, code) => crypto.createHash("sha256").update(`${salt}|${phone}|${code}`).digest("hex");
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const codeMatches = (phone, record, code) => crypto.timingSafeEqual(Buffer.from(codeHash(phone, record.salt, code)), Buffer.from(record.hash));

// With SMS connected, the account is created only after the phone proves itself with a code.
// Without SMS (until the owner connects a provider) it is created unverified: such an account
// sees only what it booked itself, and marketing never reaches it.
async function register(ctx) {
  await enforceLimit(ctx.ns, "acctip", ipKey(ctx.req), MAX_ACCOUNTS_IP_DAY, 86400, "נפתחו יותר מדי חשבונות מהחיבור הזה היום. נסו שוב מחר.");
  const b = ctx.body;
  const username = V.clientName(b.fullName);
  const phone = V.mobilePhone(b.phone);
  if (!phone) throw V.bad("נא להזין מספר טלפון נייד תקין");
  const password = V.password(b.password);
  if (b.consent !== true) throw V.bad("כדי להירשם צריך לאשר את תנאי השימוש ומדיניות הפרטיות");
  const credHash = await A.hashPassword(password);
  const marketingOptIn = b.marketingOptIn === true;
  const alreadyRegistered = Number(await cmd("HEXISTS", K(ctx, "idx:phone"), phone)) === 1;
  if (alreadyRegistered && !smsConfigured()) throw phoneTaken();
  if (alreadyRegistered) {
    // Same answer as a new number, so the form can't be used to find out who is a customer.
    // The owner of the phone gets a text telling them to log in instead.
    await enforceLimit(ctx.ns, "regcode", shortHash(phone), 3, 3600, "נשלחו יותר מדי קודים למספר הזה. נסו שוב מאוחר יותר.");
    const notice = await sendTracked(ctx, { phone, name: username, message: await templates.alreadyRegistered(ctx), logMessage: "הודעה על חשבון קיים", category: "verify" });
    if (!notice.ok) throw new HttpError(502, "לא הצלחנו לשלוח קוד אימות. נסו שוב בעוד כמה דקות.");
    return ok(ctx, { verify: true });
  }
  if (!smsConfigured()) {
    const user = await createAccount(ctx, { username, phone, credHash, marketingOptIn, phoneVerified: false });
    return ok(ctx, { user: selfView(user) });
  }

  await enforceLimit(ctx.ns, "regcode", shortHash(phone), 3, 3600, "נשלחו יותר מדי קודים למספר הזה. נסו שוב בעוד שעה.");
  const code = newCode();
  const salt = crypto.randomBytes(16).toString("hex");
  const pendingKey = K(ctx, `regpending:${phone}`);
  await pipeline([
    ["SET", pendingKey, JSON.stringify({ username, credHash, marketingOptIn, marketingConsentAt: marketingOptIn ? Date.now() : null, salt, hash: codeHash(phone, salt, code) }), "EX", CODE_TTL],
    ["DEL", K(ctx, `regatt:${phone}`)]
  ]);
  const sms = await sendTracked(ctx, { phone, name: username, message: await templates.verifyCode(ctx, code), logMessage: "קוד לאימות טלפון (התוכן לא נשמר)", category: "verify", codeBudget: true, ipCap: true });
  if (!sms.ok) {
    await cmd("DEL", pendingKey);
    throw new HttpError(502, "לא הצלחנו לשלוח קוד אימות. נסו שוב בעוד כמה דקות.");
  }
  ok(ctx, { verify: true });
}

async function registerVerify(ctx) {
  await enforceLimit(ctx.ns, "regverify", ipKey(ctx.req), 30, 3600);
  const fail = new HttpError(400, "הקוד שגוי או שפג תוקפו. אפשר לבקש קוד חדש.", { code: "bad_code" });
  const phone = V.mobilePhone(ctx.body.phone);
  const code = String(ctx.body.code || "").trim();
  if (!phone || !/^\d{6}$/.test(code)) throw fail;
  const pendingKey = K(ctx, `regpending:${phone}`);
  const pending = parseJson(await cmd("GET", pendingKey));
  if (!pending) throw fail;
  const attempts = await bumpCounter(K(ctx, `regatt:${phone}`), CODE_TTL);
  if (attempts > CODE_MAX_ATTEMPTS) {
    await cmd("DEL", pendingKey);
    throw fail;
  }
  if (!codeMatches(phone, pending, code)) throw fail;
  const user = await createAccount(ctx, { username: pending.username, phone, credHash: pending.credHash, marketingOptIn: pending.marketingOptIn, marketingConsentAt: pending.marketingConsentAt, phoneVerified: true });
  await pipeline([["DEL", pendingKey], ["DEL", K(ctx, `regatt:${phone}`)]]);
  ok(ctx, { user: selfView(user) });
}

async function login(ctx) {
  const ident = typeof ctx.body.ident === "string" ? ctx.body.ident.trim().slice(0, 60) : "";
  const pw = typeof ctx.body.password === "string" ? ctx.body.password.slice(0, 200) : "";
  const generic = new HttpError(401, "פרטי ההתחברות שגויים או שהמשתמש אינו רשום", { code: "bad_credentials" });
  const phone = V.mobilePhone(ident);
  const uid = phone ? await cmd("HGET", K(ctx, "idx:phone"), phone) : null;
  const throttleId = uid || "ident:" + ident.toLowerCase();
  // Reserved before the password check, so parallel guesses cannot pass the limit.
  await A.reserveAttempt(ctx, "login", throttleId);
  const stored = uid ? await cmd("GET", K(ctx, `ucred:${uid}`)) : null;
  let valid = false;
  if (stored) valid = await A.verifyPassword(pw, stored);
  else await A.burnVerify(pw);
  if (!valid) throw generic;
  const user = await D.getUser(ctx, uid);
  if (!user) throw generic;
  user.lastActiveAt = Date.now();
  await pipeline([["HSET", K(ctx, "users"), uid, JSON.stringify(user)]]);
  await A.attemptSucceeded(ctx, "login", throttleId);
  await A.startClientSession(ctx, uid);
  ok(ctx, { user: selfView(user) });
}

async function logout(ctx) {
  await A.endClientSession(ctx);
  ok(ctx);
}

// --- Password reset by SMS: the reply and its timing are the same whether or not the account exists. ---
const RESET_FLOOR_MS = 1500;

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
        const code = newCode();
        const salt = crypto.randomBytes(16).toString("hex");
        await pipeline([
          ["SET", K(ctx, `reset:${phone}`), JSON.stringify({ salt, hash: codeHash(phone, salt, code) }), "EX", CODE_TTL],
          ["DEL", K(ctx, `resetatt:${phone}`)]
        ]);
        await sendTracked(ctx, { phone, name: user ? user.username : "", message: await templates.resetCode(ctx, code), logMessage: "קוד לאיפוס סיסמה (התוכן לא נשמר)", category: "reset", uid, codeBudget: true, ipCap: true });
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
  if (await bumpCounter(attKey, CODE_TTL) > CODE_MAX_ATTEMPTS) {
    await cmd("DEL", K(ctx, `reset:${phone}`));
    throw fail;
  }
  if (!codeMatches(phone, record, code)) throw fail;
  const uid = await cmd("HGET", K(ctx, "idx:phone"), phone);
  const user = uid ? await D.getUser(ctx, uid) : null;
  if (!user) throw fail;
  const credHash = await A.hashPassword(newPassword);
  // The code proves the phone. A marketing opt-in made before that proof may have been someone else's, so it does not carry over.
  if (user.phoneVerified !== true) { user.marketingOptIn = false; delete user.marketingConsentAt; }
  user.phoneVerified = true;
  await pipeline([
    ["SET", K(ctx, `ucred:${uid}`), credHash],
    ["HSET", K(ctx, "users"), uid, JSON.stringify(user)],
    ["DEL", K(ctx, `reset:${phone}`)],
    ["DEL", attKey],
    ["INCR", K(ctx, "ver")]
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

// adminNote is deliberately absent: the barber's notes never reach clients.
function ownView(a) {
  return {
    id: a.id, dayIdx: a.dayIdx, date: a.date, dateStr: a.dateStr, time: a.time, startsAtMs: a.startsAtMs, createdAt: a.createdAt,
    name: a.name, phone: a.phone, srvIdx: a.srvIdx, price: a.price, service: a.service, note: a.note,
    status: a.status, movedCount: a.movedCount, reminderSent: a.reminderSent === true, confirmedAt: a.confirmedAt || null
  };
}

// An unverified account owns only what it booked itself. Matching by phone needs a proven phone.
function canAccess(user, a) {
  return a.uid === user.id || (user.phoneVerified === true && a.phone === user.phone);
}

async function apptsOnPhone(ctx, phone) {
  const ids = await cmd("SMEMBERS", K(ctx, `phoneappts:${phone}`));
  if (!ids || !ids.length) return [];
  const raw = await cmd("HMGET", K(ctx, "appts"), ...ids);
  return (raw || []).map(r => parseJson(r)).filter(a => a && a.phone === phone);
}

async function ownAppts(ctx, user) {
  return (await apptsOnPhone(ctx, user.phone)).filter(a => canAccess(user, a));
}

async function getMe(ctx) {
  // ?soft=1 is the page-load probe: being logged out is a normal answer there, not an error.
  const soft = new URL(ctx.req.url, "http://internal").searchParams.get("soft") === "1";
  const sess = soft ? await A.loadClientSession(ctx) : null;
  if (soft && !sess) return ok(ctx, { user: null, appointments: [], messages: [] });
  const user = await requireClient(ctx);
  const [appts, msgs] = await Promise.all([ownAppts(ctx, user), cmd("LRANGE", K(ctx, `umsgs:${user.id}`), 0, 49)]);
  ok(ctx, { user: selfView(user), appointments: appts.map(ownView), messages: (msgs || []).map(m => parseJson(m)).filter(Boolean) });
}

// Same reply for "does not exist" and "belongs to someone else".
const notFound = () => new HttpError(404, "התור לא נמצא");

function assertUpcoming(appt) {
  if (appt.status === "canceled") throw new HttpError(409, "התור כבר בוטל");
  if (appt.startsAtMs < Date.now() - 2 * 3600 * 1000) throw new HttpError(409, "התור הזה כבר עבר");
}

function apptIdParam(ctx) {
  const id = ctx.params[0];
  if (!V.isId(id)) throw notFound();
  return id;
}

function parseSlotRequest(body) {
  if (!isYmd(body.date) || !V.isTime(body.time)) throw V.bad("נא לבחור יום ושעה");
  return { date: body.date, time: body.time };
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
  await enforceLimit(ctx.ns, "book", shortHash(user.id), 10, 86400, "הגעת למספר התורים האפשרי ליום אחד. אפשר לפנות לעילי בטלפון.");
  const { date, time } = parseSlotRequest(ctx.body);
  const config = await D.getConfig(ctx);
  const srv = serviceFrom(config, ctx.body.srvIdx);
  S.assertClientSlot(config, date, time);
  const appt = {
    id: D.newId("ap"), uid: user.id, createdAt: Date.now(), name: user.username, phone: user.phone, srvIdx: srv.srvIdx,
    price: srv.price, service: srv.service, note: V.text(ctx.body.note, 120), status: "pending", movedCount: 0, reminderSent: false, source: "client",
    noSms: user.phoneVerified !== true
  };
  S.placeAt(appt, date, time);

  if (!(await S.acquireSlot(ctx, date, time, appt.id))) throw slotTakenError();
  // Everything below holds the slot, so any refusal has to give it back.
  const mutexKey = K(ctx, `bookmx:${shortHash(user.phone)}`);
  let mutexHeld = false;
  try {
    // One booking at a time per phone, so parallel requests cannot pass the active-appointment cap.
    mutexHeld = (await cmd("SET", mutexKey, "1", "NX", "EX", 15)) === "OK";
    if (!mutexHeld) throw new HttpError(429, "בקשה קודמת עדיין בטיפול, נסו שוב בעוד רגע");
    const now = Date.now();
    const active = (await apptsOnPhone(ctx, user.phone)).filter(a => a.status !== "canceled" && a.startsAtMs > now);
    if (active.length >= MAX_ACTIVE_APPTS) throw new HttpError(409, `אפשר להחזיק עד ${MAX_ACTIVE_APPTS} תורים קרובים. כדי לקבוע עוד, צריך לבטל תור קיים או לפנות לעילי.`, { code: "too_many_active" });
    await enforceLimit(ctx.ns, "bookip", ipKey(ctx.req), MAX_BOOKINGS_IP_DAY, 86400, "נקבעו יותר מדי תורים מהחיבור הזה היום. אפשר לפנות לעילי בטלפון.");
    await enforceLimit(ctx.ns, "bookall", todayYmd(), MAX_BOOKINGS_DAY, 172800, "אי אפשר לקבוע עוד תורים באתר היום. אפשר לפנות לעילי בטלפון.");
    await pipeline([...D.saveApptCmds(ctx, appt), ["INCR", K(ctx, "ver")]]);
  } catch (err) {
    await S.releaseSlot(ctx, date, time, appt.id);
    throw err;
  } finally {
    if (mutexHeld) await cmd("DEL", mutexKey);
  }

  await D.addNotification(ctx, {
    type: "new_booking", title: "תור חדש נקבע באתר!", message: `${appt.name} (${appt.phone}) קבע תור ל${srv.name} ${S.describeSlot(appt)}.`,
    apptId: appt.id, dayIdx: appt.dayIdx, date, uid: user.id, pushMessage: `תור חדש: ${S.describeSlot(appt)}`
  });
  const sms = await sendApptSms(ctx, appt, await templates.clientBooked(ctx, appt), "booking", { uid: user.id, ipCap: true });
  ok(ctx, { appointment: ownView(appt), smsSent: sms.ok });
}

async function moveAppointment(ctx) {
  const user = await requireClient(ctx);
  const id = apptIdParam(ctx);
  await enforceLimit(ctx.ns, "move", shortHash(user.id), 20, 86400);
  const { date, time } = parseSlotRequest(ctx.body);
  const config = await D.getConfig(ctx);
  const srv = serviceFrom(config, ctx.body.srvIdx);
  S.assertClientSlot(config, date, time);

  let acquired = false;
  let result;
  try {
    result = await S.mutateAppt(ctx, id, async (next, prev) => {
      if (!canAccess(user, prev)) throw notFound();
      assertUpcoming(prev);
      if (!(prev.date === date && prev.time === time)) {
        if (!(await S.acquireSlot(ctx, date, time, id))) throw slotTakenError();
        acquired = true;
      }
      S.placeAt(next, date, time);
      Object.assign(next, { srvIdx: srv.srvIdx, price: srv.price, service: srv.service, status: "pending", movedCount: (Number(prev.movedCount) || 0) + 1, reminderSent: false, noSms: user.phoneVerified !== true });
      delete next.confirmedAt;
    });
  } catch (err) {
    if (acquired) await S.releaseSlot(ctx, date, time, id);
    throw err;
  }
  if (!result) throw notFound();
  const { appt, prev } = result;
  if (!(prev.date === date && prev.time === time)) await S.releaseSlot(ctx, prev.date, prev.time, id);
  await D.addNotification(ctx, {
    type: "moved", title: "לקוח שינה מועד תור", message: `${appt.name} הזיז את התור ל${S.describeSlot(appt)}.`,
    apptId: id, dayIdx: appt.dayIdx, date, uid: user.id, pushMessage: `תור הוזז: ${S.describeSlot(appt)}`
  });
  const sms = await sendApptSms(ctx, appt, await templates.clientMoved(ctx, appt), "move", { uid: user.id, ipCap: true });
  ok(ctx, { appointment: ownView(appt), smsSent: sms.ok });
}

async function logIncoming(ctx, user, text, apptId) {
  await D.addLog(ctx, { phone: user.phone, name: user.username, message: text, category: "incoming", parts: 0, status: "received", reason: "התקבל מהלקוח", apptId, uid: user.id, noRetry: true });
}

async function confirmAppointment(ctx) {
  const user = await requireClient(ctx);
  const id = apptIdParam(ctx);
  await enforceLimit(ctx.ns, "appt", shortHash(user.id), 60, 3600);
  const result = await S.mutateAppt(ctx, id, (next, prev) => {
    if (!canAccess(user, prev)) throw notFound();
    assertUpcoming(prev);
    next.status = "confirmed";
    next.confirmedAt = heTime();
  });
  if (!result) throw notFound();
  const { appt } = result;
  await logIncoming(ctx, user, `אישור הגעה לתור ביום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}`, id);
  await D.addNotification(ctx, {
    type: "confirmed", title: "אישור הגעה התקבל!", message: `${appt.name} אישר הגעה לתור ביום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}.`,
    apptId: id, dayIdx: appt.dayIdx, date: appt.date, uid: user.id
  });
  ok(ctx, { appointment: ownView(appt) });
}

async function cancelAppointment(ctx) {
  const user = await requireClient(ctx);
  const id = apptIdParam(ctx);
  await enforceLimit(ctx.ns, "appt", shortHash(user.id), 60, 3600);
  const result = await S.mutateAppt(ctx, id, (next, prev) => {
    if (!canAccess(user, prev)) throw notFound();
    assertUpcoming(prev);
    next.status = "canceled";
    next.canceledAt = Date.now();
  });
  if (!result) throw notFound();
  const { appt } = result;
  // Released only after the canceled state is safely written.
  await S.releaseSlot(ctx, appt.date, appt.time, id);
  await logIncoming(ctx, user, `ביטול תור ליום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}`, id);
  await D.addNotification(ctx, {
    type: "canceled", title: "לקוח ביטל תור באתר", message: `${appt.name} (${appt.phone}) ביטל את התור ליום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}.`,
    apptId: id, dayIdx: appt.dayIdx, date: appt.date, uid: user.id, pushMessage: `תור בוטל: ${S.describeSlot(appt)}`
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
  if (!ctx.body.optIn) return ok(ctx, { user: selfView(await D.optOutMarketing(ctx, user)) });
  if (user.marketingOptIn !== true) {
    user.marketingOptIn = true;
    user.marketingConsentAt = Date.now();
    await pipeline([["HSET", K(ctx, "users"), user.id, JSON.stringify(user)], ["INCR", K(ctx, "ver")]]);
  }
  ok(ctx, { user: selfView(user) });
}

// The one-tap link from a marketing SMS. Same-origin and rate limited; the reply never says whether the token matched
// anyone or whether that number was on the list.
async function publicOptOut(ctx) {
  await enforceLimit("", "optout", ipKey(ctx.req), 30, 3600);
  const found = await findOptOutUser(ctx.body.t);
  if (found) await D.optOutMarketing({ ...ctx, ns: found.ns }, found.user);
  ok(ctx);
}

async function deleteAccount(ctx) {
  const user = await requireClient(ctx);
  await enforceLimit(ctx.ns, "acct", shortHash(user.id), 30, 3600);
  const canceled = await S.eraseCustomer(ctx, user, { byPhone: user.phoneVerified === true });
  await A.revokeAllClientSessions(ctx, user.id);
  clearCookie(ctx.req, ctx.res, ctx.test ? "ilay_sid_test" : "ilay_sid");
  await D.addNotification(ctx, { type: "account_deleted", title: "לקוח מחק את החשבון שלו", message: canceled ? `חשבון נמחק ו-${canceled} תורים עתידיים בוטלו.` : "חשבון לקוח נמחק." });
  ok(ctx);
}

module.exports = {
  getPublic, getPhoto, testCheck, register, registerVerify, login, logout, resetRequest, resetConfirm, getMe, createAppointment, moveAppointment,
  confirmAppointment, cancelAppointment, sendMessage, setMarketing, publicOptOut, deleteAccount
};
