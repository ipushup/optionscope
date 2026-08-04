import { useEffect, useState } from "react";

/**
 * Band.jsx — Triple Band radar
 *
 * 讀 band.json（收市後計一次）+ band_quotes.json（每 15 分鐘刷）。
 * **前端唔重算任何訊號** —— pivot / ext / rU60 / UT Bot 全部喺 band_scan.py
 * 用收咗市嘅棒計死。呢度只做兩件事：顯示，同埋用即時價計「距死線幾遠」。
 *
 * 四組：
 *   ✅ 已確認   pivot 封死，明早開市買，冇嘢可以推翻
 *   ⏳ 形成中   今日收市先知，兩條死線即時監察
 *   ● 有效候選  已成立未出場，有錢就可以入
 *   ▼ 今日出場
 */

const C = {
  bg: "#050d18", card: "#0a1626", line: "#14293f",
  txt: "#c8d6e8", dim: "#5c7a99", sub: "#7a92ad", mute: "#3a5060",
  up: "#22c98a", dn: "#ff4d6a", warn: "#ffa94d", acc: "#3b9eff",
};

const F = "'Syne',system-ui,sans-serif";
const N = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(d));
const P = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);

export default function BandView({ isMobile }) {
  const [band, setBand] = useState(null);
  const [q, setQ] = useState({});
  const [qAt, setQAt] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("confirmed");

  const base = import.meta.env?.BASE_URL || "/";

  useEffect(() => {
    fetch(`${base}band.json`).then(r => r.json()).then(setBand)
      .catch(() => setErr("攞唔到 band.json — 未行過 band_scan.py？"));
  }, [base]);

  useEffect(() => {
    const pull = () =>
      fetch(`${base}band_quotes.json?t=${Date.now()}`)
        .then(r => r.json())
        .then(d => { setQ(d.quotes || {}); setQAt(d.quoted_at); })
        .catch(() => {});
    pull();
    const id = setInterval(pull, 60_000);   // 檔案每 15 分鐘更新，前端一分鐘睇一次
    return () => clearInterval(id);
  }, [base]);

  if (err) return <Msg t={err} />;
  if (!band) return <Msg t="載入緊…" />;

  const live = s => q[s]?.price ?? null;
  const cnt = band.counts;
  // 訊號基準棒 vs 今日。基準棒嘅「下一個開市」已經過去 = confirmed 嗰批
  // 執行窗口關咗 —— 盤中手動跑 full scan 就會出現呢種情況。
  // 開市之後先睇到 = 窗口已關。淨係比日期唔夠 —— 今日就係「執行日 == 今日
  // 但 13:30 UTC 開市已經過咗」嗰種情況。
  const nowI = new Date().toISOString();
  const exec = band.bar_date ? nextBiz(band.bar_date) : null;
  const stalebar = exec && (nowI.slice(0, 10) > exec ||
    (nowI.slice(0, 10) === exec && nowI.slice(11, 16) >= "13:35"));
  const TABS = [
    ["confirmed", "✅ 已確認", cnt.confirmed],
    ["forming", "⏳ 形成中", cnt.forming_live ?? cnt.forming],
    ["candidates", "● 有效候選", cnt.candidates],
    ["exits", "▼ 出場", cnt.exits],
    ["observe", "○ 觀察", cnt.observe],
  ];

  return (
    <div style={{ background: C.bg, color: C.txt, fontFamily: F, padding: isMobile ? 10 : 16 }}>
      <Head band={band} qAt={qAt} isMobile={isMobile} />

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0" }}>
        {TABS.map(([id, label, n]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: "5px 11px", borderRadius: 6, border: "none", cursor: "pointer",
            fontSize: 11, fontWeight: 700, fontFamily: F,
            background: tab === id ? "#1a3555" : "transparent",
            color: tab === id ? C.acc : C.mute,
          }}>{label} {n}</button>
        ))}
      </div>

      {stalebar && (
        <div style={{
          background: "#2a1410", border: `1px solid ${C.dn}`, borderRadius: 6,
          padding: "8px 10px", margin: "0 0 10px", fontSize: 10, lineHeight: 1.6, color: C.warn,
        }}>
          ⚠ <b>執行窗口已經過去。</b>訊號基準棒 {band.bar_date}，執行日 {exec} 開市 —
          而嗰個開市已經過咗。呢批「已確認」淨係當紀錄睇 —— 唔好而家先
          追入，你嘅成本會同回測完全脫節。等收市後嗰次掃描。
        </div>
      )}
      {tab === "confirmed" && <Confirmed rows={band.confirmed} live={live} cfg={band.config} barDate={band.bar_date} isMobile={isMobile} />}
      {tab === "forming" && <Forming rows={band.forming} q={q} isMobile={isMobile} />}
      {tab === "candidates" && <Candidates rows={band.candidates} live={live} cnt={cnt} cfg={band.config} isMobile={isMobile} />}
      {tab === "exits" && <Exits rows={band.exits} isMobile={isMobile} />}
      {tab === "observe" && <Observe rows={band.observe} live={live} isMobile={isMobile} />}
    </div>
  );
}

