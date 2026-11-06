// Automated API tests. Everything runs locally against tests/harness.js: a fake Upstash and stubbed
// SMS/ntfy. Nothing here can reach production, real Upstash or any SMS provider. Run: node tests/run.js
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { start } = require("./harness");
const TIME = require("../api/_time");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let h;
let ipCounter = 0;
let phoneCounter = 0;
let nameCounter = 0;
const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";

const freshIp = () => { ipCounter++; return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.1`; };
const freshPhone = () => "052" + String(1000000 + ++phoneCounter);
function freshName() {
  nameCounter++;
  const n = nameCounter;
  return `לקוח ${LETTERS[n % 22]}${LETTERS[Math.floor(n / 22) % 22]}${LETTERS[Math.floor(n / 484) % 22]}`;
}

class Client {
  constructor({ ip = freshIp(), origin } = {}) {
    this.ip = ip;
    this.jar = {};
    this.origin = origin;
    this.last = null;
  }
  async req(method, url, body, opts = {}) {
    const u = new URL(h.base + "/api" + url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { "x-real-ip": this.ip, ...(opts.headers || {}) };
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.cookie = cookie;
    if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = payload.length; }
    if (method === "POST" && !("noOrigin" in opts)) headers.origin = this.origin || h.base;
    const res = await new Promise((resolve, reject) => {
      const r = http.request(u, { method, headers }, resp => {
        const chunks = [];
        resp.on("data", c => chunks.push(c));
        resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, buffer: Buffer.concat(chunks) }));
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
    [].concat(res.headers["set-cookie"] || []).forEach(line => {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), value = pair.slice(i + 1);
      if (!value || attrs.some(a => /max-age=0\b/i.test(a))) delete this.jar[name];
      else this.jar[name] = value;
    });
    res.text = res.buffer.toString("utf8");
    try { res.json = JSON.parse(res.text); } catch (_) { res.json = null; }
    this.last = res;
    return res;
  }
  get(url, opts) { return this.req("GET", url, undefined, opts); }
  post(url, body = {}, opts) { return this.req("POST", url, body, opts); }
}

const PASSWORD = "correct-horse-1";

// Registers through whichever flow is active: with SMS connected, the code step; without, directly.
async function registerFlow(c, body, { suffix = "", opts } = {}) {
  const first = await c.post("/auth/register" + suffix, body, opts);
  if (first.status !== 200 || !first.json.verify) return first;
  return c.post("/auth/register/verify" + suffix, { phone: body.phone, code: lastCodeFor(body.phone) }, opts);
}

async function newClient(extra = {}, clientOpts = {}) {
  const c = new Client(clientOpts);
  c.phone = extra.phone || freshPhone();
  c.name = extra.fullName || freshName();
  const r = await registerFlow(c, { fullName: c.name, phone: c.phone, password: PASSWORD, consent: true, marketingOptIn: false, ...extra });
  assert.equal(r.status, 200, "register failed: " + r.text);
  return c;
}

// Runs fn with no SMS provider configured, the state the site launches in.
async function withoutSms(fn) {
  const saved = process.env.SMS_API_TOKEN;
  delete process.env.SMS_API_TOKEN;
  try { return await fn(); } finally { process.env.SMS_API_TOKEN = saved; }
}
async function newUnverifiedClient(extra = {}) {
  return withoutSms(() => newClient(extra));
}

async function newAdmin(ip) {
  const c = new Client({ ip });
  const r = await c.post("/admin/login", { username: "testadmin", password: "test-admin-pass-1", remember: true });
  assert.equal(r.status, 200, "admin login failed: " + r.text);
  return c;
}

let slotCursor = 0;
function freshSlot() {
  // Walks 08:00..22:30 on each coming date except Saturday (opened wide by the runner), so no two tests share a slot.
  const dates = [1, 2, 3, 4, 5, 6].map(n => TIME.addDays(TIME.todayYmd(), n)).filter(d => TIME.dowOfYmd(d) !== 6);
  const i = slotCursor++;
  const date = dates[Math.floor(i / 30) % dates.length];
  const minutes = 8 * 60 + (i % 30) * 30;
  assert.ok(i < 30 * dates.length, "ran out of test slots");
  return { date, dayIdx: TIME.dowOfYmd(date), time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}` };
}

async function book(c, slot = freshSlot(), extra = {}) {
  const r = await c.post("/appointments", { ...slot, srvIdx: 0, ...extra });
  assert.equal(r.status, 200, "booking failed: " + r.text);
  return r.json.appointment;
}

const lastCodeFor = phone => {
  const m = [...h.outbox.sms].reverse().find(s => s.to === phone && /קוד/.test(s.message));
  return m ? /\b(\d{6})\b/.exec(m.message)[1] : null;
};

const FORBIDDEN_IN_RESPONSES = /scrypt\$|ucred|"salt"|"hash"|"password"|credHash/;

// --- Auth ---
test("register returns the session cookie with HttpOnly and SameSite=Lax, and no hash", async () => {
  const c = new Client();
  const r = await registerFlow(c, { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true });
  assert.equal(r.status, 200);
  const cookie = [].concat(r.headers["set-cookie"]).join(";");
  assert.match(cookie, /ilay_sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=5184000/);
  assert.doesNotMatch(cookie, /Secure/, "localhost has no Secure flag");
  assert.doesNotMatch(r.text, FORBIDDEN_IN_RESPONSES);
  assert.equal(r.headers["cache-control"], "no-store");
});

test("cookie is Secure on a non-local host", async () => {
  const c = new Client({ origin: "https://shop.example" });
  const r = await registerFlow(c, { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true }, { opts: { headers: { host: "shop.example" } } });
  assert.equal(r.status, 200);
  assert.match([].concat(r.headers["set-cookie"]).join(";"), /Secure/);
});

test("register validates password length, name, phone and consent", async () => {
  const c = new Client();
  const base = { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true };
  assert.equal((await c.post("/auth/register", { ...base, password: "short12" })).status, 400);
  assert.equal((await c.post("/auth/register", { ...base, fullName: "x" })).status, 400);
  assert.equal((await c.post("/auth/register", { ...base, fullName: "visit evil.com now" })).status, 400);
  assert.equal((await c.post("/auth/register", { ...base, phone: "12345" })).status, 400);
  assert.equal((await c.post("/auth/register", { ...base, consent: false })).status, 400);
});

test("duplicate phone gets the same answer as a new one when SMS is on; the same name is fine", async () => {
  const a = await newClient();
  const c = new Client();
  const fresh = await c.post("/auth/register", { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true });
  const taken = await c.post("/auth/register", { fullName: freshName(), phone: a.phone, password: "another-pass-22", consent: true });
  assert.equal(taken.status, fresh.status);
  assert.deepEqual(taken.json, fresh.json, "the answer must not reveal that the number is registered");
  const guess = await c.post("/auth/register/verify", { phone: a.phone, code: "123456" });
  assert.equal(guess.status, 400);
  const login = await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD });
  assert.equal(login.status, 200, "the existing account keeps its password");
  const twin = await newClient({ fullName: a.name });
  assert.equal((await twin.get("/me")).json.user.username, a.name, "two customers can share a name");
});

test("without SMS, a duplicate phone is refused and points to login or reset", async () => {
  const a = await newUnverifiedClient();
  const taken = await withoutSms(() => new Client().post("/auth/register", { fullName: freshName(), phone: a.phone, password: PASSWORD, consent: true }));
  assert.equal(taken.status, 409);
  assert.equal(taken.json.reason, "המספר הזה כבר רשום. אפשר להתחבר או לאפס סיסמה.");
});

test("passwords are stored only as salted scrypt hashes, outside the user record", async () => {
  const a = await newClient();
  const raw = [...h.fake.store.entries()].map(([k, e]) => [k, e.value instanceof Map ? JSON.stringify([...e.value]) : String(e.value)]);
  assert.ok(!raw.some(([, v]) => v.includes(PASSWORD)), "plaintext password in the store");
  const uid = h.fake.run(["HGET", "idx:phone", a.phone]).result;
  const cred = h.fake.run(["GET", `ucred:${uid}`]).result;
  assert.match(cred, /^scrypt\$32768\$8\$3\$/);
  assert.doesNotMatch(h.fake.run(["HGET", "users", uid]).result, /scrypt/);
});

test("session token is stored only as its sha256", async () => {
  const a = await newClient();
  const token = a.jar.ilay_sid;
  assert.ok(![...h.fake.store.keys()].some(k => k.includes(token)));
  const expected = require("crypto").createHash("sha256").update(token).digest("hex");
  assert.ok(h.fake.store.has("sess:" + expected));
});

test("login by phone only, me endpoint, logout revokes on the server", async () => {
  const a = await newClient();
  const c = new Client();
  assert.equal((await c.post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 200);
  const c2 = new Client();
  assert.equal((await c2.post("/auth/login", { ident: a.name, password: PASSWORD })).status, 401, "names are no longer unique, so they cannot identify an account");
  const me = await c.get("/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.user.phone, a.phone);
  assert.doesNotMatch(me.text, FORBIDDEN_IN_RESPONSES);
  assert.equal(me.headers["cache-control"], "no-store");
  const stolen = { ...c.jar };
  assert.equal((await c.post("/auth/logout")).status, 200);
  assert.equal((await c.get("/me")).status, 401);
  const replay = new Client();
  replay.jar = stolen;
  assert.equal((await replay.get("/me")).status, 401, "old token must not work after logout");
});

test("login errors are identical for a wrong password and an unknown account", async () => {
  const a = await newClient();
  const c1 = new Client(), c2 = new Client();
  const wrong = await c1.post("/auth/login", { ident: a.phone, password: "wrong-password" });
  const unknown = await c2.post("/auth/login", { ident: "0529999999", password: "wrong-password" });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.text, unknown.text);
});

test("5 failures lock that identifier from that IP only, so a stranger cannot lock the owner out", async () => {
  const a = await newClient();
  const attacker = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await attacker.post("/auth/login", { ident: a.phone, password: "bad-password" })).status, 401);
  assert.equal((await attacker.post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 429, "the right password is refused while locked");
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 200, "the owner on another IP is unaffected");
  const pairKeys = [...h.fake.store.keys()].filter(k => k.startsWith("fail:login:pair:"));
  assert.ok(pairKeys.length > 0);
  pairKeys.forEach(k => { const e = h.fake.store.get(k); assert.ok(e.expires && e.expires - Date.now() <= 900000 && e.expires > Date.now()); });
});

test("the much higher per-identifier total stops a distributed attack", async () => {
  const a = await newClient();
  const uid = h.fake.run(["HGET", "idx:phone", a.phone]).result;
  const id = require("crypto").createHash("sha256").update(uid).digest("hex").slice(0, 32);
  h.fake.run(["SET", `fail:login:id:${id}`, "100", "EX", "900"]);
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 429);
  h.fake.run(["DEL", `fail:login:id:${id}`]);
});

test("refused attempts from a locked IP do not feed the per-identifier total", async () => {
  const a = await newClient();
  const uid = h.fake.run(["HGET", "idx:phone", a.phone]).result;
  const id = require("crypto").createHash("sha256").update(uid).digest("hex").slice(0, 32);
  const attacker = new Client();
  for (let i = 0; i < 15; i++) await attacker.post("/auth/login", { ident: a.phone, password: "bad-password" });
  assert.equal(h.fake.run(["GET", `fail:login:id:${id}`]).result, "5");
});

test("parallel login guesses cannot pass the limit, even with the right password among them", async () => {
  const a = await newClient();
  const attacker = new Client();
  const guesses = Array.from({ length: 40 }, (_, i) => (i === 30 ? PASSWORD : "wrong-" + i));
  const burst = await Promise.all(guesses.map(g => attacker.post("/auth/login", { ident: a.phone, password: g })));
  assert.equal(burst.filter(r => r.status === 401 || r.status === 200).length, 5, "only 5 reach the password check");
  assert.equal(burst[30].status, 429);
});

test("parallel admin guesses cannot pass the limit, and the owner can still log in from elsewhere", async () => {
  const attacker = new Client();
  const guesses = Array.from({ length: 60 }, (_, i) => (i === 40 ? "test-admin-pass-1" : "wrong-" + i));
  const burst = await Promise.all(guesses.map(g => attacker.post("/admin/login", { username: "testadmin", password: g })));
  assert.equal(burst.filter(r => r.status !== 429).length, 5);
  assert.equal(burst[40].status, 429);
  assert.equal((await new Client().post("/admin/login", { username: "testadmin", password: "test-admin-pass-1" })).status, 200);
});

test("the lock counts failures for unknown accounts the same way (no enumeration)", async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) await c.post("/auth/login", { ident: "0528888888", password: "bad-password" });
  assert.equal((await c.post("/auth/login", { ident: "0528888888", password: "bad-password" })).status, 429);
});

test("login is throttled per IP after 20 failures", async () => {
  const c = new Client();
  for (let i = 0; i < 20; i++) assert.equal((await c.post("/auth/login", { ident: `ident-${i}`, password: "x" })).status, 401);
  assert.equal((await c.post("/auth/login", { ident: "ident-next", password: "x" })).status, 429);
});

test("a successful login clears the failure counter", async () => {
  const a = await newClient();
  const c = new Client();
  for (let i = 0; i < 4; i++) await c.post("/auth/login", { ident: a.phone, password: "bad-password" });
  assert.equal((await c.post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 200);
  for (let i = 0; i < 4; i++) await c.post("/auth/login", { ident: a.phone, password: "bad-password" });
  assert.equal((await c.post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 200);
});

// --- Reset ---
test("reset request answers the same whether or not the account exists", async () => {
  const a = await newClient();
  const known = await new Client().post("/auth/reset/request", { phone: a.phone });
  const unknown = await new Client().post("/auth/reset/request", { phone: "0527777777" });
  const invalid = await new Client().post("/auth/reset/request", { phone: "abc" });
  assert.equal(known.status, 200);
  assert.equal(known.text, unknown.text);
  assert.equal(known.text, invalid.text);
  assert.ok(lastCodeFor(a.phone));
  assert.equal(lastCodeFor("0527777777"), null);
});

test("reset flow: hashed code, new password works, old password and old sessions do not", async () => {
  const a = await newClient();
  await new Client().post("/auth/reset/request", { phone: a.phone });
  const code = lastCodeFor(a.phone);
  const stored = h.fake.run(["GET", `reset:${a.phone}`]).result;
  assert.ok(stored && !stored.includes(code), "code must be hashed in Redis");
  const ttl = h.fake.store.get(`reset:${a.phone}`).expires - Date.now();
  assert.ok(ttl > 0 && ttl <= 600000);
  const r = await new Client().post("/auth/reset/confirm", { phone: a.phone, code, newPassword: "brand-new-pass-2" });
  assert.equal(r.status, 200);
  assert.equal((await a.get("/me")).status, 401, "old session must be revoked");
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 401);
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: "brand-new-pass-2" })).status, 200);
  assert.equal((await new Client().post("/auth/reset/confirm", { phone: a.phone, code, newPassword: "another-pass-3" })).status, 400, "a code works once");
});

test("the reset code is never written to the SMS log", async () => {
  const a = await newClient();
  await new Client().post("/auth/reset/request", { phone: a.phone });
  const code = lastCodeFor(a.phone);
  const admin = await newAdmin();
  const state = await admin.get("/admin/state");
  assert.ok(!state.text.includes(code));
  assert.ok(state.json.state.smsLogs.some(l => l.category === "reset" && l.phone === a.phone && l.noRetry));
});

test("reset code allows limited attempts, then dies even with the right code", async () => {
  const a = await newClient();
  await new Client().post("/auth/reset/request", { phone: a.phone });
  const code = lastCodeFor(a.phone);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await new Client().post("/auth/reset/confirm", { phone: a.phone, code: wrong, newPassword: "brand-new-pass-2" })).status, 400);
  assert.equal((await new Client().post("/auth/reset/confirm", { phone: a.phone, code, newPassword: "brand-new-pass-2" })).status, 400);
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 200);
});

test("reset requests are rate limited per phone without changing the reply", async () => {
  const a = await newClient();
  const before = h.outbox.sms.length;
  let first;
  for (let i = 0; i < 5; i++) {
    const r = await new Client().post("/auth/reset/request", { phone: a.phone });
    if (!first) first = r.text;
    assert.equal(r.text, first);
  }
  assert.equal(h.outbox.sms.length - before, 3, "only 3 per hour reach the phone");
});

