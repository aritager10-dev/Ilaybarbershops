// Portfolio photos. Uploads are validated on the server and stored in Redis; the public endpoint
// serves raw bytes with a fixed content type. A portfolio entry is "ph_<hex>" (uploaded photo) or
// "def:N" (one of the default images listed in core.js).
const crypto = require("crypto");
const { cmd, pipeline, parseJson } = require("./_redis");
const { K, bump } = require("./_data");
const { HttpError, sendJson } = require("./_http");
const { defaultPhotoCount } = require("./_defaults");

const MAX_BYTES = 700 * 1024;
const MAX_PHOTOS = 30;
const PENDING_TTL = 3600; // An upload not yet saved into the portfolio expires by itself.
const PHOTO_RE = /^ph_[a-f0-9]{24}$/;

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

// data:image/jpeg|png|webp only, and the bytes must really be that format.
function parseImage(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_BYTES * 4 / 3) + 64) throw new HttpError(400, "התמונה גדולה מדי (עד 700KB)");
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) throw new HttpError(400, "סוג התמונה לא נתמך (JPEG, PNG או WEBP בלבד)");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_BYTES) throw new HttpError(400, "התמונה גדולה מדי (עד 700KB)");
  if (sniff(buf) !== m[1]) throw new HttpError(400, "הקובץ אינו תמונה תקינה");
  return { ct: "image/" + m[1], b64: m[2] };
}

async function uploadPhoto(ctx, dataUrl) {
  const img = parseImage(dataUrl);
  const id = "ph_" + crypto.randomBytes(12).toString("hex");
  await cmd("SET", K(ctx, `photo:${id}`), JSON.stringify(img), "EX", PENDING_TTL);
  return id;
}

async function savePortfolio(ctx, list) {
  if (!Array.isArray(list) || list.length < 1) throw new HttpError(400, "חייבת להישאר לפחות תמונה אחת בתיק");
  if (list.length > MAX_PHOTOS) throw new HttpError(400, `אפשר לשמור עד ${MAX_PHOTOS} תמונות בתיק`);
  const seen = new Set();
  list.forEach(e => {
    const defIdx = /^def:(\d+)$/.exec(String(e));
    const ok = (typeof e === "string" && PHOTO_RE.test(e)) || (defIdx && Number(defIdx[1]) < defaultPhotoCount);
    if (!ok || seen.has(e)) throw new HttpError(400, "רשימת התמונות לא תקינה");
    seen.add(e);
  });
  const ids = list.filter(e => PHOTO_RE.test(e));
  const exists = await pipeline(ids.map(id => ["EXISTS", K(ctx, `photo:${id}`)]));
  if (exists.some(n => Number(n) !== 1)) throw new HttpError(400, "אחת התמונות כבר לא קיימת, נסו להעלות שוב");
  const prev = parseJson(await cmd("GET", K(ctx, "cfg:portfolio"))) || [];
  const cmds = ids.map(id => ["PERSIST", K(ctx, `photo:${id}`)]);
  prev.filter(e => PHOTO_RE.test(e) && !seen.has(e)).forEach(id => cmds.push(["DEL", K(ctx, `photo:${id}`)]));
  cmds.push(["SET", K(ctx, "cfg:portfolio"), JSON.stringify(list)]);
  await pipeline(cmds);
  await bump(ctx);
  return list;
}

async function servePhoto(ctx, id) {
  if (!PHOTO_RE.test(id)) throw new HttpError(404, "לא נמצא");
  const img = parseJson(await cmd("GET", K(ctx, `photo:${id}`)));
  if (!img || !/^image\/(jpeg|png|webp)$/.test(img.ct)) return sendJson(ctx.res, 404, { ok: false, reason: "לא נמצא" });
  const { res } = ctx;
  const buf = Buffer.from(img.b64, "base64");
  res.statusCode = 200;
  res.setHeader("Content-Type", img.ct);
  res.setHeader("Content-Length", buf.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Ids are random and a photo never changes, so the long public cache is safe. Test mode stays private.
  res.setHeader("Cache-Control", ctx.test ? "no-store" : "public, max-age=31536000, immutable");
  res.end(buf);
}

module.exports = { uploadPhoto, savePortfolio, servePhoto, parseImage, MAX_PHOTOS };
