#!/usr/bin/env python3
"""
日線回測：Triple Band(TB/TS)、UT、Heavy Buy/Sell 分開驗證（Heavy 係新信號，從未回測）。
Longbridge 日線（約 4 年）→ 逐棒重放（無前視）→ 信號喺 seen 棒收市確認，次日開市入場，
睇 1/3/5/10/20 日回報（Heavy Sell / TS 用方向性 = −ret）。排除 ETF（按名稱）。
環境：BT_YEARS=4  BT_MAX=0（測試用，限隻數）
"""
import bisect, os, re, sys, time
from datetime import date, timedelta
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
from indicator_scan import parse_watchlist
import intraday_signals as S

YEARS = int(os.getenv("BT_YEARS", "4")); MAXN = int(os.getenv("BT_MAX", "0") or 0)
WEEK = os.getenv("BT_PERIOD", "day") == "week"
ONLY_HEAVY = os.getenv("BT_ONLY_HEAVY", "") == "1"
HZ = [1, 2, 4, 8, 13] if WEEK else [1, 3, 5, 10, 20]
UNIT = "週" if WEEK else "日"
MINBARS = 150 if WEEK else 300
COST = 0.0006
ETF_RE = re.compile(r"ETF|Daily|2X|3X|1X|Leverage|Bull|Bear|Yield|Trust|Shares|Fund|Option Income|Income|Index|Ultra|Short", re.I)


def fetch(ctx, sym):
    end = date.today(); cur = end - timedelta(days=365 * YEARS); rows = []
    while cur < end:
        nxt = min(cur + timedelta(days=730), end)
        for k in range(3):
            try:
                rows += ctx.history_candlesticks_by_date(f"{sym}.US", (Period.Week if WEEK else Period.Day), AdjustType.ForwardAdjust, cur, nxt, TradeSessions.Intraday); break
            except Exception as e:
                time.sleep(1.5 * (k + 1)); err = e
        else:
            print(f"::warning::{sym} {cur}: {err}")
        cur = nxt + timedelta(days=1)
    if not rows: return None
    df = pd.DataFrame({"Open": [float(b.open) for b in rows], "High": [float(b.high) for b in rows],
                       "Low": [float(b.low) for b in rows], "Close": [float(b.close) for b in rows],
                       "Volume": [float(b.volume) for b in rows]}, index=pd.to_datetime([b.timestamp for b in rows]))
    return df[~df.index.duplicated()].sort_index()


def is_etf(ctx, sym):
    try:
        info = ctx.static_info([f"{sym}.US"])[0]
        nm = f"{info.name_en} {info.name_cn}"
        return bool(ETF_RE.search(nm)), nm
    except Exception:
        return False, "?"


def prep(df, bench=None):
    n = len(df); c = df["Close"].values; o = df["Open"].values
    fwd = {}
    for h in HZ:
        r = np.full(n, np.nan)
        for i in range(n - h - 1):
            r[i] = c[i + h] / o[i + 1] - 1 - 0.0   # 次日開市入，第 i+h 日收市出
        fwd[h] = r
    bfwd = None
    if bench is not None:
        b = bench.reindex(df.index, method="ffill")
        bo, bc = b["Open"].values, b["Close"].values
        bfwd = {}
        for h in HZ:
            r = np.full(n, np.nan)
            for i in range(n - h - 1): r[i] = bc[i + h] / bo[i + 1] - 1
            bfwd[h] = r
    ru = np.full(n, np.nan)
    for i in range(60, n): ru[i] = (c[i] / c[i - 60] - 1) * 100
    tb = [e for e in S.triple_band(df)]
    ut = S.ut_events(df)
    hv = S.heavy_events(df)
    # Heavy 強度
    vol = df["Volume"].values; cs = np.cumsum(vol)
    hevs = []
    for e in hv:
        j = e["seen"]; lo = max(0, j - 100)
        tot = cs[j] - (cs[lo - 1] if lo else 0)
        d = df.iloc[e["i"]: j + 1]
        rng = (d["High"] - d["Low"]).values; cc = d["Close"].values; ll = d["Low"].values; hh = d["High"].values; vv = d["Volume"].values
        with np.errstate(divide="ignore", invalid="ignore"):
            dl = np.where(rng > 0, vv * ((cc - ll) - (hh - cc)) / rng, 0.0)
        hevs.append({**e, "lag": j - e["i"], "mag": abs(dl.sum()) / tot if tot else np.nan})
    return dict(n=n, o=o, c=c, fwd=fwd, bfwd=bfwd, ru=ru, tb=tb, ut=ut, hv=hevs, idx=df.index)


