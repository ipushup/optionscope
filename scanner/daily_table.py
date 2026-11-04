#!/usr/bin/env python3
"""
daily_table.py — xMarket「Daily Table」數據（日線狀態表，Longbridge 即時價）

 · 日線歷史：Longbridge candlesticks(Day, 前復權, 400 棒)，每 3 小時重拎一次
 · 今日未收線日線：用 quote 嘅 open/high/low/last/volume 即時覆蓋／補上最新一棒
 · 指標：ST / UT / EMA(10/20/50/89/250) / 量能 / RSI / ATR 比 / Whale
   全部用 daily_calc.py（由 daily brief 原封搬過嚟），同報告一致
 · 輸出 daily.json 去 gateway（SB_OUT / SB_INGEST_NAME 設定）

  SB_LOOP_SECS 跑幾耐（預設 3300）  DT_EVERY 更新間隔秒（預設 60；冇即時行情時 300）
"""
import os, sys, json, time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

os.environ.setdefault("LONGBRIDGE_ENABLE_OVERNIGHT", "true")
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
import pandas as pd
from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
import signal_board as sb
import daily_calc as C

ET = ZoneInfo("America/New_York")
EVERY = float(os.getenv("DT_EVERY", "60"))
RELOAD_EVERY = 3 * 3600
LIVE_SECS = 300           # regular 報價 timestamp 喺 5 分鐘內 = 盤中


def load_hist(ctx, s):
    for k in range(3):
        try:
            sb._throttle()
            bars = ctx.candlesticks(f"{s}.US", Period.Day, 400, AdjustType.ForwardAdjust, TradeSessions.Intraday)
            if not bars:
                return None
            df = pd.DataFrame(
                {"Open": [float(b.open) for b in bars], "High": [float(b.high) for b in bars],
                 "Low": [float(b.low) for b in bars], "Close": [float(b.close) for b in bars],
                 "Volume": [float(b.volume) for b in bars]},
                index=pd.DatetimeIndex([pd.Timestamp(b.timestamp) for b in bars]).normalize())
            return df[~df.index.duplicated(keep="last")].sort_index()
        except Exception as e:
            time.sleep(1.5 * (k + 1)); err = e
    print(f"::warning::hist {s}: {err}", flush=True)
    return None


def st_series(df):
    """同 daily_calc.compute_supertrend 一樣嘅迴圈，但返回成條 trend（計 Up/Down 幾多日）"""
    hl = df['High'] - df['Low']
    hc = abs(df['High'] - df['Close'].shift(1)); lc = abs(df['Low'] - df['Close'].shift(1))
    tr = pd.concat([hl, hc, lc], axis=1).max(axis=1)
    atr = tr.rolling(C.ST_PERIODS).mean()
    src = (df['High'] + df['Low']) / 2
    b_up = (src - C.ST_MULTIPLIER * atr).values; b_dn = (src + C.ST_MULTIPLIER * atr).values
    cl = df['Close'].values; n = len(df)
    f_up = b_up.copy(); f_dn = b_dn.copy(); trend = np.ones(n, dtype=int)
    for i in range(1, n):
        if np.isnan(b_up[i]) or np.isnan(b_dn[i]):
            trend[i] = trend[i-1]; continue
        f_up[i] = max(b_up[i], f_up[i-1]) if cl[i-1] > f_up[i-1] else b_up[i]
        f_dn[i] = min(b_dn[i], f_dn[i-1]) if cl[i-1] < f_dn[i-1] else b_dn[i]
        if   trend[i-1] == -1 and cl[i] > f_dn[i-1]: trend[i] = 1
        elif trend[i-1] ==  1 and cl[i] < f_up[i-1]: trend[i] = -1
        else:                                         trend[i] = trend[i-1]
    return trend


def with_today(df, q):
    """用 quote 嘅今日 OHLCV 覆蓋／補上最新一棒（regular session）"""
    if q is None:
        return df, False
    o, h, l, last, vol, qts = q
    if not (last > 0):
        return df, False
    qts = pd.Timestamp(qts)
    qts = qts.tz_localize("UTC") if qts.tzinfo is None else qts.tz_convert("UTC")
    qd = pd.Timestamp(qts.tz_convert(ET).date())
    live = (datetime.now(timezone.utc) - qts.to_pydatetime()).total_seconds() < LIVE_SECS
    df = df.copy()
    row = [o if o > 0 else last, h if h > 0 else last, l if l > 0 else last, last, vol]
    if qd > df.index[-1]:
        df.loc[qd] = row
    elif qd == df.index[-1]:
        df.iloc[-1] = row
    return df, live


