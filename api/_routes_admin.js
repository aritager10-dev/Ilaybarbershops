// Admin endpoints. Everything except login requires an admin session (enforced in router.js).
const { cmd, pipeline, parseJson } = require("./_redis");
const { HttpError, sendJson } = require("./_http");
const { enforceLimit, ipKey } = require("./_guard");
const V = require("./_validate");
const A = require("./_auth");
const D = require("./_data");
const { K } = D;
const S = require("./_appts");
const { sendTracked, retryLog, hasForeignLink, smsStatus, templates, smsName } = require("./_sms");
const { runReminders, maybeRunReminders } = require("./_reminders");
const { uploadPhoto, savePortfolio } = require("./_photos");
const { DAYS_HEB, dateForDayIdx, heDate } = require("./_time");

const ok = (ctx, data = {}) => sendJson(ctx.res, 200, { ok: true, ...data });
const MAX_UPSERTS = 500;

async function adminLogin(ctx) {
  // Fails closed when the environment is not configured.
  if (!A.adminAccounts().length) throw new HttpError(503, "הכניסה לניהול עדיין לא הוגדרה בשרת. יש להגדיר את ADMIN_USERNAME ו-ADMIN_PASSWORD ב-Vercel.", { code: "not_configured" });
  const username = typeof ctx.body.username === "string" ? ctx.body.username.slice(0, 100) : "";
  const password = typeof ctx.body.password === "string" ? ctx.body.password.slice(0, 200) : "";
  const throttleId = "admin:" + username.trim().toLowerCase();
  await A.assertNotLocked(ctx, "admin", throttleId);
  const found = A.matchAdmin(username, password);
  if (!found) {
    await A.recordFailure(ctx, "admin", throttleId);
    throw new HttpError(401, "שם המשתמש או הסיסמה שגויים.", { code: "bad_credentials" });
  }
  await A.clearFailures(ctx, "admin", throttleId);
  await A.startAdminSession(ctx, found.label, ctx.body.remember === true);
  ok(ctx, { label: found.label });
}

async function adminLogout(ctx) {
  await A.endAdminSession(ctx);
  ok(ctx);
}

const adminSession = ctx => ok(ctx, { label: ctx.admin.label, test: ctx.test });
// Page-load probe. Says only whether this browser holds an admin session.
const adminWhoami = ctx => ok(ctx, { label: ctx.admin ? ctx.admin.label : null });

// Cheap poll: one MGET. The browser fetches the full state only when the version changed.
async function adminVersion(ctx) {
  const [ver, gate] = await cmd("MGET", K(ctx, "ver"), K(ctx, "remgate"));
  await maybeRunReminders(ctx, gate);
  ok(ctx, { v: Number(ver) || 0 });
}

async function getState(ctx) { ok(ctx, { state: await D.adminState(ctx) }); }
const getSmsStatus = ctx => ok(ctx, smsStatus());

// --- Applying the browser's diff ---
async function ensureUserForPhone(ctx, name, phone) {
  const uid = D.newId("usr");
  if (Number(await cmd("HSETNX", K(ctx, "idx:phone"), phone, uid)) !== 1) return;
  await cmd("HSETNX", K(ctx, "idx:name"), name.toLowerCase(), uid);
  const now = Date.now();
  await cmd("HSET", K(ctx, "users"), uid, JSON.stringify({ id: uid, username: name, phone, marketingOptIn: false, consentAt: null, createdAt: heDate(now), lastActiveAt: now }));
}

async function createFromAdmin(ctx, raw, out) {
  const dayIdx = V.intIn(raw.dayIdx, 0, 6);
  const name = V.text(raw.name, 40);
  const phone = V.anyPhone(raw.phone);
  if (dayIdx === null || !V.isTime(raw.time)) { out.conflicts.push({ id: raw.id, reason: "יום או שעה לא תקינים" }); return; }
  if (name.length < 2 || !phone) { out.conflicts.push({ id: raw.id, reason: "נא להזין שם מלא וטלפון תקין" }); return; }
  const date = dateForDayIdx(dayIdx);
  const appt = {
    id: raw.id, createdAt: Date.now(), name, phone, price: V.price(raw.price) ?? 0, service: V.text(raw.service, 80),
    srvIdx: V.intIn(raw.srvIdx, 0, 30) ?? 0, note: V.text(raw.note, 120), status: "pending", movedCount: 0, reminderSent: false, source: "admin"
  };
  S.placeAt(appt, dayIdx, date, raw.time);
  if (!(await S.acquireSlot(ctx, date, raw.time, appt.id))) { out.conflicts.push({ id: raw.id, reason: "השעה הזו כבר תפוסה ביומן!" }); return; }
  await pipeline(D.saveApptCmds(ctx, appt));
  await ensureUserForPhone(ctx, name, phone);
  out.sms[appt.id] = await sendTracked(ctx, { phone, name, message: templates.adminBooked(ctx, appt), category: "booking", apptId: appt.id });
}

