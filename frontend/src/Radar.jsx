// ═══════════════════════════════════════════════════════════════════════════
//  Radar.jsx — Turnaround Radar tab for OptionScope
//  ---------------------------------------------------------------------
//  Data flow (Solution A):
//    radar.json        → indicator/GATE/SCORE/VETO cards (computed after close)
//    radar_quotes.json → live prices incl. pre/post market (refreshed every few min)
//  The card content is static (closed-candle truth); prices and all *distances*
//  are recomputed live in the browser from the reference levels in card.levels.
//
//  Usage in App.jsx — 3 edits, see RADAR_INTEGRATION.md
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback } from "react";

const BASE        = process.env.PUBLIC_URL || "";
const RADAR_URL   = `${BASE}/radar.json`;
const QUOTES_URL  = `${BASE}/radar_quotes.json`;

const SCEN_COLOR = {
  S1: { c: "#00d4aa", bg: "#00d4aa1a", label: "S1 強勢延續" },
  S2: { c: "#f5a623", bg: "#f5a6231a", label: "S2 強勢修復" },
  S3: { c: "#ff8c42", bg: "#ff8c421a", label: "S3 轉勢初期" },
};
const CONCL_COLOR = { "concl-green": "#00d4aa", "concl-amber": "#f5a623", "concl-gray": "#6a8898" };
const SESSION_BADGE = {
  pre:     { t: "PRE",  c: "#f5a623" },
  regular: { t: "LIVE", c: "#00d4aa" },
  post:    { t: "POST", c: "#3b9eff" },
  closed:  { t: "CLS",  c: "#3a5060" },
};

const mono = "DM Mono,monospace";
const syne = "'Syne',sans-serif";

// ── live derivation: everything that depends on the current price ──────────
function derive(card, quote) {
  const L = card.levels || {};
  // effective live price: post > pre > regular > radar close
  const live =
    (quote?.post ?? null) ??
    (quote?.pre ?? null) ??
    (quote?.price ?? null) ??
    card.close;
  const session = quote?.post ? "post" : quote?.pre ? "pre" : (quote?.session || "closed");

  const pct = (lvl) => (lvl ? ((live / lvl - 1) * 100) : null);

  const stopDist   = pct(card.stop);
  const stopBroken = stopDist !== null && stopDist <= 0;
  const utDist     = pct(L.ut_stop);
  const utBroken   = utDist !== null && utDist <= 0;
  const ema10Dist  = pct(L.ema10d);
  const ema20Dist  = pct(L.ema20d);

  // 回踩 target for S1/S3 conclusions
  const pullbackLvl = card.scen === "S1" ? L.ema10d : L.ema20d;
  const pullbackDist = pct(pullbackLvl);
  // "at the buy zone" = price within 1% above the pullback level (or below it)
  const atBuyZone = pullbackDist !== null && pullbackDist <= 1.0 && !stopBroken;

  const vsClose = card.close ? (live / card.close - 1) * 100 : 0;

  // live status overrides the static conclusion when something material changed
  let status = card.concl, statusColor = CONCL_COLOR[card.concl_cls] || "#6a8898";
  if (stopBroken)      { status = "🔴 已穿止蝕 — 離場";  statusColor = "#ff5c5c"; }
  else if (utBroken)   { status = "🟠 穿 UT Bot 止損";   statusColor = "#ff8c42"; }
  else if (atBuyZone)  { status = "🟢 已到買入區";       statusColor = "#00d4aa"; }

  // 距止蝕太遠 = 追高，risk/reward 差（止蝕位一觸即損失 >15%）
  const chaseRisk = !stopBroken && stopDist !== null && stopDist > 15;

  return { live, session, vsClose, stopDist, stopBroken, utDist, utBroken,
           ema10Dist, ema20Dist, pullbackLvl, pullbackDist, atBuyZone, chaseRisk,
           status, statusColor };
}

const f2 = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));
const pctTxt = (v) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

