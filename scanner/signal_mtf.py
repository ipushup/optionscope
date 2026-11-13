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
  MTF_LOOP_SECS 循環跑幾耐（秒）；0 = 跑一次。循環模式每輪完成就推去 gateway（要 GATEWAY_URL / INGEST_TOKEN / SB_INGEST_NAME=mtf.json）
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
HKT = ZoneInfo("Asia/Hong_Kong")
HK_B = [0, 570, 720, 780, 960, 1440]   # 港股 HKT 分鐘：休市→早市 9:30→午休 12:00→午市 13:00→收市 16:00
HK_OPEN = [(570, 720), (780, 960)]


def is_hk(sym):
    return sym.endswith(".HK")


def lb_sym(sym):
    return f"{int(sym[:-3])}.HK" if is_hk(sym) else f"{sym}.US"


def aggregate(df, k, tz=ET):
    """1h → k 小時：按交易日（預設美東；港股傳 HKT）分組，每 k 棒合併一組（OHLCV）"""
    if df is None or df.empty:
        return df
    idx = pd.DatetimeIndex(df.index)
    day = idx.tz_localize("UTC").tz_convert(tz).date if idx.tz is None else idx.tz_convert(tz).date
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


# ───────── 5m 為基礎尺寸嘅「時間格」數據（Signal Board 交通燈替代）─────────
# 每個時間級別（5m/15m/1h/2h/4h）喺「今日正規盤 9:30–16:00」上佔若干個 5m 格；
# 每格出：UT 轉向（買/賣）、Heavy（買/賣）、TB 真入市。只用「已收市」嘅棒計算同標記。
GRID_TFS = ["5m", "15m", "1h", "2h", "4h"]
GRID_LEN = {"5m": 5, "15m": 15, "1h": 60, "2h": 120, "4h": 240}
OPEN_MIN, CLOSE_MIN = 9 * 60 + 30, 16 * 60
F_UTB, F_UTS, F_HVB, F_HVS, F_TB = 1, 2, 4, 8, 16


def _et(idx):
    idx = pd.DatetimeIndex(idx)
    return idx.tz_localize("UTC").tz_convert(ET) if idx.tz is None else idx.tz_convert(ET)


def hv_flags(df, n=100):
    """Heavy 買／賣棒喺最新一棒出現（同 heavy_now／網站 HV B1／S1 一致；窗口 n+1 棒，要 >101 棒）"""
    h, l, c, v = (df[k].values.astype(float) for k in ("High", "Low", "Close", "Volume"))
    rng = h - l
    with np.errstate(divide="ignore", invalid="ignore"):
        vb = np.where(rng > 0, v * (c - l) / rng, v * 0.5)
        vs = np.where(rng > 0, v * (h - c) / rng, v * 0.5)
    delta = vb - vs
    sp = np.concatenate([[0.0], np.cumsum(delta)])
    N = len(df)
    buy = np.zeros(N, bool); sell = np.zeros(N, bool)
    for j in range(n + 1, N):
        w = sp[max(0, j - n): j + 1]
        if delta[j] > 0 and sp[j] <= w.min():
            buy[j] = True
        if delta[j] < 0 and sp[j] >= w.max():
            sell[j] = True
    return buy, sell


def grid_flags(df, S):
    """df 已收市、正規盤棒 → 每棒 flags（int array）"""
    n = len(df)
    fl = np.zeros(n, int)
    pos = np.asarray(S.ut_bot(df)[1])
    sell = np.zeros(n, bool)
    for i in range(1, n):
        if pos[i] == 1 and pos[i - 1] != 1:
            fl[i] |= F_UTB
        if pos[i] == -1 and pos[i - 1] != -1:
            fl[i] |= F_UTS
            sell[i] = True
    hb, hs = hv_flags(df)
    fl[hb] |= F_HVB
    fl[hs] |= F_HVS
    tbi = {e["i"] for e in S.triple_band(df) if e["kind"] == "TB"}     # 真入市：一次一倉、UT 賣出先平倉（同日線回測引擎一樣）
    in_pos = False
    for i in range(n):
        if in_pos and sell[i]:
            in_pos = False
        if i in tbi and not in_pos:
            fl[i] |= F_TB
            in_pos = True
    return fl


