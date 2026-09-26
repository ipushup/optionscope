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

const BAND_LABEL = { confirmed: "已確認", forming: "形成中", candidate: "候選", exit: "出場", watch: "觀察", flat: "追蹤中" };
const BAND_ICON = { confirmed: "✅", forming: "⏳", candidate: "●", exit: "▼", watch: "○", flat: "·" };
const bandColor = k => ({ confirmed: C.up, forming: C.warn, candidate: C.acc, exit: C.dn, watch: C.mute, flat: C.mute }[k] || C.mute);

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
  const [sortKey, setSortKey] = useState("symbol");
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
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => -d);
    else { setSortKey(key); setSortDir(1); }
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

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <input
          value={q} onChange={e => setQ(e.target.value)} placeholder="search symbol…"
          style={{
            background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
            padding: "6px 9px", borderRadius: 6, fontFamily: M, fontSize: 12, width: 130,
          }}
        />
        <select value={section} onChange={e => setSection(e.target.value)} style={{
          background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
          padding: "6px 9px", borderRadius: 6, fontFamily: M, fontSize: 12,
        }}>
          <option value="">All sections</option>
          {sections.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={bandFilter} onChange={e => setBandFilter(e.target.value)} style={{
          background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
          padding: "6px 9px", borderRadius: 6, fontFamily: M, fontSize: 12,
        }}>
          <option value="">TBand: all</option>
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
                }}>{r.symbol}</td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right" }}>
                  {r.tband
                    ? <span style={{ color: bandColor(r.tband), fontSize: 13 }}>{BAND_ICON[r.tband]}</span>
                    : <span style={{ color: C.mute }}>–</span>}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontWeight: 700 }}>
                  {r.ut ? <span style={{ color: r.ut === "long" ? C.up : C.dn }}>{r.ut === "long" ? "B" : "S"}</span> : <span style={{ color: C.mute }}>–</span>}
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
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums", color: pctC(r.ext_chg_pct) }}>
                  {P(r.ext_chg_pct)}
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