// ── LIST CARD ─────────────────────────────────────────────────────────────
function RadarListCard({ card, quote, onClick }) {
  const d  = derive(card, quote);
  const sc = SCEN_COLOR[card.scen];
  const sb = SESSION_BADGE[d.session] || SESSION_BADGE.closed;
  const gatePct = (card.gate_n / 4) * 100;

  return (
    <div onClick={onClick} style={{
      background: "#0a1828", border: `1px solid ${d.stopBroken ? "#ff5c5c55" : "#1a2e40"}`,
      borderRadius: 10, padding: "10px 12px", cursor: "pointer",
      borderLeft: `3px solid ${sc.c}`,
    }}>
      {/* header row */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 17, fontWeight: 900, color: "#fff", fontFamily: syne }}>{card.ticker}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#aaccee", fontFamily: mono }}>{f2(d.live)}</span>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: mono,
                       color: d.vsClose >= 0 ? "#00d4aa" : "#ff5c5c" }}>{pctTxt(d.vsClose)}</span>
        <span style={{ fontSize: 8, fontWeight: 800, fontFamily: mono, color: sb.c,
                       border: `1px solid ${sb.c}55`, borderRadius: 4, padding: "1px 4px" }}>{sb.t}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9, fontWeight: 800, fontFamily: mono, color: sc.c,
                       background: sc.bg, borderRadius: 5, padding: "2px 6px" }}>{card.scen}</span>
      </div>

      {/* live status */}
      <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, fontFamily: mono, color: d.statusColor }}>
        {d.status}
      </div>

      {/* metrics strip */}
      <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <Metric label="GATE" value={`${card.gate_n}/4`} color={card.gate_n === 4 ? "#00d4aa" : "#f5a623"} />
        <Metric label="SCORE" value={`${card.score}/${card.max_score}`} color="#3b9eff" />
        <Metric label={card.scen === "S1" ? "vs EMA10" : "vs EMA20"}
                value={pctTxt(d.pullbackDist)}
                color={d.atBuyZone ? "#00d4aa" : "#8aaabb"} />
        <Metric label="vs 止蝕" value={pctTxt(d.stopDist)}
                color={d.stopBroken ? "#ff5c5c" : d.chaseRisk ? "#ff8c42"
                       : (d.stopDist < 3 ? "#f5a623" : "#8aaabb")} />
        {d.chaseRisk && <Metric label="RISK" value="追高" color="#ff8c42" />}
        {card.warn_n > 0 && <Metric label="VETO" value={`⚠×${card.warn_n}`} color="#f5a623" />}
      </div>

      {/* gate bar */}
      <div style={{ marginTop: 8, height: 3, background: "#162030", borderRadius: 2 }}>
        <div style={{ width: `${gatePct}%`, height: "100%", borderRadius: 2,
                      background: card.gate_n === 4 ? "#00d4aa" : "#f5a623" }} />
      </div>
    </div>
  );
}

function Metric({ label, value, color }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 8, color: "#5a7a90", fontFamily: mono, letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: 700, color, fontFamily: mono }}>{value}</div>
    </div>
  );
}

// ── DETAIL OVERLAY ────────────────────────────────────────────────────────
function CondRow({ ok, name, detail, scoreTxt }) {
  return (
    <div style={{ display: "flex", gap: 7, padding: "3px 0", borderBottom: "1px solid #0e1c28", alignItems: "flex-start" }}>
      <span style={{ width: 26, flexShrink: 0, fontSize: 10, fontFamily: mono, textAlign: "center",
                     color: ok ? "#00d4aa" : "#4a6070" }}>
        {scoreTxt ?? (ok ? "✅" : "❌")}
      </span>
      <span style={{ width: 108, flexShrink: 0, fontSize: 10.5, fontFamily: mono,
                     color: ok ? "#ccddee" : "#5a7a90" }}>{name}</span>
      <span style={{ flex: 1, fontSize: 10.5, fontFamily: mono, color: "#7a9ab8", lineHeight: 1.45 }}>{detail}</span>
    </div>
  );
}

