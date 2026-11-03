#!/usr/bin/env python3
"""
signal_stream.py — Signal Board 推送版（Longbridge 5m K 線訂閱，取代逐隻輪詢）

流程：訂閱 5m K 線推送 → 拎一次歷史 500 棒 → 之後每次推送更新最新一棒，
每 STEP 秒只重算有變動嘅股票，再 push 去 gateway。更新延遲由 ~3.5 分鐘降到幾秒。
信號邏輯同 signal_board.analyse 完全一樣（Triple Band / UT Bot / Heavy）。

  SB_LOOP_SECS  跑幾耐（秒），預設 3300
  SB_STEP       重算間隔秒，預設 3
  SB_OUT / SB_INGEST_NAME  輸出檔 / gateway 檔名（試跑用 signals2.json）
"""
import os, sys, json, time, threading
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

os.environ.setdefault("LONGBRIDGE_ENABLE_OVERNIGHT", "true")
sys.path.insert(0, os.path.dirname(__file__))
import pandas as pd
from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
import signal_board as sb

TF = "5m"
BARS = sb.BARS
STEP = float(os.getenv("SB_STEP", "3"))
MIN_PUSH = float(os.getenv("SB_MIN_PUSH", "4"))
HEAL_EVERY = 1200            # 每 20 分鐘用歷史補一次最新 100 棒（補斷線期間嘅缺口）
SILENT_RESUB = 240           # 咁耐冇收到任何推送就重新訂閱

lock = threading.Lock()
B = {}          # sym → {ts: (o,h,l,c,v)}
PUSHED = {}     # sym → 最新一次推送嘅 ts（歷史補數唔好覆蓋佢）
DIRTY = set()
RES = {}        # sym → analyse 結果
QUOTES = {}     # sym → (last_done, prev_close)
STAT = {"events": 0, "last": time.time()}


def sym_of(s):
    return s.rsplit(".", 1)[0]


def on_candle(symbol, e):
    c = e.candlestick
    s = sym_of(symbol)
    ts = pd.Timestamp(c.timestamp)
    with lock:
        B.setdefault(s, {})[ts] = (float(c.open), float(c.high), float(c.low), float(c.close), float(c.volume))
        if ts >= PUSHED.get(s, ts):
            PUSHED[s] = ts
        DIRTY.add(s)
        STAT["events"] += 1; STAT["last"] = time.time()


def merge_history(s, bars):
    with lock:
        d = B.setdefault(s, {})
        pt = PUSHED.get(s)
        for b in bars:
            ts = pd.Timestamp(b.timestamp)
            if pt is not None and ts == pt:
                continue                         # 推送嘅最新值為準
            d[ts] = (float(b.open), float(b.high), float(b.low), float(b.close), float(b.volume))
        if len(d) > BARS + 50:
            for k in sorted(d)[:len(d) - BARS]:
                d.pop(k, None)
        DIRTY.add(s)


def history(ctx, s, n):
    for k in range(3):
        try:
            sb._throttle()
            bars = ctx.candlesticks(f"{s}.US", Period.Min_5, n, AdjustType.NoAdjust, TradeSessions.All)
            if bars:
                merge_history(s, bars)
            return bool(bars)
        except Exception as ex:
            time.sleep(1.5 * (k + 1)); err = ex
    print(f"::warning::history {s}: {err}", flush=True)
    return False


def subscribe(ctx, s):
    for k in range(3):
        try:
            ctx.subscribe_candlesticks(f"{s}.US", Period.Min_5, TradeSessions.All)
            return True
        except TypeError:
            ctx.subscribe_candlesticks(f"{s}.US", Period.Min_5); return True
        except Exception as ex:
            if "invalid security" in str(ex):
                return False
            time.sleep(1.5 * (k + 1))
    return False


def frame(s):
    with lock:
        items = sorted(B.get(s, {}).items())[-BARS:]
    if len(items) < 60:
        return None
    return pd.DataFrame([v for _, v in items], columns=["Open", "High", "Low", "Close", "Volume"],
                        index=pd.DatetimeIndex([t for t, _ in items]))


