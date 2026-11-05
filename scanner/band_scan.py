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
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from band_scanner import compute_band_radar  # noqa: E402

# ── WATCHLIST ─────────────────────────────────────────────────────────────
# 策略只做美股（港股 big-filter 之下 PF 只有 1.52）。港股照掃，入觀察組。
# 同 daily_brief.py 保持同步。
WATCHLIST_US = [
    "AAL", "AAOI", "AAOX", "AAPL", "AB", "ABBV", "ABEV", "ABT",
    "ACHR", "ACMR", "ACN", "ACQ", "ADBE", "ADI", "ADP", "ADSK",
    "AEVA", "AFL", "AGQ", "AIG", "ALAB", "ALGM", "AMAT", "AMD",
    "AMGN", "AMT", "AMZN", "ANET", "AON", "APH", "APLD", "APLX",
    "APO", "APP", "ARM", "ARMG", "ASML", "ASTS", "ASTX", "ATI",
    "AUR", "AVAV", "AVGO", "AXTI", "AXTX", "AZO", "BABA", "BAC",
    "BBAI", "BDX", "BE", "BEX", "BHP", "BKNG", "BLK", "BLSH",
    "BMNR", "BMY", "BRK-B", "BRW", "BSX", "BTG", "BUG", "BULL",
    "BWXT", "BX", "C", "CARR", "CAT", "CB", "CBRG", "CBRS",
    "CCJ", "CDE", "CDNS", "CEG", "CEGX", "CHYM", "CI", "CIEN",
    "CMCSA", "CNC", "CNH", "COF", "COHR", "COIN", "CORZ", "COST",
    "CRCG", "CRCL", "CRDO", "CRM", "CRML", "CRS", "CRWD", "CRWG",
    "CRWV", "CSCO", "CSGP", "CVX", "DASH", "DE", "DELL", "DHR",
    "DIS", "DLLL", "DPRO", "DRAM", "DRNZ", "DUK", "DUOL", "DXYZ",
    "ECHO", "ELV", "EMR", "EOG", "EOSE", "EQIX", "ERO", "F",
    "FCEL", "FCX", "FDX", "FIGR", "FLNC", "FLUC", "FLY", "FTNT",
    "FUTU", "GD", "GE", "GEV", "GILD", "GLD", "GLND", "GLW",
    "GLXY", "GM", "GOOG", "GOOGL", "GPRO", "GRAB", "GRML", "GS",
    "GSAT", "HD", "HIMS", "HON", "HOOD", "HOOG", "HPE", "HPQ",
    "HSBC", "IBIT", "IBM", "ICE", "IE", "ILMN", "INFQ", "INOD",
    "INTC", "INTU", "INTW", "IONQ", "IONX", "IRE", "IREN", "ISRG",
    "ITW", "JCI", "JEPI", "JEPQ", "JNJ", "JOBY", "JPM", "KLAC",
    "KO", "KTOS", "LAC", "LEU", "LI", "LIN", "LITE", "LLY",
    "LMT", "LOW", "LRCX", "LTBR", "LUMN", "LUNR", "MA", "MARA",
    "MCO", "MDLZ", "MDT", "META", "MMC", "MMM", "MO", "MOLY",
    "MP", "MPC", "MRNA", "MRVL", "MS", "MSFT", "MSTR", "MTRN",
    "MU", "MULL", "MUU", "NBIL", "NBIS", "NEE", "NEM", "NET",
    "NFLX", "NIO", "NKE", "NNE", "NOC", "NOK", "NOW", "NU",
    "NVDA", "NVDL", "NVDY", "NVO", "NVT", "NVTS", "NXE", "OKLL",
    "OKLO", "OKTA", "ONDS", "OPEN", "ORCL", "ORCU", "OSCR", "OXY",
    "PACB", "PANW", "PATH", "PCG", "PDD", "PEG", "PEP", "PFE",
    "PG", "PGR", "PH", "PL", "PLTR", "PLUG", "PNC", "POET",
    "PSA", "PTIR", "PURR", "PYPL", "QBTS", "QBTX", "QCOM", "QNT",
    "QS", "QTEX", "QUBT", "RBLX", "RBRK", "RCAT", "RDW", "REGN",
    "REMX", "RGTI", "RGTX", "RIG", "RIVN", "RKLB", "RKLX", "ROIV",
    "ROP", "RR", "RTX", "S", "SBET", "SBUX", "SCCO", "SCHD",
    "SCHW", "SERV", "SHW", "SIDU", "SKHX", "SKHY", "SLB", "SLV",
    "SMCI", "SMCX", "SMR", "SMTC", "SNAP", "SNDK", "SNOW", "SNPS",
    "SNXX", "SO", "SOFI", "SOUN", "SOXQ", "SPCE", "SPCH", "SPCX",
    "SPGI", "SPOT", "SQQQ", "SSPC", "STNE", "STX", "SYK", "SYM",
    "T", "TDG", "TEM", "TER", "TFC", "TJX", "TMDX", "TMO",
    "TMQ", "TQQQ", "TRV", "TSLA", "TSM", "TTD", "TTDU", "TWST",
    "TXN", "UAMY", "UBER", "UEC", "UFO", "UGL", "UMAC", "UNH",
    "UPS", "URA", "URG", "URNM", "USAR", "UUUU", "V", "VEEV",
    "VKTX", "VLO", "VRT", "VRTL", "VST", "VSTL", "VZ", "WBD",
    "WDC", "WDCX", "WELL", "WFC", "WM", "WMT", "XE", "XNDU",
    "XOM", "XPEV", "ZETA", "ZS", "ZTS"
]

