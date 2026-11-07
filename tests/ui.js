// End-to-end UI test: drives the real pages in headless Chrome against tests/harness.js, at 375px and 1280px,
// with the browser set to prefer dark mode. Uses only Node (DevTools protocol over the built-in WebSocket).
// Run: node tests/ui.js [screenshot-dir]
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("node:assert/strict");
const { start } = require("./harness");

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOTS = process.argv[2] || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ALLOWED_HOSTS = new Set(["images.unsplash.com", "cdnjs.cloudflare.com"]);
// Optional: path to a local axe.min.js (AXE_PATH=...). Nothing from axe is deployed or committed.
const AXE_SOURCE = process.env.AXE_PATH ? fs.readFileSync(process.env.AXE_PATH, "utf8") : null;

class Browser {
  async launch() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ilay-ui-"));
    this.proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.dir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: "ignore" });
    const portFile = path.join(this.dir, "DevToolsActivePort");
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    const [port] = fs.readFileSync(portFile, "utf8").split("\n");
    const info = await (await fetchLocal(`http://127.0.0.1:${port}/json/version`)).json();
    this.ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.nextId = 1;
    this.pending = new Map();
    this.pages = new Map();
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.sessionId && this.pages.has(m.sessionId)) this.pages.get(m.sessionId).onEvent(m);
    };
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  // Each page gets its own context, so cookies are separate, like two different devices.
  async newPage(width, height) {
    const { browserContextId } = await this.send("Target.createBrowserContext");
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, sessionId);
    this.pages.set(sessionId, page);
    await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"].map(m => this.send(m, {}, sessionId)));
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 }, sessionId);
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
    return page;
  }
  async close() {
    try { await this.send("Browser.close"); } catch (_) {}
    await sleep(400);
    try { this.proc.kill(); } catch (_) {}
    try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
  }
}

