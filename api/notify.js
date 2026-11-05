// התראת פוש לספר דרך ntfy.sh. שם הערוץ נשמר במשתנה הסביבה NTFY_TOPIC ב-Vercel
// (מומלץ שם אקראי וארוך, למשל ilay-7f3k9q2m8x). מספרי טלפון מוסרים מההודעה.
const { originAllowed, rateLimited, clientIp } = require("./_guard");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  if (!originAllowed(req)) return res.status(403).json({ ok: false });
  if (rateLimited("notify:" + clientIp(req), 30)) return res.status(429).json({ ok: false });

  const topic = String(process.env.NTFY_TOPIC || "ilay_barbershop_alerts").trim();
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const strip = s => String(s || "").replace(/\+?\d[\d\s-]{7,}\d/g, "[טלפון]").replace(/[<>]/g, "").slice(0, 400);
  const title = strip(body && body.title).slice(0, 100) || "עדכון במספרה";
  const message = strip(body && body.message) || "יש עדכון חדש ביומן";

  try {
    const host = req.headers.host || "ilaybarbershops.vercel.app";
    const r = await fetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title: "💈 " + title, message, priority: 4, click: `https://${host}/admin.html` })
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch (_) {
    return res.status(502).json({ ok: false });
  }
};