test("a manually added customer without a password can claim the account only through the SMS code", async () => {
  const admin = await newAdmin();
  const phone = freshPhone();
  const add = await admin.post("/admin/apply", { users: { upsert: [{ id: "usr_manual1", username: freshName(), phone }], remove: [] } });
  assert.equal(add.status, 200);
  assert.equal((await new Client().post("/auth/login", { ident: phone, password: "" })).status, 401);
  assert.equal((await new Client().post("/auth/login", { ident: phone, password: "anything-at-all" })).status, 401);
  assert.equal((await new Client().post("/auth/register", { fullName: freshName(), phone, password: PASSWORD, consent: true })).status, 200);
  assert.equal((await new Client().post("/auth/login", { ident: phone, password: PASSWORD })).status, 401, "signing up again must not take over the account");
  await new Client().post("/auth/reset/request", { phone });
  assert.equal((await new Client().post("/auth/reset/confirm", { phone, code: lastCodeFor(phone), newPassword: "claimed-pass-1" })).status, 200);
  assert.equal((await new Client().post("/auth/login", { ident: phone, password: "claimed-pass-1" })).status, 200);
});

// --- Booking ---
test("booking takes name, phone, price and duration from the server, not the request", async () => {
  const a = await newClient();
  const slot = freshSlot();
  const r = await a.post("/appointments", { ...slot, srvIdx: 1, price: 1, service: "free", name: "someone else", phone: "0501111111", status: "confirmed", reminderSent: true });
  assert.equal(r.status, 200, r.text);
  const ap = r.json.appointment;
  assert.equal(ap.price, 90);
  assert.equal(ap.service, "תספורת מוגזם • 90 ₪");
  assert.equal(ap.name, a.name);
  assert.equal(ap.phone, a.phone);
  assert.equal(ap.status, "pending");
  assert.equal(ap.reminderSent, false);
});

test("bad booking input is refused: closed day, off-grid, past, bad service, no session", async () => {
  const a = await newClient();
  const slot = freshSlot();
  const saturday = [1, 2, 3, 4, 5, 6, 7].map(n => TIME.addDays(TIME.todayYmd(), n)).find(d => TIME.dowOfYmd(d) === 6);
  assert.equal((await a.post("/appointments", { date: saturday, time: "20:00", srvIdx: 0 })).status, 400, "Saturday is closed");
  assert.equal((await a.post("/appointments", { ...slot, time: "10:17", srvIdx: 0 })).status, 400);
  assert.equal((await a.post("/appointments", { ...slot, time: "03:00", srvIdx: 0 })).status, 400);
  assert.equal((await a.post("/appointments", { ...slot, srvIdx: 99 })).status, 400);
  assert.equal((await a.post("/appointments", { ...slot, date: "not-a-date", srvIdx: 0 })).status, 400);
  assert.equal((await a.post("/appointments", { ...slot, time: "<script>", srvIdx: 0 })).status, 400);
  assert.equal((await new Client().post("/appointments", { ...slot, srvIdx: 0 })).status, 401);
});

test("past times today are refused", async () => {
  const hour = TIME.parts(Date.now()).h;
  const date = TIME.todayYmd();
  const admin = await newAdmin();
  // Open today from 00:00 so a past slot exists on the grid regardless of when this test runs.
  await admin.post("/admin/availability", { dates: { [date]: { open: true, start: "00:00", end: "23:30" } } });
  const a = await newClient();
  if (hour >= 1) assert.equal((await a.post("/appointments", { date, time: "00:00", srvIdx: 0 })).status, 400);
  await admin.post("/admin/availability", { dates: { [date]: null } });
});

test("concurrent double booking: exactly one of 25 succeeds", async () => {
  const clients = await Promise.all(Array.from({ length: 5 }, () => newClient()));
  const slot = freshSlot();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => clients[i % 5].post("/appointments", { ...slot, srvIdx: 0 })));
  const ok = results.filter(r => r.status === 200);
  const conflict = results.filter(r => r.status === 409);
  assert.equal(ok.length, 1, "statuses: " + results.map(r => r.status).join(","));
  assert.equal(conflict.length, 24);
  assert.equal(conflict[0].json.code, "slot_taken");
});

test("cancel frees the slot; a move frees the old slot and takes the new one", async () => {
  const a = await newClient(), b = await newClient();
  const s1 = freshSlot(), s2 = freshSlot(), s3 = freshSlot();
  const ap = await book(a, s1);
  assert.equal((await b.post("/appointments", { ...s1, srvIdx: 0 })).status, 409);
  assert.equal((await a.post(`/appointments/${ap.id}/move`, { ...s2, srvIdx: 2 })).status, 200);
  const moved = (await a.get("/me")).json.appointments.find(x => x.id === ap.id);
  assert.equal(moved.time, s2.time);
  assert.equal(moved.price, 80, "price follows the new service");
  assert.equal(moved.movedCount, 1);
  assert.equal(moved.status, "pending");
  assert.equal((await b.post("/appointments", { ...s2, srvIdx: 0 })).status, 409, "new slot is locked");
  assert.equal((await b.post("/appointments", { ...s1, srvIdx: 0 })).status, 200, "old slot is free");
  const ap3 = await book(a, s3);
  assert.equal((await a.post(`/appointments/${ap3.id}/cancel`)).status, 200);
  assert.equal((await b.post("/appointments", { ...s3, srvIdx: 0 })).status, 200);
});

test("moving onto a slot another client holds fails and keeps the original", async () => {
  const a = await newClient(), b = await newClient();
  const s1 = freshSlot(), s2 = freshSlot();
  const ap = await book(a, s1);
  await book(b, s2);
  assert.equal((await a.post(`/appointments/${ap.id}/move`, { ...s2, srvIdx: 0 })).status, 409);
  const still = (await a.get("/me")).json.appointments.find(x => x.id === ap.id);
  assert.equal(still.time, s1.time);
});

test("a lock left by an interrupted request heals after a minute, a fresh one does not", async () => {
  const a = await newClient();
  const slot = freshSlot();
  // Find the date by booking and reading the appointment.
  const ap = await book(a, slot);
  const stored = JSON.parse(h.fake.run(["HGET", "appts", ap.id]).result);
  await a.post(`/appointments/${ap.id}/cancel`);
  const key = `slot:${stored.date}:${stored.time}`;
  h.fake.run(["SET", key, `ap_ghost|${Date.now()}`]);
  assert.equal((await a.post("/appointments", { ...slot, srvIdx: 0 })).status, 409, "a fresh lock is respected");
  h.fake.run(["SET", key, `ap_ghost|${Date.now() - 120000}`]);
  assert.equal((await a.post("/appointments", { ...slot, srvIdx: 0 })).status, 200, "a stale orphan is taken over");
});

test("a client cannot read or change another client's appointment", async () => {
  const a = await newClient(), b = await newClient();
  const ap = await book(a);
  const mine = (await b.get("/me")).json.appointments;
  assert.ok(!mine.some(x => x.id === ap.id));
  for (const action of ["confirm", "cancel"]) assert.equal((await b.post(`/appointments/${ap.id}/${action}`)).status, 404);
  assert.equal((await b.post(`/appointments/${ap.id}/move`, { ...freshSlot(), srvIdx: 0 })).status, 404);
  const unchanged = (await a.get("/me")).json.appointments.find(x => x.id === ap.id);
  assert.equal(unchanged.status, "pending");
});

test("confirm and cancel work for the owner, and notify the admin", async () => {
  const a = await newClient();
  const ap = await book(a);
  assert.equal((await a.post(`/appointments/${ap.id}/confirm`)).json.appointment.status, "confirmed");
  assert.equal((await a.post(`/appointments/${ap.id}/cancel`)).json.appointment.status, "canceled");
  assert.equal((await a.post(`/appointments/${ap.id}/confirm`)).status, 409);
  const state = (await (await newAdmin()).get("/admin/state")).json.state;
  assert.ok(state.adminNotifications.some(n => n.type === "confirmed" && n.apptId === ap.id));
  assert.ok(state.adminNotifications.some(n => n.type === "canceled" && n.apptId === ap.id));
});

test("client messages reach the admin and appear in the client's own list only", async () => {
  const a = await newClient(), b = await newClient();
  assert.equal((await a.post("/me/message", { text: "אפשר להקדים?" })).status, 200);
  assert.equal((await a.get("/me")).json.messages[0].text, "אפשר להקדים?");
  assert.equal((await b.get("/me")).json.messages.length, 0);
  const state = (await (await newAdmin()).get("/admin/state")).json.state;
  assert.ok(state.smsLogs.some(l => l.status === "received" && l.message === "אפשר להקדים?"));
  assert.ok(state.adminNotifications.some(n => n.type === "client_msg" && n.message.includes("אפשר להקדים?")));
  assert.equal((await new Client().post("/me/message", { text: "x" })).status, 401);
});

test("marketing opt-in can be switched by the client", async () => {
  const a = await newClient();
  assert.equal((await a.post("/me/marketing", { optIn: true })).json.user.marketingOptIn, true);
  assert.equal((await a.get("/me")).json.user.marketingOptIn, true);
  assert.equal((await a.post("/me/marketing", { optIn: "yes" })).status, 400);
  assert.equal((await a.post("/me/marketing", { optIn: false })).json.user.marketingOptIn, false);
});

test("deleting an account removes personal data, frees slots, and keeps only anonymous history", async () => {
  const a = await newClient();
  const slot = freshSlot();
  const ap = await book(a, slot);
  await a.post("/me/message", { text: "מסר פרטי" });
  // An appointment that has already happened.
  const pastId = "ap_pastrow";
  const pastRow = { id: pastId, dayIdx: 1, date: "2026-01-05", dateStr: "05/01", time: "10:00", startsAtMs: Date.now() - 86400000, name: a.name, phone: a.phone, price: 70, service: "x", note: "פרטי", status: "pending" };
  h.fake.run(["HSET", "appts", pastId, JSON.stringify(pastRow)]);
  h.fake.run(["SADD", `phoneappts:${a.phone}`, pastId]);
  const stolen = { ...a.jar };
  assert.equal((await a.post("/me/delete")).status, 200);
  const replay = new Client();
  replay.jar = stolen;
  assert.equal((await replay.get("/me")).status, 401);
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 401);
  const dump = JSON.stringify([...h.fake.store.entries()].map(([k, e]) => [k, e.value instanceof Map ? [...e.value] : e.value instanceof Set ? [...e.value] : e.value]));
  assert.ok(!dump.includes(a.name), "name must be gone from Redis");
  assert.ok(!dump.includes(a.phone), "phone must be gone from Redis");
  assert.ok(!dump.includes("מסר פרטי"));
  assert.equal(h.fake.run(["HGET", "appts", ap.id]).result, null);
  const anon = JSON.parse(h.fake.run(["HGET", "appts", pastId]).result);
  assert.equal(anon.phone, "");
  assert.equal(anon.price, 70);
  const b = await newClient();
  assert.equal((await b.post("/appointments", { ...slot, srvIdx: 0 })).status, 200, "slot freed");
  h.fake.run(["HDEL", "appts", pastId]);
});

// --- Admin access ---
test("every admin endpoint is 401 without an admin session, even with a client session", async () => {
  const anon = new Client();
  const client = await newClient();
  const gets = ["session", "version", "state", "sms/status"];
  const posts = ["apply", "reset", "reminders", "sms/broadcast", "sms/test", "sms/retry", "photos", "portfolio", "users/usr_x/optout"];
  for (const c of [anon, client]) {
    for (const p of gets) assert.equal((await c.get("/admin/" + p)).status, 401, p);
    for (const p of posts) assert.equal((await c.post("/admin/" + p, {})).status, 401, p);
  }
});

test("the page-load probes answer calmly and reveal nothing", async () => {
  const anon = new Client();
  const me = await anon.get("/me?soft=1");
  assert.equal(me.status, 200);
  assert.equal(me.json.user, null);
  const who = await anon.get("/admin/whoami");
  assert.equal(who.status, 200);
  assert.equal(who.json.label, null);
  const admin = await newAdmin();
  assert.equal((await admin.get("/admin/whoami")).json.label, "עילי בן הרוש");
  const c = await newClient();
  assert.equal((await c.get("/me?soft=1")).json.user.phone, c.phone);
});

test("a forged or client cookie does not open admin endpoints", async () => {
  const c = new Client();
  c.jar.ilay_admin = "forged-token-value";
  assert.equal((await c.get("/admin/state")).status, 401);
  const client = await newClient();
  const x = new Client();
  x.jar.ilay_admin = client.jar.ilay_sid;
  assert.equal((await x.get("/admin/state")).status, 401);
});

test("admin login: both accounts, labels only, generic failure, separate cookie", async () => {
  const a = new Client();
  const r = await a.post("/admin/login", { username: "TestAdmin", password: "test-admin-pass-1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.label, "עילי בן הרוש");
  assert.ok(a.jar.ilay_admin);
  assert.match([].concat(r.headers["set-cookie"]).join(";"), /HttpOnly/);
  assert.doesNotMatch([].concat(r.headers["set-cookie"]).join(";"), /Max-Age/, "without remember it is a session cookie");
  const b = new Client();
  assert.equal((await b.post("/admin/login", { username: "testadmin2", password: "test-admin-pass-2", remember: true })).json.label, "AriDev");
  const w1 = await new Client().post("/admin/login", { username: "testadmin", password: "wrong" });
  const w2 = await new Client().post("/admin/login", { username: "nobody", password: "wrong" });
  assert.equal(w1.status, 401);
  assert.equal(w1.text, w2.text);
  assert.ok(!w1.text.includes("test-admin-pass"));
});

test("admin session lasts 12 hours on the server and logout revokes it", async () => {
  const a = await newAdmin();
  const hash = require("crypto").createHash("sha256").update(a.jar.ilay_admin).digest("hex");
  const left = h.fake.store.get("asess:" + hash).expires - Date.now();
  assert.ok(left > 11.9 * 3600 * 1000 && left <= 12 * 3600 * 1000);
  const stolen = { ...a.jar };
  await a.post("/admin/logout");
  const replay = new Client();
  replay.jar = stolen;
  assert.equal((await replay.get("/admin/state")).status, 401);
});

test("admin login locks after 5 failures", async () => {
  const c = new Client();
  for (let i = 0; i < 5; i++) await c.post("/admin/login", { username: "lockme", password: "bad" });
  assert.equal((await c.post("/admin/login", { username: "lockme", password: "bad" })).status, 429);
});

test("admin login fails closed with a clear message when env is missing", async () => {
  const saved = { u: process.env.ADMIN_USERNAME, p: process.env.ADMIN_PASSWORD, u2: process.env.ADMIN2_USERNAME, p2: process.env.ADMIN2_PASSWORD };
  delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN2_USERNAME; delete process.env.ADMIN2_PASSWORD;
  try {
    const r = await new Client().post("/admin/login", { username: "", password: "" });
    assert.equal(r.status, 503);
    assert.match(r.json.reason, /לא הוגדרה/);
  } finally {
    Object.assign(process.env, { ADMIN_USERNAME: saved.u, ADMIN_PASSWORD: saved.p, ADMIN2_USERNAME: saved.u2, ADMIN2_PASSWORD: saved.p2 });
  }
});

test("full admin state contains no hashes or session data", async () => {
  await newClient();
  const r = await (await newAdmin()).get("/admin/state");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, FORBIDDEN_IN_RESPONSES);
  assert.equal(r.headers["cache-control"], "no-store");
  r.json.state.registeredUsers.forEach(u => assert.deepEqual(Object.keys(u).sort(), ["consentAt", "createdAt", "id", "lastActiveAt", "marketingConsentAt", "marketingOptIn", "marketingOptOutAt", "phone", "phoneVerified", "username"]));
});

test("admin user upsert ignores password and consent fields", async () => {
  const admin = await newAdmin();
  const phone = freshPhone();
  const r = await admin.post("/admin/apply", { users: { upsert: [{ id: "usr_manual2", username: freshName(), phone, password: "plaintext-attempt", marketingOptIn: true }], remove: [] } });
  assert.equal(r.status, 200);
  const u = r.json.state.registeredUsers.find(x => x.id === "usr_manual2");
  assert.equal(u.marketingOptIn, false);
  assert.ok(!JSON.stringify([...h.fake.store.get("users").value]).includes("plaintext-attempt"));
});

test("deleting a user as admin revokes that user's sessions", async () => {
  const a = await newClient();
  const admin = await newAdmin();
  const uid = h.fake.run(["HGET", "idx:phone", a.phone]).result;
  assert.equal((await a.get("/me")).status, 200);
  assert.equal((await admin.post("/admin/apply", { users: { upsert: [], remove: [uid] } })).status, 200);
  assert.equal((await a.get("/me")).status, 401);
  assert.equal((await new Client().post("/auth/login", { ident: a.phone, password: PASSWORD })).status, 401);
  const again = new Client();
  assert.equal((await registerFlow(again, { fullName: a.name, phone: a.phone, password: PASSWORD, consent: true })).status, 200, "indexes released");
});

// --- Admin diff ---
test("admin diff does not overwrite a client booking made after its snapshot", async () => {
  const admin = await newAdmin();
  await admin.get("/admin/state");
  const a = await newClient();
  const ap = await book(a);
  // The admin saves a price change without knowing about the new booking.
  const before = (await admin.get("/admin/state")).json.state.services;
  const r = await admin.post("/admin/apply", { services: before });
  assert.ok(r.json.state.appointments.some(x => x.id === ap.id), "client booking survives");
});

test("manual admin appointment takes the slot lock, sends SMS, creates a club entry", async () => {
  const admin = await newAdmin();
  const slot = freshSlot();
  const phone = freshPhone();
  const name = freshName();
  const count = h.outbox.sms.length;
  const r = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_manual1", ...slot, name, phone, price: 70, service: "תספורת קלאסי • 70 ₪", note: "הערה" }], remove: [] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.conflicts, []);
  assert.equal(r.json.sms.ap_manual1.ok, true);
  assert.equal(h.outbox.sms.length, count + 1);
  assert.match(h.outbox.sms[count].message, /נקבע לך תור/);
  assert.ok(r.json.state.registeredUsers.some(u => u.phone === phone));
  const a = await newClient();
  assert.equal((await a.post("/appointments", { ...slot, srvIdx: 0 })).status, 409);
  const dup = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_manual2", ...slot, name, phone, price: 70, service: "x" }], remove: [] } });
  assert.equal(dup.json.conflicts.length, 1);
  assert.ok(!dup.json.state.appointments.some(x => x.id === "ap_manual2"));
});

test("admin move and cancel use server templates, and removal releases the lock", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  const s1 = freshSlot(), s2 = freshSlot(), s3 = freshSlot();
  const ap = await book(a, s1);
  const other = await newClient();
  let count = h.outbox.sms.length;
  const moved = await admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, ...s2 }], remove: [] } });
  assert.deepEqual(moved.json.conflicts, []);
  assert.match(h.outbox.sms[count].message, /הוזז/);
  assert.equal(h.outbox.sms[count].to, a.phone);
  assert.equal((await other.post("/appointments", { ...s1, srvIdx: 0 })).status, 200, "old slot free");
  count = h.outbox.sms.length;
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, status: "canceled" }], remove: [] } });
  assert.match(h.outbox.sms[count].message, /בוטל/);
  assert.equal((await other.post("/appointments", { ...s2, srvIdx: 0 })).status, 200, "canceled slot free");
  const third = await book(a, s3);
  await admin.post("/admin/apply", { appointments: { upsert: [], remove: [third.id] } });
  assert.equal((await a.post("/appointments", { ...s3, srvIdx: 0 })).status, 200, "removed slot free");
});

