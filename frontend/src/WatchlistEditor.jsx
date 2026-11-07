import { useEffect, useMemo, useState } from "react";

/**
 * WatchlistEditor — 喺網頁直接增減 Watchlist 股票／分組同孖展率。
 * 讀寫 repo 入面嘅 scanner/Watchlists.txt 同 scanner/margin.txt（經 Worker → GitHub Contents API commit）。
 * 每個動作即時 commit 一次；掃描 job 同 margin_import 照舊讀返 txt，管線完全唔使改。
 */

const API = "/api/gh-file";
const H = { "Content-Type": "application/json", "X-Requested-With": "xmarket" };

async function loadFile(name) {
  const r = await fetch(`${API}?name=${name}&t=${Date.now()}`, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;   // { content, sha }
}
async function saveFile(name, content, sha, message) {
  const r = await fetch(API, { method: "PUT", headers: H, body: JSON.stringify({ name, content, sha, message }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.sha;
}

// ── Watchlists.txt：逗號分隔；"###SECTION xxx" 係分組標題，其餘 EXCHANGE:SYMBOL ──
function parseWl(text) {
  const secs = [];
  let cur = null;
  for (const raw of text.split(",")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("###")) { cur = { head: t, items: [] }; secs.push(cur); }
    else { if (!cur) { cur = { head: "###SECTION UNSECTIONED", items: [] }; secs.push(cur); } cur.items.push(t); }
  }
  return secs;
}
const serializeWl = secs => secs.flatMap(s => [s.head, ...s.items]).join(",") + ",\n";
const secName = s => s.head.replace(/^###\s*(SECTION\s+)?/i, "");
const symOf = tok => tok.split(":").slice(1).join(":");

// ── margin.txt ──
const mKey = s => {
  const u = s.trim().toUpperCase().replace(/%$/, "");
  const hk = u.replace(/\.HK$/, "");
  return /^\d{1,5}$/.test(hk) ? String(parseInt(hk, 10)).padStart(4, "0") + ".HK" : u.replace(/\.US$/, "");
};
function parseMargin(text) {
  const lines = text.split("\n");
  const rows = [];
  lines.forEach((ln, i) => {
    const t = ln.replace(/#.*/, "").trim();
    if (!t) return;
    const m = t.split(/[\s,]+/);
    if (m.length >= 2 && /^[A-Za-z0-9.\-]+$/.test(m[0]) && /^\d+(\.\d+)?%?$/.test(m[1])) rows.push({ i, key: mKey(m[0]), rate: parseFloat(m[1]) });
  });
  return { lines, rows };
}
function setMargin(text, symbol, rate) {   // rate == null → 刪除
  const key = mKey(symbol);
  const { lines, rows } = parseMargin(text);
  const hits = rows.filter(r => r.key === key).map(r => r.i);
  const line = `${key.padEnd(8)} ${rate}`;
  if (rate == null) {
    return lines.filter((_, i) => !hits.includes(i)).join("\n");
  }
  if (hits.length) {
    const out = lines.map((l, i) => (i === hits[0] ? line : l)).filter((_, i) => !hits.slice(1).includes(i));
    return out.join("\n");
  }
  const isHK = key.endsWith(".HK");
  const hkHead = lines.findIndex(l => /^#.*港股/.test(l));
  if (isHK || hkHead < 0) { const tail = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length; const out = [...lines]; out.splice(tail, 0, line); return out.join("\n"); }
  let at = hkHead;                                   // 美股：放喺港股標題之前（跳過前面空行）
  while (at > 0 && lines[at - 1].trim() === "") at--;
  const out = [...lines]; out.splice(at, 0, line);
  return out.join("\n");
}

export default function WatchlistEditor({ C, F, M, isMobile, onClose, onSaved }) {
  const [tab, setTab] = useState("add");
  const [wl, setWl] = useState(null);      // { secs, sha }
  const [mg, setMg] = useState(null);      // { text, sha }
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadFile("watchlist"), loadFile("margin")])
      .then(([w, m]) => { if (alive) { setWl({ secs: parseWl(w.content), sha: w.sha }); setMg({ text: m.content, sha: m.sha }); } })
      .catch(e => alive && setErr(String(e.message || e)));
    return () => { alive = false; };
  }, []);

  const guard = async fn => {
    if (busy) return;
    setBusy(true); setErr(""); setMsg("");
    try { await fn(); } catch (e) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };
  const commitWl = async (secs, message, note) => {
    const sha = await saveFile("watchlist", serializeWl(secs), wl.sha, message);
    setWl({ secs, sha }); setMsg(note); setScanned(false); onSaved && onSaved();
  };
  const commitMg = async (text, message, note) => {
    const sha = await saveFile("margin", text, mg.sha, message);
    setMg({ text, sha }); setMsg(note); onSaved && onSaved();
  };

  const input = { background: C.chip, border: `1px solid ${C.line}`, color: C.txt, padding: "8px 9px", borderRadius: 6, fontFamily: M, fontSize: 16, minWidth: 0 };
  const btn = (on, extra) => ({ background: on ? C.tabOn : C.chip, color: C.txt, border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 12px", fontFamily: M, fontSize: 13, cursor: busy ? "wait" : "pointer", ...extra });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.55)", display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, color: C.txt, fontFamily: F, border: `1px solid ${C.line}`, borderRadius: isMobile ? "14px 14px 0 0" : 14, width: "100%", maxWidth: 560, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", borderBottom: `1px solid ${C.line}` }}>
          {[["add", "加股票"], ["manage", "管理"], ["margin", "孖展率"]].map(([k, l]) => (
            <button key={k} onClick={() => { setTab(k); setErr(""); setMsg(""); }} style={btn(tab === k)}>{l}</button>
          ))}
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={btn(false)}>關閉</button>
        </div>
        <div style={{ padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {!wl || !mg ? <div style={{ color: err ? C.warn : C.mute, fontSize: 13 }}>{err ? `⚠ ${err}` : "載入緊…"}</div> : <>
            {tab === "add" && <AddTab {...{ wl, C, M, input, btn, busy, guard, commitWl, setErr }} />}
            {tab === "manage" && <ManageTab {...{ wl, C, M, input, btn, busy, guard, commitWl }} />}
            {tab === "margin" && <MarginTab {...{ mg, C, M, input, btn, guard, commitMg }} />}
            {err && <div style={{ color: C.warn, fontSize: 13 }}>⚠ {err}</div>}
            {msg && <div style={{ color: C.up, fontSize: 13 }}>✓ {msg}</div>}
            {msg && tab !== "margin" && (
              <div style={{ color: C.mute, fontSize: 12, lineHeight: 1.6 }}>
                報價約 15 分鐘內更新；新股票嘅 TBand／UT／ST 要等下一次收市掃描。
                {" "}<button disabled={scanned} onClick={() => guard(async () => {
                  const r = await fetch("/api/wl-scan", { method: "POST", headers: H });
                  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
                  setScanned(true); setMsg("已叫 Triple Band Radar 立即掃描（約 20–30 分鐘）");
                })} style={btn(false, { padding: "3px 8px", fontSize: 12 })}>{scanned ? "已觸發掃描" : "立即掃描"}</button>
              </div>
            )}
          </>}
        </div>
      </div>
    </div>
  );
}

function AddTab({ wl, C, M, input, btn, busy, guard, commitWl }) {
  const [txt, setTxt] = useState("");
  const [ex, setEx] = useState("auto");
  const [secIdx, setSecIdx] = useState(0);
  const [newSec, setNewSec] = useState("");
  const known = useMemo(() => { const m = {}; wl.secs.forEach(s => s.items.forEach(t => { m[symOf(t).toUpperCase()] = t.split(":")[0]; })); return m; }, [wl]);
  const exists = useMemo(() => new Set(wl.secs.flatMap(s => s.items.map(t => t.toUpperCase()))), [wl]);

  const toToken = raw => {
    const t = raw.trim().toUpperCase().replace(/\.US$/, "");
    if (!t) return null;
    if (t.includes(":")) return t;
    const hk = t.replace(/\.HK$/, "");
    if (/^\d{1,5}$/.test(hk)) return `HKEX:${parseInt(hk, 10)}`;
    if (!/^[A-Z0-9.\-!&]+$/.test(t)) return null;
    return `${ex !== "auto" ? ex : known[t] || "NASDAQ"}:${t}`;
  };
  const go = () => guard(async () => {
    const toks = txt.split(/[\s,，、]+/).map(toToken).filter(Boolean);
    if (!toks.length) throw new Error("冇有效代號");
    const secs = wl.secs.map(s => ({ ...s, items: [...s.items] }));
    let target;
    if (secIdx === -1) {
      const nm = newSec.trim().toUpperCase();
      if (!nm) throw new Error("請輸入新分組名稱");
      secs.push({ head: `###SECTION ${nm}`, items: [] });
      target = secs[secs.length - 1];
    } else target = secs[secIdx];
    const added = [], skipped = [];
    for (const t of toks) {
      if (exists.has(t) || target.items.map(x => x.toUpperCase()).includes(t)) { skipped.push(t); continue; }
      target.items.push(t); added.push(t);
    }
    if (!added.length) throw new Error(`已經喺 Watchlist：${skipped.join(", ")}`);
    await commitWl(secs, `web: add ${added.map(symOf).join(",")} to ${secName(target)}`, `已加 ${added.map(symOf).join(", ")} → ${secName(target)}${skipped.length ? `（跳過已存在：${skipped.map(symOf).join(", ")}）` : ""}`);
    setTxt("");
  });

  return (
    <>
      <div style={{ fontSize: 12, color: C.mute, lineHeight: 1.6 }}>輸入代號（可以一次多隻，空格或逗號分隔）。數字自動當港股；字母預設 NASDAQ，亦可直接寫 <b>NYSE:BA</b>。</div>
      <input value={txt} onChange={e => setTxt(e.target.value)} placeholder="例如 NVDA  或  700 1810" style={input} autoCapitalize="characters" />
      <div style={{ display: "flex", gap: 6 }}>
        <select value={secIdx} onChange={e => setSecIdx(Number(e.target.value))} style={{ ...input, flex: 1 }}>
          {wl.secs.map((s, i) => <option key={i} value={i}>{secName(s)} ({s.items.length})</option>)}
          <option value={-1}>＋ 新分組…</option>
        </select>
        <select value={ex} onChange={e => setEx(e.target.value)} style={{ ...input, flex: "0 0 96px" }}>
          {["auto", "NASDAQ", "NYSE", "AMEX", "CBOE"].map(x => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
      {secIdx === -1 && <input value={newSec} onChange={e => setNewSec(e.target.value)} placeholder="新分組名稱，例如 23-MY IDEAS" style={input} />}
      <button disabled={busy} onClick={go} style={btn(true)}>{busy ? "儲存中…" : "加入"}</button>
    </>
  );
}

function ManageTab({ wl, C, M, input, btn, busy, guard, commitWl }) {
  const [q, setQ] = useState("");
  const [rn, setRn] = useState(null);   // { i, v }
  const matches = useMemo(() => {
    const k = q.trim().toUpperCase();
    if (!k) return [];
    const out = [];
    wl.secs.forEach((s, si) => s.items.forEach(t => { if (symOf(t).toUpperCase().includes(k)) out.push({ si, t }); }));
    return out.slice(0, 40);
  }, [q, wl]);
  const remove = (si, t) => guard(async () => {
    const secs = wl.secs.map((s, i) => (i === si ? { ...s, items: s.items.filter(x => x !== t) } : s));
    await commitWl(secs, `web: remove ${symOf(t)} from ${secName(wl.secs[si])}`, `已移除 ${symOf(t)}（${secName(wl.secs[si])}）`);
  });
  const delSec = si => guard(async () => {
    await commitWl(wl.secs.filter((_, i) => i !== si), `web: delete section ${secName(wl.secs[si])}`, `已刪除分組 ${secName(wl.secs[si])}`);
  });
  const renameSec = () => guard(async () => {
    const nm = (rn?.v || "").trim().toUpperCase();
    if (!nm) throw new Error("名稱唔可以空白");
    const secs = wl.secs.map((s, i) => (i === rn.i ? { ...s, head: `###SECTION ${nm}` } : s));
    await commitWl(secs, `web: rename section → ${nm}`, `已改名 → ${nm}`);
    setRn(null);
  });

  return (
    <>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋要移除嘅代號" style={input} autoCapitalize="characters" />
      {matches.map(({ si, t }) => (
        <div key={si + t} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: M, fontSize: 14, borderBottom: `1px solid ${C.line}`, padding: "5px 0" }}>
          <b style={{ minWidth: 70 }}>{symOf(t)}</b>
          <span style={{ color: C.mute, fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.split(":")[0]} · {secName(wl.secs[si])}</span>
          <button disabled={busy} onClick={() => remove(si, t)} style={btn(false, { padding: "3px 9px", color: C.dn })}>移除</button>
        </div>
      ))}
      {q.trim() && !matches.length && <div style={{ color: C.mute, fontSize: 12 }}>搵唔到</div>}
      <div style={{ fontSize: 12, color: C.mute, marginTop: 6 }}>分組（改名；空分組先可以刪除）</div>
      {wl.secs.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: M, fontSize: 12.5, borderBottom: `1px solid ${C.line}`, padding: "4px 0" }}>
          {rn?.i === i ? <>
            <input value={rn.v} onChange={e => setRn({ i, v: e.target.value })} style={{ ...input, flex: 1, padding: "4px 6px" }} />
            <button disabled={busy} onClick={renameSec} style={btn(true, { padding: "3px 9px" })}>儲存</button>
            <button onClick={() => setRn(null)} style={btn(false, { padding: "3px 9px" })}>取消</button>
          </> : <>
            <span style={{ flex: 1 }}>{secName(s)} <span style={{ color: C.mute }}>({s.items.length})</span></span>
            <button disabled={busy} onClick={() => setRn({ i, v: secName(s) })} style={btn(false, { padding: "3px 9px" })}>改名</button>
            {s.items.length === 0 && <button disabled={busy} onClick={() => delSec(i)} style={btn(false, { padding: "3px 9px", color: C.dn })}>刪除</button>}
          </>}
        </div>
      ))}
    </>
  );
}

function MarginTab({ mg, C, M, input, btn, guard, commitMg }) {
  const [sym, setSym] = useState("");
  const [rate, setRate] = useState("");
  const { rows } = useMemo(() => parseMargin(mg.text), [mg.text]);
  const map = useMemo(() => { const m = {}; rows.forEach(r => { m[r.key] = r.rate; }); return m; }, [rows]);
  const key = sym.trim() ? mKey(sym) : "";
  const cur = key ? map[key] : undefined;
  const list = useMemo(() => {
    const k = sym.trim().toUpperCase();
    const seen = new Set(), out = [];
    for (const r of rows) { if (seen.has(r.key)) continue; seen.add(r.key); if (!k || r.key.includes(k.replace(/\.HK$/, ""))) out.push(r); }
    return out.slice(0, 60);
  }, [rows, sym]);

  const apply = (remove) => guard(async () => {
    if (!key) throw new Error("請輸入代號");
    let val = null;
    if (!remove) {
      const n = parseFloat(String(rate).replace("%", ""));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("比率要係 0–100（0 = 不可融資）");
      val = n;
    }
    await commitMg(setMargin(mg.text, key, val), `web: margin ${key} ${val == null ? "removed" : val}`, val == null ? `已移除 ${key} 孖展率` : `${key} 孖展率 = ${val}%（約 15 分鐘內顯示）`);
    setRate("");
  });

  return (
    <>
      <div style={{ fontSize: 12, color: C.mute, lineHeight: 1.6 }}>0 = 不可融資。儲存後系統自動更新日期，主頁／Watchlist 嘅 superscript 約 15 分鐘內更新。</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={sym} onChange={e => setSym(e.target.value)} placeholder="代號" style={{ ...input, flex: 1 }} autoCapitalize="characters" />
        <input value={rate} onChange={e => setRate(e.target.value)} placeholder={cur != null ? `現時 ${cur}` : "比率 %"} inputMode="decimal" style={{ ...input, flex: "0 0 96px" }} />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => apply(false)} style={btn(true, { flex: 1 })}>{cur != null ? "更新" : "新增"}</button>
        {cur != null && <button onClick={() => apply(true)} style={btn(false, { color: C.dn })}>移除</button>}
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {list.map(r => (
          <div key={r.key} onClick={() => { setSym(r.key); setRate(String(r.rate)); }} style={{ display: "flex", justifyContent: "space-between", fontFamily: M, fontSize: 13.5, borderBottom: `1px solid ${C.line}`, padding: "5px 2px", cursor: "pointer" }}>
            <b>{r.key}</b><span style={{ color: r.rate <= 0 ? C.dn : C.sub }}>{r.rate <= 0 ? "✕ 不可融資" : `${r.rate}%`}</span>
          </div>
        ))}
      </div>
    </>
  );
}