def recompute(syms):
    n = 0
    for s in syms:
        df = frame(s)
        if df is None:
            continue
        try:
            RES[s] = sb.analyse(df); n += 1
        except Exception as ex:
            print(f"::warning::analyse {s}: {ex}", flush=True)
    return n


def refresh_quotes(ctx, syms):
    for i in range(0, len(syms), 400):
        try:
            for q in ctx.quote([f"{x}.US" for x in syms[i:i + 400]]):
                QUOTES[sym_of(q.symbol)] = (float(q.last_done), float(q.prev_close))
        except Exception as ex:
            print(f"::warning::quote batch failed: {ex}", flush=True)


def write(uni):
    rows = []
    for u in uni:
        s = u["sym"]; r = RES.get(s)
        if not r:
            continue
        ld, pc = QUOTES.get(s, (None, None))
        px, sess = r["px"], sb.session_of(r["t"])
        ref = pc if sess == "盤中" else ld
        chg = round((px / ref - 1) * 100, 2) if ref else None
        rows.append({"sym": s, "section": u["section"], "px": px, "chg": chg, "sess": sess, "reg": ld, "pc": pc, TF: r})
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "near": sb.NEAR, "fresh": sb.FRESH,
           "tfs": [TF], "n": len(rows), "mode": "stream", "rows": rows}
    sb.OUT.parent.mkdir(parents=True, exist_ok=True)
    sb.OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    return len(rows)


def warmup(ctx, uni):
    syms = [u["sym"] for u in uni]
    t0 = time.time()
    with ThreadPoolExecutor(5) as ex:
        ok = list(ex.map(lambda s: subscribe(ctx, s), syms))
    bad = [s for s, k in zip(syms, ok) if not k]
    print(f"subscribed {sum(ok)}/{len(syms)} in {time.time()-t0:.0f}s, skipped={bad}", flush=True)
    t1 = time.time()
    good = [s for s, k in zip(syms, ok) if k]
    with ThreadPoolExecutor(5) as ex:
        list(ex.map(lambda s: history(ctx, s, BARS), good))
    print(f"history done in {time.time()-t1:.0f}s", flush=True)
    return [u for u in uni if u["sym"] in set(good)]


def heal(ctx, syms):
    with ThreadPoolExecutor(3) as ex:
        list(ex.map(lambda s: history(ctx, s, 100), syms))
    print(f"healed {len(syms)} symbols {time.strftime('%H:%M:%S')}", flush=True)


def main():
    ctx = QuoteContext(Config.from_apikey_env())
    ctx.set_on_candlestick(on_candle)
    end = time.time() + float(os.getenv("SB_LOOP_SECS", "3300"))
    uni = sb.universe()
    uni = warmup(ctx, uni)
    syms = [u["sym"] for u in uni]
    refresh_quotes(ctx, syms)
    recompute(syms)
    print(f"first write: {write(uni)} symbols", flush=True)
    sb.push(sb.OUT)
    last_q = last_heal = last_push = time.time()
    last_stat = 0
    while time.time() < end:
        time.sleep(STEP)
        with lock:
            dirty = list(DIRTY); DIRTY.clear()
        n = recompute(dirty) if dirty else 0
        now = time.time()
        if now - last_q > 30:
            refresh_quotes(ctx, syms); last_q = now; n = n or 1
        if n and now - last_push >= MIN_PUSH:
            write(uni); sb.push(sb.OUT); last_push = now
        if now - STAT["last"] > SILENT_RESUB:
            print("::warning::no push events — resubscribing", flush=True)
            STAT["last"] = now
            try:
                with ThreadPoolExecutor(5) as ex:
                    list(ex.map(lambda s: subscribe(ctx, s), syms))
            except Exception as ex:
                print(f"::warning::resubscribe failed: {ex}", flush=True)
        if now - last_heal > HEAL_EVERY:
            threading.Thread(target=heal, args=(ctx, syms), daemon=True).start(); last_heal = now
        if now - last_stat > 60:
            print(f"stat events={STAT['events']} dirty={len(dirty)} analysed={n} lag_last_event={now-STAT['last']:.0f}s", flush=True)
            last_stat = now
    write(uni); sb.push(sb.OUT)


if __name__ == "__main__":
    main()
