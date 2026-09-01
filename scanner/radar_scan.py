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
    "AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","GOOG","BRK-B","JPM",
    "V","JNJ","WMT","PG","MA","UNH","HD","CVX","BAC","XOM","KO","PEP",
    "COST","TMO","ABBV","ADBE","CRM","NFLX","ORCL","CSCO","ACN","LIN",
    "DIS","ABT","WFC","VZ","CMCSA","NEE","DHR","LOW","UPS","RTX","TXN",
    "AMGN","IBM","QCOM","INTU","AMAT","CAT","NOW","SPGI","GS","BKNG",
    "MS","C","HON","UBER","ISRG","TJX","PLTR","BLK","ELV","MDT","SYK",
    "MMC","ADI","CB","MU","LRCX","PANW","ADP","SBUX","GILD","DE","BMY",
    "MDLZ","CI","SCHW","MO","GE","APO","REGN","MMM","EOG","ZTS","BSX",
    "DUK","BDX","ICE","SO","BX","ANET","KLAC","SHW","SNPS","MCO","CDNS",
    "APH","PH","ITW","AON","WELL","WM","PNC","TDG","EMR","GD","NOC",
    "CARR","TFC","PSA","FDX","JCI","ROP","AFL","PGR","COF","GM","MPC",
    "VLO","TRV","OXY","SLB","AZO","ADSK","DASH","WBD","PYPL","FTNT","LLY","AIG",
    "SMCI","AMD","ASML","MRVL","SNOW","CRWD","ZS","RBLX","SNAP","MARA","HOOD",
    "SOFI","COIN","CEG","CCJ","TSM","AVGO","INTC","ARM","LITE","COHR","AAOI",
    "POET","CRDO","ALAB","SMTC","NBIS","IREN","APLD","CRWV",
    "VRT","EQIX","AMT","IONQ","RGTI","QBTS","QUBT",
    "RKLB","ASTS","LUNR","SPCE","ACHR","UGL","AGQ","SPOT","LMT",
    "SOUN","APP","DUOL","BBAI","GEV","BE","VST","PEG","NNE","OKLO","SMR",
    "KTOS","AVAV","JOBY","QS","PLUG","RIVN","NIO","XPEV","BABA","PDD",
    "FUTU","NET","TQQQ","SQQQ","WDC","GLD","NEM","F","T","LUMN","NOK","RCAT","UMAC","CIEN","PCG",
    "AAL","NKE","MSTR","IBIT","PFE","VKTX","TEM","DRNZ","ZETA","SPCX","SKHY","TER","SYM","HIMS",
    "INTW","NVDL","GLW","AXTI",
    "CORZ","VRTL","IONX","RGTX","QBTX","INFQ","XNDU","QNT","GSAT","PL","RDW",
    "QTEX","INOD","BLSH","CRCL","GLXY","BMNR","SBET","NU","CHYM","FIGR",
    "NVT","CRS","MTRN","ATI","OKLL","XE","SERV","AEVA","DPRO","ONDS","FCEL","EOSE","FLUC",
    "REMX","MP","UUUU","USAR","CRML","UAMY","LAC","TMQ","IE","FCX","SCCO","ERO","NVO","CNC","OSCR","TMDX","VEEV","ILMN","PACB","OKTA","S","RBRK","BULL","GRAB","OPEN","LI",
    "CNH","PATH","ABEV","HSBC","PURR","ROIV","CDE","BTG","CSGP","STNE",
]
# WATCHLIST_HK — 72 原有 + 19 由 TradingView watchlist 補上 = 91
# 新增（19）：0354 中國軟件國際 / 0568 山東墨龍 / 0728 中國電信 / 0902 華能國際
#            1072 東方電氣 / 1088 中國神華 / 1171 兗礦能源 / 1347 華虹半導體
#            1357 美圖 / 1378 中國宏橋 / 1888 建滔積層板 / 2018 瑞聲科技
#            2208 金風科技 / 2333 長城汽車 / 2727 上海電氣 / 2888 渣打集團
#            3896 金山雲 / 6865 福萊特玻璃 / 9660 地平線機器人
# 略過：HSI（指數，唔係可買賣股票）
# TV 檔案 42 隻入面有 23 隻本身已經喺 list 度

