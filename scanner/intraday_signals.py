"""
Signal Board 引擎：喺 5m/15m 棒上面計 Triple Band(TB/TS)、UT Bot、Heavy。

純函數（唔掂網絡）：signals_for(df) -> list[event]
event = {i, t, kind, tier?, ...}   kind ∈ TB TS TBskip UTB UTS HB HS

Triple Band 邏輯同 Pine v10 / band_scanner.py 一致：
  買：pivotlow(3,3) 喺確認棒成立，ext=(m1-pl)/w1 >= 2.0，冷卻 5 棒（成立即更新），
      strong >= 3.5；rU60 <= -5% 先算 TB，否則 TBskip。
  賣：pivothigh 對稱，冇 tier 濾網 → TS。
Heavy：近 100 棒內 delta 累計最大(>0)=Heavy Buy 棒，最細(<0)=Heavy Sell 棒。
"""
import numpy as np
import pandas as pd

from band_scanner import (BAND_LEN, BAND_K, PIVOT_LEN, STRETCH_K, COOL_BARS,
                          RU_LEN, RU_THR, compute_bands, pivot_lows, ut_bot)

STRONG_K = 3.5
HEAVY_LEN = 100


def pivot_highs(high_v, p=PIVOT_LEN):
    return -pivot_lows(-np.asarray(high_v, dtype=float), p)


def triple_band(df):
    m1, w1 = compute_bands(df)
    pl = pivot_lows(df["Low"].values)
    ph = pivot_highs(df["High"].values)
    close = df["Close"].values
    n = len(df)
    last_b = last_s = -10 ** 6
    out = []
    for i in range(PIVOT_LEN, n):
        pi = i - PIVOT_LEN
        w, m = w1[pi], m1[pi]
        if not (np.isfinite(w) and w > 0):
            continue
        if np.isfinite(pl[pi]):
            ext = (m - pl[pi]) / w
            if ext >= STRETCH_K and pi - last_b >= COOL_BARS:
                last_b = pi
                ok = i >= RU_LEN and (close[i] - close[i - RU_LEN]) / close[i - RU_LEN] * 100 <= RU_THR
                out.append({"i": i, "kind": "TB" if ok else "TBskip",
                            "tier": "strong" if ext >= STRONG_K else "weak",
                            "ext": round(float(ext), 2)})
        if np.isfinite(ph[pi]):
            ext = (ph[pi] - m) / w
            if ext >= STRETCH_K and pi - last_s >= COOL_BARS:
                last_s = pi
                out.append({"i": i, "kind": "TS",
                            "tier": "strong" if ext >= STRONG_K else "weak",
                            "ext": round(float(ext), 2)})
    return out


def ut_events(df):
    _, pos, sell = ut_bot(df)
    out = []
    for i in range(1, len(df)):
        if pos[i] == 1 and pos[i - 1] != 1:
            out.append({"i": i, "kind": "UTB"})
        if sell[i]:
            out.append({"i": i, "kind": "UTS"})
    return out


def heavy_now(df, n=HEAVY_LEN):
    """最後一支棒視角：返回 (buy_idx, buy_val, sell_idx, sell_val)，冇就 None。"""
    d = df.iloc[-(n + 1):]
    h, l, c, v = (d[k].values.astype(float) for k in ("High", "Low", "Close", "Volume"))
    rng = h - l
    with np.errstate(divide="ignore", invalid="ignore"):
        vb = np.where(rng > 0, v * (c - l) / rng, v * 0.5)
        vs = np.where(rng > 0, v * (h - c) / rng, v * 0.5)
    delta = vb - vs
    run = np.cumsum(delta[::-1])[::-1]       # 由最新棒向後累加
    # run[k] = 由第 k 棒到最新棒嘅 delta 和
    base = len(df) - len(d)
    bi = int(np.argmax(run)); si = int(np.argmin(run))
    # ties 取最近
    bi = int(np.where(run == run[bi])[0][-1]); si = int(np.where(run == run[si])[0][-1])
    return (base + bi if run[bi] > 0 else None, float(run[bi]),
            base + si if run[si] < 0 else None, float(run[si]))


def heavy_events(df, n=HEAVY_LEN):
    """逐棒重放：每支棒嘅 Heavy 位置一變就記一次（用嚟睇歷史）。"""
    out = []
    prev = (None, None)
    for j in range(n, len(df)):
        bi, _, si, _ = heavy_now(df.iloc[: j + 1], n)
        if bi is not None and bi != prev[0]:
            out.append({"i": bi, "seen": j, "kind": "HB"})
        if si is not None and si != prev[1]:
            out.append({"i": si, "seen": j, "kind": "HS"})
        prev = (bi, si)
    return out


def signals_for(df):
    ev = triple_band(df) + ut_events(df)
    for e in ev:
        e["t"] = str(df.index[e["i"]])
    return sorted(ev, key=lambda e: e["i"])
