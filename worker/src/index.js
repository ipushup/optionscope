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

// ── 高頻檔（signals.json / market.json）改放 Durable Object，唔用 KV ──
// Cloudflare 免費版 KV 每日只可寫 1,000 次；循環 job 每 30–60 秒寫一次會用爆，
// 之後連每日掃描嘅上傳都 500（error 1101）。DO（SQLite）免費版每日 10 萬次寫入，夠晒。
const LIVE_NAMES = new Set(["signals.json", "signals2.json", "daily.json", "market.json", "mtf.json", "mylist.json"]);
const liveStub = (env) => env.LIVE.get(env.LIVE.idFromName("live"));

export class LiveStore {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    if (req.method === "PUT") { await this.state.storage.put(name, await req.text()); return new Response("ok"); }
    const v = await this.state.storage.get(name);
    return v == null ? new Response(null, { status: 404 }) : new Response(v);
  }
}


// ── My List（自選股，宏觀頁）：登入後可喺頁面增減；後台 job 用 ingest token 讀 ──
const DEFAULT_MYLIST = ["INTC.US", "NVDA.US", "968.HK", "868.HK", "3868.HK"];
const MYLIST_MAX = 40;
function normSymbol(raw) {
  let t = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  let m;
  if ((m = t.match(/^(\d{1,5})(?:\.HK)?$/))) return `${parseInt(m[1], 10)}.HK`;                 // 968 / 0968 / 968.HK → 968.HK
  if ((m = t.match(/^([A-Z]{1,5}(?:[.-][A-Z])?)(?:\.US)?$/))) return `${m[1].replace("-", ".")}.US`; // NVDA / BRK.B / NVDA.US
  if ((m = t.match(/^(\d{6})\.(SH|SZ)$/))) return t;                                            // A 股
  return null;
}
async function readMylist(env) {
  try {
    const raw = await env.DATA.get("data/mylist_symbols.json");
    if (raw) { const j = JSON.parse(raw); if (Array.isArray(j.symbols)) return j.symbols; }
  } catch { /* 用預設 */ }
  return DEFAULT_MYLIST;
}
async function handleMylistPut(req, env) {
  if (req.headers.get("X-Requested-With") !== "xmarket") return json({ error: "Bad request" }, 400);
  const text = await req.text();
  if (text.length > 4096) return json({ error: "Too large" }, 413);
  let body; try { body = JSON.parse(text); } catch { return json({ error: "Bad JSON" }, 400); }
  const out = [];
  for (const x of Array.isArray(body.symbols) ? body.symbols : []) {
    const n = normSymbol(x);
    if (n && !out.includes(n)) out.push(n);
  }
  // 新加入嘅股票：美股放最後一隻美股下面，港股放最後一隻港股下面（重排／移除唔受影響）
  const known = new Set(await readMylist(env));
  const isHK = (x) => x.endsWith(".HK");
  const fresh = out.filter((x) => !known.has(x));
  if (fresh.length && fresh.length < out.length) {
    const res = out.filter((x) => known.has(x));
    for (const x of fresh) {
      let at = -1;
      res.forEach((y, i) => { if (isHK(y) === isHK(x)) at = i; });
      if (at < 0) at = isHK(x) ? res.length - 1 : -1;   // 該市場未有股票：港股放最尾，美股放最頭
      res.splice(at + 1, 0, x);
    }
    out.length = 0; out.push(...res);
  }
  if (out.length > MYLIST_MAX) return json({ error: `Max ${MYLIST_MAX} symbols` }, 400);
  try { await env.DATA.put("data/mylist_symbols.json", JSON.stringify({ symbols: out, updated: new Date().toISOString() })); }
  catch (e) { return json({ error: "storage write failed", detail: String(e).slice(0, 120) }, 503); }
  return json({ ok: true, symbols: out });
}


