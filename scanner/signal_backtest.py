#!/usr/bin/env python3
"""
signal_backtest.py — 驗證「TB / UT / Heavy 同時出現（接近區間）會更準」。
Longbridge 15m 歷史棒（含夜盤）→ 逐棒計信號（無前視）→ 分數首次達 k 嗰刻入場，
睇之後 4/8/16 棒（1h/2h/4h）方向性回報，對比：(a) 全部棒基準 (b) 單一信號。
環境：SB_SYMS（逗號）、BT_DAYS=120、BT_EXTRA=30（再加幾隻 watchlist 股增加樣本）
"""
import bisect, os, sys, time
from datetime import date, timedelta
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("LONGBRIDGE_ENABLE_OVERNIGHT", "true")
from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
import intraday_signals as S

DAYS = int(os.getenv("BT_DAYS", "120"))
EXTRA = int(os.getenv("BT_EXTRA", "30"))
NEARS = [3, 6, 12]
HZ = [4, 8, 16]
TEST10 = "INTC,BABA,FUTU,SKHY,NVDA,AMD,MRNA,SPCX,CRWV,NOK".split(",")
# 槓桿 / 反向 / 收息 / 商品 ETF —— 波動結構唔同，排除
EXCL = set("TQQQ SQQQ UVIX SVIX UGL AGQ GLD SLV NVDY NVDL ARMG SMCX SMCY AMY INTW SOXQ SOXL SOXS TSLL TSLQ MSTY CONY YMAG QQQ SPY IBIT FBTC ETHA BITO".split())
COST = 0.0006                       # 來回佣金 0.03%×2（Pine 設定）；slippage 2 tick 未計
GROUP = {"TB": "TB", "UTB": "UT", "HB": "HEAVY", "TS": "TB", "UTS": "UT", "HS": "HEAVY"}
SIDE = {"TB": 1, "UTB": 1, "HB": 1, "TS": -1, "UTS": -1, "HS": -1}


def fetch(ctx, sym):
    end = date.today(); start = end - timedelta(days=DAYS)
    rows, cur = [], start
    while cur < end:
        nxt = min(cur + timedelta(days=20), end)
        for k in range(3):
            try:
                rows += ctx.history_candlesticks_by_date(f"{sym}.US", Period.Min_15, AdjustType.NoAdjust, cur, nxt, TradeSessions.All)
                break
            except Exception as e:
                time.sleep(1.5 * (k + 1)); err = e
        else:
            print(f"::warning::{sym} {cur}: {err}")
        cur = nxt + timedelta(days=1); time.sleep(0.15)
    if not rows:
        return None
    df = pd.DataFrame({"Open": [float(b.open) for b in rows], "High": [float(b.high) for b in rows],
                       "Low": [float(b.low) for b in rows], "Close": [float(b.close) for b in rows],
                       "Volume": [float(b.volume) for b in rows]},
                      index=pd.to_datetime([b.timestamp for b in rows]))
    return df[~df.index.duplicated()].sort_index()


def events(df):
    ev = [e for e in S.triple_band(df) if e["kind"] in ("TB", "TS")] + S.ut_events(df)
    out = [(e["i"], e["kind"]) for e in ev]
    out += [(e["seen"], e["kind"]) for e in S.heavy_events(df)]    # Heavy 喺 seen 棒先知
    return out


def run_symbol(df):
    n = len(df); close = df["Close"].values
    et = df.index.tz_localize("UTC").tz_convert("America/New_York")
    reg = np.array([(570 <= t.hour * 60 + t.minute < 960) for t in et])
    ev = events(df)
    by_bar = {}
    for i, k in ev: by_bar.setdefault(i, []).append(k)
    last = {(g, s): -10**9 for g in ("TB", "UT", "HEAVY") for s in (1, -1)}
    ts = df.index.values.astype("datetime64[m]").astype(np.int64)
    score = {nr: {1: np.zeros(n, int), -1: np.zeros(n, int)} for nr in NEARS}
    single = []                                                    # (i, side, kind)
    for i in range(n):
        for k in by_bar.get(i, []):
            last[(GROUP[k], SIDE[k])] = i
            single.append((i, SIDE[k], k))
        for nr in NEARS:
            for s in (1, -1):
                score[nr][s][i] = sum(1 for g in ("TB", "UT", "HEAVY") if i - last[(g, s)] <= nr)
    fwd = {}
    for h in HZ:
        r = np.full(n, np.nan)
        ok = np.zeros(n, bool)
        for i in range(n - h):
            if ts[i + h] - ts[i] <= h * 15 * 1.5:
                r[i] = close[i + h] / close[i] - 1; ok[i] = True
        fwd[h] = r
    tb = sorted(i for i, k in ev if k == "TB")
    return dict(n=n, reg=reg, fwd=fwd, score=score, single=single, tb=tb,
                open=df["Open"].values, close=close,
                utb=sorted(i for i, k in ev if k == "UTB"), uts=sorted(i for i, k in ev if k == "UTS"),
                hb=sorted(i for i, k in ev if k == "HB"), ut_pos=S.ut_bot(df)[1], reg_=reg)


def agg(vals):
    v = np.array([x for x in vals if np.isfinite(x)])
    if len(v) < 5:
        return f"n={len(v):4d}  (樣本太少)"
    return f"n={len(v):4d}  mean={v.mean()*100:+.3f}%  med={np.median(v)*100:+.3f}%  win={np.mean(v>0)*100:4.1f}%"


