"""
OptionScope Scanner — GitHub Actions Edition
Scans S&P 100 for high IV + strong trend stocks
Outputs: frontend/public/results.json  (served via GitHub Pages)
"""

import yfinance as yf
import numpy as np
import pandas as pd
from scipy.stats import norm
from scipy.optimize import brentq
import math
import json
import os
import time
from datetime import datetime, date
import warnings
warnings.filterwarnings("ignore")

# ─── TICKER LIST ──────────────────────────────────────────────────────────────
# S&P 100 — best options liquidity
SP100 = [
    "AAPL","MSFT","AMZN","NVDA","GOOGL","META","TSLA","JPM","V","UNH",
    "XOM","JNJ","MA","PG","HD","CVX","MRK","ABBV","LLY","AVGO",
    "PEP","COST","KO","WMT","MCD","TMO","CSCO","ACN","ABT","BAC",
    "PFE","CRM","DHR","TXN","ORCL","NEE","NKE","ADBE","RTX","QCOM",
    "HON","PM","LOW","CAT","UNP","AMD","SPGI","GS","MS","BLK",
    "AMGN","SBUX","GILD","AXP","BMY","BA","ISRG","LMT","ADP","VRTX",
    "REGN","ZTS","CI","CB","SO","DUK","BDX","EOG","MO","NSC",
    "PLD","WM","ELV","SHW","ITW","TGT","ETN","AON","GD","HCA",
    "KLAC","PANW","SNPS","CDNS","AMAT","LRCX","MCHP","NXPI","FTNT","INTU",
    "NOW","UBER","COIN","MU","PLTR","AMD","IONQ","MARA","GME","SOFI",
]
# Deduplicate
SP100 = list(dict.fromkeys(SP100))

MIN_IV = float(os.environ.get("MIN_IV", "0"))

# ─── BLACK-SCHOLES ─────────────────────────────────────────────────────────────
def bs_price(S, K, T, r, sigma, opt="call"):
    if T <= 0 or sigma <= 0:
        return max(0, S-K) if opt=="call" else max(0, K-S)
    d1 = (math.log(S/K) + (r + 0.5*sigma**2)*T) / (sigma*math.sqrt(T))
    d2 = d1 - sigma*math.sqrt(T)
    if opt == "call":
        return S*norm.cdf(d1) - K*math.exp(-r*T)*norm.cdf(d2)
    return K*math.exp(-r*T)*norm.cdf(-d2) - S*norm.cdf(-d1)

def implied_vol(market_price, S, K, T, r=0.05, opt="call"):
    if T <= 0 or market_price <= 0:
        return None
    try:
        intrinsic = max(0, S-K) if opt=="call" else max(0, K-S)
        if market_price <= intrinsic:
            return None
        iv = brentq(
            lambda s: bs_price(S, K, T, r, s, opt) - market_price,
            1e-6, 20.0, xtol=1e-4, maxiter=100
        )
        return iv if 0.01 <= iv <= 10.0 else None
    except:
        return None

# ─── TECHNICAL INDICATORS ──────────────────────────────────────────────────────
def calc_rsi(closes, period=14):
    delta = closes.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(span=period, adjust=False).mean().iloc[-1]
    avg_loss = loss.ewm(span=period, adjust=False).mean().iloc[-1]
    if avg_loss == 0:
        return 100.0
    return round(100 - (100 / (1 + avg_gain/avg_loss)), 1)

def calc_adx(high, low, close, period=14):
    try:
        tr = pd.concat([high-low, (high-close.shift()).abs(), (low-close.shift()).abs()], axis=1).max(axis=1)
        dm_p = np.where((high.diff()>low.diff().abs())&(high.diff()>0), high.diff(), 0)
        dm_m = np.where((low.diff().abs()>high.diff())&(low.diff()<0), low.diff().abs(), 0)
        tr_s  = pd.Series(tr).ewm(span=period, adjust=False).mean()
        dmp_s = pd.Series(dm_p).ewm(span=period, adjust=False).mean()
        dmm_s = pd.Series(dm_m).ewm(span=period, adjust=False).mean()
        di_p  = 100 * dmp_s / tr_s.replace(0, np.nan)
        di_m  = 100 * dmm_s / tr_s.replace(0, np.nan)
        dx    = 100 * (di_p - di_m).abs() / (di_p + di_m).replace(0, np.nan)
        adx   = dx.ewm(span=period, adjust=False).mean().iloc[-1]
        return round(float(adx) if not np.isnan(adx) else 0, 1)
    except:
        return 0.0

