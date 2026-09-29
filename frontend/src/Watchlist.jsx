import { useEffect, useState } from "react";

/**
 * Watchlist.jsx — 你原本 TradingView watchlist 加埋 Triple Band / UT Bot /
 * SuperTrend 狀態。
 *
 * 讀 watchlist_merged.json（merge_watchlist.py 出，收市後跑一次 —— TBand/UT/ST
 * 呢啲全部 closed-candle based，同 Band.jsx 一樣前端唔重算）+
 * watchlist_quotes.json（watchlist_quotes.py 出，實時報價，poll 頻率同
 * band_quotes.json 睇齊）。
 *
 * 版面刻意唔跟 Band.jsx 嘅「手機卡片／桌面表格」—— 你話想一行一隻股，
 * 唔想13 mini要橫掃，所以無論 isMobile 與否都係同一個緊湊table，
 * 淨係字size/padding隨住isMobile縮返啲。
 *
 * ASSUMPTIONS TO CONFIRM（同 Band.jsx 對過，但呢幾樣你自己至知）：
 * - watchlist_quotes.json 個poll頻率呢度set15秒（同band_quotes.json一致），
 *   但唔知你打算幫watchlist_quotes.py配邊個cron分鐘位，所以「下次幾多分鐘」
 *   冇好似Band.jsx quoteAge()咁計得咁精準，淨係顯示「幾耐之前」。
 * - THEMES/F/M 呢三樣直接copy自Band.jsx，冇抽出嚟做shared module——
 *   你有心思整理嘅話，呢類重複好啱抽做theme.js嘅一部分。
 */

const THEMES = {
  dark: {
    bg: "#050d18", card: "#101f31", line: "#23394f", chip: "#0e1c2c",
    txt: "#eaf2fa", dim: "#a8bdd2", sub: "#c3d3e3", mute: "#7b93aa",
    up: "#2ee89a", dn: "#ff6b83", warn: "#ffb35c", acc: "#5cb3ff",
    tabOn: "#1e4270",
  },
  light: {
    bg: "#f4f7fb", card: "#ffffff", line: "#d5e0ec", chip: "#e8eef6",
    txt: "#0e1c2c", dim: "#4a6480", sub: "#33506e", mute: "#7b93aa",
    up: "#00875a", dn: "#d1234a", warn: "#b56100", acc: "#0b6bcb",
    tabOn: "#cfe3fa",
  },
};
let C = THEMES.dark;
const F = "'Syne',system-ui,sans-serif";
const M = "'DM Mono',ui-monospace,monospace";

const N = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(d));
const P = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const pctC = v => (v == null ? C.mute : v > 0 ? C.up : v < 0 ? C.dn : C.mute);
const isHK = ticker => ticker.endsWith(".HK");

// 融資保證金率superscript -- 同你daily_brief.py嘅margin_html()/CSS
// (.mgn-lo/-mid/-hi/-no) 逐個對過，數值同顏色完全一致：
// 0% → "✕" 紅色(#ef4444，不可融資) ； ≥70% → 紅色高風險 ；
// 55-69% → 橙色(#f59e0b) ； <55% → C.sub(等於PDF嗰個var(--text-sub))
const MGN_HI = "#ef4444";
const MGN_MID = "#f59e0b";
const marginColor = v => (v <= 0 || v >= 70) ? MGN_HI : v >= 55 ? MGN_MID : C.sub;
const marginGlyph = v => (v <= 0 ? "✕" : Math.round(v).toString());
const marginTitle = v => (v <= 0 ? "不可融資" : `孖展保證金率 ${Math.round(v)}%`);

const BAND_LABEL = { confirmed: "已確認", forming: "形成中", candidate: "候選", exit: "出場", watch: "觀察", flat: "追蹤中" };
const BAND_ICON = { confirmed: "✅", forming: "⏳", candidate: "●", exit: "▼", watch: "○", flat: "·" }; // 淨係native <select> option用,嗰度冇得畫colored dot
const bandColor = k => ({ confirmed: C.up, forming: C.warn, candidate: C.acc, exit: C.dn, watch: C.mute, flat: C.mute }[k] || C.mute);

// 表格入面嘅TBand格 -- 全部同一種"dot"語言,靠顏色分狀態；
// watch(觀察)用空心圈、flat(追蹤中)用細細粒實心點,兩個灰階狀態靠形狀分開，
// 唔會撞晒樣。有 tband_days(band.json嘅"bars"欄,淨係candidate/exit先有)
// 就加個同色superscript,一眼睇到已經幾多日。
const TBandDot = ({ status, days }) => {
  if (!status) return <span style={{ color: C.mute }}>–</span>;
  if (status === "watch") {
    return <span style={{
      display: "inline-block", width: 9, height: 9, borderRadius: "50%",
      border: `1.5px solid ${C.mute}`, boxSizing: "border-box",
    }} />;
  }
  if (status === "flat") {
    return <span style={{
      display: "inline-block", width: 5, height: 5, borderRadius: "50%",
      background: C.mute, opacity: 0.65,
    }} />;
  }
  return (
    <>
      <span style={{
        display: "inline-block", width: 9, height: 9, borderRadius: "50%",
        background: bandColor(status),
      }} />
      {days != null && (
        <sup style={{ marginLeft: 1, fontSize: "0.68em", fontWeight: 700, color: bandColor(status) }}>
          {days}
        </sup>
      )}
    </>
  );
};

