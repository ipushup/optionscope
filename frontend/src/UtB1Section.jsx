import { useEffect, useRef, useState } from "react";

/**
 * 05 / UT B1·S1：每日「UT 當日轉多（B1）／當日轉空（S1）」嘅股票佔該市場有效股票％。
 * 上 US、下 HK 兩格；每日一支向上柱（B1）+ 一支向下柱（S1），白線 = 淨值（B1% − S1%）。最近 30 個交易日。
 * 數據：watchlist_merged.json 嘅 ut_b1 = { days:[YYYY-MM-DD], US:[[b%, bN, total, s%, sN]|null], HK:[...] }
 * （舊版數據冇 s% / sN：只畫 B1，等下次完整掃描就有 S1）
 */
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";

function niceMax(v, cnt) {
  const steps = cnt ? [2, 4, 8, 12, 16, 20, 30, 40, 60, 80, 120, 200] : [4, 8, 12, 16, 20, 28, 40, 60, 80, 100];
  if (v <= 0) return steps[0];
  return steps.find((s) => s >= v * 1.1) || steps[steps.length - 1];
}

export default function UtB1Section({ wl, T }) {
  const d = wl && wl.ut_b1;
  const box = useRef(null);
  const [w, setW] = useState(340);
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState(() => { try { return localStorage.getItem("os_b1_mode") === "TB" ? "TB" : "UT"; } catch { return "UT"; } });
  const pickMode = (m) => { setMode(m); try { localStorage.setItem("os_b1_mode", m); } catch { /* 無痕模式 */ } };
  const TBM = mode === "TB";
  const rowsOf = (k) => (TBM ? (d && d.tb && d.tb[k]) || [] : (d && d[k]) || []);
  const bv = (x) => (TBM ? x[1] : x[0]);   // 向上柱：UT = B1 佔比％；TB = 買入確認隻數
  const sv = (x) => (x[3] == null ? null : TBM ? x[4] : x[3]);
  const LB = TBM ? ["TB", "TS"] : ["B1", "S1"], UNIT = TBM ? "" : "%";
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el); setW(Math.max(240, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  });
  const has = d && d.days && d.days.length > 1 && (!TBM || !!d.tb);
  const days = d && d.days && d.days.length > 1 ? d.days : [];
  const hasS = has && ["US", "HK"].some((k) => rowsOf(k).some((x) => x && x[3] != null));
  const PH = 112, GAP = 20, L = 34, R = 6, Tp = 8, B = 34, iw = w - L - R;
  const H = Tp + PH * 2 + GAP + B;
  const all = has ? ["US", "HK"].flatMap((k) => rowsOf(k).filter(Boolean).flatMap((x) => [bv(x), sv(x) || 0])) : [];
  const ymax = niceMax(all.length ? Math.max(...all) : 0, TBM);
  const slot = days.length ? iw / days.length : iw;
  const X = (i) => L + slot * (i + 0.5);
  const top = (pi) => Tp + pi * (PH + GAP);
  const zero = (pi) => top(pi) + PH / 2;
  const Y = (pi, v) => zero(pi) - (v / ymax) * (PH / 2);   // v 可正可負
  const cur = has ? (sel != null ? sel : days.length - 1) : null;
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - L) / slot);
    setSel(Math.min(days.length - 1, Math.max(0, i)));
  };
  const md = (s) => s.slice(5);
  const lastOf = (k) => { const a = rowsOf(k); for (let i = a.length - 1; i >= 0; i--) if (a[i]) return { i, x: a[i] }; return null; };
  const rowText = (k) => {
    const x = has ? rowsOf(k)[cur] : null;
    if (!x) return <span style={{ color: T.mute }}>休市／冇數據</span>;
    const net = x[3] != null ? (TBM ? x[1] - x[4] : x[0] - x[3]) : null;
    return (
      <>
        <span style={{ color: T.up }}>{LB[0]} {TBM ? `${x[1]} 隻（${x[0].toFixed(1)}%）` : `${x[0].toFixed(1)}%（${x[1]}）`}</span>
        {x[3] != null && <span style={{ color: T.dn, marginLeft: 8 }}>{LB[1]} {TBM ? `${x[4]} 隻（${x[3].toFixed(1)}%）` : `${x[3].toFixed(1)}%（${x[4]}）`}</span>}
        {net != null && <span style={{ color: T.txt, marginLeft: 8 }}>淨 {net >= 0 ? "+" : "−"}{Math.abs(net).toFixed(TBM ? 0 : 1)}</span>}
        {ixText(k)}
      </>
    );
  };
  const IDXN = { US: "SPX", HK: "HSI" };
  const ix = (d && d.idx) || {};
  const ixVals = (k) => (ix[k] || []).filter((v) => v != null);
  const ixY = (k, pi, v) => { const a = ixVals(k), lo = Math.min(...a), hi = Math.max(...a); return top(pi) + 6 + (1 - (hi === lo ? 0.5 : (v - lo) / (hi - lo))) * (PH - 12); };   // 每格自己 min–max 拉伸，只睇形態
  const ixPath = (k, pi) => { let s = ""; (ix[k] || []).forEach((v, i) => { if (v == null) return; s += `${s ? "L" : "M"}${X(i).toFixed(1)},${ixY(k, pi, v).toFixed(1)}`; }); return s; };
  const ixText = (k) => {
    const a = ix[k] || [], v = a[cur];
    if (v == null) return null;
    let prev = null; for (let j = cur - 1; j >= 0; j--) if (a[j] != null) { prev = a[j]; break; }
    const c = prev ? ((v / prev - 1) * 100) : null;
    return <span style={{ color: T.dim, marginLeft: 8 }}>{IDXN[k]} {v.toLocaleString("en-US", { maximumFractionDigits: 0 })}{c != null && <span style={{ color: c >= 0 ? T.up : T.dn }}> {c >= 0 ? "+" : "−"}{Math.abs(c).toFixed(2)}%</span>}</span>;
  };
  const netPath = (k, pi) => {
    let s = "";   // 休市日冇數據：前後兩點直接連埋
    rowsOf(k).forEach((x, i) => { if (!x || x[3] == null) return; s += `${s ? "L" : "M"}${X(i).toFixed(1)},${Y(pi, bv(x) - sv(x)).toFixed(1)}`; });
    return s;
  };

  return (
    <section aria-labelledby="s5">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 14 }}>
        <div id="s5" style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>05 / {TBM ? "TRIPLE BAND TB · TS" : "UT B1 · S1"} · 60D</div>
        <div style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: 6, overflow: "hidden" }}>
          {["UT", "TB"].map((m) => (
            <button key={m} type="button" onClick={() => pickMode(m)} style={{ fontFamily: M, fontSize: 11, fontWeight: 400, padding: "2px 12px", border: 0, cursor: "pointer", background: mode === m ? T.line : "transparent", color: mode === m ? T.txt : T.mute }}>{m}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, fontFamily: M, fontSize: 11, color: T.dim }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: T.up }} />{LB[0]}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: T.dn }} />{LB[1]}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 2, background: T.txt }} />淨值</span>
          {d && d.idx && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 0, borderTop: `2px dashed ${T.acc || T.dim}` }} />指數</span>}
        </div>
      </div>
      <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 12px 10px" }}>
        {!has ? (
          <div style={{ fontFamily: M, fontSize: 12, color: T.dim, padding: "6px 4px" }}>{d && d.days && !d.tb && TBM ? "TB 數據要等下次完整掃描先會有。" : "下次完整掃描後先會有數據（掃描器要先更新一次）。"}</div>
        ) : (
          <>
            <div style={{ fontFamily: SANS, fontSize: 12, color: T.dim, lineHeight: 1.5, marginBottom: 8 }}>
              {TBM ? "每日 Triple Band 真實買入確認（TB，向上）／賣出（TS，向下）嘅股票隻數（TBskip 唔計）；白線 = TB − TS，" : "每日 UT 當日轉多（B1，向上）／轉空（S1，向下）嘅股票，佔該市場有效股票％；白線 = B1 − S1，"}虛線 = 指數（SPX／恒指，只睇形態）。撳／掃圖睇逐日數字。
              {!hasS && <span style={{ color: T.mute }}>（S1 要等下次完整掃描先有）</span>}
            </div>
            <div style={{ fontFamily: M, fontSize: 11.5, lineHeight: 1.6, marginBottom: 6, minHeight: 90 }}>
              <div style={{ color: T.mute }}>{md(days[cur])}</div>
              {["US", "HK"].map((k) => <div key={k}><span style={{ color: T.dim, marginRight: 6 }}>{k}</span>{rowText(k)}</div>)}
            </div>
            <div ref={box} style={{ width: "100%" }}>
              <svg width={w} height={H} style={{ display: "block", touchAction: "pan-y" }} onPointerDown={pick} onPointerMove={(e) => { if (e.pointerType === "mouse" || e.buttons) pick(e); }}>
                <rect x={X(cur) - slot / 2} y={Tp} width={slot} height={PH * 2 + GAP} fill={T.mute} opacity="0.16" rx="2" />
                {["US", "HK"].map((k, pi) => (
                  <g key={k}>
                    {[ymax, 0, -ymax].map((t) => (
                      <g key={t}>
                        <line x1={L} x2={w - R} y1={Y(pi, t)} y2={Y(pi, t)} stroke={T.line} strokeWidth={t === 0 ? 1.2 : 1} opacity={t === 0 ? 1 : 0.6} />
                        <text x={L - 5} y={Y(pi, t) + 3} textAnchor="end" fontSize="9" fontFamily={M} fill={T.mute}>{t > 0 ? "+" : t < 0 ? "−" : ""}{Math.abs(t)}{UNIT}</text>
                      </g>
                    ))}
                    {ixVals(k).length > 1 && <path d={ixPath(k, pi)} fill="none" stroke={T.acc || T.dim} strokeWidth="1.4" strokeDasharray="3 2" strokeLinejoin="round" opacity="0.75" />}
                    <text x={L + 4} y={top(pi) + 11} fontSize="10" fontFamily={M} fontWeight="700" fill={T.dim}>{k}</text>
                    {days.map((dt, i) => {
                      const x = rowsOf(k)[i];
                      if (!x) return null;
                      const bw = Math.max(1.5, Math.min(9, slot - 1.2));
                      const hb = bv(x) > 0 ? Math.max(1, (bv(x) / ymax) * (PH / 2)) : 0;
                      const hs = sv(x) > 0 ? Math.max(1, (sv(x) / ymax) * (PH / 2)) : 0;
                      return (
                        <g key={dt}>
                          {hb > 0 && <rect x={X(i) - bw / 2} y={zero(pi) - hb} width={bw} height={hb} rx="1" fill={T.up} />}
                          {hs > 0 && <rect x={X(i) - bw / 2} y={zero(pi)} width={bw} height={hs} rx="1" fill={T.dn} />}
                        </g>
                      );
                    })}
                    {hasS && <path d={netPath(k, pi)} fill="none" stroke={T.txt} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />}
                  </g>
                ))}
                {days.map((dt, i) => {
                  const mo = parseInt(dt.slice(5, 7), 10), dd = parseInt(dt.slice(8, 10), 10);
                  const newMonth = i === 0 || dt.slice(5, 7) !== days[i - 1].slice(5, 7);
                  if (!(newMonth || i % 5 === 0 || i === days.length - 1 || i === cur)) return null;   // 60 日：每 5 日標一次，換月加月份
                  if (!newMonth && !(i === days.length - 1 || i === cur) && i > days.length - 4) return null;   // 避免尾段同最新日期擠埋一齊
                  return (
                    <g key={dt}>
                      <text x={X(i)} y={H - 18} textAnchor="middle" fontSize="7.5" letterSpacing="-0.3" fontFamily={M} fill={i === cur ? T.txt : T.mute}>{dd}</text>
                      {newMonth && <text x={X(i)} y={H - 6} textAnchor={i === 0 ? "start" : "middle"} fontSize="8.5" fontFamily={M} fill={T.dim}>{mo}月</text>}
                    </g>
                  );
                })}
              </svg>
            </div>
            <div style={{ fontFamily: M, fontSize: 10.5, color: T.mute, marginTop: 6 }}>
              最新：{["US", "HK"].map((k) => { const l = lastOf(k); return l ? `${k} ${md(days[l.i])} ${LB[0]} ${TBM ? l.x[1] : `${l.x[0].toFixed(1)}%`}${l.x[3] != null ? ` ${LB[1]} ${TBM ? l.x[4] : `${l.x[3].toFixed(1)}%`}` : ""}` : `${k} –`; }).join(" · ")}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
