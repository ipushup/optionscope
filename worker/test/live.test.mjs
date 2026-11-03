// node worker/test/live.test.mjs — 高頻檔走 Durable Object、其他走 KV；KV 爆額度回 503 而唔係崩潰
import assert from "node:assert";
import worker, { LiveStore } from "../src/index.js";

const kv = new Map(); let kvFail = false;
const store = new Map();
const live = new LiveStore({ storage: { async put(k, v) { store.set(k, v); }, async get(k) { return store.get(k) ?? null; } } });
const env = {
  SITE_PASSWORD: "pw-test-12345", SESSION_SECRET: "s".repeat(40), INGEST_TOKEN: "i".repeat(40),
  DATA: { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { if (kvFail) throw new Error("KV PUT failed: 429"); kv.set(k, v); } },
  LIVE: { idFromName: () => "x", get: () => ({ fetch: (u, i) => live.fetch(new Request(u, i)) }) },
};
const put = (name, body) => worker.fetch(new Request(`https://x/_ingest/${name}`, { method: "PUT", headers: { Authorization: `Bearer ${"i".repeat(40)}`, "Content-Type": "application/json" }, body }), env);

let r = await put("signals.json", '{"a":1}');
assert.equal(r.status, 200); assert.equal((await r.json()).store, "do");
assert.equal(kv.size, 0, "signals.json 唔應該寫 KV");
assert.equal(store.get("signals.json"), '{"a":1}');

r = await put("results.json", '{"b":2}');
assert.equal((await r.json()).store, "kv"); assert.ok(kv.has("data/results.json"));

kvFail = true;
r = await put("results.json", '{"b":3}');
assert.equal(r.status, 503, "KV 爆額度要回 503");
r = await put("market.json", '{"c":1}');
assert.equal(r.status, 200, "高頻檔唔受 KV 額度影響");

// 讀取：要 cookie，直接用內部 handler 太繁，只驗 DO 儲存有內容
assert.equal(store.get("market.json"), '{"c":1}');
console.log("live ok");