// The harness replaces global fetch, so the runner talks to Chrome through node:http.
function fetchLocal(url) {
  const http = require("http");
  return new Promise((resolve, reject) => http.get(url, res => {
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => resolve({ json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
  }).on("error", reject));
}

class Page {
  constructor(browser, sessionId) {
    this.b = browser; this.s = sessionId;
    this.errors = []; this.hosts = new Set(); this.dialogAnswers = [];
    this.requestUrls = new Map();
  }
  onEvent(m) {
    if (m.method === "Runtime.exceptionThrown") this.errors.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push("console.error: " + m.params.args.map(a => a.value || a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      const e = m.params.entry;
      const expected = /favicon\.ico/.test(e.url || "");
      if (!expected) this.errors.push(`log: ${e.text} ${e.url || ""}`);
    }
    if (m.method === "Network.requestWillBeSent") { try { this.hosts.add(new URL(m.params.request.url).hostname); } catch (_) {} }
    if (m.method === "Page.javascriptDialogOpening") {
      const answer = this.dialogAnswers.shift();
      this.b.send("Page.handleJavaScriptDialog", { accept: answer !== false, promptText: typeof answer === "string" ? answer : "" }, this.s);
    }
  }
  send(method, params) { return this.b.send(method, params, this.s); }
  async goto(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete"`);
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + expr.slice(0, 120) + " :: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expr, label, timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try { if (await this.eval(`!!(${expr})`)) return; } catch (_) {}
      await sleep(60);
    }
    throw new Error("timed out waiting for: " + (label || expr));
  }
  click(sel) { return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no element ${sel.replace(/"/g, "'")}"); el.click(); })()`); }
  fill(sel, value) {
    return this.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("no element ${sel.replace(/"/g, "'")}"); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  }
  text(sel) { return this.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`); }
  async shot(dir, name) {
    if (!dir) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(data, "base64"));
  }
  async toast(expected) {
    await this.waitFor(`document.getElementById("toastPopup").textContent.includes(${JSON.stringify(expected)})`, "toast: " + expected).catch(async err => {
      throw new Error(err.message + " (showing: " + await this.text("#toastPopup") + ")");
    });
  }
}

// WCAG contrast of the page's main text and form controls against what is behind them.
const CONTRAST_PROBE = `(() => {
  const parse = c => { const m = c.match(/[\\d.]+/g).map(Number); const k = c.startsWith("color(") ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m[3] === undefined ? 1 : m[3] }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = el => { let stack = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0) { stack.push(c); if (c.a === 1) break; } } let out = { r: 255, g: 255, b: 255 }; for (const c of stack.reverse()) out = { r: c.r * c.a + out.r * (1 - c.a), g: c.g * c.a + out.g * (1 - c.a), b: c.b * c.a + out.b * (1 - c.a) }; return out; };
  const ratio = el => { const fg = parse(getComputedStyle(el).color), bg = bgOf(el), a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const sels = ["h1", "h2", "p", "a", "label", "input", "button", ".s-btn--primary", ".adm-btn--primary", ".srv-name", ".srv-desc", ".login-title"];
  const out = {};
  sels.forEach(s => { const el = [...document.querySelectorAll(s)].find(e => e.offsetParent !== null && e.textContent.trim() || (e.tagName === "INPUT" && e.offsetParent !== null)); if (el) out[s] = Math.round(ratio(el) * 100) / 100; });
  const body = parse(getComputedStyle(document.body).backgroundColor);
  return { scheme: getComputedStyle(document.documentElement).colorScheme, bodyBg: [body.r, body.g, body.b], ratios: out };
})()`;

async function assertLight(page, name, results) {
  const r = await page.eval(CONTRAST_PROBE);
  assert.equal(r.scheme, "light", name + " color-scheme");
  assert.ok(r.bodyBg.every(v => v >= 235), `${name} background is light: ${r.bodyBg}`);
  for (const [sel, ratio] of Object.entries(r.ratios)) assert.ok(ratio >= 4.5, `${name} ${sel} contrast ${ratio}`);
  results.push(`${name}: background rgb(${r.bodyBg.join(",")}), lowest contrast ${Math.min(...Object.values(r.ratios))}`);
}

async function assertAxeClean(page, name, context = "document") {
  if (!AXE_SOURCE) return;
  // Axe blends text with any opacity still fading in, so a sheet is checked once it has fully appeared.
  if (context !== "document") {
    await page.waitFor(`(() => { const root = document.querySelector(${context}); for (let n = root.querySelector(".s-sheet") || root; n; n = n.parentElement) { if (getComputedStyle(n).opacity !== "1") return false; } return !root.getAnimations({ subtree: true }).some(a => a.playState === "running"); })()`, name + " settles");
    await sleep(400);
  }
  await page.eval(AXE_SOURCE + ";void 0");
  const res = await page.eval(`axe.run(${context}, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map(n => n.target.join(" ") + " :: " + (n.any[0] ? n.any[0].message : "")) })))`);
  console.log(`  axe  ${name}: ${res.length} violations` + (res.length ? " " + JSON.stringify(res, null, 1) : ""));
  assert.deepEqual(res, [], name + " axe");
}

async function noHorizontalScroll(page, name) {
  const over = await page.eval(`document.documentElement.scrollWidth - window.innerWidth`);
  assert.ok(over <= 1, `${name} scrolls sideways by ${over}px`);
}

// Chooses the first open date after today in the booking sheet.
const pickNextDay = `(() => { const c = [...document.querySelectorAll("#bookingDaysRow .day-chip")].find(b => b.dataset.date > ilToday()); c.click(); return c.dataset.date; })()`;

// Submits the register sheet and completes the SMS code step that appears.
async function submitRegistration(page, h, phone) {
  await page.click("#regBox .s-btn--primary");
  await page.waitFor(`document.getElementById("regVerifyBox").style.display === "block"`, "code step");
  const sms = [...h.outbox.sms].reverse().find(s => s.to === phone && /קוד/.test(s.message));
  await page.fill("#regCode", /\b(\d{6})\b/.exec(sms.message)[1]);
  await page.click("#regVerifyBox .s-btn--primary");
}

async function runAtWidth(browser, width, shots, steps) {
  const step = async (name, fn) => { await fn(); steps.push(`${width}px: ${name}`); console.log(`  ok   ${width}px: ${name}`); };
  const h = await start();
  const height = width < 600 ? 812 : 900;
  const client = await browser.newPage(width, height);
  const adminPage = await browser.newPage(width, height);
  const other = await browser.newPage(width, height);
  const light = [];
  const clientName = `דני <img src=x onerror=window.__xss=1> כהן`;
  const clientPhone = "0523334455";
  const notePayload = `<script>window.__xss=2</script>הערה"'`;
  const adminUrl = h.base + "/admin.html";

  try {
    await step("with nothing opened, the public site says so and does not error", async () => {
      await client.goto(h.base + "/");
      await client.waitFor("typeof lastPublicVersion !== 'undefined' && lastPublicVersion !== null");
      await client.waitFor("!document.getElementById('noOpenDaysNote').hidden", "empty message");
      assert.equal((await client.text("#noOpenDaysNote")).trim(), "אין כרגע תורים פתוחים. אפשר להתקשר: 054-2858711");
      assert.deepEqual(await client.eval("openDays"), []);
      await client.waitFor("!document.getElementById('welcomeSplash') || document.getElementById('welcomeSplash').classList.contains('hide')", "splash closes");
      await client.click(".service-card .srv-book");
      await client.waitFor("document.getElementById('bookingModal').classList.contains('open')");
      assert.equal(await client.eval("document.getElementById('authModal').classList.contains('open')"), false, "no login just to hear nothing is open");
      assert.equal((await client.text("#bookingNoDays")).trim(), "אין כרגע תורים פתוחים. אפשר להתקשר: 054-2858711");
      assert.equal(await client.eval("document.getElementById('confirmBookingBtn').offsetParent"), null);
      await noHorizontalScroll(client, "empty booking sheet");
      await client.shot(shots, width + "-booking-empty");
      await assertAxeClean(client, "empty booking sheet", '"#bookingModal"');
      await client.eval("closeBookingModal()");
      // The rest of this run needs open days: every weekday but Saturday, in the real and the test data.
      const weekly = Array.from({ length: 7 }, (_, i) => ({ open: i !== 6, start: "10:00", end: "20:00" }));
      for (const ns of ["", "test:"]) { h.fake.run(["SET", ns + "cfg:availability", JSON.stringify({ weekly, dates: {} })]); h.fake.run(["INCR", ns + "ver"]); }
    });

    await step("public page loads with five photos, in light colours under a dark-preferring browser", async () => {
      await client.goto(h.base + "/");
      await client.waitFor(`typeof lastPublicVersion !== "undefined" && lastPublicVersion !== null`);
      await client.waitFor(`!document.getElementById("welcomeSplash") || document.getElementById("welcomeSplash").classList.contains("hide")`, "splash closes");
      await client.waitFor(`document.querySelectorAll("#portfolioGrid .photo-card").length === 5`, "default photos after the server says so");
      assert.equal(await client.eval(`document.querySelectorAll("#portfolioGrid > li > button.photo-card").length`), 5, "real list markup");
      assert.equal(await client.eval(`document.querySelectorAll('button[role="listitem"]').length`), 0);
      assert.equal(await client.eval(`document.getElementById("portfolioGrid").tagName`), "UL");
      assert.equal(await client.eval(`!!document.getElementById("legalTermsModal") || typeof openLegalModal !== "undefined"`), false, "dead modal is gone");
      // The site prefers the system font and uses Heebo as a fallback, so the face is loaded on demand here.
      assert.deepEqual(await client.eval(`document.fonts.load("16px Heebo", "אa").then(faces => faces.map(f => f.status))`), ["loaded", "loaded"], "self-hosted Heebo loads under the CSP");
      assert.equal(await client.eval(`[...document.styleSheets].some(s => /googleapis/.test(s.href || ""))`), false);
      // This is the page's second load here, so its splash is skipped and sections are still fading in.
      if (AXE_SOURCE) await sleep(1500);
      await assertAxeClean(client, "index");
      assert.equal(await client.text("#sidePortfolioCount"), "5");
      assert.equal(await client.eval(`document.querySelectorAll('meta[name="theme-color"]').length`), 1);
      assert.equal(await client.eval(`document.querySelector('meta[name="theme-color"]').content`), "#ffffff");
      await assertLight(client, "index.html", light);
      await noHorizontalScroll(client, "index");
      await client.shot(shots, `${width}-index`);
    });

    await step("no personal data is stored in the browser; old cached portfolio cannot return", async () => {
      await client.eval(`localStorage.setItem("ilay_portfolio_list_v5", JSON.stringify(["https://images.unsplash.com/photo-1622287162716-f311baa1a2b8?w=600","a","b","c","d","e"])); localStorage.setItem("ilay_logged_client_v1", '{"username":"x","phone":"0500000000"}'); localStorage.setItem("ilay_registered_users_v1", "[]")`);
      await client.goto(h.base + "/");
      await client.waitFor(`lastPublicVersion !== null`);
      await client.waitFor(`document.querySelectorAll("#portfolioGrid .photo-card").length === 5`);
      assert.equal(await client.eval(`document.querySelector("#portfolioGrid").innerHTML.includes("f311baa1a2b8")`), false);
      assert.deepEqual(await client.eval(`Object.keys(localStorage).filter(k => k !== "ilay_cookie_ok")`), []);
      assert.equal(await client.eval(`currentClientUser`), null);
    });

    await step("register through the sheet, with a too-short password refused first", async () => {
      await client.click("#heroPersonalBtn");
      await client.waitFor(`document.getElementById("authModal").classList.contains("open")`);
      assert.equal(await client.eval(`document.querySelectorAll('[role="tablist"], [role="tab"]').length`), 0);
      assert.equal(await client.eval(`document.getElementById("tabBtnReg").getAttribute("aria-pressed")`), "true");
      await client.eval(`switchAuthTab("log")`);
      assert.deepEqual(await client.eval(`["tabBtnReg", "tabBtnLog"].map(id => document.getElementById(id).getAttribute("aria-pressed"))`), ["false", "true"]);
      await client.eval(`switchAuthTab("reg")`);
      assert.match(await client.text("#regBox .s-consent span"), /^אני מסכים\/ה לתנאי השימוש ולמדיניות הפרטיות/);
      await assertAxeClean(client, "auth sheet", '"#authModal"');
      await client.fill("#regFullName", clientName);
      await client.fill("#regPhone", clientPhone);
      await client.fill("#regPass", "short");
      await client.click("#regConsent");
      await client.click("#regBox .s-btn--primary");
      await client.toast("8 תווים");
      assert.equal(await client.eval(`document.getElementById("regPass").placeholder`), "לפחות 8 תווים");
      await client.shot(shots, `${width}-auth`);
      await client.fill("#regPass", "client-pass-123");
      await client.click("#regBox .s-btn--primary");
      await client.waitFor(`document.getElementById("regVerifyBox").style.display === "block"`, "code step");
      assert.equal(await client.eval(`currentClientUser`), null, "no account before the code");
      await client.shot(shots, `${width}-register-code`);
      await noHorizontalScroll(client, "code step");
      const code = /\b(\d{6})\b/.exec([...h.outbox.sms].reverse().find(s => s.to === clientPhone && /קוד/.test(s.message)).message)[1];
      await client.fill("#regCode", "000000" === code ? "000001" : "000000");
      await client.click("#regVerifyBox .s-btn--primary");
      await client.toast("הקוד שגוי");
      await client.fill("#regCode", code);
      await client.click("#regVerifyBox .s-btn--primary");
      await client.waitFor(`currentClientUser && document.getElementById("sec-personal").style.display === "block"`, "personal area opens");
      const cookieVisible = await client.eval(`document.cookie`);
      assert.equal(cookieVisible, "", "session cookie is HttpOnly");
      assert.equal(await client.eval(`document.getElementById("personalCardPhone").textContent`), clientPhone);
    });

    await step("book a slot; the note and name stay inert", async () => {
      await client.click(".service-card .srv-book");
      await client.waitFor(`document.getElementById("bookingModal").classList.contains("open")`);
      await client.eval(pickNextDay);
      await client.eval(`document.querySelectorAll("#bookingHoursGrid .hour-chip:not(.taken)")[2].click()`);
      await client.fill("#clientNoteInput", notePayload);
      await client.shot(shots, `${width}-booking`);
      await noHorizontalScroll(client, "booking sheet");
      await client.click("#confirmBookingBtn");
      await client.toast("התור נקבע");
      await client.waitFor(`document.querySelectorAll("#personalFutureApptsList .client-appt-card").length === 1`);
      assert.equal(await client.eval(`window.__xss`), undefined);
      assert.equal(await client.eval(`document.querySelectorAll("#personalWelcomeTitle img, .appt-service img").length`), 0);
      assert.ok(h.outbox.sms.some(s => s.to === clientPhone && /נקבע/.test(s.message)));
      await client.shot(shots, `${width}-personal`);
    });

    await step("booking sheet exposes taken and selected slots to screen readers and keeps keyboard focus", async () => {
      await client.eval(`openBookingModal(0)`);
      // The sheet moves focus to its close button just after opening; the choices below come after that.
      await client.waitFor(`document.activeElement === document.querySelector("#bookingModal .modal-close")`, "sheet takes focus");
      const chosen = await client.eval(pickNextDay);
      const dayState = await client.eval(`[...document.querySelectorAll("#bookingDaysRow .day-chip")].map(b => [b.dataset.date, b.getAttribute("aria-pressed")])`);
      assert.deepEqual(dayState.filter(d => d[1] === "true").map(d => d[0]), [chosen]);
      assert.equal(await client.eval(`document.activeElement === document.querySelector("#bookingDaysRow .day-chip.active")`), true, "focus stays on the chosen day");
      const taken = await client.eval(`(() => { const b = document.querySelector("#bookingHoursGrid .hour-chip.taken"); return b && { disabled: b.disabled, label: b.getAttribute("aria-label"), text: b.textContent, pressed: b.getAttribute("aria-pressed") }; })()`);
      assert.ok(taken, "own booking shows as a taken slot");
      assert.equal(taken.disabled, true);
      assert.equal(taken.label, taken.text + ", לא זמין");
      assert.equal(taken.pressed, null);
      assert.equal(await client.eval(`[...document.querySelectorAll("#bookingHoursGrid .hour-chip.taken")].every(b => b.disabled)`), true);
      assert.equal(await client.eval(`[...document.querySelectorAll("#bookingHoursGrid .hour-chip:not(.taken)")].every(b => !b.disabled && b.getAttribute("aria-pressed") === "false")`), true);
      await client.eval(`document.querySelector("#bookingHoursGrid .hour-chip.taken").click()`);
      assert.equal(await client.eval(`selectedBookHour`), null, "a taken slot cannot be chosen");
      await client.eval(`document.querySelector("#bookingHoursGrid .hour-chip:not(.taken)").click()`);
      assert.equal(await client.eval(`document.querySelector("#bookingHoursGrid .hour-chip.active").getAttribute("aria-pressed")`), "true");
      assert.equal(await client.eval(`document.activeElement === document.querySelector("#bookingHoursGrid .hour-chip.active")`), true, "focus stays on the chosen hour");
      assert.match(await client.eval(`getComputedStyle(document.querySelector("#bookingHoursGrid .hour-chip.active"), "::before").content`), /✓/, "selection has a non-colour cue");
      await assertAxeClean(client, "booking sheet", '"#bookingModal"');
      await client.shot(shots, `${width}-booking-a11y`);
      await client.eval(`closeBookingModal(); selectedBookHour = null`);
    });

    await step("a visitor sees the slot as taken, with no personal data in the page state", async () => {
      await other.goto(h.base + "/");
      await other.waitFor(`lastPublicVersion !== null`);
      const appts = await other.eval(`appointments`);
      assert.equal(appts.length, 1);
      assert.equal(appts[0].busy, true);
      assert.equal(appts[0].name, undefined);
      assert.equal(appts[0].phone, undefined);
      assert.deepEqual(await other.eval(`[registeredUsers.length, smsLogs.length]`), [0, 0]);
    });

    await step("admin login is server-side: wrong password refused, right password opens the calendar", async () => {
      await adminPage.goto(adminUrl);
      await adminPage.waitFor(`document.getElementById("loginScreen")`);
      assert.equal(await adminPage.eval(`document.getElementById("adminApp").classList.contains("authenticated")`), false);
      await assertLight(adminPage, "admin.html (login)", light);
      await adminPage.shot(shots, `${width}-admin-login`);
      await adminPage.eval(`localStorage.setItem("ilay_saved_admin_label", "bypass")`);
      await adminPage.goto(adminUrl);
      await sleep(300);
      assert.equal(await adminPage.eval(`document.getElementById("adminApp").classList.contains("authenticated")`), false, "the old localStorage label must not open anything");
      assert.equal(await adminPage.eval(`typeof SECURE_ADMINS`), "undefined");
      await adminPage.fill("#barberUser", "testadmin");
      await adminPage.fill("#barberPass", "nope-nope");
      await adminPage.click(".login-box .adm-btn--primary");
      await adminPage.waitFor(`document.getElementById("loginError").style.display === "block"`);
      await adminPage.fill("#barberUser", "testadmin");
      await adminPage.fill("#barberPass", "test-admin-pass-1");
      await adminPage.click(".login-box .adm-btn--primary");
      await adminPage.waitFor(`document.getElementById("adminApp").classList.contains("authenticated") && adminSnapshot`);
      // One tab for appointments and hours, open first, on today.
      assert.equal(await adminPage.eval(`document.getElementById("tab-day").style.display`), "");
      assert.equal(await adminPage.eval(`document.getElementById("tabbtn-day").classList.contains("active")`), true);
      assert.equal(await adminPage.text("#tabbtn-day .tab-label"), "תורים ושעות");
      assert.deepEqual(await adminPage.eval(`[...document.querySelectorAll(".admin-tab-btn .tab-label")].map(e => e.textContent)`), ["תורים ושעות", "הכנסות", "הודעות", "תמונות", "מחירון"]);
      assert.equal(await adminPage.eval(`document.querySelector('#dateStrip [aria-pressed="true"]').dataset.date === ilToday()`), true);
      assert.equal(await adminPage.eval(`["#calendarBoard", "#tab-hours", "#tab-cal", ".stat-rev-card", ".cal-legend", "#availGrid", ".adm-add-btn"].every(s => !document.querySelector(s))`), true, "the old screens are gone");
      await adminPage.eval(`selectDay(appointments[0].date)`);
      await adminPage.waitFor(`document.querySelectorAll("#dayApptList .dv-appt").length === 1`, "appointment in the list");
      assert.equal(await adminPage.eval(`window.__xss`), undefined);
      assert.equal(await adminPage.eval(`document.querySelectorAll("#dayApptList img").length`), 0);
      assert.equal(await adminPage.eval(`appointments[0].price`), 70);
      assert.match(await adminPage.text("#dayApptList .dv-appt__svc"), /70 ₪/);
      assert.equal(await adminPage.text("#dayApptList .status-pill"), "מחכה לאישור");
      assert.match(await adminPage.eval(`document.querySelector('#dayApptList a.dv-act').getAttribute("href")`), new RegExp("^tel:" + clientPhone + "$"));
      await assertLight(adminPage, "admin.html", light);
      await noHorizontalScroll(adminPage, "admin");
      await adminPage.shot(shots, `${width}-admin-day`);
    });

    await step("client confirms arrival; admin sees it through polling, with the live notification", async () => {
      await adminPage.eval(`window.__tone = 0; const _t = playAlertTone; playAlertTone = () => { window.__tone++; _t(); }; 0`);
      await client.click(".btn-confirm-arrival");
      await client.toast("אישרת הגעה");
      await adminPage.eval(`pollAdminVersion()`);
      await adminPage.waitFor(`appointments[0].status === "confirmed"`);
      await adminPage.waitFor(`document.querySelector("#dayApptList .dv-appt.is-confirmed")`);
      assert.equal(await adminPage.text("#dayApptList .status-pill"), "אושר");
      assert.ok(await adminPage.eval(`window.__tone >= 1`), "alert tone played");
      await adminPage.toast("אישור הגעה התקבל");
      assert.ok(await adminPage.eval(`Number(document.getElementById("notifUnreadBadge").textContent) >= 1`));
    });

    await step("admin confirms in the list, returns to waiting; the client sees it after polling", async () => {
      await adminPage.click("#dayApptList .dv-undo");
      await adminPage.waitFor(`appointments[0].status === "pending" && adminSnapshot.appointments[0].status === "pending"`);
      await adminPage.waitFor(`document.querySelector("#dayApptList .dv-confirm")`, "the confirm button is back");
      await adminPage.click("#dayApptList .dv-confirm");
      await adminPage.toast("התור אושר");
      await adminPage.waitFor(`adminSnapshot.appointments[0].status === "confirmed"`);
      await adminPage.click("#dayApptList .dv-undo");
      await adminPage.toast("התור חזר להמתנה");
      await adminPage.waitFor(`adminSnapshot.appointments[0].status === "pending"`);
      await client.eval(`pollPublicSite()`);
      await client.waitFor(`document.querySelector(".btn-confirm-arrival")`, "client can confirm again");
    });

    await step("client moves the appointment; old slot frees and admin sees the new time", async () => {
      const oldTime = await client.eval(`appointments.find(a => !a.busy).time`);
      await client.eval(`document.querySelector("#personalFutureApptsList .btn-glass").click()`);
      await client.waitFor(`document.getElementById("bookingModal").classList.contains("open") && editingApptId`);
      await client.eval(`document.querySelectorAll("#bookingHoursGrid .hour-chip:not(.taken)")[4].click()`);
      await client.click("#confirmBookingBtn");
      await client.toast("מועד התור עודכן");
      const newTime = await client.eval(`appointments.find(a => !a.busy).time`);
      assert.notEqual(newTime, oldTime);
      await adminPage.eval(`pollAdminVersion()`);
      await adminPage.waitFor(`appointments[0].time === ${JSON.stringify(newTime)}`);
      assert.ok(h.outbox.sms.some(s => s.to === clientPhone && /עודכן/.test(s.message)));
    });

    await step("admin moves it with the move sheet; the client gets the SMS", async () => {
      const a = await adminPage.eval(`({ id: appointments[0].id, date: appointments[0].date, time: appointments[0].time })`);
      await adminPage.eval(`selectDay(${JSON.stringify(a.date)})`);
      await adminPage.click(`[data-fk="move-${a.id}"]`);
      await adminPage.waitFor(`document.getElementById("moveSheet").classList.contains("open")`);
      assert.equal(await adminPage.eval(`document.getElementById("moveSaveBtn").disabled`), true, "no time chosen yet");
      assert.equal(await adminPage.eval(`document.querySelector('#moveTimes [data-time="${a.time}"]').disabled`), true, "its own time is not offered");
      const target = await adminPage.eval(`[...document.querySelectorAll("#moveTimes .dv-time:not(:disabled)")].map(b => b.dataset.time).find(t => t >= "11:00")`);
      assert.ok(target);
      await adminPage.click(`#moveTimes [data-time="${target}"]`);
      assert.match(await adminPage.text("#moveSaveBtn"), new RegExp(target));
      await adminPage.click("#moveSaveBtn");
      await adminPage.toast("הוזז ונשלח SMS");
      assert.equal(await adminPage.eval(`adminSnapshot.appointments[0].time`), target);
      assert.ok(h.outbox.sms.some(s => s.to === clientPhone && /הוזז/.test(s.message)));
      await client.eval(`pollPublicSite()`);
      await client.waitFor(`appointments.find(a => !a.busy).time === ${JSON.stringify(target)}`);
    });

    await step("a stale tab trying to book a taken slot gets a clear message, and the slot is marked", async () => {
      const a = await adminPage.eval(`({ date: appointments[0].date, time: appointments[0].time })`);
      await other.eval(`busySlots = []; rebuildClientAppointments(); 0`);
      await other.click(".service-card .srv-book");
      await other.waitFor(`document.getElementById("authModal").classList.contains("open")`);
      await other.fill("#regFullName", "מיכל לוי");
      await other.fill("#regPhone", "0526667788");
      await other.fill("#regPass", "other-pass-123");
      await other.click("#regConsent");
      await submitRegistration(other, h, "0526667788");
      await other.waitFor(`document.getElementById("bookingModal").classList.contains("open")`, "booking opens after login");
      await other.eval(`busySlots = []; rebuildClientAppointments(); selectedBookDate = ${JSON.stringify(a.date)}; selectedBookHour = ${JSON.stringify(a.time)}; 0`);
      await other.click("#confirmBookingBtn");
      await other.toast("נתפסה");
      assert.equal(await other.eval(`isSlotTaken(${JSON.stringify(a.date)}, ${JSON.stringify(a.time)})`), true);
      await other.eval(`closeBookingModal()`);
    });

    await step("client cancels; admin sees it canceled and the slot is free again", async () => {
      await client.eval(`document.querySelector("#personalFutureApptsList .btn-glass.is-danger").click()`);
      await client.toast("התור בוטל");
      await client.waitFor(`document.querySelectorAll("#personalFutureApptsList .client-appt-card").length === 0`);
      await adminPage.eval(`pollAdminVersion()`);
      await adminPage.waitFor(`appointments[0].status === "canceled"`);
      await adminPage.waitFor(`document.getElementById("showCanceledRow").hidden === false`, "the small toggle appears");
      assert.equal(await adminPage.eval(`document.querySelector("#dayApptList .dv-appt.is-canceled")`), null, "canceled ones stay out of the way");
      assert.match(await adminPage.text("#dayApptList"), /אין תורים/);
      await adminPage.click("#showCanceledInDay");
      await adminPage.waitFor(`document.querySelector("#dayApptList .dv-appt.is-canceled")`);
      assert.equal(await adminPage.text("#dayApptList .status-pill"), "בוטל");
      await adminPage.click("#showCanceledInDay");
    });

    await step("admin price edit reaches the site, the price range and the next booking", async () => {
      await adminPage.eval(`switchTab("edit")`);
      await adminPage.fill("#sp_0", "88");
      await adminPage.shot(shots, `${width}-admin-edit`);
      await adminPage.click(".adm-save");
      await adminPage.toast("המחירון והכותרות נשמרו");
      await client.goto(h.base + "/");
      await client.waitFor(`lastPublicVersion !== null && currentClientUser`, "client session survives a reload");
      assert.match(await client.text("#publicServicesGrid .srv-price-badge"), /88/);
      assert.match(await client.text("#heroPriceRange"), /80–100/);
      assert.match(await client.text("#footerPriceRange"), /80–100/);
      await client.click(".service-card .srv-book");
      await client.waitFor(`document.getElementById("bookingModal").classList.contains("open")`);
      assert.match(await client.text("#modalServiceTitle"), /88/);
      await client.eval(pickNextDay);
      await client.eval(`document.querySelectorAll("#bookingHoursGrid .hour-chip:not(.taken)")[0].click()`);
      await client.click("#confirmBookingBtn");
      await client.toast("התור נקבע");
      await client.waitFor(`myAppointments.some(a => a.status !== "canceled" && a.price === 88)`);
    });

    await step("open a date in the admin, the public sees it and books it; once closed it is offered no more", async () => {
      const today = await adminPage.eval("ilToday()");
      // A Saturday far enough ahead: closed by the seeded weekly rules, and past the appointments above.
      let n = 8;
      const addDays = (d, k) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + k)).toISOString().slice(0, 10); };
      while (new Date(addDays(today, n) + "T12:00:00Z").getUTCDay() !== 6) n++;
      const date = addDays(today, n);
      const chipSel = `#dateStrip [data-date="${date}"]`;
      const pick = (sel, value) => adminPage.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      const clearToast = () => adminPage.eval(`document.getElementById("toastPopup").textContent = ""`);
      const saved = async fn => { await clearToast(); await fn(); await adminPage.toast("נשמר"); };
      const answer = async yes => {
        await adminPage.waitFor(`document.getElementById("confirmSheet").classList.contains("open")`, "the warning opens");
        await adminPage.click(yes ? "#confirmYes" : "#confirmNo");
        await adminPage.waitFor(`!document.getElementById("confirmSheet").classList.contains("open")`);
      };
      const key = (k, sel = "document.activeElement") => adminPage.eval(sel + ".dispatchEvent(new KeyboardEvent('keydown', { key: '" + k + "', bubbles: true, cancelable: true }))");

      // The tab at first sight.
      await adminPage.eval("switchTab('day'); selectDay(ilToday())");
      assert.equal(await adminPage.text("#ttl-day"), "תורים ושעות");
      await noHorizontalScroll(adminPage, "day tab");
      assert.equal(await adminPage.eval("document.querySelectorAll('#weeklyRows .hrs-row').length"), 7);
      assert.equal(await adminPage.eval("document.getElementById('weeklyDetails').open"), width >= 1100, "the weekly section starts collapsed on a phone");
      assert.equal(await adminPage.text(".dv-weekly__txt strong"), "פתיחה קבועה כל שבוע");
      assert.equal(await adminPage.eval("[...document.querySelectorAll('.dv-chip, .dv-switch, #dayStart, #dayEnd, #addApptBtn, #stripPrev, #stripNext, #stripToday, .dv-jump, .dv-weekly__sum, .dv-act, .dv-confirm, #slotIntervalSelect, #slotBufferSelect')].filter(el => el.offsetParent).every(el => el.offsetHeight >= 44 && el.offsetWidth >= 44)"), true, "44px targets");
      assert.equal(await adminPage.text("#dayListTitle"), "התורים של היום");
      assert.match(await adminPage.text("#dateStrip .dv-chip .dv-chip__w"), /^היום$/);
      assert.match(await adminPage.text("#stripMonth"), /^[א-ת]+ \d{4}$/);
      await adminPage.shot(shots, width + "-admin-day-today");
      await assertAxeClean(adminPage, "day tab", '"#tab-day"');

      // Keyboard: arrows move through dates, right to left, and only one date is in the Tab order.
      await adminPage.eval("document.querySelector('#dateStrip [tabindex=\"0\"]').focus()");
      assert.equal(await adminPage.eval("document.querySelectorAll('#dateStrip [tabindex=\"0\"]').length"), 1);
      await key("ArrowLeft");
      assert.equal(await adminPage.eval("document.activeElement.dataset.date"), addDays(today, 1), "left is the next day");
      assert.equal(await adminPage.eval("currentDate()"), addDays(today, 1), "the choice drives the screen");
      await key("ArrowRight");
      assert.equal(await adminPage.eval("document.activeElement.dataset.date"), today);
      await key("ArrowRight");
      assert.equal(await adminPage.eval("document.activeElement.dataset.date"), today, "cannot walk into the past");
      assert.match(await adminPage.eval("document.activeElement.getAttribute('aria-label')"), /^היום, .*, \d+ ב.* \d{4}, (פתוח|סגור), /);

      // Previous and next move the strip, and "today" comes back.
      assert.equal(await adminPage.eval("document.getElementById('stripPrev').disabled"), true);
      await adminPage.eval("document.getElementById('dateStrip').style.scrollBehavior = 'auto'; moveStrip(1)");
      await adminPage.waitFor("Math.abs(document.getElementById('dateStrip').scrollLeft) > 10", "the strip moves");
      await adminPage.waitFor("!document.getElementById('stripPrev').disabled");
      await adminPage.click("#stripToday");
      assert.equal(await adminPage.eval("currentDate()"), today);

      // "Choose a date" jumps ahead; an untouched date is closed, in words.
      await pick("#dayJumpInput", date);
      await adminPage.waitFor("currentDate() === " + JSON.stringify(date));
      assert.equal(await adminPage.text(chipSel + " .dv-chip__st"), "סגור", "untouched date is closed");
      assert.match(await adminPage.eval("document.querySelector(" + JSON.stringify(chipSel) + ").getAttribute('aria-label')"), /, סגור, אין תורים$/);
      assert.equal(await adminPage.text("#dayOpenLabel"), "מוצ״ש סגור ללקוחות");
      assert.equal(await adminPage.eval("document.getElementById('dayOpenSwitch').checked"), false);
      assert.equal(await adminPage.eval("document.getElementById('dayHours').offsetParent"), null, "no hours on a closed day");
      assert.equal(await adminPage.eval("document.getElementById('dayResetLink').offsetParent"), null, "nothing to go back from");
      assert.match(await adminPage.text("#dayApptList .dv-empty"), /אין תורים ביום הזה/);
      await noHorizontalScroll(adminPage, "closed day");
      await adminPage.shot(shots, width + "-admin-day-closed");

      // Open it with the one big switch: saved at once, in plain words.
      await saved(() => adminPage.click("#dayOpenSwitch"));
      await adminPage.waitFor("availability.dates[" + JSON.stringify(date) + "] && availability.dates[" + JSON.stringify(date) + "].open === true");
      assert.equal(await adminPage.text("#dayOpenLabel"), "מוצ״ש פתוח ללקוחות");
      assert.equal(await adminPage.text("#dayStatus"), "לקוחות יכולים לקבוע בין 10:00 ל-20:00");
      assert.equal(await adminPage.text(chipSel + " .dv-chip__st"), "פתוח");
      assert.equal(await adminPage.text("#dayResetLink"), "חזרה להגדרה השבועית");
      assert.ok(await adminPage.eval("document.getElementById('dayResetLink').offsetHeight >= 44 && document.getElementById('dayResetLink').offsetParent"), "the way back appears");

      // Bad hours are refused in place, nothing is saved, and a poll does not wipe them.
      await saved(() => pick("#dayStart", "18:00"));
      await pick("#dayEnd", "12:00");
      await adminPage.waitFor("!document.getElementById('dayHoursError').hidden");
      assert.equal(await adminPage.eval("availability.dates[" + JSON.stringify(date) + "].end"), "20:00", "nothing saved");
      await adminPage.eval("refreshAdminState({ fromPoll: true })");
      assert.equal(await adminPage.eval("document.getElementById('dayEnd').value"), "12:00", "what was chosen stays");
      await pick("#dayStart", "12:00");
      assert.equal(await adminPage.eval("document.getElementById('dayHoursError').hidden"), false);
      await saved(() => pick("#dayEnd", "14:00"));
      await adminPage.waitFor("document.getElementById('dayStatus').textContent === 'לקוחות יכולים לקבוע בין 12:00 ל-14:00'");
      assert.equal(await adminPage.eval("document.getElementById('dayHoursError').hidden"), true);
      assert.match(await adminPage.eval("document.querySelector(" + JSON.stringify(chipSel) + ").getAttribute('aria-label')"), /פתוח, אין תורים$/);

      // The public site offers it, and the customer books it.
      await other.goto(h.base + "/");
      await other.waitFor("lastPublicVersion !== null && currentClientUser");
      await other.waitFor("!actionInFlight");
      await other.waitFor("!document.getElementById('welcomeSplash') || document.getElementById('welcomeSplash').classList.contains('hide')", "splash closes");
      await other.eval("openBookingModal(0)");
      await other.waitFor("document.getElementById('bookingModal').classList.contains('open')");
      const chip = "#bookingDaysRow [data-date=\"" + date + "\"]";
      await other.waitFor("document.querySelector(" + JSON.stringify(chip) + ")", "the new date is offered");
      assert.match(await other.text(chip), /מוצ״ש/);
      assert.equal(await other.eval("[...document.querySelectorAll('#bookingDaysRow .day-chip')].every(b => b.offsetHeight >= 44)"), true);
      await noHorizontalScroll(other, "booking sheet with many days");
      await other.click(chip);
      assert.deepEqual(await other.eval("[...document.querySelectorAll('#bookingHoursGrid .hour-chip')].map(b => b.textContent)"), ["12:00", "12:30", "13:00", "13:30"]);
      await other.shot(shots, width + "-booking-days");
      await assertAxeClean(other, "booking sheet with dates", '"#bookingModal"');
      await other.click("#bookingHoursGrid .hour-chip");
      await other.click("#confirmBookingBtn");
      await other.toast("התור נקבע");
      await other.waitFor("myAppointments.some(a => a.date === " + JSON.stringify(date) + ")");

      // The booking reaches the list and the strip.
      await adminPage.eval("pollAdminVersion()");
      await adminPage.waitFor("document.querySelectorAll('#dayApptList .dv-appt').length === 1", "the booking is in the list");
      assert.equal(await adminPage.text(chipSel + " .dv-chip__n"), "תור אחד");

      // Add one by phone: the date comes filled in, and the taken hour cannot be chosen.
      await adminPage.eval("document.getElementById('addApptBtn').focus()");
      await adminPage.click("#addApptBtn");
      await adminPage.waitFor("document.getElementById('manualAddModal').classList.contains('open')");
      await adminPage.waitFor("document.activeElement.id === 'manualNameInput'", "focus moves into the sheet");
      assert.equal(await adminPage.eval("document.getElementById('manualDateInput').value"), date);
      assert.deepEqual(await adminPage.eval("(o => [o.disabled, o.textContent])(document.querySelector('#manualHourSelect option[value=\"12:00\"]'))"), [true, "12:00 (תפוס)"]);
      assert.equal(await adminPage.eval("document.getElementById('manualHourSelect').value"), "12:30", "the first free hour inside the opening hours");
      assert.equal(await adminPage.eval("document.getElementById('manualClosedWarning').hidden"), true);
      await noHorizontalScroll(adminPage, "manual sheet");
      await key("Escape");
      assert.equal(await adminPage.eval("document.getElementById('manualAddModal').classList.contains('open')"), false, "Escape closes it");
      await adminPage.waitFor("document.activeElement.id === 'addApptBtn'", "focus returns");
      await adminPage.click("#addApptBtn");
      await adminPage.waitFor("document.getElementById('manualAddModal').classList.contains('open')");
      await adminPage.eval("document.getElementById('manualHourSelect').value = '13:00'; document.getElementById('manualHourSelect').dispatchEvent(new Event('change', { bubbles: true }))");
      assert.equal(await adminPage.eval("[...document.querySelectorAll('#manualAddModal input, #manualAddModal select, #manualAddModal button')].every(el => el.offsetHeight >= 44)"), true, "44px targets in the sheet");
      await adminPage.fill("#manualNameInput", "לקוח מהטלפון");
      await adminPage.fill("#manualPhoneInput", "0528887765");
      await assertAxeClean(adminPage, "add sheet", '"#manualAddModal"');
      await adminPage.click("#manualSaveBtn");
      await adminPage.toast("התור נוסף");
      await adminPage.waitFor("adminSnapshot.appointments.some(a => a.phone === '0528887765')");
      assert.deepEqual(await adminPage.eval("[...document.querySelectorAll('#dayApptList .dv-appt__time')].map(e => e.textContent)"), [await adminPage.eval("appointments.filter(a => a.date === " + JSON.stringify(date) + ").map(a => a.time).sort()[0]"), "13:00"], "sorted by time");
      await noHorizontalScroll(adminPage, "day with appointments");
      await adminPage.shot(shots, width + "-admin-day-list");

      // Move sheet: only this day's real slots, taken ones say so, Escape and the focus trap work.
      const phoneId = await adminPage.eval("appointments.find(a => a.phone === '0528887765').id");
      const customerTime = await adminPage.eval("appointments.find(a => a.date === " + JSON.stringify(date) + " && a.phone !== '0528887765').time");
      await adminPage.eval(`document.querySelector('[data-fk="move-${phoneId}"]').focus()`);
      await adminPage.click(`[data-fk="move-${phoneId}"]`);
      await adminPage.waitFor("document.getElementById('moveSheet').classList.contains('open')");
      await adminPage.waitFor("document.activeElement.id === 'moveDateInput'", "focus moves into the sheet");
      assert.deepEqual(await adminPage.eval("[...document.querySelectorAll('#moveTimes .dv-time')].map(b => b.dataset.time)"), ["12:00", "12:30", "13:00", "13:30"], "only valid times");
      assert.deepEqual(await adminPage.eval(`(b => [b.disabled, b.getAttribute("aria-label")])(document.querySelector('#moveTimes [data-time="${customerTime}"]'))`), [true, customerTime + ", תפוס"]);
      assert.equal(await adminPage.eval("document.querySelector('#moveTimes [data-time=\"13:00\"]').disabled"), true);
      await adminPage.eval("[...document.querySelectorAll('#moveSheet button, #moveSheet input')].filter(el => el.offsetParent && !el.disabled).pop().focus()");
      await key("Tab");
      assert.equal(await adminPage.eval("document.getElementById('moveSheet').contains(document.activeElement)"), true, "focus trap");
      await noHorizontalScroll(adminPage, "move sheet");
      await adminPage.shot(shots, width + "-admin-move-sheet");
      await assertAxeClean(adminPage, "move sheet", '"#moveSheet"');
      await key("Escape");
      assert.equal(await adminPage.eval("document.getElementById('moveSheet').classList.contains('open')"), false);
      await adminPage.waitFor(`document.activeElement.dataset.fk === "move-${phoneId}"`, "focus returns to the button");
      await adminPage.click(`[data-fk="move-${phoneId}"]`);
      await adminPage.waitFor("document.getElementById('moveSheet').classList.contains('open')");
      // Another date with no opening: warned in place, with no time taken away.
      await pick("#moveDateInput", addDays(date, 7));
      await adminPage.waitFor("!document.getElementById('moveNotice').hidden");
      assert.match(await adminPage.text("#moveNotice"), /סגור ללקוחות/);
      await pick("#moveDateInput", date);
      await adminPage.waitFor("document.getElementById('moveNotice').hidden");
      await adminPage.click('#moveTimes [data-time="13:30"]');
      await adminPage.click("#moveSaveBtn");
      await adminPage.toast("הוזז ונשלח SMS");
      await adminPage.waitFor(`adminSnapshot.appointments.find(a => a.id === "${phoneId}").time === "13:30"`);

      // Cancel confirms first. Declining changes nothing; the customer hears only when it is done.
      await adminPage.click(`[data-fk="cancel-${phoneId}"]`);
      await adminPage.waitFor("document.getElementById('confirmSheet').classList.contains('open')");
      assert.match(await adminPage.text("#confirmText"), /לקוח מהטלפון/);
      await adminPage.waitFor("document.activeElement.id === 'confirmNo'", "the safe answer has the focus");
      await noHorizontalScroll(adminPage, "confirm sheet");
      await adminPage.shot(shots, width + "-admin-confirm");
      await assertAxeClean(adminPage, "confirm sheet", '"#confirmSheet"');
      await key("Escape");
      assert.equal(await adminPage.eval("document.getElementById('confirmSheet').classList.contains('open')"), false);
      assert.equal(await adminPage.eval(`adminSnapshot.appointments.find(a => a.id === "${phoneId}").status`), "pending", "Escape means no");
      await adminPage.click(`[data-fk="cancel-${phoneId}"]`);
      await answer(true);
      await adminPage.toast("בוטל");
      await adminPage.waitFor(`adminSnapshot.appointments.find(a => a.id === "${phoneId}").status === "canceled"`);
      // Removing a canceled one from the list also asks.
      await adminPage.click("#showCanceledInDay");
      await adminPage.click(`[data-fk="del-${phoneId}"]`);
      await answer(false);
      assert.ok(await adminPage.eval(`appointments.some(a => a.id === "${phoneId}")`));
      await adminPage.click(`[data-fk="del-${phoneId}"]`);
      await answer(true);
      await adminPage.waitFor(`!adminSnapshot.appointments.some(a => a.id === "${phoneId}")`);
      await adminPage.click("#showCanceledInDay");

      // Closing a day with an appointment warns in plain words, and never cancels anything.
      await adminPage.click("#dayOpenSwitch");
      await adminPage.waitFor("document.getElementById('confirmSheet').classList.contains('open')");
      assert.match(await adminPage.text("#confirmText"), /יש תור אחד/);
      assert.match(await adminPage.text("#confirmText"), /נשארים ולא מתבטלים/);
      await answer(false);
      assert.equal(await adminPage.eval("document.getElementById('dayOpenSwitch').checked"), true, "still open after no");
      assert.equal(await adminPage.eval("effectiveDay(" + JSON.stringify(date) + ").open"), true);
      await clearToast();
      await adminPage.click("#dayOpenSwitch");
      await answer(true);
      await adminPage.toast("נשמר");
      await adminPage.waitFor("!effectiveDay(" + JSON.stringify(date) + ").open");
      assert.equal(await adminPage.text(chipSel + " .dv-chip__st"), "סגור");
      assert.equal(await adminPage.text(chipSel + " .dv-chip__n"), "תור אחד");
      assert.equal(await adminPage.eval("appointments.find(a => a.date === " + JSON.stringify(date) + ").status"), "pending", "the appointment stays as it was");
      assert.equal(await adminPage.eval("document.querySelectorAll('#dayApptList .dv-appt').length"), 1);
      assert.match(await adminPage.text("#dayStatus"), /לא יכולים לקבוע/);
      await noHorizontalScroll(adminPage, "closed day with an appointment");
      await adminPage.shot(shots, width + "-admin-day-closed-appt");
      await other.eval("pollPublicSite()");
      await other.waitFor("!openDays.some(d => d.date === " + JSON.stringify(date) + ")", "no longer offered");
      await other.eval("openBookingModal(0)");
      await other.waitFor("document.querySelector('#bookingDaysRow .day-chip')");
      assert.equal(await other.eval("!!document.querySelector(" + JSON.stringify(chip) + ")"), false);
      await other.eval("closeBookingModal()");
      assert.ok(await other.eval("myAppointments.some(a => a.date === " + JSON.stringify(date) + " && a.status !== 'canceled')"), "the appointment stays");

      // Weekly section: on shows the pickers, saved at once, bad hours are refused, a poll does not wipe them.
      if (width < 1100) await adminPage.click(".dv-weekly__sum");
      assert.equal(await adminPage.eval("document.getElementById('weeklyDetails').open"), true);
      assert.equal(await adminPage.eval("document.getElementById('wk_open_6').checked"), false);
      assert.equal(await adminPage.eval("document.getElementById('wk_times_6').hidden"), true);
      await saved(() => adminPage.click("#wk_open_6"));
      assert.equal(await adminPage.eval("document.getElementById('wk_times_6').hidden"), false);
      await adminPage.waitFor("availability.weekly[6].open === true");
      await adminPage.waitFor("document.getElementById('weeklySummary').textContent.includes('בכל הימים')");
      await noHorizontalScroll(adminPage, "weekly section");
      await adminPage.eval("document.getElementById('weeklyDetails').scrollIntoView({ block: 'start', behavior: 'instant' })");
      await adminPage.shot(shots, width + "-admin-weekly");
      await assertAxeClean(adminPage, "weekly section", '"#weeklyDetails"');
      await pick("#wk_start_6", "20:00");
      await pick("#wk_end_6", "10:00");
      await adminPage.waitFor("!document.getElementById('wk_err_6').hidden");
      assert.equal(await adminPage.eval("availability.weekly[6].start"), "10:00", "bad hours are not saved");
      await adminPage.eval("refreshAdminState({ fromPoll: true })");
      assert.equal(await adminPage.eval("document.getElementById('wk_start_6').value"), "20:00", "a poll does not wipe what was chosen");
      await pick("#wk_start_6", "10:00");
      await saved(() => pick("#wk_end_6", "20:00"));
      assert.equal(await adminPage.eval("document.getElementById('wk_err_6').hidden"), true);

      // A date follows the week until it is changed: date beats week, and the link goes back.
      assert.equal(await adminPage.eval("!availability.dates[" + JSON.stringify(date) + "]"), true);
      assert.equal(await adminPage.text("#dayStatus"), "לקוחות יכולים לקבוע בין 10:00 ל-20:00");
      assert.match(await adminPage.text("#daySource"), /הקבועה של כל שבוע/);
      assert.equal(await adminPage.eval("document.getElementById('dayResetLink').offsetParent"), null);
      await saved(() => pick("#dayEnd", "16:00"));
      await adminPage.waitFor("availability.dates[" + JSON.stringify(date) + "] && availability.dates[" + JSON.stringify(date) + "].end === '16:00'");
      assert.equal(await adminPage.eval("availability.weekly[6].end"), "20:00", "the week stays as it was");
      assert.equal(await adminPage.eval("!!availability.dates[" + JSON.stringify(addDays(date, 14)) + "]"), false, "only this date changed");
      assert.equal(await adminPage.eval("effectiveDay(" + JSON.stringify(addDays(date, 14)) + ").end"), "20:00");
      assert.match(await adminPage.text("#daySource"), /לתאריך הזה בלבד/);
      assert.ok(await adminPage.eval("document.getElementById('dayResetLink').offsetParent"));
      await saved(() => adminPage.click("#dayResetLink"));
      await adminPage.waitFor("!availability.dates[" + JSON.stringify(date) + "]");
      assert.equal(await adminPage.eval("effectiveDay(" + JSON.stringify(date) + ").end"), "20:00");
      assert.equal(await adminPage.eval("document.getElementById('dayResetLink').offsetParent"), null);
      await adminPage.click("#dayOpenSwitch");
      await answer(true);
      await adminPage.waitFor("availability.dates[" + JSON.stringify(date) + "] && availability.dates[" + JSON.stringify(date) + "].open === false");
      assert.equal(await adminPage.eval("effectiveDay(" + JSON.stringify(date) + ").source"), "date", "closed on this date, open every week");
      assert.equal(await adminPage.text(chipSel + " .dv-chip__st"), "סגור");
      await saved(() => adminPage.click("#dayResetLink"));
      await adminPage.waitFor("effectiveDay(" + JSON.stringify(date) + ").open");

      // Closing a weekday with appointments warns too, and returns the switch on no.
      await adminPage.click("#wk_open_6");
      await answer(false);
      assert.equal(await adminPage.eval("document.getElementById('wk_open_6').checked && availability.weekly[6].open"), true);
      await clearToast();
      await adminPage.click("#wk_open_6");
      await answer(true);
      await adminPage.toast("נשמר");
      await adminPage.waitFor("availability.weekly[6].open === false");

      // Slots: saved at once, and the public grid follows.
      await saved(() => pick("#slotIntervalSelect", "20"));
      await adminPage.waitFor("siteConfig.slotInterval === 20");
      await saved(() => pick("#slotIntervalSelect", "30"));
      await adminPage.waitFor("adminSnapshot.siteConfig.slotInterval === 30");

      // Manual appointment on a closed day: warned, confirmed, and it does not open the day.
      await adminPage.eval("selectDay(" + JSON.stringify(addDays(date, 7)) + "); openManualAddModal(undefined, '11:00')");
      await adminPage.waitFor("!document.getElementById('manualClosedWarning').hidden");
      assert.equal(await adminPage.eval("document.getElementById('manualDateInput').value"), addDays(date, 7));
      assert.equal(await adminPage.eval("document.getElementById('manualHourSelect').value"), "11:00");
      assert.match(await adminPage.text("#manualClosedWarning"), /סגור ללקוחות/);
      await noHorizontalScroll(adminPage, "manual sheet");
      await adminPage.fill("#manualNameInput", "לקוח טלפוני");
      await adminPage.fill("#manualPhoneInput", "0528887766");
      await adminPage.click("#manualSaveBtn");
      await answer(false);
      assert.equal(await adminPage.eval("appointments.some(a => a.phone === '0528887766')"), false, "declining the warning books nothing");
      assert.equal(await adminPage.eval("document.getElementById('manualAddModal').classList.contains('open')"), true, "the sheet keeps what was typed");
      await adminPage.click("#manualSaveBtn");
      await answer(true);
      await adminPage.toast("התור נוסף");
      await adminPage.waitFor("adminSnapshot.appointments.some(a => a.phone === '0528887766' && a.date === " + JSON.stringify(addDays(date, 7)) + ")");
      assert.equal(await adminPage.eval("effectiveDay(" + JSON.stringify(addDays(date, 7)) + ").open"), false);
      await other.eval("pollPublicSite()");
      await other.waitFor("!openDays.some(d => d.date === " + JSON.stringify(addDays(date, 7)) + ")");

      // Far dates: beyond the 30 days customers see, and days gone by, which can be read but not changed.
      const farDate = addDays(date, 56); // Also a Saturday, so closed by the seeded weekly rules.
      await pick("#dayJumpInput", farDate);
      await adminPage.waitFor("currentDate() === " + JSON.stringify(farDate));
      assert.ok(await adminPage.eval("document.querySelector('#dateStrip [data-date=\"" + farDate + "\"]').getAttribute('aria-pressed') === 'true'"));
      await saved(() => adminPage.click("#dayOpenSwitch"));
      await adminPage.waitFor("effectiveDay(" + JSON.stringify(farDate) + ").open");
      assert.match(await adminPage.text("#daySource"), /30 ימים לפניו/);
      await saved(() => adminPage.click("#dayResetLink"));
      await adminPage.waitFor("!effectiveDay(" + JSON.stringify(farDate) + ").open");
      await noHorizontalScroll(adminPage, "far date");
      await pick("#dayJumpInput", addDays(today, -3));
      await adminPage.waitFor("currentDate() === " + JSON.stringify(addDays(today, -3)));
      assert.equal(await adminPage.text("#dayStatus"), "התאריך הזה כבר עבר.");
      assert.equal(await adminPage.eval("document.getElementById('daySwitchRow').offsetParent"), null);
      assert.equal(await adminPage.eval("document.getElementById('addApptBtn').offsetParent"), null);

      // A notification opens the tab on its date.
      await adminPage.eval(`adminNotifications.unshift({ id: "n_ui", title: "בדיקה", message: "x", date: ${JSON.stringify(date)}, read: false }); renderNotificationsBell(); switchTab("sms")`);
      await adminPage.click("#notifBellBtn");
      await adminPage.click("#notifListContainer .notif-item");
      await adminPage.waitFor(`document.getElementById("tab-day").style.display === "block" && currentDate() === ${JSON.stringify(date)}`);
      await adminPage.eval(`adminNotifications.shift(); selectDay(ilToday())`);
    });

    await step("the admin's other tabs render: statistics, messages, portfolio, hours", async () => {
      for (const tab of ["analytics", "sms", "portfolio", "edit", "day"]) {
        await adminPage.eval(`switchTab(${JSON.stringify(tab)})`);
        await sleep(120);
        await noHorizontalScroll(adminPage, "admin " + tab);
        await adminPage.shot(shots, `${width}-admin-${tab}`);
      }
      // The barber's phone: the seeded owner number, editable, and used by the test SMS.
      await adminPage.eval(`switchTab("sms")`);
      assert.equal(await adminPage.eval(`document.getElementById("barberPhoneInput").value`), "0542858711");
      await adminPage.fill("#barberPhoneInput", "0501112233");
      await adminPage.eval(`saveSmsSettings()`);
      await adminPage.toast("הגדרות ה-SMS נשמרו");
      await adminPage.eval(`sendTestSms()`);
      await adminPage.toast("נשלח! בדוק את הטלפון");
      assert.equal(h.outbox.sms[h.outbox.sms.length - 1].to, "0501112233");
      await adminPage.eval(`switchTab("portfolio")`);
      assert.equal(await adminPage.eval(`document.querySelectorAll("#adminPortfolioGrid .photo-card").length`), 5);
      assert.equal(await adminPage.text("#tabPhotoCount"), "5");
      assert.ok(await adminPage.eval(`window.Chart !== undefined`), "Chart.js loaded with its integrity attribute");
    });

    await step("portfolio: uploading, replacing and deleting flows to the public site", async () => {
      await adminPage.eval(`(async () => {
        const c = document.createElement("canvas"); c.width = 40; c.height = 40; c.getContext("2d").fillRect(0, 0, 40, 40);
        stagedPhotosData = [c.toDataURL("image/jpeg", 0.7)];
        await commitStagedPhotos(false);
      })()`);
      await adminPage.toast("התמונות נשמרו");
      assert.equal(await adminPage.eval(`portfolioIds.length`), 6);
      assert.match(await adminPage.eval(`portfolioList[5]`), /^\/api\/photo\/ph_/);
      await adminPage.waitFor(`document.querySelectorAll("#adminPortfolioGrid .photo-card").length === 6`);
      await client.eval(`pollPublicSite()`);
      await client.waitFor(`document.querySelectorAll("#portfolioGrid .photo-card").length === 6`);
      await client.waitFor(`(() => { const i = document.querySelectorAll("#portfolioGrid img")[5]; i.loading = "eager"; return i.complete && i.naturalWidth === 40; })()`, "uploaded image renders through CSP img-src self");
      await adminPage.eval(`deletePortfolioPhoto(0)`);
      await adminPage.toast("התמונה נמחקה");
      await client.eval(`pollPublicSite()`);
      await client.waitFor(`document.querySelectorAll("#portfolioGrid .photo-card").length === 5 && !portfolioIds.includes("def:0")`);
    });

    await step("with only uploaded photos, a fresh visitor's browser never contacts Unsplash", async () => {
      const uploaded = await adminPage.eval(`portfolioIds.filter(id => !id.startsWith("def:"))`);
      assert.equal(uploaded.length, 1);
      const r = await adminPage.eval(`savePortfolioEntries(${JSON.stringify(uploaded)}).then(r => r.ok)`);
      assert.equal(r, true);
      const fresh = await browser.newPage(width, height);
      await fresh.goto(h.base + "/");
      await fresh.waitFor(`lastPublicVersion !== null && document.querySelectorAll("#portfolioGrid .photo-card").length === 1`, "uploaded photo renders");
      await fresh.waitFor(`(() => { const i = document.querySelector("#portfolioGrid img"); return i.complete && i.naturalWidth === 40; })()`);
      await sleep(300);
      assert.ok(!fresh.hosts.has("images.unsplash.com"), "no Unsplash request: " + [...fresh.hosts]);
      assert.equal(await fresh.eval(`document.getElementById("portfolioStockNote").hidden`), true);
      assert.equal(await fresh.eval(`document.querySelector("#portfolioGrid img").hasAttribute("onerror")`), false, "a broken upload does not fall back to Unsplash");
      await adminPage.eval(`savePortfolioEntries(${JSON.stringify(["def:1", "def:2", "def:3", "def:4", ...[]])}.concat(${JSON.stringify(uploaded)})).then(r => r.ok)`);
      await client.eval(`pollPublicSite()`);
      await client.waitFor(`document.querySelectorAll("#portfolioGrid .photo-card").length === 5`);
    });

    await step("the opt-out page removes only on the button press, without login, and is noindex", async () => {
      const { tokenFor } = require("../api/_optout");
      const phone = "0527770000";
      const uid = "usr_uioptout";
      h.fake.run(["HSET", "users", uid, JSON.stringify({ id: uid, username: "לקוח דיוור", phone, phoneVerified: true, marketingOptIn: true })]);
      const stored = () => JSON.parse(h.fake.run(["HGET", "users", uid]).result);
      const page = await browser.newPage(width, height);
      await page.goto(`${h.base}/optout.html?t=${tokenFor("", phone)}`);
      assert.equal(await page.eval(`document.querySelector('meta[name="robots"]').content`), "noindex, nofollow");
      await page.waitFor(`[...document.fonts].some(f => f.status === "loaded")`, "font on the page");
      await noHorizontalScroll(page, "optout");
      await assertLight(page, "optout.html", light);
      await assertAxeClean(page, "optout");
      await sleep(200);
      assert.equal(stored().marketingOptIn, true, "opening the link changes nothing");
      await page.shot(shots, `${width}-optout`);
      await page.click("#optOutBtn");
      await page.waitFor(`document.getElementById("result").textContent.includes("הבקשה התקבלה")`);
      assert.equal(await page.eval(`document.getElementById("optOutBtn").hidden`), true);
      assert.equal(stored().marketingOptIn, false);
      assert.ok(stored().marketingOptOutAt > 0);
      await page.shot(shots, `${width}-optout-done`);
      h.fake.run(["HDEL", "users", uid]);
      const invalid = await browser.newPage(width, height);
      await invalid.goto(`${h.base}/optout.html?t=not-a-real-token`);
      await invalid.click("#optOutBtn");
      await invalid.waitFor(`document.getElementById("result").textContent.includes("הבקשה התקבלה")`, "the same generic answer");
    });

    await step("marketing checkbox works, password reset works through the sheet", async () => {
      await client.eval(`switchCategory("personal")`);
      await client.click("#personalMarketing");
      await client.toast("נרשמת לקבלת עדכונים");
      await client.eval(`document.querySelector('#sec-personal .s-personal__actions .s-btn--tinted').click()`);
      await client.toast("התנתקת");
      assert.equal(await client.eval(`currentClientUser`), null);
      await client.click("#heroPersonalBtn");
      await client.eval(`switchAuthTab("log")`);
      await client.click("#logBox .s-link");
      await client.waitFor(`document.getElementById("resetBox").style.display === "block"`);
      await client.shot(shots, `${width}-reset`);
      await client.fill("#resetPhone", clientPhone);
      await client.click("#resetBox .s-btn--tinted");
      await client.waitFor(`document.getElementById("resetStep2").style.display === "block"`);
      const sms = [...h.outbox.sms].reverse().find(s => s.to === clientPhone && /קוד/.test(s.message));
      await client.fill("#resetCode", /\b(\d{6})\b/.exec(sms.message)[1]);
      await client.fill("#resetNewPass", "new-client-pass-456");
      await client.click("#resetStep2 .s-btn--primary");
      await client.toast("הסיסמה עודכנה");
      await client.fill("#logPass", "client-pass-123");
      await client.click("#logBox .s-btn--primary");
      await client.toast("פרטי ההתחברות שגויים");
      await client.fill("#logPass", "new-client-pass-456");
      await client.click("#logBox .s-btn--primary");
      await client.waitFor(`currentClientUser && currentClientUser.marketingOptIn === true`);
    });

    await step("admin removes a customer from marketing without deleting the account", async () => {
      await adminPage.eval(`refreshAdminState()`);
      await adminPage.waitFor(`registeredUsers.some(u => u.phone === ${JSON.stringify(clientPhone)} && u.marketingOptIn === true)`);
      await adminPage.eval(`renderAllAdmin()`);
      const label = await adminPage.eval(`document.querySelector('#clubUsersContainer [onclick^="optOutClubUser"]').textContent`);
      assert.equal(label, "הסרה מדיוור");
      await adminPage.eval(`document.querySelector('#clubUsersContainer [onclick^="optOutClubUser"]').click()`);
      await adminPage.toast("הוסר מהדיוור");
      assert.equal(await adminPage.eval(`registeredUsers.find(u => u.phone === ${JSON.stringify(clientPhone)}).marketingOptIn`), false);
      assert.equal(await adminPage.eval(`document.querySelector('#clubUsersContainer [onclick^="optOutClubUser"]')`), null);
      await adminPage.eval(`switchTab("sms")`);
      await adminPage.shot(shots, `${width}-admin-sms`);
      await adminPage.eval(`switchTab("day")`);
    });

    await step("a revoked client session returns to the login sheet with a message", async () => {
      await adminPage.eval(`(() => { const i = registeredUsers.findIndex(u => u.phone === ${JSON.stringify(clientPhone)}); removeClubUser(i); })()`);
      await adminPage.waitFor(`!adminSnapshot.registeredUsers.some(u => u.phone === ${JSON.stringify(clientPhone)})`);
      await client.eval(`refreshMyData()`);
      await client.toast("נותקת מהחשבון");
      assert.equal(await client.eval(`document.getElementById("authModal").classList.contains("open")`), true);
    });

    await step("test mode: refused without admin, works with admin, and the data stay apart", async () => {
      await other.goto(h.base + "/?test=1");
      await other.waitFor(`lastPublicVersion !== null`);
      await other.toast("מצב בדיקות זמין רק");
      assert.equal(await other.eval(`!!document.getElementById("testModeBar")`), false);
      assert.equal(await other.eval(`TEST_MODE`), false);
      assert.equal(await other.eval(`localStorage.getItem("ilay_test_mode")`), null);

      const realCount = await adminPage.eval(`appointments.length`);
      await adminPage.goto(adminUrl + "?test=1");
      await adminPage.waitFor(`document.getElementById("testModeBar")`, "orange bar");
      await adminPage.waitFor(`adminSnapshot`);
      assert.equal(await adminPage.eval(`TEST_MODE`), true);
      assert.equal(await adminPage.eval(`appointments.length`), 0);
      await adminPage.shot(shots, `${width}-admin-test`);
      // The same browser, public page, in test mode.
      await adminPage.goto(h.base + "/?test=1");
      await adminPage.waitFor(`document.getElementById("testModeBar") && lastPublicVersion !== null`);
      await adminPage.click("#heroPersonalBtn");
      await adminPage.fill("#regFullName", "לקוח בדיקה");
      await adminPage.fill("#regPhone", "0529990000");
      await adminPage.fill("#regPass", "test-client-pass-1");
      await adminPage.click("#regConsent");
      await submitRegistration(adminPage, h, "0529990000");
      // The sign-in action must end first: the page ignores a second action while one is running.
      await adminPage.waitFor(`currentClientUser && !actionInFlight`);
      await adminPage.eval(`openBookingModal(0)`);
      await adminPage.eval(pickNextDay);
      await adminPage.eval(`document.querySelectorAll("#bookingHoursGrid .hour-chip:not(.taken)")[0].click()`);
      await adminPage.click("#confirmBookingBtn");
      await adminPage.toast("התור נקבע");
      assert.equal(h.fake.store.get("test:appts").value.size, 1);
      assert.equal(h.fake.run(["HGET", "idx:phone", "0529990000"]).result, null);

      // Reset in test mode, through the admin screen, with the confirm dialog accepted.
      await adminPage.goto(adminUrl);
      await adminPage.waitFor(`adminSnapshot && TEST_MODE`);
      assert.equal(await adminPage.eval(`appointments.length`), 1);
      adminPage.dialogAnswers.push(true);
      await adminPage.eval(`document.getElementById("resetClientsToo").checked = true; confirmResetCalendar()`);
      await adminPage.toast("היומן אופס");
      assert.equal(await adminPage.eval(`appointments.length + registeredUsers.length`), 0);
      assert.ok(!h.fake.store.has("test:appts"));

      await adminPage.eval(`document.querySelector("#testModeBar button").click()`);
      await adminPage.waitFor(`!document.getElementById("testModeBar") && adminSnapshot && !TEST_MODE`);
      assert.equal(await adminPage.eval(`appointments.length`), realCount);
    });

    await step("expired admin session returns to the login screen", async () => {
      [...h.fake.store.keys()].filter(k => k.startsWith("asess:")).forEach(k => h.fake.store.delete(k));
      await adminPage.eval(`pollAdminVersion()`);
      await adminPage.waitFor(`!document.getElementById("adminApp").classList.contains("authenticated")`);
      assert.equal(await adminPage.eval(`appointments.length`), 0, "private data is cleared from memory");
      await adminPage.waitFor(`document.getElementById("loginError").style.display === "block"`);
    });

    await step("legal pages are light under a dark-preferring browser and show the owner's number", async () => {
      for (const p of ["privacy", "terms", "accessibility"]) {
        await other.goto(`${h.base}/${p}.html`);
        await assertLight(other, p + ".html", light);
        await noHorizontalScroll(other, p);
        assert.ok(await other.eval(`document.body.innerHTML.includes("054-2858711")`), p + " phone");
        await other.shot(shots, `${width}-${p}`);
      }
    });

    await step("no console errors or exceptions, and only expected hosts contacted", async () => {
      // Each expected refusal above is logged by Chrome as a failed resource; everything else is a defect.
      const expected = /status of (400|401|403|409)\b/;
      for (const [name, page] of [["client", client], ["admin", adminPage], ["visitor", other]]) {
        const unexpected = page.errors.filter(e => !expected.test(e));
        assert.deepEqual(unexpected, [], name + " console");
        const local = new URL(h.base).hostname;
        const foreign = [...page.hosts].filter(x => x && x !== local && !ALLOWED_HOSTS.has(x));
        assert.deepEqual(foreign, [], name + " hosts");
      }
      assert.deepEqual(h.outbox.blocked, []);
    });
  } finally {
    await h.stop();
  }
  return light;
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = new Browser();
  await browser.launch();
  const steps = [];
  let failed = null;
  const lightResults = [];
  try {
    for (const width of [375, 1280]) lightResults.push(...await runAtWidth(browser, width, SHOTS, steps));
  } catch (err) {
    failed = err;
  }
  await browser.close();
  console.log("\nLight-mode check under emulated dark preference:");
  [...new Set(lightResults)].forEach(l => console.log("  " + l));
  console.log(`\n${steps.length} UI steps passed${failed ? ", 1 failed:\n" + (failed.stack || failed) : ", 0 failed"}`);
  process.exit(failed ? 1 : 0);
})();
