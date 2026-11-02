"""Actions 內跑：攞 Longbridge 15m/5m 棒，印出訊號列表（用嚟對 TradingView 截圖）。
用法：python scanner/signal_calibrate.py BABA.US 15m"""
import os, sys
import pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
import intraday_signals as S

sym = sys.argv[1] if len(sys.argv) > 1 else "BABA.US"
tf = sys.argv[2] if len(sys.argv) > 2 else "15m"
period = {"5m": Period.Min_5, "15m": Period.Min_15}[tf]
sess = TradeSessions.All if os.getenv("SESS", "intraday") == "all" else TradeSessions.Intraday
ctx = QuoteContext(Config.from_apikey_env())
bars = ctx.candlesticks(sym, period, 1000, AdjustType.NoAdjust, sess)
df = pd.DataFrame({"Open": [float(b.open) for b in bars], "High": [float(b.high) for b in bars],
                   "Low": [float(b.low) for b in bars], "Close": [float(b.close) for b in bars],
                   "Volume": [float(b.volume) for b in bars]},
                  index=pd.to_datetime([b.timestamp for b in bars]))
print(f"{sym} {tf} bars={len(df)} {df.index[0]} → {df.index[-1]} (timestamps as returned)")
for e in S.signals_for(df)[-80:]:
    print(f"SIG {e['t']} {e['kind']} {e.get('tier','')} {e.get('ext','')}")
bi, bv, si, sv = S.heavy_now(df)
print(f"HEAVY buy {df.index[bi] if bi is not None else None} {bv:.0f} | sell {df.index[si] if si is not None else None} {sv:.0f}")
