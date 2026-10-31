/* =====================================================================
   ILAY BARBERSHOP - CORE ENGINE (REALTIME SYNC, STORAGE, REVENUE & SMS)
   ===================================================================== */
const TWO_MONTHS_MS = 60 * 24 * 60 * 60 * 1000;
const DAYS_HEB = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "מוצ״ש"];
const CLOUD_TOPIC_BASE = "ilay_barbershop_gt_2026_live_v9";
const CLOUD_BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://test.mosquitto.org:8081/mqtt",
  "wss://broker.hivemq.com:8884/mqtt"
];

const DEFAULT_PORTFOLIO = [
  "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1621607512214-68297480165e?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1622286342621-4bd786c2447c?auto=format&fit=crop&w=600&q=80",
  "https://images.unsplash.com/photo-1517832607067-4db24a2ae47c?auto=format&fit=crop&w=600&q=80"
];

function sanitizeStr(str, maxLen = 120) {
  if (typeof str !== "string") return "";
  return str.slice(0, maxLen).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;").trim();
}

function toIsraeliLocalPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("972")) return "0" + digits.slice(3);
  return digits.startsWith("0") ? digits : "0" + digits;
}

function toE164Phone(rawPhone) {
  const local = toIsraeliLocalPhone(rawPhone);
  return local ? "+972" + local.slice(1) : "";
}

function getFormattedDateForDayIdx(dayIdx) {
  const now = new Date();
  let diff = Number(dayIdx) - now.getDay();
  if (diff < 0) diff += 7;
  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  return `${String(target.getDate()).padStart(2, "0")}/${String(target.getMonth() + 1).padStart(2, "0")}`;
}

function getTargetTimestamp(dayIdx, timeStr) {
  const now = new Date();
  let diff = Number(dayIdx) - now.getDay();
  if (diff < 0) diff += 7;
  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  const [hh, mm] = String(timeStr || "12:00").split(":").map(Number);
  target.setHours(hh || 12, mm || 0, 0, 0);
  return target.getTime();
}

function calcSmsParts(text) {
  const len = String(text || "").length;
  if (!len) return 0;
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

// --- שמירת תמונות קבועה ב-IndexedDB ---
const DB_NAME = "IlayBarbershopPortfolioDB";
const STORE_NAME = "portfolioStore";

function openPortfolioDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject("No IndexedDB");
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function savePortfolioLocally(list) {
  try { localStorage.setItem("ilay_portfolio_list_v5", JSON.stringify(list)); } catch (_) {}
  try {
    const db = await openPortfolioDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(list, "custom_photos");
      tx.oncomplete = () => res();
      tx.onerror = e => rej(e);
    });
  } catch (_) {}
}

