/**
 * optionscope-gateway — 私人只讀站嘅守門員
 *
 *   GET  /                 未登入 → 登入頁；已登入 → React app
 *   POST /api/login        {password, remember} → 簽名 cookie（remember = 30 日，否則 12 小時）
 *   POST /api/logout       清 cookie
 *   GET  /<name>.json      要有效 cookie，從 KV 讀（前端用同一條相對路徑，唔使改）
 *   PUT  /_ingest/<name>.json   Authorization: Bearer INGEST_TOKEN，GitHub Actions 上傳用
 *
 * 前端同數據喺同一個 origin，所以 cookie 係 first-party（Safari / ITP 唔會擋）。
 * 只讀：呢個 Worker 冇任何落盤／交易功能，唯一寫入口係 ingest。
 */

const DAY = 86400;
const REMEMBER_SECS = 30 * DAY;
const SESSION_SECS = 12 * 3600;
const COOKIE = "os_session";
const NAME_RE = /^[A-Za-z0-9_-]{1,64}\.json$/;
const MAX_BODY = 20 * 1024 * 1024;

const enc = new TextEncoder();

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) { return b64url(enc.encode(str)); }
function fromB64urlStr(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

/** 比較兩個字串：各自 HMAC 成定長，再逐 byte 比，唔會因長度／前綴洩露時間差。 */
async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function makeToken(env, secs) {
  const payload = b64urlStr(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secs }));
  return `${payload}.${b64url(await hmac(env.SESSION_SECRET, payload))}`;
}

async function validToken(env, token) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  if (!(await safeEqual(sig, b64url(await hmac(env.SESSION_SECRET, payload)), env.SESSION_SECRET))) return false;
  try {
    return JSON.parse(fromB64urlStr(payload)).exp > Date.now() / 1000;
  } catch { return false; }
}

function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
};
function withSec(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC_HEADERS)) r.headers.set(k, v);
  return r;
}
function json(obj, status = 200, extra = {}) {
  return withSec(new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } }));
}

async function rateLimited(env, req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}`;
  const n = parseInt((await env.DATA.get(key)) || "0", 10);
  if (n >= 8) return true;
  await env.DATA.put(key, String(n + 1), { expirationTtl: 900 });
  return false;
}

async function handleLogin(req, env) {
  if (await rateLimited(env, req)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const ok = typeof body.password === "string" && (await safeEqual(body.password, env.SITE_PASSWORD, env.SESSION_SECRET));
  if (!ok) return json({ error: "Wrong password" }, 401);
  const remember = body.remember === true;
  const secs = remember ? REMEMBER_SECS : SESSION_SECS;
  const token = await makeToken(env, secs);
  const attrs = `Path=/; HttpOnly; Secure; SameSite=Strict${remember ? `; Max-Age=${secs}` : ""}`;
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=${token}; ${attrs}` });
}

async function handleIngest(req, env, name) {
  const auth = req.headers.get("Authorization") || "";
  if (!env.INGEST_TOKEN || !(await safeEqual(auth, `Bearer ${env.INGEST_TOKEN}`, env.SESSION_SECRET))) return json({ error: "Unauthorized" }, 401);
  if (!NAME_RE.test(name)) return json({ error: "Bad name" }, 400);
  const len = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (len > MAX_BODY) return json({ error: "Too large" }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "Too large" }, 413);
  try { JSON.parse(text); } catch { return json({ error: "Body is not valid JSON" }, 400); }
  await env.DATA.put(`data/${name}`, text);
  await env.DATA.put(`meta/${name}`, new Date().toISOString());
  return json({ ok: true, name, bytes: text.length });
}

// ───────────── Longbridge 即時報價（server-side，key 唔落瀏覽器）─────────────
// 簽名演算法抄自官方 SDK：longbridge/openapi rust/crates/httpclient/src/signature.rs
// 端點：POST https://openapi.longbridge.com/quote/quotes  body {"symbol":[...]}
const LB_BASE = "https://openapi.longbridge.com";
const SYMBOL_RE = /^\.?[A-Za-z0-9]{1,12}(?:\.[A-Za-z]{1,4})?$/;
const MAX_SYMBOLS = 30;

