import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PARENTS } from "./parents";
import { MiniChart } from "./StockDetail";

/**
 * SignalBoard.jsx — 同 TradingView 並排用嘅即時短線信號板（集中睇少數股票）。
 * 名單：/api/sblist（頁面頂部加／減）；卡頭價錢 = /signals.json（推送版 5m），時間格 = /mtf.json。
 * 點股票 → 開 TradingView。
 */
const URL_ = (typeof window !== "undefined" && /[?&]src=2/.test(window.location.search)) ? "/signals2.json" : "/signals.json";   // ?src=2 = 推送版試跑
const THEMES = {
  dark: { bg: "#0f1112", card: "#151718", line: "#26292c", soft: "#1d1f21", txt: "#e3e4e5", sub: "#b9babd", dim: "#9b9b9e", mute: "#75777a", up: "#14ac9c", dn: "#f23c75", warn: "#f5a623", acc: "#3b9eff", yel: "#e8c34a" },
  light: { bg: "#f3f4f6", card: "#ffffff", line: "#d9dde2", soft: "#e8ebef", txt: "#1b1f24", sub: "#3c444d", dim: "#56606b", mute: "#6b7580", up: "#00875a", dn: "#c81e3f", warn: "#a55a00", acc: "#0b6bcb", yel: "#9a7400" },
};
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";   // 數字/標籤字體：iOS 系統字 (SF Pro)，同 Longbridge app 一致；配 tabular-nums
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
const MIN = { "5m": 5, "15m": 15, "1h": 60 };   // TradingView interval

function beep() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(a.currentTime + 0.18);
  } catch { /* 靜音 */ }
}
const stamp = iso => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return `${p.day} ${p.month} ${p.hour}:${p.minute}:${p.second} HKT`;
  } catch { return ""; }
};

// Signal Board 名單：預設值；實際名單由 /api/sblist 讀取（頁面頂部可增減）
const DEFAULT_ORDER = ["INTC", "NVDA", "BABA", "NOK", "CRWV", "TTD", "MRNA", "HIMS", "RKLB", "SKHY", "SKHX", "SPCX", "0968.HK"];

