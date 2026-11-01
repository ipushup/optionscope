"""
index_daily.py — Home 01 Market Snapshot「Daily」模式嘅數據

8 個指數／價格（Yahoo 日線）→ 蠟燭 + EMA10/20/50 + SuperTrend(10,3) + UT Bot(KV=2, ATR=1)，
演算法同 After-market-brief/market_charts.py（daily brief）一模一樣，所以信號同 brief 一致。
寫 frontend/public/daily.json；每個 symbol 失敗就該欄 null，唔估值。
"""
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

OUT_PATH = os.environ.get("DAILY_OUT", "frontend/public/daily.json")
BARS = 70
IDS = [("spx", "^GSPC"), ("ndx", "^IXIC"), ("dji", "^DJI"), ("vix", "^VIX"),
       ("hsi", "^HSI"), ("btc", "BTC-USD"), ("brent", "BZ=F"), ("us10y", "^TNX")]


def _ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def supertrend(df, period=10, mult=3.0):
    h, l, c = df["High"], df["Low"], df["Close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1.0 / period, adjust=False).mean()
    hl2 = (h + l) / 2.0
    ub, lb = hl2 + mult * atr, hl2 - mult * atr
    fub, flb = ub.copy(), lb.copy()
    for i in range(1, len(df)):
        fub.iloc[i] = ub.iloc[i] if (ub.iloc[i] < fub.iloc[i - 1] or c.iloc[i - 1] > fub.iloc[i - 1]) else fub.iloc[i - 1]
        flb.iloc[i] = lb.iloc[i] if (lb.iloc[i] > flb.iloc[i - 1] or c.iloc[i - 1] < flb.iloc[i - 1]) else flb.iloc[i - 1]
    st = pd.Series(np.nan, index=df.index, dtype=float)
    d = pd.Series(1, index=df.index, dtype=int)
    for i in range(1, len(df)):
        if c.iloc[i] > fub.iloc[i - 1]:
            d.iloc[i] = 1
        elif c.iloc[i] < flb.iloc[i - 1]:
            d.iloc[i] = -1
        else:
            d.iloc[i] = d.iloc[i - 1]
        st.iloc[i] = flb.iloc[i] if d.iloc[i] == 1 else fub.iloc[i]
    return st, d


def utbot(df, key=2.0, atr_period=1):
    c, h, l = df["Close"], df["High"], df["Low"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1.0 / atr_period, adjust=False).mean()
    n_loss = key * atr
    stop = pd.Series(np.nan, index=df.index, dtype=float)
    stop.iloc[0] = c.iloc[0] - n_loss.iloc[0]
    for i in range(1, len(df)):
        cp, pp, ps = c.iloc[i], c.iloc[i - 1], stop.iloc[i - 1]
        if cp > ps and pp > ps:
            stop.iloc[i] = max(ps, cp - n_loss.iloc[i])
        elif cp < ps and pp < ps:
            stop.iloc[i] = min(ps, cp + n_loss.iloc[i])
        elif cp > ps:
            stop.iloc[i] = cp - n_loss.iloc[i]
        else:
            stop.iloc[i] = cp + n_loss.iloc[i]
    above = (c > stop).fillna(False).astype(bool)
    prev = above.shift(1).fillna(False).astype(bool)
    buy, sell = above & (~prev), (~above) & prev
    buy.iloc[0] = False
    sell.iloc[0] = False
    return stop, buy.astype(bool), sell.astype(bool)


def build(df, bars=BARS):
    """日線 DataFrame（Open/High/Low/Close）→ 前端用 dict；數據唔夠回 None。"""
    df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
    if len(df) < 60:
        return None
    e10, e20, e50 = (_ema(df["Close"], n) for n in (10, 20, 50))
    st, d = supertrend(df)
    _, buy, sell = utbot(df)
    v = df.iloc[-bars:]
    n = len(v)
    r = lambda s: [None if pd.isna(x) else round(float(x), 4) for x in s.iloc[-n:]]
    return {
        "dates": [i.strftime("%Y-%m-%d") for i in v.index],
        "o": r(v["Open"]), "h": r(v["High"]), "l": r(v["Low"]), "c": r(v["Close"]),
        "ema10": r(e10), "ema20": r(e20), "ema50": r(e50),
        "st": r(st), "st_dir": [int(x) for x in d.iloc[-n:]],
        "buy": [bool(x) for x in buy.iloc[-n:]], "sell": [bool(x) for x in sell.iloc[-n:]],
    }


def fetch(sym):
    import yfinance as yf
    try:
        df = yf.Ticker(sym).history(period="1y", interval="1d")
        if df.empty:
            return None
        df.index = df.index.tz_localize(None) if df.index.tz is not None else df.index
        return build(df)
    except Exception as e:  # noqa: BLE001 — 單個失敗唔拖冧成個 job
        print(f"⚠ {sym}: {e}")
        return None


def main():
    out = {}
    for cid, sym in IDS:
        out[cid] = fetch(sym)
        print(f"{cid} ({sym}): {'ok' if out[cid] else 'N/A'}")
    payload = {"updated_at": datetime.now(timezone.utc).isoformat(), "source": "yahoo", "cards": out}
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    if not any(out.values()):
        raise SystemExit("no daily data fetched at all")
    print(f"✓ {OUT_PATH}")


if __name__ == "__main__":
    main()
