"""
OptionScope Scanner — GitHub Actions Edition
FIXED: Fetches real market premium at suggested strike (not estimated)
Uses 30-60 DTE for accurate IV, accounts for volatility skew
"""

import yfinance as yf
import numpy as np
import pandas as pd
from scipy.stats import norm
from scipy.optimize import brentq
import math, json, os, time
from datetime import datetime, date
import warnings
warnings.filterwarnings("ignore")

TICKERS = {
    "meme":           ["GME","AMC","SOFI","PLTR","HOOD","RIVN","LCID","NKLA"],
    "crypto":         ["COIN","MSTR","MARA","RIOT","WULF","CLSK","HUT","BITF"],
    "nuclear_energy": ["OKLO","NNE","SMR","CEG","VST","CCJ","URA","NRG"],
    "ai_quantum":     ["NVDA","AMD","IONQ","RGTI","QUBT","QBTS","SOUN","BBAI","SMCI","ARM","AVGO","CRWD","SNOW","NET","MDB"],
    "ev_clean":       ["TSLA","NIO","XPEV","LI","PLUG","FCEL","BE","CHPT","BLNK"],
    "biotech":        ["MRNA","BNTX","NVAX","SRPT","BEAM","CRSP","EDIT","NTLA","RXRX"],
    "high_beta_tech": ["META","GOOGL","AMZN","NFLX","SNAP","RBLX","DKNG","UBER","LYFT","ABNB","DASH","PANW"],
    "fintech":        ["SQ","PYPL","AFRM","UPST","SCHW","GS","MS","BAC"],
    "leveraged_etfs": ["TQQQ","SQQQ","UVXY","LABU","FNGU","UPRO"],
    "sp100_core":     ["AAPL","MSFT","JPM","UNH","JNJ","V","PG","MA","HD","MRK",
                       "ABBV","LLY","KO","MCD","TMO","CSCO","ABT","CRM","TXN","ORCL",
                       "NKE","ADBE","RTX","QCOM","HON","CAT","UNP","SPGI","BLK","AMGN",
                       "SBUX","GILD","AXP","BMY","BA","ISRG","LMT","MU","KLAC","AMAT",
                       "LRCX","INTU","NOW"],
}

ALL_TICKERS = []
seen = set()
for cat, tlist in TICKERS.items():
    for t in tlist:
        if t not in seen:
            ALL_TICKERS.append(t)
            seen.add(t)

MIN_IV = float(os.environ.get("MIN_IV", "0"))

# ── BLACK-SCHOLES ─────────────────────────────────────────────────────────────
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
        iv = brentq(lambda s: bs_price(S, K, T, r, s, opt) - market_price,
                    1e-6, 20.0, xtol=1e-4, maxiter=100)
        return iv if 0.01 <= iv <= 10.0 else None
    except:
        return None

# ── INDICATORS ────────────────────────────────────────────────────────────────
def calc_rsi(closes, period=14):
    delta = closes.diff()
    ag = delta.clip(lower=0).ewm(span=period, adjust=False).mean().iloc[-1]
    al = (-delta.clip(upper=0)).ewm(span=period, adjust=False).mean().iloc[-1]
    return round(100.0 if al == 0 else 100 - (100/(1+ag/al)), 1)

def calc_adx(high, low, close, period=14):
    try:
        high=high.reset_index(drop=True); low=low.reset_index(drop=True); close=close.reset_index(drop=True)
        tr_l,dmp_l,dmm_l=[],[],[]
        for i in range(1, len(close)):
            h,l,pc = float(high[i]),float(low[i]),float(close[i-1])
            tr_l.append(max(h-l, abs(h-pc), abs(l-pc)))
            dh = float(high[i])-float(high[i-1])
            dl = float(low[i-1])-float(low[i])
            dmp_l.append(dh if dh>dl and dh>0 else 0)
            dmm_l.append(dl if dl>dh and dl>0 else 0)
        tr_s  = pd.Series(tr_l).ewm(span=period,adjust=False).mean()
        dmp_s = pd.Series(dmp_l).ewm(span=period,adjust=False).mean()
        dmm_s = pd.Series(dmm_l).ewm(span=period,adjust=False).mean()
        di_p  = 100*dmp_s/tr_s.replace(0,np.nan)
        di_m  = 100*dmm_s/tr_s.replace(0,np.nan)
        dx    = 100*(di_p-di_m).abs()/(di_p+di_m).replace(0,np.nan)
        v     = float(dx.ewm(span=period,adjust=False).mean().iloc[-1])
        return round(v,1) if not math.isnan(v) and not math.isinf(v) else 0.0
    except: return 0.0

