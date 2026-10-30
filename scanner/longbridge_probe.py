#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
longbridge_probe.py — 測試你個 Longbridge 帳戶夠唔夠做「即時訊號」
=====================================================================
唯讀。淨係用 QuoteContext，唔會 call 任何 trade / 帳戶 API，唔落單。

回答 5 條問題（每條一個 test）：
  T1  你個帳戶開咗乜行情權限？（HK 係咪真·即時，定係延遲15分鐘）
  T2  quote() 嘅時間戳有幾新？（開市期間 age 應該 < 數秒；HK 延遲會見到 ~900s）
  T3  日線歷史 K 線攞得幾多隻？（有月度 unique-symbol 配額；你係 100 定 3000？）
  T4  同 yfinance 嘅日線 Close 對唔對得上？（backtest 用 yfinance，信號要同 parity）
  T5  WebSocket push（quote + 1分鐘K線）收唔收到、延遲幾多？（要開市期間先有意義）

執行（要 Python 3.9+，因為用 zoneinfo）：
    python -m pip install longbridge yfinance pandas tzdata     # tzdata 係 Windows 要裝
    export LONGBRIDGE_APP_KEY=...
    export LONGBRIDGE_APP_SECRET=...
    export LONGBRIDGE_ACCESS_TOKEN=...
    python scanner/longbridge_probe.py

  或用 OAuth：  export LONGBRIDGE_CLIENT_ID=...   （會彈瀏覽器授權）

常用參數：
    --n-hist 30          T3 測幾多隻 unique symbol（預設 30）
    --push-seconds 45    T5 收 push 幾耐（預設 45 秒）
    --skip-push          唔測 T5（收市時段冇意義，直接跳過）
    --out report.json    完整結果寫入 JSON

幾時行先有意義：
    T1 T3 T4  任何時間都得（週末都得）
    T2 T5     要開市：港股 09:30–16:00 HKT；美股（冬令）22:30–05:00 HKT
              收市嗰陣 T2 只會見到上一個收市價，T5 會 0 個 event —— 唔係壞咗。

