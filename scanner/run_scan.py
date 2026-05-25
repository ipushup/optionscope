"""
OptionScope Scanner — Enhanced with Vol/OI Analysis
Fetches: IV, real premium, Volume anomaly, OI walls, Max Pain, P/C ratio
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

# ── MAX PAIN CALCULATION ──────────────────────────────────────────────────────
def calc_max_pain(calls, puts):
    """
    Max Pain = strike where total option value (pain to holders) is maximized
    = strike where option writers keep the most premium
    """
    try:
        all_strikes = sorted(set(calls["strike"].tolist() + puts["strike"].tolist()))
        if not all_strikes:
            return None

        min_pain = float("inf")
        max_pain_strike = all_strikes[0]

        for test_strike in all_strikes:
            # Pain to call holders: all calls with strike < test_strike expire ITM
            call_pain = sum(
                max(0, test_strike - k) * oi
                for k, oi in zip(calls["strike"], calls["openInterest"])
                if not math.isnan(oi)
            )
            # Pain to put holders: all puts with strike > test_strike expire ITM
            put_pain = sum(
                max(0, k - test_strike) * oi
                for k, oi in zip(puts["strike"], puts["openInterest"])
                if not math.isnan(oi)
            )
            total_pain = call_pain + put_pain
            if total_pain < min_pain:
                min_pain = total_pain
                max_pain_strike = test_strike

        return round(max_pain_strike, 2)
    except:
        return None

# ── VOL/OI ANALYSIS ───────────────────────────────────────────────────────────
def analyze_vol_oi(calls, puts, price, suggest_strike, trend):
    """
    Detects unusual options activity:
    - Vol > OI: new positions being opened today (strong signal)
    - Bid/Ask fill: filled at ask = urgent buyer, at bid = closing
    - OI walls: high OI strikes acting as support/resistance
    - P/C ratio: overall sentiment
    """
    result = {
        "vol_oi_anomaly":    False,   # Vol > OI at suggest strike
        "anomaly_type":      None,    # "call_heavy" | "put_heavy" | "balanced"
        "fill_side":         None,    # "ask" (urgent) | "bid" (closing) | "mid"
        "pc_ratio":          None,    # put/call volume ratio
        "call_wall":         None,    # nearest high-OI call strike above price
        "put_wall":          None,    # nearest high-OI put strike below price
        "max_pain":          None,    # max pain strike
        "signal_matrix":     None,    # overall signal
        "oi_top_calls":      [],      # top 3 call OI strikes
        "oi_top_puts":       [],      # top 3 put OI strikes
        "vol_anomaly_strikes": [],    # strikes where vol > OI
    }

    try:
        # ── P/C Ratio ──
        total_call_vol = calls["volume"].fillna(0).sum()
        total_put_vol  = puts["volume"].fillna(0).sum()
        if total_call_vol > 0:
            result["pc_ratio"] = round(total_put_vol / total_call_vol, 2)

        # ── Max Pain ──
        result["max_pain"] = calc_max_pain(calls, puts)

        # ── Top OI strikes (walls/magnets) ──
        # Call OI wall: high OI calls above price = resistance
        calls_above = calls[calls["strike"] > price].copy()
        if not calls_above.empty:
            calls_above = calls_above.sort_values("openInterest", ascending=False)
            result["oi_top_calls"] = [
                {"strike": float(r["strike"]), "oi": int(r["openInterest"]), "vol": int(r["volume"] if not math.isnan(r["volume"]) else 0)}
                for _, r in calls_above.head(3).iterrows()
                if not math.isnan(r["openInterest"]) and r["openInterest"] > 0
            ]
            # Nearest high-OI call above price
            calls_sorted_by_strike = calls_above.sort_values("strike")
            high_oi_calls = calls_sorted_by_strike[calls_sorted_by_strike["openInterest"] > calls_sorted_by_strike["openInterest"].quantile(0.7)]
            if not high_oi_calls.empty:
                result["call_wall"] = float(high_oi_calls.iloc[0]["strike"])

        # Put OI wall: high OI puts below price = support
        puts_below = puts[puts["strike"] < price].copy()
        if not puts_below.empty:
            puts_below = puts_below.sort_values("openInterest", ascending=False)
            result["oi_top_puts"] = [
                {"strike": float(r["strike"]), "oi": int(r["openInterest"]), "vol": int(r["volume"] if not math.isnan(r["volume"]) else 0)}
                for _, r in puts_below.head(3).iterrows()
                if not math.isnan(r["openInterest"]) and r["openInterest"] > 0
            ]
            puts_sorted_by_strike = puts_below.sort_values("strike", ascending=False)
            high_oi_puts = puts_sorted_by_strike[puts_sorted_by_strike["openInterest"] > puts_sorted_by_strike["openInterest"].quantile(0.7)]
            if not high_oi_puts.empty:
                result["put_wall"] = float(high_oi_puts.iloc[0]["strike"])

        # ── Vol > OI anomaly detection ──
        # Check all strikes, find where today's volume exceeds open interest
        anomaly_strikes = []
        for df, opt_type in [(calls, "call"), (puts, "put")]:
            for _, row in df.iterrows():
                vol = row["volume"] if not math.isnan(row.get("volume", float("nan"))) else 0
                oi  = row["openInterest"] if not math.isnan(row.get("openInterest", float("nan"))) else 0
                if oi > 0 and vol > oi and vol > 100:  # meaningful volume
                    anomaly_strikes.append({
                        "strike":   float(row["strike"]),
                        "type":     opt_type,
                        "volume":   int(vol),
                        "oi":       int(oi),
                        "vol_oi_ratio": round(vol/oi, 1),
                        "bid":      float(row["bid"]) if not math.isnan(row.get("bid", float("nan"))) else 0,
                        "ask":      float(row["ask"]) if not math.isnan(row.get("ask", float("nan"))) else 0,
                    })

        # Sort by vol/OI ratio descending
        anomaly_strikes.sort(key=lambda x: x["vol_oi_ratio"], reverse=True)
        result["vol_anomaly_strikes"] = anomaly_strikes[:5]  # top 5

        if anomaly_strikes:
            result["vol_oi_anomaly"] = True
            call_anomalies = [a for a in anomaly_strikes if a["type"] == "call"]
            put_anomalies  = [a for a in anomaly_strikes if a["type"] == "put"]
            if len(call_anomalies) > len(put_anomalies) * 1.5:
                result["anomaly_type"] = "call_heavy"
            elif len(put_anomalies) > len(call_anomalies) * 1.5:
                result["anomaly_type"] = "put_heavy"
            else:
                result["anomaly_type"] = "balanced"

        # ── Bid/Ask fill at suggested strike ──
        if suggest_strike:
            df_check = puts if trend in ("bullish","neutral") else calls
            opt_type = "put" if trend in ("bullish","neutral") else "call"
            row = df_check[df_check["strike"] == suggest_strike]
            if not row.empty:
                bid  = float(row["bid"].iloc[0])
                ask  = float(row["ask"].iloc[0])
                last = float(row["lastPrice"].iloc[0]) if "lastPrice" in row.columns else (bid+ask)/2
                if ask > bid:
                    spread = ask - bid
                    if last >= ask - spread * 0.2:
                        result["fill_side"] = "ask"   # filled at ask = urgent buyer
                    elif last <= bid + spread * 0.2:
                        result["fill_side"] = "bid"   # filled at bid = closing/seller
                    else:
                        result["fill_side"] = "mid"

        # ── Signal Matrix ──
        # Combines price trend + vol anomaly + OI analysis
        pc    = result["pc_ratio"] or 1.0
        anomaly = result["vol_oi_anomaly"]
        atype   = result["anomaly_type"]
        fill    = result["fill_side"]

        if trend == "bullish" and anomaly and atype == "call_heavy" and fill == "ask":
            result["signal_matrix"] = "STRONG_BULL"   # ↑Price ↑CallVol ↑OI filled@ask
        elif trend == "bullish" and anomaly and atype == "call_heavy":
            result["signal_matrix"] = "BULL"
        elif trend == "bullish" and not anomaly:
            result["signal_matrix"] = "MILD_BULL"
        elif trend == "bearish" and anomaly and atype == "put_heavy" and fill == "ask":
            result["signal_matrix"] = "STRONG_BEAR"   # ↓Price ↑PutVol ↑OI filled@ask
        elif trend == "bearish" and anomaly and atype == "put_heavy":
            result["signal_matrix"] = "BEAR"
        elif trend == "bearish" and not anomaly:
            result["signal_matrix"] = "MILD_BEAR"
        elif anomaly and atype == "balanced":
            result["signal_matrix"] = "VOLATILE"      # high vol both sides = event play
        else:
            result["signal_matrix"] = "NEUTRAL"

    except Exception as e:
        print(f"    vol/oi err: {e}")

    return result

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

        # ── Options chain ──────────────────────────────────────────────────
        iv_current = None
        suggest_strike = None
        suggest_premium = None
        suggest_premium_contract = None
        suggest_otm_pct = None
        suggest_strike_iv = None
        dte_used = None
        vol_oi_data = {}

        try:
            exps = stock.options
            if not exps: return None

            today    = date.today()
            exp_days = [(e, (date.fromisoformat(e)-today).days) for e in exps]

            # 30-60 DTE for clean IV
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
            if not target: return None

            dte_used = (date.fromisoformat(target) - today).days
            T = dte_used / 365.0
            chain = stock.option_chain(target)
            calls = chain.calls
            puts  = chain.puts

            # ── ATM IV (4% OTM average) ──
            ivs_atm = []
            for opt_type, df, k_pct in [("put", puts, 0.96), ("call", calls, 1.04)]:
                if df.empty: continue
                k_target     = price * k_pct
                strikes_list = df["strike"].tolist()
                if not strikes_list: continue
                strike_k = min(strikes_list, key=lambda k: abs(k-k_target))
                row = df[df["strike"]==strike_k]
                if row.empty: continue
                bid = float(row["bid"].iloc[0])
                ask = float(row["ask"].iloc[0])
                if bid<=0 or ask<=0: continue
                if (ask-bid)/ask > 0.5: continue
                mid = (bid+ask)/2
                if mid < 0.05: continue
                iv = implied_vol(mid, price, strike_k, T, opt=opt_type)
                if iv and 0.05<=iv<=3.0:
                    ivs_atm.append(iv)

            if not ivs_atm: return None
            iv_current = float(np.mean(ivs_atm))

            # ── Real strike + premium at ~10% OTM ──
            if trend in ("bullish","neutral"):
                df_use   = puts
                k_target = price * 0.90
                opt_type = "put"
            else:
                df_use   = calls
                k_target = price * 1.10
                opt_type = "call"

            if not df_use.empty:
                strikes_list = df_use["strike"].tolist()
                strike_k = min(strikes_list, key=lambda k: abs(k-k_target))
                row = df_use[df_use["strike"]==strike_k]
                if not row.empty:
                    bid = float(row["bid"].iloc[0])
                    ask = float(row["ask"].iloc[0])
                    if bid<=0 and ask>0:
                        mid = ask * 0.9
                    elif bid>0 and ask>0:
                        mid = (bid+ask)/2
                    else:
                        mid = 0
                    if mid >= 0.01:
                        suggest_strike           = round(float(strike_k), 2)
                        suggest_premium          = round(mid, 2)
                        suggest_premium_contract = round(mid*100, 2)
                        suggest_otm_pct          = round(abs(price-strike_k)/price*100, 1)
                        siv = implied_vol(mid, price, strike_k, T, opt=opt_type)
                        suggest_strike_iv        = round(siv*100,1) if siv else None

            # ── Vol/OI Analysis ──
            vol_oi_data = analyze_vol_oi(calls, puts, price, suggest_strike, trend)

            print(f"    {dte_used}DTE | IV:{iv_current:.1%} | "
                  f"strike:{suggest_strike} premium:${suggest_premium_contract} | "
                  f"maxpain:{vol_oi_data.get('max_pain')} "
                  f"pc:{vol_oi_data.get('pc_ratio')} "
                  f"signal:{vol_oi_data.get('signal_matrix')}")

        except Exception as e:
            print(f"\n    options err: {e}")
            return None

        if iv_current is None or iv_current<=0: return None

        iv_rank = calc_iv_rank(iv_current, close)
        if iv_rank < MIN_IV: return None

        quad = get_quadrant(iv_rank, rr)

        return {
            "ticker":                 ticker,
            "category":               category,
            "iv_source":              "options",
            "price":                  round(price,2),
            "iv_current":             round(iv_current*100,1),
            "iv_rank":                iv_rank,
            "risk_reversal":          rr,
            "trend":                  trend,
            "rsi":                    round(rsi,1),
            "adx":                    round(adx,1),
            "ema9":                   round(ema9,2),
            "ema21":                  round(ema21,2),
            "ema50":                  round(ema50,2),
            "volume_spike":           vol_spike,
            "quadrant_label":         quad["label"],
            "quadrant_color":         quad["color"],
            "quadrant_bg":            quad["bg"],
            "strategies":             quad["strategies"],
            "win_rate":               WIN_RATES.get(quad["strategies"][0],"~55%"),
            "range_1d":               exp_range(price,iv_current,1),
            "range_1w":               exp_range(price,iv_current,7),
            "range_1m":               exp_range(price,iv_current,30),
            # Real strike data
            "suggest_strike":         suggest_strike,
            "suggest_premium":        suggest_premium,
            "suggest_premium_contract": suggest_premium_contract,
            "suggest_otm_pct":        suggest_otm_pct,
            "suggest_strike_iv":      suggest_strike_iv,
            "suggest_dte":            dte_used,
            # Vol/OI signals
            "vol_oi_anomaly":         vol_oi_data.get("vol_oi_anomaly", False),
            "anomaly_type":           vol_oi_data.get("anomaly_type"),
            "fill_side":              vol_oi_data.get("fill_side"),
            "pc_ratio":               vol_oi_data.get("pc_ratio"),
            "call_wall":              vol_oi_data.get("call_wall"),
            "put_wall":               vol_oi_data.get("put_wall"),
            "max_pain":               vol_oi_data.get("max_pain"),
            "signal_matrix":          vol_oi_data.get("signal_matrix"),
            "oi_top_calls":           vol_oi_data.get("oi_top_calls",[]),
            "oi_top_puts":            vol_oi_data.get("oi_top_puts",[]),
            "vol_anomaly_strikes":    vol_oi_data.get("vol_anomaly_strikes",[]),
            "scanned_at":             datetime.utcnow().isoformat()+"Z",
        }
    except Exception as e:
        print(f"  [ERROR] {ticker}: {e}")
        return None

# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    print(f"OptionScope Scanner — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Universe: {len(ALL_TICKERS)} tickers | Enhanced: Vol/OI/MaxPain/PC")
    print("─"*70)

    results = []
    for i, ticker in enumerate(ALL_TICKERS):
        print(f"[{i+1:3d}/{len(ALL_TICKERS)}] {ticker:<6}", end="  ")
        r = scan_ticker(ticker)
        if r:
            flag = "🔥" if r["iv_rank"]>=75 else ("✅" if r["iv_rank"]>=50 else "  ")
            sig  = r.get("signal_matrix","")
            print(f"  IV:{r['iv_current']:5.1f}%  Rank:{r['iv_rank']:5.1f}  "
                  f"Premium:${r['suggest_premium_contract']}  [{sig}] {flag}")
            results.append(r)
        else:
            print("  skipped")
        time.sleep(0.5)

    results.sort(key=lambda x: x["iv_rank"], reverse=True)

    output = {
        "scanned_at":    datetime.utcnow().isoformat()+"Z",
        "total_scanned": len(ALL_TICKERS),
        "total_results": len(results),
        "categories":    list(TICKERS.keys()),
        "results":       results,
    }

    os.makedirs("frontend/public", exist_ok=True)
    with open("frontend/public/results.json","w") as f:
        json.dump(output,f,indent=2)

    print("─"*70)
    print(f"Done — {len(results)}/{len(ALL_TICKERS)} stocks")
    print("\nTop 10 by IV Rank:")
    for r in results[:10]:
        print(f"  {r['ticker']:<6} IV:{r['iv_current']:5.1f}%  "
              f"Rank:{r['iv_rank']:5.1f}  "
              f"Strike:${r['suggest_strike']}  "
              f"Premium:${r['suggest_premium_contract']}  "
              f"Signal:{r.get('signal_matrix')}  "
              f"MaxPain:{r.get('max_pain')}  "
              f"P/C:{r.get('pc_ratio')}")

if __name__ == "__main__":
    main()
