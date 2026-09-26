"""
indicator_scan.py

Computes UT Bot (KV=2, ATR period=1) and SuperTrend (10, 3) status for every
symbol in Watchlists.txt, using daily OHLC from yfinance, and writes a single
JSON file that the new Watchlist view (frontend) can merge with band.json and
watchlist_quotes.json.

Run after market close, same as band_scanner.py:
    python indicator_scan.py --watchlist Watchlists.txt --out indicator_signals.json

NOTE ON CLOSED-CANDLE SAFETY:
daily_brief.py already had a bug class around "closed-candle detection for
daily SuperTrend signals" (see project notes). This script assumes the last
row returned by yfinance for a given day is only a *closed* daily candle when
run after that market's close. If you wire this into a workflow that can run
intraday, reuse whatever closed-candle guard daily_brief.py already has
instead of trusting yfinance's last row blindly.

ASSUMPTIONS TO CONFIRM WITH YOU:
- UT Bot "ATR=1" in your notes is read here as ATR *period* = 1 bar. That's an
  unusual period (nearly no smoothing) -- if you actually meant a different
  parameterization (e.g. ATR period 10, key value 1), tell me and I'll flip it.
- SuperTrend uses the standard (10, 3) ATR-period/multiplier convention.
- Output schema below is my best guess -- once you show me band.json's actual
  field names I'll match them exactly instead of guessing.
"""

import json
import sys
import time
import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

# ---------------------------------------------------------------------------
# 1. Parse Watchlists.txt (flat comma-separated, sections marked by ###TOKEN)
# ---------------------------------------------------------------------------

# Exchanges yfinance can resolve directly with just the bare symbol
US_PLAIN_EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "CBOE"}

# Exchange -> yfinance suffix (applied as SYMBOL + suffix)
SUFFIX_MAP = {
    "KRX": ".KS",
    "ASX": ".AX",
    "TSX": ".TO",
    "TSXV": ".V",
}


def hkex_ticker(sym: str) -> str:
    """HKEX needs zero-padding to 4 digits + '.HK'"""
    return f"{sym.zfill(4)}.HK"


# A few well-known index/fx/futures tickers worth mapping manually;
# everything else in these exchanges is skipped (not a real equity quote).
MANUAL_MAP = {
    ("SPCFD", "SPX"): "^GSPC",
    ("NASDAQ", "IXIC"): "^IXIC",
    ("TVC", "DJI"): "^DJI",
    ("TVC", "DXY"): "DX-Y.NYB",
    ("TVC", "GOLD"): "GC=F",
    ("TVC", "SILVER"): "SI=F",
    ("TVC", "USOIL"): "CL=F",
    ("CBOE", "VIX"): "^VIX",
    ("BITSTAMP", "BTCUSD"): "BTC-USD",
    ("BITSTAMP", "ETHUSD"): "ETH-USD",
    ("HSI", "HSI"): "^HSI",
}

SKIP_EXCHANGES = {"CME_MINI", "CBOT_MINI"}  # futures contracts, no clean yfinance daily equity series


def resolve_ticker(exchange: str, symbol: str):
    key = (exchange, symbol)
    if key in MANUAL_MAP:
        return MANUAL_MAP[key]
    if exchange in US_PLAIN_EXCHANGES:
        return symbol
    if exchange == "HKEX":
        return hkex_ticker(symbol)
    if exchange in SUFFIX_MAP:
        return symbol + SUFFIX_MAP[exchange]
    if exchange in SKIP_EXCHANGES:
        return None
    return None  # unknown exchange -> skip rather than guess wrong


def parse_watchlist(path: Path):
    """Returns list of dicts: {section, exchange, symbol, ticker}"""
    raw = path.read_text(encoding="utf-8").strip()
    tokens = raw.split(",")
    out = []
    section = "UNSECTIONED"
    for tok in tokens:
        tok = tok.strip()
        if not tok:
            continue
        if tok.startswith("###"):
            section = tok[3:].strip()
            continue
        if ":" not in tok:
            continue
        exchange, symbol = tok.split(":", 1)
        ticker = resolve_ticker(exchange, symbol)
        out.append({
            "section": section,
            "exchange": exchange,
            "symbol": symbol,
            "ticker": ticker,
        })
    return out


# ---------------------------------------------------------------------------
# 2. Indicators
# ---------------------------------------------------------------------------

