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
import math
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
    "RKLB","ASTS","LUNR","SPCE","UGL","AGQ","ACHR","LMT",
    "SOUN","APP","DUOL","BBAI","GEV","BE","VST","PEG","OKLO","SMR",
    "KTOS","AVAV","JOBY","QS","PLUG","RIVN","NIO","XPEV","BABA","AXTI","PDD",
    "FUTU","NET","TQQQ","SQQQ","WDC","GLD","NEM","F","T","LUMN","NOK","RCAT","NNE","UMAC","CIEN","PCG",
    "AAL","NKE","MSTR","IBIT","PFE","VKTX","TEM","DRNZ","ZETA","SPCX","SKHY","TER","SYM","HIMS",
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

OUT_PATH = os.environ.get("BAND_OUT", "frontend/public/band.json")
LOG_PATH = os.environ.get("BAND_FORMING_LOG", "frontend/public/band_forming_log.json")
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


def resolve_forming_log(payload):
    """
    回填「形成中 → 確認」轉化率。

    形成中訊號嘅 live bar 就係 bar_date 當日 —— 而今次 full scan 嘅
    bar_date 正正就係佢。所以呢一刻可以判定：當日記錄過嘅每隻，
    究竟有冇入到 confirmed。

    輸出 summary 畀前端顯示。呢個數字決定咗盤中「守住」有幾可信 ——
    高就可以當預告，低就只可以當參考。
    """
    if not os.path.exists(LOG_PATH):
        return
    try:
        log = json.load(open(LOG_PATH))
    except Exception:
        return
    day = payload.get("bar_date")
    rec = (log.get("days") or {}).get(day)
    if rec:
        got = {r["symbol"] for r in payload["confirmed"]}
        for sym, v in rec["symbols"].items():
            v["confirmed"] = sym in got

    # 只計「最後一次見到係守住」嗰啲 —— 中途已經作廢嘅唔應該計入分母，
    # 因為你根本唔會當佢係候選。
    tot = hit = 0
    for d, r in (log.get("days") or {}).items():
        for sym, v in r["symbols"].items():
            if v.get("confirmed") is None or v.get("status") != "hold":
                continue
            tot += 1
            hit += bool(v["confirmed"])
    log["summary"] = {
        "days": len(log.get("days") or {}),
        "hold_resolved": tot,
        "hold_confirmed": hit,
        "rate": round(hit / tot * 100, 1) if tot else None,
    }
    try:
        with open(LOG_PATH, "w") as f:
            json.dump(log, f, indent=2)
        if tot:
            print(f"形成中→確認 轉化率: {hit}/{tot} = {log['summary']['rate']}% "
                  f"（累積 {log['summary']['days']} 日）")
        else:
            print("形成中→確認 轉化率: 樣本未夠，繼續累積")
    except Exception as e:
        print(f"  forming log 回填失敗: {e}")


# ── JSON sanitization ───────────────────────────────────────────────────
# 2026-08-12：三隻港股（1299/0857/0883）最後一支棒 close 攞唔到，
# price/stop_dist_pct/ru60 計出 NaN。Python json.dump 預設 allow_nan=True
# 照寫，Python 讀返冇事，但瀏覽器 JSON.parse 對裸 NaN 會直接拋
#   "The string did not match the expected pattern."
# 前端 catch 咗呢個 exception 之後一律當「未行過 band_scan.py」，
# 完全掩蓋咗真正原因。呢度轉做 null（合法 JSON，前端 ?? 處理得到），
# 並且 allow_nan=False：萬一未來有新欄位漏咗清理，喺 CI 度直接見到，
# 好過出個壞檔案畀前端。
def clean_nan(o):
    """遞迴把 NaN / ±Infinity 轉做 None。"""
    if isinstance(o, dict):
        return {k: clean_nan(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean_nan(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def find_nan(o, path=""):
    """報邊個欄位有 NaN，寫落 log 方便追蹤邊隻股出事。"""
    hits = []
    if isinstance(o, dict):
        for k, v in o.items():
            hits.extend(find_nan(v, f"{path}.{k}" if path else k))
    elif isinstance(o, (list, tuple)):
        for i, v in enumerate(o):
            hits.extend(find_nan(v, f"{path}[{i}]"))
    elif isinstance(o, float) and not math.isfinite(o):
        hits.append(path)
    return hits


def main():
    t0 = time.time()
    print(f"Triple Band scan · {len(WATCHLIST_US)} US + {len(WATCHLIST_HK)} HK")

    payload = compute_band_radar(WATCHLIST_US, WATCHLIST_HK, fetch_df,
                                 earnings_veto=load_earnings_veto())

    bad = find_nan(payload)
    if bad:
        print(f"⚠ {len(bad)} 個 NaN/Inf 欄位 → 轉 null（唔會累計佢地嘅原始股票代號,只印路徑）:")
        for b in bad[:20]:
            print("   ", b)
        if len(bad) > 20:
            print(f"    …仲有 {len(bad) - 20} 個")
        payload = clean_nan(payload)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False, allow_nan=False)

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

    resolve_forming_log(payload)


if __name__ == "__main__":
    main()
