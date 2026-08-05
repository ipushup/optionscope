import { useEffect, useState } from "react";

/**
 * Band.jsx — Triple Band radar
 *
 * 讀 band.json（收市後計一次）+ band_quotes.json（每 15 分鐘刷）。
 * **前端唔重算任何訊號** —— pivot / ext / rU60 / UT Bot 全部喺 band_scan.py
 * 用收咗市嘅棒計死。呢度只做兩件事：顯示，同埋用即時價計「距死線幾遠」。
 *
 * 版面：手機用卡片（數字大、唔洗橫掃），桌面用表格。
 * 所有長篇說明預設收埋 —— 每個 tab 一打開就見到數據，唔係先讀三行字。
 */

/**
 * 主題。深色版嘅次要文字特登調亮咗好多 —— 原本 dim #5c7a99 喺 #0b1725
 * 上面對比度只有 3.5:1，低過可讀標準，「訊號 / stop / 距」嗰行根本睇唔清。
 * 而家 dim / sub / mute 全部提高到 7:1 以上。
 */
const THEMES = {
  dark: {
    bg: "#050d18", card: "#101f31", line: "#23394f", chip: "#0e1c2c",
    txt: "#eaf2fa", dim: "#a8bdd2", sub: "#c3d3e3", mute: "#7b93aa",
    up: "#2ee89a", dn: "#ff6b83", warn: "#ffb35c", acc: "#5cb3ff",
    tabOn: "#1e4270", flagBg: "#2a1119", flagLine: "#5c2434",
    staleBg: "#3a1a0c",
  },
  light: {
    bg: "#f4f7fb", card: "#ffffff", line: "#d5e0ec", chip: "#e8eef6",
    txt: "#0e1c2c", dim: "#4a6480", sub: "#33506e", mute: "#7b93aa",
    up: "#00875a", dn: "#d1234a", warn: "#b56100", acc: "#0b6bcb",
    tabOn: "#cfe3fa", flagBg: "#fdeaee", flagLine: "#f0bcc7",
    staleBg: "#fff1e0",
  },
};
let C = THEMES.dark;
const F = "'Syne',system-ui,sans-serif";
const M = "'DM Mono',ui-monospace,monospace";

const N = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(d));
const P = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const gapC = v => (v == null ? C.mute : v > 0 ? C.dn : C.up);   // 追高係壞事，所以反色

function nextBiz(d) {
  const t = new Date(`${d}T00:00:00Z`);
  do { t.setUTCDate(t.getUTCDate() + 1); } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
}

const BASE = process.env.PUBLIC_URL || "";
const BAND_URL = `${BASE}/band.json`;
const QUOTES_URL = `${BASE}/band_quotes.json`;
const FLOG_URL = `${BASE}/band_forming_log.json`;