// ── Watchlist / 孖展率 網頁編輯：經 GitHub Contents API 讀寫 repo 入面嘅 txt（需要 secret GH_CONTENTS_TOKEN）──
const GH_FILES = { watchlist: "scanner/Watchlists.txt", margin: "scanner/margin.txt" };
function b64ToUtf8(b64) { const bin = atob(b64.replace(/\s/g, "")); const u = Uint8Array.from(bin, (c) => c.charCodeAt(0)); return new TextDecoder().decode(u); }
function utf8ToB64(str) { const u = new TextEncoder().encode(str); let bin = ""; for (const b of u) bin += String.fromCharCode(b); return btoa(bin); }
function ghHeaders(env) { return { Authorization: `Bearer ${env.GH_CONTENTS_TOKEN || env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "xmarket-gateway", "X-GitHub-Api-Version": "2022-11-28" }; }
async function handleGhFile(req, env, url) {
  if (!(env.GH_CONTENTS_TOKEN || env.GH_DISPATCH_TOKEN)) return json({ error: "GH_CONTENTS_TOKEN／GH_DISPATCH_TOKEN 未設定（Worker secret）" }, 503);
  if (req.method === "GET") {
    const f = GH_FILES[url.searchParams.get("name")]; if (!f) return json({ error: "Unknown file" }, 400);
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${f}?ref=main`, { headers: ghHeaders(env), cf: { cacheTtl: 0 } });
    if (r.status === 403 || r.status === 404) return json({ error: `GitHub ${r.status}：token 未有 Contents 權限（喺 GitHub 將 token 加 Contents: Read and write）` }, 502);
    if (!r.ok) return json({ error: `GitHub ${r.status}` }, 502);
    const j = await r.json();
    return json({ content: b64ToUtf8(j.content || ""), sha: j.sha }, 200, { "Cache-Control": "no-store" });
  }
  if (req.method === "PUT") {
    if (req.headers.get("X-Requested-With") !== "xmarket") return json({ error: "Bad request" }, 400);
    const text = await req.text();
    if (text.length > 400000) return json({ error: "Too large" }, 413);
    let b; try { b = JSON.parse(text); } catch { return json({ error: "Bad JSON" }, 400); }
    const f = GH_FILES[b.name]; if (!f) return json({ error: "Unknown file" }, 400);
    const content = String(b.content ?? ""); const sha = String(b.sha || "");
    if (!sha) return json({ error: "sha missing" }, 400);
    if (b.name === "watchlist") {   // 基本格式檢查：逗號分隔，### 開頭為 section，其餘 EXCHANGE:SYMBOL
      const toks = content.trim().split(",").map((x) => x.trim()).filter(Boolean);
      if (!toks.length || !toks[0].startsWith("###")) return json({ error: "Watchlists 格式唔啱（要以 ###SECTION 開頭）" }, 400);
      for (const t of toks) if (!(t.startsWith("###") ? t.length > 3 : /^[A-Za-z0-9_.\-!]+:[A-Za-z0-9_.\-!&]+$/.test(t))) return json({ error: `格式唔啱：${t.slice(0, 40)}` }, 400);
    } else if (content.length < 50) return json({ error: "margin 內容太短" }, 400);
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${f}`, {
      method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ message: String(b.message || `web: edit ${b.name}`).slice(0, 120), content: utf8ToB64(content), sha, branch: "main" }),
    });
    if (r.status === 409 || r.status === 422) return json({ error: "檔案已被改動，請重新載入再試" }, 409);
    if (r.status === 403 || r.status === 404) return json({ error: `GitHub ${r.status}：token 未有 Contents 寫入權限` }, 502);
    if (!r.ok) return json({ error: `GitHub ${r.status}` }, 502);
    const j = await r.json();
    return json({ ok: true, sha: j.content?.sha });
  }
  return json({ error: "Method not allowed" }, 405);
}
async function handleWlScan(req, env) {   // 手動叫 Triple Band Radar full scan（令新股票出現 TBand/UT/ST）
  if (req.headers.get("X-Requested-With") !== "xmarket") return json({ error: "Bad request" }, 400);
  if (!env.GH_DISPATCH_TOKEN) return json({ error: "GH_DISPATCH_TOKEN 未設定" }, 503);
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/band_scan.yml/dispatches`, {
    method: "POST", headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "xmarket-gateway", "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { quotes_only: "false" } }),
  });
  return r.ok || r.status === 204 ? json({ ok: true }) : json({ error: `GitHub ${r.status}` }, 502);
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
  try {
    if (env.LIVE && LIVE_NAMES.has(name)) {
      await liveStub(env).fetch(`https://live/${name}`, { method: "PUT", body: text });
      return json({ ok: true, name, bytes: text.length, store: "do" });
    }
    await env.DATA.put(`data/${name}`, text);
    await env.DATA.put(`meta/${name}`, new Date().toISOString());
  } catch (e) {                                  // 例如 KV 額度爆：回 503 而唔係 1101 崩潰
    return json({ error: "storage write failed", detail: String(e).slice(0, 160) }, 503);
  }
  return json({ ok: true, name, bytes: text.length, store: "kv" });
}

