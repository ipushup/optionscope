import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * MyList.jsx — 自選股「宏觀看法」：每隻股一張卡，3 欄（日 D / 週 W / 月 M）× 7 行
 *   UT   B2 / S12：UT Bot 現時方向 + 持續咗幾多棒（轉向嗰棒 = 1）
 *   HV   B2 / S5 ：Heavy 最近標記 + 幾多棒前（最新棒 = 1）
 *   EMA10 / 20 / 50 / 89 / 250：收市價喺 EMA 之上 = 綠點、之下 = 紅點、歷史唔夠 = 灰點
 * 數據：/mylist.json（scanner/mylist.py 每分鐘出）；報價：/api/quotes（Worker 代 Longbridge，同 Home 一樣）；
 * 清單：/api/mylist（登入後可增減，存喺 gateway）。
 */
const THEMES = {
  dark: { bg: "#0f1112", card: "#151718", line: "#26292c", soft: "#1d1f21", txt: "#e3e4e5", sub: "#b9babd", dim: "#9b9b9e", mute: "#75777a", up: "#14ac9c", dn: "#f23c75", warn: "#f5a623", acc: "#3b9eff" },
  light: { bg: "#f3f4f6", card: "#ffffff", line: "#d9dde2", soft: "#e8ebef", txt: "#1b1f24", sub: "#3c444d", dim: "#56606b", mute: "#6b7580", up: "#00875a", dn: "#c81e3f", warn: "#b56100", acc: "#0b6bcb" },
};
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
const TFS = [["D", "D"], ["W", "W"], ["M", "M"]];
const EMAS = ["10", "20", "50", "89", "250"];
const SESS = { pre: ["Pre", "盤前 Pre-market"], post: ["Post", "盤後 Post-market"], overnight: ["24h", "夜盤 24h overnight"] };
const LBL_W = 56, COL_W = 64;

const short = s => (s || "").replace(/\.US$/, "").replace(/\.HK$/, "");
const fmtPx = (v, sym) => (v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: sym.endsWith(".HK") && v < 1 ? 3 : 2 }));

