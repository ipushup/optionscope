import { useState, useEffect, useCallback } from "react";
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";

const RESULTS_URL = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/results.json` : "/results.json";

// ─── SCORING ──────────────────────────────────────────────────────────────────
// Premium selling score: combines IV Rank + trend strength + RSI safety
function calcPremiumScore(stock) {
  let score = 0;
  // IV Rank is most important (50 pts max)
  score += Math.min(50, stock.iv_rank * 0.5);
  // ADX trend strength (25 pts max)
  score += Math.min(25, stock.adx * 0.6);
  // RSI not extreme — avoid selling into parabolic moves (15 pts max)
  const rsiSafe = stock.rsi >= 30 && stock.rsi <= 75;
  score += rsiSafe ? 15 : 0;
  // Volume not spiking — avoid event days (10 pts max)
  score += stock.volume_spike < 2.0 ? 10 : stock.volume_spike < 3.0 ? 5 : 0;
  return Math.round(Math.min(100, score));
}

function getScoreColor(score) {
  if (score >= 80) return "#00d4aa";
  if (score >= 60) return "#3b9eff";
  if (score >= 40) return "#f5a623";
  return "#ff5c5c";
}

function getScoreLabel(score) {
  if (score >= 80) return "SELL NOW";
  if (score >= 60) return "GOOD";
  if (score >= 40) return "FAIR";
  return "AVOID";
}

// Which to sell based on trend
function getSellType(stock) {
  if (stock.trend === "bullish") return { type: "SELL PUT", color: "#00d4aa", desc: "Stock trending up — sell below price" };
  if (stock.trend === "bearish") return { type: "SELL CALL", color: "#ff8c42", desc: "Stock trending down — sell above price" };
  return { type: "SELL STRANGLE", color: "#cc77ff", desc: "No strong trend — sell both sides" };
}

// Strike suggestion: 1 std dev OTM
function getSuggestedStrike(stock, type) {
  const move1w = stock.price * (stock.iv_current / 100) * Math.sqrt(7 / 365);
  if (type === "SELL PUT")      return Math.floor((stock.price - move1w * 1.2) / 0.5) * 0.5;
  if (type === "SELL CALL")     return Math.ceil((stock.price  + move1w * 1.2) / 0.5) * 0.5;
  return null;
}

// Days to expiry recommendation
function getDTEadvice(ivRank) {
  if (ivRank >= 75) return { dte: "21–30 DTE", reason: "IV very high — shorter expiry captures max decay" };
  if (ivRank >= 50) return { dte: "30–45 DTE", reason: "Good IV — standard theta decay zone" };
  return { dte: "45–60 DTE", reason: "Lower IV — longer expiry needed for premium" };
}

const CATEGORY_ICON = {
  meme: "🔥", crypto: "🪙", nuclear_energy: "⚛️", ai_quantum: "🤖",
  ev_clean: "🚗", biotech: "💊", high_beta_tech: "📱", fintech: "🏦",
  leveraged_etfs: "📊", sp100_core: "📈", other: "◆",
};

// ─── COMPONENTS ──────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 56 }) {
  const color = getScoreColor(score);
  const label = getScoreLabel(score);
  const r = (size / 2) - 5;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1a2a3a" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 1s cubic-bezier(0.4,0,0.2,1)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 900, color, fontFamily: "DM Mono,monospace", lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: 8, color, fontFamily: "DM Mono,monospace", letterSpacing: "0.05em" }}>{label}</div>
      </div>
    </div>
  );
}

function IVBar({ value }) {
  const color = value >= 75 ? "#00d4aa" : value >= 50 ? "#3b9eff" : value >= 25 ? "#f5a623" : "#ff5c5c";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", letterSpacing: "0.1em" }}>IV RANK</span>
        <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "DM Mono,monospace" }}>{value.toFixed(1)}</span>
      </div>
      <div style={{ background: "#0e1c28", borderRadius: 3, height: 6 }}>
        <div style={{ width: `${Math.min(value,100)}%`, height: "100%", background: color, borderRadius: 3, transition: "width 1s ease" }} />
      </div>
    </div>
  );
}

function PremiumCard({ stock, isSelected, onClick }) {
  const score    = calcPremiumScore(stock);
  const scoreCol = getScoreColor(score);
  const sell     = getSellType(stock);
  const dte      = getDTEadvice(stock.iv_rank);
  const strike   = getSuggestedStrike(stock, sell.type);
  const catIcon  = CATEGORY_ICON[stock.category] || "◆";

  return (
    <div onClick={onClick} style={{
      background: isSelected ? "#0c1e34" : "#080f1c",
      border: `1px solid ${isSelected ? scoreCol : "#0e1c28"}`,
      borderRadius: 14,
      padding: "14px 16px",
      cursor: "pointer",
      transition: "all 0.2s ease",
      boxShadow: isSelected ? `0 0 0 2px ${scoreCol}22, 0 8px 32px #00000088` : "none",
    }}>

      {/* ── ROW 1: Score ring + ticker + sell type ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <ScoreRing score={score} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11 }}>{catIcon}</span>
            <span style={{ fontSize: 21, fontWeight: 900, color: "#ddeeff", fontFamily: "'Syne',sans-serif", letterSpacing: "-0.5px" }}>{stock.ticker}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#7a9ab8", fontFamily: "DM Mono,monospace" }}>${stock.price.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 10, color: "#3a5060", fontFamily: "DM Mono,monospace", marginTop: 1 }}>
            IV {stock.iv_current}% · ADX {stock.adx} · RSI {stock.rsi}
          </div>
        </div>
        {/* Sell type badge */}
        <div style={{ textAlign: "center", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: sell.color, fontFamily: "DM Mono,monospace", letterSpacing: "0.05em",
            background: sell.color + "18", border: `1px solid ${sell.color}44`, borderRadius: 6, padding: "4px 8px" }}>
            {sell.type}
          </div>
        </div>
      </div>

      {/* ── IV Bar ── */}
      <IVBar value={stock.iv_rank} />

      {/* ── KEY TRADE INFO ── */}
      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>

        {/* Suggested strike */}
        <div style={{ padding: "8px 10px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28" }}>
          <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", letterSpacing: "0.08em", marginBottom: 3 }}>
            {sell.type === "SELL PUT" ? "SELL PUT STRIKE" : sell.type === "SELL CALL" ? "SELL CALL STRIKE" : "SELL STRANGLE"}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: sell.color, fontFamily: "DM Mono,monospace" }}>
            {strike ? `$${strike.toFixed(2)}` : "Both sides"}
          </div>
          <div style={{ fontSize: 9, color: "#445566", fontFamily: "DM Mono,monospace", marginTop: 2 }}>{sell.desc}</div>
        </div>

        {/* DTE recommendation */}
        <div style={{ padding: "8px 10px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28" }}>
          <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", letterSpacing: "0.08em", marginBottom: 3 }}>BEST EXPIRY (DTE)</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#f5a623", fontFamily: "DM Mono,monospace" }}>{dte.dte}</div>
          <div style={{ fontSize: 9, color: "#445566", fontFamily: "DM Mono,monospace", marginTop: 2 }}>{dte.reason}</div>
        </div>
      </div>

      {/* ── SAFE ZONE ── */}
      <div style={{ marginTop: 8, padding: "8px 10px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28" }}>
        <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", letterSpacing: "0.08em", marginBottom: 4 }}>
          SAFE PRICE ZONE (1 WEEK · 1 STD DEV · ~68% PROBABILITY)
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#ff8c42", fontFamily: "DM Mono,monospace" }}>${stock.range_1w.low}</span>
          <div style={{ flex: 1, height: 4, background: "#0e1c28", borderRadius: 2, position: "relative" }}>
            <div style={{ position: "absolute", left: "20%", right: "20%", top: 0, height: "100%", background: "#00d4aa44", borderRadius: 2 }} />
            <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", top: -3, width: 2, height: 10, background: "#3b9eff", borderRadius: 1 }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#ff8c42", fontFamily: "DM Mono,monospace" }}>${stock.range_1w.high}</span>
        </div>
        <div style={{ fontSize: 9, color: "#2e4055", fontFamily: "DM Mono,monospace", marginTop: 3, textAlign: "center" }}>
          Keep your strike OUTSIDE this range for safety
        </div>
      </div>

      {/* ── FOOTER ── */}
      <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 10, color: "#3a5060", fontFamily: "DM Mono,monospace" }}>
          {stock.volume_spike > 1.8 && <span style={{ color: "#f5a623" }}>🔥 Vol spike ×{stock.volume_spike} · </span>}
          <span style={{ color: scoreCol }}>Score {score}/100</span>
        </div>
        <div style={{ fontSize: 10, color: "#2e4055", fontFamily: "DM Mono,monospace" }}>
          {stock.scanned_at ? new Date(stock.scanned_at).toLocaleTimeString() : "demo"}
        </div>
      </div>
    </div>
  );
}