async function loadPortfolioFromDB() {
  try {
    const savedLS = localStorage.getItem("ilay_portfolio_list_v5");
    if (savedLS) {
      const parsed = JSON.parse(savedLS);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  try {
    const db = await openPortfolioDB();
    return await new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get("custom_photos");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}

function compressImageFile(file) {
  return new Promise(resolve => {
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const maxDim = 540;
      let w = img.width || 480, h = img.height || 640;
      if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(objUrl);
      resolve(canvas.toDataURL("image/jpeg", 0.68));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.readAsDataURL(file);
    };
    img.src = objUrl;
  });
}

// --- טעינת נתוני מערכת ---
let siteConfig = JSON.parse(localStorage.getItem("ilay_site_cfg") || "null") || {
  title: "ILAY BARBERSHOP",
  subtitle: "תספורת נקייה, אווירה טובה וסטייל שיושב בול.",
  slotInterval: 30,
  slotBuffer: 0,
  reminderHoursBefore: 3,
  smsPackageQuota: 1000,
  ntfyTopic: "ilay_barbershop_alerts",
  barberPhone: "0542223765",
  smsProvider: "textme",
  smsSenderId: "Ilay",
  smsApiUser: "",
  smsApiKey: ""
};
if (!siteConfig.smsPackageQuota) siteConfig.smsPackageQuota = 1000;
if (!siteConfig.reminderHoursBefore) siteConfig.reminderHoursBefore = 3;
if (!siteConfig.slotInterval) siteConfig.slotInterval = 30;
if (siteConfig.slotBuffer === undefined) siteConfig.slotBuffer = 0;

let SERVICES = JSON.parse(localStorage.getItem("ilay_services_v2") || "null") || [
  { name: "תספורת קלאסי", price: 70, duration: "30 דק'", desc: "דירוג (מולט, טייפר, בארסט ועוד..) עם גזירות ואפשרות להוסיף פנס לבחירה." },
  { name: "תספורת מוגזם", price: 90, duration: "45 דק'", desc: "לא הסתפרת הרבה זמן ורוצה לעשות שינוי, תספורת גזירות מלאה." },
  { name: "תספורת קלאסי + זקן", price: 80, duration: "35 דק'", desc: "דירוג נקי (מולט, טייפר, בארסט ועוד) עם גזירות, פנס לבחירה וסידור זקן מדויק." },
  { name: "תספורת מוגזם + זקן", price: 100, duration: "50 דק'", desc: "שינוי לוק מלא בגזירות ודירוג למי שלא הסתפר הרבה זמן, כולל עיצוב וסידור זקן." }
];

let weeklySchedule = JSON.parse(localStorage.getItem("ilay_weekly_hours") || "null") || [
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "20:00" },
  { active: true, start: "10:00", end: "21:00" },
  { active: true, start: "09:00", end: "15:00" },
  { active: false, start: "19:30", end: "22:00" }
];

let appointments = JSON.parse(localStorage.getItem("ilay_appointments_clean_v1") || "[]");
let registeredUsers = JSON.parse(localStorage.getItem("ilay_registered_users_v1") || "[]");
let smsLogs = JSON.parse(localStorage.getItem("ilay_sms_logs_v1") || "[]");
let adminNotifications = JSON.parse(localStorage.getItem("ilay_admin_notifs_v1") || "[]");
let portfolioList = [...DEFAULT_PORTFOLIO];

function saveAllStateLocally() {
  localStorage.setItem("ilay_site_cfg", JSON.stringify(siteConfig));
  localStorage.setItem("ilay_services_v2", JSON.stringify(SERVICES));
  localStorage.setItem("ilay_weekly_hours", JSON.stringify(weeklySchedule));
  localStorage.setItem("ilay_appointments_clean_v1", JSON.stringify(appointments));
  localStorage.setItem("ilay_registered_users_v1", JSON.stringify(registeredUsers));
  localStorage.setItem("ilay_sms_logs_v1", JSON.stringify(smsLogs.slice(0, 300)));
  localStorage.setItem("ilay_admin_notifs_v1", JSON.stringify(adminNotifications.slice(0, 120)));
}

// --- התראות בזמן אמת (פעמון + צליל + ntfy) ---
function playAlertTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch (_) {}
}

function pushRealtimeNotification(type, title, message, apptId = null, dayIdx = null) {
  const notif = {
    id: "ntf_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    type,
    title,
    message,
    apptId,
    dayIdx,
    read: false,
    createdAt: Date.now(),
    timeStr: new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) + " " + new Date().toLocaleDateString("he-IL")
  };
  adminNotifications.unshift(notif);
  saveAllStateLocally();
  broadcastCloudState("live_notif", { notif });

  if (siteConfig.ntfyTopic) {
    try {
      fetch("https://ntfy.sh", {
        method: "POST",
        body: JSON.stringify({
          topic: siteConfig.ntfyTopic.trim(),
          title: "💈 " + title,
          message,
          priority: 4,
          click: `${window.location.origin}/admin.html`
        })
      });
    } catch (_) {}
  }
  if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
}

