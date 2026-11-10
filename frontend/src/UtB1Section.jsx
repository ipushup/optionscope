import { useEffect, useRef, useState } from "react";

/**
 * 05 / UT B1：每日「UT 當日轉多（B1）」嘅股票佔有效股票％，US 同 HK 兩條線，最近 30 個交易日。
 * 數據：watchlist_merged.json 嘅 ut_b1 = { days:[YYYY-MM-DD], US:[[pct,n,total]|null], HK:[...] }
 * 全部股票（約 992 隻）每次完整掃描後重新聚合。
 */
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
const COL = { US: "#4da3ff", HK: "#ff8a3d" };

function niceMax(v) {
  if (v <= 0) return 5;
  const steps = [4, 8, 12, 16, 20, 28, 40, 60, 80, 100];
  return steps.find((s) => s >= v * 1.1) || 100;
}

export default function UtB1Section({ wl, T }) {
  const d = wl && wl.ut_b1;
  const box = useRef(null);
  const [w, setW] = useState(340);
  const [sel, setSel] = useState(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el); setW(Math.max(240, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  });
  const has = d && d.days && d.days.length > 1;
  const days = has ? d.days : [];
  const H = 190, L = 30, R = 8, Tp = 10, B = 22, iw = w - L - R, ih = H - Tp - B;
  const vals = has ? ["US", "HK"].flatMap((k) => (d[k] || []).filter(Boolean).map((x) => x[0])) : [];
  const ymax = niceMax(vals.length ? Math.max(...vals) : 0);
  const X = (i) => L + (days.length > 1 ? (i / (days.length - 1)) * iw : 0);
  const Y = (v) => Tp + ih - (v / ymax) * ih;
  const path = (k) => {
    let s = "";   // 休市日冇數據：跳過嗰日，前後兩點直接連埋，線唔斷開
    (d[k] || []).forEach((x, i) => { if (!x) return; s += `${s ? "L" : "M"}${X(i).toFixed(1)},${Y(x[0]).toFixed(1)}`; });
    return s;
  };
  const lastOf = (k) => { const a = (d && d[k]) || []; for (let i = a.length - 1; i >= 0; i--) if (a[i]) return { i, x: a[i] }; return null; };
  const md = (s) => s.slice(5);
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - L) / iw) * (days.length - 1));
    setSel(Math.min(days.length - 1, Math.max(0, i)));
  };
  const cur = has ? (sel != null ? sel : days.length - 1) : null;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => +(ymax * f).toFixed(0));
  const lbl = has ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : [];
  const row = (k) => { const x = has ? d[k]?.[cur] : null; return x ? `${x[0].toFixed(1)}%（${x[1]}/${x[2]}）` : "休市／冇數據"; };

  return (
    <section aria-labelledby="s5">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 14 }}>
        <div id="s5" style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>05 / UT B1 · 30D</div>
        <div style={{ display: "flex", gap: 12, fontFamily: M, fontSize: 11 }}>
          {["US", "HK"].map((k) => <span key={k} style={{ display: "flex", alignItems: "center", gap: 5, color: T.dim }}><span style={{ width: 12, height: 3, borderRadius: 2, background: COL[k] }} />{k}</span>)}
        </div>
      </div>
      <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 12px 10px" }}>
        {!has ? (
          <div style={{ fontFamily: M, fontSize: 12, color: T.dim, padding: "6px 4px" }}>下次完整掃描後先會有數據（掃描器要先更新一次）。</div>
        ) : (
          <>
            <div style={{ fontFamily: SANS, fontSize: 12, color: T.dim, lineHeight: 1.5, marginBottom: 8 }}>
              每日「UT 當日轉多（B1）」嘅股票，佔該市場有效股票嘅百分比。撳／掃圖睇逐日數字。
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", fontFamily: M, fontSize: 11.5, marginBottom: 6, minHeight: 34 }}>
              <span style={{ color: T.mute }}>{md(days[cur])}</span>
              {["US", "HK"].map((k) => <span key={k} style={{ color: COL[k] }}>{k} {row(k)}</span>)}
            </div>
            <div ref={box} style={{ width: "100%" }}>
              <svg width={w} height={H} style={{ display: "block", touchAction: "pan-y" }} onPointerDown={pick} onPointerMove={(e) => { if (e.pointerType === "mouse" || e.buttons) pick(e); }}>
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={L} x2={w - R} y1={Y(t)} y2={Y(t)} stroke={T.line} strokeWidth="1" />
                    <text x={L - 5} y={Y(t) + 3} textAnchor="end" fontSize="9.5" fontFamily={M} fill={T.mute}>{t}%</text>
                  </g>
                ))}
                {lbl.map((i, k) => <text key={i} x={X(i)} y={H - 6} textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"} fontSize="9.5" fontFamily={M} fill={T.mute}>{md(days[i])}</text>)}
                {["US", "HK"].map((k) => <path key={k} d={path(k)} fill="none" stroke={COL[k]} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />)}
                <line x1={X(cur)} x2={X(cur)} y1={Tp} y2={Tp + ih} stroke={T.mute} strokeDasharray="2 3" strokeWidth="1" />
                {["US", "HK"].map((k) => { const x = d[k]?.[cur]; return x ? <circle key={k} cx={X(cur)} cy={Y(x[0])} r="3.2" fill={COL[k]} stroke={T.card} strokeWidth="1.2" /> : null; })}
              </svg>
            </div>
            <div style={{ fontFamily: M, fontSize: 10.5, color: T.mute, marginTop: 6 }}>
              最新：{["US", "HK"].map((k) => { const l = lastOf(k); return l ? `${k} ${md(days[l.i])} ${l.x[0].toFixed(1)}%` : `${k} –`; }).join(" · ")}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