function DetailPanel({ stock, isMobile, onClose }) {
  if (!stock) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: "#2e4055" }}>
      <div style={{ fontSize: 40 }}>⚡</div>
      <div style={{ fontFamily: "DM Mono,monospace", fontSize: 12 }}>Select a stock</div>
    </div>
  );

  const score  = calcPremiumScore(stock);
  const sell   = getSellType(stock);
  const dte    = getDTEadvice(stock.iv_rank);
  const strike = getSuggestedStrike(stock, sell.type);
  const scoreCol = getScoreColor(score);

  // Theta estimate: rough daily decay
  const dailyTheta = (stock.iv_current / 100) * stock.price / Math.sqrt(365) * 0.4;

  return (
    <div style={{ padding: "18px 16px", overflowY: "auto", height: "100%" }}>
      {isMobile && (
        <button onClick={onClose} style={{ background: "#0a1520", border: "1px solid #162030", borderRadius: 6, color: "#667788", padding: "6px 14px", fontSize: 12, cursor: "pointer", fontFamily: "DM Mono,monospace", marginBottom: 14 }}>← Back</button>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
        <ScoreRing score={score} size={68} />
        <div>
          <div style={{ fontSize: 28, fontWeight: 900, color: "#ddeeff", fontFamily: "'Syne',sans-serif", letterSpacing: "-1px" }}>{stock.ticker}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#7a9ab8", fontFamily: "DM Mono,monospace" }}>${stock.price.toFixed(2)}</div>
          <div style={{ fontSize: 10, color: "#2e4055", fontFamily: "DM Mono,monospace" }}>{CATEGORY_ICON[stock.category]} {stock.category?.replace("_"," ")}</div>
        </div>
      </div>

      {/* Main action */}
      <div style={{ padding: "14px", background: sell.color + "12", borderRadius: 10, border: `1px solid ${sell.color}33`, marginBottom: 12, textAlign: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 900, color: sell.color, fontFamily: "DM Mono,monospace", letterSpacing: "0.05em" }}>{sell.type}</div>
        <div style={{ fontSize: 12, color: sell.color + "aa", fontFamily: "DM Mono,monospace", marginTop: 4 }}>{sell.desc}</div>
      </div>

      {/* Strike + DTE */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        <div style={{ padding: "12px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28", textAlign: "center" }}>
          <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", marginBottom: 4 }}>STRIKE LEVEL</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: sell.color, fontFamily: "DM Mono,monospace" }}>
            {strike ? `$${strike.toFixed(0)}` : "±OTM"}
          </div>
          <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", marginTop: 3 }}>suggested ATM±1σ</div>
        </div>
        <div style={{ padding: "12px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28", textAlign: "center" }}>
          <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", marginBottom: 4 }}>EXPIRY (DTE)</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "#f5a623", fontFamily: "DM Mono,monospace" }}>{dte.dte}</div>
          <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", marginTop: 3 }}>{dte.reason}</div>
        </div>
      </div>

      {/* IV Rank */}
      <div style={{ marginBottom: 10 }}>
        <IVBar value={stock.iv_rank} />
        <div style={{ fontSize: 10, color: "#3a5060", fontFamily: "DM Mono,monospace", marginTop: 4 }}>
          Current IV: {stock.iv_current}% · Higher IV Rank = more premium collected
        </div>
      </div>

      {/* Safe zones */}
      <div style={{ padding: "10px 12px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28", marginBottom: 8 }}>
        <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", marginBottom: 6 }}>EXPECTED MOVE (keep strike outside these)</div>
        {[["1 Day", stock.range_1d], ["1 Week", stock.range_1w], ["1 Month", stock.range_1m]].map(([lbl, r]) => (
          <div key={lbl} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: "#445566", fontFamily: "DM Mono,monospace" }}>{lbl}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: "#7a9ab8", fontFamily: "DM Mono,monospace" }}>${r.low} – ${r.high}</span>
          </div>
        ))}
      </div>

      {/* Theta estimate */}
      <div style={{ padding: "10px 12px", background: "#06130e", borderRadius: 8, border: "1px solid #0e2e1e", marginBottom: 8 }}>
        <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace", marginBottom: 4 }}>ESTIMATED DAILY THETA DECAY</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#00d4aa", fontFamily: "DM Mono,monospace" }}>~${dailyTheta.toFixed(2)} / contract</div>
        <div style={{ fontSize: 9, color: "#2e6040", fontFamily: "DM Mono,monospace", marginTop: 3 }}>
          Approximate value lost by option each day · works in your favour as seller
        </div>
      </div>

      {/* Market conditions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {[
          ["ADX", stock.adx, stock.adx >= 25 ? "#00d4aa" : "#f5a623", stock.adx >= 25 ? "Strong trend" : "Weak trend"],
          ["RSI", stock.rsi, stock.rsi > 70 ? "#ff5c5c" : stock.rsi < 30 ? "#ff5c5c" : "#00d4aa", stock.rsi > 70 ? "Overbought" : stock.rsi < 30 ? "Oversold" : "Safe zone"],
          ["VOL ×", stock.volume_spike, stock.volume_spike > 2 ? "#ff5c5c" : "#00d4aa", stock.volume_spike > 2 ? "Event risk!" : "Normal"],
        ].map(([lbl, val, col, hint]) => (
          <div key={lbl} style={{ padding: "8px", background: "#060e1a", borderRadius: 8, border: "1px solid #0e1c28", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#3a5060", fontFamily: "DM Mono,monospace" }}>{lbl}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: col, fontFamily: "DM Mono,monospace" }}>{typeof val === "number" ? val.toFixed(1) : val}</div>
            <div style={{ fontSize: 8, color: "#3a5060", fontFamily: "DM Mono,monospace" }}>{hint}</div>
          </div>
        ))}
      </div>

      {/* Warning if bad conditions */}
      {(stock.volume_spike > 2.5 || stock.rsi > 75 || stock.rsi < 25) && (
        <div style={{ marginTop: 10, padding: "10px 12px", background: "#2a0e0e", borderRadius: 8, border: "1px solid #5a2020" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#ff5c5c", fontFamily: "DM Mono,monospace", marginBottom: 4 }}>⚠ Caution</div>
          {stock.volume_spike > 2.5 && <div style={{ fontSize: 10, color: "#cc4444", fontFamily: "DM Mono,monospace" }}>• High volume spike — possible news event, avoid selling today</div>}
          {stock.rsi > 75 && <div style={{ fontSize: 10, color: "#cc4444", fontFamily: "DM Mono,monospace" }}>• RSI overbought — if selling call, wait for RSI to cool below 70</div>}
          {stock.rsi < 25 && <div style={{ fontSize: 10, color: "#cc4444", fontFamily: "DM Mono,monospace" }}>• RSI oversold — if selling put, wait for RSI to recover above 35</div>}
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]         = useState("premium");
  const [data, setData]         = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [filterScore, setFilterScore] = useState(0);
  const [filterCat, setFilterCat]     = useState("all");
  const [showDetail, setShowDetail]   = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  const loadResults = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${RESULTS_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      // Auto-select highest score
      if (json.results?.length > 0) {
        const sorted = [...json.results].sort((a,b) => calcPremiumScore(b) - calcPremiumScore(a));
        setSelected(sorted[0]);
      }
    } catch (e) {
      setError("No scan data yet. Run OptionScope Scanner from GitHub Actions.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadResults(); }, [loadResults]);
  useEffect(() => { const t = setInterval(loadResults, 5*60*1000); return () => clearInterval(t); }, [loadResults]);

  const allStocks = data?.results || [];
  const categories = ["all", ...new Set(allStocks.map(s => s.category).filter(Boolean))];

  const stocks = allStocks
    .map(s => ({ ...s, _score: calcPremiumScore(s) }))
    .filter(s => s._score >= filterScore)
    .filter(s => filterCat === "all" || s.category === filterCat)
    .sort((a, b) => b._score - a._score);

  const handleSelect = (stock) => { setSelected(stock); if (isMobile) setShowDetail(true); };

  // Top stats
  const sellNow   = stocks.filter(s => s._score >= 80).length;
  const avgIV     = stocks.length ? (stocks.reduce((a,s) => a + s.iv_rank, 0) / stocks.length).toFixed(0) : 0;
  const topPicks  = stocks.slice(0, 3).map(s => s.ticker).join(", ");

  return (
    <div style={{ minHeight: "100vh", background: "#040b14", color: "#ddeeff", fontFamily: "'Syne',sans-serif", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:#040b14} ::-webkit-scrollbar-thumb{background:#162030;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      {/* ── TOPBAR ── */}
      <div style={{ height: 52, background: "#050c18", borderBottom: "1px solid #0a1826", display: "flex", alignItems: "center", padding: "0 14px", gap: 10, flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, background: "linear-gradient(135deg,#0d4080,#00b894)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>⚡</div>
        {!isMobile && <span style={{ fontSize: 14, fontWeight: 900, letterSpacing: "-0.5px", background: "linear-gradient(90deg,#3b9eff,#00d4aa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>OptionScope</span>}

        {/* View tabs */}
        <div style={{ display: "flex", gap: 3, background: "#080f1c", borderRadius: 8, padding: 3, marginLeft: 4 }}>
          {[["premium","💰 Premium"], ["compass","🧭 Compass"]].map(([id, lbl]) => (
            <button key={id} onClick={() => setView(id)} style={{
              padding: isMobile ? "5px 10px" : "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
              fontSize: 11, fontWeight: 700, fontFamily: "'Syne',sans-serif",
              background: view === id ? "#1a3555" : "transparent",
              color: view === id ? "#3b9eff" : "#3a5060", transition: "all 0.15s",
            }}>{isMobile ? (id === "premium" ? "💰" : "🧭") : lbl}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        {/* Category filter */}
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ background: "#080f1c", border: "1px solid #0e1c28", borderRadius: 6, color: "#667788", padding: "4px 7px", fontSize: 11, fontFamily: "DM Mono,monospace", outline: "none", cursor: "pointer", maxWidth: isMobile ? 80 : 130 }}>
          {categories.map(c => <option key={c} value={c}>{c === "all" ? "All types" : CATEGORY_ICON[c] + " " + c.replace("_", " ")}</option>)}
        </select>

        {/* Score filter */}
        <select value={filterScore} onChange={e => setFilterScore(+e.target.value)} style={{ background: "#080f1c", border: "1px solid #0e1c28", borderRadius: 6, color: "#667788", padding: "4px 7px", fontSize: 11, fontFamily: "DM Mono,monospace", outline: "none", cursor: "pointer" }}>
          <option value={0}>All scores</option>
          <option value={60}>Score ≥ 60</option>
          <option value={80}>Score ≥ 80</option>
        </select>

        <button onClick={loadResults} style={{ padding: "5px 12px", background: "#0d3060", border: "none", borderRadius: 7, color: "#88bbee", fontSize: 11, fontWeight: 700, fontFamily: "'Syne',sans-serif", cursor: "pointer", flexShrink: 0 }}>↻</button>
      </div>

      {/* ── SUMMARY BAR ── */}
      {!loading && !error && data && (
        <div style={{ background: "#050c18", borderBottom: "1px solid #0a1826", padding: "6px 16px", display: "flex", gap: 20, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontFamily: "DM Mono,monospace" }}>
            <span style={{ color: "#3a5060" }}>SELL NOW </span>
            <span style={{ color: "#00d4aa", fontWeight: 700 }}>{sellNow} stocks</span>
          </span>
          <span style={{ fontSize: 11, fontFamily: "DM Mono,monospace" }}>
            <span style={{ color: "#3a5060" }}>AVG IV RANK </span>
            <span style={{ color: "#3b9eff", fontWeight: 700 }}>{avgIV}</span>
          </span>
          {!isMobile && topPicks && (
            <span style={{ fontSize: 11, fontFamily: "DM Mono,monospace" }}>
              <span style={{ color: "#3a5060" }}>TOP PICKS </span>
              <span style={{ color: "#f5a623", fontWeight: 700 }}>{topPicks}</span>
            </span>
          )}
          <span style={{ fontSize: 10, color: "#2e4055", fontFamily: "DM Mono,monospace", marginLeft: "auto" }}>
            {data.scanned_at ? `Scanned ${new Date(data.scanned_at).toLocaleString()}` : ""}
          </span>
        </div>
      )}

      {/* ── BODY ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>

        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#040b14", zIndex: 30, gap: 14 }}>
            <div style={{ width: 34, height: 34, border: "3px solid #0e1c28", borderTopColor: "#3b9eff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <div style={{ color: "#3a5060", fontFamily: "DM Mono,monospace", fontSize: 12 }}>Loading scan results…</div>
          </div>
        )}

        {!loading && error && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24 }}>
            <div style={{ fontSize: 40 }}>📡</div>
            <div style={{ color: "#3b9eff", fontFamily: "'Syne',sans-serif", fontSize: 16, fontWeight: 700 }}>No scan data yet</div>
            <div style={{ color: "#3a5060", fontFamily: "DM Mono,monospace", fontSize: 11, textAlign: "center", maxWidth: 300, lineHeight: 1.8 }}>
              GitHub Actions → OptionScope Scanner → Run workflow<br/>Results appear here automatically after scan completes.
            </div>
            <button onClick={loadResults} style={{ padding: "8px 20px", background: "#0d3060", border: "none", borderRadius: 8, color: "#3b9eff", fontSize: 12, fontWeight: 700, fontFamily: "'Syne',sans-serif", cursor: "pointer" }}>Try Again</button>
          </div>
        )}

        {/* Mobile detail overlay */}
        {!loading && !error && isMobile && showDetail && (
          <div style={{ position: "absolute", inset: 0, background: "#040b14", zIndex: 20, overflowY: "auto" }}>
            <DetailPanel stock={selected} onClose={() => setShowDetail(false)} isMobile={true} />
          </div>
        )}

        {/* PREMIUM VIEW */}
        {!loading && !error && view === "premium" && (
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
              <div style={{ fontSize: 10, color: "#3a5060", fontFamily: "DM Mono,monospace", marginBottom: 10 }}>
                {stocks.length} stocks · sorted by Premium Score
              </div>
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill,minmax(300px,1fr))", gap: 10 }}>
                {stocks.map((s, i) => (
                  <div key={s.ticker} style={{ animation: `fadeUp 0.3s ease ${i * 0.03}s both` }}>
                    <PremiumCard stock={s} isSelected={selected?.ticker === s.ticker} onClick={() => handleSelect(s)} />
                  </div>
                ))}
              </div>
            </div>
            {!isMobile && (
              <div style={{ width: 276, background: "#050c18", borderLeft: "1px solid #0a1826", overflowY: "auto", flexShrink: 0 }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            )}
          </div>
        )}

        {/* COMPASS VIEW */}
        {!loading && !error && view === "compass" && (
          <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
            <div style={{ flex: 1, padding: 14, overflowY: "auto" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#667788", textAlign: "center", marginBottom: 10, fontFamily: "'Syne',sans-serif" }}>Premium Opportunity Compass</div>
              <ResponsiveContainer width="100%" height={380}>
                <ScatterChart margin={{ top: 20, right: 20, bottom: 40, left: 10 }}>
                  <CartesianGrid stroke="#0a1826" strokeDasharray="4 4" />
                  <XAxis dataKey="risk_reversal" type="number" domain={[0,100]} stroke="#0e1c28"
                    tick={{ fill: "#3a5060", fontSize: 10, fontFamily: "DM Mono,monospace" }}
                    label={{ value: "Bullish ← Trend → Bearish", position: "insideBottom", offset: -24, fill: "#3a5060", fontSize: 10, fontFamily: "DM Mono,monospace" }} />
                  <YAxis dataKey="iv_rank" type="number" domain={[0,100]} stroke="#0e1c28"
                    tick={{ fill: "#3a5060", fontSize: 10, fontFamily: "DM Mono,monospace" }}
                    label={{ value: "IV Rank →", angle: -90, position: "insideLeft", fill: "#3a5060", fontSize: 10, fontFamily: "DM Mono,monospace" }} />
                  <ReferenceLine x={50} stroke="#0e1c28" strokeWidth={1.5} />
                  <ReferenceLine y={50} stroke="#0e1c28" strokeWidth={1.5} />
                  <Tooltip content={({ payload }) => {
                    if (!payload?.length) return null;
                    const d = payload[0].payload;
                    const sc = calcPremiumScore(d);
                    return (
                      <div style={{ background: "#080f1c", border: "1px solid #0e1c28", borderRadius: 8, padding: "10px 14px", fontFamily: "DM Mono,monospace" }}>
                        <div style={{ color: "#ddeeff", fontWeight: 700 }}>{d.ticker} · ${d.price}</div>
                        <div style={{ color: "#3a5060", fontSize: 11, marginTop: 4 }}>IV Rank: <span style={{ color: getScoreColor(sc) }}>{d.iv_rank}</span></div>
                        <div style={{ color: "#3a5060", fontSize: 11 }}>Score: <span style={{ color: getScoreColor(sc) }}>{sc}</span> · {getScoreLabel(sc)}</div>
                        <div style={{ color: "#3a5060", fontSize: 11 }}>{getSellType(d).type}</div>
                      </div>
                    );
                  }} />
                  <Scatter data={stocks} shape={(props) => {
                    const { cx, cy, payload } = props;
                    const sel = selected?.ticker === payload.ticker;
                    const sc  = calcPremiumScore(payload);
                    const c   = getScoreColor(sc);
                    return (
                      <g onClick={() => handleSelect(payload)} style={{ cursor: "pointer" }}>
                        <circle cx={cx} cy={cy} r={sel ? 20 : 13} fill={c} fillOpacity={0.12} />
                        <circle cx={cx} cy={cy} r={sel ? 10 : 6}  fill={c} fillOpacity={sel ? 1 : 0.75} />
                        <text x={cx} y={cy - 14} textAnchor="middle" fill="#a8bece" fontSize={10} fontFamily="DM Mono,monospace" fontWeight={600}>{payload.ticker}</text>
                      </g>
                    );
                  }} />
                </ScatterChart>
              </ResponsiveContainer>
              {/* Legend */}
              <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 8 }}>
                {[["≥80 Sell Now","#00d4aa"],["≥60 Good","#3b9eff"],["≥40 Fair","#f5a623"],["<40 Avoid","#ff5c5c"]].map(([lbl,c])=>(
                  <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />
                    <span style={{ fontSize: 10, color: c, fontFamily: "DM Mono,monospace", opacity: 0.8 }}>{lbl}</span>
                  </div>
                ))}
              </div>
            </div>
            {!isMobile ? (
              <div style={{ width: 276, background: "#050c18", borderLeft: "1px solid #0a1826", overflowY: "auto", flexShrink: 0 }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            ) : selected && (
              <div style={{ borderTop: "1px solid #0a1826", maxHeight: "40vh", overflowY: "auto" }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── STATUS ── */}
      <div style={{ height: 24, background: "#030910", borderTop: "1px solid #08141e", display: "flex", alignItems: "center", padding: "0 14px", gap: 16, flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: data ? "#00d4aa" : "#2e4055", fontFamily: "DM Mono,monospace" }}>
          {data ? `● ${data.total_results} stocks · auto-refresh 5min` : "○ Waiting"}
        </span>
        <span style={{ fontSize: 10, color: "#1e3040", fontFamily: "DM Mono,monospace" }}>yfinance · 15min delayed</span>
        <span style={{ fontSize: 10, color: "#1e3040", fontFamily: "DM Mono,monospace", marginLeft: "auto" }}>{new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