export default function SignalBoard({ isMobile, light, onBack }) {
  const T = light ? THEMES.light : THEMES.dark;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const tfs = data?.tfs?.length ? data.tfs : ["5m"];      // 推送版只有 5m；時間格另由 mtf.json 供應
  const tf = tfs.includes("5m") ? "5m" : tfs[0];
  const [side, setSide] = useState("all");      // all | bull | bear
  const [q, setQ] = useState("");
  const [sound, setSound] = useState(false);
  const [list, setList] = useState(null);        // 名單（gateway /api/sblist）；未載入前用預設
  const [addIn, setAddIn] = useState("");
  const [sbMsg, setSbMsg] = useState("");
  const [sbBusy, setSbBusy] = useState(false);
  const [openSym, setOpenSym] = useState(() => new Set());     // 展開咗圖表嘅股票
  const [ctf, setCtf] = useState("5m");                         // 展開圖表嘅級別（5m／15m／1h）
  const toggleOpen = sym => setOpenSym(o => { const n = new Set(o); if (n.has(sym)) n.delete(sym); else n.add(sym); return n; });
  const TEST_ORDER = list || DEFAULT_ORDER;
  const TEST_SYMS = useMemo(() => new Set(TEST_ORDER), [list]);
  useEffect(() => {
    let alive = true;
    fetch("/api/sblist", { cache: "no-store" }).then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(j => alive && setList(j.symbols || null)).catch(() => {});
    return () => { alive = false; };
  }, []);
  const saveList = async next => {
    setSbBusy(true); setSbMsg("");
    try {
      const r = await fetch("/api/sblist", { method: "PUT", headers: { "Content-Type": "application/json", "X-Requested-With": "xmarket" }, body: JSON.stringify({ symbols: next }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      setList(j.symbols); return j.symbols;
    } catch (e) { setSbMsg(`儲存失敗：${e.message || e}`); return null; }
    finally { setSbBusy(false); }
  };
  const addSyms = async () => {
    const parts = addIn.split(/[\s,，、]+/).filter(Boolean);
    if (!parts.length) return;
    const cur = list || DEFAULT_ORDER;
    const out = await saveList([...cur, ...parts]);
    if (out) {
      const n = out.length - cur.length;
      setAddIn(""); setSbMsg(n > 0 ? `已加入 ${n} 隻，下一輪掃描（約 1 分鐘）後出訊號` : "冇新增（格式唔啱或已經喺名單）");
    }
  };
  const removeSym = sym => saveList((list || DEFAULT_ORDER).filter(x => x !== sym));
  const seen = useRef({});                       // sym → 最新信號 key（用嚟判斷有冇新信號）

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(URL_, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`signals.json ${r.status}`); return r.json(); })
      .then(j => { if (alive) { setData(j); setErr(null); } })
      .catch(e => alive && setErr(String(e.message || e)));
    pull(); const id = setInterval(pull, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const [mtf, setMtf] = useState(null);       // mtf.json → { tfs, rows: { SYM: { "5m": {tb,hv,ut,*_ago}, ... } } }（全部股票）
  useEffect(() => {
    let alive = true;
    const pull = () => fetch("/mtf.json", { cache: "no-store" }).then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive && j && j.rows) setMtf(j); }).catch(() => {});
    pull(); const id = setInterval(pull, 20000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const [ema, setEma] = useState({});          // daily.json → sym -> [{p,above,valid}]（今日棒用即時價，盤中會變）
  useEffect(() => {
    let alive = true;
    const pull = () => fetch("/daily.json", { cache: "no-store" }).then(r => (r.ok ? r.json() : null))
      .then(j => { if (!alive || !j) return; const m = {}; for (const r of j.rows || []) m[r.sym] = r.ema; setEma(m); }).catch(() => {});
    pull(); const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const out = [];
    for (const r of data.rows) {
      let d = r[tf]; if (!d) continue;
      const score = Math.max(d.bull, d.bear);
      const dir = d.bull === d.bear ? (d.bull ? "mix" : "none") : d.bull > d.bear ? "bull" : "bear";
      const first = d.ev.length ? Math.min(...d.ev.map(e => e.ago)) : 999;
      out.push({ ...r, d, score, dir, first });
    }
    return out;
  }, [data, tf]);

  const shown = useMemo(() => {
    const k = q.trim().toUpperCase();
    return rows.filter(r => TEST_SYMS.has(r.sym) && (!k || r.sym.includes(k)) && (side === "all" || r.dir === side || r.dir === "mix"))
      .sort((a, b) => TEST_ORDER.indexOf(a.sym) - TEST_ORDER.indexOf(b.sym));      // 測試階段：固定次序（唔再按信號新舊跳位）
  }, [rows, q, side, list]);

  // 名單入面有、但 signals.json 未有數據嘅股票（啱加入，後台未計好）→ 顯示「處理中」卡
  const pending = useMemo(() => {
    if (!data || side !== "all") return [];
    const have = new Set(rows.map(r => r.sym)), k = q.trim().toUpperCase();
    return TEST_ORDER.filter(x => !have.has(x) && (!k || x.includes(k)));
  }, [data, rows, TEST_ORDER, q, side]);

  // 有股票出現新信號（最新一至兩支棒內）→ 響
  useEffect(() => {
    if (!rows.length) return;
    let ping = false;
    const first = Object.keys(seen.current).length === 0;
    for (const r of rows) {
      const e = [...r.d.ev].sort((a, b) => a.ago - b.ago)[0];
      const key = e ? `${e.k}@${e.t}` : "";
      if (!first && key && key !== seen.current[r.sym] && e.ago <= 1 && e.k === "TB" && e.tier === "strong") ping = true;   // 只喺 TB★ 先響
      seen.current[r.sym] = key;
    }
    if (ping && sound) beep();
  }, [rows, sound]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(id); }, []);
  const age = data ? (now - new Date(data.updated).getTime()) / 1000 : 0;
  const chip = (on, extra) => ({
    background: on ? T.soft : "transparent", color: on ? T.txt : T.dim,
    border: `1px solid ${on ? T.line : "transparent"}`, borderRadius: 7, padding: isMobile ? "5px 7px" : "5px 10px",
    fontFamily: M, fontSize: 12, cursor: "pointer", ...extra,
  });

  // 三條長短不一嘅垂直線（音量 / 提示音）；開 = 亮色，靜音 = 灰淡
  const SoundIcon = ({ on }) => (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block" }}>
      <g stroke={on ? T.acc : T.mute} strokeWidth="2" strokeLinecap="round" opacity={on ? 1 : 0.7}>
        <line x1="3" y1="6" x2="3" y2="10" /><line x1="8" y1="2.5" x2="8" y2="13.5" /><line x1="13" y1="5" x2="13" y2="11" />
      </g>
      {!on && <line x1="2" y1="14" x2="14" y2="2" stroke={T.mute} strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
  const SideAndSound = () => (
    <>
      <div style={{ display: "flex", gap: 2 }}>
        {[["all", "全部"], ["bull", "偏多"], ["bear", "偏空"]].map(([k, l]) => <button key={k} onClick={() => setSide(k)} style={chip(side === k)}>{l}</button>)}
      </div>
      <button onClick={() => setSound(v => !v)} title={sound ? "提示音：開" : "提示音：靜音"} aria-label={sound ? "提示音開" : "提示音靜音"}
        style={chip(sound, { padding: "6px 8px", display: "flex", alignItems: "center", flexShrink: 0 })}><SoundIcon on={sound} /></button>
    </>
  );

  // Longbridge 式斜體灰色徽章（同 Home 一致）
  const SessBadge = ({ s, ml = 5 }) => {
    const t = { 夜盤: "24h", 盤前: "Pre", 盤後: "Post" }[s];
    if (!t) return null;
    return <span title={{ "24h": "夜盤 24h overnight", Pre: "盤前 Pre-market", Post: "盤後 Post-market" }[t]}
      style={{ display: "inline-block", transform: "skewX(-12deg)", marginLeft: ml, background: T.line, color: T.sub, fontFamily: M,
        fontSize: 9.5, fontWeight: 700, fontStyle: "italic", lineHeight: 1.25, padding: "1px 5px", borderRadius: 3, verticalAlign: "middle", whiteSpace: "nowrap" }}>{t}</span>;
  };

  const gridOf = sym => (TEST_SYMS.has(sym) ? mtf?.rows?.[sym]?.grid : null);
  // 24 小時連續時間格（mtf.json rows[sym].grid = {t0, cl, tf:[[slot,len,flags],...]}）：最近 24h = 288 個 5m 格，
  // 夜盤 / 盤前 / 正規 / 盤後（美東）用顏色分段；一開頁自動捲到最近 1 小時，可左右拉開睇更早
  const G_TFS = ["5m", "15m", "1h", "2h", "4h"];
  const G_ROW = 11;                      // 訊號表每行高度 px（原 16）
  const G_UNIT = isMobile ? 13 : 9;      // 每個 5m 格闊度 px
  const G_BLUE = "#3b9eff";
  const SESS = [[0, 240, "夜盤"], [240, 570, "盤前"], [570, 960, "正規"], [960, 1200, "盤後"], [1200, 1440, "夜盤"]];
  const SESS_HK = [[0, 570, "休市"], [570, 720, "早市"], [720, 780, "午休"], [780, 960, "午市"], [960, 1440, "休市"]];   // 港股（HKT）
  const hkFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const hkMinOf = ts => { const p = hkFmt.formatToParts(new Date(ts * 1000)); return +p.find(x => x.type === "hour").value * 60 + +p.find(x => x.type === "minute").value; };
  const tvSym = sym => (sym.endsWith(".HK") ? `HKEX:${parseInt(sym, 10)}` : sym);
  const etFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const etMinOf = ts => { const p = etFmt.formatToParts(new Date(ts * 1000)); return +p.find(x => x.type === "hour").value * 60 + +p.find(x => x.type === "minute").value; };
  const hh = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const Grid = ({ sym, head }) => {
    const g = gridOf(sym);
    if (!g || !g.t0) return null;
    const G_N = g.n || 96, W = G_N * G_UNIT, cl = g.cl ?? G_N - 1, hk = !!g.hk, m0 = hk ? hkMinOf(g.t0) : etMinOf(g.t0);
    const SS = hk ? SESS_HK : SESS, isReg = m => (hk ? (m >= 570 && m < 720) || (m >= 780 && m < 960) : m >= 570 && m < 960);
    // 時段分段（按美東分鐘計；窗口內 DST 轉換忽略）
    const segs = []; let cur = null;
    for (let s = 0; s < G_N; s++) {
      const m = (m0 + s * 5) % 1440, sg = SS.find(x => m >= x[0] && m < x[1])[2];
      const key = hk ? sg : sg + "@" + (m >= 570 && m < 960 ? "R" : m >= 240 && m < 570 ? "P" : m >= 960 && m < 1200 ? "A" : "N");
      if (!cur || cur.key !== key) { cur = { key, name: sg, from: s, to: s + 1, reg: isReg(m) }; segs.push(cur); } else cur.to = s + 1;
    }
    const ticks = []; for (let s = 0; s < G_N; s++) if ((m0 + s * 5) % 60 === 0) ticks.push([s, (m0 + s * 5) % 1440]);
    return (
      <div ref={el => { if (el && !el.__init) { el.scrollLeft = Math.max(0, 24 + cl * G_UNIT - el.clientWidth * 0.72); el.__init = 1; } }}
        style={{ marginTop: 6, overflowX: "auto", overflowY: "hidden", overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch" }} >
        <div style={{ display: "grid", gridTemplateColumns: `24px ${W}px`, rowGap: 0, alignItems: "center", width: "max-content" }}>
          {head && <><span style={{ position: "sticky", left: 0, zIndex: 2, background: T.card }} /><div style={{ position: "relative", height: 10 }}>
            {ticks.map(([s, m]) => <span key={s} style={{ position: "absolute", left: s * G_UNIT, fontFamily: M, fontSize: 9, fontWeight: 600, color: T.sub, transform: "translateX(-2px)" }}>{hh(m)}</span>)}
          </div></>}
          <span style={{ position: "sticky", left: 0, zIndex: 2, background: T.card }} /><div style={{ position: "relative", height: 11 }}>
            {segs.map(sg => <div key={sg.from} style={{ position: "absolute", left: sg.from * G_UNIT, width: (sg.to - sg.from) * G_UNIT, height: 11, boxSizing: "border-box",
              background: sg.reg ? "transparent" : T.soft, borderBottom: `2px solid ${sg.reg ? T.acc : T.line}`, fontFamily: M, fontSize: 9, fontWeight: 600, color: sg.reg ? T.acc : T.sub,
              whiteSpace: "nowrap", lineHeight: "9px" }}><span style={{ position: "sticky", left: 28, paddingLeft: 3 }}>{(sg.to - sg.from) * G_UNIT >= 40 ? sg.name : ""}</span></div>)}
          </div>
          {G_TFS.map(tf => {
            const rows = g[tf];
            return (
              <Fragment key={tf}>
                <span style={{ fontFamily: M, fontSize: 9.5, fontWeight: 700, color: T.sub, position: "sticky", left: 0, zIndex: 2, background: T.card, alignSelf: "stretch", display: "flex", alignItems: "center" }}>{tf}</span>
                <div style={{ position: "relative", height: G_ROW, width: W, opacity: rows ? 1 : 0.35, borderBottom: `1px solid ${T.line}` }} title={rows ? undefined : `${tf} 數據不足`}>
                  {(rows || []).map(([sl, ln, fl]) => {
                    const w = ln * G_UNIT, done = sl + ln <= cl;
                    const ub = !!(fl & 1), us = !!(fl & 2), hb = !!(fl & 4), hs = !!(fl & 8), tb = !!(fl & 16);
                    const bg = tb ? G_BLUE + "66" : "transparent";          // TB 真入市 = 藍底
                    const hvc = hb ? T.up : hs ? T.dn : null;                // Heavy 買／賣 = 綠／紅框
                    const label = [ub && "UT 買", us && "UT 賣", hb && "Heavy 買", hs && "Heavy 賣", tb && "TB 真入市"].filter(Boolean).join(" + ");
                    const col = ub ? T.up : T.dn;
                    return (
                      <div key={sl} title={fl ? `${tf} · ${hh((m0 + sl * 5) % 1440)} ${hk ? "HKT" : "ET"} · ${label}` : undefined}
                        style={{ position: "absolute", left: sl * G_UNIT, width: w, height: G_ROW, boxSizing: "border-box", background: bg,
                          borderLeft: `1px ${done ? "solid" : "dashed"} ${T.line}`, boxShadow: hvc ? `inset 0 0 0 2px ${hvc}` : undefined,
                          opacity: done ? 1 : 0.45, display: "flex", alignItems: "center", justifyContent: "center",
                          fontFamily: M, fontSize: 9, fontWeight: 700, lineHeight: 1, color: col, overflow: "hidden" }}>
                        {(ub || us) ? <span style={{ width: 5, height: 5, borderRadius: "50%", background: col }} /> : null}
                      </div>
                    );
                  })}
                  {cl > 0 && cl < G_N && <div style={{ position: "absolute", left: cl * G_UNIT, top: -1, width: 1, height: G_ROW + 2, background: T.warn }} />}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  };

  // 展開圖表：撳卡（UT／HV／TB 時間格）展開，K 線 + UT 三角、TB 真入市（實心橙三角）、Heavy（綠／紅空心方格）
  const ChartPanel = ({ sym }) => {
    const ch = mtf?.rows?.[sym]?.chart, c = ch?.[ctf];
    return (
      <div onClick={e => e.stopPropagation()} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.line}`, cursor: "default" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
          {["5m", "15m", "1h"].map(x => <button key={x} type="button" onClick={() => setCtf(x)} style={chip(ctf === x)}>{x}</button>)}
          <span style={{ flex: 1 }} />
          <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym(sym))}&interval=${MIN[ctf] ?? 60}`} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: M, fontSize: 11.5, color: T.acc, textDecoration: "none" }}>TradingView ↗</a>
        </div>
        {c ? <MiniChart bars={c.b} emas={c.e} utf={c.u} tbf={c.tb} hvf={c.hv} tf={ctf} T={T} />
          : <div style={{ color: T.mute, fontFamily: M, fontSize: 12, padding: "14px 0", textAlign: "center" }}>呢個級別暫時冇圖表數據（下一輪掃描後出現）</div>}
      </div>
    );
  };

  const cardBox = { background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "10px 12px", minWidth: 0 };   // 每隻股票一張卡（同 My List 一樣）
  const Card = ({ r }) => {
    const lb = r.reg > 0 && r.pc > 0;
    const last = lb ? r.reg : r.px;
    const chg = lb ? (r.reg / r.pc - 1) * 100 : r.chg;
    const ext = lb && r.sess && r.sess !== "盤中" && r.px > 0 ? (r.px / r.reg - 1) * 100 : null;
    const pf = v => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
    const cc = v => (v >= 0 ? T.up : T.dn);
    const par = PARENTS[r.sym];
    const em = ema[r.sym];
    return (
      <div onClick={() => toggleOpen(r.sym)} style={{ ...cardBox, padding: "9px 12px 8px", cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", minWidth: 0, gap: 5, minHeight: 24 }}>
              {par && <span style={{ fontSize: 9.5, color: T.mute, fontWeight: 400, flexShrink: 0 }}>{par} ›</span>}
              <span style={{ fontWeight: 500, fontSize: 16, flexShrink: 0, alignSelf: "center" }}>{r.sym}</span>
              <button type="button" title="由名單移除" aria-label={`移除 ${r.sym}`} disabled={sbBusy}
              onClick={e => { e.stopPropagation(); removeSym(r.sym); }}
              style={{ background: "none", border: "none", color: T.mute, fontSize: 13, cursor: "pointer", padding: "0 4px", marginLeft: 2, lineHeight: 1, alignSelf: "center" }}>✕</button>
              {em && <span style={{ display: "flex", gap: 2, flexShrink: 0, marginLeft: 1, alignSelf: "center" }}>
                {em.map(e => <span key={e.p} style={{ fontFamily: M, fontSize: 9, fontWeight: 600, padding: "1px 3px", borderRadius: 3, background: (!e.valid ? T.mute : e.above ? T.up : T.dn) + "26", color: !e.valid ? T.mute : e.above ? T.up : T.dn }}>{e.p}</span>)}
              </span>}
            </div>
          </div>
          <div style={{ flexShrink: 0, whiteSpace: "nowrap", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ fontFamily: M, fontSize: 15, fontWeight: 600 }}>{last?.toFixed(2)}</span>
              {chg != null && <span style={{ fontFamily: M, fontSize: 12.5, fontWeight: 600, minWidth: 66, textAlign: "right", padding: "2px 5px", borderRadius: 4, background: cc(chg), color: "#fff" }}>{pf(chg)}</span>}
            </div>
            {ext != null && <div style={{ fontFamily: M, fontSize: 12.5, color: T.dim }}>
              {r.px.toFixed(2)} <span style={{ color: cc(ext) }}>{pf(ext)}</span>{SessBadge({ s: r.sess, ml: 4 })}</div>}
          </div>
        </div>
        {Grid({ sym: r.sym, head: true })}
        {openSym.has(r.sym) && ChartPanel({ sym: r.sym })}
      </div>
    );
  };

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.txt, fontFamily: SANS, padding: isMobile ? "14px 7px 40px" : "22px 28px 40px", boxSizing: "border-box", width: "100%", maxWidth: "100vw", overflowX: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minHeight: 20, marginBottom: 10 }}>
        {onBack && <button onClick={onBack} style={chip(false, { border: `1px solid ${T.line}` })}>← Home</button>}
        <div style={{ fontFamily: M, fontSize: 12, color: err ? T.dn : T.dim }}>
          {err ? `⚠ ${err}` : data ? <><span style={{ color: age > 180 ? T.dn : T.up }}>●</span> {stamp(data.updated)} · {data.n} 隻{age > 180 ? ` · ⚠ ${Math.round(age / 60)} 分鐘冇更新` : ""}</> : "loading…"}
        </div>
      </div>

      <div style={{ display: "flex", gap: isMobile ? 4 : 8, alignItems: "center", marginBottom: 8, flexWrap: isMobile ? "nowrap" : "wrap" }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={isMobile ? "搜尋" : "搜尋 symbol"}
          style={{ background: T.card, border: `1px solid ${T.line}`, color: T.txt, borderRadius: 7, padding: isMobile ? "6px 8px" : "6px 10px", fontFamily: M, fontSize: 12, width: isMobile ? "auto" : 130, flex: isMobile ? 1 : "0 0 auto", minWidth: 0 }} />
        <SideAndSound />
      </div>
      <div style={{ display: "flex", gap: 8, margin: "0 0 8px", maxWidth: 520 }}>
        <input value={addIn} onChange={e => setAddIn(e.target.value)} onKeyDown={e => e.key === "Enter" && addSyms()}
          placeholder="加股票：NVDA、968、3868 …" disabled={sbBusy}
          style={{ flex: 1, minWidth: 0, background: T.soft, color: T.txt, border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 12px", fontSize: 14, fontFamily: SANS, outline: "none" }} />
        <button type="button" onClick={addSyms} disabled={sbBusy || !addIn.trim()}
          style={{ background: T.acc, color: "#fff", border: "none", borderRadius: 8, padding: "0 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: sbBusy || !addIn.trim() ? 0.5 : 1 }}>加入</button>
      </div>
      {sbMsg && <div style={{ fontFamily: SANS, fontSize: 11.5, color: sbMsg.startsWith("儲存失敗") ? T.dn : T.mute, marginBottom: 8 }}>{sbMsg}</div>}

      <div style={{ fontSize: 11, color: T.mute, fontFamily: M, marginBottom: 10, lineHeight: 1.6 }}>
        時間格：綠／紅點 = UT 轉向（買／賣）、綠／紅框 = Heavy 買／賣、藍底 = TB 真入市（日內未驗證）、虛線淡色 = 未收市（暫時訊號，收市前可能消失）、黃線 = 現時 · 時間軸 = 過去 6 小時 + 未來 2 小時（美東時間；夜盤 / 盤前 / 正規 / 盤後分段），現時線約喺 70% 位置並自動跟住，可左右拉
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(440px, 1fr))", gap: 12, maxWidth: "100%" }}>
        {shown.map(r => <Fragment key={r.sym}>{Card({ r })}</Fragment>)}
        {pending.map(sym => (
          <div key={`p-${sym}`} style={{ ...cardBox, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 500, fontSize: 16 }}>{sym}</span>
            <span style={{ fontSize: 12, color: T.mute, fontFamily: SANS, flex: 1 }}>數據處理中，約 1–2 分鐘內出訊號…</span>
            <button type="button" title="由名單移除" disabled={sbBusy} onClick={() => removeSym(sym)}
              style={{ background: "none", border: "none", color: T.mute, fontSize: 13, cursor: "pointer", padding: "0 4px" }}>✕</button>
          </div>))}
        {data && !shown.length && !pending.length && <div style={{ color: T.mute, textAlign: "center", padding: 28, fontFamily: M, fontSize: 12 }}>呢個條件下暫時冇信號</div>}
      </div>
      <div style={{ fontFamily: M, fontSize: 10.5, color: T.mute, marginTop: 12, lineHeight: 1.6 }}>
        備註：EMA 10 黃／20 綠／50 紅／89 橙 · 白三角 = UT 買／賣 · 橙實心三角 = TB 真入市 · 綠／紅空心方 = Heavy 買／賣 · 最後一棒未收市時訊號係暫時
      </div>
    </div>
  );
}
