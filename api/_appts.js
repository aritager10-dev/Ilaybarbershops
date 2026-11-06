// Slot locks and appointment rules shared by the client and admin endpoints.
// Slot semantics are the ones the booking UI always had: a slot is one start time on one date.
// Service duration does not block neighbouring slots.
const { cmd, parseJson } = require("./_redis");
const { K } = require("./_data");
const { HttpError } = require("./_http");
const { DAYS_HEB, dateForDayIdx, epochFor, dateStrOf } = require("./_time");

// A lock's value is "<apptId>|<ms>". Compare-and-delete must be atomic, so these two run as Lua.
const RELEASE_SCRIPT = "local v=redis.call('GET',KEYS[1]) if v and string.sub(v,1,#ARGV[1]+1)==ARGV[1]..'|' then return redis.call('DEL',KEYS[1]) end return 0";
const SWAP_SCRIPT = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]) return 1 end return 0";
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

module.exports = { acquireSlot, releaseSlot, assertClientSlot, placeAt, describeSlot, RELEASE_SCRIPT, SWAP_SCRIPT };
