import { marketsClosed } from "./marketHours";
import { Fragment, useEffect, useState, useRef } from "react";
import WatchlistEditor from "./WatchlistEditor";

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
    bg: "#0f1112", card: "#151718", line: "#26292c", chip: "#1d1f21",
    txt: "#e3e4e5", dim: "#9b9b9e", sub: "#b9babd", mute: "#75777a",
    up: "#14ac9c", dn: "#f23c75", warn: "#ffb35c", acc: "#5cb3ff",
    tabOn: "#1e4270",
    hlYellow: "rgba(255,196,0,0.26)", hlRed: "rgba(255,90,90,0.26)", hlBlue: "rgba(92,179,255,0.26)",
  },
  light: {
    bg: "#f4f7fb", card: "#ffffff", line: "#d5e0ec", chip: "#e8eef6",
    txt: "#0e1c2c", dim: "#4a6480", sub: "#33506e", mute: "#7b93aa",
    up: "#00875a", dn: "#d1234a", warn: "#b56100", acc: "#0b6bcb",
    tabOn: "#cfe3fa",
    hlYellow: "rgba(255,180,0,0.30)", hlRed: "rgba(255,90,90,0.30)", hlBlue: "rgba(92,179,255,0.30)",
  },
};
let C = THEMES.dark;
const F = "'Syne',system-ui,sans-serif";
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";   // 同 Daily Table 一致：標題／代號用 Inter
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";   // 數字/標籤字體：iOS 系統字 (SF Pro)，同 Longbridge app 一致；配 tabular-nums

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

// 3色提醒：黃=短線、紅=咪call/咪買、藍=長線。
const HILITE = {
  yellow: { label: "短線提醒", swatch: "#ffcc33" },
  red: { label: "咪call/咪買", swatch: "#ff5c5c" },
  blue: { label: "長線提醒", swatch: "#5cb3ff" },
};
const hlBg = colorKey => C[`hl${colorKey[0].toUpperCase()}${colorKey.slice(1)}`];

// 自己highlight嘅symbol，存落localStorage(同theme.js嘅osTheme一樣做法)，
// 淨係呢部機／呢個瀏覽器記得住，跨session唔會唔見。
// 格式 {ticker: colorKey}。舊版本存嘅係一個純array(淨係on/off，冇顏色)，
// 讀到嗰陣自動當成全部"yellow"，唔會炸、都唔會漏返舊highlight。
const HL_KEY = "osWatchlistHighlights";
const normaliseHighlights = raw => {
  if (Array.isArray(raw)) {
    const out = {};
    for (const t of raw) out[t] = "yellow";
    return out;
  }
  return raw && typeof raw === "object" ? raw : {};
};
const loadHighlights = () => {
  try { return normaliseHighlights(JSON.parse(localStorage.getItem(HL_KEY))); }
  catch { return {}; }
};
const saveHighlights = obj => {
  try { localStorage.setItem(HL_KEY, JSON.stringify(obj)); } catch { /* 私隱模式 */ }
};

// ── 跨裝置sync：經Cloudflare Worker代理去GitHub issue當輕量database ─────
// localStorage只係一部機嘅cache；GitHub issue嘅body(一個JSON array)先係
// 「真」嘅嗰份，PC同mobile都讀寫緊同一個issue。
// 真·token而家淨係存喺Worker嘅secret(GH_TOKEN)度，唔會再出現喺任何前端
// JS bundle或者git history -- 之前直接embed落bundle嗰個做法俾GitHub
// push protection主動擋咗，所以改用呢個中間人。前端淨係call自己個
// Worker，Worker先用真token幫手call GitHub。
const WORKER_API = "https://long-hill-a5b7.emacaunet.workers.dev";
const GH_POLL_MS = 90_000; // 跟quote poll唔同頻率，避免同一秒撞兩個fetch

