// Start times by haircut length. There is one diary: every appointment holds its own length, and the next
// free start is the end of the one before it plus the break the owner set. core.js holds the same rules for the page.
const MIN_LEN = 5;
const MAX_LEN = 240;

const toMin = t => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, "0");
const fmt = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const inRange = n => Number.isInteger(n) && n >= MIN_LEN && n <= MAX_LEN;

// A service's length in minutes: its own number, else the number in its old "30 דק'" text, else the fallback.
function serviceMinutes(srv, fallback = 30) {
  const own = Number(srv && srv.minutes);
  if (inRange(own)) return own;
  const m = /(\d+)/.exec(String((srv && srv.duration) || ""));
  if (m && inRange(Number(m[1]))) return Number(m[1]);
  return fallback;
}

// An appointment keeps the length it was booked with. Older rows without one take their service's length.
function apptMinutes(a, services, site) {
  const own = Number(a && a.durationMin);
  if (inRange(own)) return own;
  const fallback = inRange(Number(site && site.slotInterval)) ? Number(site.slotInterval) : 30;
  const srv = Array.isArray(services) ? services[Number(a && a.srvIdx)] : null;
  return srv ? serviceMinutes(srv, fallback) : fallback;
}

const bufferOf = site => Math.max(0, Number(site && site.slotBuffer) || 0);

// Busy minutes of one date: [start, end) of every live appointment there, except the one being moved.
function busyRanges(appts, date, services, site, exceptId) {
  return appts
    .filter(a => a && a.date === date && a.status !== "canceled" && a.id !== exceptId && typeof a.time === "string")
    .map(a => { const s = toMin(a.time); return { s, e: s + apptMinutes(a, services, site) }; });
}

// Free starts of one open day for a haircut of `len` minutes. A start is free when the haircut and the break
// after it do not touch another appointment and its break. Starts follow each other by the haircut's length plus
// the break; after a booked appointment the next start is that appointment's end plus the break.
function freeStarts(day, len, buffer, ranges) {
  const open = toMin(day.start), close = toMin(day.end);
  const out = [];
  let cur = open;
  while (cur + len <= close) {
    const hits = ranges.filter(r => cur < r.e + buffer && r.s < cur + len + buffer);
    if (hits.length) { cur = Math.max(...hits.map(r => r.e + buffer)); continue; }
    out.push(fmt(cur));
    cur += len + buffer;
  }
  return out;
}

module.exports = { MIN_LEN, MAX_LEN, serviceMinutes, apptMinutes, bufferOf, busyRanges, freeStarts, toMin, fmt };