/* ─────────── 共用 ─────────── */
const Msg = ({ t }) => (
  <div style={{ background: C.bg, color: C.sub, fontFamily: F, padding: 40, textAlign: "center", fontSize: 13 }}>{t}</div>
);

const Empty = ({ t }) => (
  <div style={{ color: C.mute, fontSize: 12, padding: "24px 8px", textAlign: "center" }}>{t}</div>
);

function Head({ band, qAt, isMobile }) {
  const c = band.config;
  const stale = qAt && band.scanned_at && qAt.slice(0, 10) !== band.scanned_at.slice(0, 10);
  return (
    <div style={{ borderLeft: `3px solid ${C.acc}`, paddingLeft: 10 }}>
      <div style={{ fontSize: isMobile ? 15 : 18, fontWeight: 800, letterSpacing: ".02em" }}>
        TRIPLE BAND
      </div>
      <div style={{ fontSize: 10, color: C.sub, marginTop: 3, lineHeight: 1.55 }}>
        美股 only · rU60 ≤ {c.ru_thr}% · ext ≥ {c.stretch_k} · UT KV{c.ut_key}/ATR{c.ut_atr} ·
        每注 {c.size_pct}% · cap {c.cap} fifo · <b style={{ color: C.warn }}>次日開市入場</b>
      </div>
      <div style={{ fontSize: 9, color: C.mute, marginTop: 2 }}>
        {c.verified}
      </div>
      <div style={{ fontSize: 9, color: stale ? C.warn : C.mute, marginTop: 4 }}>
        掃描 {band.scanned_at?.slice(0, 16).replace("T", " ")}Z
        {qAt && ` · 報價 ${qAt.slice(11, 16)}Z`}
        {stale && " · ⚠ 掃描結果唔係今日，等收市後嗰 run"}
      </div>
    </div>
  );
}

