#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
watchlist_quotes.py — Watchlist 報價刷新 (Last / %Chg / E%Chg)
================================================================
跟 band_quotes.py 同一套做法：batch yf.download 1分鐘線，唔用
`.info`/`fast_info` — band_quotes.py 已經證實 FastInfo 會靜靜咁
出空 dict 唔拋錯，最難捉。呢度照跟。

同 band_quotes.py 唔一樣嘅地方：
  1. 呢度攞嘅係成個 Watchlists.txt（~300隻，band之外仲有好多thematic
     symbol），唔係淨係 band.json 嘅 signal 子集。
  2. 要多計 %Chg / E%Chg，band_quotes.py 冇做呢樣——所以多咗兩條料：
     a) 用 prepost=True 攞埋盤前盤後嘅1分鐘線，分辨 regular vs extended。
     b) 多一個 daily bar batch 攞前收（prev close）嚟計 %Chg。

ASSUMPTIONS TO CONFIRM WITH YOU（同你share，唔係我拍板）：
  - 港股午市休市（12:00-13:00 HKT）呢度冇特別處理，當成連續盤照計；
    如果啱啱喺lunch break嗰陣跑，"regular" 最後一口價會係12:00前嗰口，
    唔會顯示"break"狀態。細節位，睇你需唔需要。
  - 分 regular / pre / post 純粹用交易所本地時間窗口判斷
    （US 09:30–16:00 ET, HK 09:30–16:00 HKT），冇處理半日市（如平安夜）。
  - yfinance 1分鐘線 index 假設已經係交易所本地時區 tz-aware
    （官方行為，但版本之間偶有變動，第一次跑之後值得你抽查一兩隻核對）。

Run:
    python watchlist_quotes.py --watchlist Watchlists.txt --out watchlist_quotes.json
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

from indicator_scan import parse_watchlist

CHUNK = 40  # 同 band_quotes.py 一致
SLEEP_S = 0.5

MARKET_TZ = {"US": ZoneInfo("America/New_York"), "HK": ZoneInfo("Asia/Hong_Kong")}
REGULAR_WINDOW = {"US": ((9, 30), (16, 0)), "HK": ((9, 30), (16, 0))}


def market_of(ticker: str) -> str:
    return "HK" if ticker.endswith(".HK") else "US"


def split_session(idx_local_time, market):
    """time-of-day (datetime.time) -> 'pre' / 'regular' / 'post'"""
    (oh, om), (ch, cm) = REGULAR_WINDOW[market]
    t = idx_local_time
    if (t.hour, t.minute) < (oh, om):
        return "pre"
    if (t.hour, t.minute) >= (ch, cm):
        return "post"
    return "regular"


def grab_intraday(tickers, market):
    """Batch 1m bars incl. pre/post. Returns {ticker: {last, ext_price, market_state}}"""
    out = {}
    tz = MARKET_TZ[market]
    for i in range(0, len(tickers), CHUNK):
        part = tickers[i:i + CHUNK]
        try:
            df = yf.download(" ".join(part), period="1d", interval="1m",
                              prepost=True, progress=False, auto_adjust=False,
                              threads=False, group_by="ticker")
        except Exception as e:
            print(f"  intraday batch fail {part[0]}...: {e}", file=sys.stderr)
            continue
        if df is None or df.empty:
            continue
        for sym in part:
            try:
                d = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                d = d.dropna(subset=["Close"])
                if d.empty:
                    continue
                idx = d.index
                idx = idx.tz_localize("UTC") if idx.tz is None else idx
                idx_local = idx.tz_convert(tz)
                sessions = [split_session(ts.time(), market) for ts in idx_local]
                d = d.copy()
                d["_session"] = sessions

                regular = d[d["_session"] == "regular"]
                last_regular = float(regular["Close"].iloc[-1]) if not regular.empty else None

                last_row_session = sessions[-1]
                last_price = float(d["Close"].iloc[-1])
                if last_row_session in ("pre", "post") and last_regular is not None:
                    ext_price, market_state = last_price, last_row_session.upper()
                elif last_row_session in ("pre", "post") and last_regular is None:
                    # market hasn't opened for the regular session yet today
                    ext_price, market_state = last_price, last_row_session.upper()
                else:
                    ext_price, market_state = None, "REGULAR"

                out[sym] = {
                    "last": last_regular if last_regular is not None else last_price,
                    "ext_price": ext_price,
                    "market_state": market_state,
                }
            except Exception as ex:
                print(f"  parse fail {sym}: {ex}", file=sys.stderr)
        time.sleep(SLEEP_S)
    return out


