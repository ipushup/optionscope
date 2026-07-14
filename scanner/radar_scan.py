#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
radar_scan.py — OptionScope Turnaround Radar scanner
=====================================================
Runs once after market close. Computes the full radar pipeline and writes
frontend/public/radar.json for the React app.

Repo layout (same pattern as run_scan.py):
    scanner/radar_scan.py       ← this file
    scanner/turnaround_radar.py ← the module (unchanged, shared with daily_brief)
    frontend/public/radar.json  ← output

Standalone: does NOT import daily_brief. It provides its own fetch_df /
get_closed_df with identical semantics (closed-candle only).
"""
import json, os, sys, time
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from turnaround_radar import compute_turnaround_radar, SCEN_META, MAX_CARDS  # noqa: E402

# ── WATCHLISTS ────────────────────────────────────────────────────────────
# Keep in sync with daily_brief.py. Trim/extend freely.
WATCHLIST_US = [
    "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","AMD","NFLX",
    "CRM","ORCL","ADBE","NOW","PANW","CRWD","ZS","SNOW","DDOG","MDB",
    "PLTR","APP","ANET","MU","INTC","QCOM","TXN","AMAT","LRCX","KLAC",
    "HOOD","COIN","PYPL","SOFI","V","MA","JPM","GS","MS","BAC",
    "UNH","LLY","ABBV","JNJ","MRK","PFE","TMO","ISRG","VRTX","REGN",
    "XOM","CVX","COP","SLB","OXY","CAT","DE","HON","GE","BA",
    "WMT","COST","HD","NKE","SBUX","MCD","KO","PEP","PG","CL",
    "UBER","ABNB","DASH","RBLX","SHOP","SQ","SPOT","TTD","NET","CRWV",
    "VKTX","HIMS","TEM","ZETA","ELV","PGR","TRV","ADP","IBM","MPC",
    "GEV","VRT","EQIX","OKLO","SMR","NNE","AVAV","KTOS","RCAT","IONQ",
]
WATCHLIST_HK = [
    "0001.HK","0002.HK","0003.HK","0005.HK","0011.HK","0016.HK","0027.HK","0066.HK",
    "0175.HK","0241.HK","0267.HK","0288.HK","0300.HK","0386.HK","0388.HK","0669.HK",
    "0700.HK","0762.HK","0823.HK","0857.HK","0883.HK","0939.HK","0941.HK","0960.HK",
    "0968.HK","0981.HK","0992.HK","1024.HK","1038.HK","1044.HK","1093.HK","1099.HK",
    "1109.HK","1177.HK","1211.HK","1299.HK","1398.HK","1810.HK","1876.HK","1928.HK",
    "1929.HK","2007.HK","2015.HK","2020.HK","2057.HK","2269.HK","2313.HK","2318.HK",
    "2319.HK","2331.HK","2382.HK","2388.HK","2628.HK","3690.HK","3692.HK","3968.HK",
    "3988.HK","6160.HK","6618.HK","6690.HK","6862.HK","9618.HK","9633.HK","9888.HK",
    "9961.HK","9988.HK","9999.HK","1651.HK","2268.HK","6887.HK","9606.HK","9926.HK",
]

OUT_PATH = os.environ.get("RADAR_OUT", "frontend/public/radar.json")

# ── DATA LAYER (mirrors daily_brief semantics) ────────────────────────────
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
                _cache[key] = df
                return df
        except Exception as e:
            if attempt == retries:
                print(f"  fetch fail {ticker} {interval}: {e}")
            time.sleep(1)
    _cache[key] = pd.DataFrame()
    return _cache[key]


def get_closed_df(df, interval="1d"):
    """Drop the still-forming bar. Identical rule to daily_brief v21."""
    if df is None or df.empty:
        return df
    now = pd.Timestamp.now(tz="UTC")
    last = df.index[-1]
    if last.tzinfo is None:
        last = last.tz_localize("UTC")
    if interval == "1d":
        # today's bar is not closed until the session ends; drop if same UTC date
        if last.date() == now.date():
            return df.iloc[:-1]
        return df
    if interval == "1wk":
        # weekly bar closes Friday; drop the in-progress week (Mon-Fri of current week)
        week_start = (now - pd.Timedelta(days=now.weekday())).normalize()
        if last >= week_start and now.weekday() < 5:
            return df.iloc[:-1]
        return df
    return df


# ── JSON SERIALISATION ────────────────────────────────────────────────────
def card_to_json(cd):
    """Flatten one radar card into a JSON-safe dict for the React app.
    Includes the reference levels the frontend needs to recompute distances live."""
    return {
        "ticker":   cd["ticker"],
        "market":   cd["market"],
        "scen":     cd["scen"],
        "scen_name": cd["meta"]["name"],
        "scen_en":  cd["meta"]["en"],
        "position": cd["meta"]["pos"],
        "buy_logic": cd["meta"]["buy"],
        "close":    round(cd["price"], 4),          # closing price radar was computed on
        "gate_n":   cd["gate_n"],
        "score":    cd["score"],
        "max_score": cd["max_score"],
        "warn_n":   cd["warn_n"],
        "concl":    cd["concl"],
        "concl_cls": cd["concl_cls"],
        "stop":     round(cd["stop"], 4),
        "stop_label": cd["meta"]["stop_lbl"],
        "rs_now":   round(cd["rs_now"], 2),
        "rs_slope": round(cd["rs_slope"], 3),
        "w_stack":  bool(cd["w_stack"]),
        # live-monitor reference levels (frontend recomputes % vs live price)
        "levels":   cd["levels"],
        # condition blocks: [name, ok, detail]
        "scen_rows": [[a, bool(b), c] for a, b, c in cd["scen_rows"]],
        "gates":     [[a, bool(b), c] for a, b, c in cd["gates"]],
        "scores":    [[a, int(p), int(m), v] for a, p, m, v in cd["scores"]],
        "vetoes":    [[a, b, c] for a, b, c in cd["vetoes"]],
    }


def main():
    t0 = time.time()
    print(f"Turnaround Radar scan · {len(WATCHLIST_US)} US + {len(WATCHLIST_HK)} HK")

    cards, meta = compute_turnaround_radar(
        WATCHLIST_US, WATCHLIST_HK, fetch_df, get_closed_df)

    payload = {
        "scanned_at":  datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "universe":    meta["universe"],
        "scen_counts": meta["scen_counts"],
        "truncated":   meta["truncated"],
        "total_cards": len(cards),
        "max_cards":   MAX_CARDS,
        "scen_meta":   {k: {"name": v["name"], "en": v["en"], "pos": v["pos"],
                            "stop_lbl": v["stop_lbl"]} for k, v in SCEN_META.items()},
        "cards":       [card_to_json(c) for c in cards],
        "tickers":     [c["ticker"] for c in cards],   # for radar_quotes.py
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    sc = meta["scen_counts"]
    print(f"\nS1:{sc['S1']} S2:{sc['S2']} S3:{sc['S3']} → {len(cards)} cards "
          f"({time.time()-t0:.0f}s) → {OUT_PATH}")
    for c in cards[:10]:
        print(f"  {c['ticker']:<10} {c['scen']} GATE {c['gate_n']}/4 "
              f"SCORE {c['score']}/14  {c['concl']}")


if __name__ == "__main__":
    main()