export default function BandView({ isMobile, light }) {
  const [band, setBand] = useState(null);
  const [q, setQ] = useState({});
  const [qAt, setQAt] = useState(null);
  const [flog, setFlog] = useState(null);
  const [, tick] = useState(0);        // 每 15s 迫一次 re-render，令「幾分鐘前」跳動
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("forming");
  C = light ? THEMES.light : THEMES.dark;   // 由 App 個掣統一控制

  useEffect(() => {
    fetch(`${BAND_URL}?t=${Date.now()}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(setBand)
      .catch(e => setErr(`攞唔到 band.json（${e.message}）— 未行過 band_scan.py，或者部署未完成`));
    fetch(`${FLOG_URL}?t=${Date.now()}`)
      .then(r => r.json()).then(d => setFlog(d.summary || null)).catch(() => {});
  }, []);

  useEffect(() => {
    const pull = () =>
      fetch(`${QUOTES_URL}?t=${Date.now()}`)
        .then(r => r.json())
        .then(d => { setQ(d.quotes || {}); setQAt(d.quoted_at); })
        .catch(() => {});
    pull();
    // 15 秒 poll。⚠️ 唔會令價更新得快 —— band_quotes.json 係 Actions
    // 每 15 分鐘（cron :05/:20/:35/:50）先重新生成。呢度 poll 密啲只係
    // 令新一批數據一到就即刻見到，同埋令「幾分鐘前」個顯示跳得準。
    const id = setInterval(() => { pull(); tick(n => n + 1); }, 15_000);
    return () => clearInterval(id);
  }, []);

  if (err) return <Msg t={err} />;
  if (!band) return <Msg t="載入緊…" />;

  const live = s => q[s]?.price ?? null;
  const cnt = band.counts;
  const nowI = new Date().toISOString();
  const exec = band.bar_date ? nextBiz(band.bar_date) : null;
  const stale = exec && (nowI.slice(0, 10) > exec ||
    (nowI.slice(0, 10) === exec && nowI.slice(11, 16) >= "13:35"));

  const TABS = [
    ["forming", "⏳", "形成中", cnt.forming_live ?? cnt.forming],
    ["confirmed", "✅", "已確認", cnt.confirmed],
    ["candidates", "●", "候選", cnt.candidates],
    ["exits", "▼", "出場", cnt.exits],
    ["observe", "○", "觀察", cnt.observe],
  ];
  const P_ = { band, live, q, cnt, flog, exec, isMobile, stale };

  return (
    <div style={{
      background: C.bg, color: C.txt, fontFamily: F,
      padding: isMobile ? "8px 8px 24px" : 16, width: "100%", overflowX: "hidden",
    }}>
      <Head band={band} qAt={qAt} isMobile={isMobile} />

      <div style={{
        display: "flex", gap: 4, margin: "10px 0 8px",
        overflowX: "auto", WebkitOverflowScrolling: "touch",
        scrollbarWidth: "none", paddingBottom: 2,
      }}>
        {TABS.map(([id, ic, label, n]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flexShrink: 0, padding: isMobile ? "6px 10px" : "5px 12px",
            borderRadius: 7, border: "none", cursor: "pointer", fontFamily: F,
            fontSize: isMobile ? 12 : 11, fontWeight: 700,
            background: tab === id ? C.tabOn : C.chip,
            color: tab === id ? C.acc : C.mute,
          }}>
            {ic} {label} <span style={{ opacity: .75 }}>{n}</span>
          </button>
        ))}
      </div>

      {stale && <Stale bar={band.bar_date} exec={exec} isMobile={isMobile} />}

      {tab === "forming" && <Forming {...P_} rows={band.forming} />}
      {tab === "confirmed" && <Confirmed {...P_} rows={band.confirmed} />}
      {tab === "candidates" && <Candidates {...P_} rows={band.candidates} />}
      {tab === "exits" && <Exits {...P_} rows={band.exits} />}
      {tab === "observe" && <Observe {...P_} rows={band.observe} />}
    </div>
  );
}

/* ══════════ 共用零件 ══════════ */
const Msg = ({ t }) => (
  <div style={{ background: C.bg, color: C.sub, fontFamily: F, padding: 40, textAlign: "center", fontSize: 13 }}>{t}</div>
);
const Empty = ({ t }) => (
  <div style={{ color: C.mute, fontSize: 12, padding: "28px 8px", textAlign: "center" }}>{t}</div>
);

/**
 * 報價新鮮度。舊過兩個鐘就標黃 —— 唔係 bug，係 cron 分時段：
 * 港股時段（01-07 UTC）嘅 run 只抽港股報價，美股要等 08:05Z 之後。
 * 冇呢句提示，你就要靠個時間戳自己推算點解成版都係「—」。
 */
function quoteAge(qAt) {
  if (!qAt) return null;
  const now = new Date();
  const mins = (now - new Date(qAt)) / 60000;
  if (mins < 0 || !Number.isFinite(mins)) return null;
  const h = mins / 60;
  const ago = mins < 1 ? "啱啱" : h < 1 ? `${Math.round(mins)} 分鐘前` : `${h.toFixed(1)} 小時前`;

  // 美股正常時段 13:30–20:00 UTC；之外冇即時價係預期之內
  const u = now.getUTCHours() + now.getUTCMinutes() / 60;
  const usOpen = u >= 13.5 && u < 20;

  // 下次報價：cron 固定 :05/:20/:35/:50，所以算得出。
  // 只喺會真係抽美股嗰啲時段（08-23 UTC）先顯示 —— 港股時段（01-07）
  // 嘅 run 唔會 touch 美股報價，講「下次 :35」會誤導。
  const m = now.getUTCMinutes();
  const slots = [5, 20, 35, 50];
  const nx = slots.find(x => x > m);
  const hh = nx == null ? (now.getUTCHours() + 1) % 24 : now.getUTCHours();
  const next = now.getUTCHours() >= 8
    ? `${String(hh).padStart(2, "0")}:${String(nx ?? 5).padStart(2, "0")}Z`
    : null;
  const nextIn = next ? Math.round(((nx ?? 65) - m + 60) % 60) || 15 : null;

  return { stale: h >= 2, ago, next, nextIn, why: usOpen ? "報價可能有問題" : "美股未開市" };
}

function Head({ band, qAt, isMobile }) {
  const [open, setOpen] = useState(false);
  const c = band.config;
  const age = quoteAge(qAt);
  return (
    <div style={{ borderLeft: `3px solid ${C.acc}`, paddingLeft: 9 }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: isMobile ? 16 : 19, fontWeight: 800, letterSpacing: ".02em" }}>
          TRIPLE BAND
        </span>
        <span style={{
          fontSize: 10.5, fontFamily: M,
          color: age?.stale ? C.warn : C.mute,
        }}>
          {band.bar_date} · 報價 {qAt ? qAt.slice(11, 16) : "—"}Z
          {age && ` · ${age.ago}`}
          {age?.stale && ` · ${age.why}`}
          {age?.next && !age.stale && (
            <span style={{ color: C.mute }}> · 下次 ~{age.next}（{age.nextIn}分）</span>
          )}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={() => setOpen(v => !v)} style={{
            background: "transparent", border: `1px solid ${C.mute}`, borderRadius: 20,
            color: C.sub, fontSize: 11, width: 24, height: 24,
            cursor: "pointer", fontFamily: F, lineHeight: 1, padding: 0,
          }}>{open ? "×" : "i"}</button>
        </span>
      </div>
      {open && (
        <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6, lineHeight: 1.7 }}>
          美股 only · rU60 ≤ {c.ru_thr}% · ext ≥ {c.stretch_k} · UT KV{c.ut_key}/ATR{c.ut_atr} ·
          每注 {c.size_pct}% · cap {c.cap} fifo · <b style={{ color: C.warn }}>次日開市入場</b>
          <div style={{ color: C.mute, marginTop: 3 }}>{c.verified}</div>
        </div>
      )}
    </div>
  );
}

function Stale({ bar, exec, isMobile }) {
  const [open, setOpen] = useState(!isMobile);
  return (
    <div onClick={() => setOpen(v => !v)} style={{
      background: C.staleBg, border: `1px solid ${C.dn}`, borderRadius: 8,
      padding: "7px 10px", marginBottom: 8, fontSize: 12, lineHeight: 1.65,
      color: C.warn, cursor: "pointer",
    }}>
      <b>⚠ 執行窗口已過</b> · {exec} 開市已收
      {open && (
        <div style={{ marginTop: 4, color: C.sub }}>
          基準棒 {bar}，規格係次日開市入場。「已確認」而家當紀錄睇 ——
          追入嘅成本會同回測脫節。等收市後嗰次掃描。
        </div>
      )}
    </div>
  );
}

/** 說明文字：預設收埋，撳先展開。每個 tab 一打開就見數據。 */
function Info({ children, label = "點解／點睇" }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 8 }}>
      <button onClick={() => setOpen(v => !v)} style={{
        background: "transparent", border: "none", color: C.dim, cursor: "pointer",
        fontSize: 11.5, fontFamily: F, padding: "3px 0",
      }}>{open ? "▾" : "▸"} {label}</button>
      {open && (
        <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.75, paddingTop: 5 }}>
          {children}
        </div>
      )}
    </div>
  );
}

/** 卡片：左上 symbol / 右上大字主數值；下面兩行細節。 */
function Card({ sym, tag, main, mainSub, rows, flag, dim, strike }) {
  return (
    <div style={{
      background: flag ? C.flagBg : C.card,
      border: `1px solid ${flag ? C.flagLine : C.line}`,
      borderRadius: 10, padding: "11px 13px", marginBottom: 7,
      opacity: dim ?? 1, textDecoration: strike ? "line-through" : "none",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
        <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: ".01em", color: C.txt }}>{sym}</span>
        {tag}
        <span style={{ marginLeft: "auto", textAlign: "right" }}>
          <span style={{ fontSize: 21, fontWeight: 800, fontFamily: M, letterSpacing: "-.02em", color: C.txt }}>
            {main}
          </span>
          {mainSub && <span style={{ fontSize: 14, fontWeight: 700, fontFamily: M, marginLeft: 7 }}>{mainSub}</span>}
        </span>
      </div>
      {rows?.map((r, i) => (
        <div key={i} style={{
          display: "flex", gap: 13, marginTop: 6, fontSize: 12.5,
          fontFamily: M, color: C.dim, flexWrap: "wrap", lineHeight: 1.5,
        }}>{r}</div>
      ))}
    </div>
  );
}

const K = ({ l, v, c, b }) => (
  <span>{l} <span style={{ color: c || C.txt, fontWeight: b ? 700 : 400 }}>{v}</span></span>
);

const Pill = ({ t, c }) => (
  <span style={{
    fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
    background: `${c}26`, color: c, fontFamily: F,
  }}>{t}</span>
);

/* 桌面表格 */
const Tbl = ({ cols, children }) => (
  <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
      <thead><tr style={{ color: C.mute, fontSize: 10.5 }}>
        {cols.map((h, i) => (
          <th key={i} style={{
            padding: "6px", borderBottom: `1px solid ${C.line}`, fontWeight: 700,
            textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap",
          }}>{h}</th>
        ))}
      </tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);
const Td = ({ children, c, b, l }) => (
  <td style={{
    padding: "7px 6px", borderBottom: `1px solid ${C.line}`, textAlign: l ? "left" : "right",
    color: c || C.txt, fontWeight: b ? 700 : 400, whiteSpace: "nowrap",
    fontFamily: M, fontVariantNumeric: "tabular-nums",
  }}>{children}</td>
);

/* ══════════ ⏳ 形成中 ══════════ */
function Forming({ rows, q, flog, isMobile }) {
  const [showDead, setShowDead] = useState(false);
  if (!rows?.length) return <Empty t="今日冇形成中訊號" />;
  const alive = r => (r.tier_gap_pct ?? 0) > -3;
  const dead = rows.filter(r => !alive(r)).length;
  const shown = showDead ? rows : rows.filter(alive);

  const calc = r => {
    const d = q[r.symbol] || {};
    const lo = d.day_low, px = d.price;
    return {
      lo, px,
      dLow: lo != null ? (lo / r.kill_low - 1) * 100 : null,
      dCls: px != null ? (r.kill_close / px - 1) * 100 : r.tier_gap_pct,
      broke: lo != null && lo <= r.kill_low,
      small: px != null ? px > r.kill_close : r.tier_gap_pct < 0,
    };
  };

  return (
    <>
      {flog?.rate != null ? (
        <div style={{
          fontSize: 12, marginBottom: 9, fontFamily: M,
          color: flog.rate >= 80 ? C.up : flog.rate >= 60 ? C.warn : C.dn,
        }}>
          📊 守住 → 確認 <b>{flog.hold_confirmed}/{flog.hold_resolved} = {flog.rate}%</b>
          <span style={{ color: C.mute }}> · {flog.days}日
            {flog.hold_resolved < 20 && " · 樣本細，未讀得"}</span>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: C.mute, marginBottom: 9, fontFamily: M }}>
          📊 轉化率累積緊
        </div>
      )}

      <Info>
        pivot 喺 <b>今日</b> 完成第三支右棒 —— 收市前一切未定，但只有兩個死因：
        <br />① 今日 Low 跌穿 pivot low → 訊號消失
        <br />② 今日收市高過門檻 → rU60 升穿 −5%，變 small
        <br />ext 唔會變，冷卻同左邊三棒已封。兩條線守得住，收市就變「已確認」。
        <br /><b style={{ color: C.warn }}>唔好喺確認之前買</b> —— 咁做係用未驗證嘅規則
        取代已驗證嘅，而且你會系統性買到最後作廢嗰批。越接近收市，「守住」越有約束力。

        <div style={{
          marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}`,
        }}>
          <b style={{ color: C.warn }}>ext 高唔代表值得做。</b>
          ext 負責搵到「插得夠深」嘅位，rU60 負責篩走「已經升咗好耐先回一回」嘅。
          <b> 後者先係真正嘅過濾器</b> —— 所以睇呢一頁嗰陣，<b>「要郁」比「ext」重要</b>。
          <br />10 年數據：big tier（rU60 ≤ −5%）PF <b>2.03</b> vs small tier <b>1.64</b>；
          而 ext 嘅 L1/L2 分級只差 1.64 vs 1.73，<b>基本上冇分辨力</b>。
          <br /><span style={{ color: C.mute }}>
            例：HOOD ext 5.07 同 COIN ext 5.12 幾乎一樣，但 HOOD 60 日升咗兩成，
            要今日插 21.7% 先夠格 → 實際已死。
          </span>
        </div>
      </Info>

      {isMobile ? shown.map(r => {
        const c = calc(r);
        const st = c.broke ? ["作廢", C.dn] : c.small ? ["未夠跌", C.warn] : ["守住", C.up];
        return (
          <Card key={r.symbol} sym={r.symbol}
            tag={<Pill t={st[0]} c={st[1]} />}
            main={N(c.px)} flag={c.broke} dim={c.broke ? .45 : 1}
            rows={[
              <>
                <K l="Low" v={N(c.lo)} />
                <K l="破線" v={N(r.kill_low)} c={C.dn} />
                <K l="" v={P(c.dLow)} c={c.broke ? C.dn : c.dLow < 1 ? C.warn : C.up} b />
              </>,
              c.broke ? <span style={{ color: C.mute }}>pivot 已破，第二條線冇意義</span> : (
                <>
                  <K l="收市≤" v={N(r.kill_close)} c={C.warn} />
                  <K l="要郁" v={P(c.dCls)} c={c.dCls < -3 ? C.dn : c.dCls < 0 ? C.warn : C.up} b />
                  <K l="ext" v={N(r.ext)} c={C.acc} b />
                </>
              ),
            ]} />
        );
      }) : (
        <Tbl cols={["標的", "ext", "今日Low", "破線", "距離", "現價", "收市≤", "要郁", "狀態"]}>
          {shown.map(r => {
            const c = calc(r);
            const st = c.broke ? ["作廢", C.dn] : c.small ? ["未夠跌", C.warn] : ["守住", C.up];
            return (
              <tr key={r.symbol} style={{
                background: c.broke ? C.flagBg : "transparent",
                opacity: c.broke ? .4 : 1, textDecoration: c.broke ? "line-through" : "none",
              }}>
                <Td l b>{r.symbol}</Td>
                <Td c={C.acc} b>{N(r.ext)}</Td>
                <Td>{N(c.lo)}</Td>
                <Td c={C.dn}>{N(r.kill_low)}</Td>
                <Td b c={c.broke ? C.dn : c.dLow < 1 ? C.warn : C.up}>{P(c.dLow)}</Td>
                <Td b>{N(c.px)}</Td>
                <Td c={c.broke ? C.mute : C.warn}>{c.broke ? "—" : N(r.kill_close)}</Td>
                {c.broke ? <Td c={C.mute}>—</Td>
                  : <Td b c={c.dCls < -3 ? C.dn : c.dCls < 0 ? C.warn : C.up}>{P(c.dCls)}</Td>}
                <Td b c={st[1]}>{st[0]}</Td>
              </tr>
            );
          })}
        </Tbl>
      )}

      {dead > 0 && (
        <button onClick={() => setShowDead(v => !v)} style={{
          background: "transparent", border: `1px solid ${C.mute}`, borderRadius: 6,
          color: C.dim, fontSize: 10, padding: "5px 10px", cursor: "pointer",
          fontFamily: F, marginTop: 6, width: "100%",
        }}>
          {showDead ? "收埋" : `另有 ${dead} 隻 rU60 距 −5% 太遠（實際已死）`}
        </button>
      )}
    </>
  );
}