// ───────────── Longbridge 即時報價（server-side，key 唔落瀏覽器）─────────────
// 簽名演算法抄自官方 SDK：longbridge/openapi rust/crates/httpclient/src/signature.rs
// 端點：POST https://openapi.longbridge.com/quote/quotes  body {"symbol":[...]}
const LB_BASE = "https://openapi.longbridge.com";
const SYMBOL_RE = /^\.?[A-Za-z0-9]{1,12}(?:\.[A-Za-z]{1,4})?$/;
const MAX_SYMBOLS = 100;

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
    const rawTs = get(o, "timestamp");
    let ts = parseInt(rawTs, 10);
    if (!(ts > 0) || /[-T:]/.test(String(rawTs))) { const d = Date.parse(rawTs); ts = d > 0 ? Math.floor(d / 1000) : ts; }   // 數字 epoch 或 ISO 字串都接受
    if (last > 0 && ts > 0) cands.push({ ts, last, sess });
  };
  // 欄位名唔同版本有出入（pre_market_quote / preMarketQuote / pre_market …）：用正則搵，唔靠死寫
  const find = (re) => { for (const k of Object.keys(q || {})) if (re.test(k) && q[k] && typeof q[k] === "object") return q[k]; return null; };
  add("regular", q);
  add("pre", get(q, "pre_market_quote", "preMarketQuote") || find(/^pre[_-]?market/i));
  add("post", get(q, "post_market_quote", "postMarketQuote") || find(/^post[_-]?market/i));
  add("overnight", get(q, "over_night_quote", "overNightQuote") || find(/^over[_-]?night/i));
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
    // 盤前／盤後／夜盤：升跌用「常規收市價」做基準（同 Longbridge app 一樣）；常規時段先用昨收
    const reg = parseFloat(q.last_done ?? q.lastDone);
    const base = got.sess !== "regular" && reg > 0 ? reg : prev;
    out.push({ symbol: q.symbol, last: got.last, prev_close: base, change: got.last - base,
               pct: (got.last / base - 1) * 100,
               reg: reg > 0 ? reg : got.last, reg_pct: (reg > 0 ? reg / prev - 1 : got.last / prev - 1) * 100, asof: new Date(got.ts * 1000).toISOString(), session: got.sess });
  }
  const res = json({ fetched_at: new Date().toISOString(), quotes: out, ...(debug ? { raw_sample: list.slice(0, 1) } : {}) }, 200, { "Cache-Control": "public, max-age=5" });
  if (!debug) await cache.put(cacheKey, res.clone());
  return res;
}

// ── 排程：GitHub Actions 自己嘅 cron 唔準時（成日幾個鐘唔跑），
//    所以由 Cloudflare Cron Trigger 每 5 分鐘睇一次：冇循環 job 喺度跑就 dispatch 一個。
//    循環 job 每個跑 ~55 分鐘；快完（>40 分鐘）而又未有人排緊隊，就預先排一個接力（concurrency 唔取消，會排隊）。
const PUBLIC_ICONS = new Set(["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.png", "/icon-512.png"]);
const GH_REPO = "ipushup/optionscope";
// after = 最新一個 run 跑咗幾多分鐘就開下一個接力。signal_stream 熱身要 ~5 分鐘，所以早啲（無 concurrency，新舊重疊）。
const LOOP_WORKFLOWS = [{ wf: "signal_stream.yml", after: 33 }, { wf: "market_loop.yml", after: 40 }, { wf: "daily_table.yml", after: 40 }, { wf: "signal_mtf.yml", after: 40 }, { wf: "mylist.yml", after: 40 }];

async function keepLoopsAlive(env) {
  if (!env.GH_DISPATCH_TOKEN) { console.log("GH_DISPATCH_TOKEN 未設，跳過"); return; }
  const H = { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
              "User-Agent": "optionscope-gateway", "X-GitHub-Api-Version": "2022-11-28" };
  for (const { wf, after } of LOOP_WORKFLOWS) {
    try {
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${wf}/runs?per_page=5`, { headers: H });
      if (!r.ok) { console.log(wf, "list failed", r.status); continue; }
      const runs = (await r.json()).workflow_runs || [];
      const active = runs.filter(x => x.status === "in_progress" || x.status === "queued" || x.status === "waiting" || x.status === "pending");
      const queued = active.filter(x => x.status !== "in_progress");
      const running = active.filter(x => x.status === "in_progress");
      const newest = running.length ? Math.min(...running.map(x => (Date.now() - new Date(x.run_started_at || x.created_at).getTime()) / 60000)) : null;
      const need = queued.length === 0 && (running.length === 0 || newest > after);
      if (!need) continue;
      const d = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${wf}/dispatches`, {
        method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }) });
      console.log(wf, "dispatch", d.status, running.length ? `(handover, newest ${Math.round(newest)}m)` : "(none running)");
    } catch (e) { console.log(wf, "error", String(e)); }
  }
}