def stat(v):
    v = np.array([x for x in v if np.isfinite(x)])
    if len(v) < 8: return f"n={len(v):5d} (樣本太少)"
    t = v.mean() / (v.std(ddof=1) / np.sqrt(len(v))) if v.std() > 0 else 0
    return f"n={len(v):5d}  mean={v.mean()*100:+.2f}%  med={np.median(v)*100:+.2f}%  win={np.mean(v>0)*100:4.1f}%  t={t:+.1f}"


def trades(P):
    """Pine v10：flat 先入，TB(taken) 次日開市；UT 賣出場（次日開市）。"""
    tbs = {e["i"] for e in P["tb"] if e["kind"] == "TB"}; uts = {e["i"] for e in P["ut"] if e["kind"] == "UTS"}
    out, pos = [], None
    for i in range(P["n"] - 1):
        if pos is None:
            if i in tbs: pos = (i, P["o"][i + 1], i + 1)
        elif i in uts and i >= pos[2]:
            out.append({"i": pos[0], "ret": P["o"][i + 1] / pos[1] - 1 - COST, "bars": i + 1 - pos[2]}); pos = None
    return out


def main():
    ctx = QuoteContext(Config.from_apikey_env())
    syms = []
    for r in parse_watchlist(Path(__file__).with_name("Watchlists.txt")):
        t = r["ticker"]
        if t and t.isalpha() and t.isupper() and len(t) <= 5 and t not in syms and not t.endswith("HK"): syms.append(t)
    if MAXN: syms = syms[:MAXN]
    keep, dropped = [], []
    names = {}
    for i in range(0, len(syms), 100):
        try:
            for inf in ctx.static_info([f"{x}.US" for x in syms[i:i + 100]]):
                names[inf.symbol.rsplit(".", 1)[0]] = f"{inf.name_en} {inf.name_cn}"
        except Exception as e:
            print(f"::warning::static_info {e}")
    for s in syms:
        nm = names.get(s, "")
        (dropped if ETF_RE.search(nm) else keep).append(s if not ETF_RE.search(nm) else f"{s}({nm[:22]})")
    print(f"股票 {len(keep)} 隻；排除 ETF {len(dropped)}：{', '.join(dropped)}", flush=True)
    res = {}
    from concurrent.futures import ThreadPoolExecutor
    qdf = fetch(ctx, "QQQ")
    def job(s):
        df = fetch(ctx, s)
        if df is None or len(df) < MINBARS: return s, (None if df is None else len(df))
        return s, prep(df, qdf)
    with ThreadPoolExecutor(6) as ex:
        for k, (s, P) in enumerate(ex.map(job, keep)):
            if P is None or isinstance(P, int): print("skip", s, "bars=", P)
            else: res[s] = P
            if k % 20 == 0: print(f"  進度 {k}/{len(keep)}", flush=True)
    print(f"\n=== {len(res)} 隻股，約 {YEARS} 年{'週線' if WEEK else '日線'} ===")
    base = {h: [x for P in res.values() for x in P["fwd"][h]] for h in HZ}

    def block(title, picks, sign=1):
        print(f"\n--- {title}")
        for h in HZ:
            v = [sign * P["fwd"][h][i] for P, idxs in picks for i in idxs]
            b = sign * np.nanmean(base[h])
            ex = [sign * (P["fwd"][h][i] - P["bfwd"][h][i]) for P, idxs in picks for i in idxs if P["bfwd"] is not None]
            exs = f"   對QQQ超額 mean={np.nanmean(ex)*100:+.2f}% win={np.mean(np.array(ex)>0)*100:4.1f}%" if len(ex) > 8 else ""
            print(f"  持有{h:2d}{UNIT}  {stat(v)}   基準{b*100:+.2f}%{exs}")

    print("\n基準（所有日，做多）：" + " | ".join(f"{h}日 {np.nanmean(base[h])*100:+.2f}%" for h in HZ))
    # ── Heavy ──
    for kind, sign, name in (("HB", 1, "Heavy Buy（做多）"), ("HS", -1, "Heavy Sell（做空，方向性）")):
        print(f"\n################ {name} ################")
        allp = [(P, [e["seen"] for e in P["hv"] if e["kind"] == kind]) for P in res.values()]
        block(f"{name} 全部（出現日收市後，次日開市入場）", allp, sign)
        for lab, lo, hi in (("Heavy 棒＝當日（lag 0）", 0, 0), ("lag 1–3 日", 1, 3), ("lag >3 日", 4, 999)):
            block(f"{name} {lab}", [(P, [e["seen"] for e in P["hv"] if e["kind"] == kind and lo <= e["lag"] <= hi]) for P in res.values()], sign)
        mags = np.array([e["mag"] for P in res.values() for e in P["hv"] if e["kind"] == kind and np.isfinite(e["mag"])])
        if len(mags) > 30:
            q1, q2 = np.quantile(mags, [1 / 3, 2 / 3])
            for lab, f in (("強度 最強1/3", lambda m: m >= q2), ("強度 最弱1/3", lambda m: m < q1)):
                block(f"{name} {lab}（|Δ|/100日總量 {'≥' if '強' in lab else '<'}{(q2 if '強' in lab else q1):.3f}）",
                      [(P, [e["seen"] for e in P["hv"] if e["kind"] == kind and np.isfinite(e["mag"]) and f(e["mag"])]) for P in res.values()], sign)
        for lab, f in (("超賣 rU60≤−5%", lambda x: x <= -5), ("非超賣 rU60>−5%", lambda x: x > -5)):
            block(f"{name} {lab}", [(P, [e["seen"] for e in P["hv"] if e["kind"] == kind and np.isfinite(P["ru"][e["seen"]]) and f(P["ru"][e["seen"]])]) for P in res.values()], sign)
        # 前後半段穩定性
        for lab, sel in (("前半段時間", lambda P, i: i < P["n"] // 2), ("後半段時間", lambda P, i: i >= P["n"] // 2)):
            block(f"{name} {lab}", [(P, [e["seen"] for e in P["hv"] if e["kind"] == kind and sel(P, e["seen"])]) for P in res.values()], sign)
    if ONLY_HEAVY: return
    # ── TB ──
    print("\n################ Triple Band 日線 ################")
    for kind, sign, name in (("TB", 1, "TB taken（做多）"), ("TBskip", 1, "TBskip（被 rU60 濾走，做多）"), ("TS", -1, "TS（做空，方向性）")):
        block(name, [(P, [e["i"] for e in P["tb"] if e["kind"] == kind]) for P in res.values()], sign)
    allt = [t for P in res.values() for t in trades(P)]
    print(f"\n真實策略（TB taken flat 先入 + UT 賣出，扣 0.06%）: {stat([t['ret'] for t in allt])}  平均持有 {np.mean([t['bars'] for t in allt]):.0f} 日" if allt else "")
    # ── TB × Heavy Buy 重疊 ──
    print("\n################ TB taken 同 Heavy Buy 重疊（TB 出現前 N 日內有 HB）################")
    for N in (5, 10):
        for lab, want in (("有 HB", True), ("冇 HB", False)):
            pick = []
            for P in res.values():
                hbs = sorted(e["seen"] for e in P["hv"] if e["kind"] == "HB")
                idx = []
                for e in P["tb"]:
                    if e["kind"] != "TB": continue
                    j = bisect.bisect_right(hbs, e["i"]) - 1
                    has = j >= 0 and e["i"] - hbs[j] <= N
                    if has == want: idx.append(e["i"])
                pick.append((P, idx))
            block(f"TB taken，前{N}日內 {lab}", pick)
    # ── 單隻股 Heavy Buy ──
    print("\n################ 每隻股 HB 10日平均（≥15 次）################")
    rows = []
    for s, P in res.items():
        v = [P["fwd"][10][e["seen"]] for e in P["hv"] if e["kind"] == "HB" and np.isfinite(P["fwd"][10][e["seen"]])]
        if len(v) >= 15: rows.append((np.mean(v), len(v), s))
    print("  " + " | ".join(f"{s} {n}次 {m*100:+.1f}%" for m, n, s in sorted(rows)))


if __name__ == "__main__":
    main()
