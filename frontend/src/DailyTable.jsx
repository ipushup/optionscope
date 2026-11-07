import { useEffect, useMemo, useState } from "react";

/**
 * DailyTable.jsx — 日線狀態表（daily brief 嘅 Signal Dashboard，Longbridge 即時價）
 * 讀 /daily.json（scanner/daily_table.py 每 ~60 秒出）：每隻股 ST / UT / EMA / Whale / 量能 / RSI / ATR。
 * 今日 bar 未收線嗰陣，ST 翻轉／UT 觸發會標「未收線」，收市前可能改變。
 */
const URL_ = "/daily.json";
const THEMES = {
  dark: { bg: "#0f1112", card: "#151718", line: "#26292c", soft: "#1d1f21", txt: "#e3e4e5", dim: "#9b9b9e", mute: "#75777a", up: "#14ac9c", dn: "#f23c75", warn: "#f5a623", acc: "#3b9eff", upBg: "rgba(20,172,156,.16)", dnBg: "rgba(242,60,117,.16)" },
  light: { bg: "#f3f4f6", card: "#ffffff", line: "#d9dde2", soft: "#e8ebef", txt: "#1b1f24", dim: "#56606b", mute: "#6b7580", up: "#00875a", dn: "#c81e3f", warn: "#a55a00", acc: "#0b6bcb", upBg: "rgba(0,135,90,.10)", dnBg: "rgba(200,30,63,.09)" },
};
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";   // 數字/標籤字體：iOS 系統字 (SF Pro)，同 Longbridge app 一致；配 tabular-nums
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";

const hk = iso => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return `${p.hour}:${p.minute}:${p.second} HKT`;
  } catch { return ""; }
};
const sigRank = r => (r.sig === "BUY" ? 0 : r.sig === "SELL" ? 1 : 2);
const emaScore = r => r.ema.filter(e => e.valid && e.above).length;
const whaleScore = r => r.whale.reduce((s, w) => s + (w.type === "P" ? w.val : w.type === "U" ? -w.val : 0), 0);
const KEYS = {
  sym: r => r.sym, px: r => r.chg ?? -999, sig: r => sigRank(r), st: r => (r.st.t === "Up" ? 1 : -1) * (1000 - r.st.days),
  ut: r => (r.ut.pos === "L" ? 1 : -1) * (1000 - (r.ut.days ?? 999)), ema: emaScore, whale: whaleScore, vol: r => r.vol.ratio ?? 0, rsi: r => r.rsi.val ?? 0, atr: r => r.atr ?? 0,
};