**Token 唔會印出嚟，亦唔好貼落任何 chat / commit。**
"""
import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from longbridge.openapi import (AdjustType, Config, OAuthBuilder, Period,
                                    QuoteContext, SubType)
except ImportError:
    sys.exit("先裝 SDK：pip install longbridge")

MARKET_TZ = {"US": ZoneInfo("America/New_York"), "HK": ZoneInfo("Asia/Hong_Kong")}

# 固定樣本：T2 / T5 用。美股 mega-cap + 港股大價 + 指數 ETF
QUOTE_SAMPLE = ["AAPL.US", "NVDA.US", "TSLA.US", "SPY.US",
                "700.HK", "9988.HK", "5.HK", "2800.HK"]
PUSH_SAMPLE_US = ["AAPL.US", "NVDA.US", "SPY.US"]
PUSH_SAMPLE_HK = ["700.HK", "9988.HK", "2800.HK"]
FALLBACK_HIST = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD",
                 "AVGO", "NFLX", "COST", "ADBE", "CRM", "ORCL", "INTC", "QCOM",
                 "PYPL", "UBER", "SHOP", "SNOW", "PLTR", "COIN", "SQ", "ROKU",
                 "DIS", "BA", "NKE", "SBUX", "MCD", "KO", "PEP", "WMT", "HD"]


# ───────────────────────── helpers ─────────────────────────
def lb_symbol(yf_ticker):
    """yfinance ticker → Longbridge symbol。解唔到就 None（唔估）。
    AAPL→AAPL.US · BRK-B→BRK.B.US · 0700.HK→700.HK · ^GSPC / GC=F / 0700.KS→None"""
    t = yf_ticker.strip().upper()
    if not t or t.startswith("^") or "=" in t:
        return None
    if t.endswith(".HK"):
        num = t[:-3]
        return f"{int(num)}.HK" if num.isdigit() else None
    if "." in t:                      # .KS .AX .TO ... 唔係美股 / 港股
        return None
    return t.replace("-", ".") + ".US"


def market_of(sym):
    return "HK" if sym.endswith(".HK") else "US"


def market_open(sym, now_utc=None):
    """粗略開市判斷（唔識假期）。"""
    mk = market_of(sym)
    now = (now_utc or datetime.now(timezone.utc)).astimezone(MARKET_TZ[mk])
    if now.weekday() >= 5:
        return False
    hm = (now.hour, now.minute)
    if mk == "US":
        return (9, 30) <= hm < (16, 0)
    return (9, 30) <= hm < (12, 0) or (13, 0) <= hm < (16, 0)


def to_utc(ts):
    if isinstance(ts, datetime):
        return ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts.astimezone(timezone.utc)
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, timezone.utc)
    return None


def bar_date(ts, sym):
    """日線 K 棒嘅交易所本地日期。US 日線 timestamp = ET 午夜（UTC 表示），
    HK = HKT 午夜（即前一日 16:00 UTC），所以一定要轉返交易所時區先攞 date。"""
    u = to_utc(ts)
    return u.astimezone(MARKET_TZ[market_of(sym)]).date() if u else None


def err_str(e):
    return f"{type(e).__name__}: {e}"


class Report:
    def __init__(self):
        self.data = {"started_at": datetime.now(timezone.utc).isoformat(), "tests": {}}
        self.lines = []

    def add(self, level, msg):
        self.lines.append((level, msg))
        print(f"  [{level}] {msg}")

    def section(self, name):
        print(f"\n── {name} " + "─" * max(0, 60 - len(name)))


# ───────────────────────── config ─────────────────────────
def build_config():
    if os.getenv("LONGBRIDGE_APP_KEY") and os.getenv("LONGBRIDGE_APP_SECRET") \
            and os.getenv("LONGBRIDGE_ACCESS_TOKEN"):
        return Config.from_apikey_env()
    if os.getenv("LONGBRIDGE_CLIENT_ID"):
        oauth = OAuthBuilder(os.environ["LONGBRIDGE_CLIENT_ID"]).build(
            lambda url: print(f"請喺瀏覽器開呢個網址授權：\n  {url}"))
        return Config.from_oauth(oauth)
    sys.exit("冇 credentials。設 LONGBRIDGE_APP_KEY / _APP_SECRET / _ACCESS_TOKEN，"
             "或者 LONGBRIDGE_CLIENT_ID（OAuth）。")


# ───────────────────────── tests ─────────────────────────
def t1_permissions(ctx, rep):
    rep.section("T1 行情權限")
    out = {}
    try:
        out["member_id"] = ctx.member_id()
        out["quote_level"] = ctx.quote_level()
        pk = []
        for p in ctx.quote_package_details():
            pk.append({"key": p.key, "name": p.name, "description": p.description,
                       "start_at": str(p.start_at), "end_at": str(p.end_at)})
        out["packages"] = pk
        rep.add("INFO", f"member_id={out['member_id']} · quote_level={out['quote_level']}")
        for p in pk:
            rep.add("INFO", f"package: {p['name']}  ({p['key']})  until {p['end_at']}")
        text = " ".join(f"{p['key']} {p['name']} {p['description']}".lower() for p in pk)
        has_hk = "hk" in text or "港" in text
        rep.add("OK" if has_hk else "WARN",
                "有 HK 行情 package" if has_hk else
                "package 清單冇見到 HK —— HK 可能只係延遲行情。去 App Quote Store 開「LV1 Real-time Quotes (OpenAPI)」")
    except Exception as e:
        out["error"] = err_str(e)
        rep.add("FAIL", f"攞權限失敗：{out['error']}")
    rep.data["tests"]["T1_permissions"] = out


def t2_quotes(ctx, rep):
    rep.section("T2 即時報價時間戳")
    out = {"symbols": {}}
    try:
        quotes = ctx.quote(QUOTE_SAMPLE)
    except Exception as e:
        out["error"] = err_str(e)
        rep.add("FAIL", f"quote() 失敗：{out['error']}")
        rep.data["tests"]["T2_quotes"] = out
        return
    now = datetime.now(timezone.utc)
    for q in quotes:
        u = to_utc(q.timestamp)
        age = (now - u).total_seconds() if u else None
        is_open = market_open(q.symbol, now)
        out["symbols"][q.symbol] = {
            "last_done": str(q.last_done), "timestamp": str(q.timestamp),
            "age_s": round(age, 1) if age is not None else None,
            "market_open_est": is_open, "trade_status": str(q.trade_status)}
        if age is None:
            lvl, note = "WARN", "冇 timestamp"
        elif not is_open:
            lvl, note = "INFO", f"收市中，最後成交 {age/3600:.1f} 小時前（正常）"
        elif age <= 60:
            lvl, note = "OK", f"開市，age {age:.0f}s —— 即時"
        elif age >= 600:
            lvl, note = "FAIL", f"開市但 age {age/60:.0f} 分鐘 —— 好似延遲行情"
        else:
            lvl, note = "WARN", f"開市，age {age:.0f}s —— 偏慢（冷門股都可能）"
        rep.add(lvl, f"{q.symbol:<9} last={q.last_done}  {note}")
    rep.data["tests"]["T2_quotes"] = out


def t3_history(ctx, symbols, rep):
    rep.section("T3 日線歷史 K 線 + 配額")
    out = {"requested": len(symbols), "ok": 0, "first_fail_index": None,
           "errors": [], "bars": {}, "sample_timestamps": {}}
    consecutive_fail = 0
    for i, sym in enumerate(symbols):
        t0 = time.time()
        try:
            bars = ctx.candlesticks(sym, Period.Day, 1000, AdjustType.ForwardAdjust)
            n = len(bars)
            out["bars"][sym] = n
            out["ok"] += 1
            consecutive_fail = 0
            if i == 0 and n:
                out["sample_timestamps"][sym] = {
                    "first": str(bars[0].timestamp), "last": str(bars[-1].timestamp)}
            if n < 400:
                rep.add("WARN", f"{sym}: 只有 {n} 支日線（EMA150/rU60 夠，但 <400 即係新股或被截斷）")
        except Exception as e:
            consecutive_fail += 1
            out["errors"].append({"index": i, "symbol": sym, "error": err_str(e)})
            if out["first_fail_index"] is None:
                out["first_fail_index"] = i
            rep.add("FAIL", f"#{i} {sym}: {err_str(e)}")
            if consecutive_fail >= 3:
                rep.add("FAIL", "連續 3 次失敗，停止（好可能撞到月度 symbol 配額）")
                break
        time.sleep(max(0.0, 0.12 - (time.time() - t0)))   # 保守 < 10 call/s

    full = sum(1 for n in out["bars"].values() if n >= 900)
    cap100 = sum(1 for n in out["bars"].values() if n == 100)
    rep.add("OK" if out["ok"] == len(symbols) else "WARN",
            f"{out['ok']}/{len(symbols)} 隻成功 · ≥900 支棒 {full} 隻")
    if cap100:
        rep.add("FAIL", f"{cap100} 隻只返 100 支棒 —— 呢個係低配額 tier 嘅特徵（已知 issue），"
                        "日線只夠 EMA30，唔夠 150/rU60 warm-up")
    # 一次 history_by_date 睇下係咪同一條配額
    try:
        d = ctx.history_candlesticks_by_offset(symbols[0], Period.Day, AdjustType.NoAdjust,
                                               False, 200)
        out["history_by_offset_ok"] = len(d)
        rep.add("OK", f"history_candlesticks_by_offset({symbols[0]}) → {len(d)} 支")
    except Exception as e:
        out["history_by_offset_error"] = err_str(e)
        rep.add("WARN", f"history_candlesticks_by_offset 失敗：{err_str(e)}")
    rep.data["tests"]["T3_history"] = out


def t4_parity(ctx, symbols, rep, n_syms=5, k=20):
    rep.section("T4 同 yfinance 日線對數")
    out = {"symbols": {}}
    try:
        import yfinance as yf
    except ImportError:
        rep.add("WARN", "未裝 yfinance，跳過（pip install yfinance）")
        rep.data["tests"]["T4_parity"] = {"skipped": "no yfinance"}
        return
    us = [s for s in symbols if market_of(s) == "US"][:n_syms]
    for sym in us:
        yft = sym[:-3].replace(".", "-")
        try:
            lb_raw = ctx.candlesticks(sym, Period.Day, 60, AdjustType.NoAdjust)
            lb_adj = ctx.candlesticks(sym, Period.Day, 60, AdjustType.ForwardAdjust)
            df = yf.download(yft, period="6mo", interval="1d", auto_adjust=False,
                             progress=False, threads=False)
            if df is None or df.empty:
                rep.add("WARN", f"{sym}: yfinance 冇數據")
                continue
            if hasattr(df.columns, "levels"):
                df.columns = df.columns.get_level_values(0)
            ycl = {d.date(): float(v) for d, v in df["Close"].dropna().items()}
            yadj = {d.date(): float(v) for d, v in df["Adj Close"].dropna().items()}

            def cmp(bars, ref):
                diffs, miss = [], 0
                for b in bars[-k:]:
                    d = bar_date(b.timestamp, sym)
                    if d in ref:
                        diffs.append(abs(float(b.close) / ref[d] - 1) * 100)
                    else:
                        miss += 1
                return diffs, miss

            d_raw, m_raw = cmp(lb_raw, ycl)
            d_adj, m_adj = cmp(lb_adj, yadj)
            out["symbols"][sym] = {
                "raw_vs_yf_close": {"matched": len(d_raw), "unmatched": m_raw,
                                    "max_diff_pct": round(max(d_raw), 4) if d_raw else None},
                "fwdadj_vs_yf_adjclose": {"matched": len(d_adj), "unmatched": m_adj,
                                          "max_diff_pct": round(max(d_adj), 4) if d_adj else None}}
            r = out["symbols"][sym]
            for key, label in (("raw_vs_yf_close", "NoAdjust vs Close"),
                               ("fwdadj_vs_yf_adjclose", "FwdAdjust vs AdjClose")):
                m = r[key]
                if not m["matched"]:
                    rep.add("WARN", f"{sym} {label}: 對唔到任何日期（timestamp 時區？睇 report JSON）")
                elif m["max_diff_pct"] <= 0.05:
                    rep.add("OK", f"{sym} {label}: {m['matched']} 日 · 最大差 {m['max_diff_pct']}%")
                else:
                    rep.add("WARN", f"{sym} {label}: 最大差 {m['max_diff_pct']}% （{m['matched']} 日）")
        except Exception as e:
            rep.add("WARN", f"{sym}: parity 失敗 {err_str(e)}")
    rep.data["tests"]["T4_parity"] = out


def t5_push(ctx, seconds, rep):
    rep.section(f"T5 WebSocket push（{seconds}s）")
    lock = threading.Lock()
    quotes, bars = {}, {}

    def on_quote(symbol, ev):
        now = datetime.now(timezone.utc)
        u = to_utc(ev.timestamp)
        with lock:
            r = quotes.setdefault(symbol, {"n": 0, "lat": []})
            r["n"] += 1
            if u:
                r["lat"].append((now - u).total_seconds())
            r["last"] = str(ev.last_done)

    def on_bar(symbol, ev):
        with lock:
            r = bars.setdefault(symbol, {"n": 0, "confirmed": 0})
            r["n"] += 1
            if getattr(ev, "is_confirmed", False):
                r["confirmed"] += 1

    out = {"seconds": seconds}
    try:
        ctx.set_on_quote(on_quote)
        ctx.set_on_candlestick(on_bar)
        syms = PUSH_SAMPLE_US + PUSH_SAMPLE_HK
        ctx.subscribe(syms, [SubType.Quote])
        ctx.subscribe_candlesticks(PUSH_SAMPLE_US[0], Period.Min_1)
        ctx.subscribe_candlesticks(PUSH_SAMPLE_HK[0], Period.Min_1)
        out["subscribed"] = syms
        time.sleep(seconds)
        try:
            ctx.unsubscribe(syms, [SubType.Quote])
        except Exception:
            pass
    except Exception as e:
        out["error"] = err_str(e)
        rep.add("FAIL", f"subscribe 失敗：{out['error']}")
        rep.data["tests"]["T5_push"] = out
        return

    any_open = {mk: any(market_open(s) for s in syms if market_of(s) == mk) for mk in ("US", "HK")}
    for mk, group in (("US", PUSH_SAMPLE_US), ("HK", PUSH_SAMPLE_HK)):
        total = sum(quotes.get(s, {}).get("n", 0) for s in group)
        lats = [x for s in group for x in quotes.get(s, {}).get("lat", [])]
        med = sorted(lats)[len(lats) // 2] if lats else None
        out[mk] = {"quote_events": total, "median_latency_s": round(med, 2) if med is not None else None}
        if not any_open[mk]:
            rep.add("INFO", f"{mk}: 收市，{total} 個 quote event（冇 push 係正常；開市時再行）")
        elif total == 0:
            rep.add("FAIL", f"{mk}: 開市但 {seconds}s 內 0 個 push —— "
                            + ("HK 好可能係延遲行情冇 push，要買 LV1 (OpenAPI)" if mk == "HK"
                               else "檢查 US 權限 / 連線"))
        else:
            rep.add("OK", f"{mk}: {total} 個 quote push · 中位延遲 "
                          f"{round(med, 2) if med is not None else 'n/a'}s")
    for s, r in bars.items():
        rep.add("INFO", f"1m K 線 push {s}: {r['n']} 次（其中 confirmed {r['confirmed']}）")
    out["candlestick_events"] = bars
    rep.data["tests"]["T5_push"] = out


# ───────────────────────── main ─────────────────────────
def pick_hist_symbols(n, watchlist):
    syms = []
    if watchlist and Path(watchlist).exists():
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from indicator_scan import parse_watchlist       # 同 repo 同一個 parser
            for e in parse_watchlist(Path(watchlist)):
                s = lb_symbol(e["ticker"]) if e["ticker"] else None
                if s and s not in syms:
                    syms.append(s)
        except Exception as ex:
            print(f"  讀 {watchlist} 失敗（{ex}），用內置樣本")
    if not syms:
        syms = [lb_symbol(t) for t in FALLBACK_HIST]
    return syms[:n]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n-hist", type=int, default=30)
    ap.add_argument("--push-seconds", type=int, default=45)
    ap.add_argument("--skip-push", action="store_true")
    ap.add_argument("--watchlist", default=str(Path(__file__).resolve().parent / "Watchlists.txt"))
    ap.add_argument("--out", default="longbridge_probe_report.json")
    args = ap.parse_args()

    print("Longbridge probe · 唯讀 · 唔會落單")
    cfg = build_config()
    try:
        ctx = QuoteContext(cfg)
    except Exception as e:
        sys.exit(f"連唔到 Longbridge：{err_str(e)}")

    rep = Report()
    hist_syms = pick_hist_symbols(args.n_hist, args.watchlist)
    t1_permissions(ctx, rep)
    t2_quotes(ctx, rep)
    t3_history(ctx, hist_syms, rep)
    t4_parity(ctx, hist_syms, rep)
    if args.skip_push:
        print("\n(跳過 T5)")
    else:
        t5_push(ctx, args.push_seconds, rep)

    rep.data["finished_at"] = datetime.now(timezone.utc).isoformat()
    rep.data["summary"] = [{"level": l, "msg": m} for l, m in rep.lines]
    Path(args.out).write_text(json.dumps(rep.data, indent=2, ensure_ascii=False, default=str),
                              encoding="utf-8")
    counts = {lv: sum(1 for l, _ in rep.lines if l == lv) for lv in ("OK", "WARN", "FAIL")}
    print(f"\n完成 · OK {counts['OK']} · WARN {counts['WARN']} · FAIL {counts['FAIL']} → {args.out}")
    print("請將上面成段輸出貼畀我（唔包含 token，唔需要貼 JSON）。")


if __name__ == "__main__":
    main()