/* ══════════ ✅ 已確認 ══════════ */
function Confirmed({ rows, live, exec, isMobile }) {
  if (!rows?.length) return <Empty t="今日冇確認訊號" />;
  return (
    <>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 9, fontFamily: M }}>
        執行日 <b style={{ color: C.warn }}>{exec || "—"}</b> 開市市價
      </div>
      <Info>
        pivot 七支棒全部收咗市 —— <b style={{ color: C.up }}>鎖死咗，唔會 repaint</b>。
        平均跳空成本 +0.15%。唔好掛限價等回到訊號價 —— 咁樣你只會買到繼續跌嗰啲，
        係另一個未驗證過嘅策略。
      </Info>

      {isMobile ? rows.map(r => {
        const p = live(r.symbol);
        const gap = p ? (p / r.price - 1) * 100 : null;
        return (
          <Card key={r.symbol} sym={r.symbol}
            tag={r.veto_days != null ? <Pill t={`⛔業績 ${r.veto_days}d`} c={C.dn} /> : null}
            main={N(p)} mainSub={<span style={{ color: gapC(gap) }}>{P(gap)}</span>}
            flag={r.veto_days != null}
            rows={[<>
              <K l="訊號" v={N(r.price)} />
              <K l="ext" v={N(r.ext)} c={C.acc} b />
              <K l="rU60" v={P(r.ru60)} />
              <K l="stop" v={N(r.ut_stop)} c={C.sub} />
            </>]} />
        );
      }) : (
        <Tbl cols={["標的", "訊號價", "現價", "vs訊號", "ext", "rU60", "UT stop", "業績"]}>
          {rows.map(r => {
            const p = live(r.symbol);
            const gap = p ? (p / r.price - 1) * 100 : null;
            return (
              <tr key={r.symbol} style={{ background: r.veto_days != null ? C.flagBg : "transparent" }}>
                <Td l b>{r.symbol}</Td>
                <Td c={C.dim}>{N(r.price)}</Td>
                <Td b>{N(p)}</Td>
                <Td b c={gapC(gap)}>{P(gap)}</Td>
                <Td c={C.acc} b>{N(r.ext)}</Td>
                <Td c={C.dim}>{P(r.ru60)}</Td>
                <Td c={C.sub}>{N(r.ut_stop)}</Td>
                <Td c={r.veto_days != null ? C.dn : C.mute} b>
                  {r.veto_days != null ? `⛔${r.veto_days}d` : "—"}</Td>
              </tr>
            );
          })}
        </Tbl>
      )}
    </>
  );
}