test("admin status toggle sends no SMS", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  const ap = await book(a);
  const count = h.outbox.sms.length;
  const r = await admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, status: "confirmed" }], remove: [] } });
  assert.equal(r.status, 200);
  assert.equal(h.outbox.sms.length, count);
  assert.equal(r.json.state.appointments.find(x => x.id === ap.id).status, "confirmed");
});

test("admin validation rejects bad services, config and ids", async () => {
  const admin = await newAdmin();
  assert.equal((await admin.post("/admin/apply", { services: [{ name: "x", price: "free" }] })).status, 400);
  assert.equal((await admin.post("/admin/apply", { services: [] })).status, 400);
  assert.equal((await admin.post("/admin/apply", { siteConfig: { slotInterval: 0 } })).status, 400);
  assert.equal((await admin.post("/admin/apply", { siteConfig: { barberPhone: "123" } })).status, 400);
  const r = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "bad id'); alert(1)//", ...freshSlot(), name: "שם", phone: freshPhone() }], remove: [] } });
  assert.equal(r.json.conflicts.length, 1);
  assert.ok(!r.text.includes("alert(1)//\",\"dayIdx"));
  const cfg = await admin.post("/admin/apply", { siteConfig: { title: "<b>כותרת</b>", evilKey: "x", __proto__: { polluted: 1 } } });
  assert.equal(cfg.json.state.siteConfig.title, "bכותרת/b");
  assert.equal(cfg.json.state.siteConfig.evilKey, undefined);
  await admin.post("/admin/apply", { siteConfig: { title: "ILAY BARBERSHOP" } });
});

test("a price edit by the admin reaches the public endpoint and the next booking", async () => {
  const admin = await newAdmin();
  const state = (await admin.get("/admin/state")).json.state;
  const edited = state.services.map((s, i) => (i === 0 ? { ...s, price: 77 } : s));
  assert.equal((await admin.post("/admin/apply", { services: edited })).status, 200);
  const pub = await new Client().get("/public");
  assert.equal(pub.json.services[0].price, 77);
  const a = await newClient();
  assert.equal((await book(a)).price, 77);
  await admin.post("/admin/apply", { services: state.services });
});

test("the version key changes with data and is cheap to poll", async () => {
  const admin = await newAdmin();
  const v1 = (await admin.get("/admin/version")).json.v;
  const a = await newClient();
  await book(a);
  const v2 = (await admin.get("/admin/version")).json.v;
  assert.ok(v2 > v1);
  const before = h.fake.stats.commands;
  await admin.get("/admin/version");
  assert.ok(h.fake.stats.commands - before <= 3, "rate counter + session read + version read");
});

// --- Origin ---
test("cross-origin and origin-less POSTs get 403 on every kind of endpoint", async () => {
  const a = await newClient();
  const admin = await newAdmin();
  for (const [c, p] of [[a, "/me/message"], [a, "/auth/logout"], [new Client(), "/auth/login"], [new Client(), "/auth/register"], [admin, "/admin/apply"], [new Client(), "/admin/login"]]) {
    const clone = new Client({ ip: c.ip, origin: "https://evil.example" });
    clone.jar = { ...c.jar };
    assert.equal((await clone.post(p, {})).status, 403, p);
    assert.equal((await c.post(p, {}, { noOrigin: true })).status, 403, p + " without origin");
  }
  // Substring and lookalike origins must not pass.
  const look = new Client({ origin: h.base + ".evil.example" });
  assert.equal((await look.post("/auth/login", {})).status, 403);
  // A same-site Referer is accepted as the fallback when Origin is absent.
  const ref = await new Client().post("/auth/login", { ident: "x", password: "y" }, { noOrigin: true, headers: { referer: h.base + "/index.html" } });
  assert.equal(ref.status, 401);
  const badRef = await new Client().post("/auth/login", {}, { noOrigin: true, headers: { referer: "https://evil.example/" } });
  assert.equal(badRef.status, 403);
});

test("the preview host is its own allowed origin", async () => {
  const c = new Client({ origin: "https://ilay-git-branch.vercel.app" });
  const r = await c.post("/auth/login", { ident: "x", password: "y" }, { headers: { host: "ilay-git-branch.vercel.app" } });
  assert.equal(r.status, 401);
});

test("non-JSON content type is refused", async () => {
  const c = new Client();
  const res = await new Promise((resolve, reject) => {
    const r = http.request(new URL(h.base + "/api/auth/login"), { method: "POST", headers: { origin: h.base, "content-type": "text/plain", "x-real-ip": c.ip } }, resp => { resp.resume(); resp.on("end", () => resolve(resp.statusCode)); });
    r.on("error", reject);
    r.end("{}");
  });
  assert.equal(res, 415);
});

