"""
OptionScope Scanner — GitHub Actions Edition
Comprehensive high-IV ticker list for premium selling
Categories: Meme/Retail, Crypto, AI/Tech, Energy, Biotech, EV, Options-heavy S&P
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

# ─── TICKER UNIVERSE ──────────────────────────────────────────────────────────
TICKERS = {

    # 🔥 MEME / RETAIL — highest IV, most volatile
    "meme": [
        "GME",   # GameStop — king of meme IV
        "AMC",   # AMC Entertainment
        "SOFI",  # SoFi Technologies
        "PLTR",  # Palantir — retail favourite
        "HOOD",  # Robinhood
        "RIVN",  # Rivian
        "LCID",  # Lucid Motors
        "NKLA",  # Nikola
    ],

    # 🪙 CRYPTO-CORRELATED — spikes with Bitcoin
    "crypto": [
        "COIN",  # Coinbase
        "MSTR",  # MicroStrategy — Bitcoin proxy
        "MARA",  # Marathon Digital
        "RIOT",  # Riot Platforms
        "WULF",  # TeraWulf — very high IV
        "CLSK",  # CleanSpark
        "HUT",   # Hut 8 Mining
        "CIFR",  # Cipher Mining
        "BITF",  # Bitfarms
    ],

    # ⚛️  NUCLEAR / ENERGY — policy & hype cycles
    "nuclear_energy": [
        "OKLO",  # Oklo — Sam Altman backed
        "NNE",   # Nano Nuclear Energy
        "SMR",   # NuScale Power
        "CEG",   # Constellation Energy
        "VST",   # Vistra Energy
        "CCJ",   # Cameco — uranium miner
        "URA",   # Global X Uranium ETF
        "NRG",   # NRG Energy
    ],

    # 🤖 AI / QUANTUM TECH — narrative-driven IV
    "ai_quantum": [
        "NVDA",  # Nvidia — AI leader
        "AMD",   # AMD
        "IONQ",  # IonQ — quantum computing
        "RGTI",  # Rigetti Computing
        "QUBT",  # Quantum Computing Inc
        "QBTS",  # D-Wave Quantum
        "SOUN",  # SoundHound AI
        "BBAI",  # BigBear.ai
        "SMCI",  # Super Micro Computer
        "ARM",   # Arm Holdings
        "AVGO",  # Broadcom
        "CRWD",  # CrowdStrike
        "SNOW",  # Snowflake
        "NET",   # Cloudflare
        "MDB",   # MongoDB
    ],

    # 🚗 EV / CLEAN ENERGY
    "ev_clean": [
        "TSLA",  # Tesla — always high IV
        "NIO",   # NIO — Chinese EV
        "XPEV",  # XPeng
        "LI",    # Li Auto
        "PLUG",  # Plug Power — hydrogen
        "FCEL",  # FuelCell Energy
        "BE",    # Bloom Energy
        "CHPT",  # ChargePoint
        "BLNK",  # Blink Charging
    ],

    # 💊 BIOTECH — FDA events = IV explosions
    "biotech": [
        "MRNA",  # Moderna
        "BNTX",  # BioNTech
        "NVAX",  # Novavax
        "SRPT",  # Sarepta Therapeutics
        "BEAM",  # Beam Therapeutics — gene editing
        "CRSP",  # CRISPR Therapeutics
        "EDIT",  # Editas Medicine
        "NTLA",  # Intellia Therapeutics
        "RXRX",  # Recursion Pharma
    ],

    # 📱 HIGH-BETA TECH
    "high_beta_tech": [
        "META",  # Meta
        "GOOGL", # Alphabet
        "AMZN",  # Amazon
        "NFLX",  # Netflix
        "SNAP",  # Snap
        "RBLX",  # Roblox
        "DKNG",  # DraftKings
        "UBER",  # Uber
        "LYFT",  # Lyft
        "ABNB",  # Airbnb
        "DASH",  # DoorDash
        "PANW",  # Palo Alto Networks
    ],

    # 🏦 FINTECH / FINANCE
    "fintech": [
        "SQ",    # Block (Square)
        "PYPL",  # PayPal
        "AFRM",  # Affirm — BNPL
        "UPST",  # Upstart
        "SCHW",  # Charles Schwab
        "GS",    # Goldman Sachs
        "MS",    # Morgan Stanley
        "BAC",   # Bank of America
    ],

    # 📊 LEVERAGED ETFs — extreme IV
    "leveraged_etfs": [
        "TQQQ",  # 3x long QQQ
        "SQQQ",  # 3x short QQQ
        "UVXY",  # VIX ETF — extreme IV
        "LABU",  # 3x biotech bull
        "FNGU",  # 3x FANG+
        "UPRO",  # 3x long S&P
    ],

    # 📈 LIQUID S&P 100 — iron condor favourites
    "sp100_core": [
        "AAPL",  "MSFT",  "JPM",   "UNH",  "JNJ",
        "V",     "PG",    "MA",    "HD",   "MRK",
        "ABBV",  "LLY",   "KO",    "MCD",  "TMO",
        "CSCO",  "ABT",   "CRM",   "TXN",  "ORCL",
        "NKE",   "ADBE",  "RTX",   "QCOM", "HON",
        "CAT",   "UNP",   "SPGI",  "BLK",  "AMGN",
        "SBUX",  "GILD",  "AXP",   "BMY",  "BA",
        "ISRG",  "LMT",   "MU",    "KLAC", "AMAT",
        "LRCX",  "INTU",  "NOW",
    ],
}

# Flatten + deduplicate
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
        iv = brentq(
            lambda s: bs_price(S, K, T, r, s, opt) - market_price,
            1e-6, 20.0, xtol=1e-4, maxiter=100
        )
        return iv if 0.01 <= iv <= 10.0 else None
    except:
        return None

# ── INDICATORS ────────────────────────────────────────────────────────────────
def calc_rsi(closes, period=14):
    delta = closes.diff()
    gain  = delta.clip(lower=0)
    loss  = -delta.clip(upper=0)
    ag = gain.ewm(span=period, adjust=False).mean().iloc[-1]
    al = loss.ewm(span=period, adjust=False).mean().iloc[-1]
    return round(100.0 if al == 0 else 100 - (100 / (1 + ag/al)), 1)

def calc_adx(high, low, close, period=14):
    try:
        high  = high.reset_index(drop=True)
        low   = low.reset_index(drop=True)
        close = close.reset_index(drop=True)
        tr_l, dmp_l, dmm_l = [], [], []
        for i in range(1, len(close)):
            h, l, pc = float(high[i]), float(low[i]), float(close[i-1])
            tr = max(h-l, abs(h-pc), abs(l-pc))
            dh = float(high[i]) - float(high[i-1])
            dl = float(low[i-1]) - float(low[i])
            dmp_l.append(dh if dh > dl and dh > 0 else 0)
            dmm_l.append(dl if dl > dh and dl > 0 else 0)
            tr_l.append(tr)
        tr_s  = pd.Series(tr_l).ewm(span=period, adjust=False).mean()
        dmp_s = pd.Series(dmp_l).ewm(span=period, adjust=False).mean()
        dmm_s = pd.Series(dmm_l).ewm(span=period, adjust=False).mean()
        di_p  = 100 * dmp_s / tr_s.replace(0, np.nan)
        di_m  = 100 * dmm_s / tr_s.replace(0, np.nan)
        dx    = 100 * (di_p - di_m).abs() / (di_p + di_m).replace(0, np.nan)
        adx   = dx.ewm(span=period, adjust=False).mean().iloc[-1]
        v = float(adx)
        return round(v, 1) if not math.isnan(v) and not math.isinf(v) else 0.0
    except:
        return 0.0

def calc_risk_reversal(close):
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

def calc_iv_rank(iv_current, hist_close):
    log_ret     = np.log(hist_close / hist_close.shift(1)).dropna()
    rolling_vol = log_ret.rolling(window=21).std() * math.sqrt(252)
    rolling_vol = rolling_vol.dropna()
    if len(rolling_vol) < 20:
        return 50.0
    iv_52lo = float(rolling_vol.quantile(0.05))
    iv_52hi = float(rolling_vol.quantile(0.95))
    spread  = iv_52hi - iv_52lo
    if spread < 0.03:
        return min(60.0, round(iv_current / max(iv_52hi, 0.01) * 50, 1))
    return round(min(99, max(1, (iv_current - iv_52lo) / spread * 100)), 1)

def get_quadrant(iv_rank, rr):
    hi = iv_rank >= 50
    bu = rr >= 50
    if hi and bu:  return {"label":"Expensive Vol · Bullish","strategies":["Bull Put Spread","Short Put"],          "color":"#00d4aa","bg":"#0a3d2e"}
    if hi and not bu: return {"label":"Expensive Vol · Bearish","strategies":["Bear Call Spread","Iron Condor"],   "color":"#ff8c42","bg":"#3d1a0a"}
    if not hi and bu: return {"label":"Cheap Vol · Bullish",    "strategies":["Bull Call Debit Spread","Long Call"],"color":"#3b9eff","bg":"#0a1f3d"}
    return                   {"label":"Cheap Vol · Bearish",    "strategies":["Bear Put Debit Spread","Long Put"],  "color":"#cc77ff","bg":"#2a0a2a"}

WIN_RATES = {
    "Bull Put Spread":"~62%","Short Put":"~70%","Bear Call Spread":"~63%","Iron Condor":"~68%",
    "Bull Call Debit Spread":"~45%","Long Call":"~48%","Bear Put Debit Spread":"~44%","Long Put":"~46%",
}

def expected_range(price, iv, days):
    move = price * iv * math.sqrt(days / 365)
    return {"low": round(price - move, 2), "high": round(price + move, 2)}

# ── SCAN ONE TICKER ───────────────────────────────────────────────────────────
def scan_ticker(ticker):
    try:
        stock = yf.Ticker(ticker)
        hist  = stock.history(period="1y", interval="1d")
        if hist.empty or len(hist) < 50:
            return None

        close = hist["Close"].reset_index(drop=True)
        high  = hist["High"].reset_index(drop=True)
        low   = hist["Low"].reset_index(drop=True)
        price = float(close.iloc[-1])
        if price <= 0:
            return None

        rsi   = calc_rsi(close)
        adx   = calc_adx(high, low, close)
        rr    = calc_risk_reversal(close)
        ema9  = float(close.ewm(span=9,  adjust=False).mean().iloc[-1])
        ema21 = float(close.ewm(span=21, adjust=False).mean().iloc[-1])
        ema50 = float(close.ewm(span=50, adjust=False).mean().iloc[-1])
        trend = ("bullish" if ema9 > ema21 and adx > 20
                 else "bearish" if ema9 < ema21 and adx > 20 else "neutral")

        vol_avg   = float(hist["Volume"].iloc[-20:].mean())
        vol_today = float(hist["Volume"].iloc[-1])
        vol_spike = round(vol_today / vol_avg, 2) if vol_avg > 0 else 1.0

        category = next((c for c, tl in TICKERS.items() if ticker in tl), "other")

        # IV from options chain
        iv_current = None
        try:
            expirations = stock.options
            if not expirations:
                return None
            today = date.today()
            target_exp = next(
                (e for e in expirations if 14 <= (date.fromisoformat(e) - today).days <= 60),
                expirations[0]
            )
            chain = stock.option_chain(target_exp)
            T = max((date.fromisoformat(target_exp) - today).days, 1) / 365.0
            strikes = (chain.calls["strike"].tolist() if not chain.calls.empty
                       else chain.puts["strike"].tolist() if not chain.puts.empty else [])
            if not strikes:
                return None
            atm = min(strikes, key=lambda k: abs(k - price))
            ivs = []
            for ot, df in [("call", chain.calls), ("put", chain.puts)]:
                if df.empty: continue
                row = df[df["strike"] == atm]
                if row.empty: continue
                bid, ask = float(row["bid"].iloc[0]), float(row["ask"].iloc[0])
                if bid <= 0 or ask <= 0 or (ask - bid) / ask > 0.5: continue
                iv = implied_vol((bid+ask)/2, price, atm, T, opt=ot)
                if iv and 0.05 <= iv <= 5.0:
                    ivs.append(iv)
            if not ivs:
                return None
            iv_current = float(np.mean(ivs))
        except Exception as e:
            return None

        iv_rank = calc_iv_rank(iv_current, close)
        if iv_rank < MIN_IV:
            return None

        quad = get_quadrant(iv_rank, rr)

        return {
            "ticker":         ticker,
            "category":       category,
            "price":          round(price, 2),
            "iv_current":     round(iv_current * 100, 1),
            "iv_rank":        iv_rank,
            "risk_reversal":  rr,
            "trend":          trend,
            "rsi":            round(rsi, 1),
            "adx":            round(adx, 1),
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

# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    print(f"OptionScope Scanner — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Universe: {len(ALL_TICKERS)} tickers across {len(TICKERS)} categories")
    print("─" * 65)

    results = []
    for i, ticker in enumerate(ALL_TICKERS):
        print(f"[{i+1:3d}/{len(ALL_TICKERS)}] {ticker:<6}", end="  ")
        r = scan_ticker(ticker)
        if r:
            flag = "🔥" if r["iv_rank"] >= 75 else ("✅" if r["iv_rank"] >= 50 else "  ")
            print(f"IV:{r['iv_current']:6.1f}%  Rank:{r['iv_rank']:5.1f}  ADX:{r['adx']:5.1f}  {r['trend']:<8}  {flag}")
            results.append(r)
        else:
            print("skipped")
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

    print("─" * 65)
    print(f"Done — {len(results)}/{len(ALL_TICKERS)} stocks processed")
    print("\nTop 15 by IV Rank:")
    for r in results[:15]:
        print(f"  {r['ticker']:<6}  IV:{r['iv_current']:6.1f}%  Rank:{r['iv_rank']:5.1f}  [{r['category']}]  {r['quadrant_label']}")

if __name__ == "__main__":
    main()
