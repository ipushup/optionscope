#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
band_scan.py — OptionScope Triple Band radar scanner
=====================================================
收市後行一次，計晒全部訊號，寫 frontend/public/band.json 畀 React 用。

Repo layout（跟 radar_scan.py 同一個 pattern）：
    scanner/band_scan.py      ← 呢個檔
    scanner/band_scanner.py   ← module（同 daily_brief 嗰個一模一樣）
    frontend/public/band.json ← 輸出

獨立運作：唔 import daily_brief，自己有 fetch_df，語意相同（closed candle only）。

⚠️ 唯一計訊號嘅地方
   前端唔准重算任何嘢。pivot / ext / rU60 / UT Bot 全部喺呢度用收咗市
   嘅棒計死，網頁淨係刷報價同「距死線幾遠」。intraday 重算會出假訊號 ——
   成套方法係 closed-candle based。
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from band_scanner import compute_band_radar  # noqa: E402

# ── WATCHLIST ─────────────────────────────────────────────────────────────
# 策略只做美股（港股 big-filter 之下 PF 只有 1.52）。港股照掃，入觀察組。
# 同 daily_brief.py 保持同步。
WATCHLIST_US = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "NFLX",
    "CRM", "ORCL", "ADBE", "NOW", "PANW", "CRWD", "ZS", "SNOW", "DDOG", "MDB",
    "PLTR", "APP", "ANET", "MU", "INTC", "QCOM", "TXN", "AMAT", "LRCX", "KLAC",
    "HOOD", "COIN", "PYPL", "SOFI", "V", "MA", "JPM", "GS", "MS", "BAC",
    "UNH", "LLY", "ABBV", "JNJ", "MRK", "PFE", "TMO", "ISRG", "VRTX", "REGN",
    "XOM", "CVX", "COP", "SLB", "OXY", "CAT", "DE", "HON", "GE", "BA",
    "WMT", "COST", "HD", "NKE", "SBUX", "MCD", "KO", "PEP", "PG", "CL",
    "UBER", "ABNB", "DASH", "RBLX", "SHOP", "SPOT", "TTD", "NET", "CRWV",
    "VKTX", "HIMS", "TEM", "ZETA", "ELV", "PGR", "TRV", "ADP", "IBM", "MPC",
    "GEV", "VRT", "EQIX", "OKLO", "SMR", "NNE", "AVAV", "KTOS", "RCAT", "IONQ",
]
WATCHLIST_HK = [
    "0001.HK", "0002.HK", "0003.HK", "0005.HK", "0011.HK", "0016.HK", "0027.HK", "0066.HK",
    "0175.HK", "0241.HK", "0267.HK", "0288.HK", "0300.HK", "0386.HK", "0388.HK", "0669.HK",
    "0700.HK", "0762.HK", "0823.HK", "0857.HK", "0883.HK", "0939.HK", "0941.HK", "0960.HK",
    "0968.HK", "0981.HK", "0992.HK", "1024.HK", "1038.HK", "1044.HK", "1093.HK", "1099.HK",
    "1109.HK", "1177.HK", "1211.HK", "1299.HK", "1398.HK", "1810.HK", "1876.HK", "1928.HK",
    "1929.HK", "2007.HK", "2015.HK", "2020.HK", "2057.HK", "2269.HK", "2313.HK", "2318.HK",
    "2319.HK", "2331.HK", "2382.HK", "2388.HK", "2628.HK", "3690.HK", "3692.HK", "3968.HK",
    "3988.HK", "6160.HK", "6618.HK", "6690.HK", "6862.HK", "9618.HK", "9633.HK", "9888.HK",
    "9961.HK", "9988.HK", "9999.HK", "1651.HK", "2268.HK", "6887.HK", "9606.HK", "9926.HK",
]

OUT_PATH = os.environ.get("BAND_OUT", "frontend/public/band.json")
VETO_DAYS = int(os.environ.get("BAND_VETO_DAYS", "7") or 7)

_cache = {}


def fetch_df(ticker, interval="1d", period="2y", retries=2):
    key = (ticker, interval, period)
    if key in _cache:
        return _cache[key]
    for attempt in range(retries + 1):
        try:
            df = yf.download(ticker, period=period, interval=interval,
                             progress=False, auto_adjust=False, threads=False)
            if df is not None and not df.empty:
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)
                df = drop_forming(df, ticker)
                _cache[key] = df
                return df
        except Exception as e:
            if attempt == retries:
                print(f"  fetch fail {ticker}: {e}")
            time.sleep(1)
    _cache[key] = pd.DataFrame()
    return _cache[key]


def drop_forming(df, ticker):
    """
    掉走未收市嘅棒。比 radar_scan 嘅 get_closed_df 精確少少 ——
    後者見到「最後一支棒日期 == 今日 UTC 日期」就掉，即係 20:15 UTC
    跑嗰陣會連當日已經收咗市嘅美股棒都掉埋，白白蝕一日。
    呢度改成用收市時間判斷：美股 20:05 UTC 後、港股 08:10 UTC 後
    當日棒先算封。（夏令時差一個鐘，多留五分鐘緩衝已經夠。）
    """
    if df is None or df.empty:
        return df
    now = pd.Timestamp.now(tz="UTC")
    last = df.index[-1]
    last = last.tz_localize("UTC") if last.tzinfo is None else last.tz_convert("UTC")
    if last.date() != now.date():
        return df
    close_h, close_m = (8, 10) if ticker.endswith(".HK") else (20, 5)
    if (now.hour, now.minute) >= (close_h, close_m):
        return df
    return df.iloc[:-1]


def load_earnings_veto():
    """
    業績 veto。有 earnings_cache.json（daily_brief 出嘅）就用，冇就空。
    格式：{"AAPL": "2026-08-05", ...}
    """
    path = os.environ.get("BAND_EARNINGS", "frontend/public/earnings.json")
    if not os.path.exists(path):
        return {}
    try:
        raw = json.load(open(path))
    except Exception:
        return {}
    out, today = {}, pd.Timestamp.now(tz="UTC").normalize()
    for sym, d in raw.items():
        try:
            n = len(pd.bdate_range(today, pd.Timestamp(d, tz="UTC"))) - 1
        except Exception:
            continue
        if 0 <= n <= VETO_DAYS:
            out[sym] = n
    return out


def main():
    t0 = time.time()
    print(f"Triple Band scan · {len(WATCHLIST_US)} US + {len(WATCHLIST_HK)} HK")

    payload = compute_band_radar(WATCHLIST_US, WATCHLIST_HK, fetch_df,
                                 earnings_veto=load_earnings_veto())

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    c = payload["counts"]
    print(f"\n確認 {c['confirmed']} · 形成中 {c['forming']} · "
          f"候選 {c['candidates']}（cap {c['candidates_capped']}）· "
          f"出場 {c['exits']} · 觀察 {c['observe']} · 錯誤 {c['errors']} "
          f"({time.time() - t0:.0f}s) → {OUT_PATH}")
    for r in payload["confirmed"]:
        print(f"  ✅ {r['symbol']:<8} ext {r['ext']:.2f}  rU60 {r['ru60']:+.1f}%  "
              f"訊號價 {r['price']:.2f}  → 明早開市買")
    for r in payload["forming"]:
        print(f"  ⏳ {r['symbol']:<8} ext {r['ext']:.2f}  "
              f"跌穿 {r['kill_low']:.2f} 作廢 / 收高過 {r['kill_close']:.2f} 變 small")


if __name__ == "__main__":
    main()