export default function DailyTable({ isMobile, light }) {
  const T = light ? THEMES.light : THEMES.dark;
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [f, setF] = useState("all");            // all | BUY | SELL | ideal | today
  const [sec, setSec] = useState("all");
  const [q, setQ] = useState("");
  const [sk, setSk] = useState("sig");
  const [sd, setSd] = useState(1);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const pull = () => fetch(URL_, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`daily.json ${r.status}`); return r.json(); })
      .then(j => { if (alive) { setData(j); setErr(null); } })
      .catch(e => alive && setErr(String(e.message || e)));
    pull(); const id = setInterval(pull, 15000);
    const id2 = setInterval(() => setNow(Date.now()), 10000);
    return () => { alive = false; clearInterval(id); clearInterval(id2); };
  }, []);

  const rows = data?.rows || [];
  const secs = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.section && !m.has(r.section)) m.set(r.section, r.section.replace(/^\d+-/, ""));
    return [...m];
  }, [rows]);
  const counts = useMemo(() => ({
    buy: rows.filter(r => r.sig === "BUY").length, sell: rows.filter(r => r.sig === "SELL").length,
    ideal: rows.filter(r => r.ideal).length, live: rows.filter(r => r.sig && r.live).length,
  }), [rows]);

  const shown = useMemo(() => {
    const k = q.trim().toUpperCase();
    const get = KEYS[sk] || KEYS.sig;
    return rows.filter(r => (!k || r.sym.includes(k)) && (sec === "all" || r.section === sec) &&
      (f === "all" || (f === "ideal" ? r.ideal : f === "today" ? !!r.sig : r.sig === f)))
      .sort((a, b) => {
        const x = get(a), y = get(b);
        const c = (typeof x === "string" ? x.localeCompare(y) : x - y) * sd;
        return c || sigRank(a) - sigRank(b) || a.sym.localeCompare(b.sym);
      });
  }, [rows, f, sec, q, sk, sd]);

  const age = data ? (now - new Date(data.updated).getTime()) / 1000 : 0;
  const chip = (on, extra) => ({ background: on ? T.soft : "transparent", color: on ? T.txt : T.dim, border: `1px solid ${on ? T.line : "transparent"}`, borderRadius: 7, padding: isMobile ? "5px 7px" : "5px 10px", fontFamily: M, fontSize: 12, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap", ...extra });
  const th = { textAlign: "left", padding: "9px 10px", color: T.mute, fontWeight: 500, fontSize: 11, borderBottom: `1px solid ${T.line}`, position: "sticky", top: 0, background: T.card, whiteSpace: "nowrap", zIndex: 2, fontFamily: SANS };
  const td = { padding: "9px 10px", borderBottom: `1px solid ${T.soft}`, fontSize: 12.5, fontFamily: M, whiteSpace: "nowrap", verticalAlign: "middle" };
  const COLS = [["sym", "Symbol"], ["px", "現價 / %Chg"], ["sig", "Signal"], ["st", "ST"], ["ut", "UT"], ["ema", "EMA 10/20/50/89/250"], ["whale", "Whale（近 5 日）"], ["vol", "量能"], ["rsi", "RSI"], ["atr", "ATR"]];
  const sortBy = k => { if (sk === k) setSd(-sd); else { setSk(k); setSd(k === "sym" || k === "sig" ? 1 : -1); } };
  const pill = (bg, col) => ({ display: "inline-block", fontFamily: M, fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: bg, color: col });
  const tile = (label, val, col) => (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: "9px 12px", minWidth: 0 }}>
      <div style={{ fontFamily: SANS, fontSize: 11, color: T.mute, letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontFamily: M, fontSize: 22, fontWeight: 500, color: col, marginTop: 2 }}>{val}</div>
    </div>);

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.txt, fontFamily: SANS, padding: isMobile ? "14px 7px 40px" : "22px 28px 40px", boxSizing: "border-box", width: "100%", maxWidth: "100vw", overflowX: "hidden" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px", marginBottom: 12 }}>
        <span style={{ fontFamily: M, fontSize: 12, color: T.dim }}>
          {err ? `⚠ ${err}` : data ? <><span style={{ color: age > 300 ? T.dn : T.up }}>●</span> {hk(data.updated)} · {data.n} 隻{age > 300 ? ` · ⚠ ${Math.round(age / 60)} 分鐘冇更新` : ""}</> : "loading…"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,minmax(0,1fr))" : "repeat(4,minmax(0,1fr))", gap: 10, marginBottom: 12 }}>
        {tile("BUY", counts.buy, T.up)}{tile("SELL", counts.sell, T.dn)}{tile("★ IDEAL", counts.ideal, T.warn)}{tile("今日信號（未收線）", counts.live, T.txt)}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        {[["all", "全部"], ["today", "今日信號"], ["BUY", "BUY"], ["SELL", "SELL"], ["ideal", "★ Ideal"]].map(([k, l]) => <button key={k} onClick={() => setF(k)} style={chip(f === k)}>{l}</button>)}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋 symbol" aria-label="搜尋 symbol"
          style={{ background: T.card, border: `1px solid ${T.line}`, color: T.txt, borderRadius: 7, padding: "6px 10px", fontFamily: M, fontSize: 12, width: 130, minWidth: 0, flex: isMobile ? 1 : "0 0 auto" }} />
      </div>
      <div style={{ display: "flex", gap: 4, overflowX: "auto", marginBottom: 8, paddingBottom: 2 }}>
        {[["all", "全部板塊"], ...secs].map(([k, l]) => <button key={k} onClick={() => setSec(k)} style={chip(sec === k)}>{l}</button>)}
      </div>

      <div style={{ fontFamily: M, fontSize: 11, lineHeight: 1.7, color: T.mute, marginBottom: 10 }}>
        ST／UT：B/S(Nd) = 現時狀態同維持咗幾多日（今日剛轉 = 0d，⚑ = 今日剛翻轉／觸發）· Signal = 今日 ST 翻轉或 UT 觸發 · Ideal ★ = BUY＋放量＋RSI 45–72＋ATR ≤ 2x · 虛線「未收線」= 今日日線未完，收市前可能改變 · EMA 綠＝價在線上、紅＝線下、灰＝歷史不足 · Whale：P 拉升、U 洗出、W 弱（由舊到新）
      </div>

      <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, overflow: "auto", maxWidth: "100%", maxHeight: "calc(100vh - 300px)" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1000 }}>
          <thead><tr>
            {COLS.map(([k, l], i) => (
              <th key={k} style={{ ...th, ...(i === 0 ? { left: 0, zIndex: 3 } : {}), textAlign: ["px", "rsi", "atr"].includes(k) ? "right" : "left" }}>
                <button onClick={() => sortBy(k)} style={{ all: "unset", cursor: "pointer" }}>{l}{sk === k ? (sd < 0 ? " ▾" : " ▴") : ""}</button>
              </th>))}
          </tr></thead>
          <tbody>
            {shown.map(r => {
              const up = r.chg >= 0;
              return (
                <tr key={r.sym}>
                  <td style={{ ...td, position: "sticky", left: 0, background: T.card, zIndex: 1, fontFamily: SANS, cursor: "pointer" }}
                    onClick={() => window.open(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.sym)}&interval=D`, "_blank", "noopener")}>
                    <span style={{ fontWeight: 500, fontSize: 14 }}>{r.sym}</span>{r.ideal && <span style={{ color: T.warn, marginLeft: 4 }}>★</span>}
                    <span style={{ display: "block", fontSize: 11, color: T.mute, fontWeight: 400, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{(r.section || "").replace(/^\d+-/, "")}</span>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>{r.px.toFixed(2)} <span style={{ color: up ? T.up : T.dn }}>{r.chg != null ? `${up ? "+" : ""}${r.chg.toFixed(2)}%` : ""}</span></td>
                  <td style={td}>
                    {r.sig ? <span style={pill(r.sig === "BUY" ? T.upBg : T.dnBg, r.sig === "BUY" ? T.up : T.dn)}>{r.sig}</span> : <span style={{ color: T.mute }}>—</span>}
                    {r.sig && r.live && <span style={{ marginLeft: 5, border: `1px dashed ${T.mute}`, color: T.mute, borderRadius: 4, padding: "0 4px", fontSize: 9, verticalAlign: "middle" }}>未收線</span>}
                  </td>
                  <td style={{ ...td, color: r.st.t === "Up" ? T.up : T.dn }}>{r.st.t === "Up" ? "B" : "S"}<span style={{ color: T.mute }}>({r.st.days}d)</span>{r.st.flip && <span style={{ color: T.warn, marginLeft: 4 }} title="今日 ST 翻轉">⚑</span>}</td>
                  <td style={td} title={r.ut.stop != null ? `UT 止蝕位 ${r.ut.stop.toFixed(2)}` : ""}><span style={{ color: r.ut.pos === "L" ? T.up : T.dn }}>{r.ut.pos === "L" ? "B" : "S"}</span><span style={{ color: T.mute }}>{r.ut.days != null ? `(${r.ut.days}d)` : ""}</span>{r.ut.cross && <span style={{ color: T.warn, marginLeft: 4 }} title="今日 UT 觸發">⚑</span>}</td>
                  <td style={td}><span style={{ display: "inline-flex", gap: 3 }}>
                    {r.ema.map(e => <span key={e.p} style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, background: !e.valid ? T.soft : e.above ? T.upBg : T.dnBg, color: !e.valid ? T.mute : e.above ? T.up : T.dn, opacity: e.valid ? 1 : 0.6 }}>{e.p}</span>)}
                  </span></td>
                  <td style={td}><span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    {r.whale.map((w, i) => (
                      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                        {i > 0 && <span style={{ color: T.mute, fontSize: 10 }}>›</span>}
                        <span style={{ fontSize: 10.5, padding: "1px 5px", borderRadius: 4, background: w.type === "P" ? T.upBg : w.type === "U" ? T.dnBg : w.type === "W" ? T.soft : "transparent", color: w.type === "P" ? T.up : w.type === "U" ? T.dn : w.type === "W" ? T.dim : T.mute }}>
                          {w.type === "-" ? "–" : `${w.type}${Number(w.val).toFixed(1)}`}</span>
                      </span>))}
                  </span></td>
                  <td style={{ ...td, color: r.vol.sig === "strong" || r.vol.sig === "flush" ? T.txt : T.mute }}>{r.vol.sig} <span style={{ color: T.mute }}>{r.vol.ratio != null ? `×${r.vol.ratio.toFixed(1)}` : ""}</span></td>
                  <td style={{ ...td, textAlign: "right", color: r.rsi.val >= 75 ? T.dn : r.rsi.val <= 30 ? T.up : T.txt }}>{r.rsi.val ?? "—"}{r.rsi.arrow ? <span style={{ color: T.mute, fontSize: 10 }}> {r.rsi.arrow}</span> : ""}</td>
                  <td style={{ ...td, textAlign: "right", color: r.atr >= 2 ? T.dn : r.atr >= 1.5 ? T.warn : T.txt }}>{r.atr != null ? `${r.atr.toFixed(1)}x` : "—"}</td>
                </tr>);
            })}
            {!shown.length && <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: T.mute, padding: 24 }}>{data ? "冇符合嘅股票" : "載入中…"}</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ fontFamily: M, fontSize: 11, color: T.mute, marginTop: 10 }}>現價每約 60 秒更新；EMA／ST／UT／Whale 用已收市日線加今日即時價計算，同 daily brief 同一套公式。</div>
    </div>
  );
}
