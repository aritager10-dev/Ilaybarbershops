// Password hashing, server-side sessions and login throttling.
const crypto = require("crypto");
const { promisify } = require("util");
const { cmd, pipeline, parseJson } = require("./_redis");
const { parseCookies, setCookie, clearCookie, HttpError } = require("./_http");
const { shortHash, ipKey, bumpCounter } = require("./_guard");

const scrypt = promisify(crypto.scrypt);
// OWASP-listed scrypt profile that fits serverless memory (32 MiB per hash).
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 32 };
const MAXMEM = 128 * 1024 * 1024;
const CLIENT_TTL = 60 * 24 * 3600;
const ADMIN_TTL = 12 * 3600;
const FAIL_LOCK_SEC = 15 * 60;
const FAIL_MAX_PAIR = 5;  // Per identifier from one IP.
const FAIL_MAX_IP = 20;   // Per IP. Many customers can share one mobile-carrier IP.
const FAIL_MAX_ID = 100;  // Per identifier from all IPs together.

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

// --- Login attempts. ---
// The strict lock is per identifier+IP, so a stranger failing from their own IP locks only themselves.
// The per-identifier total is much higher and needs many IPs to reach. An attempt is counted before the
// password is checked, so parallel guesses cannot pass the limit; a successful login gives it back.
const attemptKeys = (ctx, scope, identifier) => {
  const id = shortHash(identifier);
  const ip = ipKey(ctx.req);
  return { pair: `${ctx.ns}fail:${scope}:pair:${id}:${ip}`, global: `${ctx.ns}fail:${scope}:id:${id}`, ip: `${ctx.ns}fail:${scope}:ip:${ip}` };
};
const lockedError = () => new HttpError(429, "יותר מדי ניסיונות כושלים. נסו שוב בעוד כ-15 דקות.");

async function reserveAttempt(ctx, scope, identifier) {
  const keys = attemptKeys(ctx, scope, identifier);
  // Checked in this order so attempts already refused here never feed the per-identifier total.
  const pair = await bumpCounter(keys.pair, FAIL_LOCK_SEC);
  if (pair === FAIL_MAX_PAIR) await cmd("EXPIRE", keys.pair, FAIL_LOCK_SEC);
  if (pair > FAIL_MAX_PAIR) throw lockedError();
  if ((await bumpCounter(keys.ip, FAIL_LOCK_SEC)) > FAIL_MAX_IP) throw lockedError();
  if ((await bumpCounter(keys.global, FAIL_LOCK_SEC)) > FAIL_MAX_ID) throw lockedError();
}

async function attemptSucceeded(ctx, scope, identifier) {
  const keys = attemptKeys(ctx, scope, identifier);
  await pipeline([["DEL", keys.pair], ["DECR", keys.ip], ["DECR", keys.global]]);
}

async function clearFailures(ctx, scope, identifier) {
  const keys = attemptKeys(ctx, scope, identifier);
  await pipeline([["DEL", keys.pair], ["DEL", keys.global]]);
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
  startAdminSession, loadAdminSession, endAdminSession, reserveAttempt, attemptSucceeded, clearFailures, adminAccounts, matchAdmin
};