def wilder_atr(df: pd.DataFrame, period: int) -> pd.Series:
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    if period <= 1:
        return tr
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def ut_bot_status(df: pd.DataFrame, key_value: float = 2.0, atr_period: int = 1):
    """Returns 'long' or 'short' as of the last closed bar. None if not enough data."""
    if len(df) < max(atr_period, 2) + 5:
        return None
    atr = wilder_atr(df, atr_period)
    n_loss = (key_value * atr).values
    close = df["Close"].values
    stop = np.zeros(len(close))
    pos = np.zeros(len(close), dtype=int)

    for i in range(1, len(close)):
        prev_stop = stop[i - 1]
        if close[i] > prev_stop and close[i - 1] > prev_stop:
            stop[i] = max(prev_stop, close[i] - n_loss[i])
        elif close[i] < prev_stop and close[i - 1] < prev_stop:
            stop[i] = min(prev_stop, close[i] + n_loss[i])
        elif close[i] > prev_stop:
            stop[i] = close[i] - n_loss[i]
        else:
            stop[i] = close[i] + n_loss[i]

        if close[i - 1] < prev_stop and close[i] > prev_stop:
            pos[i] = 1
        elif close[i - 1] > prev_stop and close[i] < prev_stop:
            pos[i] = -1
        else:
            pos[i] = pos[i - 1]

    last = pos[-1]
    if last == 0:
        return None
    return "long" if last == 1 else "short"


def supertrend_status(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0):
    if len(df) < period + 5:
        return None
    atr = wilder_atr(df, period)
    hl2 = (df["High"] + df["Low"]) / 2
    basic_ub = (hl2 + multiplier * atr).values
    basic_lb = (hl2 - multiplier * atr).values
    close = df["Close"].values

    final_ub = np.zeros(len(close))
    final_lb = np.zeros(len(close))
    trend = np.ones(len(close), dtype=int)

    for i in range(1, len(close)):
        final_ub[i] = (
            basic_ub[i]
            if (basic_ub[i] < final_ub[i - 1] or close[i - 1] > final_ub[i - 1])
            else final_ub[i - 1]
        )
        final_lb[i] = (
            basic_lb[i]
            if (basic_lb[i] > final_lb[i - 1] or close[i - 1] < final_lb[i - 1])
            else final_lb[i - 1]
        )
        if trend[i - 1] == 1:
            trend[i] = -1 if close[i] < final_lb[i] else 1
        else:
            trend[i] = 1 if close[i] > final_ub[i] else -1

    last = trend[-1]
    return "long" if last == 1 else "short"


# ---------------------------------------------------------------------------
# 3. Fetch + run
# ---------------------------------------------------------------------------

def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def run(watchlist_path: Path, out_path: Path, chunk_size: int = 80, sleep_s: float = 1.0):
    entries = parse_watchlist(watchlist_path)
    valid = [e for e in entries if e["ticker"]]
    skipped = [e for e in entries if not e["ticker"]]
    print(f"Parsed {len(entries)} watchlist entries -> {len(valid)} resolvable, {len(skipped)} skipped", file=sys.stderr)

    results = {}
    tickers_all = [e["ticker"] for e in valid]

    for batch in chunked(tickers_all, chunk_size):
        try:
            data = yf.download(
                tickers=batch, period="1y", interval="1d",
                group_by="ticker", threads=True, progress=False,
                auto_adjust=False,
            )
        except Exception as ex:
            print(f"Batch download failed ({batch[:3]}...): {ex}", file=sys.stderr)
            time.sleep(sleep_s)
            continue

        for t in batch:
            try:
                df = data[t].dropna(how="all") if len(batch) > 1 else data.dropna(how="all")
                df = df.dropna(subset=["Close"])
                if df.empty:
                    continue
                ut = ut_bot_status(df)
                st = supertrend_status(df)
                results[t] = {
                    "ut_bot": ut,
                    "supertrend": st,
                    "last_close": round(float(df["Close"].iloc[-1]), 4),
                    "asof_date": str(df.index[-1].date()),
                }
            except Exception as ex:
                print(f"Skip {t}: {ex}", file=sys.stderr)
        time.sleep(sleep_s)

    # keyed by the resolved ticker itself (e.g. "PEP", "0700.HK") so it lines
    # up directly with band.json's own "symbol" field -- band.json uses the
    # same bare-US-ticker / zero-padded-".HK" convention.
    signals = {}
    for e in valid:
        r = results.get(e["ticker"])
        if not r:
            continue
        signals[e["ticker"]] = {
            "exchange": e["exchange"],
            "symbol": e["symbol"],
            "section": e["section"],
            **r,
        }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "params": {"ut_bot": {"key_value": 2, "atr_period": 1}, "supertrend": {"period": 10, "multiplier": 3}},
        "count": len(signals),
        "skipped_exchanges": sorted({e["exchange"] for e in skipped}),
        "signals": signals,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(signals)} symbol signals -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", default="Watchlists.txt", type=Path)
    ap.add_argument("--out", default="indicator_signals.json", type=Path)
    ap.add_argument("--chunk-size", default=80, type=int)
    args = ap.parse_args()
    run(args.watchlist, args.out, chunk_size=args.chunk_size)
