// No-login marketing opt-out links. A token is an HMAC of the phone, so it carries no personal data, needs no
// storage, and dies with the account. The key is derived from the Redis token: rotating that token invalidates links
// already sent, which leaves the reply "הסר" as the way out for those messages.
const crypto = require("crypto");
const { RedisError, cmd, hashValues } = require("./_redis");

const KEY_LABEL = "ilay-barbershop:marketing-optout:v1";
const SIG_CHARS = 16; // 96 bits, short enough for an SMS.
const TOKEN_RE = /^T?[A-Za-z0-9_-]{16}$/;
const TEST_NS = "test:";

function signingKey() {
  const secret = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!secret) throw new RedisError("not_configured");
  return crypto.createHmac("sha256", secret).update(KEY_LABEL).digest();
}

// Tokens from test mode start with T and only ever match test-namespace accounts.
function tokenFor(ns, phone) {
  const sig = crypto.createHmac("sha256", signingKey()).update(`${ns}|${phone}`).digest("base64url").slice(0, SIG_CHARS);
  return (ns ? "T" : "") + sig;
}

const optOutUrl = (ctx, phone) => `https://${ctx.host}/optout.html?t=${tokenFor(ctx.ns, phone)}`;

const nsOfToken = token => (token.length === SIG_CHARS + 1 ? TEST_NS : "");

// Returns the namespace and account a token belongs to, or null. The account list is small enough to scan.
async function findOptOutUser(token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const ns = nsOfToken(token);
  const given = Buffer.from(token);
  const users = hashValues(await cmd("HGETALL", ns + "users"));
  const user = users.find(u => {
    const expected = Buffer.from(tokenFor(ns, u.phone));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
  return user ? { ns, user } : null;
}

module.exports = { tokenFor, optOutUrl, findOptOutUser };