/* ══════════ ● 有效候選 ══════════ */
function Candidates({ rows, live, cnt, band, isMobile }) {
  if (!rows?.length) return <Empty t="而家冇未出場嘅候選" />;
  return (
    <>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 9, fontFamily: M }}>
        {cnt.candidates} 隻 · cap {band.config.cap} 之下會係 {cnt.candidates_capped} 隻
      </div>
      <Info>
        訊號成立後一直顯示到 UT 出場為止，訊號日由新到舊。
        <br /><b style={{ color: C.warn }}>「vs訊號」係追高成本</b>：正數 = 今日買貴過原訊號價。
        回測入場價係次日開市；隔咗幾日先入，呢個偏離就係你同回測嘅差距。
        落單後記低佢，跑幾個月睇平均。
        <br />UT「未轉多」= 入場後未曾翻多，暫時冇止蝕位可用 —— 呢批係策略嘅左尾。
      </Info>

      {isMobile ? rows.map(r => {
        const p = live(r.symbol);
        const gap = p ? (p / r.entry_price - 1) * 100 : null;
        const ds = p && r.ut_pos === 1 ? (p - r.ut_stop) / p * 100 : null;
        return (
          <Card key={`${r.symbol}${r.entry_date}`} sym={r.symbol}
            tag={<>
              <span style={{ fontSize: 11.5, color: C.mute, fontFamily: M }}>{r.entry_date?.slice(5)}</span>
              {r.veto_days != null && <Pill t={`⛔${r.veto_days}d`} c={C.dn} />}
            </>}
            main={N(p)} mainSub={<span style={{ color: gapC(gap) }}>{P(gap)}</span>}
            flag={r.veto_days != null}
            rows={[<>
              <K l="訊號" v={N(r.entry_price)} />
              <K l="stop" v={N(r.ut_stop)} c={C.sub} />
              {r.ut_pos === 1
                ? <K l="距" v={P(ds)} c={ds != null && ds < 3 ? C.dn : C.txt} b />
                : <span style={{ color: C.mute }}>UT 未轉多</span>}
              <span style={{ marginLeft: "auto", color: C.mute }}>{r.bars}d</span>
            </>]} />
        );
      }) : (
        <Tbl cols={["標的", "訊號日", "訊號價", "現價", "vs訊號", "UT stop", "距stop", "UT", "已過", "業績"]}>
          {rows.map(r => {
            const p = live(r.symbol);
            const gap = p ? (p / r.entry_price - 1) * 100 : null;
            const ds = p && r.ut_pos === 1 ? (p - r.ut_stop) / p * 100 : null;
            return (
              <tr key={`${r.symbol}${r.entry_date}`} style={{ background: r.veto_days != null ? C.flagBg : "transparent" }}>
                <Td l b>{r.symbol}</Td>
                <Td c={C.dim}>{r.entry_date?.slice(5)}</Td>
                <Td c={C.dim}>{N(r.entry_price)}</Td>
                <Td b>{N(p)}</Td>
                <Td b c={gapC(gap)}>{P(gap)}</Td>
                <Td c={C.sub}>{N(r.ut_stop)}</Td>
                <Td b c={ds == null ? C.mute : ds < 3 ? C.dn : C.txt}>{ds == null ? "—" : P(ds)}</Td>
                <Td c={r.ut_pos === 1 ? C.up : C.mute}>{r.ut_pos === 1 ? "✓多" : "未轉多"}</Td>
                <Td c={C.dim}>{r.bars}d</Td>
                <Td c={r.veto_days != null ? C.dn : C.mute} b>
                  {r.veto_days != null ? `⛔${r.veto_days}d` : "—"}</Td>
              </tr>
            );
          })}
        </Tbl>
      )}
    </>
  );
}

