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
const ALLOWED_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com", "images.unsplash.com", "cdnjs.cloudflare.com"]);

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
    await this.waitFor(`document.getElementById("toastPopup").textContent.includes(${JSON.stringify(expected)})`, "toast: " + expected);
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

async function noHorizontalScroll(page, name) {
  const over = await page.eval(`document.documentElement.scrollWidth - window.innerWidth`);
  assert.ok(over <= 1, `${name} scrolls sideways by ${over}px`);
}

const nextActiveDay = `(() => { const d = israelDayIdx(); let n = (d + 1) % 7; if (!weeklySchedule[n].active) n = (n + 1) % 7; return n; })()`;

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
    await step("public page loads with five photos, in light colours under a dark-preferring browser", async () => {
      await client.goto(h.base + "/");
      await client.waitFor(`typeof lastPublicVersion !== "undefined" && lastPublicVersion !== null`);
      await client.waitFor(`!document.getElementById("welcomeSplash") || document.getElementById("welcomeSplash").classList.contains("hide")`, "splash closes");
      assert.equal(await client.eval(`document.querySelectorAll("#portfolioGrid .photo-card").length`), 5);
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
      assert.equal(await client.eval(`document.querySelectorAll("#portfolioGrid .photo-card").length`), 5);
      assert.equal(await client.eval(`document.querySelector("#portfolioGrid").innerHTML.includes("f311baa1a2b8")`), false);
      assert.deepEqual(await client.eval(`Object.keys(localStorage).filter(k => k !== "ilay_cookie_ok")`), []);
      assert.equal(await client.eval(`currentClientUser`), null);
    });

    await step("register through the sheet, with a too-short password refused first", async () => {
      await client.click("#heroPersonalBtn");
      await client.waitFor(`document.getElementById("authModal").classList.contains("open")`);
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
      const day = await client.eval(nextActiveDay);
      await client.eval(`document.querySelectorAll("#bookingDaysRow .day-chip")[${day}].click()`);
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
      await adminPage.click(".day-chip--week");
      await adminPage.waitFor(`document.querySelectorAll("#calendarBoard .appt-card").length === 1`, "appointment on the board");
      assert.equal(await adminPage.eval(`window.__xss`), undefined);
      assert.equal(await adminPage.eval(`document.querySelectorAll("#calendarBoard img").length`), 0);
      assert.equal(await adminPage.eval(`appointments[0].price`), 70);
      await assertLight(adminPage, "admin.html", light);
      await noHorizontalScroll(adminPage, "admin");
      await adminPage.shot(shots, `${width}-admin-cal`);
    });

    await step("client confirms arrival; admin sees it through polling, with the live notification", async () => {
      await adminPage.eval(`window.__tone = 0; const _t = playAlertTone; playAlertTone = () => { window.__tone++; _t(); }; 0`);
      await client.click(".btn-confirm-arrival");
      await client.toast("אישרת הגעה");
      await adminPage.eval(`pollAdminVersion()`);
      await adminPage.waitFor(`appointments[0].status === "confirmed"`);
      await adminPage.waitFor(`document.querySelector("#calendarBoard .appt-card.status-confirmed")`);
      assert.ok(await adminPage.eval(`window.__tone >= 1`), "alert tone played");
      await adminPage.toast("אישור הגעה התקבל");
      assert.ok(await adminPage.eval(`Number(document.getElementById("notifUnreadBadge").textContent) >= 1`));
    });

    await step("admin toggles status back to pending; the client sees it after polling", async () => {
      await adminPage.click("#calendarBoard .appt-status");
      await adminPage.waitFor(`appointments[0].status === "pending" && adminSnapshot.appointments[0].status === "pending"`);
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

    await step("admin moves it on the board; the client gets the SMS", async () => {
      const target = await adminPage.eval(`(() => { const a = appointments[0]; const t = generateCalendarHours().find(x => x >= "11:00" && x !== a.time && !appointments.some(b => b.time === x)); moveAppointmentToSlot(a.id, a.dayIdx, t); return t; })()`);
      await adminPage.toast("הוזז ונשלח SMS");
      assert.equal(await adminPage.eval(`adminSnapshot.appointments[0].time`), target);
      assert.ok(h.outbox.sms.some(s => s.to === clientPhone && /הוזז/.test(s.message)));
      await client.eval(`pollPublicSite()`);
      await client.waitFor(`appointments.find(a => !a.busy).time === ${JSON.stringify(target)}`);
    });

    await step("a stale tab trying to book a taken slot gets a clear message, and the slot is marked", async () => {
      const a = await adminPage.eval(`({ dayIdx: appointments[0].dayIdx, time: appointments[0].time })`);
      await other.eval(`busySlots = []; rebuildClientAppointments(); 0`);
      await other.click(".service-card .srv-book");
      await other.waitFor(`document.getElementById("authModal").classList.contains("open")`);
      await other.fill("#regFullName", "מיכל לוי");
      await other.fill("#regPhone", "0526667788");
      await other.fill("#regPass", "other-pass-123");
      await other.click("#regConsent");
      await submitRegistration(other, h, "0526667788");
      await other.waitFor(`document.getElementById("bookingModal").classList.contains("open")`, "booking opens after login");
      await other.eval(`busySlots = []; rebuildClientAppointments(); selectedBookDay = ${a.dayIdx}; selectedBookHour = ${JSON.stringify(a.time)}; 0`);
      await other.click("#confirmBookingBtn");
      await other.toast("נתפסה");
      assert.equal(await other.eval(`isSlotTaken(${a.dayIdx}, ${JSON.stringify(a.time)})`), true);
      await other.eval(`closeBookingModal()`);
    });

    await step("client cancels; admin sees it canceled and the slot is free again", async () => {
      await client.eval(`document.querySelector("#personalFutureApptsList .btn-glass.is-danger").click()`);
      await client.toast("התור בוטל");
      await client.waitFor(`document.querySelectorAll("#personalFutureApptsList .client-appt-card").length === 0`);
      await adminPage.eval(`pollAdminVersion()`);
      await adminPage.waitFor(`appointments[0].status === "canceled"`);
      await adminPage.waitFor(`document.querySelector("#calendarBoard .appt-card.status-canceled")`);
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
      await client.eval(`document.querySelectorAll("#bookingDaysRow .day-chip")[${await client.eval(nextActiveDay)}].click()`);
      await client.eval(`document.querySelectorAll("#bookingHoursGrid .hour-chip:not(.taken)")[0].click()`);
      await client.click("#confirmBookingBtn");
      await client.toast("התור נקבע");
      await client.waitFor(`myAppointments.some(a => a.status !== "canceled" && a.price === 88)`);
    });

    await step("the admin's other tabs render: statistics, messages, portfolio, hours", async () => {
      for (const tab of ["analytics", "sms", "portfolio", "hours", "cal"]) {
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
      await adminPage.waitFor(`currentClientUser`);
      await adminPage.eval(`openBookingModal(0)`);
      await adminPage.eval(`document.querySelectorAll("#bookingDaysRow .day-chip")[${await adminPage.eval(nextActiveDay)}].click()`);
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
