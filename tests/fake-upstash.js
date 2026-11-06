// Fake Upstash REST server for local tests. Implements exactly the commands the backend uses and
// fails loudly on anything else, so an unexpected command cannot pass unnoticed.
const http = require("http");

const RELEASE_MARK = "string.sub(v,1,#ARGV[1]+1)";
const SWAP_MARK = "redis.call('GET',KEYS[1])==ARGV[1]";

function createFake(token) {
  const store = new Map(); // key -> { type, value, expires }
  const stats = { commands: 0, byName: {} };

  const live = k => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expires && e.expires <= Date.now()) { store.delete(k); return null; }
    return e;
  };
  const ofType = (k, type, make) => {
    const e = live(k);
    if (e) { if (e.type !== type) throw new Error("WRONGTYPE"); return e; }
    if (!make) return null;
    const n = { type, value: make(), expires: null };
    store.set(k, n);
    return n;
  };
  const globRe = g => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

  const commands = {
    GET: ([k]) => { const e = ofType(k, "s"); return e ? e.value : null; },
    SET: ([k, v, ...opts]) => {
      let nx = false, ex = null;
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i].toUpperCase();
        if (o === "NX") nx = true;
        else if (o === "EX") ex = Number(opts[++i]);
        else throw new Error("unsupported SET option " + o);
      }
      if (nx && live(k)) return null;
      store.set(k, { type: "s", value: String(v), expires: ex ? Date.now() + ex * 1000 : null });
      return "OK";
    },
    MGET: keys => keys.map(k => { const e = live(k); return e && e.type === "s" ? e.value : null; }),
    DEL: keys => { let n = 0; keys.forEach(k => { if (live(k)) n++; store.delete(k); }); return n; },
    INCR: ([k]) => {
      const e = ofType(k, "s", () => "0");
      const n = Number(e.value) + 1;
      e.value = String(n);
      return n;
    },
    EXPIRE: ([k, s]) => { const e = live(k); if (!e) return 0; e.expires = Date.now() + Number(s) * 1000; return 1; },
    PERSIST: ([k]) => { const e = live(k); if (!e || !e.expires) return 0; e.expires = null; return 1; },
    EXISTS: keys => keys.filter(k => live(k)).length,
    HSET: ([k, ...fv]) => { const e = ofType(k, "h", () => new Map()); let n = 0; for (let i = 0; i < fv.length; i += 2) { if (!e.value.has(fv[i])) n++; e.value.set(fv[i], String(fv[i + 1])); } return n; },
    HSETNX: ([k, f, v]) => { const e = ofType(k, "h", () => new Map()); if (e.value.has(f)) return 0; e.value.set(f, String(v)); return 1; },
    HGET: ([k, f]) => { const e = ofType(k, "h"); return e && e.value.has(f) ? e.value.get(f) : null; },
    HMGET: ([k, ...fs]) => { const e = ofType(k, "h"); return fs.map(f => (e && e.value.has(f) ? e.value.get(f) : null)); },
    HGETALL: ([k]) => { const e = ofType(k, "h"); const out = []; if (e) e.value.forEach((v, f) => out.push(f, v)); return out; },
    HDEL: ([k, ...fs]) => { const e = ofType(k, "h"); if (!e) return 0; let n = 0; fs.forEach(f => { if (e.value.delete(f)) n++; }); if (!e.value.size) store.delete(k); return n; },
    HEXISTS: ([k, f]) => { const e = ofType(k, "h"); return e && e.value.has(f) ? 1 : 0; },
    SADD: ([k, ...ms]) => { const e = ofType(k, "set", () => new Set()); let n = 0; ms.forEach(m => { if (!e.value.has(m)) { e.value.add(m); n++; } }); return n; },
    SREM: ([k, ...ms]) => { const e = ofType(k, "set"); if (!e) return 0; let n = 0; ms.forEach(m => { if (e.value.delete(m)) n++; }); if (!e.value.size) store.delete(k); return n; },
    SMEMBERS: ([k]) => { const e = ofType(k, "set"); return e ? [...e.value] : []; },
    LPUSH: ([k, ...vs]) => { const e = ofType(k, "l", () => []); vs.forEach(v => e.value.unshift(v)); return e.value.length; },
    LTRIM: ([k, a, b]) => { const e = ofType(k, "l"); if (e) e.value = e.value.slice(Number(a), Number(b) + 1); return "OK"; },
    LRANGE: ([k, a, b]) => { const e = ofType(k, "l"); return e ? e.value.slice(Number(a), Number(b) + 1) : []; },
    SCAN: ([cursor, ...opts]) => {
      let match = "*";
      for (let i = 0; i < opts.length; i += 2) if (opts[i].toUpperCase() === "MATCH") match = opts[i + 1];
      const re = globRe(match);
      const keys = [...store.keys()].filter(k => live(k) && re.test(k));
      // Two-step cursor, so the caller's loop is exercised like against a real server.
      const offset = Number(cursor);
      const page = keys.slice(offset, offset + 100);
      const next = offset + 100 >= keys.length ? "0" : String(offset + 100);
      return [next, page];
    },
    // Only the two scripts the app uses, emulated atomically by this single-threaded server.
    EVAL: ([script, numKeys, key, ...argv]) => {
      if (Number(numKeys) !== 1) throw new Error("unexpected EVAL numkeys");
      const e = live(key);
      if (script.includes(RELEASE_MARK)) {
        if (e && String(e.value).startsWith(argv[0] + "|")) { store.delete(key); return 1; }
        return 0;
      }
      if (script.includes(SWAP_MARK)) {
        if (e && e.value === argv[0]) { store.set(key, { type: "s", value: argv[1], expires: Date.now() + Number(argv[2]) * 1000 }); return 1; }
        return 0;
      }
      throw new Error("unknown EVAL script");
    }
  };

  function run(args) {
    if (!Array.isArray(args) || !args.length) return { error: "ERR bad command" };
    args.forEach(a => { if (typeof a !== "string") throw new Error("Upstash-format args must be strings here, got " + typeof a); });
    const name = args[0].toUpperCase();
    stats.commands++;
    stats.byName[name] = (stats.byName[name] || 0) + 1;
    const fn = commands[name];
    if (!fn) return { error: "ERR fake does not implement " + name };
    try { return { result: fn(args.slice(1)) }; } catch (err) { return { error: "ERR " + err.message }; }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization !== "Bearer " + token) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Unauthorized" })); }
      if (req.method !== "POST") { res.statusCode = 405; return res.end("{}"); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { res.statusCode = 400; return res.end(JSON.stringify({ error: "ERR bad json" })); }
      if (req.url === "/pipeline") return res.end(JSON.stringify(body.map(run)));
      if (req.url === "/" || req.url === "") {
        const out = run(body);
        if (out.error) res.statusCode = 400;
        return res.end(JSON.stringify(out));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown path" }));
    });
  });

  return { server, store, stats, run };
}

module.exports = { createFake };
