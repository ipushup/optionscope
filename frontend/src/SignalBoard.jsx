import { useEffect, useMemo, useRef, useState } from "react";

/**
 * SignalBoard.jsx — 同 TradingView 並排用嘅短線信號板。
 * 讀 /signals.json（signal_board.py 每 5 分鐘出）：每隻股 × (5m,15m)
 * 嘅 TB/TS、UT、Heavy 最新事件 + 「接近區間」重疊分數。
 * 點股票 → 開 TradingView。
 */
const URL_ = "/signals.json";
const THEMES = {
  dark: { bg: "#16181b", card: "#202327", line: "#33383f", soft: "#2b2f35", txt: "#e6e9ec", sub: "#b4bcc4", dim: "#9aa4ad", mute: "#7d868f", up: "#00d4aa", dn: "#ff5c5c", warn: "#f5a623", acc: "#3b9eff", yel: "#e8c34a" },
  light: { bg: "#f3f4f6", card: "#ffffff", line: "#d9dde2", soft: "#e8ebef", txt: "#1b1f24", sub: "#3c444d", dim: "#56606b", mute: "#6b7580", up: "#00875a", dn: "#c81e3f", warn: "#a55a00", acc: "#0b6bcb", yel: "#9a7400" },
};
const M = "'DM Mono',ui-monospace,monospace";
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
const MIN = { "5m": 5, "15m": 15 };

const GROUP = { TB: "TB", TBskip: "TB", TS: "TB", UTB: "UT", UTS: "UT", HB: "HEAVY", HS: "HEAVY" };
const BULL = new Set(["TB", "TBskip", "UTB", "HB"]);

