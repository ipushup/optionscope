#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
band_quotes.py — Triple Band 輕量報價刷新
=====================================================
每 15 分鐘行一次。讀 band.json 攞 ticker 清單，只抽即時報價，
寫 frontend/public/band_quotes.json。

**唔會重新計任何訊號。** pivot / ext / rU60 / UT Bot 全部留喺 band_scan.py
嗰邊用 closed candle 計。呢度純粹係報價 —— 所以 15 分鐘跑一次都安全，
亦唔會出現「日內見到訊號、收市又冇咗」嘅假象。

day_low 係關鍵欄位：形成中訊號嘅第一條死線就係「今日 Low 跌穿 pivot low」，
前端要即時比較。
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import yfinance as yf

IN_PATH = os.environ.get("BAND_OUT", "frontend/public/band.json")
OUT_PATH = os.environ.get("BAND_QUOTES_OUT", "frontend/public/band_quotes.json")
CHUNK = 40


def grab(tickers):
    out = {}
    for i in range(0, len(tickers), CHUNK):
        part = tickers[i:i + CHUNK]
        try:
            tk = yf.Tickers(" ".join(part))
        except Exception as e:
            print(f"  batch fail: {e}")
            continue
        for sym in part:
            try:
                fi = tk.tickers[sym].fast_info
                px = fi.get("last_price") or fi.get("regular_market_price")
                if px is None:
                    continue
                out[sym] = {
                    "price": round(float(px), 4),
                    "day_low": _f(fi.get("day_low")),
                    "day_high": _f(fi.get("day_high")),
                    "prev_close": _f(fi.get("previous_close")),
                    "open": _f(fi.get("open")),
                }
            except Exception:
                continue
        time.sleep(0.4)
    return out


def _f(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def main():
    if not os.path.exists(IN_PATH):
        sys.exit(f"搵唔到 {IN_PATH} —— 要先行 band_scan.py")
    band = json.load(open(IN_PATH))
    tickers = band.get("tickers", [])
    if not tickers:
        sys.exit("band.json 冇 tickers")

    t0 = time.time()
    quotes = grab(tickers)
    payload = {
        "quoted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "band_scanned_at": band.get("scanned_at"),   # 前端用嚟偵測 JSON 過期
        "quotes": quotes,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"{len(quotes)}/{len(tickers)} quotes ({time.time() - t0:.0f}s) → {OUT_PATH}")


if __name__ == "__main__":
    main()