async function sha1hex(data) {
  const buf = await crypto.subtle.digest("SHA-1", typeof data === "string" ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret, msg) {
  return [...(await hmac(secret, msg))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function lbSign(method, path, query, body, appKey, appSecret, accessToken, ts) {
  const signedHeaders = "authorization;x-api-key;x-timestamp";
  const signedValues = `authorization:${accessToken}\nx-api-key:${appKey}\nx-timestamp:${ts}\n`;
  let str = `${method}|${path}|${query}|${signedValues}|${signedHeaders}|`;
  if (body) str += await sha1hex(body);
  const toSign = `HMAC-SHA256|${await sha1hex(str)}`;
  return `HMAC-SHA256 SignedHeaders=${signedHeaders}, Signature=${await hmacHex(appSecret, toSign)}`;
}

/** 揀 常規／盤前／盤後／夜盤 之中 timestamp 最新嗰節 */
function pickLatest(q) {
  const get = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };
  const cands = [];
  const add = (sess, o) => {
    if (!o) return;
    const last = parseFloat(get(o, "last_done", "lastDone"));
    const ts = parseInt(get(o, "timestamp"), 10);
    if (last > 0 && ts > 0) cands.push({ ts, last, sess });
  };
  add("regular", q);
  add("pre", get(q, "pre_market_quote", "preMarketQuote"));
  add("post", get(q, "post_market_quote", "postMarketQuote"));
  add("overnight", get(q, "over_night_quote", "overNightQuote"));
  if (!cands.length) return null;
  return cands.sort((a, b) => b.ts - a.ts)[0];
}

async function handleQuotes(req, env, url) {
  if (!env.LB_APP_KEY || !env.LB_APP_SECRET || !env.LB_ACCESS_TOKEN) return json({ error: "Longbridge not configured" }, 503);
  const symbols = (url.searchParams.get("symbols") || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!symbols.length || symbols.length > MAX_SYMBOLS || !symbols.every((x) => SYMBOL_RE.test(x))) return json({ error: "Bad symbols" }, 400);
  const debug = url.searchParams.get("debug") === "1";

  // 同一批 symbols 5 秒內共用結果，唔使每個重新整理都撞 Longbridge 限流（10 次/秒）
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.invalid/quotes?s=${symbols.slice().sort().join(",")}`);
  if (!debug) {
    const hit = await cache.match(cacheKey);
    if (hit) return withSec(new Response(hit.body, hit));
  }

  const body = JSON.stringify({ symbol: symbols });
  const ts = Math.floor(Date.now() / 1000);
  const path = "/quote/quotes";
  const sig = await lbSign("POST", path, "", body, env.LB_APP_KEY, env.LB_APP_SECRET, env.LB_ACCESS_TOKEN, ts);
  const region = env.LB_APP_KEY.startsWith("us_") || env.LB_ACCESS_TOKEN.startsWith("us_") ? "us" : "ap";
  let up, text;
  try {
    up = await fetch(LB_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Api-Key": env.LB_APP_KEY, Authorization: env.LB_ACCESS_TOKEN,
        "X-Timestamp": String(ts), "X-Api-Signature": sig, "x-dc-region": region,
      },
      body,
    });
    text = await up.text();
  } catch (e) { return json({ error: "Upstream unreachable", detail: String(e) }, 502); }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 下面處理 */ }
  if (!up.ok || !parsed || (parsed.code != null && parsed.code !== 0)) {
    return json({ error: "Longbridge error", status: up.status, ...(debug ? { upstream: text.slice(0, 500) } : { code: parsed?.code, message: parsed?.message }) }, 502);
  }
  const data = parsed.data ?? parsed;
  const list = data.secu_quote ?? data.secuQuote ?? [];
  const out = [];
  for (const q of list) {
    const got = pickLatest(q);
    const prev = parseFloat(q.prev_close ?? q.prevClose);
    if (!got || !(prev > 0)) continue;
    out.push({ symbol: q.symbol, last: got.last, prev_close: prev, change: got.last - prev,
               pct: (got.last / prev - 1) * 100, asof: new Date(got.ts * 1000).toISOString(), session: got.sess });
  }
  const res = json({ fetched_at: new Date().toISOString(), quotes: out, ...(debug ? { raw_sample: list.slice(0, 1) } : {}) }, 200, { "Cache-Control": "public, max-age=5" });
  if (!debug) await cache.put(cacheKey, res.clone());
  return res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!env.SITE_PASSWORD || !env.SESSION_SECRET) return json({ error: "Gateway not configured" }, 503);

    if (path === "/api/login" && req.method === "POST") return handleLogin(req, env);
    if (path === "/api/logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (path.startsWith("/_ingest/") && req.method === "PUT") return handleIngest(req, env, path.slice("/_ingest/".length));

    const authed = await validToken(env, getCookie(req, COOKIE));
    if (!authed) {
      const wantsPage = req.method === "GET" && (path === "/" || path === "/index.html");
      if (wantsPage) return withSec(new Response(LOGIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }));
      return json({ error: "Unauthorized" }, 401);
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Read only" }, 405);

    if (path === "/api/quotes") return handleQuotes(req, env, url);

    const m = path.match(/^\/([A-Za-z0-9_-]{1,64}\.json)$/);
    if (m) {
      const body = await env.DATA.get(`data/${m[1]}`);
      if (body == null) return json({ error: "Not found" }, 404);
      return withSec(new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
    }

    return withSec(await env.ASSETS.fetch(req));
  },
};

const LOGIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#16181b">
<title>OptionScope</title>
<style>
*{box-sizing:border-box;margin:0}
body{min-height:100vh;background:#16181b;color:#e6e9ec;font-family:'Syne',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.w{width:100%;max-width:380px;display:flex;flex-direction:column;gap:22px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:36px;height:36px;border-radius:9px;background:#1f4f8f;display:flex;align-items:center;justify-content:center}
.mono{font-family:'DM Mono',ui-monospace,monospace}
.card{background:#202327;border:1px solid #33383f;border-radius:14px;padding:26px;display:flex;flex-direction:column;gap:18px}
h1{font-size:24px;font-weight:800;letter-spacing:-.4px}
p{font-size:13px;line-height:1.6;color:#9aa4ad;margin-top:8px}
label{font-size:11px;letter-spacing:.1em;color:#b4bcc4}
input[type=password]{width:100%;min-height:48px;padding:0 14px;border-radius:9px;border:1px solid #3a4048;background:#111316;color:#e6e9ec;font-size:15px;margin-top:8px}
input[type=password]:focus-visible,button:focus-visible{outline:2px solid #3b9eff;outline-offset:2px}
.row{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.5;color:#b4bcc4}
.row input{width:20px;height:20px;margin-top:2px;accent-color:#3b9eff;flex-shrink:0}
.row small{display:block;font-size:12px;color:#9aa4ad}
button{min-height:48px;border-radius:9px;border:none;background:#1f4f8f;color:#fff;font-size:14px;font-weight:800;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}
#err{min-height:18px;font-size:13px;color:#ff5c5c}
.foot{font-size:11px;line-height:1.7;color:#7d868f}
</style></head><body>
<div class="w">
<div class="brand"><div class="logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d4aa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg></div>
<div><div style="font-weight:800;font-size:17px">OptionScope</div><div class="mono" style="font-size:10px;color:#7d868f;letter-spacing:.1em">PRIVATE ACCESS · OWNER ONLY</div></div></div>
<form class="card" id="f">
<div><h1>Unlock your desk</h1><p>Read-only: nothing on this site can place an order.</p></div>
<div><label class="mono" for="pw">PASSWORD</label><input id="pw" type="password" autocomplete="current-password" required autofocus></div>
<div class="row"><input id="rem" type="checkbox" checked><label for="rem" style="font-size:13px;letter-spacing:0">Remember this device for 30 days<small>Only tick this on a device you own.</small></label></div>
<div id="err" role="alert"></div>
<button type="submit" id="go">Unlock</button>
</form>
<div class="mono foot">MARKET DATA IS FOR REFERENCE ONLY · NOT INVESTMENT ADVICE</div>
</div>
<script>
document.getElementById('f').addEventListener('submit',async function(e){
  e.preventDefault();
  var b=document.getElementById('go'),er=document.getElementById('err');
  b.disabled=true;er.textContent='';
  try{
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value,remember:document.getElementById('rem').checked})});
    var j=await r.json().catch(function(){return{}});
    if(r.ok){location.reload();return}
    er.textContent=j.error||'Login failed';
  }catch(x){er.textContent='Network error. Try again.'}
  b.disabled=false;
});
</script></body></html>`;
