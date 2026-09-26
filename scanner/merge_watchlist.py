"""
merge_watchlist.py

Combines:
  - band.json               (Triple Band status + band's own ut_pos, US universe only)
  - indicator_signals.json  (independently computed UT Bot + SuperTrend, full Watchlists.txt universe)
  - watchlist_quotes.json   (Last / Chg% / Ext%Chg)
  - Watchlists.txt          (section grouping, the master symbol list + order)

...into watchlist_merged.json, one record per Watchlists.txt symbol, ready for
the Watchlist.jsx table (Symbol / TBand / UT / ST / Last / %Chg / E%Chg).

CONFIRMED AGAINST YOUR REAL band_scanner.py:
- ut_bot() there is byte-for-byte the same trailing-stop/pos logic this file
  already used for the standalone UT Bot computation (RMA-ATR via
  tr.ewm(alpha=1/atr_period, adjust=False), same trail/pos state machine).
  No functional change needed.
- SuperTrend does not exist anywhere in band_scanner.py -- it really is new,
  there's no production reference to validate against.

CONFIRMED AGAINST YOUR REAL band_scan.py:
- band_scan.py hardcodes the true full universe as WATCHLIST_US (309) +
  WATCHLIST_HK (91) = 400, matching band.json's counts.universe exactly.
  This resolves the earlier ambiguity: this script now loads those two lists
  directly from band_scan.py (via ast, so it stays in sync if you edit them)
  and uses them to tell "in-universe but flat today" apart from "outside
  band's tracked universe entirely" -- previously both collapsed to the same
  tband=None.

Run:
    python merge_watchlist.py --watchlist Watchlists.txt --band band.json \
        --band-scan band_scan.py \
        --indicators indicator_signals.json --quotes watchlist_quotes.json \
        --out watchlist_merged.json
"""

import ast
import json
import argparse
from datetime import datetime, timezone
from pathlib import Path

from indicator_scan import parse_watchlist

BAND_STATUS_MAP = {
    "confirmed": "confirmed",
    "forming": "forming",
    "candidates": "candidate",
    "exits": "exit",
    "observe": "watch",
}


def load_full_universe(band_scan_path: Path):
    """Extracts WATCHLIST_US / WATCHLIST_HK list literals straight from
    band_scan.py's source via ast, so this stays in sync with whatever you
    actually deploy rather than a copy that can silently drift out of date."""
    if not band_scan_path.exists():
        return set()
    tree = ast.parse(band_scan_path.read_text(encoding="utf-8"))
    universe = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if getattr(t, "id", None) in ("WATCHLIST_US", "WATCHLIST_HK"):
                    universe.update(ast.literal_eval(node.value))
    return universe



def load_band_status(band_json: dict):
    """ticker -> {status, ut_pos, ...raw fields} using band.json's own 'symbol'
    field as the key (already in yfinance-compatible form: bare US ticker or
    zero-padded '.HK')."""
    out = {}
    for band_key, status in BAND_STATUS_MAP.items():
        for item in band_json.get(band_key, []):
            sym = item.get("symbol")
            if not sym:
                continue
            out[sym] = {"status": status, **item}
    return out


def run(watchlist_path: Path, band_path: Path, band_scan_path: Path,
        indicators_path: Path, quotes_path: Path, out_path: Path):
    entries = parse_watchlist(watchlist_path)

    band_json = json.loads(band_path.read_text(encoding="utf-8")) if band_path.exists() else {}
    band_status = load_band_status(band_json)
    full_universe = load_full_universe(band_scan_path)

    indicators = {}
    if indicators_path.exists():
        indicators = json.loads(indicators_path.read_text(encoding="utf-8")).get("signals", {})

    quotes = {}
    if quotes_path.exists():
        quotes = json.loads(quotes_path.read_text(encoding="utf-8")).get("quotes", {})

    merged = []
    for e in entries:
        ticker = e["ticker"]
        if not ticker:
            continue

        b = band_status.get(ticker)
        ind = indicators.get(ticker, {})
        q = quotes.get(ticker, {})

        if b and b.get("ut_pos") is not None:
            ut = "long" if b["ut_pos"] == 1 else "short"
        else:
            ut = ind.get("ut_bot")

        if b:
            tband = b["status"]
        elif ticker in full_universe:
            tband = "flat"  # in band's tracked universe, no active signal today
        else:
            tband = None  # outside band's tracked universe entirely

        merged.append({
            "ticker": ticker,
            "symbol": e["symbol"],
            "exchange": e["exchange"],
            "section": e["section"],
            "tband": tband,
            "ut": ut,
            "st": ind.get("supertrend"),
            "last": q.get("last"),
            "chg_pct": q.get("chg_pct"),
            "ext_chg_pct": q.get("ext_chg_pct"),
            "market_state": q.get("market_state"),
        })

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "band_scanned_at": band_json.get("scanned_at"),
        "band_bar_date": band_json.get("bar_date"),
        "count": len(merged),
        "rows": merged,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(merged)} merged rows -> {out_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", default="Watchlists.txt", type=Path)
    ap.add_argument("--band", default="band.json", type=Path)
    ap.add_argument("--band-scan", default="band_scan.py", type=Path)
    ap.add_argument("--indicators", default="indicator_signals.json", type=Path)
    ap.add_argument("--quotes", default="watchlist_quotes.json", type=Path)
    ap.add_argument("--out", default="watchlist_merged.json", type=Path)
    args = ap.parse_args()
    run(args.watchlist, args.band, args.band_scan, args.indicators, args.quotes, args.out)
