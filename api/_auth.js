// Password hashing, server-side sessions and login throttling.
const crypto = require("crypto");
const { promisify } = require("util");
const { cmd, pipeline, parseJson } = require("./_redis");
const { parseCookies, setCookie, clearCookie, HttpError } = require("./_http");
const { shortHash, ipKey } = require("./_guard");

const scrypt = promisify(crypto.scrypt);
// OWASP-listed scrypt profile that fits serverless memory (32 MiB per hash).
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 32 };
const MAXMEM = 128 * 1024 * 1024;
const CLIENT_TTL = 60 * 24 * 3600;
const ADMIN_TTL = 12 * 3600;
const FAIL_LOCK_SEC = 15 * 60;
const FAIL_MAX_ID = 5;
const FAIL_MAX_IP = 20; // Many customers can share one mobile-carrier IP.

const sha256 = v => crypto.createHash("sha256").update(v).digest("hex");

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

async function verifyPassword(pw, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/.exec(String(stored || ""));
  if (!m) return false;
  const expected = Buffer.from(m[5], "base64");
  const dk = await scrypt(String(pw), Buffer.from(m[4], "base64"), expected.length, { N: +m[1], r: +m[2], p: +m[3], maxmem: MAXMEM });
  return crypto.timingSafeEqual(dk, expected);
}

// Spends the same CPU as a real check when the account does not exist or has no password.
let dummyHash = null;
async function burnVerify(pw) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(pw, dummyHash);
}

function constantEq(a, b) {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
}

// --- Sessions: the browser holds a random token, Redis holds only its sha256. ---
const clientCookie = ctx => (ctx.test ? "ilay_sid_test" : "ilay_sid");
const ADMIN_COOKIE = "ilay_admin";
const clientKey = (ctx, h) => `${ctx.ns}sess:${h}`;
const adminKey = h => `asess:${h}`; // Admin sessions live outside the test namespace.

function newToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

async function startClientSession(ctx, uid) {
  const { token, hash } = newToken();
  const sessSet = `${ctx.ns}usess:${uid}`;
  await pipeline([
    ["SET", clientKey(ctx, hash), JSON.stringify({ uid, touched: Date.now() }), "EX", CLIENT_TTL],
    ["SADD", sessSet, hash],
    ["EXPIRE", sessSet, CLIENT_TTL]
  ]);
  setCookie(ctx.req, ctx.res, clientCookie(ctx), token, CLIENT_TTL);
}

async function loadClientSession(ctx) {
  const token = parseCookies(ctx.req)[clientCookie(ctx)];
  if (!token) return null;
  const hash = sha256(token);
  const key = clientKey(ctx, hash);
  const sess = parseJson(await cmd("GET", key));
  if (!sess || !sess.uid) return null;
  // Sliding 60-day expiry, refreshed at most once a day to save commands.
  if (Date.now() - Number(sess.touched || 0) > 24 * 3600 * 1000) {
    await pipeline([
      ["SET", key, JSON.stringify({ uid: sess.uid, touched: Date.now() }), "EX", CLIENT_TTL],
      ["EXPIRE", `${ctx.ns}usess:${sess.uid}`, CLIENT_TTL]
    ]);
    setCookie(ctx.req, ctx.res, clientCookie(ctx), token, CLIENT_TTL);
  }
  return { uid: sess.uid, hash };
}

async function endClientSession(ctx) {
  const token = parseCookies(ctx.req)[clientCookie(ctx)];
  if (token) {
    const hash = sha256(token);
    const sess = parseJson(await cmd("GET", clientKey(ctx, hash)));
    const cmds = [["DEL", clientKey(ctx, hash)]];
    if (sess && sess.uid) cmds.push(["SREM", `${ctx.ns}usess:${sess.uid}`, hash]);
    await pipeline(cmds);
  }
  clearCookie(ctx.req, ctx.res, clientCookie(ctx));
}

