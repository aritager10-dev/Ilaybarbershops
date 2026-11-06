// Minimal Upstash Redis REST client (global fetch, no dependencies).
// Formats per upstash.com/docs/redis/features/restapi: POST <url> with ["CMD", ...] for one command,
// POST <url>/pipeline with [[...], [...]] for several; replies are {result} / {error}.
class RedisError extends Error {}

function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new RedisError("not_configured");
  return { url: url.replace(/\/+$/, ""), token };
}

async function post(path, body) {
  const { url, token } = creds();
  let res;
  try {
    res = await fetch(url + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
  } catch (_) { throw new RedisError("unreachable"); }
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null) throw new RedisError("http_" + res.status);
  return data;
}

async function cmd(...args) {
  const data = await post("", args.map(String));
  if (data.error) throw new RedisError("command_failed");
  return data.result;
}

// Not atomic; order is preserved. Any per-command error fails the whole call.
async function pipeline(commands) {
  if (!commands.length) return [];
  const data = await post("/pipeline", commands.map(c => c.map(String)));
  if (!Array.isArray(data)) throw new RedisError("bad_reply");
  return data.map(r => {
    if (r.error) throw new RedisError("command_failed");
    return r.result;
  });
}

function parseJson(raw, fallback = null) {
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

// HGETALL replies with a flat [field, value, ...] array.
function hashValues(flat) {
  const out = [];
  if (Array.isArray(flat)) for (let i = 1; i < flat.length; i += 2) { const v = parseJson(flat[i]); if (v) out.push(v); }
  return out;
}

module.exports = { RedisError, cmd, pipeline, hashValues, parseJson };
