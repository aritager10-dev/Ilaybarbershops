// The one deployed function. vercel.json rewrites /api/:path* here (Hobby allows 12 functions; _*.js files are
// shared code, not functions). Every route is listed below. Append ?test=1 to any path to use the test namespace,
// which requires a valid admin session.
//
//   Public    GET  /api/public                    config and busy slots, no personal data, CDN cached
//             GET  /api/photo/:id                 portfolio image
//             GET  /api/test/check                200 only with an admin session and ?test=1
//             POST /api/auth/register | register/verify | login | logout | reset/request | reset/confirm
//             POST /api/optout                    marketing opt-out from the SMS link, no login
//   Client    GET  /api/me                        account, own appointments, own messages
//             POST /api/appointments              create
//             POST /api/appointments/:id/move | confirm | cancel
//             POST /api/me/message | marketing | delete
//   Admin     POST /api/admin/login | logout
//             GET  /api/admin/whoami              page-load probe, public, reveals only yes or no
//             GET  /api/admin/session | version | state | sms/status
//             POST /api/admin/apply | reset | reminders | sms/broadcast | sms/test | sms/retry | photos | portfolio | users/:id/optout
const { RedisError } = require("./_redis");
const { HttpError, sendJson, readJsonBody, requestHost } = require("./_http");
const { originAllowed, enforceLimit, ipKey } = require("./_guard");
const { loadAdminSession } = require("./_auth");
const C = require("./_routes_client");
const M = require("./_routes_admin");

const GET_LIMIT_PER_MIN = 120;
const BODY_DEFAULT = 64 * 1024;
const BODY_ADMIN = 1024 * 1024;
const BODY_PHOTO = 1400 * 1024;

const routes = [
  ["GET", /^\/public$/, C.getPublic],
  ["GET", /^\/photo\/([^/]+)$/, C.getPhoto],
  ["GET", /^\/test\/check$/, C.testCheck],
  ["POST", /^\/auth\/register$/, C.register],
  ["POST", /^\/auth\/register\/verify$/, C.registerVerify],
  ["POST", /^\/auth\/login$/, C.login],
  ["POST", /^\/auth\/logout$/, C.logout],
  ["POST", /^\/auth\/reset\/request$/, C.resetRequest],
  ["POST", /^\/auth\/reset\/confirm$/, C.resetConfirm],
  ["POST", /^\/optout$/, C.publicOptOut, { public: true }],
  ["GET", /^\/me$/, C.getMe],
  ["POST", /^\/me\/message$/, C.sendMessage],
  ["POST", /^\/me\/marketing$/, C.setMarketing],
  ["POST", /^\/me\/delete$/, C.deleteAccount],
  ["POST", /^\/appointments$/, C.createAppointment],
  ["POST", /^\/appointments\/([^/]+)\/move$/, C.moveAppointment],
  ["POST", /^\/appointments\/([^/]+)\/confirm$/, C.confirmAppointment],
  ["POST", /^\/appointments\/([^/]+)\/cancel$/, C.cancelAppointment],
  ["POST", /^\/admin\/login$/, M.adminLogin, { public: true }],
  ["POST", /^\/admin\/logout$/, M.adminLogout, { public: true }],
  ["GET", /^\/admin\/whoami$/, M.adminWhoami, { public: true, needsAdminLookup: true }],
  ["GET", /^\/admin\/session$/, M.adminSession, { admin: true }],
  ["GET", /^\/admin\/version$/, M.adminVersion, { admin: true }],
  ["GET", /^\/admin\/state$/, M.getState, { admin: true }],
  ["GET", /^\/admin\/sms\/status$/, M.getSmsStatus, { admin: true }],
  ["POST", /^\/admin\/apply$/, M.applyChanges, { admin: true, body: BODY_ADMIN }],
  ["POST", /^\/admin\/reset$/, M.resetNamespace, { admin: true }],
  ["POST", /^\/admin\/reminders$/, M.manualReminders, { admin: true }],
  ["POST", /^\/admin\/sms\/broadcast$/, M.broadcast, { admin: true }],
  ["POST", /^\/admin\/users\/([^/]+)\/optout$/, M.optOutUser, { admin: true }],
  ["POST", /^\/admin\/sms\/test$/, M.testSms, { admin: true }],
  ["POST", /^\/admin\/sms\/retry$/, M.retrySms, { admin: true }],
  ["POST", /^\/admin\/photos$/, M.postPhoto, { admin: true, body: BODY_PHOTO }],
  ["POST", /^\/admin\/portfolio$/, M.postPortfolio, { admin: true }]
];