// --- מנוע שליחת SMS ---
async function executeProviderSms(toPhoneRaw, messageText) {
  const toE164 = toE164Phone(toPhoneRaw);
  const toLocal = toIsraeliLocalPhone(toPhoneRaw);
  const sender = (siteConfig.smsSenderId || "Ilay").trim().slice(0, 11);
  const user = (siteConfig.smsApiUser || "").trim();
  const key = (siteConfig.smsApiKey || "").trim();
  const provider = siteConfig.smsProvider || "textme";

  if (!toLocal || !key) return { ok: false, reason: "חסר מפתח API בהגדרות" };

  try {
    if (provider === "textme") {
      const xmlBody = `<?xml version="1.0" encoding="UTF-8"?><sms><user><username>${user}</username></user><source>${sender}</source><destinations><phone>${toLocal}</phone></destinations><message>${messageText}</message></sms>`;
      const headers = { "Content-Type": "application/xml", "Authorization": "Bearer " + key };
      try {
        const directRes = await fetch("https://my.textme.co.il/api", { method: "POST", headers, body: xmlBody });
        if (directRes.ok) return { ok: true, reason: "נמסר (TextMe)" };
      } catch (_) {}
      const proxyRes = await fetch("https://corsproxy.io/?https://my.textme.co.il/api", { method: "POST", headers, body: xmlBody });
      return { ok: proxyRes.ok, reason: proxyRes.ok ? "נמסר (TextMe)" : "שגיאת אימות TextMe" };
    } else if (provider === "clicksend") {
      const res = await fetch("https://rest.clicksend.com/v3/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + btoa(`${user}:${key}`) },
        body: JSON.stringify({ messages: [{ source: "javascript", from: sender, body: messageText, to: toE164 }] })
      });
      return { ok: res.ok, reason: res.ok ? "נמסר (ClickSend)" : "ClickSend Error" };
    } else if (provider === "twilio") {
      const formBody = new URLSearchParams({ To: toE164, From: sender, Body: messageText });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(user)}/Messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + btoa(`${user}:${key}`) },
        body: formBody.toString()
      });
      return { ok: res.ok, reason: res.ok ? "נמסר (Twilio)" : "Twilio Error" };
    }
  } catch (err) {
    return { ok: false, reason: err.message || "Network Error" };
  }
  return { ok: false, reason: "ספק לא נתמך" };
}

async function sendTrackedSms(toPhoneRaw, recipientName, messageText, category = "booking", apptId = null, channel = "sms") {
  const cleanPhone = toIsraeliLocalPhone(toPhoneRaw);
  const parts = channel === "whatsapp" ? 0 : calcSmsParts(messageText);
  let result = { ok: true, reason: "נשלח ב-WhatsApp" };

  if (channel === "sms") {
    result = await executeProviderSms(cleanPhone, messageText);
  }

  const logEntry = {
    id: "sms_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    phone: cleanPhone,
    name: recipientName || cleanPhone,
    message: messageText,
    category, // 'booking' | 'move' | 'cancel' | 'reminder' | 'broadcast'
    channel,
    parts,
    status: result.ok ? "sent" : "failed",
    reason: result.reason,
    apptId,
    createdAt: Date.now(),
    time: new Date().toLocaleString("he-IL")
  };

  smsLogs.unshift(logEntry);
  if (!result.ok && channel === "sms") {
    pushRealtimeNotification("sms_failed", "כישלון בשליחת SMS", `הודעה אל ${recipientName} (${cleanPhone}) נכשלה: ${result.reason}`, apptId);
  } else {
    saveAllStateLocally();
    broadcastCloudState();
    if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
  }
  return result.ok;
}

function logIncomingClientMessage(phone, name, text, category = "incoming", apptId = null) {
  smsLogs.unshift({
    id: "inc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5),
    phone: toIsraeliLocalPhone(phone),
    name,
    message: text,
    category,
    channel: "sms",
    parts: 0,
    status: "received",
    reason: "התקבל מהלקוח",
    apptId,
    createdAt: Date.now(),
    time: new Date().toLocaleString("he-IL")
  });
  saveAllStateLocally();
}