# WATCHLIST_HK — 全 HKEX watchlist（587 隻，同 Watchlists.txt 嘅 21-HONGKONG 一致）。
#   下面註解係早期 91 隻版本嘅來源紀錄：72 原有 + 19 由 TradingView watchlist 補上
# 新增（19）：0354 中國軟件國際 / 0568 山東墨龍 / 0728 中國電信 / 0902 華能國際
#            1072 東方電氣 / 1088 中國神華 / 1171 兗礦能源 / 1347 華虹半導體
#            1357 美圖 / 1378 中國宏橋 / 1888 建滔積層板 / 2018 瑞聲科技
#            2208 金風科技 / 2333 長城汽車 / 2727 上海電氣 / 2888 渣打集團
#            3896 金山雲 / 6865 福萊特玻璃 / 9660 地平線機器人
# 略過：HSI（指數，唔係可買賣股票）
# TV 檔案 42 隻入面有 23 隻本身已經喺 list 度

WATCHLIST_HK = [
    "0700.HK", "1398.HK", "1288.HK", "0939.HK", "0005.HK", "0857.HK", "3988.HK", "9988.HK",
    "0941.HK", "3750.HK", "3968.HK", "0883.HK", "1088.HK", "3308.HK", "2628.HK", "2318.HK",
    "2899.HK", "3328.HK", "1211.HK", "0386.HK", "0300.HK", "1299.HK", "0981.HK", "0728.HK",
    "1810.HK", "9999.HK", "2359.HK", "0998.HK", "1658.HK", "2388.HK", "2888.HK", "0388.HK",
    "9633.HK", "6030.HK", "2475.HK", "3690.HK", "0992.HK", "3993.HK", "1339.HK", "0267.HK",
    "2259.HK", "1276.HK", "2328.HK", "2601.HK", "2611.HK", "6160.HK", "2513.HK", "0016.HK",
    "1919.HK", "3986.HK", "6951.HK", "6809.HK", "6869.HK", "9618.HK", "0001.HK", "2338.HK",
    "2714.HK", "1347.HK", "1816.HK", "0669.HK", "2378.HK", "2269.HK", "3288.HK", "1109.HK",
    "9888.HK", "6690.HK", "1378.HK", "6818.HK", "9992.HK", "1766.HK", "2020.HK", "3692.HK",
    "1898.HK", "0066.HK", "9961.HK", "0002.HK", "2476.HK", "6066.HK", "1171.HK", "1336.HK",
    "6613.HK", "6886.HK", "1988.HK", "0762.HK", "2600.HK", "6031.HK", "6936.HK", "1776.HK",
    "6099.HK", "1801.HK", "0788.HK", "0175.HK", "1888.HK", "1113.HK", "1038.HK", "0763.HK",
    "3606.HK", "2423.HK", "0625.HK", "0688.HK", "0358.HK", "3908.HK", "9973.HK", "1972.HK",
    "1138.HK", "1308.HK", "0027.HK", "0003.HK", "1787.HK", "9976.HK", "0012.HK", "0006.HK",
    "1024.HK", "6881.HK", "0902.HK", "1377.HK", "0087.HK", "0019.HK", "1880.HK", "0390.HK",
    "2057.HK", "2333.HK", "3200.HK", "6618.HK", "9987.HK", "0753.HK", "3296.HK", "1208.HK",
    "1093.HK", "6990.HK", "1929.HK", "0916.HK", "2268.HK", "1072.HK", "0836.HK", "2727.HK",
    "0914.HK", "1179.HK", "1800.HK", "1177.HK", "0823.HK", "9926.HK", "2050.HK", "0083.HK",
    "0316.HK", "3808.HK", "1913.HK", "0991.HK", "9927.HK", "1548.HK", "1997.HK", "1698.HK",
    "6823.HK", "9980.HK", "1928.HK", "1055.HK", "1772.HK", "2015.HK", "2016.HK", "3618.HK",
    "0293.HK", "3759.HK", "1209.HK", "1519.HK", "0288.HK", "2099.HK", "6693.HK", "3958.HK",
    "1768.HK", "0670.HK", "9696.HK", "1876.HK", "6821.HK", "6082.HK", "2208.HK", "2249.HK",
    "0100.HK", "0177.HK", "0144.HK", "9903.HK", "9868.HK", "6198.HK", "0470.HK", "0668.HK",
    "2196.HK", "0522.HK", "0322.HK", "2319.HK", "0966.HK", "0168.HK", "1071.HK", "2618.HK",
    "3223.HK", "1989.HK", "2382.HK", "3698.HK", "0148.HK", "2097.HK", "0135.HK", "2607.HK",
    "9866.HK", "9901.HK", "9660.HK", "6166.HK", "0291.HK", "9995.HK", "1818.HK", "1258.HK",
    "1157.HK", "2883.HK", "3898.HK", "6969.HK", "0270.HK", "0004.HK", "6181.HK", "9630.HK",
    "6656.HK", "3939.HK", "2688.HK", "1364.HK", "2638.HK", "3969.HK", "2723.HK", "2238.HK",
    "2202.HK", "3396.HK", "2313.HK", "2631.HK", "6862.HK", "0285.HK", "6228.HK", "3998.HK",
    "3661.HK", "0598.HK", "3347.HK", "2799.HK", "9626.HK", "9863.HK", "0020.HK", "6655.HK",
    "2588.HK", "0023.HK", "9698.HK", "1099.HK", "3311.HK", "0241.HK", "2039.HK", "2018.HK",
    "1070.HK", "1735.HK", "1688.HK", "6127.HK", "3668.HK", "1828.HK", "1385.HK", "6963.HK",
    "0659.HK", "0008.HK", "0921.HK", "1530.HK", "1193.HK", "0392.HK", "0656.HK", "0317.HK",
    "0960.HK", "0576.HK", "0868.HK", "0699.HK", "0874.HK", "9880.HK", "6680.HK", "2282.HK",
    "2676.HK", "1729.HK", "1877.HK", "2577.HK", "2380.HK", "0101.HK", "3888.HK", "1359.HK",
    "6880.HK", "6088.HK", "1318.HK", "0151.HK", "0220.HK", "2331.HK", "1908.HK", "0995.HK",
    "2315.HK", "2228.HK", "2788.HK", "2245.HK", "1133.HK", "9856.HK", "3360.HK", "3277.HK",
    "0384.HK", "3696.HK", "2096.HK", "0257.HK", "3931.HK", "1882.HK", "0552.HK", "2696.HK",
    "1788.HK", "2768.HK", "3320.HK", "1797.HK", "2715.HK", "6979.HK", "2648.HK", "1513.HK",
    "0425.HK", "1128.HK", "2526.HK", "0631.HK", "0696.HK", "1585.HK", "0867.HK", "1440.HK",
    "3330.HK", "0683.HK", "1199.HK", "0268.HK", "0136.HK", "2689.HK", "2357.HK", "6186.HK",
    "2367.HK", "3800.HK", "1879.HK", "2225.HK", "6887.HK", "3317.HK", "3323.HK", "0780.HK",
    "2386.HK", "2602.HK", "6865.HK", "1044.HK", "2510.HK", "2672.HK", "1081.HK", "6651.HK",
    "9688.HK", "9896.HK", "2218.HK", "3896.HK", "2162.HK", "0622.HK", "0811.HK", "3774.HK",
    "1304.HK", "1196.HK", "2922.HK", "0551.HK", "0142.HK", "2026.HK", "0772.HK", "3858.HK",
    "2525.HK", "0666.HK", "2343.HK", "9900.HK", "2356.HK", "1415.HK", "1860.HK", "2687.HK",
    "0013.HK", "9969.HK", "7666.HK", "6185.HK", "2400.HK", "0817.HK", "1651.HK", "0189.HK",
    "1910.HK", "2276.HK", "9858.HK", "6098.HK", "0968.HK", "9606.HK", "1396.HK", "0512.HK",
    "9899.HK", "0325.HK", "1357.HK", "2590.HK", "6055.HK", "3900.HK", "2698.HK", "1277.HK",
    "2442.HK", "6810.HK", "2285.HK", "0014.HK", "9985.HK", "6060.HK", "1164.HK", "0326.HK",
    "1392.HK", "0371.HK", "0179.HK", "0038.HK", "3877.HK", "6049.HK", "3899.HK", "3933.HK",
    "1066.HK", "2706.HK", "6699.HK", "1626.HK", "6658.HK", "1579.HK", "0440.HK", "0639.HK",
    "6682.HK", "1866.HK", "1783.HK", "0586.HK", "0290.HK", "0017.HK", "0123.HK", "3339.HK",
    "1286.HK", "0600.HK", "0303.HK", "1060.HK", "2556.HK", "1833.HK", "1112.HK", "0590.HK",
    "1686.HK", "6727.HK", "0340.HK", "9911.HK", "3393.HK", "0152.HK", "9636.HK", "0901.HK",
    "6666.HK", "0805.HK", "3388.HK", "0856.HK", "1681.HK", "1918.HK", "0800.HK", "0068.HK",
    "6616.HK", "0467.HK", "3918.HK", "3306.HK", "1316.HK", "0081.HK", "1428.HK", "0546.HK",
    "2595.HK", "2669.HK", "0999.HK", "0697.HK", "0336.HK", "2142.HK", "6855.HK", "1999.HK",
    "0165.HK", "1191.HK", "1030.HK", "0565.HK", "0537.HK", "1952.HK", "2726.HK", "0354.HK",
    "2233.HK", "0517.HK", "1566.HK", "2697.HK", "2546.HK", "2128.HK", "2362.HK", "1368.HK",
    "0863.HK", "6938.HK", "2889.HK", "2666.HK", "9887.HK", "0116.HK", "0778.HK", "1114.HK",
    "1236.HK", "2432.HK", "0297.HK", "0975.HK", "2419.HK", "2145.HK", "2585.HK", "2007.HK",
    "2603.HK", "2616.HK", "2005.HK", "2586.HK", "0826.HK", "1672.HK", "9699.HK", "6675.HK",
    "3738.HK", "2465.HK", "7688.HK", "2498.HK", "1384.HK", "2171.HK", "0376.HK", "0400.HK",
    "2157.HK", "2186.HK", "7489.HK", "2858.HK", "0460.HK", "6069.HK", "9637.HK", "1511.HK",
    "6106.HK", "2436.HK", "0570.HK", "0568.HK", "1951.HK", "3625.HK", "0881.HK", "0751.HK",
    "2533.HK", "1478.HK", "1302.HK", "2877.HK", "1300.HK", "2272.HK", "2402.HK", "9936.HK",
    "1333.HK", "2718.HK", "0119.HK", "9678.HK", "9959.HK", "2553.HK", "1021.HK", "2575.HK",
    "0895.HK", "0147.HK", "0819.HK", "9993.HK", "2915.HK", "2670.HK", "0178.HK", "1780.HK",
    "1609.HK", "6090.HK", "7630.HK", "3816.HK", "2635.HK", "2028.HK", "6915.HK", "2105.HK",
    "1873.HK", "2617.HK", "2342.HK", "2013.HK", "0199.HK", "2652.HK", "8299.HK", "1086.HK",
    "1815.HK", "2583.HK", "2650.HK", "1906.HK", "2685.HK", "1710.HK", "0917.HK", "2591.HK",
    "1645.HK", "1046.HK", "2656.HK", "1936.HK", "2477.HK", "2661.HK", "7226.HK", "1753.HK",
    "7552.HK", "6681.HK", "0813.HK",
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
                # Yahoo 有時收市後出一支 Close=NaN 嘅尾棒 → price/tier_gap 全變 null，
                # forming_live 變 0 但前端表仍然列出（?? 0）。先掉走 NaN 棒。
                df = df.dropna(subset=["Close"])
                if df.empty:
                    continue
                df = drop_forming(df, ticker)
                _cache[key] = df
                return df
        except Exception as e:
            if attempt == retries:
                print(f"  fetch fail {ticker}: {e}")
            time.sleep(1)
    _cache[key] = pd.DataFrame()
    return _cache[key]


def drop_forming(df, ticker, now=None):
    """
    掉走未收市嘅棒。比 radar_scan 嘅 get_closed_df 精確少少 ——
    後者見到「最後一支棒日期 == 今日 UTC 日期」就掉，即係 20:15 UTC
    跑嗰陣會連當日已經收咗市嘅美股棒都掉埋，白白蝕一日。
    呢度改成用收市時間判斷：美股 20:05 UTC 後、港股 08:10 UTC 後
    當日棒先算封。（夏令時差一個鐘，多留五分鐘緩衝已經夠。）
    """
    if df is None or df.empty:
        return df
    # 用交易所本地時間判斷，唔再寫死 UTC 時刻 —— 美股收市係 20:00 UTC（夏令）
    # 但 21:00 UTC（冬令，11 月第一個星期日起），寫死 20:05 UTC 嘅話冬令時
    # 會將未收市嘅當日棒當成已收市。
    tz = ZoneInfo("Asia/Hong_Kong") if ticker.endswith(".HK") else ZoneInfo("America/New_York")
    now = (now or datetime.now(timezone.utc)).astimezone(tz)
    last = df.index[-1]
    last_date = (last.tz_convert(tz) if last.tzinfo is not None else last).date()
    if last_date != now.date():
        return df
    close_h, close_m = (16, 10) if ticker.endswith(".HK") else (16, 5)
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