async function updateFromAdmin(ctx, raw, stored, out) {
  const appt = { ...stored };
  const prevPhone = stored.phone;
  const dayIdx = raw.dayIdx === undefined ? stored.dayIdx : V.intIn(raw.dayIdx, 0, 6);
  const time = raw.time === undefined ? stored.time : raw.time;
  if (dayIdx === null || !V.isTime(time)) { out.conflicts.push({ id: raw.id, reason: "יום או שעה לא תקינים" }); return; }
  const status = ["pending", "confirmed", "canceled"].includes(raw.status) ? raw.status : stored.status;
  const moved = dayIdx !== stored.dayIdx || time !== stored.time;
  const wasCanceled = stored.status === "canceled";
  const nowCanceled = status === "canceled";

  if ("name" in raw) { const n = V.text(raw.name, 40); if (n.length >= 2) appt.name = n; }
  if ("phone" in raw) { const p = V.anyPhone(raw.phone); if (p) appt.phone = p; }
  if ("note" in raw) appt.note = V.text(raw.note, 120);
  if ("service" in raw) appt.service = V.text(raw.service, 80);
  if ("price" in raw) { const p = V.price(raw.price); if (p !== null) appt.price = p; }

  if (moved && !nowCanceled) {
    const date = dateForDayIdx(dayIdx);
    if (!(await S.acquireSlot(ctx, date, time, appt.id))) { out.conflicts.push({ id: raw.id, reason: "המשבצת תפוסה" }); return; }
    S.placeAt(appt, dayIdx, date, time);
    Object.assign(appt, { status: "pending", movedCount: (Number(appt.movedCount) || 0) + 1, reminderSent: false });
    delete appt.confirmedAt;
    delete appt.canceledAt;
    await pipeline(D.saveApptCmds(ctx, appt, prevPhone));
    if (!wasCanceled) await S.releaseSlot(ctx, stored.date, stored.time, appt.id);
    await D.addNotification(ctx, { type: "moved", title: "תור הוזז ביומן", message: `התור של ${appt.name} הועבר ל${S.describeSlot(appt)}.`, apptId: appt.id, dayIdx, pushMessage: `תור הוזז: ${S.describeSlot(appt)}` });
    out.sms[appt.id] = await sendTracked(ctx, { phone: appt.phone, name: appt.name, message: templates.adminMoved(ctx, appt), category: "move", apptId: appt.id });
    return;
  }

  if (nowCanceled && !wasCanceled) {
    appt.status = "canceled";
    appt.canceledAt = Date.now();
    await pipeline(D.saveApptCmds(ctx, appt, prevPhone));
    await S.releaseSlot(ctx, appt.date, appt.time, appt.id);
    await D.addNotification(ctx, { type: "canceled", title: "תור בוטל ביומן", message: `התור של ${appt.name} ליום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time} בוטל.`, apptId: appt.id, dayIdx: appt.dayIdx, pushMessage: `תור בוטל: יום ${DAYS_HEB[appt.dayIdx]} בשעה ${appt.time}` });
    out.sms[appt.id] = await sendTracked(ctx, { phone: appt.phone, name: appt.name, message: templates.adminCanceled(ctx, appt), category: "cancel", apptId: appt.id });
    return;
  }

  // A canceled appointment returning to the calendar must win its slot back first.
  if (!nowCanceled && wasCanceled && !(await S.acquireSlot(ctx, appt.date, appt.time, appt.id))) {
    out.conflicts.push({ id: raw.id, reason: "המשבצת כבר נתפסה" });
    return;
  }
  appt.status = status;
  await pipeline(D.saveApptCmds(ctx, appt, prevPhone));
}

