"""測試 Longbridge K 線推送：夜盤有冇推？訂閱上限？推送頻率？（一次性探針）"""
import os, sys, time, collections, threading
os.environ.setdefault("LONGBRIDGE_ENABLE_OVERNIGHT", "true")
sys.path.insert(0, os.path.dirname(__file__))
from longbridge.openapi import Config, Period, QuoteContext, TradeSessions
import signal_board as sb

ctx = QuoteContext(Config.from_apikey_env())
lock = threading.Lock()
ev = []          # (t, sym, session, ts, close, vol, confirmed)
def on_c(sym, e):
    c = e.candlestick
    with lock:
        ev.append((time.time(), sym, str(getattr(c, "trade_session", "?")), str(c.timestamp), float(c.close), float(c.volume),
                   getattr(e, "is_confirmed", None)))
ctx.set_on_candlestick(on_c)

def sub(sym):
    try:
        ctx.subscribe_candlesticks(sym, Period.Min_5, TradeSessions.All)
    except TypeError:
        ctx.subscribe_candlesticks(sym, Period.Min_5)

def report(tag, since, secs):
    with lock:
        es = [x for x in ev if x[0] >= since]
    syms = collections.Counter(x[1] for x in es)
    sess = collections.Counter(x[2] for x in es)
    print(f"[{tag}] {len(es)} events in {secs:.0f}s ({len(es)/max(secs,1):.1f}/s), {len(syms)} symbols, sessions={dict(sess)}, confirmed={collections.Counter(x[6] for x in es)}", flush=True)
    for x in es[:6]:
        print("   ", time.strftime("%H:%M:%S", time.gmtime(x[0])), *x[1:], flush=True)
    return syms

# A: 5 隻
t0 = time.time()
small = ["NVDA.US", "AMD.US", "INTC.US", "BABA.US", "FUTU.US"]
for s in small:
    sub(s)
print("subscribed 5", flush=True)
time.sleep(120)
report("A:5 symbols", t0, time.time() - t0)

# B: 全 universe，睇上限
syms = [f"{u['sym']}.US" for u in sb.universe()]
ok, fail = 0, None
t1 = time.time()
for s in syms:
    if s in small:
        ok += 1; continue
    try:
        sub(s); ok += 1
    except Exception as e:
        fail = (ok, s, repr(e)[:300]); break
    time.sleep(0.12)
print(f"B: subscribed {ok}/{len(syms)} in {time.time()-t1:.0f}s fail={fail}", flush=True)
try:
    print("subscriptions():", len(ctx.subscriptions()), flush=True)
except Exception as e:
    print("subscriptions() err", repr(e)[:200], flush=True)
t2 = time.time()
time.sleep(180)
cov = report("B:full", t2, time.time() - t2)
print(f"coverage {len(cov)}/{ok}; max events/symbol={max(cov.values()) if cov else 0}", flush=True)