CHART_N = 80


def chart_for(frames, S):
    """展開圖表用：每個級別最近 CHART_N 棒 OHLC + 每棒 UT（+1 買／−1 賣）、TB 真入市（1）、Heavy（+1 買／−1 賣）。
    最後一棒可能未收市＝暫時訊號。"""
    out = {}
    for tf in ("5m", "15m", "1h", "D", "W", "M"):
        df = frames.get(tf)
        if df is None or len(df) < (60 if tf in ("5m", "15m", "1h") else 30):
            continue
        try:
            fl = grid_flags(df, S)[-CHART_N:]
            d = df.iloc[-CHART_N:]
            out[tf] = {
                "b": [[round(float(o), 4), round(float(h), 4), round(float(l), 4), round(float(c), 4)]
                      for o, h, l, c in zip(d["Open"], d["High"], d["Low"], d["Close"])],
                "u": [1 if f & F_UTB else -1 if f & F_UTS else 0 for f in fl],
                "tb": [1 if f & F_TB else 0 for f in fl],
                "hv": [1 if f & F_HVB else -1 if f & F_HVS else 0 for f in fl],
                # EMA 10/20/50/89：用全部棒計（唔係只用最後 80 棒），再截尾
                "e": {str(k): [round(float(x), 4) for x in df["Close"].astype(float).ewm(span=k, adjust=False).mean().iloc[-CHART_N:]]
                      for k in (10, 20, 50, 89)},
            }
        except Exception as e:  # noqa: BLE001
            print(f"::warning::chart {tf}: {e}", flush=True)
    return out


GRID_HOURS = 6                         # 過去 6 小時
GRID_FUTURE_H = 2                      # 加未來 2 小時空格（現時線約 75% 位置）
GRID_N = (GRID_HOURS + GRID_FUTURE_H) * 12   # 96 格
SESS_B = [0, 240, 570, 960, 1200, 1440]   # 美東分鐘：夜盤→盤前 4:00→正規 9:30→盤後 16:00→夜盤 20:00
GRID_DEFAULT = ["INTC", "NVDA", "BABA", "NOK", "CRWV", "TTD", "MRNA", "HIMS", "RKLB", "SKHY", "SKHX", "SPCX", "0968.HK"]


def aggregate_clock(df, k):
    """1h（全時段）→ k 小時：按美東整點鐘 bucket（2h = 0,2,4…；4h = 0,4,8…20 點）合併 OHLCV；index = bucket 起點（naive UTC）"""
    if df is None or df.empty:
        return df
    et = _et(df.index)
    bs = pd.DatetimeIndex(df.index).floor("h") - pd.to_timedelta(np.asarray(et.hour) % k, unit="h")   # 美東與 UTC 差整數小時，喺 UTC 上 floor 避開 DST 歧義
    d = df.copy()
    d["_b"] = bs
    g = d.groupby("_b", sort=True)
    out = pd.DataFrame({"Open": g["Open"].first(), "High": g["High"].max(), "Low": g["Low"].min(),
                        "Close": g["Close"].last(), "Volume": g["Volume"].sum()})
    return out.sort_index()