async function applyAppointments(ctx, diff, out) {
  if (!diff || typeof diff !== "object") return;
  const upsert = Array.isArray(diff.upsert) ? diff.upsert.slice(0, MAX_UPSERTS) : [];
  for (const raw of upsert) {
    if (!raw || !V.isId(raw.id)) { out.conflicts.push({ id: "", reason: "תור לא תקין" }); continue; }
    const stored = await D.getAppt(ctx, raw.id);
    if (stored) await updateFromAdmin(ctx, raw, stored, out);
    else await createFromAdmin(ctx, raw, out);
  }
  const remove = Array.isArray(diff.remove) ? diff.remove.filter(V.isId).slice(0, MAX_UPSERTS) : [];
  for (const id of remove) {
    const stored = await D.getAppt(ctx, id);
    if (!stored) continue;
    if (stored.status !== "canceled") await S.releaseSlot(ctx, stored.date, stored.time, id);
    const cmds = [["HDEL", K(ctx, "appts"), id]];
    if (stored.phone) cmds.push(["SREM", K(ctx, `phoneappts:${stored.phone}`), id]);
    await pipeline(cmds);
  }
}

async function removeUser(ctx, uid) {
  const user = await D.getUser(ctx, uid);
  if (!user) return;
  const cmds = [
    ["HDEL", K(ctx, "users"), uid], ["DEL", K(ctx, `ucred:${uid}`)], ["DEL", K(ctx, `umsgs:${uid}`)], ["DEL", K(ctx, `reset:${user.phone}`)],
    ["HDEL", K(ctx, "idx:phone"), user.phone]
  ];
  // The name index may belong to another account when this one was auto-created from a manual booking.
  if ((await cmd("HGET", K(ctx, "idx:name"), user.username.toLowerCase())) === uid) cmds.push(["HDEL", K(ctx, "idx:name"), user.username.toLowerCase()]);
  await pipeline(cmds);
  await A.revokeAllClientSessions(ctx, uid);
}

async function applyUsers(ctx, diff, out) {
  if (!diff || typeof diff !== "object") return;
  const upsert = Array.isArray(diff.upsert) ? diff.upsert.slice(0, MAX_UPSERTS) : [];
  for (const raw of upsert) {
    if (!raw || !V.isId(raw.id)) continue;
    const username = V.text(raw.username, 40);
    const phone = V.anyPhone(raw.phone);
    if (username.length < 2 || !phone) { out.conflicts.push({ id: raw.id, reason: "נא להזין שם מלא וטלפון תקין" }); continue; }
    const stored = await D.getUser(ctx, raw.id);
    const nameKey = username.toLowerCase();
    if (!stored) {
      if (Number(await cmd("HSETNX", K(ctx, "idx:phone"), phone, raw.id)) !== 1) { out.conflicts.push({ id: raw.id, reason: "לקוח עם מספר טלפון זה כבר קיים!" }); continue; }
      if (Number(await cmd("HSETNX", K(ctx, "idx:name"), nameKey, raw.id)) !== 1) {
        await cmd("HDEL", K(ctx, "idx:phone"), phone);
        out.conflicts.push({ id: raw.id, reason: "לקוח עם שם זה כבר קיים!" });
        continue;
      }
      const now = Date.now();
      // Marketing consent can only come from the customer, so a manual entry starts with none.
      await cmd("HSET", K(ctx, "users"), raw.id, JSON.stringify({ id: raw.id, username, phone, marketingOptIn: false, consentAt: null, createdAt: heDate(now), lastActiveAt: now }));
      continue;
    }
    const updated = { ...stored };
    if (phone !== stored.phone) {
      if (Number(await cmd("HSETNX", K(ctx, "idx:phone"), phone, raw.id)) !== 1) { out.conflicts.push({ id: raw.id, reason: "לקוח עם מספר טלפון זה כבר קיים!" }); continue; }
      await cmd("HDEL", K(ctx, "idx:phone"), stored.phone);
      updated.phone = phone;
    }
    if (nameKey !== stored.username.toLowerCase()) {
      if (Number(await cmd("HSETNX", K(ctx, "idx:name"), nameKey, raw.id)) !== 1) { out.conflicts.push({ id: raw.id, reason: "לקוח עם שם זה כבר קיים!" }); }
      else { await cmd("HDEL", K(ctx, "idx:name"), stored.username.toLowerCase()); updated.username = username; }
    } else updated.username = username;
    await cmd("HSET", K(ctx, "users"), raw.id, JSON.stringify(updated));
  }
  const remove = Array.isArray(diff.remove) ? diff.remove.filter(V.isId).slice(0, MAX_UPSERTS) : [];
  for (const id of remove) await removeUser(ctx, id);
}

