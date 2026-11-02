#!/usr/bin/env python3
"""
signal_backtest.py — 驗證「TB / UT / Heavy 同時出現（接近區間）會更準」。
Longbridge 15m 歷史棒（含夜盤）→ 逐棒計信號（無前視）→ 分數首次達 k 嗰刻入場，
睇之後 4/8/16 棒（1h/2h/4h）方向性回報，對比：(a) 全部棒基準 (b) 單一信號。
環境：SB_SYMS（逗號）、BT_DAYS=120、BT_EXTRA=30（再加幾隻 watchlist 股增加樣本）
"""
import os, sys, time
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
    return dict(n=n, reg=reg, fwd=fwd, score=score, single=single)


def agg(vals):
    v = np.array([x for x in vals if np.isfinite(x)])
    if len(v) < 5:
        return f"n={len(v):4d}  (樣本太少)"
    return f"n={len(v):4d}  mean={v.mean()*100:+.3f}%  med={np.median(v)*100:+.3f}%  win={np.mean(v>0)*100:4.1f}%"


def main():
    ctx = QuoteContext(Config.from_apikey_env())
    syms = list(TEST10)
    if EXTRA:
        from indicator_scan import parse_watchlist
        for r in parse_watchlist(Path(__file__).with_name("Watchlists.txt")):
            t = r["ticker"]
            if t and t.isalpha() and t.isupper() and len(t) <= 5 and t not in syms and not t.endswith("HK"):
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


if __name__ == "__main__":
    main()