const Tbl = ({ cols, children, isMobile }) => (
  <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 10 : 11 }}>
      <thead>
        <tr style={{ color: C.mute, fontSize: 9, textAlign: "left" }}>
          {cols.map((h, i) => (
            <th key={i} style={{
              padding: "5px 6px", borderBottom: `1px solid ${C.line}`, fontWeight: 700,
              textAlign: i === 0 ? "left" : "right", whiteSpace: "nowrap",
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

const Td = ({ children, c, b, l }) => (
  <td style={{
    padding: "6px", borderBottom: `1px solid ${C.line}`, textAlign: l ? "left" : "right",
    color: c || C.txt, fontWeight: b ? 700 : 400, whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  }}>{children}</td>
);

const Sym = ({ s }) => <Td l b c={C.txt}>{s}</Td>;

const Note = ({ children }) => (
  <div style={{ fontSize: 9, color: C.mute, padding: "8px 6px", lineHeight: 1.6 }}>{children}</div>
);

const Veto = ({ d }) => d == null
  ? <Td c={C.mute}>—</Td>
  : <Td c={C.dn} b>⛔{d}d</Td>;

/* ─────────── ✅ 已確認 ─────────── */
function nextBiz(d) {
  const t = new Date(`${d}T00:00:00Z`);
  do { t.setUTCDate(t.getUTCDate() + 1); } while (t.getUTCDay() === 0 || t.getUTCDay() === 6);
  return t.toISOString().slice(0, 10);
}

function Confirmed({ rows, live, cfg, barDate, isMobile }) {
  if (!rows.length) return <Empty t="今日冇確認訊號" />;
  return (
    <>
      <Note>
        訊號基準棒 <b>{barDate}</b> · 執行日 = <b>{barDate ? nextBiz(barDate) : "—"}</b> 開市。
        <br />pivot 窗口七支棒已經全部收咗市 —— <b style={{ color: C.up }}>呢啲訊號鎖死咗，唔會 repaint</b>。
        回測規格係 <b>次日開市市價</b> 入場（平均跳空成本 +0.15%）。
        唔好掛限價等回到訊號價 —— 咁樣你只會買到繼續跌嗰啲，係另一個未驗證過嘅策略。
      </Note>
      <Tbl isMobile={isMobile} cols={["標的", "訊號價", "現價", "vs訊號", "ext", "rU60", "UT stop", "業績"]}>
        {rows.map(r => {
          const p = live(r.symbol);
          const gap = p ? (p / r.price - 1) * 100 : null;
          return (
            <tr key={r.symbol} style={{ background: r.veto_days != null ? "#1a0d14" : "transparent" }}>
              <Sym s={r.symbol} />
              <Td c={C.dim}>{N(r.price)}</Td>
              <Td b>{N(p)}</Td>
              <Td b c={gap == null ? C.mute : gap > 0 ? C.dn : C.up}>{P(gap)}</Td>
              <Td c={C.acc} b>{N(r.ext)}</Td>
              <Td c={C.dim}>{P(r.ru60)}</Td>
              <Td c={C.sub}>{N(r.ut_stop)}</Td>
              <Veto d={r.veto_days} />
            </tr>
          );
        })}
      </Tbl>
    </>
  );
}

/* ─────────── ⏳ 形成中 ─────────── */
function Forming({ rows, q, isMobile }) {
  const [showDead, setShowDead] = useState(false);
  if (!rows.length) return <Empty t="今日冇形成中訊號" />;
  // 用 −3% 容差，唔用 tier_ok 一刀切：差 1-2% 係今日真係做得到嘅
  // （見過 NVDA 要 −1.6%），差 20% 先算死。
  const live = r => (r.tier_gap_pct ?? 0) > -3;
  const dead = rows.filter(r => !live(r)).length;
  const shown = showDead ? rows : rows.filter(live);
  return (
    <>
      <Note>
        pivot 喺 <b>今日</b> 完成第三支右棒 —— 收市之前一切未定。但只有<b style={{ color: C.warn }}>兩個死因</b>：
        <br />① 今日 Low 跌穿 pivot low → pivot 唔再係窗口唯一最低，訊號消失
        <br />② 今日收市高過門檻 → rU60 升穿 −5%，變 small tier，唔入場
        <br />ext 唔會變（用 pivot 當日嘅 m1/w1），冷卻同左邊三棒亦已封。
        <b> 兩條線都守得住，收市就變「已確認」，下個開市買。</b>
        {dead > 0 && (
          <>
            <br /><span style={{ color: C.dim }}>
              另外 {dead} 隻 rU60 距 −5% 太遠（要今日暴跌先入到 big），實際已經死，預設收埋。
            </span>{" "}
            <button onClick={() => setShowDead(v => !v)} style={{
              background: "transparent", border: `1px solid ${C.mute}`, borderRadius: 4,
              color: C.sub, fontSize: 9, padding: "1px 6px", cursor: "pointer", fontFamily: F,
            }}>{showDead ? "收埋" : "照睇"}</button>
          </>
        )}
      </Note>
      <Tbl isMobile={isMobile} cols={["標的", "ext", "今日Low", "跌穿即廢", "距離", "現價", "變small線", "要郁", "狀態"]}>
        {shown.map(r => {
          const d = q[r.symbol] || {};
          const lo = d.day_low, px = d.price;
          const dLow = lo != null ? (lo / r.kill_low - 1) * 100 : null;
          // 要郁 = 今日收市相對現價要變幾多先過到 rU60 關。冇即時價就用
          // 掃描時計嘅 tier_gap_pct。大負數 = 今日冇可能做到。
          const dCls = px != null ? (r.kill_close / px - 1) * 100 : r.tier_gap_pct;
          const broke = lo != null && lo <= r.kill_low;
          const small = px != null ? px > r.kill_close : r.tier_ok === false;
          const st = broke ? ["作廢", C.dn] : small ? ["未夠跌", C.warn] : ["守住", C.up];
          return (
            <tr key={r.symbol} style={{
              background: broke ? "#1a0d14" : "transparent",
              opacity: broke ? 0.35 : (r.tier_gap_pct ?? 0) <= -3 ? 0.5 : 1,
              textDecoration: broke ? "line-through" : "none",
            }}>
              <Sym s={r.symbol} />
              <Td c={C.acc} b>{N(r.ext)}</Td>
              <Td>{N(lo)}</Td>
              <Td c={C.dn}>{N(r.kill_low)}</Td>
              <Td b c={dLow == null ? C.mute : broke ? C.dn : dLow < 1 ? C.warn : C.up}>{P(dLow)}</Td>
              <Td b>{N(px)}</Td>
              <Td c={broke ? C.mute : C.warn}>{broke ? "—" : N(r.kill_close)}</Td>
              {broke
                ? <Td c={C.mute}>—</Td>
                : <Td b c={dCls == null ? C.mute : dCls < -3 ? C.dn : dCls < 0 ? C.warn : C.up}>{P(dCls)}</Td>}
              <Td b c={st[1]}>{st[0]}</Td>
            </tr>
          );
        })}
      </Tbl>
    </>
  );
}

/* ─────────── ● 有效候選 ─────────── */
function Candidates({ rows, live, cnt, cfg, isMobile }) {
  if (!rows.length) return <Empty t="而家冇未出場嘅候選" />;
  return (
    <>
      <Note>
        訊號成立後一直顯示到 UT 出場為止，<b>訊號日由新到舊</b>。
        共 {cnt.candidates} 隻（cap {cfg.cap} 之下會係 {cnt.candidates_capped} 隻 —— 差距就係策略理論上做唔晒嗰部分）。
        <br /><b style={{ color: C.warn }}>「vs訊號」係追高成本</b>：正數 = 今日買貴過原訊號價。
        回測入場價係次日開市；隔咗幾日先入，呢個偏離就係你同回測嘅差距。落單後記低佢，跑幾個月睇平均。
        <br /><span style={{ color: C.dim }}>UT「未轉多」= 入場後未曾翻多，即係暫時冇止蝕位可用 —— 呢批係策略嘅左尾。</span>
      </Note>
      <Tbl isMobile={isMobile} cols={["標的", "訊號日", "訊號價", "現價", "vs訊號", "UT stop", "距stop", "UT", "已過", "業績"]}>
        {rows.map(r => {
          const p = live(r.symbol);
          const gap = p ? (p / r.entry_price - 1) * 100 : null;
          const ds = p && r.ut_pos === 1 ? (p - r.ut_stop) / p * 100 : null;
          return (
            <tr key={`${r.symbol}${r.entry_date}`} style={{ background: r.veto_days != null ? "#1a0d14" : "transparent" }}>
              <Sym s={r.symbol} />
              <Td c={C.dim}>{r.entry_date?.slice(5)}</Td>
              <Td c={C.dim}>{N(r.entry_price)}</Td>
              <Td b>{N(p)}</Td>
              <Td b c={gap == null ? C.mute : gap > 0 ? C.dn : C.up}>{P(gap)}</Td>
              <Td c={C.sub}>{N(r.ut_stop)}</Td>
              <Td b c={ds == null ? C.mute : ds < 3 ? C.dn : C.txt}>{ds == null ? "—" : P(ds)}</Td>
              {r.ut_pos === 1
                ? <Td c={C.up}>✓多</Td>
                : <Td c={C.mute}>未轉多</Td>}
              <Td c={C.dim}>{r.bars}d</Td>
              <Veto d={r.veto_days} />
            </tr>
          );
        })}
      </Tbl>
    </>
  );
}

/* ─────────── ▼ 出場 ─────────── */
function Exits({ rows, isMobile }) {
  if (!rows.length) return <Empty t="今日冇 UT 出場" />;
  return (
    <>
      <Note>UT Bot 由非空翻落空 —— 當日收市價平倉。冇止蝕、冇止賺、冇時間止蝕。</Note>
      <Tbl isMobile={isMobile} cols={["標的", "訊號日", "入場價", "出場價", "回報", "持有"]}>
        {rows.map(r => (
          <tr key={`${r.symbol}${r.entry_date}`}>
            <Sym s={r.symbol} />
            <Td c={C.dim}>{r.entry_date?.slice(5)}</Td>
            <Td c={C.dim}>{N(r.entry_price)}</Td>
            <Td b>{N(r.price)}</Td>
            <Td b c={r.ret_pct >= 0 ? C.up : C.dn}>{P(r.ret_pct)}</Td>
            <Td c={C.dim}>{r.bars}d</Td>
          </tr>
        ))}
      </Tbl>
    </>
  );
}

/* ─────────── ○ 觀察 ─────────── */
function Observe({ rows, live, isMobile }) {
  if (!rows.length) return <Empty t="今日觀察組冇訊號" />;
  return (
    <>
      <Note>
        <b style={{ color: C.warn }}>唔喺已驗證配置入面 —— 唔落注。</b>
        港股 big-filter 之下 PF 只有 1.52（美股 2.03）；美股 small tier PF 1.64。
        加返落去年化由 25.2% 跌到 21% 左右、Calmar 由 0.76 跌到 0.61。呢度淨係畀你睇下市況。
      </Note>
      <div style={{ opacity: 0.55 }}>
        <Tbl isMobile={isMobile} cols={["標的", "市場", "類別", "現價", "ext", "rU60", "UT stop"]}>
          {rows.map(r => (
            <tr key={r.symbol}>
              <Sym s={r.symbol} />
              <Td c={C.dim}>{r.market}</Td>
              <Td c={C.dim}>{r.market === "HK" ? "港股" : "small"}</Td>
              <Td>{N(live(r.symbol))}</Td>
              <Td c={C.acc}>{N(r.ext)}</Td>
              <Td c={C.dim}>{P(r.ru60)}</Td>
              <Td c={C.sub}>{N(r.ut_stop)}</Td>
            </tr>
          ))}
        </Tbl>
      </div>
    </>
  );
}
