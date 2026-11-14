import { Fragment, useEffect, useState } from "react";
import { MiniChart } from "./StockDetail";
import HOLD from "./etfHoldings.json";

/**
 * SectorFlow — 主頁「05 / SECTOR FLOW · 板塊資金流向」
 * 數據：/sector.json（scanner/sector_flow.py，.github/workflows/sector_flow.yml 每 15 分鐘）
 *   每個 ETF：d1 今日、d5／d20 升跌、r5／r20 = {now, prev} 組內排名（prev = 上一個 5／20 日）、flow 即日資金淨流入(M)、chart.{D,W,M}
 * 介面：今日／5 日／20 日熱力格（撳表頭排序）＋排名欄（撳表頭 5 日 ⇄ 20 日）＋撳行展開 K 線 + EMA 10/20/50/89/250（日／週／月）
 */
const M = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Roboto','Segoe UI',system-ui,sans-serif";
const SANS = "'Inter',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
const SCALE = { d1: 3, d5: 6, d20: 12 };
const COLS = [["d1", "今日"], ["d5", "5 日"], ["d20", "20 日"]];
const TFS = [["D", "日"], ["W", "週"], ["M", "月"]];

const rgb = (hex) => { const h = (hex || "#888").replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(","); };
const sgn = (v, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const load = (k, dflt) => { try { return localStorage.getItem(k) || dflt; } catch { return dflt; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ok */ } };

function useNarrow(px = 640) {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(`(max-width:${px}px)`) : null;
  const [n, setN] = useState(!!q && q.matches);
  useEffect(() => {
    if (!q) return undefined;
    const f = () => setN(q.matches);
    q.addEventListener ? q.addEventListener("change", f) : q.addListener(f);
    return () => { q.removeEventListener ? q.removeEventListener("change", f) : q.removeListener(f); };
  }, [q]);
  return n;
}

export default function SectorFlow({ data, T }) {
  const narrow = useNarrow();
  const [sortKey, setSortKey] = useState(() => load("sf_sort", "d1"));
  const [rk, setRk] = useState(() => (load("sf_rank", "5") === "20" ? "20" : "5"));
  const [open, setOpen] = useState(null);
  const [tfMap, setTfMap] = useState(() => { try { return JSON.parse(localStorage.getItem("sf_chart_tf") || "{}") || {}; } catch { return {}; } });
  const setTf = (s, x) => setTfMap((m) => { const n = { ...m, [s]: x }; save("sf_chart_tf", JSON.stringify(n)); return n; });

  // 展開咗嘅 ETF：前 10 大持倉嘅即時升跌（Worker /api/quotes → Longbridge，每 15 秒）
  const [hq, setHq] = useState({});
  useEffect(() => {
    const syms = (HOLD.etfs[open]?.h || []).map((x) => x.s).filter(Boolean);
    if (!syms.length) return undefined;
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(`/api/quotes?symbols=${syms.join(",")}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json(), m = {};
        for (const q of d.quotes || []) if (q.reg > 0) m[q.symbol] = { pct: q.reg_pct, ext: q.session === "regular" ? null : q.pct };
        if (alive) setHq((o) => ({ ...o, ...m }));
      } catch { /* 下一輪再試 */ }
    };
    pull();
    const id = setInterval(pull, 15000);
    return () => { alive = false; clearInterval(id); };
  }, [open]);

  const groups = data?.groups || [];
  const time = data?.updated ? new Date(data.updated).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;

  const tint = (v, k) => {
    if (v == null) return "transparent";
    const a = Math.min(Math.abs(v) / SCALE[k], 1) * 0.5 + 0.05;
    return `rgba(${rgb(v >= 0 ? T.up : T.dn)},${a.toFixed(2)})`;
  };
  const sorted = (items) => [...items].sort((a, b) => (b[sortKey] ?? -1e9) - (a[sortKey] ?? -1e9));

  // 自動總結：今日領漲／領跌（11 大板塊）+ 排名升幅最大
  const summary = (() => {
    const sec = groups.find((g) => g.key === "sector")?.items?.filter((x) => x.d1 != null) || [];
    if (sec.length < 4) return null;
    const by = [...sec].sort((a, b) => b.d1 - a.d1);
    const top = by.slice(0, 2).map((x) => `${x.name} ${sgn(x.d1)}`).join("、");
    const bot = by.slice(-2).reverse().map((x) => `${x.name} ${sgn(x.d1)}`).join("、");
    const jump = sec.map((x) => ({ x, d: x["r" + rk] ? x["r" + rk].prev - x["r" + rk].now : 0 })).sort((a, b) => b.d - a.d)[0];
    return `今日板塊領漲：${top}；領跌：${bot}。${jump && jump.d > 0 ? `${rk} 日排名升幅最大：${jump.x.name}（▲${jump.d}，現排第 ${jump.x["r" + rk].now}）。` : ""}`;
  })();

  const cols = narrow ? "90px 1fr 1fr 1fr 56px" : "110px 1fr 1fr 1fr 78px";
  const th = (on) => ({ background: "none", border: 0, padding: 0, cursor: "pointer", fontFamily: M, fontSize: 10.5, color: on ? T.txt : T.mute, fontWeight: on ? 700 : 400, textDecoration: on ? "underline" : "none", textAlign: "center" });

  const Rank = ({ r }) => {
    if (!r) return <div style={{ textAlign: "right", color: T.mute, fontFamily: M, fontSize: 12 }}>—</div>;
    const d = r.prev - r.now;
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 4, fontFamily: M, fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        <b style={{ fontWeight: 700, color: T.txt }}>#{r.now}</b>
        {d > 0 ? <span style={{ color: T.up, fontWeight: 600, fontSize: 11.5 }}>▲{d}</span> : d < 0 ? <span style={{ color: T.dn, fontWeight: 600, fontSize: 11.5 }}>▼{-d}</span> : <span style={{ color: T.mute }}>–</span>}
      </div>
    );
  };

  const Holdings = ({ sym }) => {
    const h = HOLD.etfs[sym], note = HOLD.notes[sym];
    if (!h) return note ? <div style={{ marginTop: 8, fontSize: 11.5, color: T.mute }}>{note}</div> : null;
    return (
      <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${T.line}` }}>
        <div style={{ fontFamily: M, fontSize: 10.5, color: T.mute, marginBottom: 3 }}>前 10 大持倉 · {h.asof.slice(5).replace("-", "/")} 披露</div>
        {h.h.map((x) => {
          const q = x.s ? hq[x.s] : null;
          return (
            <div key={x.n} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "2px 0", fontFamily: M, fontSize: 12.5 }}>
              <b style={{ minWidth: 48, fontWeight: 600, color: x.s ? T.txt : T.mute }}>{x.s ? x.s.replace(/\.US$/, "") : "—"}</b>
              <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, color: T.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.n}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", color: T.sub, fontSize: 11.5 }}>{x.w.toFixed(1)}%</span>
              <span style={{ minWidth: 56, textAlign: "right", fontVariantNumeric: "tabular-nums", color: q ? (q.pct >= 0 ? T.up : T.dn) : T.mute }}>{q ? sgn(q.pct, 2) : "—"}</span>
            </div>
          );
        })}
      </div>
    );
  };

  const Row = ({ it }) => {
    const on = open === it.sym, ctf = tfMap[it.sym] || "D", c = it.chart?.[ctf];
    return (
      <>
        <div onClick={() => setOpen(on ? null : it.sym)} style={{ display: "grid", gridTemplateColumns: cols, gap: 4, alignItems: "center", height: 29, cursor: "pointer", background: on ? T.soft : "transparent", borderRadius: on ? "6px 6px 0 0" : 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4, overflow: "hidden", whiteSpace: "nowrap" }}>
            <b style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: T.txt }}>{it.sym}</b>
            <span style={{ fontSize: 10, color: T.mute, overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
          </div>
          {COLS.map(([k]) => (
            <div key={k} style={{ height: 22, borderRadius: 5, background: tint(it[k], k), textAlign: "center", fontFamily: M, fontSize: 12, fontWeight: 600, lineHeight: "22px", color: T.txt, fontVariantNumeric: "tabular-nums" }}>{sgn(it[k])}</div>
          ))}
          {Rank({ r: it["r" + rk] })}
        </div>
        {on && (
          <div style={{ background: T.soft, borderRadius: "0 0 8px 8px", padding: "6px 6px 8px", marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6 }}>
              {TFS.map(([k, l]) => (
                <button key={k} type="button" onClick={() => setTf(it.sym, k)} style={{ fontFamily: M, fontSize: 11.5, padding: "3px 10px", borderRadius: 7, cursor: "pointer", color: T.txt, background: ctf === k ? T.card : "transparent", border: `1px solid ${ctf === k ? T.txt : T.line}` }}>{l}</button>
              ))}
              <span style={{ flex: 1 }} />
              {it.last != null && <span style={{ fontFamily: M, fontSize: 11, color: T.mute }}>{it.last.toFixed(2)}{it.flow != null ? ` · 淨流入 ${it.flow >= 0 ? "+" : "−"}${Math.abs(it.flow).toFixed(1)}M` : ""}</span>}
            </div>
            {c ? <MiniChart bars={c.b} emas={c.e} utf={c.u} tbf={c.tb} hvf={c.hv} tf={ctf} T={T} maxBars={narrow ? 60 : undefined} tight={narrow} />
              : <div style={{ color: T.mute, fontFamily: M, fontSize: 12, padding: "14px 0", textAlign: "center" }}>呢個級別暫時冇圖表數據</div>}
            {Holdings({ sym: it.sym })}
          </div>
        )}
      </>
    );
  };

  return (
    <section aria-labelledby="sf5">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 14 }}>
        <div id="sf5" style={{ fontFamily: M, fontSize: 11, letterSpacing: "0.06em", color: T.mute, whiteSpace: "nowrap" }}>05 / SECTOR FLOW · 板塊資金流向</div>
        {time && <div style={{ fontFamily: M, fontSize: 11, color: T.mute }}>updated {time}</div>}
      </div>
      {!groups.length ? (
        <div style={{ border: `1px solid ${T.line}`, background: T.card, borderRadius: 12, padding: 18, fontFamily: M, fontSize: 12, color: T.dim }}>No sector data yet.</div>
      ) : (
        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "12px 12px 10px" }}>
          {summary && <div style={{ padding: "8px 10px", background: T.soft, borderRadius: 8, fontSize: 12.5, lineHeight: 1.65, color: T.sub, marginBottom: 8 }}>{summary}</div>}
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 4, alignItems: "center", marginTop: 6 }}>
            <div style={{ fontFamily: M, fontSize: 10.5, color: T.mute }}>ETF</div>
            {COLS.map(([k, l]) => <button key={k} type="button" onClick={() => { setSortKey(k); save("sf_sort", k); }} style={th(sortKey === k)}>{l}{sortKey === k ? " ▾" : ""}</button>)}
            <button type="button" title="撳一下：5 日排名 ⇄ 20 日排名" onClick={() => { const n = rk === "5" ? "20" : "5"; setRk(n); save("sf_rank", n); }} style={{ ...th(true), textAlign: "right", textDecoration: "none" }}>{rk} 日排名 ⇄</button>
          </div>
          {groups.map((g) => (
            <div key={g.key}>
              <div style={{ fontFamily: M, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", color: T.mute, margin: "10px 0 2px", paddingBottom: 3, borderBottom: `1px solid ${T.line}` }}>{g.title}</div>
              {sorted(g.items).map((it) => <Fragment key={it.sym}>{Row({ it })}</Fragment>)}
            </div>
          ))}
          <div style={{ marginTop: 10, fontSize: 11, lineHeight: 1.65, color: T.mute }}>
            升跌 = 對上日（今日）／5／20 個交易日前收市；排名 = 組內按該期升跌排，▲▼ = 對比上一個同長週期（5–10／20–40 個交易日前）嘅排名升降。撳行展開 K 線圖（EMA 10／20／50／89／250）。白三角 = UT 買／賣 · 橙實心三角 = TB 真入市 · 綠／紅空心方 = Heavy 買／賣 · 最後一棒未收市時訊號係暫時。淨流入為 Longbridge 按成交方向估算，唔等於 ETF 申購贖回。
          </div>
        </div>
      )}
    </section>
  );
}