function Block({ title, children }) {
  return (
    <div style={{ padding: "10px 12px", background: "#0a1828", borderRadius: 10, border: "1px solid #1a2e40", marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "#3b9eff", fontFamily: mono,
                    letterSpacing: 1, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function RadarDetail({ card, quote, onClose }) {
  const d  = derive(card, quote);
  const sc = SCEN_COLOR[card.scen];
  const L  = card.levels || {};
  const sb = SESSION_BADGE[d.session] || SESSION_BADGE.closed;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#040b14", zIndex: 60,
      display: "flex", flexDirection: "column", overflow: "hidden",
      paddingTop: "env(safe-area-inset-top, 44px)",
    }}>
      {/* header */}
      <div style={{ background: "#050c18", borderBottom: "1px solid #0a1826", padding: "10px 12px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={onClose} style={{ background: "#0d3060", border: "none", borderRadius: 7,
            color: "#88bbee", fontSize: 15, fontWeight: 700, cursor: "pointer", padding: "4px 10px" }}>←</button>
          <span style={{ fontSize: 20, fontWeight: 900, color: "#fff", fontFamily: syne }}>{card.ticker}</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#aaccee", fontFamily: mono }}>{f2(d.live)}</span>
          <span style={{ fontSize: 12, fontWeight: 700, fontFamily: mono,
                         color: d.vsClose >= 0 ? "#00d4aa" : "#ff5c5c" }}>{pctTxt(d.vsClose)}</span>
          <span style={{ fontSize: 8, fontWeight: 800, fontFamily: mono, color: sb.c,
                         border: `1px solid ${sb.c}55`, borderRadius: 4, padding: "1px 4px" }}>{sb.t}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 9, fontWeight: 800, color: sc.c, background: sc.bg,
                         borderRadius: 6, padding: "3px 8px", fontFamily: mono }}>{card.scen_name}</span>
        </div>

        {/* live status banner */}
        <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 8,
                      background: `${d.statusColor}18`, border: `1px solid ${d.statusColor}44`,
                      fontSize: 12, fontWeight: 700, fontFamily: mono, color: d.statusColor }}>
          {d.status}
        </div>

        {/* pre/post detail line */}
        {(quote?.pre || quote?.post) && (
          <div style={{ marginTop: 5, fontSize: 10, fontFamily: mono, color: "#7a9ab8", display: "flex", gap: 12 }}>
            {quote.pre  && <span>PRE {f2(quote.pre)} <b style={{ color: quote.pre_pct >= 0 ? "#00d4aa" : "#ff5c5c" }}>{pctTxt(quote.pre_pct)}</b></span>}
            {quote.price && <span>REG {f2(quote.price)} <b style={{ color: quote.chg_pct >= 0 ? "#00d4aa" : "#ff5c5c" }}>{pctTxt(quote.chg_pct)}</b></span>}
            {quote.post && <span>POST {f2(quote.post)} <b style={{ color: quote.post_pct >= 0 ? "#00d4aa" : "#ff5c5c" }}>{pctTxt(quote.post_pct)}</b></span>}
          </div>
        )}
      </div>

      {/* body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>

        {/* LIVE LEVELS — the whole point of the web version */}
        <Block title="📍 現價位置 · LIVE LEVELS">
          <LevelRow label="買入區"    lvl={d.pullbackLvl} dist={d.pullbackDist} live={d.live}
                    note={card.scen === "S1" ? "Daily EMA10" : "Daily EMA20"} good={d.atBuyZone} />
          <LevelRow label={card.stop_label} lvl={card.stop} dist={d.stopDist} live={d.live}
                    note="止蝕" bad={d.stopBroken} />
          <LevelRow label="UT Bot 止損" lvl={L.ut_stop} dist={d.utDist} live={d.live} bad={d.utBroken} />
          <LevelRow label="Daily EMA20" lvl={L.ema20d} dist={d.ema20Dist} live={d.live} />
          <LevelRow label="Daily EMA50" lvl={L.ema50d} dist={d.live && L.ema50d ? (d.live / L.ema50d - 1) * 100 : null} live={d.live} />
          {L.ch_upper && <LevelRow label="下降通道上軌" lvl={L.ch_upper}
                    dist={(d.live / L.ch_upper - 1) * 100} live={d.live} note="阻力" />}
          <div style={{ marginTop: 7, fontSize: 9.5, color: "#5a7a90", fontFamily: mono, lineHeight: 1.5 }}>
            指標數值（KDJ J={L.kdj_j ?? "—"} · CMF {L.cmf_d} · BigChing {L.bigching}/7）為收市值 —
            價格與距離為即時。
          </div>
        </Block>

        <Block title={`🎯 SCENARIO — ${card.scen} · 倉位 ${card.position}`}>
          {card.scen_rows.map(([n, ok, v], i) => <CondRow key={i} ok={ok} name={n} detail={v} />)}
        </Block>

        <Block title={`🚪 GATE ${card.gate_n}/4`}>
          {card.gates.map(([n, ok, v], i) => <CondRow key={i} ok={ok} name={n} detail={v} />)}
        </Block>

        <Block title={`⭐ SCORE ${card.score}/${card.max_score}`}>
          {card.scores.map(([n, p, m, v], i) =>
            <CondRow key={i} ok={p > 0} name={n} detail={v} scoreTxt={`${p}/${m}`} />)}
        </Block>

        {card.vetoes.length > 0 && (
          <Block title={`⚠️ VETO — ${card.vetoes.length} 項`}>
            {card.vetoes.map(([ic, n, v], i) =>
              <CondRow key={i} ok={ic === "ℹ️"} name={n} detail={v} scoreTxt={ic} />)}
          </Block>
        )}

        <div style={{ padding: "10px 12px", background: "#0a1828", borderRadius: 10,
                      border: "1px solid #1a2e40", marginBottom: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#3b9eff", fontFamily: mono,
                        letterSpacing: 1, marginBottom: 5 }}>💡 買入邏輯</div>
          <div style={{ fontSize: 11.5, color: "#ccddee", fontFamily: mono, lineHeight: 1.6 }}>{card.buy_logic}</div>
        </div>
      </div>
    </div>
  );
}

