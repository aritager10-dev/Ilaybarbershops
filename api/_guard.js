// Same-origin enforcement for state-changing requests, and durable rate limits stored in Redis.
const crypto = require("crypto");
const { pipeline } = require("./_redis");
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

// Fixed window counter. Returns true when the caller is over the limit.
async function overLimit(ns, scope, id, max, windowSec) {
  const key = `${ns}rl:${scope}:${id}`;
  const [, count] = await pipeline([["SET", key, "0", "NX", "EX", windowSec], ["INCR", key]]);
  return Number(count) > max;
}

async function enforceLimit(ns, scope, id, max, windowSec, reason = "יותר מדי בקשות, נסו שוב מאוחר יותר") {
  if (await overLimit(ns, scope, id, max, windowSec)) throw new HttpError(429, reason);
}

module.exports = { originAllowed, overLimit, enforceLimit, ipKey, shortHash };