def calc_risk_reversal(close):
    """0=strong bearish, 100=strong bullish (EMA alignment score)"""
    ema9  = close.ewm(span=9,  adjust=False).mean().iloc[-1]
    ema21 = close.ewm(span=21, adjust=False).mean().iloc[-1]
    ema50 = close.ewm(span=50, adjust=False).mean().iloc[-1]
    price = close.iloc[-1]
    score = 50.0
    if ema9 > ema21 > ema50:   score += 20
    elif ema9 < ema21 < ema50: score -= 20
    score += 10 if price > ema21 else -10
    score += 10 if price > ema50 else -10
    ret10 = (price - close.iloc[-11]) / close.iloc[-11] if len(close) > 11 else 0
    score += min(15, max(-15, ret10 * 200))
    return round(min(99, max(1, score)), 1)

def get_quadrant(iv_rank, rr):
    high_iv = iv_rank >= 50
    bullish  = rr >= 50
    if high_iv and bullish:
        return {"label":"Expensive Vol · Bullish", "strategies":["Bull Put Spread","Short Put"],             "color":"#00d4aa","bg":"#0a3d2e"}
    if high_iv and not bullish:
        return {"label":"Expensive Vol · Bearish", "strategies":["Bear Call Spread","Iron Condor"],          "color":"#ff8c42","bg":"#3d1a0a"}
    if not high_iv and bullish:
        return {"label":"Cheap Vol · Bullish",     "strategies":["Bull Call Debit Spread","Long Call"],      "color":"#3b9eff","bg":"#0a1f3d"}
    return         {"label":"Cheap Vol · Bearish", "strategies":["Bear Put Debit Spread","Long Put"],        "color":"#cc77ff","bg":"#2a0a2a"}

WIN_RATES = {
    "Bull Put Spread":"~62%","Short Put":"~70%","Bear Call Spread":"~63%","Iron Condor":"~68%",
    "Bull Call Debit Spread":"~45%","Long Call":"~48%","Bear Put Debit Spread":"~44%","Long Put":"~46%",
}

def expected_range(price, iv, days):
    move = price * iv * math.sqrt(days / 365)
    return {"low": round(price-move, 2), "high": round(price+move, 2)}

