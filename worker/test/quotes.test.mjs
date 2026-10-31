// node worker/test/quotes.test.mjs — 離線測試：假 Longbridge 上游，驗簽名同報價整理
import crypto from "node:crypto";
import assert from "node:assert";
import worker from "../src/index.js";

const kv = new Map();
const env = {
  SITE_PASSWORD: "pw-test-12345", SESSION_SECRET: "s".repeat(40), INGEST_TOKEN: "i".repeat(40),
  LB_APP_KEY: "ap_key", LB_APP_SECRET: "ap_secret", LB_ACCESS_TOKEN: "ap_token",
  DATA: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } },
};
globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };

// 參考實作（逐行對 rust signature.rs）
const sha1 = (d) => crypto.createHash("sha1").update(d).digest("hex");
function refSign(method, path, query, body, key, secret, token, ts) {
  const sh = "authorization;x-api-key;x-timestamp";
  const sv = `authorization:${token}\nx-api-key:${key}\nx-timestamp:${ts}\n`;
  let s = `${method}|${path}|${query}|${sv}|${sh}|`;
  if (body) s += sha1(body);
  const h = crypto.createHmac("sha256", secret).update(`HMAC-SHA256|${sha1(s)}`).digest("hex");
  return `HMAC-SHA256 SignedHeaders=${sh}, Signature=${h}`;
}

let seen;
globalThis.fetch = async (url, init) => {
  seen = { url, init };
  const body = { code: 0, message: "OK", data: { secu_quote: [
    { symbol: "SPY.US", last_done: "755.72", prev_close: "769.36", timestamp: "1793390400",
      post_market_quote: { last_done: "757.12", timestamp: "1793419140" },
      over_night_quote: { last_done: "762.33", timestamp: "1793430000" } },
    { symbol: ".SPX.US", last_done: "7580.07", prev_close: "7720.39", timestamp: "1793390400" },
    { symbol: "BAD.US", last_done: "0", prev_close: "0", timestamp: "0" },
  ] } };
  return new Response(JSON.stringify(body), { status: 200 });
};

// 登入攞 cookie
let r = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: env.SITE_PASSWORD, remember: true }) }), env);
assert.equal(r.status, 200);
const cookie = r.headers.get("Set-Cookie").split(";")[0];

// 未登入 → 401
r = await worker.fetch(new Request("https://x/api/quotes?symbols=SPY.US"), env);
assert.equal(r.status, 401);

// 已登入
r = await worker.fetch(new Request("https://x/api/quotes?symbols=SPY.US,.SPX.US,BAD.US", { headers: { Cookie: cookie } }), env);
assert.equal(r.status, 200);
const j = await r.json();
assert.equal(j.quotes.length, 2);
const spy = j.quotes.find((q) => q.symbol === "SPY.US");
assert.equal(spy.session, "overnight");           // 最新 timestamp 嗰節
assert.equal(spy.last, 762.33);
assert.equal(spy.asof, new Date(1793430000 * 1000).toISOString());
assert.ok(Math.abs(spy.pct - (762.33 / 769.36 - 1) * 100) < 1e-9);
assert.equal(j.quotes.find((q) => q.symbol === ".SPX.US").session, "regular");

// 簽名同參考實作一致
const h = seen.init.headers;
const expect = refSign("POST", "/quote/quotes", "", seen.init.body, "ap_key", "ap_secret", "ap_token", h["X-Timestamp"]);
assert.equal(h["X-Api-Signature"], expect);
assert.equal(seen.url, "https://openapi.longbridge.com/quote/quotes");
assert.equal(seen.init.body, JSON.stringify({ symbol: ["SPY.US", ".SPX.US", "BAD.US"] }));
assert.equal(h["x-dc-region"], "ap");

// 壞 symbol 擋住
r = await worker.fetch(new Request("https://x/api/quotes?symbols=../etc", { headers: { Cookie: cookie } }), env);
assert.equal(r.status, 400);
// 未設 key → 503
r = await worker.fetch(new Request("https://x/api/quotes?symbols=SPY.US", { headers: { Cookie: cookie } }), { ...env, LB_APP_KEY: "" });
assert.equal(r.status, 503);
console.log("all ok");
