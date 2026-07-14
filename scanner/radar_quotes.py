#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
radar_quotes.py — lightweight price refresher for the Turnaround Radar web page
===============================================================================
Reads the ticker list from radar.json, fetches current quotes (regular + pre +
post market) and writes radar_quotes.json. No indicator maths — this is the fast
job that can run every few minutes without burning Action minutes.

Session logic (why three price fields):
  US  : premarket 04:00-09:30 ET · regular 09:30-16:00 ET · postmarket 16:00-20:00 ET
  HK  : regular 09:30-16:00 HKT (no pre/post on cash equities)
        "night market" for a HK-listed name in practice = its US ADR / US session,
        so for HK tickers we only report the regular quote and yfinance's last price.

yfinance's `fast_info` is used first (cheap); `info` is the fallback for the
pre/post fields, which fast_info does not carry.
"""
import json, os, sys, time
from datetime import datetime, timezone

import yfinance as yf

RADAR_PATH  = os.environ.get("RADAR_IN",  "frontend/public/radar.json")
QUOTES_PATH = os.environ.get("QUOTES_OUT", "frontend/public/radar_quotes.json")


def quote_one(tkr):
    """Return dict with regular/pre/post prices. Any field may be None."""
    out = {"price": None, "prev_close": None, "chg_pct": None,
           "pre": None, "pre_pct": None, "post": None, "post_pct": None,
           "session": "closed", "as_of": None}
    try:
        t = yf.Ticker(tkr)

        # cheap path
        try:
            fi = t.fast_info
            out["price"]      = _f(fi.get("lastPrice"))
            out["prev_close"] = _f(fi.get("previousClose"))
        except Exception:
            pass

        # info carries pre/post market fields
        try:
            info = t.info or {}
        except Exception:
            info = {}

        if out["price"] is None:
            out["price"] = _f(info.get("regularMarketPrice"))
        if out["prev_close"] is None:
            out["prev_close"] = _f(info.get("regularMarketPreviousClose"))

        state = (info.get("marketState") or "").upper()

        is_hk = tkr.upper().endswith(".HK")

        # HK cash equities have no pre/post session. yfinance still returns a
        # postMarketPrice for them (it echoes the close), which made the UI
        # label every HK card "POST". Suppress both fields for .HK.
        pre  = None if is_hk else _f(info.get("preMarketPrice"))
        post = None if is_hk else _f(info.get("postMarketPrice"))
        reg  = out["price"]
        prev = out["prev_close"]

        # NOTE: never trust yfinance's *ChangePercent fields — compute them.
        # (Same bug that hit premarket_brief.py: preMarketChangePercent is unreliable.)
        if pre and prev:
            out["pre"], out["pre_pct"] = pre, round((pre / prev - 1) * 100, 2)
        if post and reg:
            out["post"], out["post_pct"] = post, round((post / reg - 1) * 100, 2)
        if reg and prev:
            out["chg_pct"] = round((reg / prev - 1) * 100, 2)

        if is_hk:
            out["session"] = "regular" if state == "REGULAR" else "closed"
        elif state in ("PRE", "PREPRE"):
            out["session"] = "pre"
        elif state == "REGULAR":
            out["session"] = "regular"
        elif state in ("POST", "POSTPOST"):
            out["session"] = "post"
        else:
            out["session"] = "closed"

        out["as_of"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception as e:
        print(f"  quote fail {tkr}: {e}")
    return out


def _write(payload):
    d = os.path.dirname(QUOTES_PATH)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(QUOTES_PATH, "w") as f:
        json.dump(payload, f, indent=2)


def _f(v):
    try:
        f = float(v)
        return round(f, 4) if f == f and f != 0 else None    # NaN / 0 guard
    except (TypeError, ValueError):
        return None


def main():
    if not os.path.exists(RADAR_PATH):
        print(f"ERROR: {RADAR_PATH} not found.")
        print("  Run the workflow once with full_scan = true to create it.")
        sys.exit(1)

    with open(RADAR_PATH) as f:
        radar = json.load(f)
    tickers = radar.get("tickers") or [c["ticker"] for c in radar.get("cards", [])]
    if not tickers:
        print("no tickers in radar.json — writing empty quotes file")
        _write({"updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "radar_scanned_at": radar.get("scanned_at"), "quotes": {}})
        sys.exit(0)

    print(f"Quoting {len(tickers)} radar tickers…")
    quotes, t0 = {}, time.time()
    for tk in tickers:
        quotes[tk] = quote_one(tk)

    _write({
        "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "radar_scanned_at": radar.get("scanned_at"),
        "quotes": quotes,
    })

    ok = sum(1 for q in quotes.values() if q["price"])
    print(f"{ok}/{len(tickers)} quoted in {time.time()-t0:.0f}s → {QUOTES_PATH}")
    for tk in tickers[:8]:
        q = quotes[tk]
        extra = ""
        if q["pre"]:  extra = f" · PRE {q['pre']} ({q['pre_pct']:+.2f}%)"
        if q["post"]: extra = f" · POST {q['post']} ({q['post_pct']:+.2f}%)"
        print(f"  {tk:<10} {q['price']} [{q['session']}]{extra}")


if __name__ == "__main__":
    main()
