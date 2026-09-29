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
import re
import sys
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


def load_parents(path):
    """watchlist_parents.txt -> {child_symbol: parent_symbol}. 每行 "子 母"，
    逗號/空格/tab 都得，# 後面係註解。冇檔案就當冇從屬關係。"""
    out = {}
    if path is None or not Path(path).exists():
        return out
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = [x for x in re.split(r"[,\s]+", line) if x]
        if len(parts) >= 2:
            out[parts[0].upper()] = parts[1].upper()
    return out


def suggest_unmapped(entries, parents):
    """只係提示，唔會自動猜：同一 section 入面，緊接住某隻股後面、
    ticker 頭 3 個字母一樣、但未登記喺 watchlist_parents.txt 嘅組合。"""
    hints = []
    prev = None
    for e in entries:
        if not e["ticker"]:
            continue
        sym = e["symbol"].upper()
        if (prev and prev["section"] == e["section"] and sym not in parents
                and not sym.isdigit() and len(sym) >= 3
                and sym[:3] == prev["symbol"].upper()[:3] and sym != prev["symbol"].upper()):
            hints.append(f'{sym} → {prev["symbol"].upper()}?')
        prev = e
    if hints:
        print("ℹ 可能係從屬但未登記 watchlist_parents.txt: " + ", ".join(hints), file=sys.stderr)


def run(watchlist_path: Path, band_path: Path, band_scan_path: Path,
        indicators_path: Path, quotes_path: Path, margin_path: Path, out_path: Path,
        parents_path=None):
    entries = parse_watchlist(watchlist_path)
    parents = load_parents(parents_path)
    present = {e["symbol"].upper() for e in entries if e["ticker"]}
    # 母股唔喺 watchlist 入面就冇得縮排（冇嘢可以「從屬」）
    parents = {c: p for c, p in parents.items() if c in present and p in present}
    suggest_unmapped(entries, parents)

    band_json = json.loads(band_path.read_text(encoding="utf-8")) if band_path.exists() else {}
    band_status = load_band_status(band_json)
    full_universe = load_full_universe(band_scan_path)

    indicators = {}
    if indicators_path.exists():
        indicators = json.loads(indicators_path.read_text(encoding="utf-8")).get("signals", {})

    quotes = {}
    if quotes_path.exists():
        quotes = json.loads(quotes_path.read_text(encoding="utf-8")).get("quotes", {})

    # margin_cache.json (from margin_import.py) is keyed exactly like our own
    # ticker convention already -- bare US ticker / zero-padded "0700.HK" --
    # so this is a direct dict lookup, no normalisation needed here.
    # margin.txt's own header warns that stale margin rates are more
    # dangerous than none (a stock that just got hit can have its margin
    # eligibility cut with no notice) -- same MARGIN_MAX_AGE=30 day cutoff
    # your other systems use, so a forgotten update doesn't silently show
    # numbers you can no longer trust.
    margin = {}
    if margin_path.exists():
        margin_json = json.loads(margin_path.read_text(encoding="utf-8"))
        as_of = margin_json.get("as_of")
        stale = False
        if as_of:
            try:
                age_days = (datetime.now(timezone.utc).date() - datetime.fromisoformat(as_of).date()).days
                stale = age_days > 30
            except ValueError:
                stale = True  # unparseable as_of -- treat as untrustworthy, same as stale
        if stale:
            print(f"⚠ margin_cache.json as_of={as_of} 超過30日或讀唔到，全部隱藏", file=sys.stderr)
        else:
            margin = margin_json.get("data", {})

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
        # UT streak length always comes from indicator_scan.py's own count --
        # band.json has no equivalent "days in this UT direction" field.
        # Assumes indicator_scan's direction agrees with band.json's ut_pos
        # when both exist (validated true for the overlap you checked
        # earlier); if they ever disagree for a symbol, this days count
        # would describe indicator_scan's own streak, not necessarily one
        # that matches the ut value actually shown.
        ut_days = ind.get("ut_days")

        if b:
            tband = b["status"]
        elif ticker in full_universe:
            tband = "flat"  # in band's tracked universe, no active signal today
        else:
            tband = None  # outside band's tracked universe entirely
        # "bars" only exists on candidates/exits in band.json (days since
        # entry_date) -- None for every other status, including flat/forming.
        tband_days = b.get("bars") if b else None

        merged.append({
            "ticker": ticker,
            "symbol": e["symbol"],
            "exchange": e["exchange"],
            "section": e["section"],
            "tband": tband,
            "tband_days": tband_days,
            "ut": ut,
            "ut_days": ut_days,
            "st": ind.get("supertrend"),
            "last": q.get("last"),
            "chg_pct": q.get("chg_pct"),
            "ext_chg_pct": q.get("ext_chg_pct"),
            "market_state": q.get("market_state"),
            "parent": parents.get(e["symbol"].upper()),  # 母股symbol，前端用嚟縮排
            "margin": margin.get(ticker),  # None if not in margin.txt -- "唔顯示" per margin.txt's own convention
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
    ap.add_argument("--margin", default="margin_cache.json", type=Path)
    ap.add_argument("--parents", default="watchlist_parents.txt", type=Path)
    ap.add_argument("--out", default="watchlist_merged.json", type=Path)
    args = ap.parse_args()
    run(args.watchlist, args.band, args.band_scan, args.indicators, args.quotes, args.margin, args.out,
        parents_path=args.parents)