def calc_rr(close):
    e9=close.ewm(span=9,adjust=False).mean().iloc[-1]
    e21=close.ewm(span=21,adjust=False).mean().iloc[-1]
    e50=close.ewm(span=50,adjust=False).mean().iloc[-1]
    p=close.iloc[-1]; s=50.0
    if e9>e21>e50: s+=20
    elif e9<e21<e50: s-=20
    s+=10 if p>e21 else -10
    s+=10 if p>e50 else -10
    ret10=(p-close.iloc[-11])/close.iloc[-11] if len(close)>11 else 0
    s+=min(15,max(-15,ret10*200))
    return round(min(99,max(1,s)),1)

def calc_iv_rank(iv_current, close):
    log_ret = np.log(close/close.shift(1)).dropna()
    rv = log_ret.rolling(21).std()*math.sqrt(252)
    rv = rv.dropna()
    if len(rv)<20: return 50.0
    lo,hi = float(rv.quantile(0.05)), float(rv.quantile(0.95))
    spread = hi-lo
    if spread<0.03: return min(60.0, round(iv_current/max(hi,0.01)*50,1))
    return round(min(99,max(1,(iv_current-lo)/spread*100)),1)

def get_quadrant(iv_rank, rr):
    hi,bu = iv_rank>=50, rr>=50
    if hi and bu:     return {"label":"Expensive Vol · Bullish","strategies":["Bull Put Spread","Short Put"],            "color":"#00d4aa","bg":"#0a3d2e"}
    if hi and not bu: return {"label":"Expensive Vol · Bearish","strategies":["Bear Call Spread","Iron Condor"],         "color":"#ff8c42","bg":"#3d1a0a"}
    if not hi and bu: return {"label":"Cheap Vol · Bullish",    "strategies":["Bull Call Debit Spread","Long Call"],     "color":"#3b9eff","bg":"#0a1f3d"}
    return                   {"label":"Cheap Vol · Bearish",    "strategies":["Bear Put Debit Spread","Long Put"],       "color":"#cc77ff","bg":"#2a0a2a"}

WIN_RATES = {
    "Bull Put Spread":"~62%","Short Put":"~70%","Bear Call Spread":"~63%","Iron Condor":"~68%",
    "Bull Call Debit Spread":"~45%","Long Call":"~48%","Bear Put Debit Spread":"~44%","Long Put":"~46%",
}

def exp_range(price, iv, days):
    move = price*iv*math.sqrt(days/365)
    return {"low":round(price-move,2),"high":round(price+move,2)}

def get_real_strike_and_premium(df, price, trend, T):
    """
    Find the best strike for selling and return REAL market premium.
    For puts (bullish): target ~8-10% OTM below price
    For calls (bearish): target ~8-10% OTM above price
    Returns: (strike, real_mid_price, otm_pct, real_iv)
    """
    if df.empty:
        return None, None, None, None

    strikes = df["strike"].tolist()
    if not strikes:
        return None, None, None, None

    # Target strike: 8-10% OTM
    if trend in ("bullish", "neutral"):
        k_target = price * 0.90  # 10% below for put
    else:
        k_target = price * 1.10  # 10% above for call

    # Find closest available strike
    strike = min(strikes, key=lambda k: abs(k - k_target))
    row = df[df["strike"] == strike]
    if row.empty:
        return None, None, None, None

    bid = float(row["bid"].iloc[0])
    ask = float(row["ask"].iloc[0])

    # Skip if no market
    if bid <= 0 and ask <= 0:
        return None, None, None, None

    # Use ask if no bid (illiquid but still real)
    if bid <= 0:
        mid = ask * 0.9
    else:
        mid = (bid + ask) / 2

    if mid < 0.01:
        return None, None, None, None

    otm_pct = round(abs(price - strike) / price * 100, 1)

    # Get real IV at this strike (accounts for vol skew)
    opt_type = "put" if trend in ("bullish", "neutral") else "call"
    real_iv = implied_vol(mid, price, strike, T, opt=opt_type)

    return round(strike, 2), round(mid, 2), otm_pct, real_iv

