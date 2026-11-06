// Local stand-in for Vercel: serves the static files with vercel.json headers and rewrites, mounts the
// router, and replaces global fetch so nothing can leave this machine. Only the fake Upstash is reachable;
// SMS and ntfy calls are recorded instead of sent; any other host throws.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createFake } = require("./fake-upstash");

const ROOT = path.join(__dirname, "..");
const TOKEN = "fake-upstash-token";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const SERVED_EXT = new Set(Object.keys(MIME));

// vercel.json "source" patterns used by this project.
function sourceRegex(src) {
  if (src === "/admin.html") return /^\/admin\.html$/;
  if (src === "/(.*)") return /^\/.*$/;
  if (src === "/api/:path*") return /^\/api(\/.*)?$/;
  throw new Error("harness does not know vercel source " + src);
}

async function start({ env = {}, port = 0 } = {}) {
  const fake = createFake(TOKEN);
  await new Promise(r => fake.server.listen(0, "127.0.0.1", r));
  const fakeUrl = `http://127.0.0.1:${fake.server.address().port}`;

  const outbox = { sms: [], ntfy: [], blocked: [], smsFail: false };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(fakeUrl)) return realFetch(url, init);
    if (u.startsWith("https://my.textme.co.il/") || u.startsWith("https://019sms.co.il/")) {
      const body = JSON.parse(init.body);
      outbox.sms.push({ to: "0" + body.sms.destinations.phone, message: body.sms.message, sender: body.sms.source });
      if (outbox.smsFail) return new Response(JSON.stringify({ status: 998 }), { status: 200 });
      return new Response(JSON.stringify({ status: 0, shipment_id: "t" + outbox.sms.length }), { status: 200 });
    }
    if (u === "https://ntfy.sh") {
      outbox.ntfy.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    outbox.blocked.push(u);
    throw new Error("harness blocked outbound request to " + u);
  };

  Object.assign(process.env, {
    KV_REST_API_URL: fakeUrl, KV_REST_API_TOKEN: TOKEN,
    ADMIN_USERNAME: "testadmin", ADMIN_PASSWORD: "test-admin-pass-1",
    ADMIN2_USERNAME: "testadmin2", ADMIN2_PASSWORD: "test-admin-pass-2",
    SMS_PROVIDER: "textme", SMS_USERNAME: "fake-sms-user", SMS_API_TOKEN: "fake-sms-token", SMS_SENDER: "IlayTest",
    ...env
  });
  delete process.env.NTFY_TOPIC;
  if (env.NTFY_TOPIC) process.env.NTFY_TOPIC = env.NTFY_TOPIC;

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const headerRules = vercel.headers.map(h => ({ re: sourceRegex(h.source), headers: h.headers }));
  const rewrites = vercel.rewrites.map(r => ({ re: sourceRegex(r.source), destination: r.destination }));
  const router = require(path.join(ROOT, "api", "router.js"));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://internal");
    // vercel.json headers apply first; a function's own header of the same name wins, as on Vercel.
    headerRules.filter(h => h.re.test(url.pathname)).forEach(h => h.headers.forEach(({ key, value }) => res.setHeader(key, value)));

    const rewrite = rewrites.find(r => r.re.test(url.pathname));
    if (rewrite && rewrite.destination === "/api/router") {
      return router(req, res);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const file = path.normalize(path.join(ROOT, rel));
    const ext = path.extname(file);
    const relative = path.relative(ROOT, file);
    const denied = relative.startsWith("..") || relative.split(path.sep)[0] === "tests" || relative.split(path.sep)[0] === "api" || relative.startsWith(".");
    if (denied || !SERVED_EXT.has(ext) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("Content-Type", MIME[ext]);
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(port, "127.0.0.1", r));

  return {
    fake, outbox,
    base: `http://127.0.0.1:${server.address().port}`,
    server,
    async stop() {
      globalThis.fetch = realFetch;
      await new Promise(r => server.close(r));
      await new Promise(r => fake.server.close(r));
    }
  };
}

module.exports = { start };

// `node tests/harness.js [port]` runs it for driving the UI by hand or from a browser tool.
if (require.main === module) {
  start({ port: Number(process.argv[2]) || 4173 }).then(h => {
    console.log("harness at " + h.base);
    const extra = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sms: h.outbox.sms, ntfy: h.outbox.ntfy, blocked: h.outbox.blocked, commands: h.fake.stats.commands }));
    });
    extra.listen((Number(process.argv[2]) || 4173) + 1, "127.0.0.1");
  });
}