// A GET accepts only the query values it uses. Each extra value would be a separate CDN cache key, so a
// random one could otherwise bypass the cache and reach Redis on every request. Runs before any Redis call.
function assertKnownQuery(req, path) {
  const params = new URL(req.url, "http://internal").searchParams;
  for (const [key, value] of params) {
    const known = (key === "test" && value === "1")
      || (key === "soft" && value === "1" && path === "/me")
      || (key === "path" && "/" + params.getAll("path").join("/").replace(/^\/+/, "") === path);
    if (!known) throw new HttpError(400, "בקשה לא תקינה");
  }
}

// Vercel may hand the function the original path or the rewrite target with the captured
// path in the query, so both are understood.
function resolvePath(req) {
  const url = new URL(req.url, "http://internal");
  let path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/api/router") {
    const captured = url.searchParams.getAll("path").join("/");
    path = "/" + captured.replace(/^\/+/, "");
  } else if (path.startsWith("/api/")) {
    path = path.slice(4);
  }
  return { path, testFlag: url.searchParams.get("test") === "1" };
}

async function handle(req, res) {
  const { path, testFlag } = resolvePath(req);
  const method = req.method === "HEAD" ? "GET" : req.method;
  const matches = routes.filter(r => r[1].test(path));
  if (!matches.length) throw new HttpError(404, "לא נמצא");
  const route = matches.find(r => r[0] === method);
  if (!route) { res.setHeader("Allow", matches.map(r => r[0]).join(", ")); throw new HttpError(405, "Method not allowed"); }
  const opts = route[3] || {};

  if (method === "GET") {
    assertKnownQuery(req, path);
    // Only requests that reach this function count: CDN hits never do.
    await enforceLimit("", "g", ipKey(req), GET_LIMIT_PER_MIN, 60);
  }

  // Every state-changing request must come from this site.
  if (method === "POST" && !originAllowed(req)) throw new HttpError(403, "מקור לא מורשה");
  if (method === "POST") await enforceLimit("", "w", ipKey(req), 300, 600);

  const ctx = { req, res, host: requestHost(req), ns: "", test: false, params: route[1].exec(path).slice(1), body: {} };
  if (opts.admin || opts.needsAdminLookup || testFlag) ctx.admin = await loadAdminSession(req);

  // Checked first, so an expired admin session in test mode also returns the UI to the login screen.
  if (opts.admin && !ctx.admin) throw new HttpError(401, "נדרשת כניסה לניהול");
  // Test mode is enforced here, for every route, before the namespace is chosen.
  if (testFlag && !opts.public) {
    if (!ctx.admin) throw new HttpError(403, "מצב בדיקות זמין רק אחרי כניסה לניהול.", { code: "test_denied" });
    ctx.test = true;
    ctx.ns = "test:";
  }

  if (method === "POST") ctx.body = await readJsonBody(req, opts.body || BODY_DEFAULT);
  await route[2](ctx);
}

module.exports = async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, reason: err.reason, ...(err.extra || {}) });
    if (err instanceof RedisError) {
      console.error("[router] redis", err.message);
      const reason = err.message === "not_configured" ? "מסד הנתונים לא מוגדר בשרת" : "השרת לא זמין כרגע, נסו שוב בעוד רגע";
      return sendJson(res, 503, { ok: false, reason });
    }
    console.error("[router] unexpected", err && err.name);
    return sendJson(res, 500, { ok: false, reason: "שגיאת שרת, נסו שוב" });
  }
};