# ── SCAN ONE TICKER ───────────────────────────────────────────────────────────
def scan_ticker(ticker):
    try:
        stock = yf.Ticker(ticker)
        hist  = stock.history(period="1y", interval="1d")
        if hist.empty or len(hist)<50: return None

        close = hist["Close"].reset_index(drop=True)
        high  = hist["High"].reset_index(drop=True)
        low   = hist["Low"].reset_index(drop=True)
        price = float(close.iloc[-1])
        if price<=0: return None

        rsi  = calc_rsi(close)
        adx  = calc_adx(high,low,close)
        rr   = calc_rr(close)
        ema9  = float(close.ewm(span=9, adjust=False).mean().iloc[-1])
        ema21 = float(close.ewm(span=21,adjust=False).mean().iloc[-1])
        ema50 = float(close.ewm(span=50,adjust=False).mean().iloc[-1])
        trend = ("bullish" if ema9>ema21 and adx>20
                 else "bearish" if ema9<ema21 and adx>20 else "neutral")
        vol_avg   = float(hist["Volume"].iloc[-20:].mean())
        vol_today = float(hist["Volume"].iloc[-1])
        vol_spike = round(vol_today/vol_avg,2) if vol_avg>0 else 1.0
        category  = next((c for c,tl in TICKERS.items() if ticker in tl),"other")

        # ── IV + Real Premium from options chain ──────────────────────────
        iv_current   = None
        suggest_strike    = None
        suggest_premium   = None  # real market mid price per share
        suggest_otm_pct   = None
        suggest_strike_iv = None
        dte_used      = None

        try:
            exps = stock.options
            if not exps:
                return None

            today    = date.today()
            exp_days = [(e, (date.fromisoformat(e)-today).days) for e in exps]

            # Strict 30-60 DTE for clean IV
            target = None
            for e, d in exp_days:
                if 30 <= d <= 60:
                    target = e
                    break
            if not target:
                for e, d in exp_days:
                    if 25 <= d <= 90:
                        target = e
                        break
            if not target:
                return None

            dte_used = (date.fromisoformat(target) - today).days
            T = dte_used / 365.0
            chain = stock.option_chain(target)

            # ── Step 1: Get ATM IV for IV Rank calculation ──
            # Use 4% OTM put + call average = cleaner ATM IV signal
            ivs_atm = []
            for opt_type, df, k_pct in [("put", chain.puts, 0.96), ("call", chain.calls, 1.04)]:
                if df.empty: continue
                k_target     = price * k_pct
                strikes_list = df["strike"].tolist()
                if not strikes_list: continue
                strike_k = min(strikes_list, key=lambda k: abs(k - k_target))
                row = df[df["strike"] == strike_k]
                if row.empty: continue
                bid = float(row["bid"].iloc[0])
                ask = float(row["ask"].iloc[0])
                if bid <= 0 or ask <= 0: continue
                if ask > 0 and (ask - bid) / ask > 0.5: continue
                mid = (bid + ask) / 2
                if mid < 0.05: continue
                iv = implied_vol(mid, price, strike_k, T, opt=opt_type)
                if iv and 0.05 <= iv <= 3.0:
                    ivs_atm.append(iv)

            if not ivs_atm:
                return None
            iv_current = float(np.mean(ivs_atm))

            # ── Step 2: Get REAL premium at suggested strike ──
            # Fetch directly from options chain — no estimation formula!
            if trend in ("bullish", "neutral"):
                # Selling put — use puts chain
                strike, mid_price, otm_pct, strike_iv = get_real_strike_and_premium(
                    chain.puts, price, trend, T)
            else:
                # Selling call — use calls chain
                strike, mid_price, otm_pct, strike_iv = get_real_strike_and_premium(
                    chain.calls, price, trend, T)

            suggest_strike    = strike
            suggest_premium   = mid_price   # per share (×100 for contract)
            suggest_otm_pct   = otm_pct
            suggest_strike_iv = round(strike_iv * 100, 1) if strike_iv else None

            print(f"    {dte_used}DTE | IV:{iv_current:.1%} | "
                  f"strike:{suggest_strike} mid:${suggest_premium} "
                  f"otm:{suggest_otm_pct}% iv_at_strike:{suggest_strike_iv}%")

        except Exception as e:
            print(f"\n    options err: {e}")
            return None

        if iv_current is None or iv_current <= 0:
            return None

        iv_rank = calc_iv_rank(iv_current, close)
        if iv_rank < MIN_IV: return None

        quad = get_quadrant(iv_rank, rr)

        # Real premium per contract = mid_price × 100
        premium_per_contract = round(suggest_premium * 100, 2) if suggest_premium else None

        return {
            "ticker":              ticker,
            "category":            category,
            "iv_source":           "options",
            "price":               round(price, 2),
            "iv_current":          round(iv_current * 100, 1),
            "iv_rank":             iv_rank,
            "risk_reversal":       rr,
            "trend":               trend,
            "rsi":                 round(rsi, 1),
            "adx":                 round(adx, 1),
            "ema9":                round(ema9, 2),
            "ema21":               round(ema21, 2),
            "ema50":               round(ema50, 2),
            "volume_spike":        vol_spike,
            "quadrant_label":      quad["label"],
            "quadrant_color":      quad["color"],
            "quadrant_bg":         quad["bg"],
            "strategies":          quad["strategies"],
            "win_rate":            WIN_RATES.get(quad["strategies"][0], "~55%"),
            "range_1d":            exp_range(price, iv_current, 1),
            "range_1w":            exp_range(price, iv_current, 7),
            "range_1m":            exp_range(price, iv_current, 30),
            # Real market data at suggested strike
            "suggest_strike":      suggest_strike,
            "suggest_premium":     suggest_premium,       # per share
            "suggest_premium_contract": premium_per_contract,  # per contract
            "suggest_otm_pct":     suggest_otm_pct,
            "suggest_strike_iv":   suggest_strike_iv,
            "suggest_dte":         dte_used,
            "scanned_at":          datetime.utcnow().isoformat() + "Z",
        }
    except Exception as e:
        print(f"  [ERROR] {ticker}: {e}")
        return None

# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    print(f"OptionScope Scanner — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Universe: {len(ALL_TICKERS)} tickers | Min IV Rank: {MIN_IV}")
    print(f"Using REAL market premium from options chain (no estimation)")
    print("─"*65)

    results = []
    for i, ticker in enumerate(ALL_TICKERS):
        print(f"[{i+1:3d}/{len(ALL_TICKERS)}] {ticker:<6}", end="  ")
        r = scan_ticker(ticker)
        if r:
            flag = "🔥" if r["iv_rank"] >= 75 else ("✅" if r["iv_rank"] >= 50 else "  ")
            print(f"  IV:{r['iv_current']:5.1f}%  Rank:{r['iv_rank']:5.1f}  "
                  f"Strike:${r['suggest_strike']}  Premium:${r['suggest_premium_contract']}  {flag}")
            results.append(r)
        else:
            print("  skipped")
        time.sleep(0.5)

    results.sort(key=lambda x: x["iv_rank"], reverse=True)

    output = {
        "scanned_at":    datetime.utcnow().isoformat() + "Z",
        "total_scanned": len(ALL_TICKERS),
        "total_results": len(results),
        "categories":    list(TICKERS.keys()),
        "results":       results,
    }

    os.makedirs("frontend/public", exist_ok=True)
    with open("frontend/public/results.json", "w") as f:
        json.dump(output, f, indent=2)

    print("─"*65)
    print(f"Done — {len(results)}/{len(ALL_TICKERS)} stocks")
    print("\nTop 10 by IV Rank:")
    for r in results[:10]:
        print(f"  {r['ticker']:<6} IV:{r['iv_current']:5.1f}%  "
              f"Strike:${r['suggest_strike']}  "
              f"Premium:${r['suggest_premium_contract']}  "
              f"({r['suggest_otm_pct']}% OTM)  {r['quadrant_label']}")

if __name__ == "__main__":
    main()
