import { useState, useEffect, useCallback } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// In production this reads from same domain (GitHub Pages)
// In local dev, reads from public/results.json
const RESULTS_URL = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL}/results.json`
  : "/results.json";

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const getIVColor = (iv) => {
  if (iv >= 75) return "#00d4aa";
  if (iv >= 50) return "#3b9eff";
  if (iv >= 25) return "#f5a623";
  return "#ff5c5c";
};

const getTrendIcon  = (t) => t==="bullish"?"▲":t==="bearish"?"▼":"◆";
const getTrendColor = (t) => t==="bullish"?"#00d4aa":t==="bearish"?"#ff5c5c":"#8899aa";

// ─── COMPONENTS ──────────────────────────────────────────────────────────────
function IVBar({ value, color }) {
  return (
    <div style={{ marginTop:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
        <span style={{ fontSize:10, color:"#556677", fontFamily:"DM Mono,monospace", letterSpacing:"0.08em" }}>IV RANK</span>
        <span style={{ fontSize:14, fontWeight:700, color, fontFamily:"DM Mono,monospace" }}>{value.toFixed(1)}</span>
      </div>
      <div style={{ background:"#1a2332", borderRadius:4, height:8, overflow:"hidden" }}>
        <div style={{ width:`${Math.min(value,100)}%`, height:"100%", background:`linear-gradient(90deg,${color}55,${color})`, borderRadius:4, transition:"width 1.2s cubic-bezier(0.4,0,0.2,1)" }} />
      </div>
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div style={{ padding:"8px 10px", background:"#060f1c", borderRadius:8, border:"1px solid #162030", textAlign:"center" }}>
      <div style={{ fontSize:9, color:"#445566", fontFamily:"DM Mono,monospace", letterSpacing:"0.1em", marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:15, fontWeight:700, color:color||"#b8cce0", fontFamily:"DM Mono,monospace" }}>{value}</div>
    </div>
  );
}

function StockCard({ stock, isSelected, onClick }) {
  const ivColor = getIVColor(stock.iv_rank);
  return (
    <div onClick={onClick} style={{
      background: isSelected ? "#0c1e34" : "#0a1520",
      border:`1px solid ${isSelected?"#3b9eff":"#162030"}`,
      borderRadius:12, padding:16, cursor:"pointer",
      transition:"all 0.18s ease",
      boxShadow: isSelected ? "0 0 0 2px #3b9eff1a, 0 4px 24px #00000077" : "0 2px 8px #00000033",
    }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <span style={{ fontSize:22, fontWeight:900, color:"#ddeeff", fontFamily:"'Syne',sans-serif", letterSpacing:"-0.5px" }}>{stock.ticker}</span>
            <span style={{ fontSize:13, color:getTrendColor(stock.trend) }}>{getTrendIcon(stock.trend)}</span>
          </div>
          <div style={{ fontSize:10, color:"#2e4055", fontFamily:"DM Mono,monospace", marginTop:2 }}>
            {stock.scanned_at ? new Date(stock.scanned_at).toLocaleString() : "—"}
          </div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:18, fontWeight:700, color:"#c8dcf0", fontFamily:"DM Mono,monospace" }}>${stock.price.toFixed(2)}</div>
          <div style={{ fontSize:10, padding:"2px 8px", borderRadius:20, background:stock.quadrant_bg, color:stock.quadrant_color, marginTop:4, fontFamily:"DM Mono,monospace", whiteSpace:"nowrap" }}>
            {stock.quadrant_label}
          </div>
        </div>
      </div>

      <IVBar value={stock.iv_rank} color={ivColor} />

      {/* Strategies */}
      <div style={{ marginTop:11, padding:"9px 12px", background:"#060e1a", borderRadius:8, border:"1px solid #14222e" }}>
        <div style={{ fontSize:9, color:"#3a5060", letterSpacing:"0.1em", fontFamily:"DM Mono,monospace", marginBottom:5 }}>BEST STRATEGIES</div>
        {stock.strategies.slice(0,2).map(s => (
          <div key={s} style={{ fontSize:13, fontWeight:600, color:"#a8bece", fontFamily:"'Syne',sans-serif", marginBottom:2 }}>• {s}</div>
        ))}
      </div>

      {/* Expected ranges */}
      <div style={{ marginTop:9, display:"flex", flexDirection:"column", gap:3 }}>
        {[["1 Day",stock.range_1d],["1 Week",stock.range_1w],["1 Month",stock.range_1m]].map(([lbl,r])=>(
          <div key={lbl} style={{ display:"flex", justifyContent:"space-between" }}>
            <span style={{ fontSize:10, color:"#3a5060", fontFamily:"DM Mono,monospace" }}>{lbl} Range</span>
            <span style={{ fontSize:11, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>${r.low} – ${r.high}</span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ marginTop:9, display:"flex", justifyContent:"space-between", borderTop:"1px solid #14222e", paddingTop:9 }}>
        <span style={{ fontSize:11, color:"#667788", fontFamily:"DM Mono,monospace" }}>
          Win: <span style={{ color:"#00d4aa" }}>{stock.win_rate}</span>
        </span>
        <span style={{ fontSize:10, color:"#3a5060", fontFamily:"DM Mono,monospace" }}>
          ADX {stock.adx} · RSI {stock.rsi}
          {stock.volume_spike > 1.5 && <span style={{ color:"#f5a623", marginLeft:4 }}>🔥 ×{stock.volume_spike}</span>}
        </span>
      </div>
    </div>
  );
}

function DetailPanel({ stock, onClose, isMobile }) {
  if (!stock) return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"100%", gap:10, color:"#2e4055" }}>
      <div style={{ fontSize:36 }}>⚡</div>
      <div style={{ fontFamily:"DM Mono,monospace", fontSize:12 }}>Select a stock</div>
    </div>
  );
  const ivColor = getIVColor(stock.iv_rank);
  return (
    <div style={{ padding:"18px 16px", overflowY:"auto", height:"100%" }}>
      {isMobile && (
        <button onClick={onClose} style={{ background:"#0a1520", border:"1px solid #162030", borderRadius:6, color:"#667788", padding:"6px 14px", fontSize:12, cursor:"pointer", fontFamily:"DM Mono,monospace", marginBottom:14 }}>← Back</button>
      )}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontSize:30, fontWeight:900, color:"#ddeeff", fontFamily:"'Syne',sans-serif", letterSpacing:"-1px" }}>{stock.ticker}</div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:22, fontWeight:700, fontFamily:"DM Mono,monospace", color:"#c8dcf0" }}>${stock.price.toFixed(2)}</div>
          <div style={{ fontSize:11, color:getTrendColor(stock.trend), fontFamily:"DM Mono,monospace" }}>{getTrendIcon(stock.trend)} {stock.trend.toUpperCase()}</div>
        </div>
      </div>
      <div style={{ fontSize:10, color:"#2e4055", fontFamily:"DM Mono,monospace", marginTop:4, marginBottom:14 }}>
        {stock.scanned_at ? `Scanned: ${new Date(stock.scanned_at).toLocaleString()}` : ""}
      </div>

      <IVBar value={stock.iv_rank} color={ivColor} />
      <div style={{ fontSize:11, color:"#3a5060", fontFamily:"DM Mono,monospace", marginTop:4 }}>Current IV: {stock.iv_current}%</div>

      <div style={{ marginTop:13, padding:"11px 12px", background:"#060e1a", borderRadius:8, border:"1px solid #14222e" }}>
        <div style={{ fontSize:9, color:"#3a5060", letterSpacing:"0.1em", fontFamily:"DM Mono,monospace", marginBottom:7 }}>BEST OPTIONS STRATEGIES</div>
        {stock.strategies.map(s => (
          <div key={s} style={{ fontSize:14, fontWeight:700, color:"#a8bece", fontFamily:"'Syne',sans-serif", marginBottom:5 }}>• {s}</div>
        ))}
      </div>

      {[["1 Day Expected Range",stock.range_1d],["1 Week Expected Range",stock.range_1w],["1 Month Expected Range",stock.range_1m]].map(([lbl,r])=>(
        <div key={lbl} style={{ marginTop:8, padding:"9px 12px", background:"#060e1a", borderRadius:8, border:"1px solid #14222e" }}>
          <div style={{ fontSize:9, color:"#3a5060", fontFamily:"DM Mono,monospace", marginBottom:3 }}>{lbl}</div>
          <div style={{ fontSize:15, fontWeight:700, color:"#7a9ab8", fontFamily:"DM Mono,monospace" }}>${r.low} – ${r.high}</div>
        </div>
      ))}

      <div style={{ marginTop:13, display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
        <StatPill label="WIN RATE"    value={stock.win_rate}          color="#00d4aa" />
        <StatPill label="IV RANK"     value={stock.iv_rank.toFixed(1)} color={ivColor} />
        <StatPill label="ADX"         value={stock.adx}                color={stock.adx>=30?"#00d4aa":"#f5a623"} />
        <StatPill label="RSI"         value={stock.rsi}                color={stock.rsi>70?"#ff5c5c":stock.rsi<30?"#00d4aa":"#7a9ab8"} />
        <StatPill label="EMA 9"       value={`$${stock.ema9?.toFixed(0)}`} />
        <StatPill label="EMA 21"      value={`$${stock.ema21?.toFixed(0)}`} />
      </div>

      {stock.volume_spike > 1.5 && (
        <div style={{ marginTop:11, padding:"9px 12px", background:"#221408", borderRadius:8, border:"1px solid #3a2508", textAlign:"center" }}>
          <span style={{ color:"#f5a623", fontFamily:"DM Mono,monospace", fontSize:12 }}>🔥 Volume spike ×{stock.volume_spike} vs avg</span>
        </div>
      )}

      <div style={{ marginTop:11, padding:"9px 12px", borderRadius:8, background:stock.quadrant_bg, border:`1px solid ${stock.quadrant_color}22` }}>
        <div style={{ fontSize:12, fontWeight:700, color:stock.quadrant_color, fontFamily:"DM Mono,monospace" }}>{stock.quadrant_label}</div>
      </div>
    </div>
  );
}

function CompassChart({ stocks, selected, onSelect }) {
  return (
    <div style={{ padding:"0 4px" }}>
      <div style={{ textAlign:"center", fontSize:15, fontWeight:700, color:"#667788", marginBottom:8, fontFamily:"'Syne',sans-serif" }}>Options Compass</div>
      <ResponsiveContainer width="100%" height={380}>
        <ScatterChart margin={{ top:20, right:20, bottom:40, left:10 }}>
          <CartesianGrid stroke="#0e1c28" strokeDasharray="4 4" />
          <XAxis dataKey="risk_reversal" type="number" domain={[0,100]} stroke="#14222e"
            tick={{ fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }}
            label={{ value:"Bullish ← Risk Reversal → Bearish", position:"insideBottom", offset:-24, fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }} />
          <YAxis dataKey="iv_rank" type="number" domain={[0,100]} stroke="#14222e"
            tick={{ fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }}
            label={{ value:"IV Rank", angle:-90, position:"insideLeft", fill:"#3a5060", fontSize:10, fontFamily:"DM Mono,monospace" }} />
          <ReferenceLine x={50} stroke="#14222e" strokeWidth={1.5} />
          <ReferenceLine y={50} stroke="#14222e" strokeWidth={1.5} />
          <Tooltip content={({ payload }) => {
            if (!payload?.length) return null;
            const d = payload[0].payload;
            return (
              <div style={{ background:"#0a1520", border:"1px solid #162030", borderRadius:8, padding:"10px 14px", fontFamily:"DM Mono,monospace" }}>
                <div style={{ color:"#ddeeff", fontWeight:700 }}>{d.ticker} · ${d.price}</div>
                <div style={{ color:"#445566", fontSize:11, marginTop:4 }}>IV Rank: <span style={{ color:getIVColor(d.iv_rank) }}>{d.iv_rank}</span></div>
                <div style={{ color:"#445566", fontSize:11 }}>RSI {d.rsi} · ADX {d.adx}</div>
              </div>
            );
          }} />
          <Scatter data={stocks} shape={(props) => {
            const { cx, cy, payload } = props;
            const sel = selected?.ticker === payload.ticker;
            const c = getIVColor(payload.iv_rank);
            return (
              <g onClick={() => onSelect(payload)} style={{ cursor:"pointer" }}>
                <circle cx={cx} cy={cy} r={sel?20:13} fill={c} fillOpacity={0.1} />
                <circle cx={cx} cy={cy} r={sel?10:6}  fill={c} fillOpacity={sel?1:0.7} />
                <text x={cx} y={cy-16} textAnchor="middle" fill="#a8bece" fontSize={10} fontFamily="DM Mono,monospace" fontWeight={600}>{payload.ticker}</text>
              </g>
            );
          }} />
        </ScatterChart>
      </ResponsiveContainer>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginTop:4 }}>
        {[["Exp. Vol · Bearish","#ff8c42"],["Exp. Vol · Bullish","#00d4aa"],["Cheap Vol · Bearish","#cc77ff"],["Cheap Vol · Bullish","#3b9eff"]].map(([l,c])=>(
          <div key={l} style={{ textAlign:"center", fontSize:10, color:c, fontFamily:"DM Mono,monospace", opacity:0.6 }}>{l}</div>
        ))}
      </div>
    </div>
  );
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView]         = useState("explorer");
  const [data, setData]         = useState(null);       // raw JSON from results.json
  const [selected, setSelected] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [filterIV, setFilterIV] = useState(0);
  const [sortBy, setSortBy]     = useState("iv_rank");
  const [showDetail, setShowDetail] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  const loadResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${RESULTS_URL}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      if (json.results?.length > 0) setSelected(json.results[0]);
    } catch (e) {
      setError("No scan data yet. Trigger the GitHub Action to run a scan.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadResults(); }, [loadResults]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const t = setInterval(loadResults, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [loadResults]);

  const stocks = (data?.results || [])
    .filter(s => s.iv_rank >= filterIV)
    .sort((a,b) => sortBy==="iv_rank" ? b.iv_rank-a.iv_rank : b.adx-a.adx);

  const handleSelect = (stock) => {
    setSelected(stock);
    if (isMobile) setShowDetail(true);
  };

  const lastScan = data?.scanned_at ? new Date(data.scanned_at).toLocaleString() : null;

  return (
    <div style={{ minHeight:"100vh", background:"#050d18", color:"#ddeeff", fontFamily:"'Syne',sans-serif", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#050d18} ::-webkit-scrollbar-thumb{background:#162030;border-radius:4px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
      `}</style>

      {/* ── TOPBAR ── */}
      <div style={{ height:52, background:"#060d1a", borderBottom:"1px solid #0e1c28", display:"flex", alignItems:"center", padding:"0 14px", gap:10, flexShrink:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginRight:4 }}>
          <div style={{ width:28, height:28, background:"linear-gradient(135deg,#0d4080,#00c49a)", borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, flexShrink:0 }}>⚡</div>
          {!isMobile && <span style={{ fontSize:15, fontWeight:900, letterSpacing:"-0.5px", background:"linear-gradient(90deg,#3b9eff,#00d4aa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>OptionScope</span>}
        </div>

        <div style={{ display:"flex", gap:3, background:"#090f1c", borderRadius:8, padding:3 }}>
          {[["explorer","Explorer"],["compass","Compass"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setView(id)} style={{
              padding:isMobile?"5px 10px":"5px 14px", borderRadius:6, border:"none", cursor:"pointer",
              fontSize:12, fontWeight:700, fontFamily:"'Syne',sans-serif",
              background:view===id?"#1a3555":"transparent", color:view===id?"#3b9eff":"#3a5060",
              transition:"all 0.15s",
            }}>{lbl}</button>
          ))}
        </div>

        <div style={{ flex:1 }} />

        {!isMobile && lastScan && (
          <span style={{ fontSize:10, color:"#2e4055", fontFamily:"DM Mono,monospace" }}>Last scan: {lastScan}</span>
        )}

        <select value={filterIV} onChange={e=>setFilterIV(+e.target.value)} style={{ background:"#090f1c", border:"1px solid #162030", borderRadius:6, color:"#667788", padding:"5px 7px", fontSize:11, fontFamily:"DM Mono,monospace", outline:"none", cursor:"pointer" }}>
          <option value={0}>All IV</option>
          <option value={50}>IV &gt; 50</option>
          <option value={70}>IV &gt; 70</option>
          <option value={85}>IV &gt; 85</option>
        </select>

        <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={{ background:"#090f1c", border:"1px solid #162030", borderRadius:6, color:"#667788", padding:"5px 7px", fontSize:11, fontFamily:"DM Mono,monospace", outline:"none", cursor:"pointer" }}>
          <option value="iv_rank">↓ IV Rank</option>
          <option value="adx">↓ ADX</option>
        </select>

        <button onClick={loadResults} style={{ padding:"6px 14px", background:"#0d3060", border:"none", borderRadius:8, color:"#88bbee", fontSize:12, fontWeight:700, fontFamily:"'Syne',sans-serif", cursor:"pointer" }}>
          ↻ Refresh
        </button>
      </div>

      {/* ── BODY ── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", position:"relative" }}>

        {/* Loading */}
        {loading && (
          <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:"#050d18", zIndex:30, gap:14 }}>
            <div style={{ width:36, height:36, border:"3px solid #162030", borderTopColor:"#3b9eff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
            <div style={{ color:"#3a5060", fontFamily:"DM Mono,monospace", fontSize:12 }}>Loading scan results…</div>
          </div>
        )}

        {/* Error / empty state */}
        {!loading && error && (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, padding:24 }}>
            <div style={{ fontSize:40 }}>📡</div>
            <div style={{ color:"#3b9eff", fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:700 }}>No scan data yet</div>
            <div style={{ color:"#3a5060", fontFamily:"DM Mono,monospace", fontSize:12, textAlign:"center", maxWidth:320, lineHeight:1.7 }}>
              Go to your GitHub repo → Actions → OptionScope Scanner → Run workflow to trigger your first scan.
              Results will appear here automatically.
            </div>
            <button onClick={loadResults} style={{ padding:"8px 20px", background:"#0d3060", border:"none", borderRadius:8, color:"#3b9eff", fontSize:13, fontWeight:700, fontFamily:"'Syne',sans-serif", cursor:"pointer" }}>Try Again</button>
          </div>
        )}

        {/* Mobile detail overlay */}
        {!loading && !error && isMobile && showDetail && (
          <div style={{ position:"absolute", inset:0, background:"#050d18", zIndex:20, overflowY:"auto" }}>
            <DetailPanel stock={selected} onClose={()=>setShowDetail(false)} isMobile={true} />
          </div>
        )}

        {/* EXPLORER */}
        {!loading && !error && view==="explorer" && (
          <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
            <div style={{ flex:1, overflowY:"auto", padding:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <span style={{ fontSize:11, color:"#3a5060", fontFamily:"DM Mono,monospace" }}>{stocks.length} stocks · sorted by {sortBy==="iv_rank"?"IV Rank":"ADX"}</span>
                {data?.scanned_at && <span style={{ fontSize:10, color:"#2e4055", fontFamily:"DM Mono,monospace" }}>S&P 100</span>}
              </div>
              <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(276px,1fr))", gap:10 }}>
                {stocks.map((s,i) => (
                  <div key={s.ticker} style={{ animation:`fadeUp 0.3s ease ${i*0.03}s both` }}>
                    <StockCard stock={s} isSelected={selected?.ticker===s.ticker} onClick={()=>handleSelect(s)} />
                  </div>
                ))}
              </div>
            </div>
            {!isMobile && (
              <div style={{ width:268, background:"#060d1a", borderLeft:"1px solid #0e1c28", overflowY:"auto", flexShrink:0 }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            )}
          </div>
        )}

        {/* COMPASS */}
        {!loading && !error && view==="compass" && (
          <div style={{ flex:1, display:"flex", flexDirection:isMobile?"column":"row", overflow:"hidden" }}>
            <div style={{ flex:1, padding:14, overflowY:"auto" }}>
              <CompassChart stocks={stocks} selected={selected} onSelect={handleSelect} />
            </div>
            {!isMobile ? (
              <div style={{ width:268, background:"#060d1a", borderLeft:"1px solid #0e1c28", overflowY:"auto", flexShrink:0 }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            ) : selected && (
              <div style={{ borderTop:"1px solid #0e1c28", maxHeight:"42vh", overflowY:"auto" }}>
                <DetailPanel stock={selected} isMobile={false} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── STATUS BAR ── */}
      <div style={{ height:26, background:"#040b14", borderTop:"1px solid #0a1622", display:"flex", alignItems:"center", padding:"0 14px", gap:16, flexShrink:0 }}>
        <span style={{ fontSize:10, color: data?"#00d4aa":"#2e4055", fontFamily:"DM Mono,monospace" }}>
          {data ? `● ${data.total_results} results · auto-refresh 5min` : "○ Waiting for data"}
        </span>
        <span style={{ fontSize:10, color:"#1e3040", fontFamily:"DM Mono,monospace" }}>yfinance · 15min delayed</span>
        <span style={{ fontSize:10, color:"#1e3040", fontFamily:"DM Mono,monospace", marginLeft:"auto" }}>{new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