async function retryFailedSmsLog(logId) {
  const item = smsLogs.find(l => l.id === logId);
  if (!item) return false;
  const res = await executeProviderSms(item.phone, item.message);
  item.status = res.ok ? "sent" : "failed";
  item.reason = res.reason;
  item.time = new Date().toLocaleString("he-IL");
  saveAllStateLocally();
  broadcastCloudState();
  if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
  return res.ok;
}

// --- חישוב סטטיסטיקות פרקטי + חישוב מחירים והכנסות (היום, השבוע, החודש, ממוצע) ---
function computeComprehensiveAnalytics(selectedDayFilter = null) {
  const todayIdx = selectedDayFilter !== null ? Number(selectedDayFilter) : new Date().getDay();

  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  let weeklyRevenue = 0;

  const activeAppts = appointments.filter(a => a.status !== "canceled");
  activeAppts.forEach(a => {
    const d = Number(a.dayIdx);
    const price = Number(a.price) || 70;
    if (d >= 0 && d < 7) {
      dayTotals[d] += price;
      dayCounts[d] += 1;
      weeklyRevenue += price;
    }
  });

  const todayRevenue = dayTotals[todayIdx] || 0;
  const todayAppts = dayCounts[todayIdx] || 0;
  const weekAppts = activeAppts.length;
  const monthlyRevenue = Math.round(weeklyRevenue * 4.3);
  const monthAppts = Math.round(weekAppts * 4.3);

  const activeDaysCount = weeklySchedule.filter(d => d.active).length || 1;
  const avgDailyRevenue = Math.round(weeklyRevenue / activeDaysCount);
  const avgRevenuePerAppt = weekAppts ? Math.round(weeklyRevenue / weekAppts) : 0;

  const confirmedAppts = activeAppts.filter(a => a.status === "confirmed").length;
  const pendingAppts = activeAppts.filter(a => !a.status || a.status === "pending").length;
  const canceledAppts = appointments.filter(a => a.status === "canceled").length;
  const movedAppts = activeAppts.filter(a => Number(a.movedCount || 0) > 0).length;

  // לקוחות
  const totalClients = registeredUsers.length;
  const visitCountsByPhone = {};
  activeAppts.forEach(a => {
    const p = toIsraeliLocalPhone(a.phone);
    visitCountsByPhone[p] = (visitCountsByPhone[p] || 0) + 1;
  });

  // הודעות SMS
  let smsDelivered = 0, smsFailed = 0, totalPartsUsed = 0;
  const byCategory = { booking: 0, move: 0, cancel: 0, reminder: 0, broadcast: 0 };

  smsLogs.forEach(l => {
    if (l.status === "received" || l.channel === "whatsapp") return;
    if (l.status === "sent") {
      smsDelivered++;
      const p = Number(l.parts) || 1;
      totalPartsUsed += p;
      if (byCategory[l.category] !== undefined) byCategory[l.category] += p;
    } else {
      smsFailed++;
    }
  });

  const quota = Number(siteConfig.smsPackageQuota) || 1000;
  const remaining = Math.max(0, quota - totalPartsUsed);

  return {
    revenue: {
      todayRevenue,
      weeklyRevenue,
      monthlyRevenue,
      avgDailyRevenue,
      avgRevenuePerAppt,
      dayTotals,
      dayCounts
    },
    appts: {
      todayAppts,
      weekAppts,
      monthAppts,
      confirmedAppts,
      pendingAppts,
      canceledAppts,
      movedAppts,
      apptsByDay: dayCounts
    },
    clients: {
      totalClients,
      visitCountsByPhone
    },
    messages: {
      smsDelivered,
      smsFailed,
      totalPartsUsed,
      quota,
      remaining,
      byCategory
    }
  };
}