async function fetchRemoteHighlights() {
  // cache:"no-store" + 加個timestamp query -- 防止瀏覽器(尤其mobile)將
  // response cache住，poll嗰陣攞返stale舊data，將啱啱highlight咗嘅
  // symbol覆蓋走(之前實際報到嘅bug)。Worker自己個fetch去GitHub都已經
  // cf:{cacheTtl:0}，呢度係多一重防禦。
  const r = await fetch(`${WORKER_API}/?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`[watchlist-highlight] GET ${WORKER_API} → HTTP ${r.status}`, body);
    throw new Error(`HTTP ${r.status}`);
  }
  const data = await r.json();
  let raw = {};
  try { raw = JSON.parse(data.body || "{}"); } catch { raw = {}; }
  return normaliseHighlights(raw);
}

async function pushRemoteHighlights(obj) {
  // keys排序，淨係為咗個issue body每次改動嘅diff睇落穩定啲，方便你自己
  // 手動睇個issue history嗰陣對得到邊次改咗咩。
  const sorted = Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
  const r = await fetch(WORKER_API, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: JSON.stringify(sorted) }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    // 常見原因：Worker嘅GH_TOKEN secret未set/已經唔work，或者worker個
    // GH_OWNER/GH_REPO/GH_ISSUE set錯 -- 睇body個message。
    console.error(`[watchlist-highlight] PATCH ${WORKER_API} → HTTP ${r.status}`, body);
    throw new Error(`HTTP ${r.status}`);
  }
}

// PATCH失敗(或者未PATCH完)嗰陣,下一輪poll嘅GET唔應該用返舊data覆蓋走個
// 剛剛先做嘅local改動——之前個bug就係咁：highlight咗，但poll隔90秒後
// 攞到仲未更新嘅舊list，直接clobber返個local highlight，睇落好似「自己
// 唔見咗」。用pendingPushes追蹤緊邊幾個toggle重未confirm成功push到
// GitHub，poll期間淨係跳過呢啲，其他symbol照用返remote(等第二部機嘅
// 改動都sync到)。
async function pushWithRetry(obj, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { await pushRemoteHighlights(obj); return true; }
    catch { if (i < attempts - 1) await new Promise(res => setTimeout(res, 1500 * (i + 1))); }
  }
  return false;
}

const BASE = process.env.PUBLIC_URL || "";
const BAND_LABEL = { confirmed: "Confirmed", forming: "Forming", candidate: "Candidate", exit: "Exit", watch: "Watch", flat: "Tracking" };
// 自訂下拉（原生 <select> 嘅 option 畫唔到彩色圓點）：● 同 Longbridge 狀態點同款
const BAND_ICON = { confirmed: ["●", "up"], forming: ["●", "warn"], candidate: ["●", "txt"], exit: ["▼", "dn"], watch: ["○", "mute"], flat: ["·", "mute"] };
function BandPicker({ value, onChange, isMobile, style }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("touchstart", off);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("touchstart", off); };
  }, [open]);
  const dot = k => <span style={{ color: C[BAND_ICON[k][1]], display: "inline-block", width: 14, textAlign: "center" }}>{BAND_ICON[k][0]}</span>;
  const label = value ? <>{dot(value)} {BAND_LABEL[value]}</> : (isMobile ? "TBand" : "TBand: all");
  return (
    <div ref={box} style={{ position: "relative", ...style }}>
      <button type="button" onClick={() => setOpen(o => !o)} style={{
        width: "100%", textAlign: "left", background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
        padding: isMobile ? "6px 3px" : "6px 9px", borderRadius: 6, fontFamily: isMobile ? "system-ui,-apple-system,sans-serif" : M, fontSize: isMobile ? 16 : 12, // 手機同原生 select 一樣 16px（index.html 全域規則）
        cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4, whiteSpace: "nowrap", overflow: "hidden",
      }}><span>{label}</span><svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke={C.txt} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true"><path d="M2 6l4-4 4 4M2 10l4 4 4-4" /></svg></button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: "100%", zIndex: 40, background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,.35)", padding: 4 }}>
          {[["", null], ...Object.entries(BAND_LABEL)].map(([k, v]) => (
            <div key={k} onClick={() => { onChange(k); setOpen(false); }} style={{
              padding: "9px 10px", fontFamily: M, fontSize: 13, color: C.txt, cursor: "pointer", whiteSpace: "nowrap", borderRadius: 5,
              background: value === k ? C.chip : "transparent",
            }}>{k ? <>{dot(k)} {v}</> : "All"}</div>
          ))}
        </div>
      )}
    </div>
  );
}
const SIG_KEYS = ["ut_k", "hv_k", "tb_k", "st_k"];
const WATCHLIST_URL = `${BASE}/watchlist_merged.json`;
const QUOTES_URL = `${BASE}/watchlist_quotes.json`;

const Msg = ({ t }) => (
  <div style={{ background: C.bg, color: C.sub, fontFamily: F, padding: 40, textAlign: "center", fontSize: 13 }}>{t}</div>
);

export default function Watchlist({ isMobile, light }) {
  const [status, setStatus] = useState(null);   // watchlist_merged.json
  const [sigQ, setSigQ] = useState({});          // Longbridge 即時（signals.json，Signal Board 個 job 每輪更新）→ {ticker: {last, chg_pct, ext_chg_pct}}
  const [quotes, setQuotes] = useState({});      // watchlist_quotes.json -> {ticker: {...}}
  const [qAt, setQAt] = useState(null);
  const [apiQ, setApiQ] = useState({});          // Longbridge 即時（/api/quotes，Worker 直接問 Longbridge）→ 同 sigQ 一樣格式；優先過 signals.json，yfinance 做後備
  const [apiAt, setApiAt] = useState(null);
  const [apiAsof, setApiAsof] = useState(null);      // 所有報價入面最新一筆成交時間（休市時顯示呢個）
  const [lbAt, setLbAt] = useState(null);          // Longbridge 即時報價最後更新時間（signals.json.updated）
  const [, tick] = useState(0);                  // 15s 迫 re-render，令「幾分鐘前」跳動
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);   // 編輯面板（加／移除股票、分組、孖展率）
  const [section, setSection] = useState("");
  const [bandFilter, setBandFilter] = useState("");   // Triple Band 分組：confirmed / forming / candidate / exit / watch / flat
  const [sigKind, setSigKind] = useState("");   // "" | ut | hv | tb | st
  const [sigSide, setSigSide] = useState("");   // "" | B | B2 | B5 | S | S2 | S5
  // null = 跟 Watchlists.txt 原本section次序(INDICES → SECTION 1 → … → HONGKONG),
  // 美股喺前、港股喺最尾。揀咗column先會改做按該column排序。
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState(1);
  const [highlighted, setHighlighted] = useState(loadHighlights); // {ticker: colorKey}；local cache先行，GitHub fetch返嚟先覆蓋
  const [syncErr, setSyncErr] = useState(false);
  const [picker, setPicker] = useState(null); // {ticker, symbol} | null -- 揀色popup開緊邊個symbol
  // 邊幾個ticker重有個local改動未confirm成功push到GitHub -- poll攞到
  // 新嘅remote set嗰陣，呢幾個要保留返local嘅版本，唔好俾poll用（可能係
  // push完成之前攞到嘅）舊data覆蓋走，呢個正正係之前「highlight咗，90秒
  // 後自己唔見咗」嗰個bug嘅根源。
  const pendingRef = useRef(new Set());

  // 開頁即刻攞一次遠端(另一部機可能啱啱改過)，之後每90秒poll一次。
  useEffect(() => {
    let alive = true;
    const pull = () => fetchRemoteHighlights()
      .then(remote => {
        if (!alive) return;
        setHighlighted(prev => {
          // 保留住重pending緊嘅local改動，其餘用返remote(等第二部機嘅
          // 改動都sync到)
          const merged = { ...remote };
          for (const t of pendingRef.current) {
            if (t in prev) merged[t] = prev[t]; else delete merged[t];
          }
          saveHighlights(merged);
          return merged;
        });
        setSyncErr(false);
      })
      .catch(() => { if (alive) setSyncErr(true); }); // fetch唔到就靜靜哋用返local cache，唔阻住個page
    pull();
    const id = setInterval(pull, GH_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // 共用嘅「改咗一個ticker → local即刻生效、background push、失敗retry3次」
  const applyHighlightChange = (ticker, next) => {
    setHighlighted(prev => {
      const merged = { ...prev };
      if (next) merged[ticker] = next; else delete merged[ticker];
      saveHighlights(merged);

      pendingRef.current.add(ticker);
      pushWithRetry(merged).then(ok => {
        pendingRef.current.delete(ticker);
        setSyncErr(!ok); // retry 3次都失敗至會警告 -- local改動本身冇走
      });
      return merged;
    });
  };

  // 㩒一行：已highlight → 直接取消，唔使問。未highlight → 彈個3色揀色
  // popup，㩒邊個色就即刻confirm用嗰隻色（唔使再多撳一次OK），避免手滑
  // 㩒錯就整到成行變色。
  const toggleHighlight = (ticker, symbol) => {
    if (highlighted[ticker]) applyHighlightChange(ticker, null);
    else setPicker({ ticker, symbol });
  };
  const chooseColor = colorKey => {
    if (picker) applyHighlightChange(picker.ticker, colorKey);
    setPicker(null);
  };
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
    const pullLB = () =>
      fetch("/signals.json", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d || (Date.now() - new Date(d.updated).getTime()) > 300_000) { setSigQ({}); setLbAt(null); return; }   // 太舊就唔用，跌返 yfinance
          const m = {};
          for (const r of d.rows || []) {
            if (!(r.reg > 0) || !(r.pc > 0)) continue;
            m[r.sym] = { last: r.reg, chg_pct: +((r.reg / r.pc - 1) * 100).toFixed(2),
                         ext_chg_pct: r.sess === "盤中" ? null : +((r.px / r.reg - 1) * 100).toFixed(2), sess: r.sess };
          }
          setSigQ(m); setLbAt(d.updated);
        }).catch(() => {});
    pull(); pullLB();
    const id = setInterval(() => { pull(); pullLB(); tick(n => n + 1); }, 15_000);
    return () => clearInterval(id);
  }, []);

  // Longbridge 即時報價：Watchlist 全部美股／港股 ticker，每 100 隻一批，逐批問（避免撞 Longbridge 限流）
  useEffect(() => {
    if (!status) return undefined;
    const back = {};
    for (const r of status.rows || []) {
      const t = r.ticker || "";
      let m;
      if ((m = t.match(/^(\d{1,5})\.HK$/))) back[`${parseInt(m[1], 10)}.HK`] = t;
      else if (/^[A-Z]{1,5}$/.test(t)) back[`${t}.US`] = t;
    }
    const syms = Object.keys(back);
    if (!syms.length) return undefined;
    const SESS = { regular: "盤中", pre: "盤前", post: "盤後", overnight: "夜盤" };
    let alive = true;
    const pullAPI = async () => {
      const m = {}; let at = null; let asof = 0;
      for (let i = 0; i < syms.length; i += 100) {
        try {
          const r = await fetch(`/api/quotes?symbols=${syms.slice(i, i + 100).join(",")}`, { cache: "no-store" });
          if (!r.ok) continue;
          const d = await r.json();
          for (const q of d.quotes || []) {
            const t = back[q.symbol];
            if (!t || !(q.reg > 0)) continue;
            { const ms = Date.parse(q.asof); if (ms > asof) asof = ms; }
            m[t] = { last: q.reg, chg_pct: +q.reg_pct.toFixed(2), ext_chg_pct: q.session === "regular" ? null : +q.pct.toFixed(2), sess: SESS[q.session] || "盤中" };
          }
          if (d.fetched_at) at = d.fetched_at;
        } catch (e) { /* 呢批失敗 → 跌返 signals.json / yfinance */ }
      }
      if (alive && Object.keys(m).length) { setApiQ(m); setApiAt(at || new Date().toISOString()); if (asof) setApiAsof(new Date(asof).toISOString()); }
    };
    let got = false;
    const pull = async () => { await pullAPI(); got = true; };
    pull();
    const id = setInterval(() => { if (got && marketsClosed()) return; pullAPI(); }, 15_000);   // 休市：拉一次顯示收市價就停
    return () => { alive = false; clearInterval(id); };
  }, [status]);

  if (err) return <Msg t={err} />;
  if (!status) return <Msg t="載入緊…" />;

  // live() 覆蓋 status 裡面嘅snapshot報價 —— 同 Band.jsx 嘅 live(symbol) 一樣諗法，
  // 分開兩個檔案輪詢，唔使成個merge file連tband都要15分鐘一次重寫。
  const live = ticker => (apiQ[ticker] || sigQ[ticker]) ? { ...quotes[ticker], ...(apiQ[ticker] || sigQ[ticker]) } : quotes[ticker];   // Longbridge /api/quotes → signals.json → yfinance

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
        ext_sess: lv?.ext_chg_pct != null ? lv.sess : null,
        chg: (lv?.last ?? r.last) != null && (lv?.chg_pct ?? r.chg_pct) != null ? (lv?.last ?? r.last) - (lv?.last ?? r.last) / (1 + (lv?.chg_pct ?? r.chg_pct) / 100) : null,
        // 排序用：買 > 賣，越新越前
        // 訊號欄：{s:+1買/-1賣, n:幾棒前}；排序見 sigRank
        ut_k: r.ut && r.ut_days != null ? { s: r.ut === "long" ? 1 : -1, n: r.ut_days } : null,
        hv_k: r.hv ? { s: r.hv.s, n: r.hv.n } : null,
        tb_k: r.tb_days != null ? { s: 1, n: r.tb_days } : null,
        st_k: r.st && r.st_days != null ? { s: r.st === "long" ? 1 : -1, n: r.st_days } : null,
      };
    })
    .filter(r => {
      if (!sigSide) return true;
      const want = sigSide[0] === "B" ? 1 : -1;
      const max = sigSide.length > 1 ? Number(sigSide.slice(1)) : Infinity;
      const keys = sigKind ? [sigKind + "_k"] : SIG_KEYS;
      return keys.some(k => r[k] && r[k].s === want && r[k].n <= max);
    })
    .sort((a, b) => {
      if (sortKey == null) return 0; // 保持原本section次序(Array.sort係stable)
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (SIG_KEYS.includes(sortKey)) {
        // 第一下：B1,B2,B3… 再 S1,S2…；第二下：S1,S2… 再 B1,B2…
        const rank = v => (v.s === (sortDir === 1 ? 1 : -1) ? 0 : 1000) + v.n;
        return rank(av) - rank(bv);
      }
      if (typeof av === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });

  // 三段式：㩒第一下升序 → 第二下降序 → 第三下返回預設(section次序)
  const toggleSort = key => {
    if (key === "tb_k") { // TB 只有買入訊號：㩒一下排最新，再㩒返預設
      if (sortKey !== key) { setSortKey(key); setSortDir(1); } else { setSortKey(null); setSortDir(1); }
      return;
    }
    if (sortKey !== key) { setSortKey(key); setSortDir(1); }
    else if (sortDir === 1) setSortDir(-1);
    else { setSortKey(null); setSortDir(1); }
  };

  const hkDate = iso => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", day: "2-digit", month: "short" }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
      return `${p.day} ${p.month}`;
    } catch { return ""; }
  };
  const hkTime = iso => {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
        .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
      return `${p.hour}:${p.minute}:${p.second}`;
    } catch { return "—"; }
  };
  const elapsed = qAt ? Math.max(0, Math.round((Date.now() - new Date(qAt).getTime()) / 60000)) : null;
  const elapsedLabel = elapsed == null ? "—" : elapsed < 1 ? "啱啱" : `${elapsed} 分鐘前`;

  const COLS = [
    { key: "symbol", label: "Symbol" },
    { key: "ut_k", label: "UT" },
    { key: "hv_k", label: "HV" },
    { key: "tb_k", label: "TB" },
    { key: "st_k", label: "ST" },
    { key: "last", label: "Last" },
    { key: "chg_pct", label: "%Chg" },
    { key: "ext_chg_pct", label: "E%Chg" },
  ];
  // 訊號：5 棒內綠／紅底白字（同 My List 一樣），之後綠／紅字；冇訊號 –
  const sigCell = (s, n, tip) => {
    if (s == null || n == null) return <span style={{ color: C.mute }}>–</span>;
    const col = s > 0 ? C.up : C.dn, txt = `${s > 0 ? "B" : "S"}${n}`;
    return n <= 5
      ? <span title={tip} style={{ background: col, color: "#fff", padding: "0 4px", borderRadius: 3, fontSize: 11, lineHeight: "13px", display: "inline-block" }}>{txt}</span>
      : <span title={tip} style={{ color: col }}>{txt}</span>;
  };
  const tdSig = { padding: "7px 4px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, whiteSpace: "nowrap" };

  return (
    <div style={{
      background: C.bg, color: C.txt, fontFamily: SANS,
      padding: isMobile ? "14px 7px 40px" : "18px 24px 40px", width: "100%", overflowX: "hidden",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontFamily: M, fontSize: 12, color: C.dim, minHeight: 20, marginBottom: 10 }}>
        <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>
          {(() => {
            const at = apiAt || lbAt || qAt;
            if (!at) return "";
            if (marketsClosed()) { const t = apiAsof || at; return <><span style={{ color: C.mute }}>●</span> {hkDate(t)} {hkTime(t)} HKT · {status.count} 隻</>; }
            const age = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
            return <><span style={{ color: age > 300 ? C.dn : C.up }}>●</span> {hkDate(at)} {hkTime(at)} HKT · {status.count} 隻{age > 300 ? ` · ⚠ ${Math.round(age / 60)} 分鐘冇更新` : ""}</>;
          })()}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, whiteSpace: "nowrap" }}>
          {syncErr && <span style={{ color: C.warn }}>⚠ sync</span>}
          <button onClick={() => setEditing(true)} style={{ background: C.chip, color: C.txt, border: `1px solid ${C.line}`, borderRadius: 6, padding: "1px 9px", lineHeight: "16px", fontFamily: M, fontSize: 12, cursor: "pointer" }}>✎ Edit</button>
        </span>
      </div>

      {editing && <WatchlistEditor C={C} F={F} M={M} isMobile={isMobile} onClose={() => setEditing(false)} />}
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
        <BandPicker value={bandFilter} onChange={setBandFilter} isMobile={isMobile} style={{ flex: "1 1 0%", minWidth: 0 }} />
      </div>
      <div style={{ display: "flex", gap: isMobile ? 4 : 6, flexWrap: "nowrap", alignItems: "center", marginBottom: 8 }}>
        <select value={sigKind} onChange={e => setSigKind(e.target.value)} style={{
          background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
          padding: isMobile ? "6px 3px" : "6px 9px", borderRadius: 6, fontFamily: M,
          fontSize: isMobile ? 11 : 12, flex: "1 1 0%", minWidth: 0,
        }}>
          <option value="">{isMobile ? "Signal" : "Signal: all"}</option>
          <option value="ut">UT</option>
          <option value="hv">HV</option>
          <option value="tb">TB</option>
          <option value="st">ST</option>
        </select>
        <select value={sigSide} onChange={e => setSigSide(e.target.value)} style={{
          background: C.chip, border: `1px solid ${C.line}`, color: C.txt,
          padding: isMobile ? "6px 3px" : "6px 9px", borderRadius: 6, fontFamily: M,
          fontSize: isMobile ? 11 : 12, flex: "1 1 0%", minWidth: 0,
        }}>
          <option value="">{isMobile ? "B/S" : "B/S: any"}</option>
          <option value="B">B any</option>
          <option value="B2">B ≤2</option>
          <option value="B5">B ≤5</option>
          <option value="S">S any</option>
          <option value="S2">S ≤2</option>
          <option value="S5">S ≤5</option>
        </select>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 430, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 12.5 }}>
          {/* 固定欄寬：排序／篩選／active 標示都唔會令欄位郁 */}
          <colgroup>
            {[74, 44, 44, 44, 44, 62, 60, 58].map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead>
            <tr style={{ color: C.mute, fontSize: 11 }}>
              {COLS.map((col, i) => (
                <th key={col.key} onClick={() => toggleSort(col.key)} style={{
                  padding: isMobile ? "6px 3px" : "6px", borderBottom: `1px solid ${C.line}`, fontWeight: 500, fontFamily: SANS,
                  textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap", cursor: "pointer",
                  color: light ? "#6b7580" : "#75777a",   // 同 Daily Table / Signal Board 表頭一致（active 用 ▴▾ 標示，唔變色）
                }}>{col.label}{sortKey === col.key
                    ? (SIG_KEYS.includes(col.key) ? (col.key === "tb_k" || sortDir > 0 ? " B▸" : " S▸") : (sortDir < 0 ? " ▾" : " ▴"))
                    : (SIG_KEYS.includes(col.key) ? <span style={{ opacity: 0.45 }}> ▾</span> : "")}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <Fragment key={r.ticker}>
              {sortKey == null && (ri === 0 || rows[ri - 1].section !== r.section) && (
                <tr style={{ height: 32 }}><td colSpan={COLS.length} style={{ padding: "0 6px", verticalAlign: "middle", fontFamily: M, fontSize: 10.5, letterSpacing: "0.08em", color: C.mute, borderBottom: `1px solid ${C.line}`, textAlign: "left", whiteSpace: "nowrap" }}>
                  {r.section.replace(/^SECTION\s+/i, "")} <span style={{ opacity: 0.7 }}>· {rows.filter(x => x.section === r.section).length}</span>
                </td></tr>
              )}
              <tr
                onClick={() => toggleHighlight(r.ticker, r.symbol)}
                style={{ height: 32, cursor: "pointer", background: highlighted[r.ticker] ? hlBg(highlighted[r.ticker]) : undefined }}
              >
                <td style={{
                  padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "left",
                  fontWeight: 500, fontSize: 14, whiteSpace: "nowrap", fontFamily: SANS,
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
                      <sup title={marginTitle(r.margin)} style={{ marginLeft: 2, lineHeight: 0, fontSize: "0.68em", fontWeight: 700, color: marginColor(r.margin) }}>
                        {marginGlyph(r.margin)}
                      </sup>
                    )}
                  </span>
                </td>
                <td style={tdSig}>{sigCell(r.ut === "long" ? 1 : r.ut === "short" ? -1 : null, r.ut_days, "UT Bot（日線）：B = 買方向、S = 賣方向，數字 = 持續咗幾多棒")}</td>
                <td style={tdSig}>{sigCell(r.hv?.s, r.hv?.n, "Heavy：最近一個 HB / HS，數字 = 幾多棒前")}</td>
                <td style={tdSig}>{sigCell(r.tb_days != null ? 1 : null, r.tb_days, "Triple Band 買入確認棒，數字 = 幾多棒前（最近 20 棒）")}</td>
                <td style={tdSig}>{sigCell(r.st === "long" ? 1 : r.st === "short" ? -1 : null, r.st_days, "SuperTrend(10,3)：B = 上升、S = 下降，數字 = 持續咗幾多棒")}</td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums" }}>
                  {N(r.last)}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums", color: pctC(r.chg_pct) }}>
                  {P(r.chg_pct)}
                </td>
                <td style={{ padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: "right", fontFamily: M, fontVariantNumeric: "tabular-nums", color: isHK(r.ticker) ? C.mute : pctC(r.ext_chg_pct) }}>
                  {isHK(r.ticker) ? "n/a" : P(r.ext_chg_pct)}
                </td>
              </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: C.mute, fontFamily: M }}>
        {rows.length} / {status.count} symbols
      </div>

      {picker && (
        <div
          onClick={() => setPicker(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: C.card, border: `1px solid ${C.line}`, borderRadius: 10,
              padding: "18px 20px", minWidth: 220, fontFamily: F,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: C.txt, marginBottom: 14 }}>
              Highlight {picker.symbol}
            </div>
            <div style={{ display: "flex", gap: 14, justifyContent: "center" }}>
              {Object.entries(HILITE).map(([key, { label, swatch }]) => (
                <button
                  key={key}
                  onClick={() => chooseColor(key)}
                  title={label}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                    background: "none", border: "none", cursor: "pointer", padding: 4,
                  }}
                >
                  <span style={{
                    display: "block", width: 28, height: 28, borderRadius: "50%",
                    background: swatch, border: `1px solid ${C.line}`,
                  }} />
                  <span style={{ fontSize: 10, fontFamily: M, color: C.sub }}>{label}</span>
                </button>
              ))}
            </div>
            <div
              onClick={() => setPicker(null)}
              style={{ marginTop: 14, textAlign: "center", fontSize: 11, color: C.mute, fontFamily: M, cursor: "pointer" }}
            >
              取消
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