async function applyLogs(ctx, diff) {
  if (!diff || typeof diff !== "object") return;
  // The server writes every SMS log itself. The one thing the browser reports is a WhatsApp link it opened.
  const upsert = Array.isArray(diff.upsert) ? diff.upsert.slice(0, 20) : [];
  const existing = upsert.length ? await pipeline(upsert.map(l => ["HEXISTS", K(ctx, "smslogs"), String(l && l.id).slice(0, 60)])) : [];
  for (let i = 0; i < upsert.length; i++) {
    const l = upsert[i];
    if (!l || l.channel !== "whatsapp" || Number(existing[i]) === 1) continue;
    await D.addLog(ctx, {
      phone: V.anyPhone(l.phone) || "", name: V.text(l.name, 40), message: V.text(l.message, 600), category: "reminder", channel: "whatsapp",
      parts: 0, status: "sent", reason: "נשלח ב-WhatsApp", apptId: V.isId(l.apptId) ? l.apptId : null, noRetry: true
    });
  }
  const remove = Array.isArray(diff.remove) ? diff.remove.filter(V.isId).slice(0, MAX_UPSERTS) : [];
  if (remove.length) await cmd("HDEL", K(ctx, "smslogs"), ...remove);
}

async function applyNotifications(ctx, diff) {
  if (!diff || typeof diff !== "object") return;
  // Only the read flag can change.
  const upsert = Array.isArray(diff.upsert) ? diff.upsert.filter(n => n && V.isId(n.id)).slice(0, MAX_UPSERTS) : [];
  if (upsert.length) {
    const stored = await cmd("HMGET", K(ctx, "notifs"), ...upsert.map(n => n.id));
    const cmds = [];
    upsert.forEach((n, i) => {
      const cur = parseJson(stored[i]);
      if (cur) { cur.read = n.read === true; cmds.push(["HSET", K(ctx, "notifs"), cur.id, JSON.stringify(cur)]); }
    });
    await pipeline(cmds);
  }
  const remove = Array.isArray(diff.remove) ? diff.remove.filter(V.isId).slice(0, MAX_UPSERTS) : [];
  if (remove.length) await cmd("HDEL", K(ctx, "notifs"), ...remove);
}

// Body: { appointments, users, logs, notifications: {upsert, remove}; services, weeklySchedule, siteConfig: whole values }.
// Only what the admin changed is sent, so a client booking made in the meantime is never overwritten.
async function applyChanges(ctx) {
  const b = ctx.body;
  const out = { conflicts: [], sms: {} };
  // Validate whole-value sections first so a bad value rejects the request before anything is written.
  const writes = [];
  if ("services" in b) writes.push(["SET", K(ctx, "cfg:services"), JSON.stringify(V.services(b.services))]);
  if ("weeklySchedule" in b) writes.push(["SET", K(ctx, "cfg:schedule"), JSON.stringify(V.schedule(b.weeklySchedule))]);
  if ("siteConfig" in b) {
    const patch = V.siteConfigPatch(b.siteConfig);
    const stored = parseJson(await cmd("GET", K(ctx, "cfg:site"))) || {};
    writes.push(["SET", K(ctx, "cfg:site"), JSON.stringify({ ...stored, ...patch })]);
  }
  await pipeline(writes);
  await applyUsers(ctx, b.users, out);
  await applyAppointments(ctx, b.appointments, out);
  await applyLogs(ctx, b.logs);
  await applyNotifications(ctx, b.notifications);
  await D.bump(ctx);
  ok(ctx, { conflicts: out.conflicts, sms: out.sms, state: await D.adminState(ctx) });
}