// --- תזכורות אוטומטיות ---
async function checkAndSendUpcomingReminders(forceAllPending = false) {
  const hoursBefore = Number(siteConfig.reminderHoursBefore) || 3;
  const windowMs = hoursBefore * 60 * 60 * 1000;
  const now = Date.now();
  const publicUrl = `${window.location.origin}/ilay.html#personal-area`;
  let sentCount = 0;

  for (const appt of appointments) {
    if (appt.status === "canceled" || appt.reminderSent) continue;
    const apptTimeMs = appt.startsAtMs || getTargetTimestamp(appt.dayIdx, appt.time);
    const diffMs = apptTimeMs - now;

    if ((diffMs > 0 && diffMs <= windowMs) || (forceAllPending && diffMs > 0)) {
      appt.reminderSent = true;
      const dateStr = appt.dateStr || getFormattedDateForDayIdx(appt.dayIdx);
      const dayName = DAYS_HEB[appt.dayIdx];
      const msg = `אהלן ${appt.name}, תזכורת מ-Ilay Barbershop: התור שלך ליום ${dayName} (${dateStr}) מתקיים בשעה ${appt.time}. האם אתה מאשר הגעה? לאישור הגעה מהיר היכנס לאזור האישי: ${publicUrl}`;
      await sendTrackedSms(appt.phone, appt.name, msg, "reminder", appt.id, "sms");
      sentCount++;
    }
  }

  if (sentCount > 0) {
    saveAllStateLocally();
    broadcastCloudState();
  }
  return sentCount;
}

// --- סנכרון דו-כיווני מהיר (<3 שניות) ---
const mqttClients = [];
let lastStateTs = Number(localStorage.getItem("ilay_state_ts") || 0);
let lastPortfolioTs = Number(localStorage.getItem("ilay_portfolio_ts") || 0);
const batchMetaMap = {};
const batchChunksMap = {};
const localChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("ilay_barbershop_fast_sync") : null;

function broadcastCloudState(extraTopic = null, extraPayload = null) {
  const now = Date.now();
  lastStateTs = now;
  localStorage.setItem("ilay_state_ts", String(now));
  saveAllStateLocally();

  const stateObj = {
    updatedAt: now,
    siteConfig,
    services: SERVICES,
    weeklySchedule,
    appointments,
    registeredUsers,
    smsLogs: smsLogs.slice(0, 120),
    adminNotifications: adminNotifications.slice(0, 80)
  };

  if (localChannel) {
    try { localChannel.postMessage({ type: "STATE_SYNC", data: stateObj }); } catch (_) {}
  }

  const payload = JSON.stringify(stateObj);
  mqttClients.forEach(c => {
    try {
      if (c.connected) {
        c.publish(`${CLOUD_TOPIC_BASE}/state`, payload, { qos: 1, retain: true });
        if (extraTopic && extraPayload) {
          c.publish(`${CLOUD_TOPIC_BASE}/${extraTopic}`, JSON.stringify({ updatedAt: now, ...extraPayload }), { qos: 1, retain: true });
        }
      }
    } catch (_) {}
  });
}

function broadcastPortfolioToCloud(list) {
  if (!Array.isArray(list) || !list.length) return;
  const now = Date.now();
  const batchId = "b_" + now + "_" + Math.random().toString(36).slice(2, 6);
  lastPortfolioTs = now;
  localStorage.setItem("ilay_portfolio_ts", String(now));

  if (localChannel) {
    try { localChannel.postMessage({ type: "PORTFOLIO_SYNC", list, updatedAt: now }); } catch (_) {}
  }

  const metaPayload = JSON.stringify({ batchId, updatedAt: now, count: list.length });
  mqttClients.forEach(c => {
    try {
      if (c.connected) {
        list.forEach((src, idx) => {
          c.publish(`${CLOUD_TOPIC_BASE}/photo/${idx}`, JSON.stringify({ batchId, idx, src, updatedAt: now }), { qos: 1, retain: true });
        });
        c.publish(`${CLOUD_TOPIC_BASE}/portfolio_meta`, metaPayload, { qos: 1, retain: true });
      }
    } catch (_) {}
  });
}

function tryAssemblePortfolioBatch(batchId) {
  if (!batchId || !batchMetaMap[batchId]) return;
  const meta = batchMetaMap[batchId];
  if (meta.updatedAt <= lastPortfolioTs) return;
  const chunks = batchChunksMap[batchId] || {};
  const assembled = [];
  for (let i = 0; i < meta.count; i++) {
    if (chunks[i]) assembled.push(chunks[i]);
  }
  if (assembled.length === meta.count && assembled.length > 0) {
    portfolioList = assembled;
    lastPortfolioTs = meta.updatedAt;
    localStorage.setItem("ilay_portfolio_ts", String(lastPortfolioTs));
    savePortfolioLocally(portfolioList);
    if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
  }
}