const BASE = process.env.PUBLIC_URL || "";
const WATCHLIST_URL = `${BASE}/watchlist_merged.json`;
const QUOTES_URL = `${BASE}/watchlist_quotes.json`;

const Msg = ({ t }) => (
  <div style={{ background: C.bg, color: C.sub, fontFamily: F, padding: 40, textAlign: "center", fontSize: 13 }}>{t}</div>
);

export default function Watchlist({ isMobile, light }) {
  const [status, setStatus] = useState(null);   // watchlist_merged.json
  const [quotes, setQuotes] = useState({});      // watchlist_quotes.json -> {ticker: {...}}
  const [qAt, setQAt] = useState(null);
  const [, tick] = useState(0);                  // 15s 迫 re-render，令「幾分鐘前」跳動
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [section, setSection] = useState("");
  const [bandFilter, setBandFilter] = useState("");
  // null = 跟 Watchlists.txt 原本section次序(INDICES → SECTION 1 → … → HONGKONG),
  // 美股喺前、港股喺最尾。揀咗column先會改做按該column排序。
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState(1);
  C = light ? THEMES.light : THEMES.dark;

  useEffect(() => {
    fetch(`${WATCHLIST_URL}?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setStatus)
      .catch(e => setErr(`攞唔到 watchlist_merged.json（${e.message}）— 未跑過 merge_watchlist.py，或者部署未完成`));
  }, []);

  useEffect(() => {
    const pull = () =>
      fetch(`${QUOTES_URL}?t=${Date.now()}`)
        .then(r => r.json())
        .then(d => { setQuotes(d.quotes || {}); setQAt(d.quoted_at); })
        .catch(() => {});
    pull();
    const id = setInterval(() => { pull(); tick(n => n + 1); }, 15_000);
    return () => clearInterval(id);
  }, []);

  if (err) return <Msg t={err} />;
  if (!status) return <Msg t="載入緊…" />;

  // live() 覆蓋 status 裡面嘅snapshot報價 —— 同 Band.jsx 嘅 live(symbol) 一樣諗法，
  // 分開兩個檔案輪詢，唔使成個merge file連tband都要15分鐘一次重寫。
  const live = ticker => quotes[ticker];

  const sections = [...new Set(status.rows.map(r => r.section))].sort();
  const query = q.trim().toUpperCase();
  const rows = status.rows
    .filter(r =>
      (!query || r.symbol.toUpperCase().includes(query)) &&
      (!section || r.section === section) &&
      (!bandFilter || r.tband === bandFilter))
    .map(r => {
      const lv = live(r.ticker);
      return {
        ...r,
        last: lv?.last ?? r.last,
        chg_pct: lv?.chg_pct ?? r.chg_pct,
        ext_chg_pct: lv?.ext_chg_pct ?? r.ext_chg_pct,
      };
    })
    .sort((a, b) => {
      if (sortKey == null) return 0; // 保持原本section次序(Array.sort係stable)
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });

  // 三段式：㩒第一下升序 → 第二下降序 → 第三下返回預設(section次序)
  const toggleSort = key => {
    if (sortKey !== key) { setSortKey(key); setSortDir(1); }
    else if (sortDir === 1) setSortDir(-1);
    else { setSortKey(null); setSortDir(1); }
  };

  const elapsed = qAt ? Math.max(0, Math.round((Date.now() - new Date(qAt).getTime()) / 60000)) : null;
  const elapsedLabel = elapsed == null ? "—" : elapsed < 1 ? "啱啱" : `${elapsed} 分鐘前`;

  const COLS = [
    { key: "symbol", label: "Symbol" },
    { key: "tband", label: "TBand" },
    { key: "ut", label: "UT" },
    { key: "st", label: "ST" },
    { key: "last", label: "Last" },
    { key: "chg_pct", label: "%Chg" },
    { key: "ext_chg_pct", label: "E%Chg" },
  ];

  return (
    <div style={{
      background: C.bg, color: C.txt, fontFamily: F,
      padding: isMobile ? "8px 8px 24px" : 16, width: "100%", overflowX: "hidden",
    }}>
      <div style={{ borderLeft: `3px solid ${C.acc}`, paddingLeft: 9, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: isMobile ? 16 : 19, fontWeight: 800, letterSpacing: ".02em" }}>
            🔭 WATCHLIST
          </span>
          <span style={{ fontSize: 10.5, fontFamily: M, color: C.mute }}>
            {status.band_bar_date ? `Triple Band ${status.band_bar_date}` : ""} · 報價 {elapsedLabel}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: isMobile ? 4 : 6, flexWrap: "nowrap", alignItems: "center", marginBottom: 8 }}>
        <input
          value={q} onChange={e => setQ(e.target.value)} placeholder={isMobile ? "search…" : "search symbol…"}
          style={{
            background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
            padding: isMobile ? "6px 6px" : "6px 9px", borderRadius: 6, fontFamily: M,
            fontSize: isMobile ? 11 : 12, flex: "0 1 76px", minWidth: 0,
          }}
        />
        <select value={section} onChange={e => setSection(e.target.value)} style={{
          background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
          padding: isMobile ? "6px 3px" : "6px 9px", borderRadius: 6, fontFamily: M,
          fontSize: isMobile ? 11 : 12, flex: "1 1 0%", minWidth: 0,
        }}>
          <option value="">{isMobile ? "Section" : "All sections"}</option>
          {sections.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={bandFilter} onChange={e => setBandFilter(e.target.value)} style={{
          background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
          padding: isMobile ? "6px 3px" : "6px 9px", borderRadius: 6, fontFamily: M,
          fontSize: isMobile ? 11 : 12, flex: "1 1 0%", minWidth: 0,
        }}>
          <option value="">{isMobile ? "TBand" : "TBand: all"}</option>
          {Object.entries(BAND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{BAND_ICON[k]} {v}</option>
          ))}
        </select>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 11.5 : 12.5 }}>
          <thead>
            <tr style={{ color: C.mute, fontSize: 10.5 }}>
              {COLS.map((col, i) => (
                <th key={col.key} onClick={() => toggleSort(col.key)} style={{
                  padding: "6px", borderBottom: `1px solid ${C.line}`, fontWeight: 700,
                  textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap", cursor: "pointer",
                  color: sortKey === col.key ? C.acc : C.mute,
                }}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.ticker}>
                <td style={{
                  padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "left",
                  fontWeight: 700, whiteSpace: "nowrap", fontFamily: M, fontVariantNumeric: "tabular-nums",
                }}>
                  {/* 從屬(ETF)縮入 10px：用 position:relative 平移，唔係加 padding，
                      所以唔會撐闊 Symbol 欄、亦唔會擠細其他欄 */}
                  <span style={{ position: "relative", left: r.parent ? 10 : 0 }} title={r.parent ? `${r.parent} 嘅 ETF` : undefined}>
                    {/* └ 用 absolute 擺喺縮入出嚟嗰 10px 空位，唔佔 layout 闊度 */}
                    {r.parent && (
                      <span aria-hidden="true" style={{
                        position: "absolute", left: -10, top: 0, fontSize: 11, fontWeight: 400,
                        color: C.mute, pointerEvents: "none",
                      }}>└</span>
                    )}
                    {r.symbol}
                    {r.margin != null && (
                      <sup title={marginTitle(r.margin)} style={{ marginLeft: 2, fontSize: "0.68em", fontWeight: 700, color: marginColor(r.margin) }}>
                        {marginGlyph(r.margin)}
                      </sup>
                    )}
                  </span>
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right" }}>
                  {r.tband
                    ? <TBandDot status={r.tband} days={r.tband_days} />
                    : <span style={{ color: C.mute }}>–</span>}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontWeight: 700 }}>
                  {r.ut
                    ? (
                      <span style={{ color: r.ut === "long" ? C.up : C.dn }}>
                        {r.ut === "long" ? "B" : "S"}
                        {r.ut_days != null && (
                          <sup style={{ marginLeft: 1, fontSize: "0.68em", fontWeight: 700 }}>{r.ut_days}</sup>
                        )}
                      </span>
                    )
                    : <span style={{ color: C.mute }}>–</span>}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontWeight: 700 }}>
                  {r.st ? <span style={{ color: r.st === "long" ? C.up : C.dn }}>{r.st === "long" ? "B" : "S"}</span> : <span style={{ color: C.mute }}>–</span>}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums" }}>
                  {N(r.last)}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums", color: pctC(r.chg_pct), fontWeight: 700 }}>
                  {P(r.chg_pct)}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums", color: isHK(r.ticker) ? C.mute : pctC(r.ext_chg_pct) }}>
                  {isHK(r.ticker) ? "n/a" : P(r.ext_chg_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: C.mute, fontFamily: M }}>
        {rows.length} / {status.count} symbols
      </div>
    </div>
  );
}