def analyse_daily(df, live):
    cl = df["Close"]
    px = float(cl.iloc[-1]); prev = float(cl.iloc[-2])
    tr = st_series(df)
    t, p = int(tr[-1]), int(tr[-2])
    days = 1
    for v in tr[-2::-1]:
        if v == t: days += 1
        else: break
    st_flip = "BUY" if (t == 1 and p == -1) else "SELL" if (t == -1 and p == 1) else None
    ut_cross, ut_pos, ut_stop = C.compute_ut_bot(df)
    ema = C.compute_ema_status(df)
    vol_sig = C.compute_vol_signal(df)
    v = df["Volume"]; avg = float(v.iloc[-21:-1].mean()) if len(v) > 21 else 0
    vr = round(float(v.iloc[-1]) / avg, 2) if avg > 0 else None
    rsi_val, _, _, rsi_arrow, _, _ = C.compute_rsi(df)
    atr_val, _, _ = C.compute_atr_ratio(df)
    whale = [{"type": w["type"], "val": w["val"]} for w in C.compute_whale_history(df)]
    sig = st_flip or ("BUY" if ut_cross == "B" else "SELL" if ut_cross == "S" else None)
    ideal = bool(sig == "BUY" and vol_sig == "strong" and (vr or 0) >= 1.5 and rsi_val is not None
                 and 45 <= rsi_val <= 72 and atr_val is not None and atr_val <= 2.0)
    return {
        "px": round(px, 4), "chg": round((px / prev - 1) * 100, 2) if prev else None, "live": bool(live),
        "bar": str(df.index[-1].date()),
        "st": {"t": "Up" if t == 1 else "Down", "days": days, "flip": st_flip},
        "ut": {"pos": ut_pos, "stop": ut_stop, "cross": ut_cross},
        "sig": sig,
        "ema": [{"p": e["period"], "above": bool(e["above"]), "valid": bool(e["valid"])} for e in ema["pills"]],
        "whale": whale,
        "vol": {"sig": vol_sig, "ratio": vr},
        "rsi": {"val": rsi_val, "arrow": rsi_arrow},
        "atr": atr_val,
        "ideal": ideal,
    }


def fetch_quotes(ctx, syms):
    out = {}
    for i in range(0, len(syms), 400):
        try:
            for q in ctx.quote([f"{s}.US" for s in syms[i:i + 400]]):
                out[q.symbol.rsplit(".", 1)[0]] = (float(q.open), float(q.high), float(q.low), float(q.last_done),
                                                    float(q.volume), q.timestamp)
        except Exception as e:
            print(f"::warning::quote batch failed: {e}", flush=True)
    return out


def main():
    ctx = QuoteContext(Config.from_apikey_env())
    end = time.time() + float(os.getenv("SB_LOOP_SECS", "3300"))
    uni = sb.universe(); syms = [u["sym"] for u in uni]
    HIST = {}; hist_at = 0.0
    while time.time() < end:
        t0 = time.time()
        if t0 - hist_at > RELOAD_EVERY:
            with ThreadPoolExecutor(5) as ex:
                for s, df in zip(syms, ex.map(lambda x: load_hist(ctx, x), syms)):
                    if df is not None and len(df) >= 60: HIST[s] = df
            hist_at = time.time()
            first = next(iter(HIST.values()))
            print(f"history loaded {len(HIST)}/{len(syms)} in {hist_at-t0:.0f}s; sample index {first.index[-3:].tolist()}", flush=True)
        qs = fetch_quotes(ctx, syms)
        rows, nlive, tc = [], 0, time.time()
        for u in uni:
            s = u["sym"]; df = HIST.get(s)
            if df is None: continue
            try:
                d, live = with_today(df, qs.get(s))
                r = analyse_daily(d, live)
            except Exception as e:
                print(f"::warning::analyse {s}: {e}", flush=True); continue
            nlive += r["live"]
            rows.append({"sym": s, "section": u["section"], **r})
        out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n": len(rows), "live_n": nlive, "rows": rows}
        sb.OUT.parent.mkdir(parents=True, exist_ok=True)
        sb.OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
        sb.push(sb.OUT)
        print(f"daily.json: {len(rows)} rows, live={nlive}, calc {time.time()-tc:.0f}s {time.strftime('%H:%M:%S')}", flush=True)
        every = EVERY if nlive else max(EVERY, 300)
        time.sleep(max(5.0, every - (time.time() - t0)))


if __name__ == "__main__":
    main()
