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

import pandas as pd
import yfinance as yf

IN_PATH = os.environ.get("BAND_OUT", "frontend/public/band.json")
# 只抽開緊市嗰邊。收市時段照掃 170 隻純粹浪費 Yahoo 額度，
# 而且容易撞到 throttle 累埋開緊市嗰邊。
MARKETS = {m.strip().upper() for m in
           os.environ.get("QUOTE_MARKETS", "US,HK").split(",") if m.strip()}
OUT_PATH = os.environ.get("BAND_QUOTES_OUT", "frontend/public/band_quotes.json")
LOG_PATH = os.environ.get("BAND_FORMING_LOG", "frontend/public/band_forming_log.json")
LOG_DAYS = 40
CHUNK = 40


def grab(tickers):
    """
    用 yf.download 批量攞當日 1 分鐘線 —— 同 band_scan.py 同一條 API，
    已經證實喺 Actions 行得通。

    唔用 Tickers().fast_info：FastInfo 唔係普通 dict，`.get()` 唔一定
    work，實測成個 quotes 出空 {} 而且唔會拋錯 —— 靜靜咁失敗最難捉。

    day_low 好緊要：形成中訊號第一條死線就係「今日 Low 跌穿 pivot low」。
    分鐘線嘅 Low 累計就係當日 Low。
    """
    out = {}
    for i in range(0, len(tickers), CHUNK):
        part = tickers[i:i + CHUNK]
        try:
            df = yf.download(" ".join(part), period="1d", interval="1m",
                             progress=False, auto_adjust=False,
                             threads=False, group_by="ticker")
        except Exception as e:
            print(f"  batch fail {part[0]}…: {e}")
            continue
        if df is None or df.empty:
            continue
        for sym in part:
            try:
                d = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                d = d.dropna(subset=["Close"])
                if d.empty:
                    continue
                out[sym] = {
                    "price": round(float(d["Close"].iloc[-1]), 4),
                    "day_low": round(float(d["Low"].min()), 4),
                    "day_high": round(float(d["High"].max()), 4),
                    "open": round(float(d["Open"].iloc[0]), 4),
                    "bars": int(len(d)),
                }
            except Exception:
                continue
        time.sleep(0.5)

    if not out:
        # 收市時段 1m 會空。退返落日線最後一支棒，總好過畀個空 {} 出去
        # 令前端成版「—」而完全冇提示。
        print("  1m 全空，fallback 落日線")
        for i in range(0, len(tickers), CHUNK):
            part = tickers[i:i + CHUNK]
            try:
                df = yf.download(" ".join(part), period="5d", interval="1d",
                                 progress=False, auto_adjust=False,
                                 threads=False, group_by="ticker")
            except Exception:
                continue
            if df is None or df.empty:
                continue
            for sym in part:
                try:
                    d = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                    d = d.dropna(subset=["Close"])
                    if d.empty:
                        continue
                    out[sym] = {
                        "price": round(float(d["Close"].iloc[-1]), 4),
                        "day_low": round(float(d["Low"].iloc[-1]), 4),
                        "day_high": round(float(d["High"].iloc[-1]), 4),
                        "open": round(float(d["Open"].iloc[-1]), 4),
                        "bars": 0,          # 0 = 日線 fallback，唔係即時
                    }
                except Exception:
                    continue
            time.sleep(0.5)
    return out


def log_forming(band, quotes):
    """
    每次報價 run 記低「形成中」嘅即時狀態，同一日同一隻覆寫（保留最新）。
    第二日 band_scan.py 會回填 confirmed=true/false。

    目的：量度「盤中見到守住」→「收市真係確認」嘅轉化率。呢個數字而家
    完全冇人知 —— 如果九成，盤中睇到守住就可以放心預備；如果得五成，
    就只可以當參考，唔可以當預告。

    只記有真實分鐘線報價（bars>0）嗰啲 —— 港股時段跑嗰啲 run 冇美股即時
    價，記低咗只會污染統計。
    """
    forming = band.get("forming") or []
    if not forming:
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log = {"days": {}}
    if os.path.exists(LOG_PATH):
        try:
            log = json.load(open(LOG_PATH))
        except Exception:
            pass
    log.setdefault("days", {})
    rec = log["days"].setdefault(day, {"symbols": {}})

    n = 0
    for r in forming:
        q = quotes.get(r["symbol"])
        if not q or not q.get("bars"):
            continue
        lo, px = q.get("day_low"), q.get("price")
        broke = lo is not None and lo <= r["kill_low"]
        tier_bad = px is not None and px > r["kill_close"]
        rec["symbols"][r["symbol"]] = {
            "t": datetime.now(timezone.utc).strftime("%H:%M"),
            "price": px, "day_low": lo,
            "kill_low": r["kill_low"], "kill_close": r["kill_close"],
            "ext": round(r.get("ext", 0), 2),
            "status": "broke" if broke else "tier" if tier_bad else "hold",
            # 由 band_scan.py 回填：收市後究竟有冇入到 confirmed
            "confirmed": rec["symbols"].get(r["symbol"], {}).get("confirmed"),
        }
        n += 1

    for d in sorted(log["days"])[:-LOG_DAYS]:
        log["days"].pop(d, None)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "w") as f:
            json.dump(log, f, indent=2)
        print(f"forming log: {day} · {n} 隻 → {LOG_PATH}")
    except Exception as e:
        print(f"  forming log 寫唔到: {e}")


def main():
    if not os.path.exists(IN_PATH):
        sys.exit(f"搵唔到 {IN_PATH} —— 要先行 band_scan.py")
    band = json.load(open(IN_PATH))
    tickers = band.get("tickers", [])
    if not tickers:
        sys.exit("band.json 冇 tickers")
    tickers = [t for t in tickers
               if ("HK" if t.endswith(".HK") else "US") in MARKETS]
    if not tickers:
        print(f"QUOTE_MARKETS={sorted(MARKETS)} 之下冇 ticker 要抽")
        return

    t0 = time.time()
    quotes = {}
    if os.path.exists(OUT_PATH):
        try:                      # 保留另一邊市場上次嘅報價，唔好抹走
            quotes = json.load(open(OUT_PATH)).get("quotes", {})
        except Exception:
            pass
    quotes.update(grab(tickers))
    payload = {
        "quoted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "band_scanned_at": band.get("scanned_at"),   # 前端用嚟偵測 JSON 過期
        "quotes": quotes,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"{len(tickers)} 隻 ({sorted(MARKETS)}) · 合共 {len(quotes)} quotes "
          f"({time.time() - t0:.0f}s) → {OUT_PATH}")
    log_forming(band, quotes)


if __name__ == "__main__":
    main()
