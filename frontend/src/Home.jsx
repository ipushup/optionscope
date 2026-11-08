import { marketsClosed } from "./marketHours";
import { useEffect, useState } from "react";
import { PARENTS, groupRows } from "./parents";
import AppHeader from "./AppHeader";

/**
 * Home.jsx — OptionScope 主頁（只讀）
 *
 * 版面跟 Manus 嗰套三段響應式：
 *   寬（≥1200）  固定側欄 + 4 欄卡
 *   中（760–1199）窄側欄（底部帶狀態卡）+ 2 欄卡
 *   窄（<760）   側欄變頂部可橫掃嘅 tab 條 + 2 欄卡，sparkline 移去價錢下面
 * inline style 做唔到 media query，所以呢頁用一份 <style> + className。
 *
 * 01 Market Snapshot：讀 market.json（scanner/market_snapshot.py 每 15 分鐘出）。
 * 每張卡 = 指數 + 追蹤佢嘅 ETF。攞唔到 → 顯示 N/A，唔估、唔補。
 * 其餘 section（Triple Band 訊號、Daily brief、Data status）之後逐段加。
 */

const BASE = process.env.PUBLIC_URL || "";
const MARKET_URL = `${BASE}/market.json`;
const DAILY_URL = `${BASE}/index_daily.json`;
const SUMMARY_URL = `${BASE}/summary.json`;
const BAND_URL = `${BASE}/band.json`;
const WL_URL = `${BASE}/watchlist_merged.json`;
const BQ_URL = `${BASE}/band_quotes.json`;
// 即時報價（Worker 代 Longbridge 查）。card id → Longbridge 指數代號；ETF 代號喺 market.json 入面。
const LIVE_URL = "/api/quotes";
const INDEX_LB = { spx: ".SPX.US", ndx: ".IXIC.US", dji: ".DJI.US", vix: ".VIX.US", hsi: "HSI.HK" };
const LIVE_EVERY_MS = 5000;

const THEMES = {
  dark: {
    bg: "#0f1112", side: "#0f1112", card: "#151718", line: "#26292c", soft: "#1d1f21",
    txt: "#e3e4e5", sub: "#b9babd", dim: "#9b9b9e", mute: "#75777a",
    up: "#14ac9c", dn: "#f23c75", warn: "#f5a623", acc: "#3b9eff",
    navOn: "#1d1f21", navOnLine: "#2d3033", logo: "#1f4f8f", okBg: "#17241f", okLine: "#25423a",
  },
  light: {
    bg: "#f3f4f6", side: "#ffffff", card: "#ffffff", line: "#d9dde2", soft: "#e8ebef",
    txt: "#1b1f24", sub: "#3c444d", dim: "#56606b", mute: "#6b7580",
    up: "#00875a", dn: "#c81e3f", warn: "#a55a00", acc: "#0b6bcb",
    navOn: "#dbe7f7", navOnLine: "#b5cdee", logo: "#0652b2", okBg: "#eaf7f0", okLine: "#b9e2cc",
  },
};
const F = "'Syne',system-ui,sans-serif";
const NAMES = { ndx: "NASDAQ", vix: "VIX", hsi: "HSI" };
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";

async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch { /* 離線都照 reload */ }
  window.location.reload();
}
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";   // 數字/標籤字體：iOS 系統字 (SF Pro)，同 Longbridge app 一致；配 tabular-nums

