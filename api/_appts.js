// Slot locks and appointment rules shared by the client and admin endpoints.
// Slot semantics are the ones the booking UI always had: a slot is one start time on one date.
// Service duration does not block neighbouring slots.
const { cmd, pipeline, parseJson } = require("./_redis");
const { K } = require("./_data");
const { HttpError } = require("./_http");
const { DAYS_HEB, dateForDayIdx, epochFor, dateStrOf } = require("./_time");

// A lock's value is "<apptId>|<ms>". Compare-and-delete must be atomic, so these two run as Lua.
const RELEASE_SCRIPT = "local v=redis.call('GET',KEYS[1]) if v and string.sub(v,1,#ARGV[1]+1)==ARGV[1]..'|' then return redis.call('DEL',KEYS[1]) end return 0";
const SWAP_SCRIPT = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]) return 1 end return 0";
// Appointment rows are written only if they still hold exactly what was read.
const CAS_SCRIPT = "if redis.call('HGET',KEYS[1],ARGV[1])==ARGV[2] then redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]) return 1 end return 0";
const STALE_LOCK_MS = 60 * 1000;
const slotKey = (ctx, date, time) => K(ctx, `slot:${date}:${time}`);

function lockTtl(date, time) {
  return Math.max(86400, Math.ceil((epochFor(date, time) - Date.now()) / 1000) + 8 * 86400);
}

// Atomic via SET NX. A lock left behind by an interrupted request heals after a minute:
// it is taken over only when its holder no longer occupies this slot.
async function acquireSlot(ctx, date, time, apptId) {
  const key = slotKey(ctx, date, time);
  const ttl = lockTtl(date, time);
  const val = `${apptId}|${Date.now()}`;
  if (await cmd("SET", key, val, "NX", "EX", ttl) === "OK") return true;
  const cur = await cmd("GET", key);
  if (!cur) return (await cmd("SET", key, val, "NX", "EX", ttl)) === "OK";
  const [holder, ts] = cur.split("|");
  if (holder === apptId) return true;
  if (Date.now() - Number(ts) < STALE_LOCK_MS) return false;
  const appt = parseJson(await cmd("HGET", K(ctx, "appts"), holder));
  if (appt && appt.status !== "canceled" && appt.date === date && appt.time === time) return false;
  return Number(await cmd("EVAL", SWAP_SCRIPT, 1, key, cur, val, ttl)) === 1;
}

async function releaseSlot(ctx, date, time, apptId) {
  if (!date || !time) return;
  await cmd("EVAL", RELEASE_SCRIPT, 1, slotKey(ctx, date, time), apptId);
}

// Read-modify-write that cannot lose an update: a canceled appointment cannot be brought back by a
// slower request that read it earlier. fn receives a copy to change and the stored row; it may throw to
// abort or return false to leave the row alone, and it may run again if the row changed meanwhile.
// Resolves to null when the row does not exist.
async function mutateAppt(ctx, id, fn) {
  for (let i = 0; i < 6; i++) {
    const raw = await cmd("HGET", K(ctx, "appts"), id);
    if (!raw) return null;
    const prev = parseJson(raw);
    if (!prev) return null;
    const next = { ...prev };
    if ((await fn(next, prev)) === false) return { appt: prev, prev, changed: false };
    if (Number(await cmd("EVAL", CAS_SCRIPT, 1, K(ctx, "appts"), id, raw, JSON.stringify(next))) === 1) {
      const after = [["INCR", K(ctx, "ver")]];
      if (next.phone) after.push(["SADD", K(ctx, `phoneappts:${next.phone}`), id]);
      if (prev.phone && prev.phone !== next.phone) after.push(["SREM", K(ctx, `phoneappts:${prev.phone}`), id]);
      await pipeline(after);
      return { appt: next, prev, changed: true };
    }
  }
  throw new HttpError(409, "התור התעדכן ממש עכשיו, נסו שוב");
}

// Same grid the booking UI renders.
function slotOnGrid(cfg, day, time) {
  const step = Math.max(10, (Number(cfg.slotInterval) || 30) + (Number(cfg.slotBuffer) || 0));
  const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const target = toMin(time);
  for (let cur = toMin(day.start); cur < toMin(day.end); cur += step) if (cur === target) return true;
  return false;
}

function assertClientSlot(config, dayIdx, time) {
  const day = config.weeklySchedule[dayIdx];
  if (!day || !day.active) throw new HttpError(400, "ביום הזה המספרה סגורה. אפשר לבחור יום אחר.");
  if (!slotOnGrid(config.siteConfig, day, time)) throw new HttpError(400, "השעה הזו לא זמינה לקביעת תור");
  const date = dateForDayIdx(dayIdx);
  if (epochFor(date, time) <= Date.now()) throw new HttpError(400, "השעה הזו כבר עברה, נא לבחור שעה אחרת");
  return date;
}

function placeAt(appt, dayIdx, date, time) {
  appt.dayIdx = dayIdx;
  appt.date = date;
  appt.dateStr = dateStrOf(date);
  appt.time = time;
  appt.startsAtMs = epochFor(date, time);
}

function describeSlot(a) { return `יום ${DAYS_HEB[a.dayIdx]} (${a.dateStr}) בשעה ${a.time}`; }

module.exports = { acquireSlot, releaseSlot, mutateAppt, assertClientSlot, placeAt, describeSlot, RELEASE_SCRIPT, SWAP_SCRIPT, CAS_SCRIPT };
