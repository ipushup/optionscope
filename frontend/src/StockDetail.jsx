import { useEffect, useRef, useState } from "react";
import { marketsClosed, hkClosed } from "./marketHours";
import STOCK_NAMES from "./names.json";
import { chartSeries } from "./indicators";
import FUND from "./fundamentals.json";   // {ticker: [總股本, EPS TTM]}（算市盈率／總市值）

/**
 * StockDetail.jsx — 股票展開內容（Home 03 共振榜、Data 頁共用）
 *   第 1 行：股票名 + EMA 10/20/50/89/250 + 目前時段（盤前／盤後／24h）價
 *   第 2 行：撳圖輪流切換 D → W → M 嘅 K 線（疊 EMA 線、UT 三角形）+ 8 項數據
 * 主題色用傳入嘅 T（up / dn / mute / dim / txt / line / bg / sub）。
 */
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";
function fmt(v, d = 2) { return v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function pctText(p) { return p == null ? "" : `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`; }

const SESS_BADGE = { pre: "Pre", post: "Post", overnight: "24h", 盤前: "Pre", 盤後: "Post", 夜盤: "24h" };
const SESS_TITLE = { Pre: "盤前 Pre-market", Post: "盤後 Post-market", "24h": "夜盤 24h overnight" };
// Longbridge 式斜體灰色小徽章
export function SessBadge({ sess, T, size = 9.5 }) {
  const t = SESS_BADGE[sess];
  if (!t) return null;
  return <span title={SESS_TITLE[t]} style={{ display: "inline-block", transform: "skewX(-12deg)", background: T.line, color: T.sub, fontFamily: M, fontSize: size, fontWeight: 700, fontStyle: "italic", lineHeight: 1.25, padding: "1px 5px", borderRadius: 3, verticalAlign: "middle", whiteSpace: "nowrap" }}>{t}</span>;
}


// 展開行數據：億／萬／M 格式
function fmtBig(n, unit) {
  if (n == null || !isFinite(n)) return "–";
  if (unit === "M") return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n));
  return n >= 1e8 ? (n / 1e8).toFixed(n >= 1e10 ? 0 : 2) + "億" : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + "萬" : String(Math.round(n));
}
function MiniChart({ bars: allBars, emas: allEmas, utf: allUtf, tbf: allTbf, tf, T }) {
  // 闊度跟住容器（手機 168px；PC 較闊），高度隨闊度加高；顯示棒數按闊度自動調整（手機 40，PC 最多用盡已儲存嘅棒數）
  const box = useRef(null), [W, setW] = useState(168);
  useEffect(() => {
    const el = box.current; if (!el) return undefined;
    const fit = () => setW(Math.max(168, Math.round(el.clientWidth)));
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W > 300 ? Math.round(92 + Math.min(40, (W - 300) / 6)) : 92;
  const n = Math.min(allBars.length, Math.max(40, Math.floor((W - 12) / 2.9))), step = (W - 12) / n;
  const bars = allBars.slice(-n), tbf = allTbf && allTbf.length === allBars.length ? allTbf.slice(-n) : null, utf = allUtf && allUtf.length === allBars.length ? allUtf.slice(-n) : null;
  const emas = {}; Object.keys(allEmas || {}).forEach((k) => { if (allEmas[k].length === allBars.length) emas[k] = allEmas[k].slice(-n); });
  const hi = Math.max(...bars.map((b) => b[1])), lo = Math.min(...bars.map((b) => b[2]));   // 縱軸只按K線範圍；EMA 超出範圍就裁走
  const EC = { 10: "#f5c542", 20: "#4cd964", 50: "#ff3b30", 89: "#ff9f0a", 250: "#3d8bff" };   // 黃／綠／紅／橙／藍
  const y = (v) => 20 + ((hi - v) / (hi - lo || 1)) * (H - 40);   // 上下留位畀 UT + TB 兩層三角形
  return (
    <div ref={box} style={{ width: "100%" }}>
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", borderRadius: 8, background: T.bg }} role="img" aria-label={`${tf} 線 ${n} bars`}>
      {bars.map((b, i) => {
        const x = 6 + i * step + step / 2, up = b[3] >= b[0], c = up ? T.up : T.dn, t = y(Math.max(b[0], b[3])), bt = y(Math.min(b[0], b[3]));
        return <g key={i}><line x1={x} x2={x} y1={y(b[1])} y2={y(b[2])} stroke={c} strokeWidth="1" /><rect x={x - step * 0.4} y={t} width={Math.max(1, step * 0.8)} height={Math.max(1, bt - t)} fill={c} /></g>;
      })}
      <clipPath id="mc-clip"><rect x="0" y="14" width={W} height={H - 14} /></clipPath>
      <g clipPath="url(#mc-clip)" fill="none" strokeWidth="1" strokeLinejoin="round" opacity="0.9">
        {Object.keys(EC).filter((p) => emas?.[p]?.length === n).map((p) => (
          <polyline key={p} stroke={EC[p]} points={emas[p].map((v, i) => `${(6 + i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} />
        ))}
      </g>
      {utf && utf.length === n && utf.map((f, i) => {   // UT Bot：買 = 低位下面向上三角，賣 = 高位上面向下三角（同 01 Market Snapshot 一樣）
        if (!f) return null;
        const x = 6 + i * step + step / 2;
        return f > 0
          ? <path key={`u${i}`} d={`M${x.toFixed(1)} ${(y(bars[i][2]) + 2.5).toFixed(1)} l-3 5.2 h6z`} fill={T.txt} />
          : <path key={`u${i}`} d={`M${x.toFixed(1)} ${(y(bars[i][1]) - 2.5).toFixed(1)} l-3 -5.2 h6z`} fill={T.txt} />;
      })}
      {tbf && tbf.length === n && tbf.map((f, i) => {   // Triple Band 買入確認：另一色向上三角；同棒有 UT 買就畫喺 UT 三角下面
        if (!f) return null;
        const x = 6 + i * step + step / 2, off = utf && utf[i] > 0 ? 8.5 : 0;
        return <path key={`t${i}`} d={`M${x.toFixed(1)} ${(y(bars[i][2]) + 2.5 + off).toFixed(1)} l-3 5.2 h6z`} fill="#ff9f0a" />;
      })}
      <text x="6" y="11" fontSize="9.5" fill={T.mute} fontFamily="inherit">{tf} · {n} bars</text>
    </svg>
    </div>
  );
}

// ticker → Longbridge symbol（0700.HK → 700.HK；NVDA → NVDA.US）；唔識就 null
function lbSym(ticker) {
  let m;
  if ((m = ticker.match(/^(\d{1,5})\.HK$/))) return `${parseInt(m[1], 10)}.HK`;
  return /^[A-Z]{1,5}$/.test(ticker) ? `${ticker}.US` : null;
}

// 掃描冇帶 K 線嘅股票：展開時先經 Worker /api/candles 拉，前端計 EMA／UT（5 分鐘內同一隻唔重拉）
const CANDLE_CACHE = new Map();   // "sym|tf" -> {at, data}
const SHOW_N = { D: 100, W: 80, M: 60 };
function useCandles(ticker, tf, enabled) {
  const key = `${ticker}|${tf}`;
  const [st, setSt] = useState(() => { const h = CANDLE_CACHE.get(key); return h && Date.now() - h.at < 3e5 ? { key, data: h.data } : { key, data: null }; });
  useEffect(() => {
    if (!enabled || !ticker) return undefined;
    const h = CANDLE_CACHE.get(key);
    if (h && Date.now() - h.at < 3e5) { setSt({ key, data: h.data }); return undefined; }
    let alive = true;
    setSt({ key, data: null, loading: true });
    fetch(`/api/candles?symbol=${encodeURIComponent(ticker)}&tf=${tf}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const data = d && d.bars && d.bars.length > 5 ? chartSeries(d.bars, SHOW_N[tf]) : false;
        if (data) CANDLE_CACHE.set(key, { at: Date.now(), data });
        if (alive) setSt({ key, data });
      })
      .catch(() => { if (alive) setSt({ key, data: false }); });
    return () => { alive = false; };
  }, [key, enabled, ticker, tf]);
  return st.key === key ? st : { key, data: null, loading: enabled };
}

export function sessIcon(sess) {
  const p = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (sess === "pre") return <svg {...p}><path d="M5 18a7 7 0 0 1 14 0M12 4v4M4.5 9.5l2 2M19.5 9.5l-2 2M2 21h20" /></svg>;
  if (sess === "post") return <svg {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>;
  return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}

// Longbridge 即時報價（只喺未由外面傳入 q 時用，例如 Data 頁）：每 15 秒，休市拉一次就停
function useLiveQuote(ticker, enabled) {
  const [q, setQ] = useState(null);
  useEffect(() => {
    if (!enabled || !ticker) return undefined;
    const sym = lbSym(ticker);
    if (!sym) return undefined;
    const hk = sym.endsWith(".HK");
    let alive = true, got = false;
    const pull = async () => {
      try {
        const r = await fetch(`/api/quotes?symbols=${sym}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json(), x = (d.quotes || [])[0];
        if (alive && x && x.reg > 0) {
          setQ({ last: x.reg, pct: x.reg_pct, ext: x.session === "regular" ? null : x.pct, sess: x.session, exts: x.ext || {}, open: x.open, high: x.high, low: x.low, prev: x.prev_reg, vol: x.volume, tov: x.turnover });
          got = true;
        }
      } catch (e) { /* 冇即時價 → 顯示 – */ }
    };
    pull();
    const id = setInterval(() => { if (got && (marketsClosed() || (hk && hkClosed()))) return; pull(); }, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [ticker, enabled]);
  return q;
}

export default function StockDetail({ r, q: qProp, T }) {
  const own = useLiveQuote(r.ticker, qProp === undefined);
  const q = qProp !== undefined ? qProp : own;
  // 同 My List 一樣：撳圖輪流切換 D → W → M，每隻股票各自記低
  const [tfMap, setTfMap] = useState(() => { try { return JSON.parse(localStorage.getItem("os_conf_tf") || "{}") || {}; } catch (e) { return {}; } });
  const cycleTf = (t) => setTfMap((m) => { const v = m[t] || "D"; const n = { ...m, [t]: v === "D" ? "W" : v === "W" ? "M" : "D" }; try { localStorage.setItem("os_conf_tf", JSON.stringify(n)); } catch (e) { /* ignore */ } return n; });
  const hk = /\.HK$/.test(r.ticker), f = FUND[r.ticker], px = q?.last, pd = px >= 100 ? 2 : 3, pf3 = (v) => (v != null ? fmt(v, pd) : "–");
  const vs = (v) => (v == null || q?.prev == null ? T.txt : v >= q.prev ? T.up : T.dn);   // 同昨收比較定顏色
  const pe = f && px ? (f[1] > 0 ? (px / f[1]).toFixed(2) : "虧損") : "–";
  const stats = [
    ["最高", pf3(q?.high), vs(q?.high)], ["最低", pf3(q?.low), vs(q?.low)],
    ["今開", pf3(q?.open), vs(q?.open)], ["昨收", pf3(q?.prev), T.txt],
    ["成交量", fmtBig(q?.vol, hk ? "億" : "M"), T.txt], ["成交額", fmtBig(q?.tov), T.txt],
    ["市盈率", pe, T.txt], ["總市值", f && px ? fmtBig(f[0] * px) : "–", T.txt],
  ];
  const tf = tfMap[r.ticker] || "D", own0 = tf === "D" ? r : r[tf];
  const cd = useCandles(r.ticker, tf, !(own0?.bars && own0.bars.length > 5));   // 掃描有就用掃描，冇先即時拉
  const src = own0?.bars && own0.bars.length > 5 ? own0 : cd.data || null, bars = src?.bars;
  return (
    <div>
      <style>{`
        .os-xchart{flex:0 0 168px;min-width:0}
        .os-xstats{flex:1 1 0;min-width:0;grid-auto-rows:23px;gap:0 8px}
        .os-xl{font-size:10px}
        .os-xv{font-size:11px}
        @media (min-width:760px){
          .os-xchart{flex:3 1 0}
          .os-xstats{flex:2 1 0;grid-auto-rows:28px;gap:0 24px}
          .os-xl{font-size:12px}
          .os-xv{font-size:13px}
        }
      `}</style>
      <div style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 2px 9px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 0" }}>
          <span title={STOCK_NAMES[r.ticker] || r.ticker} style={{ fontFamily: SANS, fontSize: 12, color: T.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "0 1 auto" }}>{STOCK_NAMES[r.ticker] || r.ticker}</span>
          {r.ema && <span style={{ display: "flex", gap: 1, flexShrink: 0 }}>
            {r.ema.map((e) => { const c = !e.valid ? T.mute : e.above ? T.up : T.dn; return <span key={e.p} style={{ fontFamily: M, fontSize: 9, fontWeight: 600, padding: "1px 2px", borderRadius: 3, background: c + "26", color: c }}>{e.p}</span>; })}
          </span>}
        </div>
        <div style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", gap: 8, fontFamily: M, fontSize: 11, color: T.dim, flexShrink: 0, whiteSpace: "nowrap" }}>
          {(q?.sess && q.sess !== "regular" ? [q.sess] : []).filter((k) => q?.exts?.[k]).map((k) => {   // 只顯示而家呢個時段（夜盤時唔顯示舊嘅盤前／盤後）
            const x = q.exts[k], c = x.pct == null ? T.mute : x.pct >= 0 ? T.up : T.dn;
            return <span key={k} style={{ whiteSpace: "nowrap" }}>{fmt(x.last, x.last >= 1000 ? 0 : 2)} {x.pct != null && <span style={{ color: c }}>{pctText(x.pct)}</span>} <SessBadge sess={k} T={T} size={9} /></span>;
          })}
          {!q || (q.sess && q.sess !== "regular" && !q.exts?.[q.sess]) ? <span style={{ color: T.mute }}>–</span> : null}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "stretch", padding: "0 2px 10px" }}>
        <div onClick={() => cycleTf(r.ticker)} role="button" title="撳一下切換 D / W / M 圖" className="os-xchart" style={{ cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
          {bars && bars.length > 5
            ? <MiniChart bars={bars} emas={src.emas} utf={src.utf} tbf={src.tbf} tf={tf} T={T} />
            : <div style={{ width: "100%", height: 92, borderRadius: 8, background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: SANS, fontSize: 10.5, color: T.mute, textAlign: "center", padding: 8, boxSizing: "border-box" }}>{cd.loading ? "載入 K 線…" : "K 線暫時攞唔到"}</div>}
        </div>
        <div className="os-xstats" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", alignContent: "space-between" }}>
          {stats.map(([l, v, c]) => (
            <div key={l} style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 4, minWidth: 0, borderBottom: `1px solid ${T.line}` }}>
              <span className="os-xl" style={{ fontFamily: SANS, color: T.mute, whiteSpace: "nowrap" }}>{l}</span>
              <span className="os-xv" style={{ fontFamily: M, fontVariantNumeric: "tabular-nums", color: c, whiteSpace: "nowrap" }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