WATCHLIST_HK = [
    "0001.HK", "0002.HK", "0003.HK", "0005.HK", "0011.HK", "0016.HK", "0027.HK", "0066.HK",
    "0175.HK", "0241.HK", "0267.HK", "0288.HK", "0300.HK", "0354.HK", "0386.HK", "0388.HK",
    "0568.HK", "0669.HK", "0700.HK", "0728.HK", "0762.HK", "0823.HK", "0857.HK", "0883.HK",
    "0902.HK", "0939.HK", "0941.HK", "0960.HK", "0968.HK", "0981.HK", "0992.HK", "1024.HK",
    "1038.HK", "1044.HK", "1072.HK", "1088.HK", "1093.HK", "1099.HK", "1109.HK", "1171.HK",
    "1177.HK", "1211.HK", "1299.HK", "1347.HK", "1357.HK", "1378.HK", "1398.HK", "1651.HK",
    "1810.HK", "1876.HK", "1888.HK", "1928.HK", "1929.HK", "2007.HK", "2015.HK", "2018.HK",
    "2020.HK", "2057.HK", "2208.HK", "2268.HK", "2269.HK", "2313.HK", "2318.HK", "2319.HK",
    "2331.HK", "2333.HK", "2382.HK", "2388.HK", "2628.HK", "2727.HK", "2888.HK", "3690.HK",
    "3692.HK", "3896.HK", "3968.HK", "3988.HK", "6160.HK", "6618.HK", "6690.HK", "6862.HK",
    "6865.HK", "6887.HK", "9606.HK", "9618.HK", "9633.HK", "9660.HK", "9888.HK", "9926.HK",
    "9961.HK", "9988.HK", "9999.HK",
]

OUT_PATH = os.environ.get("RADAR_OUT", "frontend/public/radar.json")
HISTORY_PATH = os.environ.get("RADAR_HISTORY", "frontend/public/radar_history.json")

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
        "downgraded": cd.get("downgraded"),
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

    # yesterday's breadth (for ↑/↓ deltas). Written each scan to HISTORY_PATH.
    prev_breadth = None
    if os.path.exists(HISTORY_PATH):
        try:
            hist = json.load(open(HISTORY_PATH))
            if hist.get("days"):
                prev_breadth = hist["days"][-1].get("breadth")
        except Exception:
            pass

    cards, meta = compute_turnaround_radar(
        WATCHLIST_US, WATCHLIST_HK, fetch_df, get_closed_df,
        prev_breadth=prev_breadth)

    payload = {
        "scanned_at":  datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "universe":    meta["universe"],
        "scen_counts": meta["scen_counts"],
        "truncated":   meta["truncated"],
        "total_cards": len(cards),
        "max_cards":   MAX_CARDS,
        "market":      meta["market"],          # regime + indices + breadth + VIX
        "scen_meta":   {k: {"name": v["name"], "en": v["en"], "pos": v["pos"],
                            "stop_lbl": v["stop_lbl"]} for k, v in SCEN_META.items()},
        "cards":       [card_to_json(c) for c in cards],
        "tickers":     [c["ticker"] for c in cards],   # for radar_quotes.py
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    # append today's breadth to rolling history (keep ~10 days)
    try:
        hist = {"days": []}
        if os.path.exists(HISTORY_PATH):
            hist = json.load(open(HISTORY_PATH))
        today = datetime.now(timezone.utc).date().isoformat()
        hist.setdefault("days", [])
        hist["days"] = [d for d in hist["days"] if d.get("date") != today]  # replace same-day
        hist["days"].append({"date": today, "breadth": meta["breadth_raw"]})
        hist["days"] = hist["days"][-10:]
        with open(HISTORY_PATH, "w") as f:
            json.dump(hist, f, indent=2)
    except Exception as e:
        print(f"  history write warn: {e}")

    sc = meta["scen_counts"]
    print(f"\nS1:{sc['S1']} S2:{sc['S2']} S3:{sc['S3']} → {len(cards)} cards "
          f"({time.time()-t0:.0f}s) → {OUT_PATH}")
    for c in cards[:10]:
        print(f"  {c['ticker']:<10} {c['scen']} GATE {c['gate_n']}/4 "
              f"SCORE {c['score']}/14  {c['concl']}")


if __name__ == "__main__":
    main()
