// Request/response helpers. Uses plain Node req/res so it runs the same on Vercel and in the test harness.
class HttpError extends Error {
  constructor(status, reason, extra) { super(reason); this.status = status; this.reason = reason; this.extra = extra; }
}

function sendJson(res, status, obj, cache = "no-store") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(obj));
}

function readStream(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "הבקשה גדולה מדי")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Accepts JSON objects only. Vercel's lazy req.body getter throws on malformed JSON, hence the try.
async function readJsonBody(req, limit) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new HttpError(413, "הבקשה גדולה מדי");
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) throw new HttpError(415, "סוג תוכן לא נתמך");
  let body;
  try { body = req.body; } catch (_) { throw new HttpError(400, "בקשה לא תקינה"); }
  if (body === undefined) body = await readStream(req, limit);
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (body.length > limit) throw new HttpError(413, "הבקשה גדולה מדי");
    try { body = body ? JSON.parse(body) : {}; } catch (_) { throw new HttpError(400, "בקשה לא תקינה"); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "בקשה לא תקינה");
  return body;
}

function parseCookies(req) {
  const out = Object.create(null);
  String(req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function requestHost(req) { return String(req.headers.host || "").toLowerCase(); }
function isLocalHost(host) { return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host); }

function setCookie(req, res, name, value, maxAgeSec) {
  const attrs = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeSec !== null && maxAgeSec !== undefined) attrs.push("Max-Age=" + maxAgeSec);
  if (!isLocalHost(requestHost(req))) attrs.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, attrs.join("; ")) : attrs.join("; "));
}

function clearCookie(req, res, name) { setCookie(req, res, name, "", 0); }

function clientIp(req) {
  return String(req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0]).trim() || "unknown";
}

module.exports = { HttpError, sendJson, readJsonBody, parseCookies, requestHost, isLocalHost, setCookie, clearCookie, clientIp };
