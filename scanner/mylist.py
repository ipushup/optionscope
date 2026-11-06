#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mylist.py — My List 頁（宏觀看法）數據：自選股 × (日 D / 週 W / 月 M) × (UT / HV / EMA10·20·50·89·250)

  UT   UT Bot 現時持倉方向 + 持續咗幾多棒：B2 = 買方向、第 2 棒（轉向嗰棒 = 1）
  HV   Heavy（同 Signal Board / Daily Table 同一套 heavy_now）最近嗰個標記：B3 = HB、3 棒前（最新棒 = 1）
  EMA  收市價喺 EMA 之上 = 1、之下 = 0；歷史棒數唔夠（< 週期）= None

自選股由 gateway 讀（GET {GATEWAY_URL}/_ingest/mylist.json，Bearer INGEST_TOKEN；前端頁面入面增減）。
未設 gateway 就用環境變數 MYLIST（逗號分隔），再唔係用預設。

環境變數
  MYLIST_OUT        輸出檔，預設 frontend/public/mylist.json
  MYLIST_LOOP_SECS  循環跑幾耐（秒）；0 = 跑一次。循環模式每輪（預設 60 秒）推去 gateway（SB_INGEST_NAME=mylist.json）
  MYLIST            自選股（逗號分隔），例如 INTC.US,NVDA.US,968.HK
"""
import os, sys, json, time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("SB_INGEST_NAME", "mylist.json")
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np  # noqa: F401
import pandas as pd

DEFAULT = ["INTC.US", "NVDA.US", "968.HK", "868.HK", "3868.HK"]
OUT = Path(os.getenv("MYLIST_OUT") or Path(__file__).resolve().parent.parent / "frontend" / "public" / "mylist.json")
EMAS = [10, 20, 50, 89, 250]
BARS = {"D": 900, "W": 600, "M": 300}
EVERY = 60
KEEP = {"D": 30, "W": 30, "M": 30}   # 圖上顯示幾多棒
TB_RECENT = 20      # TB 只顯示最近 20 棒內嘅買入訊號


def fetch_list():
    gw, tok = os.getenv("GATEWAY_URL", "").rstrip("/"), os.getenv("INGEST_TOKEN", "")
    if gw and tok:
        try:
            req = urllib.request.Request(f"{gw}/_ingest/mylist.json", headers={
                "Authorization": f"Bearer {tok}", "User-Agent": "curl/8.5.0", "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=15) as r:
                syms = json.loads(r.read().decode()).get("symbols") or []
                if syms:
                    return [str(s) for s in syms]
        except Exception as e:  # noqa: BLE001  gateway 未有清單（404）= 用預設
            print(f"ℹ gateway list: {e}", flush=True)
    env = [x.strip() for x in (os.getenv("MYLIST") or "").split(",") if x.strip()]
    return env or DEFAULT


def run_len(arr):
    """最新狀態連續咗幾多棒（最新棒轉向 = 1）"""
    last = arr[-1]; n = 1
    for v in arr[-2::-1]:
        if v == last:
            n += 1
        else:
            break
    return n


def analyse(df, S, key="D"):
    """一個週期嘅 {ut, hv, ema}；數據太少回 None"""
    if df is None or len(df) < 30:
        return None
    n = len(df)
    pos = S.ut_bot(df)[1]
    ut = None
    if int(pos[-1]) != 0:
        ut = {"s": int(pos[-1]), "n": run_len(list(pos))}
    hv = None
    if n > 101:
        bi, _bv, si, _sv = S.heavy_now(df)
        if bi is not None or si is not None:
            buy = si is None or (bi is not None and bi >= si)
            hv = {"s": 1 if buy else -1, "n": n - (bi if buy else si)}   # 最新棒 = 1
    # Triple Band：只要真正買入（確認買入嗰支棒，kind == TB；TBskip 唔計），最近 TB_RECENT 棒內
    tb = None
    tbs = [e["i"] for e in S.triple_band(df) if e["kind"] == "TB"]
    if tbs and n - tbs[-1] < TB_RECENT:
        tb = {"s": 1, "n": n - tbs[-1]}               # 確認棒 = 最新棒 → 1
    close = df["Close"].astype(float)
    ema = {}
    for p in EMAS:
        if n < p:
            ema[str(p)] = None
        else:
            e = close.ewm(span=p, adjust=False).mean()
            ema[str(p)] = 1 if float(close.iloc[-1]) > float(e.iloc[-1]) else 0
    # 細 K 線圖數據：最近 KEEP 棒 OHLC + EMA10/20/50
    keep = KEEP.get(key, 40)
    tail = df.iloc[-keep:]
    k = {c: [round(float(x), 4) for x in tail[col].values] for c, col in (("o", "Open"), ("h", "High"), ("l", "Low"), ("c", "Close"))}
    for p in (10, 20, 50):
        e = close.ewm(span=p, adjust=False).mean().iloc[-keep:]
        k[f"e{p}"] = [round(float(x), 4) if n >= p else None for x in e.values]
    return {"ut": ut, "hv": hv, "tb": tb, "ema": ema, "bars": n, "k": k}


def main():
    from longbridge.openapi import AdjustType, Config, Period, QuoteContext
    import signal_board as sb
    import intraday_signals as S
    ctx = QuoteContext(Config.from_apikey_env())
    sb.RATE = 6.0
    names = {}

    def pull(sym, period, count):
        err = None
        for k in range(3):
            try:
                sb._throttle()
                bars = ctx.candlesticks(sym, period, count, AdjustType.ForwardAdjust)
                if not bars:
                    return None
                df = sb._df(bars)
                return df[~df.index.duplicated(keep="last")].sort_index()
            except Exception as e:  # noqa: BLE001
                err = e; time.sleep(1.5 * (k + 1))
        print(f"::warning::{sym} {period}: {err}", flush=True)
        return None

    def name_of(sym):
        if sym in names:
            return names[sym]
        nm = None
        try:
            sb._throttle()
            info = ctx.static_info([sym])[0]
            nm = (getattr(info, "name_cn", None) if sym.endswith(".HK") else None) or getattr(info, "name_en", None) or getattr(info, "name_cn", None)
        except Exception:  # noqa: BLE001
            pass
        names[sym] = nm
        return nm

    def one_round():
        syms = fetch_list()
        rows = {}
        for s in syms:
            r = {"name": name_of(s)}
            for key, period in (("D", Period.Day), ("W", Period.Week), ("M", Period.Month)):
                r[key] = analyse(pull(s, period, BARS[key]), S, key)
            rows[s] = r
        payload = {"updated": datetime.now(timezone.utc).isoformat(), "symbols": syms, "rows": rows}
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        got = sum(1 for r in rows.values() if r.get("D"))
        print(f"✓ {len(syms)} symbols, daily ok {got}", flush=True)

    loop_s = float(os.getenv("MYLIST_LOOP_SECS", "0") or 0)
    end = time.time() + loop_s
    while True:
        t0 = time.time()
        try:
            one_round()
            if loop_s:
                sb._LAST_PUSH[0] = 0
                sb.push(OUT)
        except Exception as e:  # noqa: BLE001
            print(f"::warning::round failed: {e}", flush=True)
            if not loop_s:
                raise
        if not loop_s or time.time() + EVERY >= end:
            break
        time.sleep(max(1.0, EVERY - (time.time() - t0)))


if __name__ == "__main__":
    main()