// --- XSS ---
test("XSS payloads in name and note are stored without markup", async () => {
  const payload = `<img src=x onerror=alert(1)>`;
  const a = await newClient({ fullName: payload });
  const ap = await book(a, freshSlot(), { note: `<script>alert(2)</script>"'\`` });
  for (const raw of [h.fake.run(["HGET", "appts", ap.id]).result, h.fake.run(["HGET", "users", h.fake.run(["HGET", "idx:phone", a.phone]).result]).result]) {
    assert.ok(!/[<>`]/.test(raw), "markup characters in " + raw);
  }
  const state = (await (await newAdmin()).get("/admin/state")).text;
  assert.ok(!state.includes("<img") && !state.includes("<script"));
});

test("an account name cannot smuggle a link into an SMS", async () => {
  const admin = await newAdmin();
  const slot = freshSlot();
  const count = h.outbox.sms.length;
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_smslink", ...slot, name: "לחץ evil.example/x", phone: freshPhone(), price: 1, service: "x" }], remove: [] } });
  assert.ok(!h.outbox.sms[count].message.includes("evil.example"));
});

// --- Test mode ---
test("test mode is refused without an admin session, on every kind of endpoint", async () => {
  const anon = new Client();
  const client = await newClient();
  for (const c of [anon, client]) {
    for (const p of ["/test/check?test=1", "/public?test=1", "/me?test=1", "/admin/state?test=1", "/photo/ph_000000000000000000000000?test=1"]) {
      const r = await c.get(p);
      assert.ok([401, 403].includes(r.status), p + " gave " + r.status);
      assert.equal(r.headers["cache-control"], "no-store");
    }
    assert.equal((await c.post("/auth/register?test=1", { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true })).status, 403);
    assert.equal((await c.post("/appointments?test=1", { ...freshSlot(), srvIdx: 0 })).status, 403);
  }
  assert.equal((await anon.get("/test/check?test=1")).json.code, "test_denied");
});

test("namespaces are isolated, with separate cookies, and the test public response is not cacheable", async () => {
  const admin = await newAdmin();
  const check = await admin.get("/test/check?test=1");
  assert.equal(check.status, 200);
  assert.equal(check.json.test, true);

  const phone = freshPhone();
  const name = freshName();
  const reg = await registerFlow(admin, { fullName: name, phone, password: PASSWORD, consent: true }, { suffix: "?test=1" });
  assert.equal(reg.status, 200, reg.text);
  assert.ok(admin.jar.ilay_sid_test);
  assert.ok(!admin.jar.ilay_sid);
  const uidTest = h.fake.run(["HGET", "test:idx:phone", phone]).result;
  assert.ok(uidTest);
  assert.equal(h.fake.run(["HGET", "idx:phone", phone]).result, null, "must not exist in the real namespace");

  const slot = freshSlot();
  const booked = await admin.post("/appointments?test=1", { ...slot, srvIdx: 0 });
  assert.equal(booked.status, 200, booked.text);
  const id = booked.json.appointment.id;
  assert.ok(h.fake.run(["HGET", "test:appts", id]).result);
  assert.equal(h.fake.run(["HGET", "appts", id]).result, null);

  // The same slot is free in the real calendar, and the real login does not know this user.
  const real = await newClient();
  assert.equal((await real.post("/appointments", { ...slot, srvIdx: 0 })).status, 200);
  assert.equal((await new Client().post("/auth/login", { ident: phone, password: PASSWORD })).status, 401);

  const testState = (await admin.get("/admin/state?test=1")).json.state;
  const realState = (await admin.get("/admin/state")).json.state;
  assert.ok(testState.appointments.some(a => a.id === id));
  assert.ok(!realState.appointments.some(a => a.id === id));
  assert.ok(!testState.registeredUsers.some(u => u.phone === real.phone));

  const testPublic = await admin.get("/public?test=1");
  assert.equal(testPublic.headers["cache-control"], "no-store");
  assert.equal(testPublic.json.test, true);
  const keys = [...h.fake.store.keys()].filter(k => k.startsWith("test:"));
  assert.ok(keys.length > 3);
});

test("only keys under the test prefix change while in test mode", async () => {
  const admin = await newAdmin();
  await registerFlow(admin, { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true }, { suffix: "?test=1" });
  const realBefore = JSON.stringify(h.fake.run(["HGETALL", "appts"]).result);
  const verBefore = h.fake.run(["GET", "ver"]).result;
  await admin.post("/appointments?test=1", { ...freshSlot(), srvIdx: 0 });
  await admin.post("/admin/apply?test=1", { siteConfig: { title: "מצב בדיקות" } });
  assert.equal(JSON.stringify(h.fake.run(["HGETALL", "appts"]).result), realBefore);
  assert.equal(h.fake.run(["GET", "ver"]).result, verBefore);
  assert.equal((await new Client().get("/public")).json.siteConfig.title, "ILAY BARBERSHOP");
  await admin.post("/admin/apply?test=1", { siteConfig: { title: "ILAY BARBERSHOP" } });
});

test("test reset clears only the test namespace, optionally with clients and their sessions", async () => {
  const admin = await newAdmin();
  const real = await newClient();
  const realAppt = await book(real);
  const phone = freshPhone();
  await registerFlow(admin, { fullName: freshName(), phone, password: PASSWORD, consent: true }, { suffix: "?test=1" });
  const slot = freshSlot();
  const t = await admin.post("/appointments?test=1", { ...slot, srvIdx: 0 });
  assert.equal(t.status, 200);

  const r1 = await admin.post("/admin/reset?test=1", { clearClients: false });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.state.appointments.length, 0);
  assert.equal(r1.json.state.smsLogs.length, 0);
  assert.equal(r1.json.state.adminNotifications.length, 0);
  assert.ok(r1.json.state.registeredUsers.some(u => u.phone === phone));
  assert.equal((await admin.get("/me?test=1")).status, 200, "session stays without clearClients");
  assert.equal((await admin.post("/appointments?test=1", { ...slot, srvIdx: 0 })).status, 200, "locks were cleared");

  const r2 = await admin.post("/admin/reset?test=1", { clearClients: true });
  assert.equal(r2.json.state.registeredUsers.length, 0);
  assert.equal((await admin.get("/me?test=1")).status, 401, "test sessions gone");
  assert.ok((await admin.get("/admin/state")).json.state.appointments.some(a => a.id === realAppt.id), "real data untouched");
  assert.equal((await real.get("/me")).status, 200);
});

test("real-namespace reset needs the typed confirmation", async () => {
  const admin = await newAdmin();
  assert.equal((await admin.post("/admin/reset", { clearClients: false })).status, 400);
});

// --- Photos ---
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP"), Buffer.alloc(100, 2)]);
const dataUrl = (type, buf) => `data:image/${type};base64,${buf.toString("base64")}`;

test("photo validation: only real JPEG, PNG and WEBP within the size cap", async () => {
  const admin = await newAdmin();
  const up = img => admin.post("/admin/photos", { image: img });
  assert.equal((await up(dataUrl("png", PNG))).status, 200);
  assert.equal((await up(dataUrl("jpeg", JPEG))).status, 200);
  assert.equal((await up(dataUrl("webp", WEBP))).status, 200);
  assert.equal((await up(dataUrl("png", JPEG))).status, 400, "declared type must match the bytes");
  assert.equal((await up(dataUrl("jpeg", Buffer.from("<script>alert(1)</script>")))).status, 400, "magic bytes");
  assert.equal((await up(`data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`)).status, 400);
  assert.equal((await up(`data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`)).status, 400);
  assert.equal((await up("https://evil.example/x.png")).status, 400);
  assert.equal((await up(12345)).status, 400);
  assert.equal((await up(dataUrl("jpeg", Buffer.concat([JPEG, Buffer.alloc(701 * 1024, 3)])))).status, 400, "too large");
  const atCap = await up(dataUrl("jpeg", Buffer.concat([JPEG, Buffer.alloc(690 * 1024, 3)])));
  assert.equal(atCap.status, 200, "690KB is within the cap");
});

test("photo serving: exact type, nosniff, long cache, and only saved ids", async () => {
  const admin = await newAdmin();
  const id = (await admin.post("/admin/photos", { image: dataUrl("png", PNG) })).json.id;
  const r = await new Client().get("/photo/" + id);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(r.headers["cache-control"], /public, max-age=31536000, immutable/);
  assert.ok(r.buffer.equals(PNG));
  assert.equal((await new Client().get("/photo/ph_ffffffffffffffffffffffff")).status, 404);
  assert.equal((await new Client().get("/photo/..%2f..%2fsecret")).status, 404);
  assert.ok(h.fake.store.get("photo:" + id).expires, "unsaved uploads expire");
});

test("portfolio: empty stays default, saving persists, removal deletes, limits enforced", async () => {
  const admin = await newAdmin();
  assert.deepEqual((await new Client().get("/public")).json.portfolio, [], "defaults are the browser's when nothing is stored");
  const id = (await admin.post("/admin/photos", { image: dataUrl("png", PNG) })).json.id;
  const list = ["def:0", "def:1", "def:2", "def:3", "def:4", id];
  assert.equal((await admin.post("/admin/portfolio", { list })).status, 200);
  assert.equal(h.fake.store.get("photo:" + id).expires, null, "saved photos no longer expire");
  assert.deepEqual((await admin.get("/admin/state")).json.state.portfolio, list);
  assert.equal((await admin.post("/admin/portfolio", { list: ["def:5"] })).status, 400, "the sixth default no longer exists");
  assert.equal((await admin.post("/admin/portfolio", { list: ["javascript:alert(1)"] })).status, 400);
  assert.equal((await admin.post("/admin/portfolio", { list: ["ph_000000000000000000000000"] })).status, 400, "must exist");
  assert.equal((await admin.post("/admin/portfolio", { list: ["def:0", "def:0"] })).status, 400, "no duplicates");
  assert.equal((await admin.post("/admin/portfolio", { list: [] })).status, 400);
  assert.equal((await admin.post("/admin/portfolio", { list: ["def:0"] })).status, 200);
  assert.equal(h.fake.run(["GET", "photo:" + id]).result, null, "removed photo is deleted");
  const many = [];
  for (let i = 0; i < 31; i++) many.push((await admin.post("/admin/photos", { image: dataUrl("png", PNG) })).json.id);
  assert.equal((await admin.post("/admin/portfolio", { list: many })).status, 400, "max 30");
  assert.equal((await admin.post("/admin/portfolio", { list: many.slice(0, 30) })).status, 200);
  await admin.post("/admin/portfolio", { list: ["def:0", "def:1", "def:2", "def:3", "def:4"] });
  h.fake.run(["DEL", "cfg:portfolio"]);
  h.fake.run(["INCR", "ver"]);
});

test("the removed sixth default photo appears nowhere in deployed code", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8");
  const defaults = /const DEFAULT_PORTFOLIO = \[([\s\S]*?)\];/.exec(core)[1].match(/https:/g);
  assert.equal(defaults.length, 5);
  assert.equal(require("../api/_defaults").defaultPhotoCount, 5);
});

// --- Public endpoint ---
test("the public endpoint holds no personal data and is cacheable for a short time", async () => {
  const a = await newClient();
  const ap = await book(a, freshSlot(), { note: "הערה סודית" });
  const r = await new Client().get("/public");
  assert.equal(r.status, 200);
  assert.match(r.headers["cache-control"], /s-maxage=10/);
  assert.match(r.headers["cache-control"], /stale-while-revalidate/);
  assert.equal(r.headers["set-cookie"], undefined, "a cached reply must not set cookies");
  assert.ok(!r.text.includes(a.phone));
  assert.ok(!r.text.includes(a.name));
  assert.ok(!r.text.includes("הערה סודית"));
  assert.ok(!r.text.includes(ap.id));
  assert.ok(!/05\d{8}/.test(r.text), "no phone number of any kind, including the barber's");
  assert.ok(!r.text.includes("smsPackageQuota") && !r.text.includes("reminderHoursBefore"));
  assert.deepEqual(Object.keys(r.json.siteConfig).sort(), ["slotBuffer", "slotInterval", "subtitle", "title"]);
  r.json.busy.forEach(b => assert.deepEqual(Object.keys(b).sort(), ["date", "time"]));
  assert.ok(r.json.busy.some(b => b.time === ap.time && b.date === ap.date));
});

test("the public snapshot costs little when nothing changed", async () => {
  await new Client().get("/public");
  const before = h.fake.stats.commands;
  await new Client().get("/public");
  assert.ok(h.fake.stats.commands - before <= 2);
});

test("canceled appointments leave the busy list", async () => {
  const a = await newClient();
  const slot = freshSlot();
  const ap = await book(a, slot);
  assert.ok((await new Client().get("/public")).json.busy.some(b => b.date === slot.date && b.time === slot.time));
  await a.post(`/appointments/${ap.id}/cancel`);
  assert.ok(!(await new Client().get("/public")).json.busy.some(b => b.date === slot.date && b.time === slot.time));
});

// --- SMS ---
test("public free-text SMS and notify endpoints are gone", async () => {
  const c = new Client();
  assert.equal((await c.post("/send-sms", { to: "0501234567", message: "hi" })).status, 404);
  assert.equal((await c.post("/notify", { title: "x", message: "y" })).status, 404);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "api", "send-sms.js")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "api", "notify.js")), false);
});

test("booking sends the template SMS with a link to the site's own host", async () => {
  const a = await newClient();
  const count = h.outbox.sms.length;
  const ap = await book(a);
  const sms = h.outbox.sms[count];
  assert.equal(sms.to, a.phone);
  assert.equal(sms.sender, "IlayTest");
  assert.match(sms.message, /התור שלך ל-Ilay Barbershop נקבע/);
  assert.ok(sms.message.includes(ap.time));
  assert.ok(sms.message.includes(new URL(h.base).host + "/#personal-area"));
});

test("booking succeeds when the SMS provider fails, and the failure is recorded", async () => {
  const a = await newClient();
  h.outbox.smsFail = true;
  let r;
  try { r = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 }); } finally { h.outbox.smsFail = false; }
  assert.equal(r.status, 200);
  assert.equal(r.json.smsSent, false);
  const state = (await (await newAdmin()).get("/admin/state")).json.state;
  assert.ok(state.smsLogs.some(l => l.apptId === r.json.appointment.id && l.status === "failed"));
  assert.ok(state.adminNotifications.some(n => n.type === "sms_failed" && n.apptId === r.json.appointment.id));
});

test("booking succeeds when SMS is not configured", async () => {
  const saved = process.env.SMS_API_TOKEN;
  delete process.env.SMS_API_TOKEN;
  try {
    const a = await newClient();
    const r = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.json.smsSent, false);
    const st = await (await newAdmin()).get("/admin/sms/status");
    assert.equal(st.json.configured, false);
  } finally { process.env.SMS_API_TOKEN = saved; }
});

test("provider status is admin-only and reveals no secrets", async () => {
  const st = await (await newAdmin()).get("/admin/sms/status");
  assert.deepEqual({ configured: st.json.configured, provider: st.json.provider, sender: st.json.sender }, { configured: true, provider: "TextMe", sender: "IlayTest" });
  assert.ok(!st.text.includes("fake-sms-token"));
  assert.ok(!st.text.includes("fake-sms-user"));
});

test("broadcast goes only to opted-in users, with the opt-out line, and blocks foreign links", async () => {
  const yes = await newClient({ marketingOptIn: true });
  const no = await newClient({ marketingOptIn: false });
  const admin = await newAdmin();
  assert.equal((await admin.post("/admin/sms/broadcast", { message: "מבצע evil.example/x" })).status, 400);
  assert.equal((await admin.post("/admin/sms/broadcast", { message: "מבצע https://evil.example/x" })).status, 400);
  const count = h.outbox.sms.length;
  const r = await admin.post("/admin/sms/broadcast", { message: "אהלן {שם}, מבצע השבוע!" });
  assert.equal(r.status, 200, r.text);
  const sent = h.outbox.sms.slice(count);
  assert.ok(sent.some(s => s.to === yes.phone));
  assert.ok(!sent.some(s => s.to === no.phone));
  const msg = sent.find(s => s.to === yes.phone).message;
  assert.ok(msg.includes(yes.name));
  assert.ok(msg.endsWith(" או השב/י הסר"), "a working way to opt out");
  const own = await admin.post("/admin/sms/broadcast", { message: `בואו לאתר ${h.base}/` });
  assert.equal(own.status, 200, "links to the site itself stay allowed");
});

test("test SMS goes to the seeded owner number, and to the admin-saved one after saving", async () => {
  const admin = await newAdmin();
  const count = h.outbox.sms.length;
  assert.equal((await admin.get("/admin/state")).json.state.siteConfig.barberPhone, "0542858711");
  assert.equal((await admin.post("/admin/sms/test")).json.sent, true);
  assert.equal(h.outbox.sms[count].to, "0542858711");
  await admin.post("/admin/apply", { siteConfig: { barberPhone: "050-1234567" } });
  assert.equal((await admin.get("/admin/state")).json.state.siteConfig.barberPhone, "0501234567");
  await admin.post("/admin/sms/test");
  assert.equal(h.outbox.sms[h.outbox.sms.length - 1].to, "0501234567");
  await admin.post("/admin/apply", { siteConfig: { barberPhone: "0542858711" } });
});

test("SMS retry works for failed messages and is blocked for reset codes", async () => {
  const a = await newClient();
  h.outbox.smsFail = true;
  const ap = (await a.post("/appointments", { ...freshSlot(), srvIdx: 0 })).json.appointment;
  await new Client().post("/auth/reset/request", { phone: a.phone });
  h.outbox.smsFail = false;
  const admin = await newAdmin();
  const logs = (await admin.get("/admin/state")).json.state.smsLogs;
  const failed = logs.find(l => l.apptId === ap.id);
  const r = await admin.post("/admin/sms/retry", { id: failed.id });
  assert.equal(r.json.sent, true);
  assert.equal(r.json.state.smsLogs.find(l => l.id === failed.id).status, "sent");
  const resetLog = logs.find(l => l.category === "reset" && l.phone === a.phone);
  assert.equal((await admin.post("/admin/sms/retry", { id: resetLog.id })).json.sent, false);
});

test("daily per-phone SMS cap stops sending but never blocks a booking", async () => {
  const a = await newClient();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
  const phoneHash = require("crypto").createHash("sha256").update(a.phone).digest("hex").slice(0, 32);
  h.fake.run(["SET", `cap:p:${phoneHash}:${day}`, "15", "EX", "172800"]);
  const count = h.outbox.sms.length;
  const r = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.smsSent, false);
  assert.equal(h.outbox.sms.length, count);
});

test("daily per-IP SMS cap stops client-triggered sending", async () => {
  const ip = freshIp();
  const a = await newClient({}, { ip });
  const ipHash = require("crypto").createHash("sha256").update("ip:" + ip).digest("hex").slice(0, 32);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
  h.fake.run(["SET", `cap:i:${ipHash}:${day}`, "40", "EX", "172800"]);
  const r = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.smsSent, false);
});

test("durable write rate limit returns 429 and lives in Redis", async () => {
  const ip = freshIp();
  const ipHash = require("crypto").createHash("sha256").update("ip:" + ip).digest("hex").slice(0, 32);
  h.fake.run(["SET", `rl:w:${ipHash}`, "300", "EX", "600"]);
  assert.equal((await new Client({ ip }).post("/auth/login", { ident: "x", password: "y" })).status, 429);
});

// --- Reminders ---
test("reminders are idempotent, and force mode reaches everything upcoming once", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  const ap = await book(a);
  const count = h.outbox.sms.length;
  const r1 = await admin.post("/admin/reminders");
  assert.ok(r1.json.sent >= 1);
  const toClient = h.outbox.sms.slice(count).filter(s => s.to === a.phone);
  assert.equal(toClient.length, 1);
  assert.match(toClient[0].message, /תזכורת מ-Ilay Barbershop/);
  assert.equal(r1.json.state.appointments.find(x => x.id === ap.id).reminderSent, true);
  const r2 = await admin.post("/admin/reminders");
  assert.equal(r2.json.sent, 0);
  assert.equal(h.outbox.sms.slice(count).filter(s => s.to === a.phone).length, 1);
});

test("two reminder runs at once still send one message per appointment", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  await book(a);
  const count = h.outbox.sms.length;
  await Promise.all([admin.post("/admin/reminders"), admin.post("/admin/reminders"), admin.post("/admin/reminders")]);
  assert.equal(h.outbox.sms.slice(count).filter(s => s.to === a.phone).length, 1);
});

test("moving an appointment re-arms its reminder", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  const ap = await book(a);
  await admin.post("/admin/reminders");
  await a.post(`/appointments/${ap.id}/move`, { ...freshSlot(), srvIdx: 0 });
  const count = h.outbox.sms.length;
  await admin.post("/admin/reminders");
  assert.equal(h.outbox.sms.slice(count).filter(s => s.to === a.phone).length, 1);
});

test("opportunistic reminders run from a public request at most once per gate period, inside the window only", async () => {
  const admin = await newAdmin();
  await admin.post("/admin/apply", { siteConfig: { reminderHoursBefore: 1 } });
  const a = await newClient();
  await book(a); // More than an hour ahead: outside the window.
  h.fake.run(["DEL", "remgate"]);
  let count = h.outbox.sms.length;
  await new Client().get("/public");
  assert.equal(h.outbox.sms.slice(count).filter(s => s.to === a.phone).length, 0, "outside the window");
  assert.ok(h.fake.store.has("remgate"));
  await admin.post("/admin/apply", { siteConfig: { reminderHoursBefore: 48 } });
  const b = await newClient();
  const dayAhead = await book(b);
  assert.ok(dayAhead);
  count = h.outbox.sms.length;
  await new Client().get("/public");
  assert.equal(h.outbox.sms.slice(count).filter(s => s.to === b.phone).length, 0, "the gate holds");
  h.fake.run(["DEL", "remgate"]);
  await admin.get("/admin/version");
  const inWindow = new Date(new Date().getTime() + 48 * 3600 * 1000) > new Date(dayAhead.startsAtMs);
  assert.equal(h.outbox.sms.slice(count).filter(s => s.to === b.phone).length, inWindow ? 1 : 0, "admin polling triggers it");
  await admin.post("/admin/apply", { siteConfig: { reminderHoursBefore: 3 } });
});

test("old appointments are purged by the daily maintenance", async () => {
  const id = "ap_ancient";
  h.fake.run(["HSET", "appts", id, JSON.stringify({ id, dayIdx: 0, time: "10:00", status: "pending", startsAtMs: Date.now() - 200 * 86400000, phone: "0520000000" })]);
  h.fake.run(["DEL", "remgate"]);
  h.fake.run(["DEL", "maint"]);
  await new Client().get("/public");
  assert.equal(h.fake.run(["HGET", "appts", id]).result, null);
});

// --- Notifications ---
test("ntfy is silent without NTFY_TOPIC", async () => {
  const a = await newClient();
  const before = h.outbox.ntfy.length;
  await book(a);
  assert.equal(h.outbox.ntfy.length, before, "no default public topic");
});

test("notifications: read flag persists and only the read flag can change", async () => {
  const a = await newClient();
  await book(a);
  const admin = await newAdmin();
  const n = (await admin.get("/admin/state")).json.state.adminNotifications[0];
  const r = await admin.post("/admin/apply", { notifications: { upsert: [{ id: n.id, read: true, message: "hacked", title: "hacked" }], remove: [] } });
  const after = r.json.state.adminNotifications.find(x => x.id === n.id);
  assert.equal(after.read, true);
  assert.equal(after.message, n.message);
});

test("logs from the browser: only WhatsApp records are accepted", async () => {
  const admin = await newAdmin();
  const fakeSms = { id: "sms_forged", phone: "0501111111", name: "x", message: "forged", channel: "sms", status: "sent" };
  const wa = { id: "wa_1", phone: "0501111111", name: "לקוח", message: "<b>שלום</b>", channel: "whatsapp", apptId: null };
  const r = await admin.post("/admin/apply", { logs: { upsert: [fakeSms, wa], remove: [] } });
  assert.ok(!r.json.state.smsLogs.some(l => l.message === "forged"));
  const log = r.json.state.smsLogs.find(l => l.channel === "whatsapp");
  assert.equal(log.message, "bשלום/b");
});

// --- Infrastructure ---
test("routing: 404, 405, query-style rewrite target, and private paths stay hidden", async () => {
  const c = new Client();
  assert.equal((await c.get("/nope")).status, 404);
  assert.equal((await c.get("/auth/login")).status, 405);
  const viaRouter = await c.req("GET", "/router?path=public");
  assert.equal(viaRouter.status, 200, "Vercel may pass the captured path as a query value");
  assert.ok(viaRouter.json.services);
  const nested = await c.req("GET", "/router?path=admin/state");
  assert.equal(nested.status, 401);
});

test("the Redis client falls back to the UPSTASH_ variable names", async () => {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = url; process.env.UPSTASH_REDIS_REST_TOKEN = token;
  try {
    assert.equal((await new Client().get("/public")).status, 200);
  } finally {
    Object.assign(process.env, { KV_REST_API_URL: url, KV_REST_API_TOKEN: token });
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});

test("a database outage gives a clean 503 without details", async () => {
  const saved = process.env.KV_REST_API_URL;
  process.env.KV_REST_API_URL = "http://127.0.0.1:1";
  try {
    const r = await new Client().get("/public");
    assert.equal(r.status, 503);
    assert.ok(!r.text.includes("127.0.0.1"));
    assert.equal(r.headers["cache-control"], "no-store");
  } finally {
    process.env.KV_REST_API_URL = saved;
    h.outbox.blocked = h.outbox.blocked.filter(u => u !== "http://127.0.0.1:1"); // This test's own dead address.
  }
});

test("vercel config: one rewrite, CSP limited to self, no broker hosts, tests not deployed", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  assert.deepEqual(cfg.rewrites, [{ source: "/api/:path*", destination: "/api/router" }]);
  const csp = cfg.headers[0].headers.find(x => x.key === "Content-Security-Policy").value;
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /wss:|emqx|hivemq|mosquitto/);
  const fns = fs.readdirSync(path.join(__dirname, "..", "api")).filter(f => !f.startsWith("_"));
  assert.deepEqual(fns, ["router.js"], "exactly one deployed function");
  assert.match(fs.readFileSync(path.join(__dirname, "..", ".vercelignore"), "utf8"), /^tests\/$/m);
});

test("static files carry the security headers and the harness hides private paths", async () => {
  const get = p => new Promise((resolve, reject) => http.get(h.base + p, res => { res.resume(); res.on("end", () => resolve(res)); }).on("error", reject));
  const index = await get("/index.html");
  assert.equal(index.statusCode, 200);
  assert.match(index.headers["content-security-policy"], /connect-src 'self'/);
  assert.equal(index.headers["x-frame-options"], "DENY");
  assert.equal((await get("/api/_auth.js")).statusCode, 404);
});

// --- Review findings ---
test("H1: with SMS connected, no account exists until the phone proves itself", async () => {
  const c = new Client();
  const phone = freshPhone();
  const body = { fullName: freshName(), phone, password: PASSWORD, consent: true, marketingOptIn: true };
  const first = await c.post("/auth/register", body);
  assert.equal(first.status, 200);
  assert.equal(first.json.verify, true);
  assert.equal(first.json.user, undefined);
  assert.equal(c.jar.ilay_sid, undefined, "no session yet");
  assert.equal(h.fake.run(["HGET", "idx:phone", phone]).result, null, "no account yet");
  const code = lastCodeFor(phone);
  const pending = h.fake.run(["GET", `regpending:${phone}`]).result;
  assert.ok(pending && !pending.includes(code) && !pending.includes(PASSWORD), "code and password are hashed");
  const ttl = h.fake.store.get(`regpending:${phone}`).expires - Date.now();
  assert.ok(ttl > 0 && ttl <= 600000);
  const wrong = code === "000000" ? "000001" : "000000";
  assert.equal((await c.post("/auth/register/verify", { phone, code: wrong })).status, 400);
  const done = await c.post("/auth/register/verify", { phone, code });
  assert.equal(done.status, 200);
  assert.ok(c.jar.ilay_sid);
  const uid = h.fake.run(["HGET", "idx:phone", phone]).result;
  assert.equal(JSON.parse(h.fake.run(["HGET", "users", uid]).result).phoneVerified, true);
  assert.equal(h.fake.run(["GET", `regpending:${phone}`]).result, null);
});

test("H1: registration codes have limited attempts and are rate limited", async () => {
  const phone = freshPhone();
  const c = new Client();
  const body = { fullName: freshName(), phone, password: PASSWORD, consent: true };
  await c.post("/auth/register", body);
  const code = lastCodeFor(phone);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await c.post("/auth/register/verify", { phone, code: wrong })).status, 400);
  assert.equal((await c.post("/auth/register/verify", { phone, code })).status, 400, "the code is dead after 5 tries");
  assert.equal(h.fake.run(["HGET", "idx:phone", phone]).result, null);
  const phone2 = freshPhone();
  const body2 = { ...body, phone: phone2 };
  for (let i = 0; i < 3; i++) assert.equal((await new Client().post("/auth/register", body2)).status, 200);
  assert.equal((await new Client().post("/auth/register", body2)).status, 429, "3 codes per phone per hour");
});

test("H1: registration reports a clear error when the code cannot be sent", async () => {
  h.outbox.smsFail = true;
  try {
    const phone = freshPhone();
    const r = await new Client().post("/auth/register", { fullName: freshName(), phone, password: PASSWORD, consent: true });
    assert.equal(r.status, 502);
    assert.equal(h.fake.run(["GET", `regpending:${phone}`]).result, null);
  } finally { h.outbox.smsFail = false; }
});

test("H1: without SMS, registration and booking work, unverified, and no code is sent", async () => {
  const count = h.outbox.sms.length;
  const a = await newUnverifiedClient();
  const uid = h.fake.run(["HGET", "idx:phone", a.phone]).result;
  assert.equal(JSON.parse(h.fake.run(["HGET", "users", uid]).result).phoneVerified, false);
  await withoutSms(() => book(a));
  assert.equal((await a.get("/me")).json.appointments.length, 1);
  assert.equal(h.outbox.sms.length, count);
});

test("H1: an unverified account cannot reach the barber's appointment for its phone", async () => {
  const attacker = await newUnverifiedClient({ marketingOptIn: true });
  const own = await book(attacker);
  const admin = await newAdmin();
  const id = "ap_victim_" + attacker.phone;
  const slot = freshSlot();
  const added = await admin.post("/admin/apply", { appointments: { upsert: [{ id, ...slot, name: "לקוח אמיתי", phone: attacker.phone, price: 70, service: "x", adminNote: "הערה פרטית" }], remove: [] } });
  assert.deepEqual(added.json.conflicts, []);
  const seen = (await attacker.get("/me")).json.appointments.map(a => a.id);
  assert.deepEqual(seen, [own.id], "only what it booked itself");
  for (const action of ["confirm", "cancel"]) assert.equal((await attacker.post(`/appointments/${id}/${action}`)).status, 404);
  assert.equal((await attacker.post(`/appointments/${id}/move`, { ...freshSlot(), srvIdx: 0 })).status, 404);
  assert.equal(JSON.parse(h.fake.run(["HGET", "appts", id]).result).status, "pending");

  // Unverified accounts never get marketing, even when opted in.
  const before = h.outbox.sms.length;
  await admin.post("/admin/sms/broadcast", { message: "מבצע השבוע" });
  assert.ok(!h.outbox.sms.slice(before).some(s => s.to === attacker.phone));

  // The real owner proves the phone by reset: attacker's session dies, the appointment is theirs, consent is not inherited.
  await new Client().post("/auth/reset/request", { phone: attacker.phone });
  assert.equal((await new Client().post("/auth/reset/confirm", { phone: attacker.phone, code: lastCodeFor(attacker.phone), newPassword: "the-real-owner-1" })).status, 200);
  assert.equal((await attacker.get("/me")).status, 401);
  const owner = new Client();
  await owner.post("/auth/login", { ident: attacker.phone, password: "the-real-owner-1" });
  const me = await owner.get("/me");
  assert.ok(me.json.appointments.some(a => a.id === id), "a proven phone sees appointments by phone");
  assert.equal(me.json.user.marketingOptIn, false);
  const after = (await admin.get("/admin/state")).json.state.registeredUsers.find(u => u.phone === attacker.phone);
  assert.equal(after.phoneVerified, true);
});

test("H1: bookings from an unverified account send no SMS even after a provider is connected", async () => {
  const a = await newUnverifiedClient();
  const count = h.outbox.sms.length;
  const r = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.json.smsSent, false);
  await (await newAdmin()).post("/admin/reminders");
  assert.ok(!h.outbox.sms.slice(count).some(s => s.to === a.phone));
});

test("H2: an account or phone holds at most 2 upcoming appointments", async () => {
  const a = await newClient();
  await book(a);
  const second = await book(a);
  const third = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 });
  assert.equal(third.status, 409);
  assert.equal(third.json.code, "too_many_active");
  assert.match(third.json.reason, /עד 2 תורים/);
  const slotUsed = freshSlot();
  assert.equal((await a.post("/appointments", { ...slotUsed, srvIdx: 0 })).status, 409);
  await a.post(`/appointments/${second.id}/cancel`);
  assert.equal((await a.post("/appointments", { ...slotUsed, srvIdx: 0 })).status, 200, "the refused slot was released, and canceling makes room");

  const b = await newClient();
  await (await newAdmin()).post("/admin/apply", { appointments: { upsert: [{ id: "ap_cap_" + b.phone, ...freshSlot(), name: "ידני", phone: b.phone, price: 1, service: "x" }], remove: [] } });
  await book(b);
  assert.equal((await b.post("/appointments", { ...freshSlot(), srvIdx: 0 })).json.code, "too_many_active", "the barber's booking for that phone counts");
});

test("H2: parallel bookings cannot pass the cap", async () => {
  const a = await newClient();
  const results = await Promise.all(Array.from({ length: 6 }, () => a.post("/appointments", { ...freshSlot(), srvIdx: 0 })));
  assert.ok(results.filter(r => r.status === 200).length <= 2);
  const active = (await a.get("/me")).json.appointments.filter(x => x.status !== "canceled");
  assert.ok(active.length <= 2);
  const free = freshSlot();
  const c = await newClient();
  assert.equal((await c.post("/appointments", { ...free, srvIdx: 0 })).status, 200, "refused requests left no lock behind");
});

test("H2: per-IP caps on accounts and bookings, and a site-wide daily cap", async () => {
  const ip = freshIp();
  const ipHash = require("crypto").createHash("sha256").update("ip:" + ip).digest("hex").slice(0, 32);
  h.fake.run(["SET", `rl:acctip:${ipHash}`, "20", "EX", "86400"]);
  const blocked = await new Client({ ip }).post("/auth/register", { fullName: freshName(), phone: freshPhone(), password: PASSWORD, consent: true });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.reason, /יותר מדי חשבונות/);

  const a = await newClient();
  const aHash = require("crypto").createHash("sha256").update("ip:" + a.ip).digest("hex").slice(0, 32);
  h.fake.run(["SET", `rl:bookip:${aHash}`, "15", "EX", "86400"]);
  const slot = freshSlot();
  const r = await a.post("/appointments", { ...slot, srvIdx: 0 });
  assert.equal(r.status, 429);
  assert.match(r.json.reason, /יותר מדי תורים/);

  const b = await newClient();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
  const saved = h.fake.run(["GET", `rl:bookall:${day}`]).result;
  h.fake.run(["SET", `rl:bookall:${day}`, "200", "EX", "172800"]);
  const g = await b.post("/appointments", { ...slot, srvIdx: 0 });
  assert.equal(g.status, 429);
  assert.match(g.json.reason, /אי אפשר לקבוע עוד תורים/);
  h.fake.run(["SET", `rl:bookall:${day}`, saved || "0", "EX", "172800"]);
  assert.equal((await b.post("/appointments", { ...slot, srvIdx: 0 })).status, 200, "refused bookings released the slot");
});

test("4: the site-wide daily SMS cap stops all texts, reminders included, and tells the admin once", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
  const key = `cap:g:${day}`;
  const saved = h.fake.run(["GET", key]).result;
  h.fake.run(["SET", key, "500", "EX", "172800"]);
  try {
    const count = h.outbox.sms.length;
    const r = await a.post("/appointments", { ...freshSlot(), srvIdx: 0 });
    assert.equal(r.status, 200, "the booking still succeeds");
    assert.equal(r.json.smsSent, false);
    await book(a);
    assert.equal((await admin.post("/admin/reminders")).status, 200);
    assert.equal(h.outbox.sms.length, count, "nothing goes out, reminders included");
    const notes = (await admin.get("/admin/state")).json.state.adminNotifications.filter(n => n.type === "sms_cap");
    assert.equal(notes.length, 1, "one notice, not one per message");
  } finally {
    h.fake.run(["SET", key, saved || "0", "EX", "172800"]);
    h.fake.run(["DEL", "notifs"]);
  }
});

test("4: codes have their own budget, so requesting codes cannot suppress booking texts", async () => {
  const a = await newClient();
  const hash = require("crypto").createHash("sha256").update(a.phone).digest("hex").slice(0, 32);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
  h.fake.run(["SET", `codecap:p:${hash}:${day}`, "6", "EX", "172800"]);
  let count = h.outbox.sms.length;
  await new Client().post("/auth/reset/request", { phone: a.phone });
  assert.equal(h.outbox.sms.length, count, "the code budget is used up");
  count = h.outbox.sms.length;
  assert.equal((await a.post("/appointments", { ...freshSlot(), srvIdx: 0 })).json.smsSent, true, "the booking text still goes out");

  const b = await newClient();
  const hashB = require("crypto").createHash("sha256").update(b.phone).digest("hex").slice(0, 32);
  h.fake.run(["SET", `cap:p:${hashB}:${day}`, "15", "EX", "172800"]);
  await new Client().post("/auth/reset/request", { phone: b.phone });
  assert.ok(lastCodeFor(b.phone), "and a full booking budget does not block a code");
});

test("6: unknown query values on GET are refused before touching Redis", async () => {
  const before = h.fake.stats.commands;
  for (const p of ["/public?x=random", "/public?test=0", "/public?soft=1", "/public?path=other", "/photo/ph_000000000000000000000000?v=2", "/me?foo=1", "/admin/state?a=b"]) {
    const r = await new Client().get(p);
    assert.equal(r.status, 400, p);
    assert.equal(r.headers["cache-control"], "no-store");
  }
  assert.equal(h.fake.stats.commands, before, "no Redis commands");
});

test("6: uncached GETs are rate limited per IP", async () => {
  const ip = freshIp();
  const ipHash = require("crypto").createHash("sha256").update("ip:" + ip).digest("hex").slice(0, 32);
  h.fake.run(["SET", `rl:g:${ipHash}`, "120", "EX", "60"]);
  const r = await new Client({ ip }).get("/public");
  assert.equal(r.status, 429);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal((await new Client().get("/public")).status, 200);
});

test("7: the barber's note never reaches the client; the client's own note does", async () => {
  const a = await newClient();
  const ap = await book(a, freshSlot(), { note: "הערה שלי" });
  const admin = await newAdmin();
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, adminNote: "לקוח בעייתי" }], remove: [] } });
  const manualId = "ap_note_" + a.phone;
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: manualId, ...freshSlot(), name: a.name, phone: a.phone, price: 1, service: "x", adminNote: "הערה ידנית" }], remove: [] } });
  const me = await a.get("/me");
  assert.ok(!me.text.includes("לקוח בעייתי") && !me.text.includes("הערה ידנית") && !me.text.includes("adminNote"));
  assert.equal(me.json.appointments.find(x => x.id === ap.id).note, "הערה שלי");
  const stored = (await admin.get("/admin/state")).json.state.appointments;
  assert.equal(stored.find(x => x.id === ap.id).adminNote, "לקוח בעייתי");
  assert.equal(stored.find(x => x.id === ap.id).note, "הערה שלי");
  assert.equal(stored.find(x => x.id === manualId).adminNote, "הערה ידנית");
  // An older page sending the field as "note" still cannot expose it.
  const legacyId = "ap_legacy_" + a.phone;
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: legacyId, ...freshSlot(), name: a.name, phone: a.phone, price: 1, service: "x", note: "ישן" }], remove: [] } });
  assert.ok(!(await a.get("/me")).text.includes("ישן"));
});

test("9: an expired admin session in test mode gets 401, not 403", async () => {
  const admin = await newAdmin();
  assert.equal((await admin.get("/admin/version?test=1")).status, 200);
  await admin.post("/admin/logout");
  assert.equal((await admin.get("/admin/version?test=1")).status, 401);
  assert.equal((await admin.get("/admin/state?test=1")).status, 401);
  assert.equal((await new Client().post("/admin/apply?test=1", {})).status, 401);
  assert.equal((await new Client().get("/public?test=1")).status, 403, "non-admin routes keep the test-mode refusal");
});

test("10: deleting an account scrubs barber-written notifications too", async () => {
  const a = await newClient();
  const admin = await newAdmin();
  const ap = await book(a);
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, ...freshSlot() }], remove: [] } });
  await admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, status: "canceled" }], remove: [] } });
  const mentions = async () => (await admin.get("/admin/state")).json.state.adminNotifications.filter(n => (n.message + n.title).includes(a.name));
  assert.ok((await mentions()).length >= 2);
  assert.equal((await a.post("/me/delete")).status, 200);
  assert.deepEqual(await mentions(), []);
});

test("10: an admin removing a user also scrubs their notifications", async () => {
  const a = await newClient();
  const admin = await newAdmin();
  await book(a);
  const uid = h.fake.run(["HGET", "idx:phone", a.phone]).result;
  await admin.post("/admin/apply", { users: { upsert: [], remove: [uid] } });
  const notes = (await admin.get("/admin/state")).json.state.adminNotifications;
  assert.ok(!notes.some(n => (n.message + n.title).includes(a.name) || n.message.includes(a.phone)));
});

test("11: a stale write cannot restore a canceled appointment", async () => {
  const S = require("../api/_appts");
  const a = await newClient();
  const ap = await book(a);
  const ctx = { ns: "" };
  let runs = 0;
  const result = await S.mutateAppt(ctx, ap.id, async (next, prev) => {
    runs++;
    // A cancel lands between this writer's read and its write.
    if (runs === 1) assert.equal((await a.post(`/appointments/${ap.id}/cancel`)).status, 200);
    if (prev.status === "canceled") return false;
    next.reminderSent = true;
    return undefined;
  });
  assert.equal(runs, 2, "the stale attempt was rejected and re-read");
  assert.equal(result.changed, false);
  const stored = JSON.parse(h.fake.run(["HGET", "appts", ap.id]).result);
  assert.equal(stored.status, "canceled");
  assert.equal(stored.reminderSent, false);
});

test("11: racing confirm, cancel and reminders leave a canceled appointment canceled, with its slot free", async () => {
  const admin = await newAdmin();
  for (let round = 0; round < 3; round++) {
    const a = await newClient();
    const slot = freshSlot();
    const ap = await book(a, slot);
    const [, cancel] = await Promise.all([
      a.post(`/appointments/${ap.id}/confirm`),
      a.post(`/appointments/${ap.id}/cancel`),
      admin.post("/admin/reminders")
    ]);
    assert.equal(cancel.status, 200);
    assert.equal(JSON.parse(h.fake.run(["HGET", "appts", ap.id]).result).status, "canceled");
    assert.equal((await (await newClient()).post("/appointments", { ...slot, srvIdx: 0 })).status, 200);
  }
});

test("12: every rate counter is created with a TTL, atomically through Lua", async () => {
  const before = h.fake.stats.byName.EVAL || 0;
  await new Client().post("/auth/login", { ident: "x", password: "y" });
  assert.ok((h.fake.stats.byName.EVAL || 0) > before);
  const noTtl = [...h.fake.store.entries()].filter(([k, e]) => /^(test:)?(rl|fail|cap|codecap):/.test(k) && !e.expires).map(([k]) => k);
  assert.deepEqual(noTtl, []);
});

test("13: the SMS total survives log trimming and counts every sent message", async () => {
  const admin = await newAdmin();
  const a = await newClient();
  const stats = async () => (await admin.get("/admin/state")).json.state.smsStats;
  const before = await stats();
  await book(a);
  const after = await stats();
  assert.ok(after.partsTotal > before.partsTotal);
  assert.equal(after.delivered, before.delivered + 1);
  assert.ok(after.parts_booking > (before.parts_booking || 0));
  h.fake.run(["DEL", "smslogs"]);
  const trimmed = await admin.get("/admin/state");
  assert.equal(trimmed.json.state.smsLogs.length, 0);
  assert.equal(trimmed.json.state.smsStats.partsTotal, after.partsTotal);

  h.outbox.smsFail = true;
  const b = await newUnverifiedClient().catch(() => null);
  assert.ok(b);
  h.outbox.smsFail = false;
  const c = await newClient();
  h.outbox.smsFail = true;
  const failedAppt = (await c.post("/appointments", { ...freshSlot(), srvIdx: 0 })).json.appointment;
  h.outbox.smsFail = false;
  const mid = await stats();
  assert.equal(mid.failed, (after.failed || 0) + 1);
  const log = (await admin.get("/admin/state")).json.state.smsLogs.find(l => l.apptId === failedAppt.id);
  await admin.post("/admin/sms/retry", { id: log.id });
  const end = await stats();
  assert.equal(end.failed, mid.failed - 1);
  assert.ok(end.partsTotal > mid.partsTotal);
});

// --- Marketing compliance (Communications Law 30A) ---
const { tokenFor } = require("../api/_optout");
const uidOf = phone => h.fake.run(["HGET", "idx:phone", phone]).result;
const storedUser = phone => JSON.parse(h.fake.run(["HGET", "users", uidOf(phone)]).result);
const redisDump = () => JSON.stringify([...h.fake.store.entries()].map(([k, e]) => [k, e.value instanceof Map ? [...e.value] : e.value instanceof Set ? [...e.value] : e.value]));
const freshBroadcastBudget = () => h.fake.run(["DEL", "rl:broadcast:all"]);
function rawGet(pathname) {
  return new Promise((resolve, reject) => http.get(h.base + pathname, res => {
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
  }).on("error", reject));
}

test("broadcast format: advertising prefix first, no-login link and reply option last, no phone in the link", async () => {
  freshBroadcastBudget();
  const c = await newClient({ marketingOptIn: true });
  const admin = await newAdmin();
  const count = h.outbox.sms.length;
  assert.equal((await admin.post("/admin/sms/broadcast", { message: "אהלן {שם}, מבצע השבוע!" })).status, 200);
  const msg = h.outbox.sms.slice(count).find(s => s.to === c.phone).message;
  const lines = msg.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "פרסומת: Ilay Barbershop");
  assert.ok(lines[1].includes(c.name));
  const m = /^להסרה: https:\/\/([^/]+)\/optout\.html\?t=([A-Za-z0-9_-]{16}) או השב\/י הסר$/.exec(lines[2]);
  assert.ok(m, lines[2]);
  assert.equal(m[1], new URL(h.base).host);
  assert.equal(m[2], tokenFor("", c.phone));
  assert.ok(!m[2].includes(c.phone));
  assert.notEqual(tokenFor("", c.phone), tokenFor("", freshPhone()), "per phone");
  assert.notEqual(tokenFor("", c.phone), tokenFor("test:", c.phone).slice(1), "per namespace");
});

test("a broadcast fills the 600 character limit with the opt-out text included, and a longer one is refused before sending", async () => {
  freshBroadcastBudget();
  const c = await newClient({ marketingOptIn: true });
  const admin = await newAdmin();
  const overhead = ("פרסומת: Ilay Barbershop\n" + "\nלהסרה: https://" + new URL(h.base).host + "/optout.html?t=" + tokenFor("", c.phone) + " או השב/י הסר").length;
  const count = h.outbox.sms.length;
  const tooLong = await admin.post("/admin/sms/broadcast", { message: "א".repeat(600 - overhead + 1) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.reason, /ארוכה מדי ב-1 תווים/);
  assert.equal(h.outbox.sms.length, count, "nothing left");
  const fits = await admin.post("/admin/sms/broadcast", { message: "א".repeat(600 - overhead) });
  assert.equal(fits.status, 200, fits.text);
  const sent = h.outbox.sms.slice(count).find(s => s.to === c.phone);
  assert.ok(sent, "delivered");
  assert.equal(sent.message.length, 600);
  // A long name in {שם} counts too.
  const longName = await admin.post("/admin/sms/broadcast", { message: "{שם}".repeat(120) });
  assert.equal(longName.status, 400);
});

test("opt-out link: opening the page or GET changes nothing, POST removes without login, the account stays", async () => {
  const c = await newClient({ marketingOptIn: true });
  const t = tokenFor("", c.phone);
  const page = await rawGet("/optout.html?t=" + t);
  assert.equal(page.status, 200);
  assert.match(page.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal(page.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal((await new Client().get("/optout")).status, 405);
  assert.equal((await new Client().get("/optout?t=" + t)).status, 405);
  assert.equal(storedUser(c.phone).marketingOptIn, true, "GET must not remove");
  assert.ok(!storedUser(c.phone).marketingOptOutAt);

  const before = Date.now();
  const r = await new Client().post("/optout", { t });
  assert.equal(r.status, 200);
  const u = storedUser(c.phone);
  assert.equal(u.marketingOptIn, false);
  assert.ok(u.marketingOptOutAt >= before);
  assert.equal((await c.get("/me")).status, 200, "the account and its session stay");
  freshBroadcastBudget();
  const admin = await newAdmin();
  const count = h.outbox.sms.length;
  await admin.post("/admin/sms/broadcast", { message: "מבצע" });
  assert.ok(!h.outbox.sms.slice(count).some(s => s.to === c.phone), "no more marketing");
  // Repeating keeps the first removal time.
  await new Client().post("/optout", { t });
  assert.equal(storedUser(c.phone).marketingOptOutAt, u.marketingOptOutAt);
});

test("opt-out link: invalid tokens get the same answer as valid ones and change nothing", async () => {
  const c = await newClient({ marketingOptIn: true });
  const other = await newClient({ marketingOptIn: true });
  const t = tokenFor("", c.phone);
  const flipped = (t[0] === "A" ? "B" : "A") + t.slice(1);
  const valid = await new Client().post("/optout", { t });
  for (const bad of [flipped, "", "short", "T" + t, t + "x", other.phone, 12345, null, { $ne: 1 }]) {
    const r = await new Client().post("/optout", { t: bad });
    assert.equal(r.status, valid.status, String(bad));
    assert.equal(r.text, valid.text, String(bad));
  }
  assert.equal(storedUser(other.phone).marketingOptIn, true);
  assert.equal(storedUser(c.phone).marketingOptIn, false);
});

test("opt-out link: same-origin only, rate limited, and a test-mode token touches only test accounts", async () => {
  const c = await newClient({ marketingOptIn: true });
  const t = tokenFor("", c.phone);
  assert.equal((await new Client({ origin: "https://evil.example" }).post("/optout", { t })).status, 403);
  assert.equal((await new Client().post("/optout", { t }, { noOrigin: true })).status, 403);
  assert.equal((await new Client().post("/optout", { t: tokenFor("test:", c.phone) })).status, 200);
  assert.equal(storedUser(c.phone).marketingOptIn, true);
  const flood = new Client();
  let last;
  for (let i = 0; i < 31; i++) last = await flood.post("/optout", { t: "nothing-valid-00" });
  assert.equal(last.status, 429);
  assert.equal((await flood.post("/optout", { t })).status, 429);
  assert.equal(storedUser(c.phone).marketingOptIn, true);
});

test("retrying a failed broadcast rechecks consent and phone proof at retry time", async () => {
  freshBroadcastBudget();
  const c = await newClient({ marketingOptIn: true });
  const admin = await newAdmin();
  h.outbox.smsFail = true;
  await admin.post("/admin/sms/broadcast", { message: "מבצע לבדיקת שליחה חוזרת" });
  h.outbox.smsFail = false;
  const log = (await admin.get("/admin/state")).json.state.smsLogs.find(l => l.phone === c.phone && l.category === "broadcast" && l.status === "failed");
  assert.ok(log);
  await new Client().post("/optout", { t: tokenFor("", c.phone) });
  const count = h.outbox.sms.length;
  const refused = await admin.post("/admin/sms/retry", { id: log.id });
  assert.equal(refused.json.sent, false);
  assert.match(refused.json.reason, /לא מאשר/);
  assert.equal(h.outbox.sms.length, count, "nothing sent after opt-out");

  // Opted in again but with the phone no longer proven: still refused.
  await c.post("/me/marketing", { optIn: true });
  const u = storedUser(c.phone);
  h.fake.run(["HSET", "users", u.id, JSON.stringify({ ...u, phoneVerified: false })]);
  assert.equal((await admin.post("/admin/sms/retry", { id: log.id })).json.sent, false);
  assert.equal(h.outbox.sms.length, count);
  h.fake.run(["HSET", "users", u.id, JSON.stringify(u)]);

  // Consent current and phone proven: the retry goes out.
  assert.equal((await admin.post("/admin/sms/retry", { id: log.id })).json.sent, true);
  assert.equal(h.outbox.sms[count].to, c.phone);
  assert.ok(h.outbox.sms[count].message.startsWith("פרסומת: Ilay Barbershop\n"));
});

test("a broadcast logged in the old format cannot be retried; other messages retry as before", async () => {
  const c = await newClient({ marketingOptIn: true });
  const admin = await newAdmin();
  const id = "sms_legacy_" + c.phone;
  h.fake.run(["HSET", "smslogs", id, JSON.stringify({ id, phone: c.phone, name: c.name, message: "מבצע ישן\nלהסרה: 054-2858711", category: "broadcast", status: "failed", parts: 1, createdAt: Date.now() })]);
  const count = h.outbox.sms.length;
  assert.equal((await admin.post("/admin/sms/retry", { id })).json.sent, false);
  assert.equal(h.outbox.sms.length, count);
  h.fake.run(["HDEL", "smslogs", id]);
});

test("admin opt-out: admin only, keeps the account and login, and the customer can opt in again", async () => {
  const c = await newClient({ marketingOptIn: true });
  const stranger = await newClient();
  const uid = uidOf(c.phone);
  for (const who of [new Client(), stranger, c]) {
    assert.equal((await who.post(`/admin/users/${uid}/optout`)).status, 401);
  }
  assert.equal(storedUser(c.phone).marketingOptIn, true);
  const admin = await newAdmin();
  assert.equal((await admin.post("/admin/users/usr_missing/optout")).status, 404);
  const r = await admin.post(`/admin/users/${uid}/optout`);
  assert.equal(r.status, 200);
  const row = r.json.state.registeredUsers.find(u => u.id === uid);
  assert.equal(row.marketingOptIn, false);
  assert.ok(row.marketingOptOutAt > 0);
  assert.equal(row.phone, c.phone, "the account stays");
  assert.equal((await c.get("/me")).status, 200);
  assert.equal((await new Client().post("/auth/login", { ident: c.phone, password: PASSWORD })).status, 200);
  assert.equal((await c.post("/me/marketing", { optIn: true })).json.user.marketingOptIn, true);
  // The apply diff cannot grant consent.
  await admin.post(`/admin/users/${uid}/optout`);
  await admin.post("/admin/apply", { users: { upsert: [{ id: uid, username: c.name, phone: c.phone, marketingOptIn: true }], remove: [] } });
  assert.equal(storedUser(c.phone).marketingOptIn, false);
});

test("marketing consent time is recorded at sign-up, through the code step, and on switching on", async () => {
  const start = Date.now();
  const yes = await newClient({ marketingOptIn: true });
  const atSignup = storedUser(yes.phone).marketingConsentAt;
  assert.ok(atSignup >= start && atSignup <= Date.now(), "verification flow");
  const no = await newClient({ marketingOptIn: false });
  assert.equal(storedUser(no.phone).marketingConsentAt, undefined);
  const direct = await newUnverifiedClient({ marketingOptIn: true });
  assert.ok(storedUser(direct.phone).marketingConsentAt >= start, "no-SMS flow");

  const beforeOn = Date.now();
  await no.post("/me/marketing", { optIn: true });
  const first = storedUser(no.phone).marketingConsentAt;
  assert.ok(first >= beforeOn);
  await new Promise(r => setTimeout(r, 5));
  await no.post("/me/marketing", { optIn: true });
  assert.equal(storedUser(no.phone).marketingConsentAt, first, "repeating does not move it");
  await no.post("/me/marketing", { optIn: false });
  const off = storedUser(no.phone);
  assert.equal(off.marketingOptIn, false);
  assert.ok(off.marketingOptOutAt >= first);

  const admin = await newAdmin();
  const row = (await admin.get("/admin/state")).json.state.registeredUsers.find(u => u.phone === yes.phone);
  assert.equal(row.marketingConsentAt, atSignup);
  // A new number on the account does not inherit the old number's consent.
  const moved = freshPhone();
  await admin.post("/admin/apply", { users: { upsert: [{ id: uidOf(yes.phone), username: yes.name, phone: moved }], remove: [] } });
  const after = storedUser(moved);
  assert.equal(after.marketingOptIn, false);
  assert.equal(after.marketingConsentAt, undefined);
});

// --- Deletion matches the privacy policy ---
function seedPast(c, id) {
  const row = { id, dayIdx: 1, date: "2026-01-05", dateStr: "05/01", time: "10:00", startsAtMs: Date.now() - 86400000, uid: uidOf(c.phone), name: c.name, phone: c.phone, price: 90, service: "x", note: "הערת-לקוח-למחיקה", adminNote: "הערת-ספר-למחיקה", status: "confirmed" };
  h.fake.run(["HSET", "appts", id, JSON.stringify(row)]);
  h.fake.run(["SADD", `phoneappts:${c.phone}`, id]);
}

for (const [who, erase] of [
  ["an admin", async (c, admin) => admin.post("/admin/apply", { users: { upsert: [], remove: [uidOf(c.phone)] } })],
  ["the customer", async c => c.post("/me/delete")]
]) {
  test(`deletion by ${who} scrubs appointments, SMS logs and messages, frees slots and keeps anonymous statistics`, async () => {
    freshBroadcastBudget();
    const c = await newClient({ marketingOptIn: true });
    const admin = await newAdmin();
    const slot = freshSlot();
    const future = await book(c, slot);
    const canceled = await book(c);
    assert.equal((await c.post(`/appointments/${canceled.id}/cancel`)).status, 200);
    const manualId = "ap_manual_" + Date.now();
    await admin.post("/admin/apply", { appointments: { upsert: [{ id: manualId, ...freshSlot(), name: c.name, phone: c.phone, price: 70, service: "x", adminNote: "הערה ידנית" }], remove: [] } });
    const pastId = "ap_past_" + Date.now();
    seedPast(c, pastId);
    await c.post("/me/message", { text: "הודעה פרטית מאוד" });
    await admin.post("/admin/sms/broadcast", { message: "מבצע" });
    const uid = uidOf(c.phone);
    assert.ok(redisDump().includes(c.phone));

    const r = await erase(c, admin);
    assert.equal(r.status, 200, r.text);

    const dump = redisDump();
    assert.ok(!dump.includes(c.phone), "phone is gone from Redis");
    assert.ok(!dump.includes(c.name), "name is gone from Redis");
    assert.ok(!dump.includes("הודעה פרטית מאוד"));
    assert.ok(!dump.includes("הערת-לקוח-למחיקה"));
    assert.ok(!dump.includes("הערת-ספר-למחיקה"));
    assert.ok(!dump.includes(uid));
    for (const id of [future.id, canceled.id, manualId]) assert.equal(h.fake.run(["HGET", "appts", id]).result, null, id);
    const anon = JSON.parse(h.fake.run(["HGET", "appts", pastId]).result);
    assert.deepEqual([anon.name, anon.phone, anon.note, anon.adminNote, anon.uid], ["לקוח שנמחק", "", "", "", undefined]);
    assert.equal(anon.price, 90, "statistics keep the revenue");
    const state = (await admin.get("/admin/state")).json.state;
    assert.ok(!JSON.stringify(state).includes(c.phone));
    const b = await newClient();
    assert.equal((await b.post("/appointments", { ...slot, srvIdx: 0 })).status, 200, "slot freed");
    h.fake.run(["HDEL", "appts", pastId]);
  });
}

test("deleting an account that never proved its phone leaves the real owner's appointment and logs alone", async () => {
  const fake = await newUnverifiedClient();
  const admin = await newAdmin();
  const id = "ap_owner_" + fake.phone;
  await admin.post("/admin/apply", { appointments: { upsert: [{ id, ...freshSlot(), name: "הבעלים האמיתי", phone: fake.phone, price: 70, service: "x" }], remove: [] } });
  assert.ok((await admin.get("/admin/state")).json.state.smsLogs.some(l => l.phone === fake.phone && l.apptId === id));
  assert.equal((await fake.post("/me/delete")).status, 200);
  const state = (await admin.get("/admin/state")).json.state;
  assert.equal(JSON.parse(h.fake.run(["HGET", "appts", id]).result).name, "הבעלים האמיתי");
  assert.ok(state.smsLogs.some(l => l.phone === fake.phone && l.apptId === id));
  await admin.post("/admin/apply", { appointments: { upsert: [], remove: [id] } });
});

// --- Third parties and dead code in what gets deployed ---
test("deployed files load nothing from Google, the dead legal modal is gone, Heebo is self-hosted under the OFL", async () => {
  const root = path.join(__dirname, "..");
  const deployed = fs.readdirSync(root).filter(f => /\.(html|css|js|json)$/.test(f));
  deployed.push(...fs.readdirSync(path.join(root, "api")).map(f => "api/" + f), "fonts/heebo.css");
  for (const f of deployed) {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(text, /fonts\.googleapis|fonts\.gstatic/, f);
    assert.doesNotMatch(text, /legalTermsModal|legalTitle|openLegalModal|s-legal/, f);
  }
  const csp = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")).headers[0].headers.find(x => x.key === "Content-Security-Policy").value;
  assert.match(csp, /font-src 'self';/);
  assert.match(csp, /style-src 'self' 'unsafe-inline';/);
  for (const page of ["index", "admin", "privacy", "terms", "accessibility", "optout"]) {
    assert.match(fs.readFileSync(path.join(root, page + ".html"), "utf8"), /href="\/fonts\/heebo\.css"/, page);
  }
  const css = await rawGet("/fonts/heebo.css");
  assert.equal(css.status, 200);
  assert.equal((css.text.match(/font-display: swap/g) || []).length, 2);
  for (const url of css.text.match(/\/fonts\/[\w-]+\.woff2/g)) {
    const font = await rawGet(url);
    assert.equal(font.status, 200, url);
    assert.equal(font.headers["content-type"], "font/woff2");
  }
  assert.match(fs.readFileSync(path.join(root, "fonts", "OFL.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
});

// --- Availability: every date is closed until the owner opens it ---
const AV = require("../api/_availability");
const T = require("../api/_time");
const OPEN = { open: true, start: "10:00", end: "12:00" };
const ilToday = () => T.todayYmd();
const plusDays = n => T.addDays(ilToday(), n);
// First date at least minDays ahead that falls on the weekday.
function nextWeekday(dow, minDays = 7) { for (let n = minDays; ; n++) if (T.dowOfYmd(plusDays(n)) === dow) return plusDays(n); }
const avKey = (ns = "") => ns + "cfg:availability";
const storedAvailability = (ns = "") => JSON.parse(h.fake.run(["GET", avKey(ns)]).result);

// Runs fn with the stored rules replaced (null: nothing stored, the state on the day this ships), then puts them back.
async function withAvailability(av, fn) {
  const saved = h.fake.run(["GET", avKey()]).result;
  const set = v => { if (v === null) h.fake.run(["DEL", avKey()]); else h.fake.run(["SET", avKey(), typeof v === "string" ? v : JSON.stringify(v)]); h.fake.run(["INCR", "ver"]); };
  set(av);
  freshCodeBudget();
  try { return await fn(); } finally { set(saved); }
}
// These tests register many customers; the site-wide daily budget for SMS codes is not what they are about.
const freshCodeBudget = () => h.fake.run(["DEL", "codecap:g:" + T.todayYmd()]);
const openDaysNow = async () => (await new Client().get("/public")).json.openDays;

test("availability: with nothing stored, every date is closed and nothing can be booked", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const state = (await admin.get("/admin/state")).json.state;
  assert.equal(state.availability.weekly.length, 7);
  assert.ok(state.availability.weekly.every(d => d.open === false), "all weekdays closed");
  assert.deepEqual(state.availability.dates, {});
  assert.equal(state.weeklySchedule, undefined);
  assert.deepEqual(await openDaysNow(), []);
  const a = await newClient();
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 29]) {
    const r = await a.post("/appointments", { date: plusDays(n), time: "12:00", srvIdx: 0 });
    assert.equal(r.status, 400, "day +" + n);
    assert.match(r.json.reason, /סגורה|עברה/);
  }
  assert.equal((await a.post("/appointments", { date: plusDays(3), time: "12:00", srvIdx: 0 })).json.reason, "ביום הזה המספרה סגורה. אפשר לבחור יום אחר.");
}));

test("availability: the old stored schedule opens nothing, and the old save field is ignored", () => withAvailability(null, async () => {
  const oldSchedule = Array.from({ length: 7 }, () => ({ active: true, start: "08:00", end: "22:00" }));
  h.fake.run(["SET", "cfg:schedule", JSON.stringify(oldSchedule)]);
  h.fake.run(["INCR", "ver"]);
  try {
    assert.deepEqual(await openDaysNow(), []);
    const r = await (await newClient()).post("/appointments", { date: plusDays(2), time: "10:00", srvIdx: 0 });
    assert.equal(r.status, 400);
    const admin = await newAdmin();
    assert.equal((await admin.post("/admin/apply", { weeklySchedule: oldSchedule })).status, 200);
    assert.equal(h.fake.run(["GET", avKey()]).result, null, "does not become availability");
    assert.deepEqual(await openDaysNow(), []);
    assert.equal(fs.readFileSync(path.join(__dirname, "..", "api", "_defaults.js"), "utf8").includes("weeklySchedule"), false);
  } finally { h.fake.run(["DEL", "cfg:schedule"]); }
}));

test("availability: a weekly rule opens that weekday only, in every week within the horizon", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const dow = 2;
  const weekly = AV.defaults().weekly.map((d, i) => (i === dow ? { open: true, start: "10:00", end: "12:00" } : d));
  assert.equal((await admin.post("/admin/availability", { weekly })).status, 200);
  const days = await openDaysNow();
  assert.ok(days.length >= 4 && days.length <= 5, "four or five Tuesdays in 30 days: " + days.length);
  days.forEach(d => { assert.equal(T.dowOfYmd(d.date), dow); assert.equal(d.start, "10:00"); assert.equal(d.end, "12:00"); });
  const closedDay = nextWeekday(3);
  assert.equal((await (await newClient()).post("/appointments", { date: closedDay, time: "10:00", srvIdx: 0 })).status, 400);
}));

test("availability: the same weekday and time in two different weeks are two different slots", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const dow = 4;
  const weekly = AV.defaults().weekly.map((d, i) => (i === dow ? { open: true, start: "10:00", end: "12:00" } : d));
  await admin.post("/admin/availability", { weekly });
  const first = nextWeekday(dow, 7);
  const second = T.addDays(first, 7);
  const a = await newClient();
  const b = await newClient();
  const apA = await book(a, { date: first, time: "11:00" });
  const apB = await book(b, { date: second, time: "11:00" });
  assert.equal(apA.dayIdx, apB.dayIdx);
  assert.equal(apA.date, first);
  assert.equal(apB.date, second);
  assert.notEqual(apA.startsAtMs, apB.startsAtMs);
  assert.equal(T.todayYmd(apB.startsAtMs), second);
  assert.equal((await (await newClient()).post("/appointments", { date: second, time: "11:00", srvIdx: 0 })).status, 409, "still one per slot");
  const busy = (await new Client().get("/public")).json.busy;
  assert.ok(busy.some(x => x.date === first && x.time === "11:00") && busy.some(x => x.date === second && x.time === "11:00"));
  // Moving to the same weekday a week later is a real move.
  const c = await newClient();
  const apC = await book(c, { date: first, time: "10:00" });
  const moved = await c.post("/appointments/" + apC.id + "/move", { date: second, time: "10:00", srvIdx: 0 });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.appointment.date, second);
  assert.equal((await (await newClient()).post("/appointments", { date: first, time: "10:00", srvIdx: 0 })).status, 200, "the first week's slot is free again");
  // The barber can do the same from the calendar.
  const adminMove = await admin.post("/admin/apply", { appointments: { upsert: [{ id: apA.id, date: T.addDays(second, 7), time: "11:00" }], remove: [] } });
  assert.deepEqual(adminMove.json.conflicts, []);
  assert.equal(adminMove.json.state.appointments.find(x => x.id === apA.id).date, T.addDays(second, 7));
}));

test("availability: a date opens on a closed weekday, closes on an open one, and reset removes the rule", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const dow = 1;
  const weekly = AV.defaults().weekly.map((d, i) => (i === dow ? { open: true, start: "10:00", end: "12:00" } : d));
  await admin.post("/admin/availability", { weekly });
  const closedWeekday = nextWeekday(5, 7);
  const openWeekday = nextWeekday(dow, 7);
  // Open on a closed weekday.
  let r = await admin.post("/admin/availability", { dates: { [closedWeekday]: { open: true, start: "16:00", end: "18:00" } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.state.availability.dates[closedWeekday], { open: true, start: "16:00", end: "18:00" });
  assert.deepEqual((await openDaysNow()).find(d => d.date === closedWeekday), { date: closedWeekday, start: "16:00", end: "18:00" });
  assert.equal(new Set((await openDaysNow()).map(d => d.date)).size, (await openDaysNow()).length);
  const a = await newClient();
  assert.equal((await a.post("/appointments", { date: closedWeekday, time: "10:00", srvIdx: 0 })).status, 400, "that date's own hours apply");
  assert.equal((await a.post("/appointments", { date: closedWeekday, time: "17:00", srvIdx: 0 })).status, 200);
  // Only that date: the same weekday a week later stays closed.
  assert.equal((await a.post("/appointments", { date: T.addDays(closedWeekday, 7), time: "17:00", srvIdx: 0 })).status, 400);
  // Close one date in an open weekday.
  await admin.post("/admin/availability", { dates: { [openWeekday]: { open: false } } });
  assert.ok(!(await openDaysNow()).some(d => d.date === openWeekday));
  assert.equal((await (await newClient()).post("/appointments", { date: openWeekday, time: "10:00", srvIdx: 0 })).status, 400);
  assert.ok((await openDaysNow()).some(d => d.date === T.addDays(openWeekday, 7) || T.addDays(openWeekday, 7) > plusDays(29)), "other weeks stay open");
  // Reset: back to the weekly rule, and back to closed.
  r = await admin.post("/admin/availability", { dates: { [openWeekday]: null, [closedWeekday]: null } });
  assert.deepEqual(r.json.state.availability.dates, {});
  assert.ok((await openDaysNow()).some(d => d.date === openWeekday));
  assert.ok(!(await openDaysNow()).some(d => d.date === closedWeekday));
}));

test("availability: saving validates dates, hours and limits", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const post = body => admin.post("/admin/availability", body);
  const open = date => ({ dates: { [date]: OPEN } });
  assert.equal((await post(open(plusDays(-1)))).status, 400, "past date");
  assert.match((await post(open(plusDays(-1)))).json.reason, /עבר/);
  assert.equal((await post(open(plusDays(0)))).status, 200, "today is fine");
  assert.equal((await post(open(plusDays(367)))).status, 400, "too far");
  assert.equal((await post(open(plusDays(366)))).status, 200);
  for (const bad of ["2026-02-30", "2026-13-01", "20260101", "not-a-date", "__proto__"]) assert.equal((await post(open(bad))).status, 400, bad);
  assert.equal((await post({ dates: { [plusDays(1)]: { open: true, start: "12:00", end: "12:00" } } })).status, 400, "start equals end");
  assert.equal((await post({ dates: { [plusDays(1)]: { open: true, start: "14:00", end: "12:00" } } })).status, 400, "start after end");
  assert.equal((await post({ dates: { [plusDays(1)]: { open: true, start: "25:00", end: "26:00" } } })).status, 400);
  assert.equal((await post({ dates: { [plusDays(1)]: { open: "yes" } } })).status, 400);
  assert.equal((await post({ dates: [] })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ weekly: [] })).status, 400);
  const badRow = AV.defaults().weekly.map((d, i) => (i === 0 ? { open: true, start: "20:00", end: "10:00" } : d));
  assert.equal((await post({ weekly: badRow })).status, 400);
  // Removing a rule whose date has passed is always allowed.
  assert.equal((await post({ dates: { [plusDays(-5)]: null } })).status, 200);
  // Up to 400 rules.
  const huge = {};
  for (let i = 0; i < 401; i++) huge[T.addDays("2030-01-01", i)] = null;
  assert.equal((await post({ dates: huge })).status, 400, "too many in one request");
  const full = {};
  for (let i = 0; i < 400; i++) full[T.addDays("2020-01-01", i)] = { open: false };
  h.fake.run(["SET", avKey(), JSON.stringify({ weekly: AV.defaults().weekly, dates: full })]);
  assert.equal((await post({ dates: { [plusDays(0)]: OPEN } })).status, 400, "401st rule");
  // Nothing refused was written.
  assert.equal(Object.keys(storedAvailability().dates).length, 400);
}));

test("availability: two saves at once both survive", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const dates = [1, 2, 3, 4, 5, 6].map(plusDays);
  const replies = await Promise.all(dates.map(d => admin.post("/admin/availability", { dates: { [d]: OPEN } })));
  replies.forEach(r => assert.equal(r.status, 200));
  dates.forEach(d => assert.deepEqual(storedAvailability().dates[d], OPEN));
}));

test("availability: closed-day booking and move are refused, an open day's hours are the bound", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const openDate = plusDays(11);
  const closedDate = plusDays(12);
  await admin.post("/admin/availability", { dates: { [openDate]: { open: true, start: "10:30", end: "12:00" } } });
  const a = await newClient();
  const refused = async (time, date = openDate) => (await a.post("/appointments", { date, time, srvIdx: 0 })).status;
  assert.equal(await refused("10:00"), 400, "before opening");
  assert.equal(await refused("12:00"), 400, "the closing time is not a slot");
  assert.equal(await refused("12:30"), 400, "after closing");
  assert.equal(await refused("10:45"), 400, "off the grid");
  assert.equal(await refused("10:30", closedDate), 400, "closed date");
  assert.equal(await refused("10:30", plusDays(30)), 400, "beyond the horizon");
  assert.match((await a.post("/appointments", { date: plusDays(30), time: "10:30", srvIdx: 0 })).json.reason, /30 ימים/);
  assert.equal(await refused("10:30", "2026-02-30"), 400);
  assert.equal((await a.post("/appointments", { dayIdx: 1, time: "10:30", srvIdx: 0 })).status, 400, "a weekday alone is no longer a date");
  const ap = await book(a, { date: openDate, time: "11:30" });
  const move = await a.post("/appointments/" + ap.id + "/move", { date: closedDate, time: "10:30", srvIdx: 0 });
  assert.equal(move.status, 400);
  assert.match(move.json.reason, /סגורה/);
  assert.equal((await a.get("/me")).json.appointments.find(x => x.id === ap.id).date, openDate, "stays where it was");
  assert.equal((await a.post("/appointments/" + ap.id + "/move", { date: openDate, time: "10:30", srvIdx: 0 })).status, 200);
  // The edge of the horizon, the last bookable date.
  await admin.post("/admin/availability", { dates: { [plusDays(29)]: OPEN, [plusDays(30)]: OPEN } });
  assert.equal((await (await newClient()).post("/appointments", { date: plusDays(29), time: "11:00", srvIdx: 0 })).status, 200);
  assert.ok(!(await openDaysNow()).some(d => d.date === plusDays(30)));
}));

test("availability: closing a day keeps its appointments valid, visible and cancelable", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const date = plusDays(13);
  await admin.post("/admin/availability", { dates: { [date]: { open: true, start: "15:00", end: "16:00" } } });
  const a = await newClient();
  const ap = await book(a, { date, time: "15:00" });
  await admin.post("/admin/availability", { dates: { [date]: { open: false } } });
  assert.ok((await a.get("/me")).json.appointments.some(x => x.id === ap.id && x.status === "pending"));
  assert.ok((await admin.get("/admin/state")).json.state.appointments.some(x => x.id === ap.id));
  assert.ok((await new Client().get("/public")).json.busy.some(x => x.date === date && x.time === "15:00"));
  assert.equal((await a.post("/appointments/" + ap.id + "/confirm")).status, 200);
  assert.equal((await a.post("/appointments/" + ap.id + "/cancel")).status, 200);
}));

test("availability: a manual admin appointment works on a closed day and opens nothing to customers", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const date = plusDays(8);
  const phone = freshPhone();
  const r = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_override1", date, time: "13:15", name: "לקוח ידני", phone, price: 70, service: "x" }], remove: [] } });
  assert.deepEqual(r.json.conflicts, []);
  const appt = r.json.state.appointments.find(x => x.id === "ap_override1");
  assert.equal(appt.date, date);
  assert.equal(appt.dayIdx, T.dowOfYmd(date));
  assert.equal(appt.dateStr, T.dateStrOf(date));
  assert.deepEqual(await openDaysNow(), []);
  assert.equal((await (await newClient()).post("/appointments", { date, time: "13:45", srvIdx: 0 })).status, 400);
  // Still one per slot, and still a real date.
  const dup = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_override2", date, time: "13:15", name: "לקוח ידני", phone: freshPhone(), price: 70, service: "x" }], remove: [] } });
  assert.equal(dup.json.conflicts.length, 1);
  const past = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_override3", date: plusDays(-1), time: "10:00", name: "לקוח ידני", phone: freshPhone(), price: 70, service: "x" }], remove: [] } });
  assert.match(past.json.conflicts[0].reason, /שעבר/);
  const noDate = await admin.post("/admin/apply", { appointments: { upsert: [{ id: "ap_override4", dayIdx: 2, time: "10:00", name: "לקוח ידני", phone: freshPhone(), price: 70, service: "x" }], remove: [] } });
  assert.equal(noDate.json.conflicts.length, 1);
  await admin.post("/admin/apply", { appointments: { upsert: [], remove: ["ap_override1"] } });
}));

test("availability: saving is admin only, same-origin, bumps the version and leaves the other namespace alone", () => withAvailability(null, async () => {
  const body = { dates: { [plusDays(2)]: OPEN } };
  assert.equal((await new Client().post("/admin/availability", body)).status, 401);
  assert.equal((await (await newClient()).post("/admin/availability", body)).status, 401, "a customer session is not enough");
  assert.equal(h.fake.run(["GET", avKey()]).result, null);
  const admin = await newAdmin();
  assert.equal((await admin.post("/admin/availability", body, { noOrigin: true })).status, 403);
  const foreign = new Client({ ip: admin.ip, origin: "https://evil.example" });
  foreign.jar = admin.jar;
  assert.equal((await foreign.post("/admin/availability", body)).status, 403);
  const before = (await admin.get("/admin/version")).json.v;
  const saved = await admin.post("/admin/availability", body);
  assert.equal(saved.status, 200);
  assert.ok((await admin.get("/admin/version")).json.v > before);
  assert.ok(storedAvailability().dates[plusDays(2)]);

  // test: has its own rules.
  const testBefore = h.fake.run(["GET", avKey("test:")]).result;
  h.fake.run(["DEL", avKey("test:")]);
  try {
    const t = (await admin.get("/admin/state?test=1")).json.state;
    assert.ok(t.availability.weekly.every(d => d.open === false), "starts closed in test mode too");
    assert.deepEqual(t.availability.dates, {});
    const d = plusDays(3);
    assert.equal((await admin.post("/admin/availability?test=1", { dates: { [d]: OPEN } })).status, 200);
    assert.ok(!storedAvailability().dates[d], "the real rules are untouched");
    assert.ok(storedAvailability("test:").dates[d]);
    assert.ok((await admin.get("/public?test=1")).json.openDays.some(x => x.date === d));
  } finally { h.fake.run(["SET", avKey("test:"), testBefore]); }
}));

test("availability: the public payload has only open dates and hours, and no personal data", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const weekly = AV.defaults().weekly.map((d, i) => (i === 3 ? { open: true, start: "10:00", end: "12:00" } : d));
  await admin.post("/admin/availability", { weekly, dates: { [plusDays(9)]: OPEN, [plusDays(10)]: { open: false } } });
  const a = await newClient();
  await book(a, { date: plusDays(9), time: "10:30" }, { note: "הערה סודית" });
  const r = await new Client().get("/public");
  assert.deepEqual(Object.keys(r.json).sort(), ["busy", "horizonDays", "ok", "openDays", "portfolio", "services", "siteConfig", "test", "v"]);
  r.json.openDays.forEach(d => assert.deepEqual(Object.keys(d).sort(), ["date", "end", "start"]));
  r.json.busy.forEach(b => assert.deepEqual(Object.keys(b).sort(), ["date", "time"]));
  assert.equal(r.json.horizonDays, 30);
  for (const leak of [a.name, a.phone, "הערה סודית", "weekly", "weeklySchedule", "availability", "source"]) assert.ok(!r.text.includes(leak), leak);
  assert.ok(!r.text.includes(plusDays(10)) || T.dowOfYmd(plusDays(10)) === 3 || r.json.busy.some(b => b.date === plusDays(10)), "an explicitly closed date is simply absent");
}));

test("availability: rules for past dates are dropped by the daily maintenance", () => withAvailability({ weekly: AV.defaults().weekly, dates: { [plusDays(-3)]: OPEN, [plusDays(-1)]: { open: false }, [plusDays(0)]: OPEN, [plusDays(4)]: OPEN } }, async () => {
  h.fake.run(["DEL", "remgate"]);
  h.fake.run(["DEL", "maint"]);
  await new Client().get("/public");
  assert.deepEqual(Object.keys(storedAvailability().dates).sort(), [plusDays(0), plusDays(4)].sort());
}));

test("availability: the manual reminder button stops at the coming week", () => withAvailability(null, async () => {
  const admin = await newAdmin();
  const far = plusDays(20);
  await admin.post("/admin/availability", { dates: { [far]: { open: true, start: "15:00", end: "16:00" } } });
  const a = await newClient();
  const ap = await book(a, { date: far, time: "15:00" });
  await admin.post("/admin/reminders");
  const stored = (await a.get("/me")).json.appointments.find(x => x.id === ap.id);
  assert.equal(stored.reminderSent, false, "a month-away booking keeps its one reminder for later");
}));

test("dates: Israel's midnight decides the date, in winter and in summer", () => {
  // Winter, UTC+2.
  assert.equal(T.todayYmd(Date.UTC(2026, 10, 7, 21, 59)), "2026-11-07");
  assert.equal(T.todayYmd(Date.UTC(2026, 10, 7, 22, 1)), "2026-11-08");
  // Summer, UTC+3.
  assert.equal(T.todayYmd(Date.UTC(2026, 6, 1, 20, 59)), "2026-07-01");
  assert.equal(T.todayYmd(Date.UTC(2026, 6, 1, 21, 1)), "2026-07-02");
  // At 00:01 in Israel it is still the day before in UTC.
  const av = { weekly: AV.defaults().weekly, dates: { "2026-11-07": OPEN, "2026-11-08": OPEN } };
  const site = { slotInterval: 30, slotBuffer: 0 };
  const before = Date.UTC(2026, 10, 7, 21, 59);
  const after = Date.UTC(2026, 10, 7, 22, 1);
  assert.deepEqual(AV.publicOpenDays(av, before).map(d => d.date), ["2026-11-07", "2026-11-08"]);
  assert.deepEqual(AV.publicOpenDays(av, after).map(d => d.date), ["2026-11-08"]);
  assert.doesNotThrow(() => AV.assertBookable(av, site, "2026-11-08", "10:00", before));
  assert.throws(() => AV.assertBookable(av, site, "2026-11-07", "10:00", after), /עברה/);
  // A weekday comes from the date, and addDays does not slip across the clock change.
  assert.equal(T.dowOfYmd("2026-11-08"), 0);
  assert.equal(T.addDays("2027-03-25", 2), "2027-03-27");
  assert.equal(T.addDays("2027-10-30", 2), "2027-11-01");
  // The horizon's last date, counted in Israel days.
  const last = "2026-12-07";
  const horizonAv = { weekly: AV.defaults().weekly, dates: { [last]: OPEN, "2026-12-08": OPEN } };
  assert.doesNotThrow(() => AV.assertBookable(horizonAv, site, last, "10:00", after));
  assert.throws(() => AV.assertBookable(horizonAv, site, "2026-12-08", "10:00", after), /30 ימים/);
  assert.deepEqual(AV.publicOpenDays(horizonAv, after).map(d => d.date), [last]);
});

test("dates: summer time changes keep hours right, and the skipped hour is not bookable", () => {
  const eq = (date, time, utcH, utcM = 0) => {
    const [y, m, d] = date.split("-").map(Number);
    assert.equal(T.epochFor(date, time), Date.UTC(y, m - 1, d, utcH, utcM), date + " " + time);
  };
  // Clocks go forward on Friday 2027-03-26 at 02:00, and back on Sunday 2027-10-31 at 02:00.
  eq("2027-03-25", "10:00", 8);
  assert.equal(T.epochFor("2027-03-26", "01:30"), Date.UTC(2027, 2, 25, 23, 30), "01:30 is still winter time");
  eq("2027-03-26", "03:00", 0);
  eq("2027-03-26", "10:00", 7);
  eq("2027-10-30", "10:00", 7);
  eq("2027-10-31", "03:00", 1);
  eq("2027-10-31", "10:00", 8);
  assert.equal(T.wallClockExists("2027-03-26", "02:30"), false, "02:30 does not exist that morning");
  assert.equal(T.wallClockExists("2027-03-26", "03:00"), true);
  assert.equal(T.wallClockExists("2027-10-31", "01:30"), true);
  const av = { weekly: AV.defaults().weekly, dates: { "2027-03-26": { open: true, start: "00:00", end: "06:00" } } };
  const site = { slotInterval: 30, slotBuffer: 0 };
  const dayBefore = Date.UTC(2027, 2, 24, 12);
  assert.throws(() => AV.assertBookable(av, site, "2027-03-26", "02:30", dayBefore), /לא זמינה/);
  assert.doesNotThrow(() => AV.assertBookable(av, site, "2027-03-26", "03:00", dayBefore));
  assert.equal(AV.adminSlotProblem("2027-03-26", "02:30", dayBefore) !== null, true);
});

test("ntfy: only a customer's booking, move, cancel and message reach the phone", async () => {
  freshCodeBudget();
  const pushes = () => h.outbox.ntfy.length;
  const admin = await newAdmin();
  const notifCount = async () => (await admin.get("/admin/state")).json.state.adminNotifications.length;
  process.env.NTFY_TOPIC = "test-topic";
  try {
    const silent = async (name, fn) => {
      const before = pushes();
      await fn();
      assert.equal(pushes(), before, name + " must not push: " + JSON.stringify(h.outbox.ntfy.slice(before)));
    };
    const pushed = async (name, fn, re) => {
      const before = pushes();
      await fn();
      const sent = h.outbox.ntfy.slice(before);
      assert.equal(sent.length, 1, name + " pushes once");
      assert.match(sent[0].message, re, name);
      return sent[0];
    };

    let c;
    await silent("a new customer", async () => { c = await newClient(); });
    const slot = freshSlot();
    let ap;
    const created = await pushed("a customer's booking", async () => { ap = await book(c, slot); }, /תור חדש: יום .* בשעה/);
    assert.ok(created.message.includes(slot.time) && created.message.includes(T.dateStrOf(slot.date)), "says the day and time");
    await silent("arrival confirmation", () => c.post("/appointments/" + ap.id + "/confirm"));
    const s2 = freshSlot();
    await pushed("a customer's move", () => c.post("/appointments/" + ap.id + "/move", { ...s2, srvIdx: 0 }), /תור הוזז: יום .* בשעה/);
    await pushed("a customer's message", () => c.post("/me/message", { text: "הטלפון שלי 0501234567 בסוד" }), /הודעה חדשה/);
    await silent("admin moves it", () => admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, ...freshSlot() }], remove: [] } }));
    await silent("admin cancels it", () => admin.post("/admin/apply", { appointments: { upsert: [{ id: ap.id, status: "canceled" }], remove: [] } }));
    const manualId = "ap_push_manual";
    await silent("a manual appointment", () => admin.post("/admin/apply", { appointments: { upsert: [{ id: manualId, ...freshSlot(), name: "ידני", phone: freshPhone(), price: 1, service: "x" }], remove: [] } }));
    await silent("test SMS", () => admin.post("/admin/sms/test"));
    await silent("a failed SMS", async () => {
      h.outbox.smsFail = true;
      try { await admin.post("/admin/sms/test"); } finally { h.outbox.smsFail = false; }
    });
    await silent("the daily SMS cap", async () => {
      const limit = Number(/CAP_GLOBAL_DAY = (\d+)/.exec(fs.readFileSync(path.join(__dirname, "..", "api", "_sms.js"), "utf8"))[1]);
      const key = "cap:g:" + T.todayYmd();
      const saved = h.fake.run(["GET", key]).result;
      h.fake.run(["SET", key, String(limit), "EX", "172800"]);
      try { await admin.post("/admin/sms/test"); } finally { h.fake.run(["SET", key, saved || "0", "EX", "172800"]); }
    });
    await silent("a reminder", async () => {
      const r = await newClient();
      const before = pushes();
      const booked = await book(r);
      assert.equal(pushes(), before + 1);
      h.outbox.ntfy.pop();
      await admin.post("/admin/reminders");
      assert.equal((await r.get("/me")).json.appointments.find(x => x.id === booked.id).reminderSent, true);
    });
    await silent("a deleted account", async () => {
      const d = await newClient();
      await d.post("/me/delete");
    });
    const c2 = await newClient();
    const ap2 = await book(c2);
    const inApp = await notifCount();
    const canceled = await pushed("a customer's cancel", () => c2.post("/appointments/" + ap2.id + "/cancel"), /תור בוטל: יום .* בשעה/);
    assert.equal(await notifCount(), inApp + 1, "the in-app notification stays");

    const blob = JSON.stringify(h.outbox.ntfy);
    assert.ok(!/05\d{8}/.test(blob), "no phone numbers");
    assert.ok(!blob.includes(c.name) && !blob.includes(c2.name), "no customer names");
    assert.ok(!blob.includes("בסוד"), "no customer text");
    assert.ok(canceled.title && canceled.topic === "test-topic");
  } finally { delete process.env.NTFY_TOPIC; }
});

test("ntfy: in-app notifications still appear for the events that do not push", async () => {
  freshCodeBudget();
  const admin = await newAdmin();
  const c = await newClient();
  const ap = await book(c);
  await c.post("/appointments/" + ap.id + "/confirm");
  const types = (await admin.get("/admin/state")).json.state.adminNotifications.map(n => n.type);
  for (const t of ["new_user", "new_booking", "confirmed"]) assert.ok(types.includes(t), t);
});

test("no outbound request ever tried to leave the harness", () => {
  assert.deepEqual(h.outbox.blocked, []);
});

// --- Runner ---
(async () => {
  h = await start();
  const setup = await newAdmin();
  // Everything starts closed, so the tests open every weekday but Saturday, wide.
  const wide = Array.from({ length: 7 }, (_, i) => ({ open: i !== 6, start: "08:00", end: "23:00" }));
  assert.equal((await setup.post("/admin/availability", { weekly: wide })).status, 200);
  assert.equal((await setup.post("/admin/availability?test=1", { weekly: wide })).status, 200);
  let passed = 0;
  const failures = [];
  const started = Date.now();
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      failures.push(t.name);
      console.log(`  FAIL ${t.name}\n       ${String(err && err.stack || err).split("\n").slice(0, 5).join("\n       ")}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed, ${tests.length} total, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`fake Redis handled ${h.fake.stats.commands} commands: ${Object.keys(h.fake.stats.byName).sort().join(", ")}`);
  await h.stop();
  process.exit(failures.length ? 1 : 0);
})();