function applyIncomingState(data) {
  if (!data || !data.updatedAt || data.updatedAt <= lastStateTs) return;
  lastStateTs = data.updatedAt;
  localStorage.setItem("ilay_state_ts", String(lastStateTs));
  if (data.siteConfig) siteConfig = { ...siteConfig, ...data.siteConfig };
  if (data.services) SERVICES = data.services;
  if (data.weeklySchedule) weeklySchedule = data.weeklySchedule;
  if (Array.isArray(data.appointments)) appointments = data.appointments;
  if (Array.isArray(data.registeredUsers)) registeredUsers = data.registeredUsers;
  if (Array.isArray(data.smsLogs)) smsLogs = data.smsLogs;
  if (Array.isArray(data.adminNotifications)) adminNotifications = data.adminNotifications;
  saveAllStateLocally();
  if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated(data);
}

async function initCloudSyncEngine() {
  const dbPhotos = await loadPortfolioFromDB();
  if (dbPhotos && Array.isArray(dbPhotos) && dbPhotos.length > 0) {
    portfolioList = dbPhotos;
    if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
  }

  if (localChannel) {
    localChannel.onmessage = ev => {
      if (ev.data?.type === "STATE_SYNC") applyIncomingState(ev.data.data);
      if (ev.data?.type === "PORTFOLIO_SYNC" && Array.isArray(ev.data.list)) {
        portfolioList = ev.data.list;
        savePortfolioLocally(portfolioList);
        if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
      }
    };
  }

  window.addEventListener("storage", async () => {
    siteConfig = JSON.parse(localStorage.getItem("ilay_site_cfg") || JSON.stringify(siteConfig));
    SERVICES = JSON.parse(localStorage.getItem("ilay_services_v2") || JSON.stringify(SERVICES));
    weeklySchedule = JSON.parse(localStorage.getItem("ilay_weekly_hours") || JSON.stringify(weeklySchedule));
    appointments = JSON.parse(localStorage.getItem("ilay_appointments_clean_v1") || "[]");
    registeredUsers = JSON.parse(localStorage.getItem("ilay_registered_users_v1") || "[]");
    smsLogs = JSON.parse(localStorage.getItem("ilay_sms_logs_v1") || "[]");
    adminNotifications = JSON.parse(localStorage.getItem("ilay_admin_notifs_v1") || "[]");
    const savedP = await loadPortfolioFromDB();
    if (savedP && savedP.length) portfolioList = savedP;
    if (typeof window.onCoreDataUpdated === "function") window.onCoreDataUpdated();
  });

  if (!window.mqtt) return;
  CLOUD_BROKERS.forEach(url => {
    try {
      const client = mqtt.connect(url, { clientId: "ilay_" + Math.random().toString(16).slice(2, 10), clean: true, reconnectPeriod: 2000 });
      client.on("connect", () => client.subscribe(`${CLOUD_TOPIC_BASE}/#`, { qos: 1 }));
      client.on("message", (topic, buf) => {
        try {
          const str = buf.toString();
          if (!str) return;
          const data = JSON.parse(str);
          if (topic === `${CLOUD_TOPIC_BASE}/state`) {
            applyIncomingState(data);
          } else if (topic === `${CLOUD_TOPIC_BASE}/live_notif` && data.notif) {
            playAlertTone();
            if (typeof window.onLiveNotificationReceived === "function") window.onLiveNotificationReceived(data.notif);
          } else if (topic === `${CLOUD_TOPIC_BASE}/portfolio_meta`) {
            if (data.batchId && data.updatedAt > lastPortfolioTs) {
              batchMetaMap[data.batchId] = { count: Number(data.count) || 0, updatedAt: data.updatedAt };
              tryAssemblePortfolioBatch(data.batchId);
            }
          } else if (topic.startsWith(`${CLOUD_TOPIC_BASE}/photo/`)) {
            if (data && data.batchId && data.src) {
              if (!batchChunksMap[data.batchId]) batchChunksMap[data.batchId] = {};
              batchChunksMap[data.batchId][Number(data.idx)] = data.src;
              tryAssemblePortfolioBatch(data.batchId);
            }
          }
        } catch (_) {}
      });
      mqttClients.push(client);
    } catch (_) {}
  });

  setInterval(() => { checkAndSendUpcomingReminders(false); }, 45000);
}