# ─── MAIN SCAN ────────────────────────────────────────────────────────────────
def scan_ticker(ticker):
    try:
        stock = yf.Ticker(ticker)
        hist  = stock.history(period="1y", interval="1d")
        if hist.empty or len(hist) < 30:
            return None

        close = hist["Close"]
        high  = hist["High"]
        low   = hist["Low"]
        price = float(close.iloc[-1])

        # Technicals
        rsi = calc_rsi(close)
        adx = calc_adx(high, low, close)
        rr  = calc_risk_reversal(close)
        ema9  = float(close.ewm(span=9,  adjust=False).mean().iloc[-1])
        ema21 = float(close.ewm(span=21, adjust=False).mean().iloc[-1])
        ema50 = float(close.ewm(span=50, adjust=False).mean().iloc[-1])
        trend = "bullish" if ema9>ema21 and adx>25 else ("bearish" if ema9<ema21 and adx>25 else "neutral")

        # Volume spike
        vol_avg   = float(hist["Volume"].iloc[-20:].mean())
        vol_today = float(hist["Volume"].iloc[-1])
        vol_spike = round(vol_today/vol_avg, 2) if vol_avg > 0 else 1.0

        # IV from options chain
        iv_current = None
        try:
            expirations = stock.options
            today = date.today()
            target_exp = next((e for e in expirations if (date.fromisoformat(e)-today).days >= 7), expirations[0] if expirations else None)
            if target_exp:
                chain = stock.option_chain(target_exp)
                T = max((date.fromisoformat(target_exp) - today).days, 1) / 365.0
                # Find ATM strike
                strikes = chain.calls["strike"].tolist() if not chain.calls.empty else chain.puts["strike"].tolist()
                if strikes:
                    atm = min(strikes, key=lambda k: abs(k-price))
                    ivs = []
                    for opt_type, df in [("call", chain.calls), ("put", chain.puts)]:
                        if df.empty: continue
                        row = df[df["strike"]==atm]
                        if row.empty: continue
                        mid = (float(row["bid"].iloc[0]) + float(row["ask"].iloc[0])) / 2
                        if mid > 0:
                            iv = implied_vol(mid, price, atm, T, opt=opt_type)
                            if iv: ivs.append(iv)
                    if ivs:
                        iv_current = float(np.mean(ivs))
        except Exception as e:
            pass

        if iv_current is None:
            return None

        # IV Rank vs 52-week realized vol
        log_ret = np.log(close / close.shift(1)).dropna()
        rolling_vol = log_ret.rolling(21).std() * math.sqrt(252)
        rolling_vol = rolling_vol.dropna()
        iv_52lo = float(rolling_vol.min())
        iv_52hi = float(rolling_vol.max())
        if iv_52hi > iv_52lo:
            iv_rank = round(min(99, max(1, (iv_current - iv_52lo) / (iv_52hi - iv_52lo) * 100)), 1)
        else:
            iv_rank = 50.0

        if iv_rank < MIN_IV:
            return None

        quad = get_quadrant(iv_rank, rr)

        return {
            "ticker":         ticker,
            "price":          round(price, 2),
            "iv_current":     round(iv_current * 100, 1),
            "iv_rank":        iv_rank,
            "risk_reversal":  rr,
            "trend":          trend,
            "rsi":            rsi,
            "adx":            adx,
            "ema9":           round(ema9, 2),
            "ema21":          round(ema21, 2),
            "ema50":          round(ema50, 2),
            "volume_spike":   vol_spike,
            "quadrant_label": quad["label"],
            "quadrant_color": quad["color"],
            "quadrant_bg":    quad["bg"],
            "strategies":     quad["strategies"],
            "win_rate":       WIN_RATES.get(quad["strategies"][0], "~55%"),
            "range_1d":       expected_range(price, iv_current, 1),
            "range_1w":       expected_range(price, iv_current, 7),
            "range_1m":       expected_range(price, iv_current, 30),
            "scanned_at":     datetime.utcnow().isoformat() + "Z",
        }
    except Exception as e:
        print(f"  [ERROR] {ticker}: {e}")
        return None

# ─── RUN ──────────────────────────────────────────────────────────────────────
def main():
    print(f"OptionScope Scanner — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Scanning {len(SP100)} tickers | Min IV Rank: {MIN_IV}")
    print("─" * 50)

    results = []
    for i, ticker in enumerate(SP100):
        print(f"[{i+1:3d}/{len(SP100)}] {ticker:<6}", end=" ")
        r = scan_ticker(ticker)
        if r:
            print(f"IV Rank: {r['iv_rank']:5.1f}  Trend: {r['trend']:<8}  ADX: {r['adx']}")
            results.append(r)
        else:
            print("skipped")
        time.sleep(0.4)   # be polite to yfinance

    # Sort by IV Rank descending
    results.sort(key=lambda x: x["iv_rank"], reverse=True)

    # Write output JSON
    output = {
        "scanned_at":    datetime.utcnow().isoformat() + "Z",
        "total_scanned": len(SP100),
        "total_results": len(results),
        "results":       results,
    }

    # Save to frontend/public so it gets served by GitHub Pages
    os.makedirs("frontend/public", exist_ok=True)
    with open("frontend/public/results.json", "w") as f:
        json.dump(output, f, indent=2)

    print("─" * 50)
    print(f"Done. {len(results)} stocks saved to frontend/public/results.json")
    print(f"Top 5 by IV Rank:")
    for r in results[:5]:
        print(f"  {r['ticker']:<6} IV:{r['iv_rank']:5.1f}  {r['quadrant_label']}")

if __name__ == "__main__":
    main()