async function revokeAllClientSessions(ctx, uid) {
  const setKey = `${ctx.ns}usess:${uid}`;
  const hashes = await cmd("SMEMBERS", setKey);
  const cmds = [["DEL", setKey]];
  (hashes || []).forEach(h => cmds.push(["DEL", clientKey(ctx, h)]));
  await pipeline(cmds);
}

async function startAdminSession(ctx, label, remember) {
  const { token, hash } = newToken();
  await cmd("SET", adminKey(hash), JSON.stringify({ label, at: Date.now() }), "EX", ADMIN_TTL);
  // "Remember" only decides whether the cookie survives closing the browser; the server limit is always 12 hours.
  setCookie(ctx.req, ctx.res, ADMIN_COOKIE, token, remember ? ADMIN_TTL : null);
}

async function loadAdminSession(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const sess = parseJson(await cmd("GET", adminKey(sha256(token))));
  return sess && sess.label ? { label: sess.label } : null;
}

async function endAdminSession(ctx) {
  const token = parseCookies(ctx.req)[ADMIN_COOKIE];
  if (token) await cmd("DEL", adminKey(sha256(token)));
  clearCookie(ctx.req, ctx.res, ADMIN_COOKIE);
}

// --- Failed-login counters. ---
const failKeys = (ctx, scope, identifier) => [
  `${ctx.ns}fail:${scope}:id:${shortHash(identifier)}`,
  `${ctx.ns}fail:${scope}:ip:${ipKey(ctx.req)}`
];

async function assertNotLocked(ctx, scope, identifier) {
  const [idKey, ipK] = failKeys(ctx, scope, identifier);
  const [idCount, ipCount] = await cmd("MGET", idKey, ipK);
  if (Number(idCount) >= FAIL_MAX_ID || Number(ipCount) >= FAIL_MAX_IP) {
    throw new HttpError(429, "יותר מדי ניסיונות כושלים. נסו שוב בעוד כ-15 דקות.");
  }
}

async function recordFailure(ctx, scope, identifier) {
  const [idKey, ipK] = failKeys(ctx, scope, identifier);
  const res = await pipeline([
    ["SET", idKey, "0", "NX", "EX", FAIL_LOCK_SEC], ["INCR", idKey],
    ["SET", ipK, "0", "NX", "EX", FAIL_LOCK_SEC], ["INCR", ipK]
  ]);
  // Reaching the limit starts a full 15-minute lock from this attempt.
  const extra = [];
  if (Number(res[1]) >= FAIL_MAX_ID) extra.push(["EXPIRE", idKey, FAIL_LOCK_SEC]);
  if (Number(res[3]) >= FAIL_MAX_IP) extra.push(["EXPIRE", ipK, FAIL_LOCK_SEC]);
  await pipeline(extra);
}

async function clearFailures(ctx, scope, identifier) {
  await cmd("DEL", failKeys(ctx, scope, identifier)[0]);
}

// --- Admin credentials come only from environment variables. ---
function adminAccounts() {
  const list = [];
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) list.push({ u: process.env.ADMIN_USERNAME, p: process.env.ADMIN_PASSWORD, label: "עילי בן הרוש" });
  if (process.env.ADMIN2_USERNAME && process.env.ADMIN2_PASSWORD) list.push({ u: process.env.ADMIN2_USERNAME, p: process.env.ADMIN2_PASSWORD, label: "AriDev" });
  return list;
}

function matchAdmin(username, pw) {
  const u = String(username || "").trim().toLowerCase();
  let found = null;
  // No short circuit: every configured account is compared on every attempt.
  for (const a of adminAccounts()) {
    const okU = constantEq(u, String(a.u).trim().toLowerCase());
    const okP = constantEq(String(pw || ""), a.p);
    if (okU && okP) found = a;
  }
  return found;
}

module.exports = {
  sha256, hashPassword, verifyPassword, burnVerify, startClientSession, loadClientSession, endClientSession, revokeAllClientSessions,
  startAdminSession, loadAdminSession, endAdminSession, assertNotLocked, recordFailure, clearFailures, adminAccounts, matchAdmin
};