// ── 收市後一次性 job：GitHub 自己嘅 cron 唔準時（甚至成日唔跑），由 Worker 補 dispatch。
//    slot = UTC 時間（平日）；開始後 3 小時內，如果該 workflow 未有喺 slot 之後建立嘅 run，就 dispatch 一個。
const AFTER_CLOSE = [
  { wf: "index_daily.yml", h: 8, m: 30 },    // HK 收市後
  { wf: "index_daily.yml", h: 21, m: 30 },   // US 收市後（冬令；夏令更早收市，亦夠遲）
];

async function afterCloseJobs(env) {
  if (!env.GH_DISPATCH_TOKEN) return;
  const H = { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
              "User-Agent": "optionscope-gateway", "X-GitHub-Api-Version": "2022-11-28" };
  const now = new Date();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return;
  for (const { wf, h, m } of AFTER_CLOSE) {
    try {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
      if (now < start || now - start > 3 * 3600 * 1000) continue;
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${wf}/runs?per_page=5`, { headers: H });
      if (!r.ok) { console.log(wf, "list failed", r.status); continue; }
      const runs = (await r.json()).workflow_runs || [];
      if (runs.some(x => new Date(x.created_at) >= start)) continue;
      const d = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${wf}/dispatches`, {
        method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }) });
      console.log(wf, "after-close dispatch", d.status);
    } catch (e) { console.log(wf, "after-close error", String(e)); }
  }
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(keepLoopsAlive(env)); ctx.waitUntil(afterCloseJobs(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!env.SITE_PASSWORD || !env.SESSION_SECRET) return json({ error: "Gateway not configured" }, 503);

    if (path === "/api/login" && req.method === "POST") return handleLogin(req, env);
    if (path === "/api/logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (path.startsWith("/_ingest/") && req.method === "PUT") return handleIngest(req, env, path.slice("/_ingest/".length));
    if (path === "/_ingest/mylist.json" && req.method === "GET") {
      const auth = req.headers.get("Authorization") || "";
      if (!env.INGEST_TOKEN || !(await safeEqual(auth, `Bearer ${env.INGEST_TOKEN}`, env.SESSION_SECRET))) return json({ error: "Unauthorized" }, 401);
      return json({ symbols: await readMylist(env) });
    }

    // 圖示要公開（iOS 加到主畫面時唔會帶登入 cookie）；只係個 X 圖，冇敏感內容
    if (req.method === "GET" && PUBLIC_ICONS.has(path)) return withSec(await env.ASSETS.fetch(req));

    const authed = await validToken(env, getCookie(req, COOKIE));
    if (!authed) {
      const wantsPage = req.method === "GET" && (path === "/" || path === "/index.html");
      if (wantsPage) return withSec(new Response(LOGIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }));
      return json({ error: "Unauthorized" }, 401);
    }

    if (path === "/api/mylist") {
      if (req.method === "GET") return json({ symbols: await readMylist(env) }, 200, { "Cache-Control": "no-store" });
      if (req.method === "PUT") return handleMylistPut(req, env);
    }

    if (path === "/api/gh-file") return handleGhFile(req, env, url);
    if (path === "/api/wl-scan" && req.method === "POST") return handleWlScan(req, env);

    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Read only" }, 405);

    if (path === "/api/quotes") return handleQuotes(req, env, url);

    const m = path.match(/^\/([A-Za-z0-9_-]{1,64}\.json)$/);
    if (m) {
      let body = null;
      if (env.LIVE && LIVE_NAMES.has(m[1])) {
        const r = await liveStub(env).fetch(`https://live/${m[1]}`);
        if (r.ok) body = await r.text();
      }
      if (body == null) body = await env.DATA.get(`data/${m[1]}`);
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
<meta name="apple-mobile-web-app-title" content="xMarket">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/favicon.png">
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