const NAV = [
  { id: "home", label: "Home", tag: "now", icon: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V11z" },
  { id: "band", label: "Triple Band", tag: "live", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  { id: "watchlist", label: "Data", tag: "live", icon: "M4 6h16M4 12h16M4 18h10" },
  { id: "signals", label: "Signals", tag: "live", icon: "M3 18h3v-5H3zM9 18h3V8H9zM15 18h3V4h-3zM21 20H2" },
  { id: "radar", label: "Radar", tag: "live", icon: "M12 12l6-6M12 3a9 9 0 1 0 9 9" },
  { id: "brief", label: "Daily brief", tag: "soon", dim: true, icon: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7" },
  { id: "premium", label: "Premium", tag: "paused", dim: true, icon: "M12 3v18M16 7.5c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3" },
  { id: "compass", label: "Compass", tag: "paused", dim: true, off: true, icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z" },
];

function fmt(v, d = 2) {
  if (v == null || Number.isNaN(v)) return "N/A";
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pctText(p) { return p == null ? "" : `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`; }
function ageText(iso) {
  if (!iso) return "—";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 36) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

const SESS_BADGE = { pre: "Pre", post: "Post", overnight: "24h", 盤前: "Pre", 盤後: "Post", 夜盤: "24h" };
const SESS_TITLE = { Pre: "盤前 Pre-market", Post: "盤後 Post-market", "24h": "夜盤 24h overnight" };
// Longbridge 式斜體灰色小徽章
function SessBadge({ sess, T, size = 9.5 }) {
  const t = SESS_BADGE[sess];
  if (!t) return null;
  return <span title={SESS_TITLE[t]} style={{ display: "inline-block", transform: "skewX(-12deg)", background: T.line, color: T.sub, fontFamily: M, fontSize: size, fontWeight: 700, fontStyle: "italic", lineHeight: 1.25, padding: "1px 5px", borderRadius: 3, verticalAlign: "middle", whiteSpace: "nowrap" }}>{t}</span>;
}

function stamp(q) {
  if (!q?.asof) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(q.asof));
  const g = (t) => parts.find((x) => x.type === t)?.value || "";
  return `${g("day")} ${g("month")} ${g("hour")}:${g("minute")} HKT`;
}

function Spark({ data, color, T }) {
  const box = { width: "100%", height: "100%", display: "block" };
  if (!data || data.length < 2) {
    return <svg style={box} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d="M2 20h96" stroke={T.mute} strokeWidth="1.5" strokeDasharray="3 4" fill="none" vectorEffect="non-scaling-stroke" /></svg>;
  }
  const lo = Math.min(...data), hi = Math.max(...data), span = hi - lo || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * 100).toFixed(1)},${(36 - ((v - lo) / span) * 32).toFixed(1)}`).join(" ");
  return <svg style={box} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>;
}

// Daily brief 樣式：蠟燭 + EMA10/20/50 + SuperTrend + UT Bot 上下箭嘴
const ZOOM_BARS = 45;
function Candles({ d: full, T, light }) {
  const total = full?.c?.length || 0;
  if (total < 5) return null;
  const from = Math.max(0, total - ZOOM_BARS);
  const d = {};
  Object.keys(full).forEach((k) => { d[k] = Array.isArray(full[k]) ? full[k].slice(from) : full[k]; });
  const n = d.c.length;
  const W = 300, H = 150;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (d.l[i] < lo) lo = d.l[i]; if (d.h[i] > hi) hi = d.h[i]; }
  const pad = (hi - lo) * 0.07 || 1; lo -= pad; hi += pad;
  const X = (i) => ((i + 0.5) / n) * W;
  const Y = (p) => H - ((p - lo) / (hi - lo)) * H;
  const cw = (W / n) * 0.62;
  const path = (arr, mask) => {
    let out = "", pen = false;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v == null || (mask && !mask(i))) { pen = false; continue; }
      out += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    }
    return out;
  };
  const arrowC = light ? T.txt : "#ffffff";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Daily candles with EMA, SuperTrend and UT Bot signals">
      {d.c.map((c, i) => {
        const col = c >= d.o[i] ? T.up : T.dn;
        const top = Y(Math.max(d.o[i], c)), bot = Y(Math.min(d.o[i], c));
        return (
          <g key={i}>
            <line x1={X(i)} x2={X(i)} y1={Y(d.h[i])} y2={Y(d.l[i])} stroke={col} strokeWidth="0.8" />
            <rect x={X(i) - cw / 2} y={top} width={cw} height={Math.max(bot - top, 0.6)} fill={col} />
          </g>
        );
      })}
      <path d={path(d.ema10)} fill="none" stroke="#e8c34a" strokeWidth="1" strokeLinejoin="round" />
      <path d={path(d.ema20)} fill="none" stroke="#8fdc5a" strokeWidth="1" strokeLinejoin="round" />
      <path d={path(d.ema50)} fill="none" stroke="#e05563" strokeWidth="1" strokeLinejoin="round" />
      <path d={path(d.st, (i) => d.st_dir[i] === 1)} fill="none" stroke="#00b894" strokeWidth="1.4" strokeLinejoin="round" />
      <path d={path(d.st, (i) => d.st_dir[i] === -1)} fill="none" stroke="#ff5d73" strokeWidth="1.4" strokeLinejoin="round" />
      {d.buy.map((on, i) => on && <path key={`b${i}`} d={`M${X(i)} ${Y(d.l[i]) + 5} l-4.8 8.25 h9.6z`} fill={arrowC} />)}
      {d.sell.map((on, i) => on && <path key={`s${i}`} d={`M${X(i)} ${Y(d.h[i]) - 5} l-4.8 -8.25 h9.6z`} fill={arrowC} />)}
    </svg>
  );
}

function IndexCard({ card, T, mode, daily, light, tf, onCycle }) {
  const bars = daily && tf !== "D" && daily[tf] ? daily[tf] : daily;   // 每隻指數自己揀 D / W / M
  const ix = card.index, etf = card.etf;
  const isYield = card.id === "us10y";
  const main = ix || null;
  const up = main ? main.change >= 0 : true;
  const col = main ? (up ? T.up : T.dn) : T.mute;
  const etfCol = etf ? (etf.change >= 0 ? T.up : T.dn) : T.mute;
  const arrow = (x) => (x.change >= 0 ? "▲" : "▼");
  const showDaily = mode !== "intraday" && bars && bars.c && bars.c.length > 4;
  const priceBlock = (
    <div style={{ minWidth: 0, flex: "0 0 auto" }}>
      <div className="os-price" style={{ fontFamily: SANS, fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em", color: T.txt }}>
        {main ? (isYield ? `${fmt(main.last)}%` : fmt(main.last)) : "N/A"}
      </div>
      <div style={{ fontFamily: M, fontSize: 12, marginTop: 4, color: col }}>
        {main ? `${arrow(main)} ${isYield ? `${fmt(Math.abs(main.change) * 100, 1)} bp` : fmt(Math.abs(main.change))} · ${pctText(main.pct)}` : "no quote"}
      </div>
    </div>
  );
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderTop: `2px solid ${col}`, borderRadius: 12, padding: "14px 14px 12px", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: T.sub }}>{NAMES[card.id] || card.name}</span>
        <span style={{ fontFamily: M, fontSize: 10, color: T.sub }}>{card.index_symbol}</span>
      </div>
      {showDaily ? (
        <>
          <div style={{ marginTop: 10 }}>{priceBlock}</div>
          <div onClick={onCycle} role="button" title="撳一下切換 D / W / M" style={{ marginTop: 10, position: "relative", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}>
            <Candles d={bars} T={T} light={light} />
            <span style={{ position: "absolute", top: 0, left: 2, fontFamily: M, fontSize: 10, color: T.mute }}>{tf}</span>
          </div>
        </>
      ) : (
        <div className="os-px" style={{ display: "flex", gap: 10, marginTop: 10 }}>
          {priceBlock}
          <div className="os-spark">
            <Spark data={main?.spark} color={col} T={T} />
          </div>
        </div>
      )}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.line}` }}>
        <div className="os-etf" style={{ fontFamily: M, display: "flex", justifyContent: "space-between", gap: 6, whiteSpace: "nowrap" }}>
          <span style={{ color: T.txt }}>{card.etf_symbol}</span>
          <span style={{ color: T.txt }}>{etf ? fmt(etf.last) : "N/A"}</span>
          <span style={{ color: etfCol }}>{etf ? `${arrow(etf)} ${pctText(etf.pct)}` : ""}</span>
          {etf && <span className="os-bd-d"><SessBadge sess={etf.session} T={T} size={9} /></span>}
        </div>
        {etf && <div style={{ fontFamily: M, fontSize: 10, color: T.mute, marginTop: 5, display: "flex", justifyContent: "space-between", gap: 6, whiteSpace: "nowrap" }}>
          <span>{stamp(etf)}</span><span className="os-bd-m"><SessBadge sess={etf.session} T={T} /></span></div>}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, color, T }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 14px 12px", minWidth: 0 }}>
      <div style={{ fontFamily: M, fontSize: 10, letterSpacing: "0.12em", color: T.mute }}>{label}</div>
      <div style={{ fontFamily: M, fontSize: 28, fontWeight: 500, color: color || T.txt, marginTop: 6 }}>{value ?? "—"}</div>
      <div style={{ fontSize: 11, color: T.dim, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

const hkTime = (iso) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.hour}:${p.minute}:${p.second}`;
  } catch { return "—"; }
};

function BandSection({ band, bq, T }) {
  const c = band?.counts || {};
  const quotes = bq?.quotes || {};
  const [mkt, setMkt] = useState(() => { try { return localStorage.getItem("os_band_mkt") === "HK" ? "HK" : "US"; } catch { return "US"; } });
  const pickMkt = (m) => { setMkt(m); try { localStorage.setItem("os_band_mkt", m); } catch { /* */ } };
  const isHK = mkt === "HK";
  const [sigAt, setSigAt] = useState(null);
  const [sig, setSig] = useState({});   // Longbridge 即時 (signals.json): sym -> row
  const [dly, setDly] = useState({});    // daily.json: sym -> row (EMA stack)
  const [mgn, setMgn] = useState({ data: {}, stale: false });   // margin.json（daily brief 同一份 margin_cache）
  useEffect(() => {
    fetch("/margin.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d || !d.data) return;
      const age = d.as_of ? (Date.now() - new Date(d.as_of).getTime()) / 864e5 : 0;
      setMgn({ data: d.data, stale: age > 30, asOf: d.as_of });
    }).catch(() => {});
  }, []);
  // 融資保證金率 superscript —— 顏色同 Watchlist / daily brief 一致
  const marginSup = (sym) => {
    const v = mgn.data[sym];
    if (v == null) return null;
    const col = T.txt;   // 統一白色（light 主題跟 T.txt）
    return (
      <sup title={(v <= 0 ? "不可融資" : `孖展保證金率 ${Math.round(v)}%`) + (mgn.stale ? `（資料 ${mgn.asOf}，已過期）` : "")}
        style={{ marginLeft: 2, fontSize: "0.62em", fontWeight: 700, color: col, opacity: mgn.stale ? 0.55 : 1, lineHeight: 0 }}>
        {v <= 0 ? "✕" : Math.round(v)}
      </sup>
    );
  };
  useEffect(() => {
    const pull = () => {
      fetch("/signals.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d || Date.now() - new Date(d.updated).getTime() > 300000) { setSig({}); setSigAt(null); return; }
        setSigAt(d.updated);
        const m = {}; for (const r of d.rows || []) m[r.sym] = r; setSig(m);
      }).catch(() => {});
      fetch("/daily.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        const m = {}; for (const r of (d && d.rows) || []) m[r.sym] = r; setDly(m);
      }).catch(() => {});
    };
    pull(); const id = setInterval(pull, 15000); return () => clearInterval(id);
  }, []);
  // 最近 5 日訊號 tag：1 = 最新一根日棒（今日 / bar_date），5 = 五日前
  const busDiff = (a, b) => { // a→b 之間嘅交易日數（週一至五）
    let n = 0; const d = new Date(a + "T00:00:00Z"), e = new Date(b + "T00:00:00Z");
    while (d < e) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  };
  const tbMap = (() => {
    const m = {}, bd = band?.bar_date;
    if (!bd) return m;
    const put = (sym, from) => { if (!from) return; const n = busDiff(from, bd) + 1; if (n >= 1 && n <= 5 && (m[sym] == null || n < m[sym])) m[sym] = n; };
    for (const r of band.confirmed || []) put(r.symbol, r.date);
    for (const r of band.candidates || []) put(r.symbol, r.entry_date);
    for (const r of band.observe || []) put(r.symbol, r.date);
    return m;
  })();
  const enrich = (r) => {
    const q = quotes[r.symbol] || {};
    const px = q.price ?? null, low = q.day_low ?? null;
    let st = "—";
    if (r.kill_low == null) st = "ENTRY";
    else if (px != null && low != null) st = low <= r.kill_low ? "BROKE" : r.kill_close != null && px > r.kill_close ? "TIER" : "HOLD";
    const g = sig[r.symbol], lb = g && g.reg > 0 && g.pc > 0;
    const last = lb ? g.reg : px;
    const isHKrow = r.symbol.endsWith(".HK");
    const chg = lb ? (g.reg / g.pc - 1) * 100 : isHKrow ? (q.prev_close > 0 && px != null ? (px / q.prev_close - 1) * 100 : null) : (q.chg_pct ?? null);
    const ext = lb && g.sess !== "盤中" ? (g.px / g.reg - 1) * 100 : null;
    const dd = dly[r.symbol] || {};
    // 固定三格：TB / UT / Heavy。最近 5 日有訊號 → 彩色 tag（1 = 最新一棒）；冇 → 灰色 "–"
    // daily.json 嘅 ut.pos 係 'L'（long）/ 'S'（short）字串，唔係 +1/-1
    const utLong = dd.ut ? (dd.ut.pos === "L" || dd.ut.pos === 1 ? true : dd.ut.pos === "S" || dd.ut.pos === -1 ? false : null) : null;
    const utN = dd.ut && dd.ut.days != null ? dd.ut.days + 1 : null;   // daily_table 嘅 days 由 0 起算
    const hvN = dd.heavy && dd.heavy.days != null ? dd.heavy.days + 1 : null;
    const tags = [
      tbMap[r.symbol] != null ? { t: `TB${tbMap[r.symbol]}`, c: T.up } : { t: "TB–" },
      utN != null && utN <= 5 && utLong != null ? { t: `${utLong ? "B" : "S"}${utN}`, c: utLong ? T.up : T.dn } : { t: "UT–" },
      hvN != null && hvN <= 5 ? { t: `${dd.heavy.k}${hvN}`, c: dd.heavy.k === "HB" ? T.up : T.dn } : { t: "HV–" },
    ];
    return { ...r, tags, bandExt: r.ext, px, low, st, last, chg, ext, utPos: dd.ut ? dd.ut.pos : null, hv: dd.heavy ? dd.heavy.k : null, ema: isHKrow ? (q.ema ? q.ema.map((e) => ({ p: e.p, valid: e.valid, above: px != null && px > e.v })) : null) : dd.ema };
  };
  const rows = groupRows((isHK ? band?.forming_hk : band?.forming) || []).filter((r) => (r.tier_gap_pct ?? 0) > -3).map(enrich);
  const hkEntries = isHK ? (band?.observe || []).filter((r) => r.market === "HK") : [];
  const confRows = groupRows(isHK ? hkEntries : band?.confirmed || []).map(enrich);
  const pill = { ENTRY: T.up, HOLD: T.acc, BROKE: T.dn, TIER: T.warn, "—": T.mute };
  const th = { textAlign: "left", fontFamily: M, fontSize: 10, letterSpacing: "0.1em", color: T.mute, fontWeight: 400, padding: "8px 10px", borderBottom: `1px solid ${T.line}`, whiteSpace: "nowrap" };
  const td = { fontFamily: M, fontSize: 12, padding: "9px 10px", borderBottom: `1px solid ${T.line}`, whiteSpace: "nowrap" };
  const renderCard = (r) => {
                  const pf = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
                  const cc = (v) => (v >= 0 ? T.up : T.dn);
                  const g = sig[r.symbol];
                  const par = PARENTS[r.symbol];
                  return (
                    <div key={r.symbol} style={{ padding: "9px 14px 8px", borderTop: `1px solid ${T.line}`, opacity: r.st === "BROKE" ? 0.5 : 1 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", minWidth: 0, gap: 4, overflow: "hidden", padding: "3px 1px" }}>
                          {par && <span style={{ fontSize: 9.5, color: T.mute, fontWeight: 400, flexShrink: 0 }}>{par} ›</span>}
                          <span style={{ fontWeight: 500, fontSize: 16, color: T.txt, flexShrink: 0 }}>{isHK ? r.symbol.replace(/\.HK$/, "") : r.symbol}{marginSup(r.symbol)}</span>
                        <div style={{ fontFamily: M, fontSize: 12, color: T.dim, whiteSpace: "nowrap", flexShrink: 0, marginLeft: 3 }} title={`day low ${r.low != null ? fmt(r.low) : "N/A"}${r.kill_close != null ? ` · kill close ${fmt(r.kill_close)}` : ""}`}>
                          <span style={{ color: pill[r.st], border: `1px solid ${pill[r.st]}`, borderRadius: 999, padding: "1px 6px", fontSize: 10, lineHeight: 1.3, display: "inline-block", marginRight: 4 }}>{r.st}</span>
                          {r.st === "ENTRY" ? <><span style={{ color: T.mute }}>ext</span> {r.bandExt != null ? r.bandExt.toFixed(2) : "—"}</> : <><span style={{ color: T.mute }}>kill</span> {fmt(r.kill_low)}</>}
                        </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, whiteSpace: "nowrap" }}>
                          <span style={{ fontFamily: M, fontSize: 14.5, fontWeight: 600 }}>{r.last != null ? fmt(r.last) : "N/A"}</span>
                          {r.chg != null && <span style={{ fontFamily: M, fontSize: 12, fontWeight: 600, minWidth: 60, textAlign: "right", padding: "2px 4px", borderRadius: 4, background: cc(r.chg), color: "#fff" }}>{pf(r.chg)}</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6, minHeight: 20 }}>
                        <div style={{ display: "flex", alignItems: "center", minWidth: 0, overflow: "hidden" }}>
                          {r.ema && <span style={{ display: "flex", gap: 1, flexShrink: 0, marginLeft: 0 }}>
                            {r.ema.map((e) => { const c = !e.valid ? T.mute : e.above ? T.up : T.dn; return <span key={e.p} style={{ fontFamily: M, fontSize: 9, fontWeight: 600, padding: "1px 2px", borderRadius: 3, background: c + "26", color: c }}>{e.p}</span>; })}
                          </span>}
                          {r.tags && <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 9, paddingLeft: 9, borderLeft: `2px solid ${T.mute}` }}>
                            {r.tags.map((x) => <span key={x.t} style={{ fontFamily: M, fontSize: 10, fontWeight: x.c ? 600 : 400, color: x.c || T.mute, opacity: x.c ? 1 : 0.7, whiteSpace: "nowrap" }}>{x.t}</span>)}
                          </span>}
                        </div>
                        {r.ext != null && <div style={{ fontFamily: M, fontSize: 12.5, color: T.dim, whiteSpace: "nowrap", flexShrink: 0 }}>
                          {g.px.toFixed(2)} <span style={{ color: cc(r.ext) }}>{pf(r.ext)}</span> <SessBadge sess={g.sess} T={T} /></div>}
                      </div>
                    </div>
                  );
  };
  return (
    <section aria-labelledby="s2">
      <div id="s2" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 8px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>02 / TRIPLE BAND</div>
          <div role="tablist" aria-label="Market" style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: 7, overflow: "hidden" }}>
            {["US", "HK"].map((m) => (
              <button key={m} role="tab" aria-selected={mkt === m} onClick={() => pickMkt(m)}
                style={{ fontFamily: M, fontSize: 11, fontWeight: 600, padding: "3px 10px", border: 0, cursor: "pointer", background: mkt === m ? T.soft : "transparent", color: mkt === m ? T.txt : T.mute }}>{m}</button>
            ))}
          </div>
        </div>
        <div style={{ fontFamily: M, fontSize: 11, color: T.mute, whiteSpace: "nowrap" }}>bar {(band?.bar_date || "—").slice(5)} · prices {bq?.quoted_at ? ageText(bq.quoted_at) : "—"}</div>
      </div>
      {!band ? (
        <div style={{ border: `1px solid ${T.line}`, background: T.card, borderRadius: 12, padding: 18, fontFamily: M, fontSize: 12, color: T.dim }}>band.json not available.</div>
      ) : (
        <>
          <div className="os-grid">
            {isHK ? <>
              <Tile label="CONFIRMED" value={c.hk_entry ?? hkEntries.length} sub="observe only" color={T.up} T={T} />
              <Tile label="FORMING" value={c.forming_hk ?? rows.length} sub={`${rows.length} listed`} color={T.acc} T={T} />
              <Tile label="EXITS" value="—" sub="not tracked for HK" color={T.dn} T={T} />
              <Tile label="CANDIDATES" value="—" sub={`of ${c.hk_universe ?? "—"} HK scanned`} T={T} />
            </> : <>
              <Tile label="CONFIRMED" value={c.confirmed} sub="entries confirmed" color={T.up} T={T} />
              <Tile label="FORMING" value={c.forming_live ?? c.forming} sub={`${c.forming ?? "—"} formed today · ${rows.length} listed`} color={T.acc} T={T} />
              <Tile label="EXITS" value={c.exits} sub="exit signals" color={T.dn} T={T} />
              <Tile label="CANDIDATES" value={c.candidates} sub={`of ${c.universe ?? "—"} scanned`} T={T} />
            </>}
          </div>
          {confRows.length > 0 && (
            <div style={{ marginTop: 14, background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 14px", fontSize: 13, fontWeight: 700 }}>Confirmed signals{isHK ? " · HK" : ""} <span style={{ fontFamily: M, fontSize: 11, color: T.mute, fontWeight: 400 }}>{isHK ? "observe only" : "buy next open"}</span></div>
              <div>{confRows.map(renderCard)}</div>
            </div>
          )}
          <div style={{ marginTop: 14, background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><span>Forming signals{isHK ? " · HK" : ""}</span> <span style={{ fontFamily: M, fontSize: 11, color: T.mute, fontWeight: 400, whiteSpace: "nowrap" }}>{sigAt && !isHK ? <>{hkTime(sigAt)} HKT {marketsClosed() ? <span><span style={{ color: T.mute }}>●</span> closed</span> : <span style={{ color: T.up }}>● live</span>}</> : bq?.quoted_at ? `${hkTime(bq.quoted_at)} HKT` : "—"}</span></div>
            {rows.length === 0 ? (
              <div style={{ padding: "0 14px 14px", fontFamily: M, fontSize: 12, color: T.dim }}>{isHK ? (band?.forming_hk ? "No HK forming signals." : "HK forming not scanned yet — appears after the next full Triple Band scan.") : "No forming signals."}</div>
            ) : (
              <div>
                {rows.map(renderCard)}
              </div>
            )}
          </div>
          <div style={{ marginTop: 12, fontFamily: M, fontSize: 11, lineHeight: 1.7, color: T.mute }}>
            {isHK ? "HK is observe-only (no validated config). HOLD: day low above kill low. BROKE: day low touched kill low (dimmed). Prices from Yahoo, about 15 min delayed; CHG% vs previous close, EMA from daily bars (Longbridge live feed not connected for HK yet)." : null}
            {isHK ? null : <>HOLD: day low above kill low. BROKE: day low touched kill low (dimmed). TIER: price above kill close. Price, CHG% and pre/post EXT% from Longbridge realtime; EMA 10/20/50/89/250 (green above, red below). HOLD/BROKE/TIER refreshes about every 15 min.</>}
          </div>
        </>
      )}
    </section>
  );
}

// ── 訊號共振榜：Data 頁 D/W/M × UT/HV/TB 九格，最近 5 棒內同向訊號數 ≥ 5（唔加權，純數數）──
const CONF_MIN = 5, CONF_BARS = 5, CONF_SHOW = 8;
const CONF_KEYS = ["UT", "HV", "TB"];
function confSigs(r) {
  // 返回 9 格 [{s, n} | null]，次序 D UT/HV/TB, W …, M …
  const one = (src) => {
    const ut = src.ut === "long" ? 1 : src.ut === "short" ? -1 : null;
    const tb = src.tb ?? (src.tb_days != null ? { s: 1, n: src.tb_days } : null);
    return [ut != null && src.ut_days != null ? { s: ut, n: src.ut_days } : null, src.hv?.s ? src.hv : null, tb?.s ? tb : null]
      .map((x) => (x && x.n != null && x.n <= CONF_BARS ? x : null));
  };
  return [...one(r), ...one(r.W || {}), ...one(r.M || {})];
}
function ConfluenceSection({ wl, T, onNavigate }) {
  const [side, setSide] = useState(() => { try { return localStorage.getItem("os_conf_side") === "S" ? "S" : "B"; } catch (e) { return "B"; } });
  const [all, setAll] = useState(false);
  const pick = (v) => { setSide(v); setAll(false); try { localStorage.setItem("os_conf_side", v); } catch (e) { /* ignore */ } };
  const want = side === "B" ? 1 : -1, col = side === "B" ? T.up : T.dn;
  const calc = (w) => (wl?.rows || []).map((r) => {
    const hit = confSigs(r).map((x) => (x && x.s === w ? x : null));
    return { sym: r.symbol || r.ticker, hit, n: hit.filter(Boolean).length, fresh: hit.reduce((a, x) => a + (x ? x.n : 0), 0) };
  }).filter((r) => r.n >= CONF_MIN).sort((a, b) => b.n - a.n || a.fresh - b.fresh);
  const bullRows = calc(1), bearRows = calc(-1);
  const rows = side === "B" ? bullRows : bearRows;
  const shown = all ? rows : rows.slice(0, CONF_SHOW);
  const noSell = wl?.rows && !wl.rows.some((r) => r.tb !== undefined);
  return (
    <section aria-labelledby="s2b">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 8px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div id="s2b" style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>03 / SIGNAL CONFLUENCE</div>
          <div role="tablist" aria-label="Side" style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: 7, overflow: "hidden" }}>
            {[["B", "偏多 ▲"], ["S", "偏空 ▼"]].map(([k, lb]) => (
              <button key={k} role="tab" aria-selected={side === k} onClick={() => pick(k)}
                style={{ fontFamily: SANS, fontSize: 11, fontWeight: 600, padding: "3px 10px", border: 0, cursor: "pointer", background: side === k ? T.soft : "transparent", color: side === k ? (k === "B" ? T.up : T.dn) : T.mute }}>{lb}</button>
            ))}
          </div>
        </div>
        <div style={{ fontFamily: M, fontSize: 11, color: T.mute, whiteSpace: "nowrap" }}>D·W·M × UT HV TB · ≤{CONF_BARS} 棒 · ≥{CONF_MIN}/9</div>
      </div>
      {wl && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[["偏多最強", bullRows, T.up], ["偏空最強", bearRows, T.dn]].map(([lb, rs, c]) => {
            const top = rs.length ? rs[0].n : null, names = top == null ? [] : rs.filter((r) => r.n === top);
            return (
              <div key={lb} style={{ flex: "1 1 0", minWidth: 0, background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ fontFamily: SANS, fontSize: 11, color: c }}>{lb}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2, minWidth: 0 }}>
                  <span style={{ fontFamily: M, fontSize: 22, fontWeight: 700, color: T.txt, fontVariantNumeric: "tabular-nums" }}>{top ?? "–"}</span>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: T.mute, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                    / 9{names.length ? ` · ${names.slice(0, 3).map((r) => r.sym.replace(/\.HK$/, "")).join(" ")}${names.length > 3 ? ` +${names.length - 3}` : ""}` : " · 冇"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!wl ? (
        <div style={{ border: `1px solid ${T.line}`, background: T.card, borderRadius: 12, padding: 18, fontFamily: M, fontSize: 12, color: T.dim }}>watchlist_merged.json not available.</div>
      ) : (
        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "6px 14px 10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, height: 24, fontFamily: SANS, fontSize: 10.5, color: T.mute }}>
            <div style={{ width: 70 }}>Symbol</div>
            <div style={{ flexGrow: 1, display: "flex", gap: 10 }}>
              {["D", "W", "M"].map((t) => <div key={t} style={{ flex: "1 1 0", textAlign: "center" }}>{t}</div>)}
            </div>
            <div style={{ width: 30, textAlign: "right" }}>Total</div>
          </div>
          {shown.length === 0 && <div style={{ padding: "14px 0", fontFamily: M, fontSize: 12, color: T.dim }}>冇股票達到 {CONF_MIN}/9。</div>}
          {shown.map((r) => (
            <button key={r.sym} type="button" onClick={() => onNavigate && onNavigate("watchlist")} title={r.hit.map((x, i) => x ? `${["D", "W", "M"][Math.floor(i / 3)]} ${CONF_KEYS[i % 3]} ${side}${x.n}` : null).filter(Boolean).join(" · ")}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", height: 40, padding: 0, border: 0, borderTop: `1px solid ${T.line}`, background: "transparent", color: T.txt, cursor: "pointer", textAlign: "left", font: "inherit" }}>
              <div style={{ width: 70, fontFamily: SANS, fontSize: 14, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.sym}</div>
              <div style={{ flexGrow: 1, display: "flex", gap: 10 }}>
                {[0, 3, 6].map((o) => (
                  <div key={o} style={{ flex: "1 1 0", display: "flex", gap: 2 }}>
                    {[0, 1, 2].map((j) => <div key={j} style={{ flex: "1 1 0", height: 10, borderRadius: 2, background: r.hit[o + j] ? col : T.line }} />)}
                  </div>
                ))}
              </div>
              <div style={{ width: 30, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums", fontSize: 15, fontWeight: 700, color: col }}>{r.n}<span style={{ fontSize: 10, fontWeight: 400, color: T.mute }}>/9</span></div>
            </button>
          ))}
          {rows.length > CONF_SHOW && (
            <button type="button" onClick={() => setAll((v) => !v)} style={{ display: "block", width: "100%", marginTop: 4, padding: "8px 0 2px", border: 0, borderTop: `1px solid ${T.line}`, background: "transparent", color: T.acc, fontFamily: SANS, fontSize: 12, cursor: "pointer" }}>
              {all ? "收埋" : `展開全部 ${rows.length} 隻`}
            </button>
          )}
        </div>
      )}
      <div style={{ marginTop: 10, fontFamily: M, fontSize: 11, lineHeight: 1.7, color: T.mute }}>
        每組三格 = UT / HV / TB；亮色 = 該格最近 {CONF_BARS} 棒內出現同向訊號。數據來自 Yahoo Finance K 線掃描（收市後更新），撳一行去 Data 頁睇詳情。{noSell ? " TB 賣出訊號要等下一次完整掃描先會出現。" : ""}
      </div>
    </section>
  );
}

function SummarySection({ sm, T }) {
  const fmtDate = (d) => {
    const dt = new Date(`${d}T00:00:00Z`);
    return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short" });
  };
  return (
    <section aria-labelledby="s3">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 14 }}>
        <div id="s3" style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>04 / US AFTER-MARKET</div>
        {sm && <div style={{ fontFamily: M, fontSize: 11, color: T.mute }}>{fmtDate(sm.date)} close{sm.temperature ? ` · temp ${sm.temperature.value}` : ""}</div>}
      </div>
      {!sm ? (
        <div style={{ border: `1px solid ${T.line}`, background: T.card, borderRadius: 12, padding: 18, fontFamily: M, fontSize: 12, color: T.dim }}>No summary yet.</div>
      ) : (
        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "16px 16px 14px" }}>
          <div style={{ fontFamily: SANS, fontSize: 17, fontWeight: 700, lineHeight: 1.45, color: T.txt }}>{sm.headline}</div>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {(sm.bullets || []).map((b, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                <span style={{ flex: "0 0 52px", fontFamily: M, fontSize: 11, color: T.acc }}>{b.tag}</span>
                <span style={{ fontSize: 13, lineHeight: 1.65, color: T.sub }}>{b.text}</span>
              </div>
            ))}
          </div>
          {sm.ahead && <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.line}`, fontSize: 12, lineHeight: 1.6, color: T.dim }}>{sm.ahead}</div>}
          <div style={{ marginTop: 10, fontFamily: M, fontSize: 10, lineHeight: 1.7, color: T.mute }}>
            Source: {(sm.sources || []).map((x) => x.name).join(" · ")}
          </div>
        </div>
      )}
    </section>
  );
}

