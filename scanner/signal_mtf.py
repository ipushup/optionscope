#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
signal_mtf.py — Signal Board「交通燈」矩陣數據：少量股票 × 6 個時間級別 × (TB / HV / UT)

每個格輸出「持倉狀態」（+1 買方向 / -1 賣方向 / 0 冇）：
  TB  最近一個 TB（唔計被 rU60 濾走嘅 TBskip）同最近一個 TS 邊個新：TB 新 = +1，TS 新 = -1
  HV  Heavy（同 Signal Board / Daily Table 同一套 heavy_now）最近出現嘅係 HB = +1、HS = -1（逐棒重放，同 Signal Board 一致）；
      標記距今超過 HV_FRESH 棒（通常係窗口邊緣嘅舊標記）當冇 = 0
  UT  UT Bot 現時持倉方向（long = +1 / short = -1）
同時附 ago（距今幾多棒）俾前端 tooltip。

時間級別：5m / 15m（盤前盤後都計，同 Signal Board 一致）、1h（正規盤）、
2h / 4h 由 1h 按美東交易日合併（9:30 起算：2h = 2 棒、4h = 4 棒，最後一組可能較短）、1D（日線）。

環境變數
  SB_MTF_SYMS   股票（逗號分隔）；留空 = Signal Board 全部股票（Watchlists.txt 美股）
  MTF_RATE      每秒最多幾個 candlestick call（預設 6）  MTF_THREADS 並行數（預設 4）
  MTF_OUT       輸出檔，預設 frontend/public/mtf.json