def trades_for(r):
    """Pine v10 production：Long/Flat，flat 先入，TB(taken) 次棒開市成交；UT 賣出場（次棒開市）。"""
    n, op = r["n"], r["open"]
    uts = set(r["uts"]); tbs = set(r["tb"])
    import bisect
    out, i, pos = [], 0, None
    for i in range(n - 1):
        if pos is None:
            if i in tbs:
                pos = {"i": i, "entry": op[i + 1], "ei": i + 1}
        else:
            if i in uts and i >= pos["ei"]:
                px = op[i + 1]
                out.append({**pos, "xi": i + 1, "ret": px / pos["entry"] - 1 - COST})
                pos = None
    return out


def conf_flags(r, t, k):
    i = t["i"]
    def within(lst):
        j = bisect.bisect_right(lst, i) - 1
        return j >= 0 and i - lst[j] <= k
    return {"UT買": within(r["utb"]), "UT持多": r["ut_pos"][i] == 1,
            "Heavy買": within(r["hb"])}


def stat(v):
    v = np.array(v)
    if len(v) < 5: return f"n={len(v):3d} (樣本太少)"
    w, l = v[v > 0], v[v <= 0]
    pf = w.sum() / abs(l.sum()) if len(l) and l.sum() != 0 else float("inf")
    return f"n={len(v):3d}  平均={v.mean()*100:+.2f}%  中位={np.median(v)*100:+.2f}%  勝率={np.mean(v>0)*100:4.1f}%  PF={pf:.2f}"


def trade_report(res):
    import bisect
    print("\n\n################ 真實策略交易（藍箭咀 = TB taken 且 flat 先入，UT 賣出，次棒開市成交，扣 0.06% 來回成本）################")
    allt = []
    for s, r in res.items():
        for t in trades_for(r):
            t["sym"] = s; t["bars"] = t["xi"] - t["ei"]; t["reg"] = bool(r["reg"][t["i"]])
            for k in (6, 12):
                f = conf_flags(r, t, k)
                for name, v in f.items(): t[f"{name}{k}"] = v
            allt.append(t)
    print(f"全部交易  {stat([t['ret'] for t in allt])}   平均持有 {np.mean([t['bars'] for t in allt]):.0f} 棒")
    print(f"  正式盤入場  {stat([t['ret'] for t in allt if t['reg']])}")
    print(f"  盤前後夜盤入場  {stat([t['ret'] for t in allt if not t['reg']])}")
    for k in (6, 12):
        print(f"\n-- 入場前 {k} 棒內 / 當刻 重疊（只計真實交易）")
        for name in ("UT持多", "UT買", "Heavy買"):
            key = f"{name}{k}"
            a = [t["ret"] for t in allt if t[key]]; b = [t["ret"] for t in allt if not t[key]]
            print(f"  {name:6s} 有:  {stat(a)}")
            print(f"  {name:6s} 冇:  {stat(b)}")
        both = [t["ret"] for t in allt if t[f"UT持多{k}"] and t[f"Heavy買{k}"]]
        print(f"  UT持多 + Heavy買 同時: {stat(both)}")
    print("\n-- 每隻股（交易數 / 平均）")
    by = {}
    for t in allt: by.setdefault(t["sym"], []).append(t["ret"])
    print("  " + " | ".join(f"{k} {len(v)}筆 {np.mean(v)*100:+.2f}%" for k, v in sorted(by.items())))


def main():
    ctx = QuoteContext(Config.from_apikey_env())
    syms = list(TEST10)
    if EXTRA:
        from indicator_scan import parse_watchlist
        for r in parse_watchlist(Path(__file__).with_name("Watchlists.txt")):
            t = r["ticker"]
            if t and t.isalpha() and t.isupper() and len(t) <= 5 and t not in syms and t not in EXCL and not t.endswith("HK"):
                syms.append(t)
            if len(syms) >= len(TEST10) + EXTRA: break
    res = {}
    for s in syms:
        df = fetch(ctx, s)
        if df is None or len(df) < 400:
            print(f"skip {s}"); continue
        res[s] = run_symbol(df)
        print(f"{s}: {res[s]['n']} bars", flush=True)
    print(f"\n=== {len(res)} symbols, {DAYS} days, 15m, 方向性回報（多=+ret，空=−ret）===")
    for h in HZ:
        print(f"\n######## 持有 {h} 棒（{h*15}分鐘）########")
        for ses, mask in (("全部時段", lambda r: np.ones_like(r["reg"])), ("只正式盤", lambda r: r["reg"]), ("只盤前盤後夜盤", lambda r: ~r["reg"])):
            print(f"\n-- 入場時段：{ses}")
            base = []
            for r in res.values():
                m = mask(r); base += list(r["fwd"][h][m])
            bm = np.nanmean(base) if len(base) else 0
            print(f"基準（所有棒，多頭視角）  {agg(base)}")
            for side, name in ((1, "偏多"), (-1, "偏空")):
                for kind in ("TB", "UT", "HEAVY"):
                    pass
                sing = {}
                for r in res.values():
                    for (i, s, k) in r["single"]:
                        if s == side and mask(r)[i]:
                            sing.setdefault(k, []).append(side * r["fwd"][h][i])
                for k, v in sorted(sing.items()):
                    print(f"{name} 單一 {k:4s}              {agg(v)}")
                for nr in NEARS:
                    for kk in (2, 3):
                        v = []
                        for r in res.values():
                            sc = r["score"][nr][side]; m = mask(r)
                            for i in range(1, r["n"]):
                                if sc[i] >= kk and sc[i - 1] < kk and m[i]:
                                    v.append(side * r["fwd"][h][i])
                        print(f"{name} 分數首次≥{kk} near={nr:2d}棒    {agg(v)}")
            print(f"（基準對照：多頭視角 mean={bm*100:+.3f}% ；偏空要睇 −基準 = {-bm*100:+.3f}%）")
    trade_report(res)


if __name__ == "__main__":
    main()
