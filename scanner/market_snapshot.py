"""
market_snapshot.py — Home 頁 01 Market Snapshot 嘅數據

每張卡 = 一個指數／價格 + 一隻追蹤佢嘅 ETF。寫 frontend/public/market.json。
數據源：yfinance（Yahoo）。Longbridge 做主源要 Actions 有 LONGBRIDGE_* secrets，
未接；上到 secrets 之後喺 fetch_longbridge() 補返就得，其餘唔洗郁。

任何一個 symbol 攞唔到 → 該欄寫 null（前端顯示 N/A），唔估價、唔沿用舊值冒充新。
"""
import json
import os
from datetime import datetime, timezone

OUT_PATH = os.environ.get("MARKET_OUT", "frontend/public/market.json")

# id, 顯示名, 指數 Yahoo symbol, 指數 Longbridge 碼, ETF 碼（Yahoo, Longbridge）
CARDS = [
    ("spx", "S&P 500",         "^GSPC",   ".SPX.US", ("SPY",  "SPY.US")),
    ("ndx", "Nasdaq Composite", "^IXIC",  ".IXIC.US", ("TQQQ", "TQQQ.US")),
    ("dji", "Dow Jones",       "^DJI",    ".DJI.US", ("DIA",  "DIA.US")),
    ("vix", "Volatility Index", "^VIX",   ".VIX.US", ("UVIX", "UVIX.US")),
    ("hsi", "Hang Seng Index", "^HSI",    "HSI.HK",  ("2800.HK", "2800.HK")),
    ("btc", "Bitcoin",         "BTC-USD", None,      ("IBIT", "IBIT.US")),
    ("brent", "Brent Crude",   "BZ=F",    None,      ("BNO",  "BNO.US")),
    ("us10y", "US 10Y Yield",  "^TNX",    None,      ("IEF",  "IEF.US")),
]


def quote_yf(symbol):
    """回 {last, prev_close, change, pct, spark[], asof}；失敗回 None。"""
    import yfinance as yf
    try:
        t = yf.Ticker(symbol)
        intr = t.history(period="1d", interval="5m", prepost=True)
        daily = t.history(period="5d", interval="1d")
        if intr.empty or len(daily) < 2:
            return None
        last = float(intr["Close"].iloc[-1])
        # prev_close：用最近一根「唔係今日 session」嘅日棒收市價
        last_day = intr.index[-1].date()
        prev_rows = daily[[d.date() < last_day for d in daily.index]]
        if prev_rows.empty:
            prev_rows = daily.iloc[:-1]
        prev = float(prev_rows["Close"].iloc[-1])
        spark = [round(float(v), 4) for v in intr["Close"].tolist()[-80:]]
        return {
            "last": last,
            "prev_close": prev,
            "change": last - prev,
            "pct": (last / prev - 1.0) * 100.0,
            "spark": spark,
            "asof": intr.index[-1].astimezone(timezone.utc).isoformat(),
        }
    except Exception as e:  # noqa: BLE001 — 單個 symbol 失敗唔應該拖冧成個 job
        print(f"⚠ {symbol}: {e}")
        return None


def _ts(x):
    """SDK 嘅 timestamp 可能係 datetime（naive UTC）或 epoch 秒 → aware UTC datetime。"""
    if x is None:
        return None
    if isinstance(x, datetime):
        return x.replace(tzinfo=timezone.utc) if x.tzinfo is None else x.astimezone(timezone.utc)
    if isinstance(x, (int, float)):
        return datetime.fromtimestamp(x, timezone.utc)
    return None


def pick_latest(q):
    """喺 常規 / 盤前 / 盤後 / 夜盤 之中揀 timestamp 最新嗰節，回 (last, ts, session)。"""
    cands = []
    for sess, obj in (("regular", q), ("pre", getattr(q, "pre_market_quote", None)),
                      ("post", getattr(q, "post_market_quote", None)),
                      ("overnight", getattr(q, "overnight_quote", None))):
        if obj is None:
            continue
        last, ts = getattr(obj, "last_done", None), _ts(getattr(obj, "timestamp", None))
        if last is None or ts is None or float(last) == 0:
            continue
        cands.append((ts, float(last), sess))
    if not cands:
        return None
    ts, last, sess = max(cands)
    return last, ts, sess


def fetch_longbridge(symbols):
    """Longbridge 即時報價（要 LONGBRIDGE_APP_KEY / _APP_SECRET / _ACCESS_TOKEN）。
    回 {symbol: {last, prev_close, change, pct, asof, session}}。冇 credentials 或失敗 → {}。"""
    if not (os.getenv("LONGBRIDGE_APP_KEY") and os.getenv("LONGBRIDGE_APP_SECRET")
            and os.getenv("LONGBRIDGE_ACCESS_TOKEN")):
        print("ℹ 冇 Longbridge credentials，全部用 Yahoo")
        return {}
    try:
        from longbridge.openapi import Config, QuoteContext
        ctx = QuoteContext(Config.from_apikey_env())
        out = {}
        for q in ctx.quote([s for s in symbols if s]):
            got = pick_latest(q)
            prev = float(q.prev_close) if getattr(q, "prev_close", None) else None
            if not got or not prev:
                continue
            last, ts, sess = got
            out[q.symbol] = {"last": last, "prev_close": prev, "change": last - prev,
                             "pct": (last / prev - 1.0) * 100.0,
                             "asof": ts.isoformat(), "session": sess, "source": "longbridge"}
        print(f"✓ Longbridge: {len(out)}/{len(symbols)} symbols")
        return out
    except Exception as e:  # noqa: BLE001
        print(f"⚠ Longbridge 失敗，用 Yahoo：{e}")
        return {}


def merge(lb, yf_q):
    """Longbridge 報價優先；sparkline 用 Yahoo 嘅（Longbridge 呢度唔 call intraday，慳 quota）。"""
    if lb is None:
        return dict(yf_q, source="yahoo", session=None) if yf_q else None
    return dict(lb, spark=(yf_q or {}).get("spark", []))


def main():
    lb = fetch_longbridge([c[3] for c in CARDS] + [c[4][1] for c in CARDS])
    cards = []
    for cid, name, idx_y, idx_lb, (etf_y, etf_lb) in CARDS:
        cards.append({
            "id": cid,
            "name": name,
            "index_symbol": idx_y,
            "index": merge(lb.get(idx_lb) if idx_lb else None, quote_yf(idx_y)),
            "etf_symbol": etf_lb,
            "etf": merge(lb.get(etf_lb), quote_yf(etf_y)),
        })
        print(f"{cid}: index={'ok' if cards[-1]['index'] else 'N/A'} etf={'ok' if cards[-1]['etf'] else 'N/A'}")

    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source": "longbridge+yahoo" if lb else "yahoo",
        "cards": cards,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=1)
    ok = sum(1 for c in cards if c["index"] and c["etf"])
    print(f"✓ {OUT_PATH} — {ok}/{len(cards)} cards complete")
    # 全部攞唔到先當失敗；部分失敗照出（前端會標 N/A）
    if not any(c["index"] or c["etf"] for c in cards):
        raise SystemExit("no quotes fetched at all")


if __name__ == "__main__":
    main()
