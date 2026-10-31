import { useEffect, useState } from "react";

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

const THEMES = {
  dark: {
    bg: "#16181b", side: "#111316", card: "#202327", line: "#33383f", soft: "#2b2f35",
    txt: "#e6e9ec", sub: "#b4bcc4", dim: "#9aa4ad", mute: "#7d868f",
    up: "#00d4aa", dn: "#ff5c5c", warn: "#f5a623", acc: "#3b9eff",
    navOn: "#2b3340", navOnLine: "#3a4a63", logo: "#1f4f8f", okBg: "#17241f", okLine: "#25423a",
  },
  light: {
    bg: "#f3f4f6", side: "#ffffff", card: "#ffffff", line: "#d9dde2", soft: "#e8ebef",
    txt: "#1b1f24", sub: "#3c444d", dim: "#56606b", mute: "#6b7580",
    up: "#00875a", dn: "#c81e3f", warn: "#a55a00", acc: "#0b6bcb",
    navOn: "#dbe7f7", navOnLine: "#b5cdee", logo: "#0652b2", okBg: "#eaf7f0", okLine: "#b9e2cc",
  },
};
const F = "'Syne',system-ui,sans-serif";
const M = "'DM Mono',ui-monospace,monospace";

const NAV = [
  { id: "home", label: "Home", tag: "now", icon: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V11z" },
  { id: "band", label: "Triple Band", tag: "live", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
  { id: "watchlist", label: "Watchlist", tag: "live", icon: "M4 6h16M4 12h16M4 18h10" },
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

function Spark({ data, color, T }) {
  if (!data || data.length < 2) {
    return <svg width="84" height="30" aria-hidden="true"><path d="M2 15h80" stroke={T.mute} strokeWidth="1.5" strokeDasharray="3 4" fill="none" /></svg>;
  }
  const lo = Math.min(...data), hi = Math.max(...data), span = hi - lo || 1;
  const pts = data.map((v, i) => `${(2 + (i / (data.length - 1)) * 80).toFixed(1)},${(27 - ((v - lo) / span) * 24).toFixed(1)}`).join(" ");
  return <svg width="84" height="30" viewBox="0 0 84 30" aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" /></svg>;
}

function IndexCard({ card, T }) {
  const ix = card.index, etf = card.etf;
  const isYield = card.id === "us10y";
  const main = ix || null;
  const up = main ? main.change >= 0 : true;
  const col = main ? (up ? T.up : T.dn) : T.mute;
  const etfCol = etf ? (etf.change >= 0 ? T.up : T.dn) : T.mute;
  const arrow = (x) => (x.change >= 0 ? "▲" : "▼");
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderTop: `2px solid ${col}`, borderRadius: 12, padding: "14px 14px 12px", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.sub }}>{card.name}</span>
        <span style={{ fontFamily: M, fontSize: 10, color: T.mute }}>{card.index_symbol}</span>
      </div>
      <div className="os-px" style={{ display: "flex", justifyContent: "space-between", gap: 6, marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div className="os-price" style={{ fontFamily: M, fontWeight: 500, color: T.txt }}>
            {main ? (isYield ? `${fmt(main.last)}%` : fmt(main.last)) : "N/A"}
          </div>
          <div style={{ fontFamily: M, fontSize: 12, marginTop: 4, color: col }}>
            {main ? `${arrow(main)} ${isYield ? `${fmt(Math.abs(main.change) * 100, 1)} bp` : fmt(Math.abs(main.change))} · ${pctText(main.pct)}` : "no quote"}
          </div>
        </div>
        <div style={{ flexShrink: 0 }}>
          <Spark data={main?.spark} color={col} T={T} />
          <div style={{ fontFamily: M, fontSize: 10, color: T.mute }}>{main ? "Intraday" : "—"}</div>
        </div>
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: M, fontSize: 10, letterSpacing: "0.08em", color: T.mute }}>ETF · {card.etf_symbol}</div>
          <div style={{ fontFamily: M, fontSize: 15, fontWeight: 500, color: T.txt, marginTop: 2 }}>{etf ? fmt(etf.last) : "N/A"}</div>
        </div>
        <div style={{ fontFamily: M, fontSize: 12, color: etfCol, textAlign: "right" }}>
          {etf ? `${arrow(etf)} ${pctText(etf.pct)}` : ""}
        </div>
      </div>
    </div>
  );
}

