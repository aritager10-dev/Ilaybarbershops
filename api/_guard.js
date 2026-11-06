// Same-origin enforcement for state-changing requests, and durable rate limits stored in Redis.
const crypto = require("crypto");
const { cmd } = require("./_redis");
const { requestHost, isLocalHost, clientIp, HttpError } = require("./_http");

function allowedOrigins(req) {
  const host = requestHost(req);
  const list = [`https://${host}`];
  if (isLocalHost(host)) list.push(`http://${host}`);
  String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).forEach(o => list.push(o));
  return list;
}

// Requires an Origin (or Referer) from the request's own host; a request with neither is rejected.
function originAllowed(req) {
  if (!requestHost(req)) return false;
  const allowed = allowedOrigins(req);
  const origin = req.headers.origin;
  if (origin) return allowed.includes(String(origin).toLowerCase());
  const ref = req.headers.referer || req.headers.referrer;
  if (ref) { try { return allowed.includes(new URL(ref).origin.toLowerCase()); } catch (_) { return false; } }
  return false;
}

function shortHash(v) { return crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 32); }
// IPs are never stored raw; only this hash appears in Redis key names.
function ipKey(req) { return shortHash("ip:" + clientIp(req)); }

// Fixed window counter. Lua keeps INCR and EXPIRE atomic, so a counter can never be left without a TTL.
const RATE_SCRIPT = "local c=redis.call('INCR',KEYS[1]) if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end return c";

async function bumpCounter(key, windowSec) {
  return Number(await cmd("EVAL", RATE_SCRIPT, 1, key, windowSec));
}

// Returns true when the caller is over the limit.
async function overLimit(ns, scope, id, max, windowSec) {
  return (await bumpCounter(`${ns}rl:${scope}:${id}`, windowSec)) > max;
}

async function enforceLimit(ns, scope, id, max, windowSec, reason = "יותר מדי בקשות, נסו שוב מאוחר יותר") {
  if (await overLimit(ns, scope, id, max, windowSec)) throw new HttpError(429, reason);
}

module.exports = { originAllowed, overLimit, enforceLimit, bumpCounter, ipKey, shortHash, RATE_SCRIPT };