export default function Home({ onNavigate, light, onToggleLight }) {
  const T = light ? THEMES.light : THEMES.dark;
  const [mk, setMk] = useState(null);
  const [live, setLive] = useState(null);   // { fetched_at, bySymbol }
  const [err, setErr] = useState(null);
  const [band, setBand] = useState(null);
  const [bq, setBq] = useState(null);
  const [daily, setDaily] = useState(null);
  const [sm, setSm] = useState(null);
  const [wl, setWl] = useState(null);
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem("os_snap_mode") === "intraday" ? "intraday" : "D"; } catch (e) { return "D"; }
  });
  const [tfMap, setTfMap] = useState(() => { try { return JSON.parse(localStorage.getItem("os_snap_tf") || "{}") || {}; } catch (e) { return {}; } });
  const cycleTf = (id) => setTfMap((m) => { const v = m[id] || "D"; const n = { ...m, [id]: v === "D" ? "W" : v === "W" ? "M" : "D" }; try { localStorage.setItem("os_snap_tf", JSON.stringify(n)); } catch (e) { /* ignore */ } return n; });
  const pickMode = (m) => { setMode(m); try { localStorage.setItem("os_snap_mode", m); } catch (e) { /* ignore */ } };

  useEffect(() => {
    let dead = false;
    const get = async (u, set) => {
      try {
        const r = await fetch(`${u}?t=${Date.now()}`);
        if (r.ok && !dead) set(await r.json());
      } catch (e) { /* section shows unavailable */ }
    };
    get(DAILY_URL, setDaily);
    get(SUMMARY_URL, setSm);
    get(BAND_URL, setBand);
    get(BQ_URL, setBq);
    get(WL_URL, setWl);
    const t = setInterval(() => get(BQ_URL, setBq), 120 * 1000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch(`${MARKET_URL}?t=${Date.now()}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!dead) { setMk(j); setErr(null); }
      } catch (e) { if (!dead) setErr(String(e.message || e)); }
    };
    load();
    const t = setInterval(load, 60 * 1000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  // 即時層：每 5 秒向 Worker 要一次；分頁隱藏就唔 call；失敗就靜靜地退返 market.json
  useEffect(() => {
    if (!mk) return undefined;
    const syms = mk.cards.flatMap((cd) => [INDEX_LB[cd.id], cd.etf_symbol]).filter(Boolean);
    if (!syms.length) return undefined;
    let dead = false;
    let got = false;
    const tick = async () => {
      if (document.hidden) return;
      if (got && marketsClosed()) return;   // 休市：拉一次顯示收市價就停
      try {
        const r = await fetch(`${LIVE_URL}?symbols=${encodeURIComponent(syms.join(","))}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const bySymbol = {};
        for (const q of j.quotes || []) bySymbol[q.symbol] = q;
        if (!dead) setLive(Object.keys(bySymbol).length ? { fetched_at: j.fetched_at, bySymbol } : null);
        got = Object.keys(bySymbol).length > 0;
      } catch { if (!dead) setLive(null); }
    };
    tick();
    const t = setInterval(tick, LIVE_EVERY_MS);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { dead = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [mk]);

  const overlay = (base, q) => (q && base ? { ...base, ...q, spark: base.spark, source: "longbridge-live" } : base);
  const cards = (mk?.cards || []).map((cd) => (live ? {
    ...cd,
    index: overlay(cd.index, live.bySymbol[INDEX_LB[cd.id]]),
    etf: overlay(cd.etf, live.bySymbol[cd.etf_symbol]),
  } : cd));
  const complete = cards.filter((c) => c.index && c.etf).length;
  const ageMin = mk ? (Date.now() - new Date(mk.updated_at).getTime()) / 60000 : null;
  // 美股休市時段（紐約時間 週五 20:00 → 週日 20:00）：舊數據係正常，用灰色，唔當 stale
  const usClosed = (() => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
      const h = parseInt(p.hour, 10);
      return p.weekday === "Sat" || (p.weekday === "Sun" && h < 20) || (p.weekday === "Fri" && h >= 20);
    } catch (e) { return false; }
  })();
  const stale = ageMin != null && ageMin > 60 && !usClosed;
  const feedClosed = ageMin != null && ageMin > 60 && usClosed;
  const feedColor = !mk ? T.dn : stale ? T.warn : feedClosed ? T.mute : T.up;

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&display=swap');
    .os-home{min-height:100vh;display:flex;flex-direction:column;background:${T.bg};color:${T.txt};font-family:${F}}
    .os-home *{box-sizing:border-box}
    .os-side{flex:0 0 220px;width:220px;background:${T.side};border-right:1px solid ${T.line};padding:20px 16px;display:flex;flex-direction:column;gap:18px;position:sticky;top:0;height:100vh}
    .os-nav{display:flex;flex-direction:column;gap:6px}
    .os-main{flex:1 1 auto;min-width:0;width:100%;max-width:1280px;margin:0 auto;padding:24px 32px 48px;display:flex;flex-direction:column;gap:28px}
    .os-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .os-hero{display:flex;flex-direction:row;align-items:stretch;gap:16px}
    .os-herocard{flex:1 1 auto}
    .os-price{font-size:24px}
    .os-px{flex-direction:row;align-items:stretch}
    .os-etf{font-size:13px}
    .os-bd-m{display:none}
    .os-spark{flex:1 1 0;min-width:0;min-height:44px}
    .os-tabs{display:none}
    .os-h1{font-size:34px}
    @media (max-width:1199px){
      .os-side{flex-basis:190px;width:190px}
      .os-main{padding:22px 24px 40px}
      .os-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .os-herocard{flex-basis:230px}
      .os-price{font-size:26px}
    }
    @media (max-width:759px){
      .os-home{flex-direction:column}
      .os-side{display:none}
      .os-tabs{display:flex;flex-direction:column;gap:10px;background:${T.side};border-bottom:1px solid ${T.line};padding:12px 14px 0;position:sticky;top:0;z-index:5}
      .os-main{padding:16px 7px 40px}
      .os-hero{flex-direction:column}
      .os-herocard{flex-basis:auto}
      .os-px{flex-direction:column;align-items:stretch}
      .os-spark{flex:0 0 auto;height:40px;min-height:40px;width:100%}
      .os-price{font-size:22px}
      .os-h1{font-size:26px}
      .os-etf{font-size:11px}
      .os-bd-d{display:none}
      .os-bd-m{display:inline}
    }
    .os-navbtn{display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:44px;border-radius:9px;border:1px solid transparent;background:transparent;color:${T.sub};font-family:${F};font-size:13px;font-weight:700;cursor:pointer;text-align:left;width:100%}
    .os-navbtn:focus-visible{outline:2px solid ${T.acc};outline-offset:2px}
    .os-navbtn[disabled]{cursor:not-allowed}
    .os-tabstrip{display:flex;gap:6px;overflow-x:auto;padding-bottom:12px}
    .os-tabstrip .os-navbtn{flex:0 0 auto;width:auto;white-space:nowrap}
  `;

  const NavBtn = ({ n, strip }) => {
    const active = n.id === "home";
    const disabled = !!n.off;
    return (
      <button type="button" className="os-navbtn" disabled={disabled} onClick={() => !disabled && !active && onNavigate(n.id)}
        style={{ background: active ? T.navOn : "transparent", borderColor: active ? T.navOnLine : "transparent", color: active ? T.acc : n.dim ? T.mute : T.sub }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d={n.icon} /></svg>
        <span style={{ flex: 1 }}>{n.label}</span>
        {!strip && <span style={{ fontFamily: M, fontSize: 10, color: active ? T.acc : T.mute }}>{n.tag}</span>}
      </button>
    );
  };

  const Logo = ({ s = 32 }) => (
    <div style={{ width: s, height: s, borderRadius: 8, background: T.logo, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={s / 2} height={s / 2} viewBox="0 0 24 24" fill="none" stroke="#00d4aa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>
    </div>
  );

  return (
    <div className="os-home">
      <style>{css}</style>

      <AppHeader view="home" onNavigate={onNavigate} light={light} onToggleLight={onToggleLight} />

      <main className="os-main">
        <div className="os-hero">
          <div className="os-herocard" style={{ background: feedClosed ? T.soft : T.okBg, border: `1px solid ${feedClosed ? T.line : T.okLine}`, borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
            <div style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.1em", color: feedColor }}>● MARKET FEED</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: feedColor }}>
              {!mk ? (err ? "Unavailable" : "Loading…") : `${complete} of ${cards.length} cards complete`}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: T.dim }}>
              {mk ? `Updated ${ageText(mk.updated_at)}${stale ? " · stale" : feedClosed ? " · market closed" : ""}.` : "market.json could not be read."}
            </div>
          </div>
        </div>

        <section aria-labelledby="s1">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 8px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div id="s1" style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>01 / MARKET SNAPSHOT</div>
              <div role="tablist" aria-label="Chart mode" style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: 7, overflow: "hidden" }}>
                {[["D", "D/W/M"], ["intraday", "Intraday"]].map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={mode === k} onClick={() => pickMode(k)}
                    style={{ fontFamily: M, fontSize: 11, fontWeight: 600, padding: "3px 10px", border: 0, cursor: "pointer", background: mode === k ? T.soft : "transparent", color: mode === k ? T.txt : T.mute }}>{label}</button>
                ))}
              </div>
            </div>
            <div style={{ fontFamily: M, fontSize: 11, color: T.mute, whiteSpace: "nowrap" }}>{live ? (marketsClosed() ? <span><span style={{ color: T.mute }}>●</span> closed</span> : <span style={{ color: T.up }}>● live</span>) : "snapshot"}</div>
          </div>
          {mk ? (
            <div className="os-grid">{cards.map((cd) => <IndexCard key={cd.id} card={cd} T={T} mode={mode} daily={daily?.cards?.[cd.id]} tf={tfMap[cd.id] || "D"} onCycle={() => cycleTf(cd.id)} light={light} />)}</div>
          ) : (
            <div style={{ border: `1px solid ${T.line}`, background: T.card, borderRadius: 12, padding: 18, fontFamily: M, fontSize: 12, color: err ? T.dn : T.dim }}>
              {err ? `Could not load market.json (${err}).` : "Loading market data…"}
            </div>
          )}
        </section>

        <BandSection band={band} bq={bq} T={T} />

        <ConfluenceSection wl={wl} T={T} onNavigate={onNavigate} />

        <SummarySection sm={sm} T={T} />

        <div style={{ fontFamily: M, fontSize: 11, lineHeight: 1.7, color: T.mute }}>Read-only. No orders can be placed here. Quotes may be delayed. Not investment advice.</div>
      </main>
    </div>
  );
}