function ago(bars, tf) {
  const m = bars * MIN[tf];
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + "m" : ""}`;
}
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
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return `${p.day} ${p.month} ${p.hour}:${p.minute} HKT`;
  } catch { return ""; }
};

export default function SignalBoard({ isMobile, light, onBack }) {
  const T = light ? THEMES.light : THEMES.dark;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [tf, setTf] = useState(() => { try { return localStorage.getItem("os_sb_tf") || "15m"; } catch { return "15m"; } });
  const [side, setSide] = useState("all");      // all | bull | bear
  const [minScore, setMinScore] = useState(1);
  const [q, setQ] = useState("");
  const [sound, setSound] = useState(false);
  const seen = useRef({});                       // sym → 上次分數
  useEffect(() => { try { localStorage.setItem("os_sb_tf", tf); } catch { /* */ } }, [tf]);

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(URL_, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`signals.json ${r.status}`); return r.json(); })
      .then(j => { if (alive) { setData(j); setErr(null); } })
      .catch(e => alive && setErr(String(e.message || e)));
    pull(); const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const out = [];
    for (const r of data.rows) {
      const d = r[tf]; if (!d) continue;
      const score = Math.max(d.bull, d.bear);
      const dir = d.bull === d.bear ? (d.bull ? "mix" : "none") : d.bull > d.bear ? "bull" : "bear";
      const first = d.ev.length ? Math.min(...d.ev.map(e => e.ago)) : 999;
      out.push({ ...r, d, score, dir, first });
    }
    return out;
  }, [data, tf]);

  const shown = useMemo(() => {
    const k = q.trim().toUpperCase();
    return rows.filter(r => r.score >= minScore && (!k || r.sym.includes(k)) &&
      (side === "all" || r.dir === side || r.dir === "mix"))
      .sort((a, b) => b.score - a.score || a.first - b.first || a.sym.localeCompare(b.sym));
  }, [rows, q, side, minScore]);

  // 新到 3 分 → 響
  useEffect(() => {
    if (!rows.length) return;
    let ping = false;
    for (const r of rows) {
      const p = seen.current[r.sym] ?? 0;
      if (r.score >= 3 && p < 3) ping = true;
      seen.current[r.sym] = r.score;
    }
    if (ping && sound) beep();
  }, [rows, sound]);

  const near = data?.near ?? 6;
  const chip = (on, extra) => ({
    background: on ? T.soft : "transparent", color: on ? T.txt : T.dim,
    border: `1px solid ${on ? T.line : "transparent"}`, borderRadius: 7, padding: "5px 10px",
    fontFamily: M, fontSize: 12, cursor: "pointer", ...extra,
  });

  const Cell = ({ r, grp }) => {
    const e = r.d.ev.filter(x => GROUP[x.k] === grp).sort((a, b) => a.ago - b.ago)[0];
    if (!e) return <span style={{ color: T.mute }}>–</span>;
    const bull = BULL.has(e.k);
    const skip = e.k === "TBskip";
    let col = skip ? T.mute : bull ? T.up : T.dn;
    if (e.k === "TB" && e.tier === "weak") col = T.yel;
    if (e.k === "TS" && e.tier === "weak") col = T.warn;
    const label = e.k === "UTB" ? "▲ UT" : e.k === "UTS" ? "▼ UT" : e.k === "HB" ? "Heavy B" : e.k === "HS" ? "Heavy S" : skip ? "skip" : e.k + (e.tier === "strong" ? "★" : "");
    const fresh = e.ago <= near;
    return (
      <span style={{ color: col, opacity: fresh ? 1 : 0.45, whiteSpace: "nowrap", fontWeight: fresh ? 700 : 500 }}
        title={`${e.k} ${e.t} UTC${e.tier ? " · " + e.tier : ""}${e.val ? " · Δ" + e.val : ""}`}>
        {label} <span style={{ color: T.dim, fontWeight: 400, fontSize: 11 }}>{ago(e.ago, tf)}</span>
      </span>
    );
  };

  const th = { textAlign: "left", padding: "8px 10px", color: T.mute, fontWeight: 500, fontSize: 11, borderBottom: `1px solid ${T.line}`, position: "sticky", top: 0, background: T.card };
  const td = { padding: isMobile ? "9px 8px" : "9px 10px", borderBottom: `1px solid ${T.soft}`, fontSize: isMobile ? 12 : 13, fontFamily: M };

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.txt, fontFamily: SANS, padding: isMobile ? "14px 12px 40px" : "22px 28px 40px", boxSizing: "border-box", width: "100%", maxWidth: "100vw", overflowX: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {onBack && <button onClick={onBack} style={chip(false, { border: `1px solid ${T.line}` })}>← Home</button>}
        <div style={{ fontFamily: M, fontSize: 11, color: T.mute, letterSpacing: 1 }}>SIGNAL BOARD</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: M, fontSize: 11, color: err ? T.dn : T.mute }}>
          {err ? `⚠ ${err}` : data ? `● ${stamp(data.updated)} · ${data.n} 隻` : "loading…"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 2 }}>
          {["5m", "15m"].map(x => <button key={x} onClick={() => setTf(x)} style={chip(tf === x)}>{x}</button>)}
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {[["all", "全部"], ["bull", "偏多"], ["bear", "偏空"]].map(([k, l]) => <button key={k} onClick={() => setSide(k)} style={chip(side === k)}>{l}</button>)}
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {[1, 2, 3].map(n => <button key={n} onClick={() => setMinScore(n)} style={chip(minScore === n)}>{n}+</button>)}
        </div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋 symbol"
          style={{ background: T.card, border: `1px solid ${T.line}`, color: T.txt, borderRadius: 7, padding: "6px 10px", fontFamily: M, fontSize: 12, width: 130 }} />
        <button onClick={() => setSound(s => !s)} style={chip(sound)}>{sound ? "🔔 開" : "🔕 靜音"}</button>
      </div>

      <div style={{ fontSize: 11, color: T.mute, fontFamily: M, marginBottom: 10, lineHeight: 1.6 }}>
        分數 = {near} 棒（{ago(near, tf)}）內同時出現幾組信號（TB、UT、Heavy）。TB★ 強 · 黃/橙 弱 · skip = 被 rU60 濾走。灰淡 = 超過接近區間。
      </div>

      <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, overflow: "auto", maxWidth: "100%", maxHeight: "calc(100vh - 210px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isMobile ? 440 : 520 }}>
          <thead><tr>
            <th style={th}>股票</th><th style={th}>分數</th><th style={th}>TB / TS</th>
            <th style={th}>UT</th><th style={th}>Heavy</th>
            {!isMobile && <th style={{ ...th, textAlign: "right" }}>價 / 升跌</th>}
          </tr></thead>
          <tbody>
            {shown.map(r => {
              const col = r.dir === "bull" ? T.up : r.dir === "bear" ? T.dn : r.dir === "mix" ? T.warn : T.mute;
              return (
                <tr key={r.sym} onClick={() => window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.sym)}&interval=${MIN[tf]}`, "_blank", "noopener")}
                  style={{ cursor: "pointer" }}>
                  <td style={{ ...td, fontWeight: 700, fontFamily: SANS }}>
                    {r.sym}
                    <span style={{ marginLeft: 6, color: r.d.ut_pos === 1 ? T.up : T.dn, fontSize: 9 }} title="UT 持倉方向">{r.d.ut_pos === 1 ? "●" : "○"}</span>
                    {isMobile && <div style={{ fontFamily: M, fontSize: 11, color: r.chg >= 0 ? T.up : T.dn, fontWeight: 400 }}>{r.px?.toFixed(2)} {r.chg != null ? `${r.chg >= 0 ? "+" : ""}${r.chg}%` : ""} <span style={{ color: T.mute }}>{r.sess}</span></div>}
                  </td>
                  <td style={{ ...td, color: col, fontWeight: 700 }}>{r.score ? `${r.dir === "bear" ? "▼" : r.dir === "bull" ? "▲" : "◆"} ${r.score}` : "·"}</td>
                  <td style={td}><Cell r={r} grp="TB" /></td>
                  <td style={td}><Cell r={r} grp="UT" /></td>
                  <td style={td}><Cell r={r} grp="HEAVY" /></td>
                  {!isMobile && <td style={{ ...td, textAlign: "right", color: r.chg >= 0 ? T.up : T.dn }}>{r.px?.toFixed(2)} <span style={{ fontSize: 11 }}>{r.chg != null ? `${r.chg >= 0 ? "+" : ""}${r.chg}%` : ""}</span> <span style={{ fontSize: 10, color: T.mute }}>{r.sess}</span></td>}
                </tr>
              );
            })}
            {data && !shown.length && <tr><td colSpan={6} style={{ ...td, color: T.mute, textAlign: "center", padding: 28 }}>呢個條件下暫時冇信號</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
