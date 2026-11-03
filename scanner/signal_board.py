#!/usr/bin/env python3
"""
signal_board.py — Signal Board 數據：Watchlists.txt 美股 × (15m,5m)，
用 Longbridge 棒（含盤前盤後夜盤）計 TB/TS、UT、Heavy，輸出 signals.json。

環境變數：LONGBRIDGE_APP_KEY/_APP_SECRET/_ACCESS_TOKEN；
  LONGBRIDGE_ENABLE_OVERNIGHT=true（夜盤棒要呢個）
  SB_TFS=15m,5m   SB_NEAR=6（接近區間，棒數）  SB_FRESH=24（保留幾多棒內嘅事件）
  SB_LIMIT=0（測試用，只跑頭 N 隻）
輸出：frontend/public/signals.json
"""
import json, os, re, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("LONGBRIDGE_ENABLE_OVERNIGHT", "true")
from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
from indicator_scan import parse_watchlist
import intraday_signals as S

TFS = [t for t in os.getenv("SB_TFS", "15m,5m").split(",") if t]
NEAR = int(os.getenv("SB_NEAR", "6"))
FRESH = int(os.getenv("SB_FRESH", "24"))
LIMIT = int(os.getenv("SB_LIMIT", "0") or 0)
PERIOD = {"15m": Period.Min_15, "5m": Period.Min_5}
BARS = 500
RATE = float(os.getenv("SB_RATE", "9"))                       # 每秒最多幾個 candlestick call
THREADS = int(os.getenv("SB_THREADS", "5"))   # Longbridge 同時最多 5 個請求
PARTS = int(os.getenv("SB_PARTS", "4"))       # 每輪分幾次中途推
OUT = Path(os.getenv("SB_OUT") or Path(__file__).resolve().parent.parent / "frontend" / "public" / "signals.json")
INGEST_NAME = os.getenv("SB_INGEST_NAME", "signals.json")
US_OK = re.compile(r"^[A-Z]{1,5}$")

BULL = {"TB": "TB", "UTB": "UT", "HB": "HEAVY"}
BEAR = {"TS": "TB", "UTS": "UT", "HS": "HEAVY"}

_lock = threading.Lock(); _next = [0.0]


def _throttle():
    with _lock:
        now = time.time(); t = max(now, _next[0]); _next[0] = t + 1 / RATE
    if t > now:
        time.sleep(t - now)


def universe():
    only = [x.strip().upper() for x in os.getenv("SB_SYMS", "").split(",") if x.strip()]
    if only:
        return [{"sym": t, "section": "TEST"} for t in only]
    seen, out = set(), []
    for r in parse_watchlist(Path(__file__).with_name("Watchlists.txt")):
        t = r["ticker"]
        if not t or t.endswith(".HK") or not US_OK.match(t) or t in seen:
            continue
        seen.add(t); out.append({"sym": t, "section": r["section"]})
    return out[:LIMIT] if LIMIT else out


DFC = {}            # (sym, tf) → (DataFrame, 上次全量拎嘅時間)；之後只拎最新幾十棒再合併，大幅減少每個 call 嘅數據量
INC = int(os.getenv("SB_INC", "40"))
FULL_EVERY = 3600


def _df(bars):
    return pd.DataFrame(
        {"Open": [float(b.open) for b in bars], "High": [float(b.high) for b in bars],
         "Low": [float(b.low) for b in bars], "Close": [float(b.close) for b in bars],
         "Volume": [float(b.volume) for b in bars]},
        index=pd.to_datetime([b.timestamp for b in bars]))


def fetch(ctx, sym, tf):
    key = (sym, tf)
    old = DFC.get(key)
    for k in range(3):
        try:
            _throttle()
            inc = bool(old) and time.time() - old[1] < FULL_EVERY
            bars = ctx.candlesticks(f"{sym}.US", PERIOD[tf], INC if inc else BARS, AdjustType.NoAdjust, TradeSessions.All)
            if not bars:
                return None
            new = _df(bars)
            if inc:
                if new.index[0] > old[0].index[-1]:      # 有缺口（斷咗太耐）→ 重新全量
                    old = None
                    continue
                df = pd.concat([old[0], new])
                df = df[~df.index.duplicated(keep="last")].sort_index().tail(BARS)
                DFC[key] = (df, old[1])
                return df
            DFC[key] = (new, time.time())
            return new
        except Exception as e:           # 限流 / 暫時錯 → 退避重試
            time.sleep(1.5 * (k + 1))
            err = e
    print(f"::warning::{sym} {tf}: {err}")
    return None


def analyse(df):
    n = len(df)
    if n < 120:
        return None
    ev = S.triple_band(df) + S.ut_events(df)
    last = {}
    for e in ev:                          # 每種事件只保留最新一個
        ago = n - 1 - e["i"]
        if ago <= FRESH:
            k = e["kind"]
            if k not in last or e["i"] > last[k]["i"]:
                last[k] = {**e, "ago": ago}
    bi, bv, si, sv = S.heavy_now(df)
    if bi is not None and n - 1 - bi <= FRESH:
        last["HB"] = {"i": bi, "kind": "HB", "ago": n - 1 - bi, "val": round(bv)}
    if si is not None and n - 1 - si <= FRESH:
        last["HS"] = {"i": si, "kind": "HS", "ago": n - 1 - si, "val": round(sv)}

    def score(side):
        got = {grp: min(last[k]["ago"] for k in last if side.get(k) == grp) for grp in set(side.values())
               if any(side.get(k) == grp for k in last)}
        near = {g: a for g, a in got.items() if a <= NEAR}
        return len(near), sorted(near)
    bs, bg = score(BULL); ss, sg = score(BEAR)
    pos = S.ut_bot(df)[1]
    return {
        "t": str(df.index[-1]), "px": round(float(df["Close"].iloc[-1]), 4),
        "ut_pos": int(pos[-1]),
        "ev": [{"k": e["kind"], "ago": e["ago"], "t": str(df.index[e["i"]]),
                **({"tier": e["tier"]} if "tier" in e else {}),
                **({"val": e["val"]} if "val" in e else {})}
               for e in sorted(last.values(), key=lambda x: x["ago"])],
        "bull": bs, "bear": ss, "bull_g": bg, "bear_g": sg,
    }


