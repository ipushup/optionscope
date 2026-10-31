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


def main():
    cards = []
    for cid, name, idx_y, idx_lb, (etf_y, etf_lb) in CARDS:
        cards.append({
            "id": cid,
            "name": name,
            "index_symbol": idx_y,
            "index": quote_yf(idx_y),
            "etf_symbol": etf_lb,
            "etf": quote_yf(etf_y),
        })
        print(f"{cid}: index={'ok' if cards[-1]['index'] else 'N/A'} etf={'ok' if cards[-1]['etf'] else 'N/A'}")

    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source": "yahoo",
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