function LevelRow({ label, lvl, dist, live, note, good, bad }) {
  if (!lvl) return null;
  const color = bad ? "#ff5c5c" : good ? "#00d4aa" : (Math.abs(dist) < 2 ? "#f5a623" : "#7a9ab8");
  const above = live >= lvl;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
                  borderBottom: "1px solid #0e1c28" }}>
      <span style={{ width: 96, flexShrink: 0, fontSize: 10.5, fontFamily: mono, color: "#8aaabb" }}>{label}</span>
      <span style={{ width: 62, flexShrink: 0, fontSize: 11, fontFamily: mono, color: "#ccddee" }}>{f2(lvl)}</span>
      <span style={{ fontSize: 11, fontWeight: 700, fontFamily: mono, color }}>
        {above ? "▲" : "▼"} {pctTxt(dist)}
      </span>
      <div style={{ flex: 1 }} />
      {note && <span style={{ fontSize: 9, fontFamily: mono, color: "#5a7a90" }}>{note}</span>}
    </div>
  );
}

// ── MAIN RADAR VIEW ───────────────────────────────────────────────────────
export default function RadarView({ isMobile }) {
  const [radar, setRadar]     = useState(null);
  const [quotes, setQuotes]   = useState({});
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [filterScen, setFilterScen] = useState("all");

  const loadRadar = useCallback(async () => {
    try {
      const r = await fetch(`${RADAR_URL}?t=${Date.now()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRadar(await r.json());
      setError(null);
    } catch { setError("No radar data yet."); }
    finally { setLoading(false); }
  }, []);

  const loadQuotes = useCallback(async () => {
    try {
      const r = await fetch(`${QUOTES_URL}?t=${Date.now()}`);
      if (r.ok) { const j = await r.json(); setQuotes(j.quotes || {}); }
    } catch { /* quotes are optional — cards still render on close price */ }
  }, []);

  useEffect(() => { loadRadar(); loadQuotes(); }, [loadRadar, loadQuotes]);
  // radar itself changes once a day; quotes refresh often
  useEffect(() => {
    const t = setInterval(loadQuotes, 60 * 1000);
    return () => clearInterval(t);
  }, [loadQuotes]);

  const cards = (radar?.cards || []).filter(c => filterScen === "all" || c.scen === filterScen);

  // ⚠️ ALERTS — anything that broke its stop / UT Bot floats to the top.
  // These are positions you may already hold: most urgent info, so it goes first.
  const alerts = cards.filter(c => {
    const d = derive(c, quotes[c.ticker]);
    return d.stopBroken || d.utBroken;
  });
  const alertSet = new Set(alerts.map(c => c.ticker));
  const rest = cards.filter(c => !alertSet.has(c.ticker));
  const grouped = ["S1", "S2", "S3"]
    .map(s => [s, rest.filter(c => c.scen === s)])
    .filter(([, a]) => a.length);

  if (loading) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 34, height: 34, border: "3px solid #0e1c28", borderTopColor: "#3b9eff",
                    borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
    </div>
  );

  if (error) return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
                  justifyContent: "center", gap: 12, padding: 24 }}>
      <div style={{ fontSize: 40 }}>📡</div>
      <div style={{ color: "#3b9eff", fontFamily: syne, fontSize: 16, fontWeight: 700 }}>No radar data yet</div>
      <div style={{ color: "#8aaabb", fontFamily: mono, fontSize: 11, textAlign: "center", lineHeight: 1.8 }}>
        GitHub Actions → Turnaround Radar → Run workflow
      </div>
    </div>
  );

  const sc = radar.scen_counts || {};

  return (
    <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "10px 10px 20px" }}>
      {detail && <RadarDetail card={detail} quote={quotes[detail.ticker]} onClose={() => setDetail(null)} />}

      {/* funnel summary */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        {[["all", `全部 ${radar.total_cards}`, "#3b9eff"],
          ["S1", `S1 ${sc.S1 || 0}`, SCEN_COLOR.S1.c],
          ["S2", `S2 ${sc.S2 || 0}`, SCEN_COLOR.S2.c],
          ["S3", `S3 ${sc.S3 || 0}`, SCEN_COLOR.S3.c]].map(([id, label, color]) => (
          <button key={id} onClick={() => setFilterScen(id)} style={{
            padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontFamily: mono,
            fontSize: 10, fontWeight: 700,
            border: `1px solid ${filterScen === id ? color : "#1a2e40"}`,
            background: filterScen === id ? `${color}22` : "#080f1c",
            color: filterScen === id ? color : "#5a7a90",
          }}>{label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "#5a7a90", fontFamily: mono }}>
          Universe {radar.universe} · 收市 {radar.scanned_at ? new Date(radar.scanned_at).toLocaleDateString() : "—"}
        </span>
      </div>

      {alerts.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#ff5c5c", fontFamily: mono,
                        letterSpacing: 1, marginBottom: 6, paddingLeft: 2 }}>
            ⚠️ 警報 · {alerts.length} 隻 — 已穿止蝕或 UT Bot 止損
          </div>
          <div style={{ display: "grid", gap: 8,
                        gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill,minmax(320px,1fr))" }}>
            {alerts.map(c => (
              <RadarListCard key={c.ticker} card={c} quote={quotes[c.ticker]} onClick={() => setDetail(c)} />
            ))}
          </div>
        </div>
      )}

      {grouped.length === 0 && alerts.length === 0 && (
        <div style={{ color: "#5a7a90", fontFamily: mono, fontSize: 12, textAlign: "center", padding: 30 }}>
          今日無符合條件嘅股票
        </div>
      )}

      {grouped.map(([s, list]) => (
        <div key={s} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: SCEN_COLOR[s].c, fontFamily: mono,
                        letterSpacing: 1, marginBottom: 6, paddingLeft: 2 }}>
            {SCEN_COLOR[s].label} · {list.length} 隻 · 倉位 {radar.scen_meta?.[s]?.pos}
          </div>
          <div style={{ display: "grid", gap: 8,
                        gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill,minmax(320px,1fr))" }}>
            {list.map(c => (
              <RadarListCard key={c.ticker} card={c} quote={quotes[c.ticker]} onClick={() => setDetail(c)} />
            ))}
          </div>
        </div>
      ))}

      <div style={{ fontSize: 9, color: "#3a5060", fontFamily: mono, textAlign: "center",
                    marginTop: 14, lineHeight: 1.6 }}>
        指標為 closed candle 收市值 · 價格及距離即時更新（1 分鐘刷新）<br />
        🔴 已穿止蝕 · 🟢 已到買入區 · 🟠 追高（距止蝕 &gt;15%，risk/reward 差）
      </div>
    </div>
  );
}