"""
import os, sys, json, time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

os.environ.setdefault("LONGBRIDGE_ENABLE_OVERNIGHT", "true")
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
import pandas as pd

TFS = ["5m", "15m", "1h", "2h", "4h", "1D"]
OUT = Path(os.getenv("MTF_OUT") or Path(__file__).resolve().parent.parent / "frontend" / "public" / "mtf.json")
MIN_BARS = 120
HV_GRACE = 3     # 標記消失後仍保留幾多棒
HV_REPLAY = 300  # Heavy 重放只用最近咁多棒（夠長，慳 CPU）
HV_FRESH = 50   # Heavy 標記只認最近 50 棒（窗口 100 棒嘅後半）；更舊嘅當冇
ET = ZoneInfo("America/New_York")


def aggregate(df, k):
    """1h → k 小時：按美東交易日分組，每 k 棒合併一組（OHLCV）"""
    if df is None or df.empty:
        return df
    idx = pd.DatetimeIndex(df.index)
    day = idx.tz_localize("UTC").tz_convert(ET).date if idx.tz is None else idx.tz_convert(ET).date
    d = df.copy()
    d["_day"] = day
    d["_pos"] = d.groupby("_day").cumcount() // k
    d["_ts"] = d.index
    g = d.groupby(["_day", "_pos"], sort=True)
    out = pd.DataFrame({
        "Open": g["Open"].first(), "High": g["High"].max(), "Low": g["Low"].min(),
        "Close": g["Close"].last(), "Volume": g["Volume"].sum(),
    })
    out.index = pd.DatetimeIndex(g["_ts"].first().values)
    return out.sort_index()


def states(df, S):
    """回 {tb, hv, ut, tb_ago, hv_ago, ut_ago}；數據唔夠回 None"""
    n = len(df)
    if n < MIN_BARS:
        return None
    tb = [e for e in S.triple_band(df) if e["kind"] == "TB"]
    ts = [e for e in S.triple_band(df) if e["kind"] == "TS"]
    tb_i = max((e["i"] for e in tb), default=None)
    ts_i = max((e["i"] for e in ts), default=None)
    if tb_i is None and ts_i is None:
        tb_s, tb_ago = 0, None
    elif ts_i is None or (tb_i is not None and tb_i >= ts_i):
        tb_s, tb_ago = 1, n - 1 - tb_i
    else:
        tb_s, tb_ago = -1, n - 1 - ts_i
    # Heavy：以「而家最後一棒睇到嘅標記」(heavy_now，即圖上顯示嘅) 為準；
    # 剛剛（<= HV_GRACE 棒內）先消失嘅標記仍然算（成交量來源有少少差異時，邊緣標記會跳）
    n_ = len(df)
    bi, _bv, si, _sv = S.heavy_now(df)
    hd = df.iloc[-HV_REPLAY:]
    hn = len(hd)
    hev = S.heavy_events(hd)
    off = n_ - hn
    hb = [e["i"] + off for e in hev if e["kind"] == "HB"]
    hs = [e["i"] + off for e in hev if e["kind"] == "HS"]
    if bi is None and hb and n_ - 1 - max(hb) <= HV_GRACE:
        bi = max(hb)
    if si is None and hs and n_ - 1 - max(hs) <= HV_GRACE:
        si = max(hs)
    hn = n_
    if bi is None and si is None:
        hv_s, hv_ago = 0, None
    elif si is None or (bi is not None and bi >= si):
        hv_s, hv_ago = 1, hn - 1 - bi
    else:
        hv_s, hv_ago = -1, hn - 1 - si
    if hv_ago is not None and hv_ago > HV_FRESH:
        hv_s, hv_ago = 0, None
    pos = S.ut_bot(df)[1]
    ut_s = int(pos[-1])
    ut_ago = 0
    for v in pos[-2::-1]:
        if v == pos[-1]:
            ut_ago += 1
        else:
            break
    return {"tb": tb_s, "hv": hv_s, "ut": ut_s, "tb_ago": tb_ago, "hv_ago": hv_ago, "ut_ago": ut_ago if ut_s else None}


def compute_symbol(frames, S):
    """frames: {tf: DataFrame} → {tf: states}"""
    out = {}
    for tf in TFS:
        df = frames.get(tf)
        out[tf] = states(df, S) if df is not None and len(df) else None
    return out


def main():
    from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
    import signal_board as sb
    import intraday_signals as S

    from concurrent.futures import ThreadPoolExecutor
    sb.RATE = float(os.getenv("MTF_RATE", "6"))
    only = [x.strip().upper() for x in (os.getenv("SB_MTF_SYMS") or "").split(",") if x.strip()]
    syms = only or [u["sym"] for u in sb.universe()]
    print(f"{len(syms)} symbols", flush=True)
    ctx = QuoteContext(Config.from_apikey_env())

    def pull(sym, period, count, adj, sess):
        for k in range(3):
            try:
                sb._throttle()
                bars = ctx.candlesticks(f"{sym}.US", period, count, adj, sess)
                if not bars:
                    return None
                df = sb._df(bars)
                return df[~df.index.duplicated(keep="last")].sort_index()
            except Exception as e:  # noqa: BLE001
                time.sleep(1.5 * (k + 1)); err = e
        print(f"::warning::{sym} {period}: {err}", flush=True)
        return None

    def one(s):
        try:
            f = {}
            f["5m"] = pull(s, Period.Min_5, 1000, AdjustType.NoAdjust, TradeSessions.All)
            f["15m"] = pull(s, Period.Min_15, 1000, AdjustType.NoAdjust, TradeSessions.All)
            h1 = pull(s, Period.Min_60, 1000, AdjustType.NoAdjust, TradeSessions.Intraday)
            f["1h"] = h1
            f["2h"] = aggregate(h1, 2) if h1 is not None else None
            f["4h"] = aggregate(h1, 4) if h1 is not None else None
            f["1D"] = pull(s, Period.Day, 400, AdjustType.ForwardAdjust, TradeSessions.Intraday)
            return s, compute_symbol(f, S)
        except Exception as e:  # noqa: BLE001
            print(f"::warning::{s}: {e}", flush=True)
            return s, None

    rows, t0, bad = {}, time.time(), 0
    with ThreadPoolExecutor(int(os.getenv("MTF_THREADS", "4"))) as ex:
        for i, (s, r) in enumerate(ex.map(one, syms), 1):
            if r is None or not any(r.values()):
                bad += 1
                continue
            rows[s] = r
            if i % 50 == 0 or i == len(syms):
                print(f"{i}/{len(syms)} done, {time.time()-t0:.0f}s", flush=True)
    print(f"ok {len(rows)}, empty {bad}", flush=True)
    if not rows:
        raise SystemExit("no rows")

    payload = {"updated": datetime.now(timezone.utc).isoformat(), "tfs": TFS, "rows": rows}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"✓ {OUT}", flush=True)


if __name__ == "__main__":
    main()