/* ══════════ ▼ 出場 ══════════ */
function Exits({ rows, isMobile }) {
  if (!rows?.length) return <Empty t="今日冇 UT 出場" />;
  return (
    <>
      <Info>UT Bot 由非空翻落空 —— 當日收市價平倉。冇止蝕、冇止賺、冇時間止蝕。</Info>
      {isMobile ? rows.map(r => (
        <Card key={`${r.symbol}${r.entry_date}`} sym={r.symbol}
          tag={<span style={{ fontSize: 11.5, color: C.mute, fontFamily: M }}>{r.entry_date?.slice(5)}</span>}
          main={N(r.price)}
          mainSub={<span style={{ color: r.ret_pct >= 0 ? C.up : C.dn }}>{P(r.ret_pct)}</span>}
          rows={[<>
            <K l="入場" v={N(r.entry_price)} />
            <span style={{ marginLeft: "auto", color: C.mute }}>持有 {r.bars}d</span>
          </>]} />
      )) : (
        <Tbl cols={["標的", "訊號日", "入場價", "出場價", "回報", "持有"]}>
          {rows.map(r => (
            <tr key={`${r.symbol}${r.entry_date}`}>
              <Td l b>{r.symbol}</Td>
              <Td c={C.dim}>{r.entry_date?.slice(5)}</Td>
              <Td c={C.dim}>{N(r.entry_price)}</Td>
              <Td b>{N(r.price)}</Td>
              <Td b c={r.ret_pct >= 0 ? C.up : C.dn}>{P(r.ret_pct)}</Td>
              <Td c={C.dim}>{r.bars}d</Td>
            </tr>
          ))}
        </Tbl>
      )}
    </>
  );
}