def grab_prev_close(tickers):
    """Batch daily bars, return {ticker: prev_close}. Mirrors band_quotes.py's
    daily fallback style (period=5d, interval=1d)."""
    out = {}
    today = datetime.now(timezone.utc).date()
    for i in range(0, len(tickers), CHUNK):
        part = tickers[i:i + CHUNK]
        try:
            df = yf.download(" ".join(part), period="5d", interval="1d",
                              progress=False, auto_adjust=False,
                              threads=False, group_by="ticker")
        except Exception as e:
            print(f"  daily batch fail {part[0]}...: {e}", file=sys.stderr)
            continue
        if df is None or df.empty:
            continue
        for sym in part:
            try:
                d = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                d = d.dropna(subset=["Close"])
                if d.empty:
                    continue
                # if the last daily row is *today*, that's the still-forming
                # bar -- previous close is the row before it. Otherwise the
                # last row already IS the previous close (today's bar hasn't
                # posted yet, e.g. run before/soon after open).
                if d.index[-1].date() == today and len(d) >= 2:
                    out[sym] = float(d["Close"].iloc[-2])
                else:
                    out[sym] = float(d["Close"].iloc[-1])
            except Exception as ex:
                print(f"  prev_close parse fail {sym}: {ex}", file=sys.stderr)
        time.sleep(SLEEP_S)
    return out


def load_prev_quotes(out_path: Path):
    """保留上次報價 -- 同 band_quotes.py 一致嘅防禦寫法，
    避免單一 run 部分市場冧咗就令另一邊市場嘅料一齊消失。"""
    if out_path.exists():
        try:
            return json.loads(out_path.read_text(encoding="utf-8")).get("quotes", {})
        except Exception:
            pass
    return {}


def run(watchlist_path: Path, out_path: Path):
    entries = parse_watchlist(watchlist_path)
    valid = [e for e in entries if e["ticker"]]
    by_market = {"US": [], "HK": []}
    for e in valid:
        by_market[market_of(e["ticker"])].append(e["ticker"])

    quotes = load_prev_quotes(out_path)
    fresh_count = 0
    note = None

    for market, tickers in by_market.items():
        if not tickers:
            continue
        print(f"{market}: {len(tickers)} symbols", file=sys.stderr)
        intraday = grab_intraday(tickers, market)
        prev_close = grab_prev_close(tickers)

        if not intraday:
            print(f"  ⚠ {market} 1m 全空，fallback 落日線 (同 band_quotes.py 一致)", file=sys.stderr)

        for t in tickers:
            pc = prev_close.get(t)
            iq = intraday.get(t)

            if iq is None:
                # daily-only fallback: no live price today, use prev_close itself
                # as "last" with no chg -- matches band_quotes.py's bars=0 flag idea
                if pc is None:
                    continue
                quotes[t] = {"last": pc, "prev_close": pc, "chg": None, "chg_pct": None,
                             "market_state": "CLOSED", "ext_price": None, "ext_chg_pct": None,
                             "live": False}
                continue

            last = iq["last"]
            chg = last - pc if pc else None
            chg_pct = (chg / pc * 100) if (chg is not None and pc) else None
            ext_price = iq["ext_price"]
            ext_chg_pct = ((ext_price - last) / last * 100) if (ext_price is not None and last) else None

            quotes[t] = {
                "last": round(last, 4),
                "prev_close": round(pc, 4) if pc is not None else None,
                "chg": round(chg, 4) if chg is not None else None,
                "chg_pct": round(chg_pct, 4) if chg_pct is not None else None,
                "market_state": iq["market_state"],
                "ext_price": round(ext_price, 4) if ext_price is not None else None,
                "ext_chg_pct": round(ext_chg_pct, 4) if ext_chg_pct is not None else None,
                "live": True,
            }
            fresh_count += 1

    payload = {
        "quoted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(quotes),
        "fresh_this_run": fresh_count,
        "quotes": quotes,
    }
    if note:
        payload["note"] = note

    os.makedirs(os.path.dirname(str(out_path)) or ".", exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{fresh_count} fresh / {len(quotes)} total quotes -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", default=Path(os.environ.get("WATCHLIST_TXT", "Watchlists.txt")), type=Path)
    ap.add_argument("--out", default=Path(os.environ.get("WATCHLIST_QUOTES_OUT", "watchlist_quotes.json")), type=Path)
    args = ap.parse_args()
    run(args.watchlist, args.out)
