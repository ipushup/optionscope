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
from daily_calc import compute_ema_status
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
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
    """Returns (status, days) as of the last closed bar -- 'long'/'short' plus
    how many consecutive closed bars pos has held that same direction (1 =
    flipped on the most recent bar). None if not enough data."""
    if len(df) < max(atr_period, 2) + 5:
        return None, None
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
        return None, None
    days = 0
    for p in reversed(pos):
        if p == last:
            days += 1
        else:
            break
    return ("long" if last == 1 else "short"), days


def _supertrend_trend(df: pd.DataFrame, period: int, multiplier: float):
    """SuperTrend 趨勢陣列（1 / -1 / 0=未有效）。ATR 暖機期（NaN）會跳過，從第一個有效棒起算，
    避免 NaN 污染 final band 令趨勢永遠唔轉向。"""
    atr = wilder_atr(df, period)
    hl2 = (df["High"] + df["Low"]) / 2
    basic_ub = (hl2 + multiplier * atr).values
    basic_lb = (hl2 - multiplier * atr).values
    close = df["Close"].values
    n = len(close)
    trend = np.zeros(n, dtype=int)
    valid = np.where(~np.isnan(basic_ub))[0]
    if len(valid) == 0:
        return trend
    s = int(valid[0])
    fu = np.full(n, np.nan); fl = np.full(n, np.nan)
    fu[s] = basic_ub[s]; fl[s] = basic_lb[s]
    trend[s] = 1 if close[s] >= (fu[s] + fl[s]) / 2 else -1
    for i in range(s + 1, n):
        fu[i] = basic_ub[i] if (basic_ub[i] < fu[i - 1] or close[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = basic_lb[i] if (basic_lb[i] > fl[i - 1] or close[i - 1] < fl[i - 1]) else fl[i - 1]
        if trend[i - 1] == 1:
            trend[i] = -1 if close[i] < fl[i] else 1
        else:
            trend[i] = 1 if close[i] > fu[i] else -1
    return trend


def supertrend_status(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0):
    if len(df) < period + 5:
        return None
    last = _supertrend_trend(df, period, multiplier)[-1]
    if last == 0:
        return None
    return "long" if last == 1 else "short"


def supertrend_days(df: pd.DataFrame, period: int = 10, multiplier: float = 3.0):
    """(status, days)：SuperTrend 方向 + 連續咗幾多棒（轉向嗰棒 = 1）。"""
    if len(df) < period + 5:
        return None, None
    tr = _supertrend_trend(df, period, multiplier)
    last = tr[-1]
    if last == 0:
        return None, None
    days = 0
    for v in tr[::-1]:
        if v == last:
            days += 1
        else:
            break
    return ("long" if last == 1 else "short"), days


def hv_tb_status(df: pd.DataFrame, tb_recent: int = 20):
    """Heavy（最近一個 HB/HS，最新棒 = 1）同 Triple Band 買入確認棒（只計 TB，最近 tb_recent 棒內）。
    同 My List / Signal Board 同一套（intraday_signals）。出錯或棒數不足回 (None, None)。"""
    n = len(df)
    hv = tb = None
    tbs_sig = None
    try:
        import intraday_signals as S
        if n > 101:
            bi, _bv, si, _sv = S.heavy_now(df)
            if bi is not None or si is not None:
                buy = si is None or (bi is not None and bi >= si)
                hv = {"s": 1 if buy else -1, "n": n - (bi if buy else si)}
        # TB = 買入確認、TS = 賣出（TBskip 唔計）；攞最近一個，最近 tb_recent 棒內
        evs = [e for e in S.triple_band(df) if e["kind"] in ("TB", "TS")]
        if evs and n - evs[-1]["i"] < tb_recent:
            last = evs[-1]
            tbs_sig = {"s": 1 if last["kind"] == "TB" else -1, "n": n - last["i"]}
            if last["kind"] == "TB":
                tb = tbs_sig["n"]
    except Exception:  # noqa: BLE001
        pass
    return hv, tb, tbs_sig


# ---------------------------------------------------------------------------
# 3. Fetch + run
# ---------------------------------------------------------------------------

def tf_signals(df: pd.DataFrame):
    """一個時間框（D / W / M 棒）嘅 UT / ST / HV / TB。棒數不足嘅項目留 None。"""
    ut, ut_days = ut_bot_status(df)
    st, st_days = supertrend_days(df)
    hv, tb_days, tb = hv_tb_status(df)
    return {"ut_bot": ut, "ut_days": ut_days, "supertrend": st, "st_days": st_days, "hv": hv, "tb_days": tb_days, "tb": tb}


def _clean(data, batch, t):
    df = data[t].dropna(how="all") if len(batch) > 1 else data.dropna(how="all")
    return df.dropna(subset=["Close"])


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

        # 週線（5 年）／月線（15 年）：Data 頁 D/W/M 切換用。HV 要 >101 棒，所以月線攞足年期
        tf_data = {}
        for key, interval, period in (("W", "1wk", "5y"), ("M", "1mo", "15y")):
            try:
                tf_data[key] = yf.download(
                    tickers=batch, period=period, interval=interval,
                    group_by="ticker", threads=True, progress=False, auto_adjust=False,
                )
            except Exception as ex:
                print(f"{key} batch download failed ({batch[:3]}...): {ex}", file=sys.stderr)

        for t in batch:
            try:
                df = _clean(data, batch, t)
                if df.empty:
                    continue
                r = tf_signals(df)
                r["last_close"] = round(float(df["Close"].iloc[-1]), 4)
                try:   # EMA 疊（10/20/50/89/250，收市價 vs EMA）畀主頁共振榜展開行用
                    r["ema"] = [{"p": e["period"], "above": bool(e["above"]), "valid": bool(e["valid"])} for e in compute_ema_status(df.copy())["pills"]]
                except Exception:  # noqa: BLE001
                    pass
                r["asof_date"] = str(df.index[-1].date())
                for key, d in tf_data.items():
                    try:
                        dfk = _clean(d, batch, t)
                        if len(dfk) >= 15:
                            r[key] = tf_signals(dfk)
                    except Exception as ex:  # noqa: BLE001
                        print(f"Skip {t} {key}: {ex}", file=sys.stderr)
                results[t] = r
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
