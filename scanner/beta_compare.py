#!/usr/bin/env python3
"""Longbridge（forward-adjust 日線）vs yfinance（調整／未調整）beta 對比：同一批日期、同一基準、簡單日報酬回歸。"""
import json, os
import numpy as np, pandas as pd, yfinance as yf

here = os.path.dirname(os.path.abspath(__file__))
LB = json.load(open(os.path.join(here, "beta_compare_lb.json")))

def parse(s):
    d = {}
    for tok in s.split():
        k, v = tok.split(":")
        d[pd.Timestamp(f"2026-{k[:2]}-{k[2:]}")] = float(v)
    return pd.Series(d).sort_index()

def beta(y, x):
    r = pd.concat([y.pct_change(), x.pct_change()], axis=1).dropna()
    r.columns = ["y", "x"]
    c = np.cov(r.y, r.x)
    return c[0, 1] / c[1, 1], len(r), r.corr().iloc[0, 1]

def yf_close(sym, adj):
    d = yf.download(sym, start="2026-05-01", end="2026-11-13", interval="1d", progress=False, auto_adjust=adj)["Close"].squeeze().dropna()
    d.index = d.index.tz_localize(None) if d.index.tz is not None else d.index
    return d

PAIRS = [("NVDA", "SPY", "NVDA"), ("AAPL", "SPY", "AAPL"), ("TSLA", "SPY", "TSLA"), ("KO", "SPY", "KO"), ("JPM", "SPY", "JPM"),
         ("0700.HK", "2800.HK", "0700.HK"), ("9988.HK", "2800.HK", "9988.HK"), ("1299.HK", "2800.HK", "1299.HK"),
         ("0941.HK", "2800.HK", "0941.HK"), ("3690.HK", "2800.HK", "3690.HK")]
rows = []
for lbk, bk, ysym in PAIRS:
    s_lb, b_lb = parse(LB[lbk]), parse(LB[bk])
    common = s_lb.index.intersection(b_lb.index)
    s_lb, b_lb = s_lb[common], b_lb[common]
    try:
        sa, ba = yf_close(ysym, True), yf_close(bk, True)
        su, bu = yf_close(ysym, False), yf_close(bk, False)
    except Exception as e:  # noqa: BLE001
        print(lbk, "yf fail", e); continue
    cm = common.intersection(sa.index).intersection(ba.index)
    b1, n1, c1 = beta(s_lb[cm], b_lb[cm])
    b2, _, c2 = beta(sa[cm], ba[cm])
    b3, _, _ = beta(su[cm], bu[cm])
    diff = (s_lb[cm] / sa[cm] - 1).abs().max() * 100
    diffu = (s_lb[cm] / su[cm] - 1).abs().max() * 100
    rows.append({"stock": lbk, "bench": bk, "n_ret": n1, "beta_LB": round(b1, 3), "beta_YF_adj": round(b2, 3),
                 "beta_YF_unadj": round(b3, 3), "LB-YFadj": round(b1 - b2, 3), "corr_LB": round(c1, 3),
                 "maxPxDiff%_vs_adj": round(diff, 2), "maxPxDiff%_vs_unadj": round(diffu, 2)})
df = pd.DataFrame(rows)
pd.set_option("display.width", 250)
print(df.to_string(index=False))
print("\nmean |LB - YFadj| =", round(df["LB-YFadj"].abs().mean(), 4), " max =", round(df["LB-YFadj"].abs().max(), 4))