def session_of(ts):
    """bar 時間（UTC naive）→ 美東時段"""
    from zoneinfo import ZoneInfo
    t = pd.Timestamp(ts).tz_localize("UTC").tz_convert(ZoneInfo("America/New_York"))
    m = t.hour * 60 + t.minute
    if 570 <= m < 960: return "盤中"
    if 240 <= m < 570: return "盤前"
    if 960 <= m < 1200: return "盤後"
    return "夜盤"


_FAST = [False]; _LAST_PUSH = [0.0]


def push(path):
    """PUT 去私人 gateway（等同 push_private.sh，但循環入面直接做）"""
    import urllib.request
    gw, tok = os.getenv("GATEWAY_URL", "").rstrip("/"), os.getenv("INGEST_TOKEN", "")
    if not gw or not tok:
        return
    # Worker 回 store:"do" 先用高頻；仲係 KV（免費版每日 1,000 寫）就每 5 分鐘先推一次，免得用爆額度
    if not _FAST[0] and time.time() - _LAST_PUSH[0] < 300:
        return
    _LAST_PUSH[0] = time.time()
    req = urllib.request.Request(f"{gw}/_ingest/{INGEST_NAME}", data=Path(path).read_bytes(), method="PUT",
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                                          "User-Agent": "curl/8.5.0", "Accept": "*/*"})   # Cloudflare 會擋 Python-urllib UA
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "ignore")
            _FAST[0] = '"store":"do"' in body
            print(f"push {r.status} {time.strftime('%H:%M:%S')} {'fast' if _FAST[0] else 'slow(kv)'}", flush=True)
    except Exception as e:
        body = getattr(e, "read", lambda: b"")()[:200]
        print(f"::warning::push failed: {e} {body}", flush=True)


def main():
    ctx = QuoteContext(Config.from_apikey_env())
    loop_s = float(os.getenv("SB_LOOP_SECS", "0") or 0)       # 0 = 跑一次
    every = float(os.getenv("SB_INTERVAL", "30") or 30)
    end = time.time() + loop_s
    while True:
        t0 = time.time()
        try:
            run_once(ctx, push if loop_s else None)
            if loop_s:
                push(OUT)
        except Exception as e:                                 # 一輪錯唔好搞死成個循環
            print(f"::warning::round failed: {e}")
        if time.time() + every >= end:
            break
        time.sleep(max(1.0, every - (time.time() - t0)))


CACHE = {}          # sym → {tf: analyse 結果}；每輪逐步覆寫，所以中途 publish 都有齊全部股票


def run_once(ctx, on_write=None):
    uni = universe()
    syms = [u["sym"] for u in uni]
    quotes = {}
    for i in range(0, len(syms), 400):
        try:
            for q in ctx.quote([f"{s}.US" for s in syms[i:i + 400]]):
                quotes[q.symbol.rsplit(".", 1)[0]] = (float(q.last_done), float(q.prev_close))
        except Exception as e:
            print(f"::warning::quote batch failed: {e}")
    jobs = [(u, tf) for u in uni for tf in TFS]

    def work(j):
        u, tf = j
        df = fetch(ctx, u["sym"], tf)
        return u["sym"], tf, (analyse(df) if df is not None else None)

    def write():
        rows = []
        for u in uni:
            s = u["sym"]
            r = CACHE.get(s)
            if not r:
                continue
            ld, pc = quotes.get(s, (None, None))
            d = r.get("15m") or r.get(TFS[0]) or next(iter(r.values()))
            px, sess = d["px"], session_of(d["t"])
            # 盤中：對上日收市；盤前/盤後/夜盤：對最近一個正式收市（last_done）
            ref = pc if sess == "盤中" else ld
            chg = round((px / ref - 1) * 100, 2) if ref else None
            rows.append({"sym": s, "section": u["section"], "px": px, "chg": chg,
                         "sess": sess, "reg": ld, "pc": pc, **r})
        out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "near": NEAR, "fresh": FRESH, "tfs": TFS, "n": len(rows), "rows": rows}
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
        return len(rows)

    t0 = time.time(); step = max(1, len(jobs) // PARTS); done = 0
    with ThreadPoolExecutor(THREADS) as ex:
        for sym, tf, r in ex.map(work, jobs):        # 按次序出結果
            if r:
                CACHE.setdefault(sym, {})[tf] = r
            done += 1
            if on_write and done % step == 0 and done < len(jobs):
                write(); on_write(OUT)               # 中途先推一次，唔使等成輪
    n = write()
    print(f"signals.json: {n}/{len(uni)} symbols, {OUT.stat().st_size/1024:.0f} KB, round {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
