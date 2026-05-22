import { useState, useEffect, useCallback } from "react";
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";

const RESULTS_URL = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/results.json` : "/results.json";

function calcPremiumScore(stock) {
  let score = 0;
  score += Math.min(50, stock.iv_rank * 0.5);
  score += Math.min(25, stock.adx * 0.6);
  score += (stock.rsi >= 30 && stock.rsi <= 75) ? 15 : 0;
  score += stock.volume_spike < 2.0 ? 10 : stock.volume_spike < 3.0 ? 5 : 0;
  return Math.round(Math.min(100, score));
}
function getScoreColor(s) {
  if (s >= 80) return "#00d4aa";
  if (s >= 60) return "#3b9eff";
  if (s >= 40) return "#f5a623";
  return "#ff5c5c";
}
function getScoreLabel(s) {
  if (s >= 80) return "SELL NOW";
  if (s >= 60) return "GOOD";
  if (s >= 40) return "FAIR";
  return "AVOID";
}
function getSellType(stock) {
  if (stock.trend === "bullish") return { type: "SELL PUT",      color: "#00d4aa", desc: "Stock trending up — sell below price" };
  if (stock.trend === "bearish") return { type: "SELL CALL",     color: "#ff8c42", desc: "Stock trending down — sell above price" };
  return                                 { type: "SELL STRANGLE", color: "#cc77ff", desc: "No clear trend — sell both sides" };
}

// ── STRIKE + PREMIUM ─────────────────────────────────────────────────────────
// Use real market data from scanner (not estimated)
function getRealStrike(stock) {
  return stock.suggest_strike || null;
}
function getRealPremium(stock) {
  if (!stock.suggest_premium_contract) return null;
  return {
    perContract: stock.suggest_premium_contract,
    perShare:    stock.suggest_premium,
    otmPct:      stock.suggest_otm_pct,
  };
}
// Fallback estimator only if scanner data missing
function estimatePremium(stock, strike, type) {
  if (!strike) return null;
  const iv    = stock.iv_current / 100;
  const price = stock.price;
  const dte   = stock.suggest_dte || (stock.iv_rank >= 75 ? 25 : stock.iv_rank >= 50 ? 37 : 52);
  const T     = dte / 365;
  const atmPremium   = price * iv * Math.sqrt(T) * 0.4;
  const distance     = Math.abs(price - strike) / price;
  const moneynessAdj = Math.exp(-distance * distance / (2 * iv * iv * T));
  const perShare     = atmPremium * moneynessAdj;
  return {
    perContract: Math.round(perShare * 100 * 100) / 100,
    perShare:    Math.round(perShare * 100) / 100,
    otmPct:      Math.round(distance * 1000) / 10,
  };
}

function getDTEadvice(ivRank) {
  if (ivRank >= 75) return { dte: "21–30 DTE", reason: "IV very high — shorter expiry, max decay" };
  if (ivRank >= 50) return { dte: "30–45 DTE", reason: "Good IV — standard theta zone" };
  return                   { dte: "45–60 DTE", reason: "Lower IV — longer expiry needed" };
}

const CATEGORY_ICON = {
  meme:"🔥", crypto:"🪙", nuclear_energy:"⚛️", ai_quantum:"🤖",
  ev_clean:"🚗", biotech:"💊", high_beta_tech:"📱", fintech:"🏦",
  leveraged_etfs:"📊", sp100_core:"📈", other:"◆",
};

// ── SCORE RING ────────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 56 }) {
  const color = getScoreColor(score);
  const label = getScoreLabel(score);
  const r = (size / 2) - 5;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1a2a3a" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
        <div style={{ fontSize:15, fontWeight:900, color, fontFamily:"DM Mono,monospace", lineHeight:1 }}>{score}</div>
        <div style={{ fontSize:8, color, fontFamily:"DM Mono,monospace" }}>{label}</div>
      </div>
    </div>
  );
}

// ── IV BAR ────────────────────────────────────────────────────────────────────
function IVBar({ value }) {
  const color = value >= 75 ? "#00d4aa" : value >= 50 ? "#3b9eff" : value >= 25 ? "#f5a623" : "#ff5c5c";
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
        <span style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>IV RANK</span>
        <span style={{ fontSize:12, fontWeight:700, color, fontFamily:"DM Mono,monospace" }}>{value.toFixed(1)}</span>
      </div>
      <div style={{ background:"#162030", borderRadius:3, height:6, width:"100%" }}>
        <div style={{ width:`${Math.min(value,100)}%`, height:"100%", background:color, borderRadius:3, transition:"width 1s ease" }} />
      </div>
    </div>
  );
}

// ── PREMIUM CARD ──────────────────────────────────────────────────────────────
function PremiumCard({ stock, isSelected, onClick }) {
  const score    = calcPremiumScore(stock);
  const scoreCol = getScoreColor(score);
  const sell     = getSellType(stock);
  const dte      = getDTEadvice(stock.iv_rank);
  const strike   = getRealStrike(stock);
  const premium  = getRealPremium(stock) || estimatePremium(stock, strike, sell.type);

  return (
    <div onClick={onClick} style={{
      background: isSelected ? "#0c1e34" : "#080f1c",
      border:`1px solid ${isSelected ? scoreCol : "#0e1c28"}`,
      borderRadius:14, padding:"14px 12px", cursor:"pointer",
      transition:"all 0.2s ease", width:"100%", minWidth:0, overflow:"hidden",
      boxShadow: isSelected ? `0 0 0 2px ${scoreCol}22` : "none",
    }}>

      {/* Row 1: ring + ticker + price + badge */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
        <ScoreRing score={score} />
        <div style={{ flex:1, minWidth:0, overflow:"hidden" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:4 }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:5, minWidth:0 }}>
              <span style={{ fontSize:20, fontWeight:900, color:"#fff", fontFamily:"'Syne',sans-serif", flexShrink:0 }}>{stock.ticker}</span>
              <span style={{ fontSize:13, fontWeight:700, color:"#aaccee", fontFamily:"DM Mono,monospace", flexShrink:0 }}>${stock.price.toFixed(2)}</span>
            </div>
            <span style={{ fontSize:10, fontWeight:800, color:sell.color, fontFamily:"DM Mono,monospace",
              background:sell.color+"18", border:`1px solid ${sell.color}44`, borderRadius:6,
              padding:"3px 6px", whiteSpace:"nowrap", flexShrink:0 }}>
              {sell.type}
            </span>
          </div>
          <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:3 }}>
            IV {stock.iv_current}% · ADX {stock.adx} · RSI {stock.rsi}
          </div>
        </div>
      </div>

      {/* IV Bar */}
      <IVBar value={stock.iv_rank} />

      {/* Strike + DTE row */}
      <div style={{ display:"flex", gap:6, marginTop:10 }}>
        <div style={{ flex:1, minWidth:0, padding:"8px 10px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40" }}>
          <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>
            {sell.type === "SELL PUT" ? "PUT STRIKE" : sell.type === "SELL CALL" ? "CALL STRIKE" : "STRANGLE"}
          </div>
          <div style={{ fontSize:16, fontWeight:700, color:sell.color, fontFamily:"DM Mono,monospace" }}>
            {strike ? `$${strike.toFixed(0)}` : "—"}
          </div>
          {premium && (
            <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:2 }}>
              ~{premium.otmPct}% OTM
            </div>
          )}
        </div>
        <div style={{ flex:1, minWidth:0, padding:"8px 10px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40" }}>
          <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>EST. PREMIUM</div>
          <div style={{ fontSize:16, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>
            {premium ? `$${premium.perContract}` : "—"}
          </div>
          <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:2 }}>
            per contract · {stock.suggest_dte ? `${stock.suggest_dte} DTE` : dte.dte}
          </div>
        </div>
      </div>

      {/* Safe zone */}
      <div style={{ marginTop:8, padding:"8px 10px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40" }}>
        <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:5 }}>
          SAFE ZONE THIS WEEK — keep strike outside
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:12, fontWeight:700, color:"#ff8c42", fontFamily:"DM Mono,monospace", flexShrink:0 }}>${stock.range_1w.low}</span>
          <div style={{ flex:1, height:4, background:"#162030", borderRadius:2, position:"relative", minWidth:0 }}>
            <div style={{ position:"absolute", left:"20%", right:"20%", top:0, height:"100%", background:"#00d4aa33", borderRadius:2 }} />
            <div style={{ position:"absolute", left:"50%", transform:"translateX(-50%)", top:-3, width:2, height:10, background:"#3b9eff", borderRadius:1 }} />
          </div>
          <span style={{ fontSize:12, fontWeight:700, color:"#ff8c42", fontFamily:"DM Mono,monospace", flexShrink:0 }}>${stock.range_1w.high}</span>
        </div>
        <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:4, textAlign:"center" }}>
          1 week · 1 std dev · ~68% probability
        </div>
      </div>

      {/* Footer */}
      <div style={{ marginTop:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>
          {stock.volume_spike > 1.8 && <span style={{ color:"#f5a623" }}>🔥 ×{stock.volume_spike} · </span>}
          <span style={{ color:scoreCol, fontWeight:700 }}>Score {score}/100</span>
        </div>
        <div style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace" }}>
          {stock.scanned_at ? new Date(stock.scanned_at).toLocaleTimeString() : "demo"}
        </div>
      </div>

    </div>
  );
}

// ── DETAIL PANEL ──────────────────────────────────────────────────────────────
function DetailPanel({ stock, isMobile, onClose }) {
  if (!stock) return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:12, color:"#2e4055" }}>
      <div style={{ fontSize:40 }}>⚡</div>
      <div style={{ fontFamily:"DM Mono,monospace", fontSize:12 }}>Select a stock</div>
    </div>
  );

  const score      = calcPremiumScore(stock);
  const sell       = getSellType(stock);
  const dte        = getDTEadvice(stock.iv_rank);
  const strike     = getRealStrike(stock);
  const premium    = getRealPremium(stock) || estimatePremium(stock, strike, sell.type);
  const scoreCol   = getScoreColor(score);
  const dailyTheta = premium ? (premium.perContract / (stock.suggest_dte || 35)) : 0;

  return (
    <div style={{ padding:"18px 14px", overflowY:"auto", height:"100%" }}>

      {isMobile && (
        <button onClick={onClose} style={{ background:"#0a1520", border:"1px solid #162030", borderRadius:6, color:"#667788", padding:"6px 14px", fontSize:12, cursor:"pointer", fontFamily:"DM Mono,monospace", marginBottom:14 }}>← Back</button>
      )}

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:16 }}>
        <ScoreRing score={score} size={68} />
        <div>
          <div style={{ fontSize:28, fontWeight:900, color:"#ddeeff", fontFamily:"'Syne',sans-serif", letterSpacing:"-1px" }}>{stock.ticker}</div>
          <div style={{ fontSize:18, fontWeight:700, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>${stock.price.toFixed(2)}</div>
          <div style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace" }}>{CATEGORY_ICON[stock.category]} {stock.category?.replace("_"," ")}</div>
        </div>
      </div>

      {/* Main action badge */}
      <div style={{ padding:"14px", background:sell.color+"12", borderRadius:10, border:`1px solid ${sell.color}33`, marginBottom:12, textAlign:"center" }}>
        <div style={{ fontSize:22, fontWeight:900, color:sell.color, fontFamily:"DM Mono,monospace" }}>{sell.type}</div>
        <div style={{ fontSize:12, color:sell.color+"aa", fontFamily:"DM Mono,monospace", marginTop:4 }}>{sell.desc}</div>
      </div>

      {/* Strike + DTE + Premium */}
      <div style={{ display:"flex", gap:8, marginBottom:10 }}>
        <div style={{ flex:1, minWidth:0, padding:"12px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40", textAlign:"center" }}>
          <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>
            {sell.type === "SELL PUT" ? "PUT STRIKE" : "CALL STRIKE"}
          </div>
          <div style={{ fontSize:22, fontWeight:800, color:sell.color, fontFamily:"DM Mono,monospace" }}>
            {strike ? `$${strike.toFixed(0)}` : "—"}
          </div>
          <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:3 }}>
            {premium ? `~${premium.otmPct}% OTM` : "~0.30 delta"}
          </div>
        </div>
        <div style={{ flex:1, minWidth:0, padding:"12px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e", textAlign:"center" }}>
          <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>EST. PREMIUM</div>
          <div style={{ fontSize:22, fontWeight:800, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>
            {premium ? `$${premium.perContract}` : "—"}
          </div>
          <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:3 }}>
            per contract · {dte.dte}
          </div>
        </div>
      </div>

      {/* IV Rank */}
      <div style={{ marginBottom:10 }}>
        <IVBar value={stock.iv_rank} />
        <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:4 }}>
          Current IV: {stock.iv_current}% · Higher = more premium collected
        </div>
      </div>

      {/* Expected move ranges */}
      <div style={{ padding:"10px 12px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40", marginBottom:8 }}>
        <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:6 }}>EXPECTED MOVE — keep strike outside</div>
        {[["1 Day", stock.range_1d], ["1 Week", stock.range_1w], ["1 Month", stock.range_1m]].map(([lbl, r]) => (
          <div key={lbl} style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
            <span style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>{lbl}</span>
            <span style={{ fontSize:12, fontWeight:600, color:"#ccddee", fontFamily:"DM Mono,monospace" }}>${r.low} – ${r.high}</span>
          </div>
        ))}
      </div>

      {/* Theta */}
      <div style={{ padding:"10px 12px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e", marginBottom:8 }}>
        <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>ESTIMATED DAILY THETA DECAY</div>
        <div style={{ fontSize:20, fontWeight:800, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>~${dailyTheta.toFixed(2)} / contract</div>
        <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:3 }}>
          Option loses this value each day — works in your favour as seller
        </div>
      </div>

      {/* ADX / RSI / VOL pills */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
        {[
          ["ADX",   stock.adx,         stock.adx>=25?"#00d4aa":"#f5a623",  stock.adx>=25?"Strong":"Weak"],
          ["RSI",   stock.rsi,         stock.rsi>70||stock.rsi<30?"#ff5c5c":"#00d4aa", stock.rsi>70?"Overbought":stock.rsi<30?"Oversold":"Safe"],
          ["VOL×",  stock.volume_spike, stock.volume_spike>2?"#ff5c5c":"#00d4aa", stock.volume_spike>2?"Risk!":"Normal"],
        ].map(([lbl, val, col, hint]) => (
          <div key={lbl} style={{ padding:"8px 4px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40", textAlign:"center" }}>
            <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>{lbl}</div>
            <div style={{ fontSize:15, fontWeight:700, color:col, fontFamily:"DM Mono,monospace" }}>{typeof val==="number"?val.toFixed(1):val}</div>
            <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>{hint}</div>
          </div>
        ))}
      </div>

      {/* Warnings */}
      {(stock.volume_spike > 2.5 || stock.rsi > 75 || stock.rsi < 25) && (
        <div style={{ marginTop:10, padding:"10px 12px", background:"#2a0e0e", borderRadius:8, border:"1px solid #5a2020" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#ff5c5c", fontFamily:"DM Mono,monospace", marginBottom:4 }}>⚠ Caution</div>
          {stock.volume_spike > 2.5 && <div style={{ fontSize:10, color:"#cc4444", fontFamily:"DM Mono,monospace" }}>• High volume — possible news, avoid selling today</div>}
          {stock.rsi > 75 && <div style={{ fontSize:10, color:"#cc4444", fontFamily:"DM Mono,monospace" }}>• RSI overbought — wait for RSI to cool below 70</div>}
          {stock.rsi < 25 && <div style={{ fontSize:10, color:"#cc4444", fontFamily:"DM Mono,monospace" }}>• RSI oversold — wait for RSI to recover above 35</div>}
        </div>
      )}

    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]               = useState("premium");
  const [data, setData]               = useState(null);
  const [selected, setSelected]       = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [filterScore, setFilterScore] = useState(0);
  const [filterCat, setFilterCat]     = useState("all");
  const [showDetail, setShowDetail]   = useState(false);
  const [isMobile, setIsMobile]       = useState(window.innerWidth < 768);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  const loadResults = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${RESULTS_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      if (json.results?.length > 0) {
        const sorted = [...json.results].sort((a,b) => calcPremiumScore(b) - calcPremiumScore(a));
        setSelected(sorted[0]);
      }
    } catch (e) {
      setError("No scan data yet.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadResults(); }, [loadResults]);
  useEffect(() => { const t = setInterval(loadResults, 5*60*1000); return () => clearInterval(t); }, [loadResults]);

  const allStocks  = data?.results || [];
  const categories = ["all", ...new Set(allStocks.map(s => s.category).filter(Boolean))];
  const stocks     = allStocks
    .map(s => ({ ...s, _score: calcPremiumScore(s) }))
    .filter(s => s._score >= filterScore)
    .filter(s => filterCat === "all" || s.category === filterCat)
    .sort((a,b) => b._score - a._score);

  const handleSelect = (stock) => { setSelected(stock); if (isMobile) setShowDetail(true); };
  const sellNow  = stocks.filter(s => s._score >= 80).length;
  const avgIV    = stocks.length ? (stocks.reduce((a,s) => a + s.iv_rank, 0) / stocks.length).toFixed(0) : 0;
  const topPicks = stocks.slice(0,3).map(s => s.ticker).join(", ");

  return (
    <div style={{ minHeight:"100vh", background:"#040b14", color:"#ddeeff", fontFamily:"'Syne',sans-serif", display:"flex", flexDirection:"column", overflow:"hidden", maxWidth:"100vw" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{overflow-x:hidden;max-width:100vw;background:#040b14}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:#040b14} ::-webkit-scrollbar-thumb{background:#162030;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>

      {/* TOPBAR */}
      <div style={{ height:52, background:"#050c18", borderBottom:"1px solid #0a1826", display:"flex", alignItems:"center", padding:"0 10px", gap:8, flexShrink:0, overflow:"hidden" }}>
        <div style={{ width:28, height:28, background:"linear-gradient(135deg,#0d4080,#00b894)", borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, flexShrink:0 }}>⚡</div>
        {!isMobile && <span style={{ fontSize:14, fontWeight:900, letterSpacing:"-0.5px", background:"linear-gradient(90deg,#3b9eff,#00d4aa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>OptionScope</span>}
        <div style={{ display:"flex", gap:3, background:"#080f1c", borderRadius:8, padding:3 }}>
          {[["premium","💰 Premium"],["compass","🧭 Compass"]].map(([id,lbl]) => (
            <button key={id} onClick={() => setView(id)} style={{
              padding:isMobile?"5px 10px":"5px 14px", borderRadius:6, border:"none", cursor:"pointer",
              fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif",
              background:view===id?"#1a3555":"transparent", color:view===id?"#3b9eff":"#3a5060",
            }}>{isMobile?(id==="premium"?"💰":"🧭"):lbl}</button>
          ))}
        </div>
        <div style={{ flex:1 }} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ background:"#080f1c", border:"1px solid #0e1c28", borderRadius:6, color:"#667788", padding:"4px 6px", fontSize:10, fontFamily:"DM Mono,monospace", outline:"none", cursor:"pointer", maxWidth:90 }}>
          {categories.map(c => <option key={c} value={c}>{c==="all"?"All types":CATEGORY_ICON[c]+" "+c.replace("_"," ")}</option>)}
        </select>
        <select value={filterScore} onChange={e => setFilterScore(+e.target.value)} style={{ background:"#080f1c", border:"1px solid #0e1c28", borderRadius:6, color:"#667788", padding:"4px 6px", fontSize:10, fontFamily:"DM Mono,monospace", outline:"none", cursor:"pointer" }}>
          <option value={0}>All scores</option>
          <option value={60}>≥ 60</option>
          <option value={80}>≥ 80</option>
        </select>
        <button onClick={loadResults} style={{ padding:"5px 10px", background:"#0d3060", border:"none", borderRadius:7, color:"#88bbee", fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif", cursor:"pointer", flexShrink:0 }}>↻</button>
      </div>

      {/* SUMMARY BAR */}
      {!loading && !error && data && (
        <div style={{ background:"#050c18", borderBottom:"1px solid #0a1826", padding:"6px 12px", display:"flex", gap:16, alignItems:"center", flexShrink:0, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
            <span style={{ color:"#8aaabb" }}>SELL NOW </span>
            <span style={{ color:"#00d4aa", fontWeight:700 }}>{sellNow} stocks</span>
          </span>
          <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
            <span style={{ color:"#8aaabb" }}>AVG IV RANK </span>
            <span style={{ color:"#3b9eff", fontWeight:700 }}>{avgIV}</span>
          </span>
          {!isMobile && topPicks && (
            <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
              <span style={{ color:"#8aaabb" }}>TOP PICKS </span>
              <span style={{ color:"#f5a623", fontWeight:700 }}>{topPicks}</span>
            </span>
          )}
          <span style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace", marginLeft:"auto" }}>
            {data.scanned_at ? `Scanned ${new Date(data.scanned_at).toLocaleString()}` : ""}
          </span>
        </div>
      )}

      {/* BODY */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", position:"relative" }}>

        {/* Loading */}
        {loading && (
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#040b14", zIndex:30, gap:14 }}>
            <div style={{ width:34, height:34, border:"3px solid #0e1c28", borderTopColor:"#3b9eff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
            <div style={{ color:"#8aaabb", fontFamily:"DM Mono,monospace", fontSize:12 }}>Loading scan results…</div>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, padding:24 }}>
            <div style={{ fontSize:40 }}>📡</div>
            <div style={{ color:"#3b9eff", fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:700 }}>No scan data yet</div>
            <div style={{ color:"#8aaabb", fontFamily:"DM Mono,monospace", fontSize:11, textAlign:"center", maxWidth:300, lineHeight:1.8 }}>
              GitHub Actions → OptionScope Scanner → Run workflow
            </div>
            <button onClick={loadResults} style={{ padding:"8px 20px", background:"#0d3060", border:"none", borderRadius:8, color:"#3b9eff", fontSize:12, fontWeight:700, fontFamily:"'Syne',sans-serif", cursor:"pointer" }}>Try Again</button>
          </div>
        )}

        {/* Mobile detail overlay */}
        {!loading && !error && isMobile && showDetail && (
          <div style={{ position:"absolute", inset:0, background:"#040b14", zIndex:20, overflowY:"auto" }}>
            <DetailPanel stock={selected} onClose={() => setShowDetail(false)} isMobile={true} />
          </div>
        )}

        {/* PREMIUM VIEW */}
        {!loading && !error && view === "premium" && (
          <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
            <div style={{ flex:1, overflowY:"auto", overflowX:"hidden", padding:"12px 10px" }}>
              <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginBottom:10 }}>
                {stocks.length} stocks · sorted by Premium Score
              </div>
              <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(300px,1fr))", gap:10, width:"100%" }}>
                {stocks.map((s,i) => (
                  <div key={s.ticker} style={{ animation:`fadeUp 0.3s ease ${i*0.03}s both`, minWidth:0 }}>
                    <PremiumCard stock={s} isSelected={selected?.ticker===s.ticker} onClick={() => handleSelect(s)} />
                  </div>
                ))}
              </div>
            </div>
            {!isMobile && (
              <div style={{ width:276, background:"#050c18", borderLeft:"1px solid #0a1826", overflowY:"auto", flexShrink:0 }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            )}
          </div>
        )}

        {/* COMPASS VIEW */}
        {!loading && !error && view === "compass" && (
          <div style={{ flex:1, display:"flex", flexDirection:isMobile?"column":"row", overflow:"hidden" }}>
            <div style={{ flex:1, padding:14, overflowY:"auto" }}>
              <div style={{ fontSize:13, fontWeight:700, color:"#667788", textAlign:"center", marginBottom:10, fontFamily:"'Syne',sans-serif" }}>Premium Opportunity Compass</div>
              <ResponsiveContainer width="100%" height={360}>
                <ScatterChart margin={{ top:20, right:20, bottom:40, left:10 }}>
                  <CartesianGrid stroke="#0a1826" strokeDasharray="4 4" />
                  <XAxis dataKey="risk_reversal" type="number" domain={[0,100]} stroke="#0e1c28"
                    tick={{ fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }}
                    label={{ value:"Bullish ← Trend → Bearish", position:"insideBottom", offset:-24, fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }} />
                  <YAxis dataKey="iv_rank" type="number" domain={[0,100]} stroke="#0e1c28"
                    tick={{ fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }}
                    label={{ value:"IV Rank", angle:-90, position:"insideLeft", fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }} />
                  <ReferenceLine x={50} stroke="#0e1c28" strokeWidth={1.5} />
                  <ReferenceLine y={50} stroke="#0e1c28" strokeWidth={1.5} />
                  <Tooltip content={({ payload }) => {
                    if (!payload?.length) return null;
                    const d = payload[0].payload;
                    const sc = calcPremiumScore(d);
                    return (
                      <div style={{ background:"#080f1c", border:"1px solid #0e1c28", borderRadius:8, padding:"10px 14px", fontFamily:"DM Mono,monospace" }}>
                        <div style={{ color:"#ddeeff", fontWeight:700 }}>{d.ticker} · ${d.price}</div>
                        <div style={{ color:"#3a5060", fontSize:11, marginTop:4 }}>IV Rank: <span style={{ color:getScoreColor(sc) }}>{d.iv_rank}</span></div>
                        <div style={{ color:"#3a5060", fontSize:11 }}>Score: <span style={{ color:getScoreColor(sc) }}>{sc}</span> · {getScoreLabel(sc)}</div>
                      </div>
                    );
                  }} />
                  <Scatter data={stocks} shape={(props) => {
                    const { cx, cy, payload } = props;
                    const sel = selected?.ticker === payload.ticker;
                    const sc  = calcPremiumScore(payload);
                    const c   = getScoreColor(sc);
                    return (
                      <g onClick={() => handleSelect(payload)} style={{ cursor:"pointer" }}>
                        <circle cx={cx} cy={cy} r={sel?20:12} fill={c} fillOpacity={0.12} />
                        <circle cx={cx} cy={cy} r={sel?10:6}  fill={c} fillOpacity={sel?1:0.75} />
                        <text x={cx} y={cy-14} textAnchor="middle" fill="#a8bece" fontSize={10} fontFamily="DM Mono,monospace" fontWeight={600}>{payload.ticker}</text>
                      </g>
                    );
                  }} />
                </ScatterChart>
              </ResponsiveContainer>
              <div style={{ display:"flex", justifyContent:"center", gap:14, marginTop:8, flexWrap:"wrap" }}>
                {[["≥80 Sell Now","#00d4aa"],["≥60 Good","#3b9eff"],["≥40 Fair","#f5a623"],["<40 Avoid","#ff5c5c"]].map(([lbl,c])=>(
                  <div key={lbl} style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background:c }} />
                    <span style={{ fontSize:10, color:c, fontFamily:"DM Mono,monospace" }}>{lbl}</span>
                  </div>
                ))}
              </div>
            </div>
            {!isMobile ? (
              <div style={{ width:276, background:"#050c18", borderLeft:"1px solid #0a1826", overflowY:"auto", flexShrink:0 }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            ) : selected && (
              <div style={{ borderTop:"1px solid #0a1826", maxHeight:"40vh", overflowY:"auto" }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            )}
          </div>
        )}

      </div>

      {/* STATUS BAR */}
      <div style={{ height:24, background:"#030910", borderTop:"1px solid #08141e", display:"flex", alignItems:"center", padding:"0 14px", gap:16, flexShrink:0 }}>
        <span style={{ fontSize:10, color:data?"#00d4aa":"#2e4055", fontFamily:"DM Mono,monospace" }}>
          {data ? `● ${data.total_results} stocks · auto-refresh 5min` : "○ Waiting"}
        </span>
        <span style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace", marginLeft:"auto" }}>{new Date().toLocaleTimeString()}</span>
      </div>

    </div>
  );
}
