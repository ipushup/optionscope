import { useState, useEffect, useCallback } from "react";
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, BarChart, Bar } from "recharts";

const RESULTS_URL = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/results.json` : "/results.json";

// ── HELPERS ───────────────────────────────────────────────────────────────────
function calcPremiumScore(stock) {
  let score = 0;
  score += Math.min(50, stock.iv_rank * 0.5);
  score += Math.min(25, stock.adx * 0.6);
  score += (stock.rsi >= 30 && stock.rsi <= 75) ? 15 : 0;
  score += stock.volume_spike < 2.0 ? 10 : stock.volume_spike < 3.0 ? 5 : 0;
  return Math.round(Math.min(100, score));
}
function getScoreColor(s) {
  if (s >= 80) return "#00d4aa"; if (s >= 60) return "#3b9eff";
  if (s >= 40) return "#f5a623"; return "#ff5c5c";
}
function getScoreLabel(s) {
  if (s >= 80) return "SELL NOW"; if (s >= 60) return "GOOD";
  if (s >= 40) return "FAIR"; return "AVOID";
}
function getSellType(stock) {
  if (stock.trend === "bullish") return { type:"SELL PUT",      color:"#00d4aa", desc:"Stock trending up — sell below price" };
  if (stock.trend === "bearish") return { type:"SELL CALL",     color:"#ff8c42", desc:"Stock trending down — sell above price" };
  return                                 { type:"SELL STRANGLE", color:"#cc77ff", desc:"No clear trend — sell both sides" };
}
function getRealStrike(stock) { return stock.suggest_strike || null; }
function getRealPremium(stock) {
  if (!stock.suggest_premium_contract) return null;
  return { perContract: stock.suggest_premium_contract, perShare: stock.suggest_premium, otmPct: stock.suggest_otm_pct };
}

const SIGNAL_CONFIG = {
  STRONG_BULL: { label:"⚡ Strong Bull",  color:"#00d4aa", bg:"#0a3d2e", desc:"↑Price + Call Vol > OI + filled @Ask" },
  BULL:        { label:"▲ Bullish",       color:"#00d4aa", bg:"#0a2e20", desc:"↑Price + unusual call activity" },
  MILD_BULL:   { label:"↗ Mild Bull",     color:"#3b9eff", bg:"#0a1f3d", desc:"Uptrend, normal volume" },
  STRONG_BEAR: { label:"⚡ Strong Bear",  color:"#ff5c5c", bg:"#3d0a0a", desc:"↓Price + Put Vol > OI + filled @Ask" },
  BEAR:        { label:"▼ Bearish",       color:"#ff8c42", bg:"#2e1a0a", desc:"↓Price + unusual put activity" },
  MILD_BEAR:   { label:"↘ Mild Bear",     color:"#ff8c42", bg:"#2e1a0a", desc:"Downtrend, normal volume" },
  VOLATILE:    { label:"⚡ Volatile",     color:"#f5a623", bg:"#2e2a0a", desc:"High vol both sides — event play" },
  NEUTRAL:     { label:"◆ Neutral",       color:"#667788", bg:"#14222e", desc:"No clear signal" },
};

const CATEGORY_ICON = {
  meme:"🔥", crypto:"🪙", nuclear_energy:"⚛️", ai_quantum:"🤖",
  ev_clean:"🚗", biotech:"💊", high_beta_tech:"📱", fintech:"🏦",
  leveraged_etfs:"📊", sp100_core:"📈", other:"◆",
};

// ── SCORE RING ────────────────────────────────────────────────────────────────
function ScoreRing({ score, size=56 }) {
  const color = getScoreColor(score);
  const r = (size/2)-5, circ = 2*Math.PI*r, dash = (score/100)*circ;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1a2a3a" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
        <div style={{ fontSize:15, fontWeight:900, color, fontFamily:"DM Mono,monospace", lineHeight:1 }}>{score}</div>
        <div style={{ fontSize:8, color, fontFamily:"DM Mono,monospace" }}>{getScoreLabel(score)}</div>
      </div>
    </div>
  );
}

function IVBar({ value }) {
  const color = value>=75?"#00d4aa":value>=50?"#3b9eff":value>=25?"#f5a623":"#ff5c5c";
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
  const strike   = getRealStrike(stock);
  const premium  = getRealPremium(stock);
  const sig      = SIGNAL_CONFIG[stock.signal_matrix] || SIGNAL_CONFIG.NEUTRAL;

  return (
    <div onClick={onClick} style={{
      background:isSelected?"#0c1e34":"#080f1c",
      border:`1px solid ${isSelected?scoreCol:"#0e1c28"}`,
      borderRadius:14, padding:"14px 12px", cursor:"pointer",
      transition:"all 0.2s ease", width:"100%", minWidth:0, overflow:"hidden",
      boxShadow:isSelected?`0 0 0 2px ${scoreCol}22`:"none",
    }}>
      {/* Row 1 */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
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

      {/* Signal matrix badge */}
      <div style={{ marginBottom:8, padding:"5px 10px", background:sig.bg, borderRadius:6, border:`1px solid ${sig.color}33`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:11, fontWeight:700, color:sig.color, fontFamily:"DM Mono,monospace" }}>{sig.label}</span>
        <div style={{ display:"flex", gap:8 }}>
          {stock.vol_oi_anomaly && <span style={{ fontSize:10, color:"#f5a623", fontFamily:"DM Mono,monospace" }}>⚡ Vol&gt;OI</span>}
          {stock.pc_ratio && <span style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>P/C {stock.pc_ratio}</span>}
        </div>
      </div>

      <IVBar value={stock.iv_rank} />

      {/* Strike + Premium */}
      <div style={{ display:"flex", gap:6, marginTop:10 }}>
        <div style={{ flex:1, minWidth:0, padding:"8px 10px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40" }}>
          <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>
            {sell.type==="SELL PUT"?"PUT STRIKE":sell.type==="SELL CALL"?"CALL STRIKE":"STRANGLE"}
          </div>
          <div style={{ fontSize:16, fontWeight:700, color:sell.color, fontFamily:"DM Mono,monospace" }}>
            {strike ? `$${strike}` : "—"}
          </div>
          <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:2 }}>
            {premium ? `~${premium.otmPct}% OTM` : ""}
          </div>
        </div>
        <div style={{ flex:1, minWidth:0, padding:"8px 10px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e" }}>
          <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>REAL PREMIUM</div>
          <div style={{ fontSize:16, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>
            {premium ? `$${premium.perContract}` : "—"}
          </div>
          <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:2 }}>
            {stock.suggest_expiry
              ? `Exp ${new Date(stock.suggest_expiry).toLocaleDateString('en-US',{month:'short',day:'numeric'})} · ${stock.suggest_dte||35} DTE`
              : `${stock.suggest_dte||35} DTE`}
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

      {/* OI walls + spread summary */}
      {(stock.call_wall || stock.put_wall || stock.spread?.net_contract) && (
        <div style={{ marginTop:8, display:"flex", gap:6 }}>
          {stock.put_wall && (
            <div style={{ flex:1, padding:"6px 8px", background:"#0a1828", borderRadius:6, border:"1px solid #1a2e40" }}>
              <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>PUT WALL</div>
              <div style={{ fontSize:13, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>${stock.put_wall}</div>
            </div>
          )}
          {stock.max_pain && (
            <div style={{ flex:1, padding:"6px 8px", background:"#0a1828", borderRadius:6, border:"1px solid #1a2e40", textAlign:"center" }}>
              <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>MAX PAIN</div>
              <div style={{ fontSize:13, fontWeight:700, color:"#f5a623", fontFamily:"DM Mono,monospace" }}>${stock.max_pain}</div>
            </div>
          )}
          {stock.spread?.net_contract && (
            <div style={{ flex:1, padding:"6px 8px", background:"#071510", borderRadius:6, border:"1px solid #0e2e1e", textAlign:"right" }}>
              <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>SPREAD NET</div>
              <div style={{ fontSize:13, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>${stock.spread.net_contract}</div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop:8, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>
          {stock.volume_spike>1.8 && <span style={{ color:"#f5a623" }}>🔥 ×{stock.volume_spike} · </span>}
          <span style={{ color:scoreCol, fontWeight:700 }}>Score {score}/100</span>
        </div>
        <div style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace" }}>
          {stock.scanned_at ? new Date(stock.scanned_at).toLocaleTimeString() : "demo"}
        </div>
      </div>
    </div>
  );
}

// ── DETAIL PAGE ───────────────────────────────────────────────────────────────
function DetailPage({ stock, onClose }) {
  const [tab, setTab] = useState("signal");
  const score   = calcPremiumScore(stock);
  const sell    = getSellType(stock);
  const strike  = getRealStrike(stock);
  const premium = getRealPremium(stock);
  const sig     = SIGNAL_CONFIG[stock.signal_matrix] || SIGNAL_CONFIG.NEUTRAL;
  const scoreCol = getScoreColor(score);
  const dailyTheta = premium ? (premium.perContract / (stock.suggest_dte || 35)) : 0;

  const tabs = [
    { id:"signal",  label:"Signal" },
    { id:"spread",  label:"Spread" },
    { id:"voloi",   label:"Vol/OI" },
    { id:"maxpain", label:"Max Pain" },
  ];

  return (
    <div style={{ position:"fixed", inset:0, background:"#040b14", zIndex:50, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Header */}
      <div style={{
        background:"#050c18",
        borderBottom:"1px solid #0a1826",
        flexShrink:0,
        paddingTop:"env(safe-area-inset-top, 44px)",
      }}>
        <div style={{ padding:"12px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
            <button onClick={onClose} style={{ background:"#0a1520", border:"1px solid #162030", borderRadius:6, color:"#8aaabb", padding:"6px 12px", fontSize:12, cursor:"pointer", fontFamily:"DM Mono,monospace", flexShrink:0 }}>← Back</button>
            <div style={{ display:"flex", alignItems:"center", gap:10, flex:1, minWidth:0 }}>
              <ScoreRing score={score} size={48} />
              <div style={{ minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"baseline", gap:8 }}>
                  <span style={{ fontSize:24, fontWeight:900, color:"#fff", fontFamily:"'Syne',sans-serif" }}>{stock.ticker}</span>
                  <span style={{ fontSize:16, color:"#aaccee", fontFamily:"DM Mono,monospace" }}>${stock.price.toFixed(2)}</span>
                </div>
                <div style={{ fontSize:11, padding:"2px 8px", borderRadius:12, background:sig.bg, color:sig.color, fontFamily:"DM Mono,monospace", display:"inline-block", marginTop:2 }}>{sig.label}</div>
              </div>
            </div>
            <div style={{ textAlign:"right", flexShrink:0 }}>
              <div style={{ fontSize:11, fontWeight:800, color:sell.color, background:sell.color+"18", border:`1px solid ${sell.color}44`, borderRadius:6, padding:"4px 8px", fontFamily:"DM Mono,monospace" }}>{sell.type}</div>
              {premium && <div style={{ fontSize:14, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace", marginTop:4 }}>${premium.perContract}</div>}
            </div>
          </div>
          {/* Tab bar */}
          <div style={{ display:"flex", gap:4, background:"#080f1c", borderRadius:8, padding:3 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                flex:1, padding:"6px 4px", borderRadius:6, border:"none", cursor:"pointer",
                fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif",
                background:tab===t.id?"#1a3555":"transparent",
                color:tab===t.id?"#3b9eff":"#3a5060",
              }}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex:1, overflowY:"auto", padding:"14px" }}>

        {/* ── TAB 1: SIGNAL MATRIX ── */}
        {tab === "signal" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

            {/* Main signal */}
            <div style={{ padding:"16px", background:sig.bg, borderRadius:10, border:`1px solid ${sig.color}44`, textAlign:"center" }}>
              <div style={{ fontSize:24, fontWeight:900, color:sig.color, fontFamily:"DM Mono,monospace" }}>{sig.label}</div>
              <div style={{ fontSize:12, color:sig.color+"aa", fontFamily:"DM Mono,monospace", marginTop:6 }}>{sig.desc}</div>
            </div>

            {/* Signal matrix grid */}
            <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:10, letterSpacing:"0.1em" }}>SIGNAL MATRIX — CURRENT STATE</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[
                  ["Price Trend", stock.trend?.toUpperCase(), stock.trend==="bullish"?"#00d4aa":stock.trend==="bearish"?"#ff5c5c":"#8aaabb"],
                  ["ADX Strength", stock.adx>=30?"STRONG":"WEAK", stock.adx>=30?"#00d4aa":"#f5a623"],
                  ["Vol Anomaly", stock.vol_oi_anomaly?"DETECTED":"NORMAL", stock.vol_oi_anomaly?"#f5a623":"#8aaabb"],
                  ["Anomaly Type", stock.anomaly_type?.replace("_"," ").toUpperCase()||"—", stock.anomaly_type==="call_heavy"?"#00d4aa":stock.anomaly_type==="put_heavy"?"#ff5c5c":"#8aaabb"],
                  ["Fill Side", stock.fill_side?.toUpperCase()||"—", stock.fill_side==="ask"?"#f5a623":stock.fill_side==="bid"?"#8aaabb":"#667788"],
                  ["P/C Ratio", stock.pc_ratio||"—", stock.pc_ratio>1.2?"#ff8c42":stock.pc_ratio<0.8?"#00d4aa":"#8aaabb"],
                  ["RSI", stock.rsi, stock.rsi>70?"#ff5c5c":stock.rsi<30?"#00d4aa":"#8aaabb"],
                  ["IV Rank", stock.iv_rank, stock.iv_rank>=75?"#00d4aa":stock.iv_rank>=50?"#3b9eff":"#f5a623"],
                ].map(([label, value, color]) => (
                  <div key={label} style={{ padding:"8px 10px", background:"#060e1a", borderRadius:8, border:"1px solid #162030" }}>
                    <div style={{ fontSize:9, color:"#445566", fontFamily:"DM Mono,monospace", marginBottom:3 }}>{label}</div>
                    <div style={{ fontSize:14, fontWeight:700, color, fontFamily:"DM Mono,monospace" }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Trade setup */}
            <div style={{ padding:"12px", background:"#060e1a", borderRadius:10, border:"1px solid #162030" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:10, letterSpacing:"0.1em" }}>TRADE SETUP</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                <div style={{ padding:"10px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40", textAlign:"center" }}>
                  <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>STRIKE</div>
                  <div style={{ fontSize:20, fontWeight:800, color:sell.color, fontFamily:"DM Mono,monospace" }}>${strike||"—"}</div>
                  <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>{premium?.otmPct}% OTM</div>
                </div>
                <div style={{ padding:"10px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e", textAlign:"center" }}>
                  <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>PREMIUM</div>
                  <div style={{ fontSize:20, fontWeight:800, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>${premium?.perContract||"—"}</div>
                  <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>
                    {stock.suggest_expiry
                      ? `Exp ${new Date(stock.suggest_expiry).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} · ${stock.suggest_dte} DTE`
                      : `${stock.suggest_dte} DTE`}
                  </div>
                </div>
              </div>
              <div style={{ marginTop:8, padding:"10px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e" }}>
                <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>DAILY THETA DECAY</div>
                <div style={{ fontSize:18, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>~${dailyTheta.toFixed(2)} / day</div>
                <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:2 }}>Close at 50% profit (~${(premium?.perContract/2||0).toFixed(0)}) after ~{Math.round((stock.suggest_dte||35)/2)} days</div>
              </div>
            </div>

            {/* Expected ranges */}
            <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:8, letterSpacing:"0.1em" }}>EXPECTED MOVE — keep strike outside</div>
              {[["1 Day",stock.range_1d],["1 Week",stock.range_1w],["1 Month",stock.range_1m]].map(([lbl,r])=>(
                <div key={lbl} style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>{lbl}</span>
                  <span style={{ fontSize:12, fontWeight:600, color:"#ccddee", fontFamily:"DM Mono,monospace" }}>${r.low} – ${r.high}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── TAB 2: SPREAD ANALYSIS ── */}
        {tab === "spread" && (() => {
          const sp = stock.spread;
          const sell = getSellType(stock);
          const strike = stock.suggest_strike;
          const sellPremium = stock.suggest_premium_contract;
          const isBull = stock.trend !== "bearish";

          if (!sp || !sp.protect_strike) return (
            <div style={{ padding:24, textAlign:"center", color:"#445566", fontFamily:"DM Mono,monospace" }}>
              <div style={{ fontSize:14, marginBottom:8 }}>No Put Wall detected</div>
              <div style={{ fontSize:11 }}>Spread requires a Put Wall as protection strike. No high-OI put below current price found.</div>
            </div>
          );

          const scenarios = [
            { price: stock.price,          label: "Stock stays here",    pnl: sp.max_profit,          note: "Best case — full premium" },
            { price: strike,               label: `Stock hits sell $${strike}`, pnl: sp.max_profit,   note: "Still max profit at expiry" },
            { price: sp.breakeven,         label: `Breakeven $${sp.breakeven}`, pnl: 0,               note: "Zero profit/loss point" },
            { price: sp.halfway_price,     label: `Halfway $${sp.halfway_price}`, pnl: Math.round(sp.max_profit / 2 * -1), note: "Partial loss zone" },
            { price: sp.protect_strike,    label: `Protection $${sp.protect_strike}`, pnl: -sp.max_loss, note: "Max loss — spread fully ITM" },
            { price: sp.protect_strike * 0.8, label: "Big crash", pnl: -sp.max_loss, note: "Still capped at max loss" },
          ];

          return (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

              {/* Strategy header */}
              <div style={{ padding:"14px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:12, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:10, letterSpacing:"0.1em" }}>
                  {isBull ? "BULL PUT SPREAD" : "BEAR CALL SPREAD"} — USING PUT WALL AS PROTECTION
                </div>

                {/* Sell leg */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e", marginBottom:6 }}>
                  <div>
                    <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>SELL {isBull?"PUT":"CALL"} (collect)</div>
                    <div style={{ fontSize:20, fontWeight:800, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>${strike}</div>
                    <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>{stock.suggest_otm_pct}% OTM</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>PREMIUM RECEIVED</div>
                    <div style={{ fontSize:20, fontWeight:800, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>+${sellPremium}</div>
                    <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>
                      {stock.suggest_expiry
                        ? `Exp ${new Date(stock.suggest_expiry).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}`
                        : `${stock.suggest_dte} DTE`}
                    </div>
                  </div>
                </div>

                {/* Buy leg */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px", background:"#1a0a0a", borderRadius:8, border:"1px solid #2e0e0e", marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>BUY {isBull?"PUT":"CALL"} (protection)</div>
                    <div style={{ fontSize:20, fontWeight:800, color:"#ff8c42", fontFamily:"DM Mono,monospace" }}>${sp.protect_strike}</div>
                    <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>at Put Wall</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>PREMIUM PAID</div>
                    <div style={{ fontSize:20, fontWeight:800, color:"#ff5c5c", fontFamily:"DM Mono,monospace" }}>-${sp.protect_contract}</div>
                    <div style={{ fontSize:10, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>per contract</div>
                  </div>
                </div>

                {/* Divider */}
                <div style={{ height:1, background:"#1a2e40", marginBottom:10 }} />

                {/* Net result */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                  <div style={{ padding:"10px", background:"#071510", borderRadius:8, border:"1px solid #0e2e1e", textAlign:"center" }}>
                    <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>NET PREMIUM</div>
                    <div style={{ fontSize:18, fontWeight:800, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>${sp.net_contract}</div>
                    <div style={{ fontSize:9, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>yours to keep</div>
                  </div>
                  <div style={{ padding:"10px", background:"#1a0a0a", borderRadius:8, border:"1px solid #2e0e0e", textAlign:"center" }}>
                    <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>MAX LOSS</div>
                    <div style={{ fontSize:18, fontWeight:800, color:"#ff5c5c", fontFamily:"DM Mono,monospace" }}>-${sp.max_loss}</div>
                    <div style={{ fontSize:9, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>if fully ITM</div>
                  </div>
                  <div style={{ padding:"10px", background:"#0a1828", borderRadius:8, border:"1px solid #1a2e40", textAlign:"center" }}>
                    <div style={{ fontSize:9, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:3 }}>RETURN/RISK</div>
                    <div style={{ fontSize:18, fontWeight:800, color:"#f5a623", fontFamily:"DM Mono,monospace" }}>{sp.return_on_risk}%</div>
                    <div style={{ fontSize:9, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>on capital at risk</div>
                  </div>
                </div>
              </div>

              {/* Breakeven */}
              <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40", textAlign:"center" }}>
                <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:4 }}>BREAKEVEN PRICE</div>
                <div style={{ fontSize:28, fontWeight:900, color:"#3b9eff", fontFamily:"DM Mono,monospace" }}>${sp.breakeven}</div>
                <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:4 }}>
                  Stock must stay above ${sp.breakeven} to profit · currently ${stock.price.toFixed(2)} ({((stock.price - sp.breakeven)/stock.price*100).toFixed(1)}% buffer)
                </div>
              </div>

              {/* Scenario table */}
              <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:10, letterSpacing:"0.1em" }}>SCENARIO ANALYSIS AT EXPIRY</div>
                {scenarios.map((s, i) => (
                  <div key={i} style={{
                    display:"flex", justifyContent:"space-between", alignItems:"center",
                    padding:"8px 10px", marginBottom:4, borderRadius:8,
                    background: s.pnl > 0 ? "#071510" : s.pnl === 0 ? "#0a1828" : "#1a0a0a",
                    border: `1px solid ${s.pnl > 0 ? "#0e2e1e" : s.pnl === 0 ? "#1a3555" : "#2e0e0e"}`,
                  }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:"#ccddee", fontFamily:"DM Mono,monospace" }}>{s.label}</div>
                      <div style={{ fontSize:10, color:"#445566", fontFamily:"DM Mono,monospace" }}>{s.note}</div>
                    </div>
                    <div style={{ fontSize:16, fontWeight:800, fontFamily:"DM Mono,monospace",
                      color: s.pnl > 0 ? "#00d4aa" : s.pnl === 0 ? "#3b9eff" : "#ff5c5c" }}>
                      {s.pnl > 0 ? `+$${s.pnl}` : s.pnl === 0 ? "$0" : `-$${Math.abs(s.pnl)}`}
                    </div>
                  </div>
                ))}
              </div>

              {/* vs Naked comparison */}
              <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:10, letterSpacing:"0.1em" }}>SPREAD vs NAKED SELL PUT</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  {[
                    ["Net Premium",    `$${sp.net_contract}`,  `$${sellPremium}`,  false],
                    ["Max Loss",       `-$${sp.max_loss}`,      "Unlimited",        true],
                    ["Capital Needed", `-$${sp.max_loss}`,      `~$${Math.round(strike*100*0.2)}`, true],
                    ["Return/Risk",    `${sp.return_on_risk}%`, `${(sellPremium/Math.round(strike*100*0.2)*100).toFixed(1)}%`, false],
                  ].map(([label, spread, naked, spreadBetter]) => (
                    <div key={label} style={{ gridColumn:"1/-1", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 0", borderBottom:"1px solid #0e1c28" }}>
                      <span style={{ fontSize:11, color:"#7a9ab8", fontFamily:"DM Mono,monospace", flex:1 }}>{label}</span>
                      <span style={{ fontSize:12, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace", flex:1, textAlign:"center" }}>
                        Spread: {spread}
                      </span>
                      <span style={{ fontSize:12, fontWeight:700, color:"#ff8c42", fontFamily:"DM Mono,monospace", flex:1, textAlign:"right" }}>
                        Naked: {naked}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recommendation */}
              <div style={{ padding:"12px", background: sp.return_on_risk > 50 ? "#071510" : "#0a1828", borderRadius:10, border:`1px solid ${sp.return_on_risk > 50 ? "#0e2e1e" : "#1a2e40"}` }}>
                <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:6 }}>RECOMMENDATION</div>
                <div style={{ fontSize:12, color:"#ccddee", fontFamily:"DM Mono,monospace", lineHeight:1.7 }}>
                  {sp.return_on_risk > 80
                    ? `Spread is highly efficient. ${sp.return_on_risk}% return on risk with capped downside. Recommended over naked sell.`
                    : sp.return_on_risk > 40
                    ? `Decent spread setup. Consider spread if account is small or stock is volatile. Naked sell if you want more premium.`
                    : `Put Wall too close to sell strike — spread premium is low. Naked sell may be better if you accept the risk.`}
                </div>
                <div style={{ fontSize:11, color:"#00d4aa", fontFamily:"DM Mono,monospace", marginTop:8 }}>
                  Close at 50% profit = ${Math.round(sp.net_contract/2)} after ~{Math.round((stock.suggest_dte||35)/2)} days
                  {stock.suggest_expiry ? ` · Expiry ${new Date(stock.suggest_expiry).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}` : ""}
                </div>
              </div>

            </div>
          );
        })()}
        {tab === "voloi" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

            {/* Vol anomaly summary */}
            <div style={{ padding:"14px", background: stock.vol_oi_anomaly?"#2a1a06":"#0a1828", borderRadius:10, border:`1px solid ${stock.vol_oi_anomaly?"#f5a623":"#1a2e40"}` }}>
              <div style={{ fontSize:14, fontWeight:700, color:stock.vol_oi_anomaly?"#f5a623":"#8aaabb", fontFamily:"DM Mono,monospace", marginBottom:4 }}>
                {stock.vol_oi_anomaly ? "⚡ Volume Anomaly Detected" : "○ No Volume Anomaly"}
              </div>
              <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>
                {stock.vol_oi_anomaly
                  ? `${stock.anomaly_type?.replace("_"," ")} — unusual activity today. Someone is opening new positions.`
                  : "Today's volume is within normal range. No smart money signal detected."}
              </div>
            </div>

            {/* Fill side */}
            <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:8 }}>BID/ASK FILL ANALYSIS</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                {[
                  ["Filled @Ask", "Urgent buyer\nNew position\nBullish signal", stock.fill_side==="ask"],
                  ["Filled @Mid", "Normal fill\nNo urgency\nNeutral", stock.fill_side==="mid"],
                  ["Filled @Bid", "Closing position\nSeller dominant\nBearish signal", stock.fill_side==="bid"],
                ].map(([label, desc, active]) => (
                  <div key={label} style={{ padding:"8px", background:active?"#1a3020":"#060e1a", borderRadius:8, border:`1px solid ${active?"#00d4aa":"#162030"}`, textAlign:"center" }}>
                    <div style={{ fontSize:10, fontWeight:700, color:active?"#00d4aa":"#445566", fontFamily:"DM Mono,monospace", marginBottom:4 }}>{label}</div>
                    {desc.split("\n").map((d,i) => (
                      <div key={i} style={{ fontSize:9, color:active?"#8aaabb":"#334455", fontFamily:"DM Mono,monospace" }}>{d}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* P/C Ratio */}
            <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:8 }}>PUT/CALL RATIO AT EXPIRY</div>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ fontSize:36, fontWeight:900, color:stock.pc_ratio>1.2?"#ff8c42":stock.pc_ratio<0.8?"#00d4aa":"#8aaabb", fontFamily:"DM Mono,monospace" }}>
                  {stock.pc_ratio||"—"}
                </div>
                <div>
                  <div style={{ fontSize:12, color:"#8aaabb", fontFamily:"DM Mono,monospace" }}>
                    {stock.pc_ratio>1.5?"Heavily bearish — lots of put buying":
                     stock.pc_ratio>1.2?"Bearish lean — more puts than calls":
                     stock.pc_ratio<0.6?"Heavily bullish — lots of call buying":
                     stock.pc_ratio<0.8?"Bullish lean — more calls than puts":
                     "Balanced — neutral sentiment"}
                  </div>
                  <div style={{ fontSize:10, color:"#445566", fontFamily:"DM Mono,monospace", marginTop:4 }}>
                    &gt;1.2 = bearish · &lt;0.8 = bullish · ~1.0 = neutral
                  </div>
                </div>
              </div>
            </div>

            {/* Vol > OI anomaly strikes */}
            {stock.vol_anomaly_strikes?.length > 0 && (
              <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:8 }}>⚡ VOL &gt; OI STRIKES (new positions being opened)</div>
                {stock.vol_anomaly_strikes.map((s,i) => (
                  <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #0e1c28" }}>
                    <div>
                      <span style={{ fontSize:12, fontWeight:700, color:s.type==="call"?"#00d4aa":"#ff8c42", fontFamily:"DM Mono,monospace" }}>
                        ${s.strike} {s.type.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:11, color:"#f5a623", fontFamily:"DM Mono,monospace" }}>×{s.vol_oi_ratio} Vol/OI</div>
                      <div style={{ fontSize:10, color:"#445566", fontFamily:"DM Mono,monospace" }}>Vol:{s.volume.toLocaleString()} OI:{s.oi.toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 3: MAX PAIN & OI WALLS ── */}
        {tab === "maxpain" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

            {/* Max pain */}
            <div style={{ padding:"16px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40", textAlign:"center" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:6 }}>MAX PAIN PRICE ({stock.suggest_dte} DTE expiry)</div>
              <div style={{ fontSize:40, fontWeight:900, color:"#f5a623", fontFamily:"DM Mono,monospace" }}>${stock.max_pain||"—"}</div>
              <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginTop:6 }}>
                {stock.max_pain && stock.price > stock.max_pain
                  ? `Stock is $${(stock.price-stock.max_pain).toFixed(1)} ABOVE max pain → bearish pull expected`
                  : stock.max_pain && stock.price < stock.max_pain
                  ? `Stock is $${(stock.max_pain-stock.price).toFixed(1)} BELOW max pain → bullish pull expected`
                  : "Price near max pain — low directional pull"}
              </div>
            </div>

            {/* Price map */}
            <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
              <div style={{ fontSize:10, color:"#7a9ab8", fontFamily:"DM Mono,monospace", marginBottom:10 }}>PRICE MAP — OI WALLS & LEVELS</div>

              {/* Visual price ladder */}
              <div style={{ position:"relative", padding:"0 8px" }}>
                {[
                  { label:"CALL WALL",     price:stock.call_wall,       color:"#ff8c42", desc:"Resistance — call writers defend here" },
                  { label:"CURRENT PRICE", price:stock.price,           color:"#3b9eff", desc:"Where stock trades now", highlight:true },
                  { label:"MAX PAIN",      price:stock.max_pain,        color:"#f5a623", desc:"Option writers' target price" },
                  { label:"YOUR STRIKE",   price:stock.suggest_strike,  color:"#00d4aa", desc:"Suggested sell strike" },
                  { label:"PUT WALL",      price:stock.put_wall,        color:"#00d4aa", desc:"Support — put writers defend here" },
                ].filter(l => l.price).sort((a,b) => b.price-a.price).map((level,i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8,
                    padding:"8px 10px", background:level.highlight?"#0d1f35":"#060e1a",
                    borderRadius:8, border:`1px solid ${level.highlight?"#3b9eff":"#162030"}` }}>
                    <div style={{ width:3, height:36, background:level.color, borderRadius:2, flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:9, color:"#445566", fontFamily:"DM Mono,monospace" }}>{level.label}</div>
                      <div style={{ fontSize:16, fontWeight:700, color:level.color, fontFamily:"DM Mono,monospace" }}>${level.price}</div>
                      <div style={{ fontSize:10, color:"#556677", fontFamily:"DM Mono,monospace" }}>{level.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top OI strikes */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              {/* Top call OI */}
              <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:10, color:"#ff8c42", fontFamily:"DM Mono,monospace", marginBottom:8 }}>TOP CALL OI</div>
                {stock.oi_top_calls?.slice(0,3).map((c,i) => (
                  <div key={i} style={{ marginBottom:6 }}>
                    <div style={{ display:"flex", justifyContent:"space-between" }}>
                      <span style={{ fontSize:13, fontWeight:700, color:"#ff8c42", fontFamily:"DM Mono,monospace" }}>${c.strike}</span>
                      <span style={{ fontSize:10, color:"#445566", fontFamily:"DM Mono,monospace" }}>{(c.oi/1000).toFixed(0)}K OI</span>
                    </div>
                    <div style={{ height:4, background:"#162030", borderRadius:2, marginTop:3 }}>
                      <div style={{ width:`${Math.min(100, c.oi / (stock.oi_top_calls[0]?.oi||1) * 100)}%`, height:"100%", background:"#ff8c42", borderRadius:2 }} />
                    </div>
                  </div>
                ))}
              </div>
              {/* Top put OI */}
              <div style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:10, color:"#00d4aa", fontFamily:"DM Mono,monospace", marginBottom:8 }}>TOP PUT OI</div>
                {stock.oi_top_puts?.slice(0,3).map((p,i) => (
                  <div key={i} style={{ marginBottom:6 }}>
                    <div style={{ display:"flex", justifyContent:"space-between" }}>
                      <span style={{ fontSize:13, fontWeight:700, color:"#00d4aa", fontFamily:"DM Mono,monospace" }}>${p.strike}</span>
                      <span style={{ fontSize:10, color:"#445566", fontFamily:"DM Mono,monospace" }}>{(p.oi/1000).toFixed(0)}K OI</span>
                    </div>
                    <div style={{ height:4, background:"#162030", borderRadius:2, marginTop:3 }}>
                      <div style={{ width:`${Math.min(100, p.oi / (stock.oi_top_puts[0]?.oi||1) * 100)}%`, height:"100%", background:"#00d4aa", borderRadius:2 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 4: GUIDE ── */}
        {tab === "guide" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

            {[
              {
                title:"📊 Signal Matrix",
                items:[
                  ["STRONG BULL","↑Price + Call Vol>OI + filled @Ask → smart money buying calls aggressively"],
                  ["BULL","↑Price + unusual call volume → directional bias up"],
                  ["STRONG BEAR","↓Price + Put Vol>OI + filled @Ask → smart money buying puts aggressively"],
                  ["BEAR","↓Price + unusual put volume → directional bias down"],
                  ["VOLATILE","High vol on both calls and puts → event play, big move expected"],
                  ["NEUTRAL","No unusual activity, trade IV rank only"],
                ]
              },
              {
                title:"⚡ Vol > OI (Most Important Signal)",
                items:[
                  ["What it means","Today's volume EXCEEDS existing open interest → someone opened a brand new large position today"],
                  ["Why it matters","OI builds over days/weeks. Vol>OI in one day = urgent conviction trade by smart money"],
                  ["Call Vol>OI","Bullish — someone expects price to rise, buying calls urgently"],
                  ["Put Vol>OI","Bearish — someone expects price to fall, buying puts urgently"],
                  ["Combined with @Ask fill","Strongest signal — paid full ask price = very urgent, not waiting for better fill"],
                ]
              },
              {
                title:"🧱 OI Walls & Max Pain",
                items:[
                  ["Call Wall","High OI call strike above price = resistance. Market makers hedged here, will sell stock to hedge if price approaches"],
                  ["Put Wall","High OI put strike below price = support. Market makers buy stock to hedge puts if price falls here"],
                  ["Max Pain","Price where most options expire worthless. On expiry day price often drifts toward max pain"],
                  ["Your strike vs max pain","If your put strike is BELOW max pain = safer. Stock pulled toward max pain = away from your strike"],
                ]
              },
              {
                title:"❌ 4 Common Mistakes",
                items:[
                  ["Selling high IV blindly","Always check Vol/OI — if put Vol>OI with @Ask fills, market knows something. Avoid selling puts."],
                  ["Ignoring P/C ratio","P/C > 1.5 means heavy put buying. Even if trend is bullish, wait for ratio to normalize."],
                  ["Strike below put wall","Put wall = strong support. Strike ABOVE put wall is safer — stock defended there."],
                  ["Holding to expiry","Always close at 50% profit. Last 2 weeks have max gamma risk — small move = big loss."],
                ]
              },
            ].map(section => (
              <div key={section.title} style={{ padding:"12px", background:"#0a1828", borderRadius:10, border:"1px solid #1a2e40" }}>
                <div style={{ fontSize:13, fontWeight:700, color:"#3b9eff", fontFamily:"'Syne',sans-serif", marginBottom:10 }}>{section.title}</div>
                {section.items.map(([term, desc]) => (
                  <div key={term} style={{ marginBottom:8, paddingBottom:8, borderBottom:"1px solid #0e1c28" }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#ccddee", fontFamily:"DM Mono,monospace", marginBottom:2 }}>{term}</div>
                    <div style={{ fontSize:11, color:"#7a9ab8", fontFamily:"DM Mono,monospace", lineHeight:1.5 }}>{desc}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]               = useState("premium");
  const [data, setData]               = useState(null);
  const [selected, setSelected]       = useState(null);
  const [detailStock, setDetailStock] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [filterScore, setFilterScore] = useState(0);
  const [filterCat, setFilterCat]     = useState("all");
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
        const sorted = [...json.results].sort((a,b) => calcPremiumScore(b)-calcPremiumScore(a));
        setSelected(sorted[0]);
      }
    } catch (e) { setError("No scan data yet."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadResults(); }, [loadResults]);
  useEffect(() => { const t = setInterval(loadResults, 5*60*1000); return () => clearInterval(t); }, [loadResults]);

  const allStocks  = data?.results || [];
  const categories = ["all", ...new Set(allStocks.map(s => s.category).filter(Boolean))];
  const stocks     = allStocks
    .map(s => ({ ...s, _score: calcPremiumScore(s) }))
    .filter(s => s._score >= filterScore)
    .filter(s => filterCat==="all" || s.category===filterCat)
    .sort((a,b) => b._score - a._score);

  const sellNow  = stocks.filter(s => s._score >= 80).length;
  const avgIV    = stocks.length ? (stocks.reduce((a,s)=>a+s.iv_rank,0)/stocks.length).toFixed(0) : 0;
  const topPicks = stocks.slice(0,3).map(s=>s.ticker).join(", ");
  const anomalies = stocks.filter(s => s.vol_oi_anomaly).length;

  return (
    <div style={{ minHeight:"100vh", background:"#040b14", color:"#ddeeff", fontFamily:"'Syne',sans-serif", display:"flex", flexDirection:"column", overflow:"hidden", maxWidth:"100vw" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{overflow-x:hidden;max-width:100vw;background:#040b14}
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:#040b14} ::-webkit-scrollbar-thumb{background:#162030;border-radius:3px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        /* iPhone safe area support */
        :root {
          --sat: env(safe-area-inset-top, 44px);
          --sab: env(safe-area-inset-bottom, 0px);
          --sal: env(safe-area-inset-left, 0px);
          --sar: env(safe-area-inset-right, 0px);
        }
      `}</style>

      {/* Detail page overlay */}
      {detailStock && <DetailPage stock={detailStock} onClose={() => setDetailStock(null)} />}

      {/* TOPBAR */}
      <div style={{
        background:"#050c18",
        borderBottom:"1px solid #0a1826",
        flexShrink:0,
        overflow:"hidden",
        paddingTop:"env(safe-area-inset-top, 44px)",
      }}>
        <div style={{ height:52, display:"flex", alignItems:"center", padding:"0 10px", gap:8 }}>
        <div style={{ width:28, height:28, background:"linear-gradient(135deg,#0d4080,#00b894)", borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, flexShrink:0 }}>⚡</div>
        {!isMobile && <span style={{ fontSize:14, fontWeight:900, letterSpacing:"-0.5px", background:"linear-gradient(90deg,#3b9eff,#00d4aa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>OptionScope</span>}
        <div style={{ display:"flex", gap:3, background:"#080f1c", borderRadius:8, padding:3 }}>
          {[["premium","💰"],["compass","🧭"]].map(([id,icon])=>(
            <button key={id} onClick={()=>setView(id)} style={{
              padding:"5px 12px", borderRadius:6, border:"none", cursor:"pointer",
              fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif",
              background:view===id?"#1a3555":"transparent", color:view===id?"#3b9eff":"#3a5060",
            }}>{isMobile?icon:(id==="premium"?"💰 Premium":"🧭 Compass")}</button>
          ))}
        </div>
        <div style={{ flex:1 }} />
        <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} style={{ background:"#080f1c", border:"1px solid #0e1c28", borderRadius:6, color:"#667788", padding:"4px 6px", fontSize:10, fontFamily:"DM Mono,monospace", outline:"none", cursor:"pointer", maxWidth:90 }}>
          {categories.map(c=><option key={c} value={c}>{c==="all"?"All":CATEGORY_ICON[c]+" "+c.replace("_"," ")}</option>)}
        </select>
        <select value={filterScore} onChange={e=>setFilterScore(+e.target.value)} style={{ background:"#080f1c", border:"1px solid #0e1c28", borderRadius:6, color:"#667788", padding:"4px 6px", fontSize:10, fontFamily:"DM Mono,monospace", outline:"none", cursor:"pointer" }}>
          <option value={0}>All</option>
          <option value={60}>≥60</option>
          <option value={80}>≥80</option>
        </select>
        <button onClick={loadResults} style={{ padding:"5px 10px", background:"#0d3060", border:"none", borderRadius:7, color:"#88bbee", fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif", cursor:"pointer", flexShrink:0 }}>↻</button>
        </div>
      </div>

      {/* SUMMARY BAR */}
      {!loading && !error && data && (
        <div style={{ background:"#050c18", borderBottom:"1px solid #0a1826", padding:"5px 12px", display:"flex", gap:14, alignItems:"center", flexShrink:0, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
            <span style={{ color:"#8aaabb" }}>SELL NOW </span>
            <span style={{ color:"#00d4aa", fontWeight:700 }}>{sellNow}</span>
          </span>
          <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
            <span style={{ color:"#8aaabb" }}>AVG IV </span>
            <span style={{ color:"#3b9eff", fontWeight:700 }}>{avgIV}</span>
          </span>
          {anomalies > 0 && (
            <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
              <span style={{ color:"#f5a623" }}>⚡ {anomalies} Vol Anomalies</span>
            </span>
          )}
          {!isMobile && <span style={{ fontSize:11, fontFamily:"DM Mono,monospace" }}>
            <span style={{ color:"#8aaabb" }}>TOP </span>
            <span style={{ color:"#f5a623", fontWeight:700 }}>{topPicks}</span>
          </span>}
          <span style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace", marginLeft:"auto" }}>
            {data.scanned_at ? `Scanned ${new Date(data.scanned_at).toLocaleString()}` : ""}
          </span>
        </div>
      )}

      {/* BODY */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", position:"relative" }}>

        {loading && (
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#040b14", zIndex:30, gap:14 }}>
            <div style={{ width:34, height:34, border:"3px solid #0e1c28", borderTopColor:"#3b9eff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
            <div style={{ color:"#8aaabb", fontFamily:"DM Mono,monospace", fontSize:12 }}>Loading scan results…</div>
          </div>
        )}

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

        {/* PREMIUM VIEW */}
        {!loading && !error && view==="premium" && (
          <div style={{ flex:1, overflowY:"auto", overflowX:"hidden", padding:"12px 10px" }}>
            <div style={{ fontSize:11, color:"#8aaabb", fontFamily:"DM Mono,monospace", marginBottom:10 }}>
              {stocks.length} stocks · tap any card for full analysis
            </div>
            <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(300px,1fr))", gap:10, width:"100%" }}>
              {stocks.map((s,i) => (
                <div key={s.ticker} style={{ animation:`fadeUp 0.3s ease ${i*0.03}s both`, minWidth:0 }}>
                  <PremiumCard
                    stock={s}
                    isSelected={selected?.ticker===s.ticker}
                    onClick={() => { setSelected(s); setDetailStock(s); }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* COMPASS VIEW */}
        {!loading && !error && view==="compass" && (
          <div style={{ flex:1, padding:14, overflowY:"auto" }}>
            <div style={{ fontSize:13, fontWeight:700, color:"#667788", textAlign:"center", marginBottom:10, fontFamily:"'Syne',sans-serif" }}>Premium Opportunity Compass</div>
            <ResponsiveContainer width="100%" height={360}>
              <ScatterChart margin={{ top:20, right:20, bottom:40, left:10 }}>
                <CartesianGrid stroke="#0a1826" strokeDasharray="4 4" />
                <XAxis dataKey="risk_reversal" type="number" domain={[0,100]} stroke="#0e1c28"
                  tick={{ fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }}
                  label={{ value:"Bullish ← Trend → Bearish", position:"insideBottom", offset:-24, fill:"#3a5060", fontSize:10 }} />
                <YAxis dataKey="iv_rank" type="number" domain={[0,100]} stroke="#0e1c28"
                  tick={{ fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }}
                  label={{ value:"IV Rank", angle:-90, position:"insideLeft", fill:"#3a5060", fontSize:10 }} />
                <ReferenceLine x={50} stroke="#0e1c28" strokeWidth={1.5} />
                <ReferenceLine y={50} stroke="#0e1c28" strokeWidth={1.5} />
                <Tooltip content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0].payload;
                  const sc = calcPremiumScore(d);
                  const sig = SIGNAL_CONFIG[d.signal_matrix]||SIGNAL_CONFIG.NEUTRAL;
                  return (
                    <div style={{ background:"#080f1c", border:"1px solid #0e1c28", borderRadius:8, padding:"10px 14px", fontFamily:"DM Mono,monospace" }}>
                      <div style={{ color:"#ddeeff", fontWeight:700 }}>{d.ticker} · ${d.price}</div>
                      <div style={{ color:"#3a5060", fontSize:11, marginTop:4 }}>IV Rank: <span style={{ color:getScoreColor(sc) }}>{d.iv_rank}</span></div>
                      <div style={{ color:sig.color, fontSize:11 }}>{sig.label}</div>
                      {d.vol_oi_anomaly && <div style={{ color:"#f5a623", fontSize:11 }}>⚡ Vol Anomaly</div>}
                    </div>
                  );
                }} />
                <Scatter data={stocks} shape={(props) => {
                  const { cx, cy, payload } = props;
                  const sel = selected?.ticker===payload.ticker;
                  const sc  = calcPremiumScore(payload);
                  const c   = getScoreColor(sc);
                  const hasAnomaly = payload.vol_oi_anomaly;
                  return (
                    <g onClick={() => { setSelected(payload); setDetailStock(payload); }} style={{ cursor:"pointer" }}>
                      {hasAnomaly && <circle cx={cx} cy={cy} r={sel?24:17} fill="#f5a623" fillOpacity={0.15} />}
                      <circle cx={cx} cy={cy} r={sel?20:12} fill={c} fillOpacity={0.12} />
                      <circle cx={cx} cy={cy} r={sel?10:6}  fill={c} fillOpacity={sel?1:0.75} />
                      <text x={cx} y={cy-14} textAnchor="middle" fill="#a8bece" fontSize={10} fontFamily="DM Mono,monospace" fontWeight={600}>{payload.ticker}</text>
                    </g>
                  );
                }} />
              </ScatterChart>
            </ResponsiveContainer>
            <div style={{ display:"flex", justifyContent:"center", gap:14, marginTop:8, flexWrap:"wrap" }}>
              {[["≥80 Sell Now","#00d4aa"],["≥60 Good","#3b9eff"],["≥40 Fair","#f5a623"],["<40 Avoid","#ff5c5c"],["⚡ Vol Anomaly","#f5a623"]].map(([lbl,c])=>(
                <div key={lbl} style={{ display:"flex", alignItems:"center", gap:4 }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:c }} />
                  <span style={{ fontSize:10, color:c, fontFamily:"DM Mono,monospace" }}>{lbl}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* STATUS BAR */}
      <div style={{ height:24, background:"#030910", borderTop:"1px solid #08141e", display:"flex", alignItems:"center", padding:"0 14px", gap:16, flexShrink:0 }}>
        <span style={{ fontSize:10, color:data?"#00d4aa":"#2e4055", fontFamily:"DM Mono,monospace" }}>
          {data?`● ${data.total_results} stocks · auto-refresh 5min`:"○ Waiting"}
        </span>
        <span style={{ fontSize:10, color:"#6a8898", fontFamily:"DM Mono,monospace", marginLeft:"auto" }}>{new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