def grid_for(frames, S, now_utc=None, hk=False):
    """frames: 5m/15m/1h（全時段：夜盤+盤前+正規+盤後）、2h/4h（1h 按美東整點合併）。
    回 {t0, cl, tf: [[slot, len, flags], ...]}：過去 6 小時 + 未來 2 小時 = 96 個 5m 格（slot 0 = t0，epoch 秒 UTC）；
    每個時間級別每支棒一個區塊（len = 佔幾多個 5m 格；盤前盤後邊界會截短，例如 9:00 嗰支 1h 棒只佔 30 分鐘）；
    未收市區塊嘅 flags 係暫時訊號（前端畫虛線淡色）。"""
    now_utc = now_utc or pd.Timestamp.now(tz="UTC")
    now5 = now_utc.floor("5min")
    t0 = now5 + pd.Timedelta(minutes=5) - pd.Timedelta(hours=GRID_HOURS)
    t0n = t0.tz_localize(None)
    nown = now_utc.tz_localize(None)
    out = {"t0": int(t0.timestamp()), "n": GRID_N, "cl": int((now5 - t0) / pd.Timedelta(minutes=5))}
    if hk:
        out["hk"] = 1     # 前端按 HKT 畫早市／午市分段
    tz = HKT if hk else ET
    bnd = HK_B if hk else SESS_B
    any_ok = False
    for tf in GRID_TFS:
        df = None if (hk and tf in ("2h", "4h")) else frames.get(tf)   # 港股 2h/4h 冇意義（一日得 5 小時，仲分上下午）→ 唔出
        if df is None or df.empty:
            out[tf] = None
            continue
        start = pd.DatetimeIndex(df.index)
        if tf in ("2h", "4h"):
            ln = np.full(len(df), GRID_LEN[tf])
        else:
            lt = _et(start).tz_convert(tz)
            sm = np.asarray(lt.hour) * 60 + np.asarray(lt.minute)
            nb = np.array([min(b for b in bnd if b > m) for m in sm])
            ln = np.minimum(GRID_LEN[tf], nb - sm)
        end = start + pd.to_timedelta(ln, unit="m")
        closed = np.asarray(end <= nown)
        if int(closed.sum()) < MIN_BARS:
            out[tf] = None
            continue
        # 連未收市（forming）嗰條一齊計：已收市棒嘅訊號只靠過去數據（因果），唔受最後一棒影響；
        # forming 棒嘅訊號係「暫時」，前端虛線淡色顯示，收市前可能消失
        fl = grid_flags(df, S)
        rows = []
        for i in range(len(df)):
            s0 = int(round((start[i] - t0n) / pd.Timedelta(minutes=5)))
            l5 = int(ln[i] // 5)
            if s0 < 0:
                l5 += s0
                s0 = 0
            if l5 <= 0 or s0 >= GRID_N:
                continue
            rows.append([s0, min(l5, GRID_N - s0), int(fl[i])])
        # 未來空格：由「現時 5m 格」開始、df 冇嘅區塊，按同一套邊界生成（flags = 0）
        have = {r[0] for r in rows}
        cl = out["cl"]
        for s0 in range(cl, GRID_N):
            if s0 in have:
                continue
            ts = t0 + pd.Timedelta(minutes=5 * s0)
            et = ts.tz_convert(tz)
            m = et.hour * 60 + et.minute
            if hk and not any(a <= m < b for a, b in HK_OPEN):
                continue        # 港股休市時段冇棒
            if tf == "5m":
                ln_m = 5
            elif tf == "15m":
                if m % 15:
                    continue
                ln_m = 15
            elif tf == "1h":
                if hk:
                    a0 = 570 if m < 720 else 780
                    if (m - a0) % 60:
                        continue
                elif (m - 570) % 60 if 570 <= m < 960 else m % 60:
                    continue
                ln_m = min(60, min(b for b in bnd if b > m) - m)
            else:
                k = 2 if tf == "2h" else 4
                if m % (k * 60):
                    continue
                ln_m = k * 60
            l5 = min(ln_m // 5, GRID_N - s0)
            if l5 > 0:
                rows.append([s0, l5, 0])
        rows.sort(key=lambda r: r[0])
        out[tf] = rows
        any_ok = True
    return out if any_ok else None


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
    def get_syms():       # 每輪重新讀名單（頁面上增減後下一輪生效）
        return only or sb.fetch_sblist() or GRID_DEFAULT
    syms = get_syms()
    print(f"{len(syms)} symbols", flush=True)
    ctx = QuoteContext(Config.from_apikey_env())

    def pull(sym, period, count, adj, sess):
        for k in range(3):
            try:
                sb._throttle()
                bars = ctx.candlesticks(lb_sym(sym), period, count, adj, sess)
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
            f["5m"] = pull(s, Period.Min_5, 600, AdjustType.NoAdjust, TradeSessions.All)
            f["15m"] = pull(s, Period.Min_15, 600, AdjustType.NoAdjust, TradeSessions.All)
            h1 = pull(s, Period.Min_60, 700, AdjustType.NoAdjust, TradeSessions.Intraday)
            f["1h"] = h1
            tzs = HKT if is_hk(s) else ET
            f["2h"] = aggregate(h1, 2, tzs) if h1 is not None else None
            f["4h"] = aggregate(h1, 4, tzs) if h1 is not None else None
            f["1D"] = pull(s, Period.Day, 300, AdjustType.ForwardAdjust, TradeSessions.Intraday)
            r = compute_symbol(f, S)
            fw = pull(s, Period.Week, 300, AdjustType.ForwardAdjust, TradeSessions.Intraday)     # 展開圖表 W／M 用（最後一棒未完成＝暫時訊號）
            fm = pull(s, Period.Month, 200, AdjustType.ForwardAdjust, TradeSessions.Intraday)
            try:
                h1a = pull(s, Period.Min_60, 700, AdjustType.NoAdjust, TradeSessions.All)   # 24h 時間格用：全時段 1h
                g = grid_for({"5m": f["5m"], "15m": f["15m"], "1h": h1a,
                              "2h": None if is_hk(s) else aggregate_clock(h1a, 2),
                              "4h": None if is_hk(s) else aggregate_clock(h1a, 4)}, S, hk=is_hk(s))
                if g:
                    r["grid"] = g
                r["chart"] = chart_for({"5m": f["5m"], "15m": f["15m"], "1h": h1a, "D": f["1D"], "W": fw, "M": fm}, S)
            except Exception as e:  # noqa: BLE001
                print(f"::warning::{s} grid: {e}", flush=True)
            return s, r
        except Exception as e:  # noqa: BLE001
            print(f"::warning::{s}: {e}", flush=True)
            return s, None

    def run_once():
        nonlocal syms
        syms = get_syms()
        rows, t0, bad = {}, time.time(), 0
        with ThreadPoolExecutor(int(os.getenv("MTF_THREADS", "5"))) as ex:
            for i, (s, r) in enumerate(ex.map(one, syms), 1):
                if r is None or not any(v for k, v in r.items() if k not in ("grid", "chart")):
                    bad += 1
                    continue
                rows[s] = r
                if i % 100 == 0 or i == len(syms):
                    print(f"{i}/{len(syms)} done, {time.time()-t0:.0f}s", flush=True)
        print(f"ok {len(rows)}, empty {bad}, round {time.time()-t0:.0f}s", flush=True)
        if not rows:
            raise RuntimeError("no rows")
        payload = {"updated": datetime.now(timezone.utc).isoformat(), "tfs": TFS, "rows": rows}
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(payload, separators=(",", ":")))
        print(f"✓ {OUT}", flush=True)

    loop_s = float(os.getenv("MTF_LOOP_SECS", "0") or 0)
    end = time.time() + loop_s
    while True:
        t0 = time.time()
        try:
            run_once()
            if loop_s:
                sb._LAST_PUSH[0] = 0      # 每輪都推（KV 模式 sb.push 預設 5 分鐘先推一次；一輪 >= 幾分鐘）
                sb.push(OUT)
        except Exception as e:  # noqa: BLE001  一輪失敗唔好搞死成個循環
            print(f"::warning::round failed: {e}", flush=True)
            if not loop_s:
                raise
        if not loop_s or time.time() + 60 >= end:
            break
        time.sleep(max(1.0, 60 - (time.time() - t0)))


if __name__ == "__main__":
    main()