export default function MyList({ isMobile, light }) {
  const T = light ? THEMES.light : THEMES.dark;
  const [syms, setSyms] = useState(null);       // 清單（gateway）
  const [data, setData] = useState(null);       // mylist.json
  const [live, setLive] = useState({});         // sym → quote
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(null);      // 開咗操作選單嘅 symbol

  // 清單
  useEffect(() => {
    let alive = true;
    fetch("/api/mylist", { cache: "no-store" }).then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(j => alive && setSyms(j.symbols || [])).catch(e => alive && setMsg(`讀取清單失敗（${e}）`));
    return () => { alive = false; };
  }, []);

  // 計算結果（後台每分鐘更新）
  useEffect(() => {
    let alive = true;
    const pull = () => fetch("/mylist.json", { cache: "no-store" }).then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive && j && j.rows) setData(j); }).catch(() => {});
    pull(); const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // 即時報價
  const key = (syms || []).join(",");
  useEffect(() => {
    if (!key) return undefined;
    let dead = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(key)}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json(); const m = {};
        for (const q of j.quotes || []) m[q.symbol] = q;
        if (!dead) setLive(m);
      } catch { /* 下次再試 */ }
    };
    tick(); const id = setInterval(tick, 10000);
    return () => { dead = true; clearInterval(id); };
  }, [key]);

  const save = useCallback(async next => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/mylist", { method: "PUT", headers: { "Content-Type": "application/json", "X-Requested-With": "xmarket" }, body: JSON.stringify({ symbols: next }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      setSyms(j.symbols); return j.symbols;
    } catch (e) { setMsg(`儲存失敗：${e.message || e}`); return null; }
    finally { setBusy(false); }
  }, []);

  const add = async () => {
    const parts = input.split(/[\s,，、]+/).filter(Boolean);
    if (!parts.length || !syms) return;
    const out = await save([...syms, ...parts]);
    if (out) {
      const added = out.length - syms.length;
      setInput("");
      setMsg(added > 0 ? `已加入 ${added} 隻，約 1 分鐘內出指標` : "冇新增（格式唔啱或已經喺清單）");
    }
  };
  const remove = s => { setMenu(null); return save((syms || []).filter(x => x !== s)); };
  const move = (s, d) => {
    const a = [...syms]; const i = a.indexOf(s); const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]]; save(a);          // 選單保持打開，可連續上移／下移
  };

  const rows = useMemo(() => syms || [], [syms]);

  // 一個格：UT / HV 顯示 B2 / S12；EMA 顯示點
  const txtCell = (v, tip) => (v
    ? <span title={tip} style={{ color: v.s === 1 ? T.up : T.dn, fontWeight: 600 }}>{v.s === 1 ? "B" : "S"}{v.n}</span>
    : <span style={{ color: T.mute }}>—</span>);
  const dot = v => (v == null
    ? <span title="歷史棒數不足" style={{ display: "inline-block", width: 9, height: 9, borderRadius: 5, background: T.line }} />
    : <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 5, background: v ? T.up : T.dn }} />);

  const Card = ({ sym }) => {
    const r = data?.rows?.[sym];
    const q = live[sym];
    const sess = q && SESS[q.session];
    const up = (q?.pct ?? 0) >= 0;
    const cell = { width: COL_W, textAlign: "center", fontFamily: M, fontSize: 12.5, lineHeight: 1 };
    return (
      <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "10px 14px 8px", minWidth: 0, position: "relative" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div role="button" tabIndex={0} title="撳一下：上移／下移／移除" onClick={() => setMenu(menu === sym ? null : sym)}
              onKeyDown={e => (e.key === "Enter" || e.key === " ") && setMenu(menu === sym ? null : sym)}
              style={{ display: "inline-flex", alignItems: "baseline", gap: 8, cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
              <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: 16 }}>{short(sym)}</span>
              {sym.endsWith(".HK") && <span style={{ fontFamily: M, fontSize: 10, color: T.mute }}>HK</span>}
              <span aria-hidden="true" style={{ fontSize: 9, color: T.mute }}>▾</span>
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11, color: T.mute, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 170 }}>{r?.name || " "}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontFamily: M, fontSize: 14.5, fontWeight: 600 }}>{fmtPx(q?.last, sym)}</span>
              {q && <span style={{ fontFamily: M, fontSize: 12.5, fontWeight: 600, minWidth: 62, textAlign: "right", padding: "2px 5px", borderRadius: 4, background: up ? T.up : T.dn, color: "#fff" }}>{up ? "+" : "−"}{Math.abs(q.pct).toFixed(2)}%</span>}
            </div>
            {sess && <span title={sess[1]} style={{ display: "inline-block", transform: "skewX(-12deg)", background: T.line, color: T.sub, fontFamily: M, fontSize: 9.5, fontWeight: 700, fontStyle: "italic", lineHeight: 1.25, padding: "1px 5px", borderRadius: 3 }}>{sess[0]}</span>}
          </div>
        </div>

        <div style={{ marginTop: 8, borderTop: `1px solid ${T.line}`, paddingTop: 6 }}>
          {!r ? <div style={{ fontFamily: SANS, fontSize: 12, color: T.mute, padding: "10px 0" }}>計算中…（新加入嘅股票約 1 分鐘內出指標）</div> : (
            <>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
                <span style={{ width: LBL_W }} />
                {TFS.map(([k, t]) => <span key={k} style={{ ...cell, fontSize: 11, color: T.mute }}>{t}</span>)}
              </div>
              {[["ut", "UT", "UT Bot：B = 買方向、S = 賣方向，數字 = 持續咗幾多棒"], ["hv", "HV", "Heavy：B = Heavy Buy、S = Heavy Sell，數字 = 幾多棒前（最新棒 = 1）"]].map(([k, l, tip]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", height: 15 }}>
                  <span title={tip} style={{ width: LBL_W, fontFamily: M, fontSize: 11, color: T.mute }}>{l}</span>
                  {TFS.map(([tk]) => <span key={tk} style={cell}>{r[tk] ? txtCell(r[tk][k], tip) : <span style={{ color: T.mute }}>—</span>}</span>)}
                </div>
              ))}
              <div style={{ borderTop: `1px dashed ${T.line}`, margin: "3px 0" }} />
              {EMAS.map(p => (
                <div key={p} style={{ display: "flex", alignItems: "center", height: 14 }}>
                  <span title={`收市價喺 EMA${p} 之上 = 綠、之下 = 紅`} style={{ width: LBL_W, fontFamily: M, fontSize: 11, color: T.mute }}>EMA{p}</span>
                  {TFS.map(([tk]) => <span key={tk} style={cell}>{dot(r[tk] ? r[tk].ema?.[p] : null)}</span>)}
                </div>
              ))}
            </>
          )}
        </div>

        {menu === sym && (
          <>
            <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
            <div role="menu" style={{ position: "absolute", left: 10, top: 44, zIndex: 21, background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", minWidth: 120, overflow: "hidden" }}>
              {[["↑  上移", () => move(sym, -1), T.txt, rows.indexOf(sym) === 0], ["↓  下移", () => move(sym, 1), T.txt, rows.indexOf(sym) === rows.length - 1], ["✕  移除", () => remove(sym), T.dn, false]].map(([t, f, col, off], i) => (
                <button key={t} type="button" role="menuitem" disabled={busy || off} onClick={f}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: i ? `1px solid ${T.line}` : "none", color: col, opacity: off ? 0.35 : 1, fontSize: 14, fontFamily: SANS, padding: "10px 14px", cursor: off ? "default" : "pointer" }}>{t}</button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: T.bg, color: T.txt, minHeight: "100vh", fontFamily: SANS, padding: isMobile ? "14px 14px 40px" : "18px 24px 40px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontFamily: M, fontSize: 12, color: T.mute }}>
        <span style={{ letterSpacing: "0.12em" }}>MY LIST</span>
        <span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{data?.updated ? `updated ${new Date(data.updated).toLocaleTimeString("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit" })} HKT` : ""}</span>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "12px 0 10px", maxWidth: 520 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && add()}
          placeholder="加股票：NVDA、968、3868 …" disabled={busy || !syms}
          style={{ flex: 1, minWidth: 0, background: T.soft, color: T.txt, border: `1px solid ${T.line}`, borderRadius: 8, padding: "9px 12px", fontSize: 14, fontFamily: SANS, outline: "none" }} />
        <button type="button" onClick={add} disabled={busy || !input.trim() || !syms}
          style={{ background: T.acc, color: "#fff", border: "none", borderRadius: 8, padding: "0 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: busy || !input.trim() ? 0.5 : 1 }}>加入</button>
      </div>
      {msg && <div style={{ fontFamily: SANS, fontSize: 11.5, color: msg.startsWith("儲存失敗") || msg.startsWith("讀取") ? T.dn : T.mute, marginBottom: 8 }}>{msg}</div>}

      {!syms ? <div style={{ color: T.mute, fontSize: 13 }}>載入中…</div> : rows.length === 0 ? (
        <div style={{ color: T.mute, fontSize: 13 }}>清單係空嘅，喺上面加入股票。</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(330px, 1fr))", gap: 12 }}>
          {rows.map(s => <Card key={s} sym={s} />)}
        </div>
      )}
      <div style={{ fontFamily: SANS, fontSize: 11.5, color: T.mute, marginTop: 14, lineHeight: 1.6 }}>字母 = 美股；數字 = 港股（968 即 0968.HK）。D／W／M 以最新一棒（未收線）計算。</div>
    </div>
  );
}

const btn = T => ({ background: "none", border: "none", color: T.mute, fontSize: 12, cursor: "pointer", padding: "2px 4px", fontFamily: "inherit" });