// Clears the current namespace only. Config, prices and photos stay.
async function scanDelete(ctx, pattern) {
  let cursor = "0";
  do {
    const [next, keys] = await cmd("SCAN", cursor, "MATCH", pattern, "COUNT", 200);
    cursor = String(next);
    if (keys && keys.length) await cmd("DEL", ...keys);
  } while (cursor !== "0");
}

async function resetNamespace(ctx) {
  const b = ctx.body;
  if (!ctx.test && b.confirm !== "איפוס") throw V.bad("נדרש אישור לאיפוס");
  await cmd("DEL", K(ctx, "appts"), K(ctx, "smslogs"), K(ctx, "notifs"), K(ctx, "pub"));
  await scanDelete(ctx, K(ctx, "slot:*"));
  await scanDelete(ctx, K(ctx, "phoneappts:*"));
  await scanDelete(ctx, K(ctx, "remlock:*"));
  if (b.clearClients === true) {
    await cmd("DEL", K(ctx, "users"), K(ctx, "idx:phone"), K(ctx, "idx:name"));
    for (const p of ["ucred:*", "usess:*", "sess:*", "umsgs:*", "reset:*", "resetatt:*"]) await scanDelete(ctx, K(ctx, p));
  }
  await D.bump(ctx);
  ok(ctx, { state: await D.adminState(ctx) });
}

async function manualReminders(ctx) {
  await enforceLimit(ctx.ns, "remind", ipKey(ctx.req), 30, 3600);
  const { sent } = await runReminders(ctx, { force: true, budgetMs: 20000 });
  ok(ctx, { sent, state: await D.adminState(ctx) });
}

// --- SMS ---
async function broadcast(ctx) {
  await enforceLimit(ctx.ns, "broadcast", "all", 10, 86400, "נשלחו יותר מדי הודעות תפוצה היום");
  const raw = V.text(ctx.body.message, 500);
  if (!raw) throw V.bad("נא להקליד הודעה");
  if (hasForeignLink(raw, ctx.host)) throw V.bad("קישורים מותרים רק לאתר של המספרה");
  const state = await D.adminState(ctx);
  const list = state.registeredUsers.filter(u => u.marketingOptIn === true);
  const started = Date.now();
  let sent = 0;
  let attempted = 0;
  for (const u of list) {
    if (Date.now() - started > 25000) break;
    attempted++;
    const message = raw.replace(/\{שם\}/g, smsName(u.username)) + "\nלהסרה השב/י \"הסר\"";
    if ((await sendTracked(ctx, { phone: u.phone, name: u.username, message, category: "broadcast" })).ok) sent++;
  }
  ok(ctx, { sent, attempted, total: list.length, state: await D.adminState(ctx) });
}

async function testSms(ctx) {
  await enforceLimit(ctx.ns, "smstest", "all", 20, 86400);
  const config = await D.getConfig(ctx);
  const phone = config.siteConfig.barberPhone;
  if (!phone) throw V.bad("אין מספר טלפון של הספר בהגדרות");
  const result = await sendTracked(ctx, { phone, name: "בדיקה", message: templates.test(), category: "test" });
  ok(ctx, { sent: result.ok, reason: result.reason, state: await D.adminState(ctx) });
}

async function retrySms(ctx) {
  await enforceLimit(ctx.ns, "smsretry", "all", 100, 86400);
  if (!V.isId(ctx.body.id)) throw V.bad("בקשה לא תקינה");
  const log = parseJson(await cmd("HGET", K(ctx, "smslogs"), ctx.body.id));
  if (!log) throw new HttpError(404, "ההודעה לא נמצאה");
  const result = await retryLog(ctx, log);
  ok(ctx, { sent: result.ok, reason: result.reason, state: await D.adminState(ctx) });
}

// --- Photos ---
async function postPhoto(ctx) {
  await enforceLimit(ctx.ns, "photo", "all", 120, 3600);
  ok(ctx, { id: await uploadPhoto(ctx, ctx.body.image) });
}

async function postPortfolio(ctx) {
  ok(ctx, { portfolio: await savePortfolio(ctx, ctx.body.list) });
}

module.exports = {
  adminLogin, adminLogout, adminSession, adminWhoami, adminVersion, getState, getSmsStatus, applyChanges, resetNamespace,
  manualReminders, broadcast, testSms, retrySms, postPhoto, postPortfolio
};