// --- מנוע תלת-מימד ריאליסטי (Three.js) ---
function initRealistic3DBarberScene() {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas || !window.THREE) return;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const warmLight = new THREE.PointLight(0xffdf8e, 2.1, 35); warmLight.position.set(6, 8, 9); scene.add(warmLight);
  const coolLight = new THREE.PointLight(0x60a5fa, 1.3, 35); coolLight.position.set(-7, -5, 8); scene.add(coolLight);

  const sc = document.createElement("canvas"); sc.width = 512; sc.height = 512;
  const ctx = sc.getContext("2d"); ctx.fillStyle = "#f8fafc"; ctx.fillRect(0, 0, 512, 512);
  const drawBand = (off, col) => {
    ctx.fillStyle = col;
    for (let y = -512; y < 1024; y += 256) {
      ctx.beginPath(); ctx.moveTo(0, y + off); ctx.lineTo(512, y + 512 + off);
      ctx.lineTo(512, y + 512 + off + 68); ctx.lineTo(0, y + off + 68); ctx.closePath(); ctx.fill();
    }
  };
  drawBand(0, "#c1121f"); drawBand(128, "#1d3557");
  const poleTex = new THREE.CanvasTexture(sc);
  poleTex.wrapS = THREE.RepeatWrapping; poleTex.wrapT = THREE.RepeatWrapping; poleTex.repeat.set(1, 1.85);

  const coreMat = new THREE.MeshStandardMaterial({ map: poleTex, roughness: 0.25, metalness: 0.1 });
  const glassMat = new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, shininess: 160 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.18 });

  function makePole() {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 3.1, 40), coreMat);
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.53, 0.53, 3.14, 40), glassMat);
    const topD = new THREE.Mesh(new THREE.SphereGeometry(0.47, 32, 20), goldMat); topD.position.y = 1.72;
    const botD = new THREE.Mesh(new THREE.SphereGeometry(0.47, 32, 20), goldMat); botD.position.y = -1.72;
    g.add(core, glass, topD, botD); g.userData = { core }; return g;
  }

  const cfgs = [
    { x: -5.4, y: 1.7, z: -1.8, scale: 0.9, rotZ: 0.18 },
    { x: 5.5, y: -1.7, z: -1.4, scale: 0.94, rotZ: -0.18 }
  ];
  const poles = cfgs.map(c => { const p = makePole(); scene.add(p); return { group: p, ...c }; });

  function resize() {
    const w = window.innerWidth, h = window.innerHeight, mob = w < 680;
    camera.aspect = w / h; camera.position.z = mob ? 16.2 : 13.8; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    poles.forEach((p, i) => {
      p.group.position.set(cfgs[i].x * (mob ? 0.36 : 1), cfgs[i].y, p.z);
      p.group.scale.setScalar(p.scale * (mob ? 0.76 : 1));
      p.group.rotation.z = p.rotZ;
    });
  }
  resize(); window.addEventListener("resize", resize);

  (function anim() {
    requestAnimationFrame(anim);
    if (document.body.classList.contains("acc-no-anim")) return;
    const t = performance.now() * 0.001;
    poleTex.offset.y -= 0.0036;
    poles.forEach((p, i) => {
      p.group.userData.core.rotation.y += 0.014;
      p.group.position.y = cfgs[i].y + Math.sin(t * 1.15 + i) * 0.2;
    });
    renderer.render(scene, camera);
  })();
}