/* ══════════ ○ 觀察 ══════════ */
function Observe({ rows, live, isMobile }) {
  if (!rows?.length) return <Empty t="今日觀察組冇訊號" />;
  return (
    <>
      <div style={{ fontSize: 12, color: C.warn, marginBottom: 9, fontWeight: 700 }}>
        唔喺已驗證配置入面 — 唔落注
      </div>
      <Info>
        港股 big-filter 之下 PF 只有 1.52（美股 2.03）；美股 small tier PF 1.64。
        加返落去年化由 25.2% 跌到 21% 左右、Calmar 由 0.76 跌到 0.61。呢度淨係畀你睇下市況。
      </Info>
      <div style={{ opacity: .6 }}>
        {isMobile ? rows.map(r => (
          <Card key={r.symbol} sym={r.symbol}
            tag={<Pill t={r.market === "HK" ? "港股" : "small"} c={C.mute} />}
            main={N(live(r.symbol))}
            rows={[<>
              <K l="ext" v={N(r.ext)} c={C.acc} />
              <K l="rU60" v={P(r.ru60)} />
              <K l="stop" v={N(r.ut_stop)} />
            </>]} />
        )) : (
          <Tbl cols={["標的", "市場", "類別", "現價", "ext", "rU60", "UT stop"]}>
            {rows.map(r => (
              <tr key={r.symbol}>
                <Td l b>{r.symbol}</Td>
                <Td c={C.dim}>{r.market}</Td>
                <Td c={C.dim}>{r.market === "HK" ? "港股" : "small"}</Td>
                <Td>{N(live(r.symbol))}</Td>
                <Td c={C.acc}>{N(r.ext)}</Td>
                <Td c={C.dim}>{P(r.ru60)}</Td>
                <Td c={C.sub}>{N(r.ut_stop)}</Td>
              </tr>
            ))}
          </Tbl>
        )}
      </div>
    </>
  );
}