export default function Home({ onNavigate, light, onToggleLight }) {
  const T = light ? THEMES.light : THEMES.dark;
  const [mk, setMk] = useState(null);
  const [err, setErr] = useState(null);

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

  const cards = mk?.cards || [];
  const complete = cards.filter((c) => c.index && c.etf).length;
  const ageMin = mk ? (Date.now() - new Date(mk.updated_at).getTime()) / 60000 : null;
  const stale = ageMin != null && ageMin > 60;
  const feedColor = !mk ? T.dn : stale ? T.warn : T.up;

  const css = `
    .os-home{min-height:100vh;display:flex;flex-direction:row;background:${T.bg};color:${T.txt};font-family:${F}}
    .os-home *{box-sizing:border-box}
    .os-side{flex:0 0 220px;width:220px;background:${T.side};border-right:1px solid ${T.line};padding:20px 16px;display:flex;flex-direction:column;gap:18px;position:sticky;top:0;height:100vh}
    .os-nav{display:flex;flex-direction:column;gap:6px}
    .os-main{flex:1 1 auto;min-width:0;padding:24px 32px 48px;display:flex;flex-direction:column;gap:28px}
    .os-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .os-hero{display:flex;flex-direction:row;align-items:stretch;gap:16px}
    .os-herocard{flex:0 0 300px}
    .os-price{font-size:22px}
    .os-px{flex-direction:row;align-items:flex-end}
    .os-tabs{display:none}
    .os-h1{font-size:34px}
    @media (max-width:1199px){
      .os-side{flex-basis:190px;width:190px}
      .os-main{padding:22px 24px 40px}
      .os-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .os-herocard{flex-basis:230px}
      .os-price{font-size:24px}
    }
    @media (max-width:759px){
      .os-home{flex-direction:column}
      .os-side{display:none}
      .os-tabs{display:flex;flex-direction:column;gap:10px;background:${T.side};border-bottom:1px solid ${T.line};padding:12px 14px 0;position:sticky;top:0;z-index:5}
      .os-main{padding:16px 14px 40px}
      .os-hero{flex-direction:column}
      .os-herocard{flex-basis:auto}
      .os-px{flex-direction:column;align-items:flex-start}
      .os-price{font-size:20px}
      .os-h1{font-size:26px}
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

      <aside className="os-side">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.3px" }}>OptionScope</div>
            <div style={{ fontFamily: M, fontSize: 10, color: T.mute, letterSpacing: "0.1em" }}>PERSONAL DESK</div>
          </div>
        </div>
        <div style={{ fontFamily: M, fontSize: 10, color: T.mute, letterSpacing: "0.14em" }}>WORKSPACE</div>
        <nav className="os-nav" aria-label="Primary">{NAV.map((n) => <NavBtn key={n.id} n={n} />)}</nav>
        <div style={{ marginTop: "auto", background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontFamily: M, fontSize: 11, color: T.dim }}>Read only</div>
          <div style={{ fontFamily: M, fontSize: 11, color: T.mute }}>Market data {mk ? ageText(mk.updated_at) : "—"}</div>
        </div>
      </aside>

      <div className="os-tabs">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo s={28} />
          <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: "-0.3px", flex: 1 }}>OptionScope</div>
        </div>
        <nav className="os-tabstrip" aria-label="Primary">{NAV.map((n) => <NavBtn key={n.id} n={n} strip />)}</nav>
      </div>

      <main className="os-main">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.12em", color: T.mute }}>OPTIONSCOPE / <span style={{ color: T.txt }}>HOME</span></div>
          <button type="button" onClick={onToggleLight} aria-label="Switch dark or light theme" style={{ width: 44, height: 44, borderRadius: 8, border: `1px solid ${T.line}`, background: T.card, color: T.dim, cursor: "pointer", fontSize: 16 }}>{light ? "🌙" : "☀"}</button>
        </div>

        <div className="os-hero">
          <header style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.14em", color: T.acc }}>HOME · DAILY DESK</div>
            <h1 className="os-h1" style={{ margin: 0, lineHeight: 1.15, fontWeight: 800, letterSpacing: "-0.5px" }}>Today at a glance</h1>
            <p style={{ margin: 0, maxWidth: 640, fontSize: 14, lineHeight: 1.6, color: T.dim }}>市場、Triple Band 訊號同數據新鮮度，一頁睇晒。Read-only: no orders can be placed from here.</p>
          </header>
          <div className="os-herocard" style={{ background: T.okBg, border: `1px solid ${T.okLine}`, borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 6 }}>
            <div style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.1em", color: feedColor }}>● MARKET FEED</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: feedColor }}>
              {!mk ? (err ? "Unavailable" : "Loading…") : `${complete} of ${cards.length} cards complete`}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, color: T.dim }}>
              {mk ? `Updated ${ageText(mk.updated_at)}${stale ? " · stale" : ""}. A missing quote shows N/A, never an estimate.` : "market.json could not be read."}
            </div>
          </div>
        </div>

        <section aria-labelledby="s1">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 8, marginBottom: 14 }}>
            <div>
              <div style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.12em", color: T.mute }}>01 / MARKET SNAPSHOT</div>
              <h2 id="s1" style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700 }}>Indices and macro</h2>
            </div>
            <div style={{ fontFamily: M, fontSize: 11, color: T.mute }}>index + tracking ETF · source: {mk?.source || "—"}</div>
          </div>
          {mk ? (
            <div className="os-grid">{cards.map((cd) => <IndexCard key={cd.id} card={cd} T={T} />)}</div>
          ) : (
            <div style={{ border: `1px solid ${T.line}`, background: T.card, borderRadius: 12, padding: 18, fontFamily: M, fontSize: 12, color: err ? T.dn : T.dim }}>
              {err ? `Could not load market.json (${err}).` : "Loading market data…"}
            </div>
          )}
          <div style={{ marginTop: 12, fontFamily: M, fontSize: 11, lineHeight: 1.7, color: T.mute }}>
            TQQQ (3x) and UVIX (2x) are leveraged and decay over time; their % moves are not the index's move. IEF is a price, not a yield.
          </div>
        </section>

        <div style={{ fontFamily: M, fontSize: 11, lineHeight: 1.7, color: T.mute }}>Read-only. No orders can be placed here. Quotes may be delayed. Not investment advice.</div>
      </main>
    </div>
  );
}
