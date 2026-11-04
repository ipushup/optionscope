"""daily_calc.py — 由 After-market-brief/daily_brief.py 原封搬過嚟嘅指標函數（ST / UT / EMA / 量能 / RSI / ATR 比 / Whale）。
冇改動邏輯，確保 Daily Table 同 daily brief 報告數字一致。來源 commit: a0b3f93。"""
import numpy as np
import pandas as pd

ST_PERIODS    = 10
ST_MULTIPLIER = 3.0
UT_KEY_VALUE  = 2
UT_ATR_PERIOD = 1
EMA_PERIODS   = [10, 20, 50, 89, 250]


def compute_supertrend(df):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) < ST_PERIODS + 30:
        return None, None
    hl  = df['High'] - df['Low']
    hc  = abs(df['High'] - df['Close'].shift(1))
    lc  = abs(df['Low']  - df['Close'].shift(1))
    tr  = pd.concat([hl, hc, lc], axis=1).max(axis=1)
    atr = tr.rolling(ST_PERIODS).mean()
    src = (df['High'] + df['Low']) / 2
    b_up = (src - ST_MULTIPLIER * atr).values
    b_dn = (src + ST_MULTIPLIER * atr).values
    cl   = df['Close'].values
    n    = len(df)
    f_up = b_up.copy(); f_dn = b_dn.copy()
    trend = np.ones(n, dtype=int)
    for i in range(1, n):
        if np.isnan(b_up[i]) or np.isnan(b_dn[i]):
            trend[i] = trend[i-1]; continue
        f_up[i] = max(b_up[i], f_up[i-1]) if cl[i-1] > f_up[i-1] else b_up[i]
        f_dn[i] = min(b_dn[i], f_dn[i-1]) if cl[i-1] < f_dn[i-1] else b_dn[i]
        if   trend[i-1] == -1 and cl[i] > f_dn[i-1]: trend[i] =  1
        elif trend[i-1] ==  1 and cl[i] < f_up[i-1]: trend[i] = -1
        else:                                          trend[i] = trend[i-1]
    return trend[-1], trend[-2] if n > 1 else trend[-1]


def supertrend_signal_and_trend(df):
    t, p = compute_supertrend(df)
    if t is None: return None, "N/A"
    tr = "Up" if t == 1 else "Down"
    if   t ==  1 and p == -1: sig = "BUY"
    elif t == -1 and p ==  1: sig = "SELL"
    else:                      sig = None
    return sig, tr


def compute_ut_bot(df, key_value=UT_KEY_VALUE, atr_period=UT_ATR_PERIOD):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) < atr_period + 10: return None, None, None

    hl   = df['High'] - df['Low']
    hc   = abs(df['High'] - df['Close'].shift(1))
    lc   = abs(df['Low']  - df['Close'].shift(1))
    tr   = pd.concat([hl, hc, lc], axis=1).max(axis=1)
    atr  = tr.ewm(alpha=1.0/atr_period, adjust=False).mean()

    src  = df['Close'].values
    loss = (key_value * atr).values
    n    = len(src)

    trail = np.zeros(n)
    for i in range(1, n):
        ps = src[i-1]; pt = trail[i-1]; cs = src[i]; lo = loss[i]
        # ATR 有 NaN（High/Low 有窿）嘅 bar：carry trail forward，
        # 唔好俾 NaN poison 條 trail 然後靜默 reset 狀態
        if not np.isfinite(lo) or not np.isfinite(cs):
            trail[i] = pt
            continue
        if   cs > pt and ps > pt: trail[i] = max(pt, cs - lo)
        elif cs < pt and ps < pt: trail[i] = min(pt, cs + lo)
        elif cs > pt:             trail[i] = cs - lo
        else:                     trail[i] = cs + lo

    pos = np.zeros(n, dtype=int)
    for i in range(1, n):
        if   src[i-1] < trail[i-1] and src[i] > trail[i-1]: pos[i] =  1
        elif src[i-1] > trail[i-1] and src[i] < trail[i-1]: pos[i] = -1
        else:                                                  pos[i] = pos[i-1]

    if n < 2: return None, None, None

    ema_last   = src[-1]
    ema_prev   = src[-2]
    trail_last = trail[-1]; trail_prev = trail[-2]

    above = (ema_prev < trail_prev) and (ema_last > trail_last)
    below = (trail_prev < ema_prev) and (trail_last > ema_last)

    cross_signal = None
    if ema_last > trail_last and above: cross_signal = "B"
    if ema_last < trail_last and below: cross_signal = "S"

    pos_state = "L" if pos[-1] == 1 else "S" if pos[-1] == -1 else None

    pos_state  = "L" if pos[-1] == 1 else "S" if pos[-1] == -1 else None
    stop_value = round(float(trail_last), 2)
    return cross_signal, pos_state, stop_value


def compute_ema_status(df):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) < 20:
        return {"pills": [], "stack": False}
    close = df["Close"]
    pills = []; ema_vals = {}
    for p in EMA_PERIODS:
        if len(df) < p:
            pills.append({"period": p, "above": False, "valid": False})
            ema_vals[p] = None
        else:
            e = float(close.ewm(span=p, adjust=False).mean().iloc[-1])
            ema_vals[p] = e
            pills.append({"period": p, "above": float(close.iloc[-1]) > e, "valid": True})
    e10 = ema_vals.get(10); e20 = ema_vals.get(20); e50 = ema_vals.get(50)
    stack = (e10 is not None and e20 is not None and e50 is not None
             and e10 > e20 > e50)
    return {"pills": pills, "stack": stack}


def compute_vol_signal(df):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) < 21 or "Volume" not in df.columns: return "normal"
    try:
        close = df["Close"]; vol = df["Volume"]
        chg   = (float(close.iloc[-1]) - float(close.iloc[-2])) / float(close.iloc[-2])
        avg   = float(vol.iloc[-21:-1].mean())
        ratio = float(vol.iloc[-1]) / avg if avg > 0 else 1.0
        if chg >  0.002 and ratio >= 1.2: return "strong"
        if chg < -0.002 and ratio >= 1.2: return "flush"
        if chg >  0.002 and ratio <= 0.8: return "weak"
        if chg < -0.002 and ratio <= 0.8: return "fade"
        return "normal"
    except Exception: return "normal"


def compute_rsi(df, period=14, ma_period=10, trend_threshold=3):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) < period + ma_period + 5:
        return None, "N/A", "rsi-ok", "", "", None
    try:
        close = df["Close"].astype(float)
        delta = close.diff()
        gain  = delta.clip(lower=0)
        loss  = (-delta).clip(lower=0)
        avg_g = gain.ewm(alpha=1/period, adjust=False).mean()
        avg_l = loss.ewm(alpha=1/period, adjust=False).mean()
        rs    = avg_g / avg_l.replace(0, np.nan)
        rsi_s = 100 - (100 / (1 + rs))
        val   = round(float(rsi_s.iloc[-1]), 1)
        ma10  = float(rsi_s.rolling(ma_period).mean().iloc[-1])
        diff  = val - ma10
        arrow = "▲" if diff > trend_threshold else ("▼" if diff < -trend_threshold else "")
        acss  = "rsi-up" if diff > trend_threshold else ("rsi-dn" if diff < -trend_threshold else "")
        if val >= 75:   css = "rsi-ob"
        elif val >= 70: css = "rsi-ob2"
        elif val <= 30: css = "rsi-os"
        else:           css = "rsi-ok"
        return val, f"{val:.1f}", css, arrow, acss, round(ma10, 1)
    except Exception:
        return None, "N/A", "rsi-ok", "", "", None


def compute_atr_ratio(df, period=14):
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) < period + 5:
        return None, "N/A", "atr-ok"
    try:
        close   = df["Close"].astype(float)
        high    = df["High"].astype(float)
        low     = df["Low"].astype(float)
        tr      = pd.concat([high-low, abs(high-close.shift(1)), abs(low-close.shift(1))], axis=1).max(axis=1)
        atr     = tr.rolling(period).mean()
        atr_val = float(atr.iloc[-1])
        price   = float(close.iloc[-1])
        prev    = float(close.iloc[-2])
        atr_pct = (atr_val / price * 100) if price > 0 else 0
        chg_pct = abs((price - prev) / prev * 100) if prev > 0 else 0
        ratio   = round(chg_pct / atr_pct, 1) if atr_pct > 0 else 0.0
        if ratio >= 2.0:   css = "atr-hot"
        elif ratio >= 1.5: css = "atr-warm"
        else:              css = "atr-ok"
        return ratio, f"{ratio:.1f}x", css
    except Exception:
        return None, "N/A", "atr-ok"


def compute_hv30(df):
    """計算30日年化歷史波動率 (Historical Volatility)"""
    try:
        if df is None or len(df) < 32:
            return None, "—"
        close   = df["Close"].astype(float)
        returns = close.pct_change().dropna()
        hv      = float(returns.rolling(30).std().iloc[-1]) * (252 ** 0.5) * 100
        if pd.isna(hv):
            return None, "—"
        hv = round(hv, 1)
        return hv, f"{hv}%"
    except Exception:
        return None, "—"


def _pine_smoothed_avg(series, length, weight):
    """
    Exact port of Pine Script smoothed_average(src, len, weight):

    sumf := nz(sumf[1]) - nz(src[len]) + src   // rolling sum, nz()=0 for NaN
    ma   := na(src[len]) ? na : sumf / len       // SMA, na during warmup
    out  := na(out[1])   ? ma : (src*w + out[1]*(len-w)) / len

    Key: Pine nz() converts NaN→0, and var float initialises to 0.
    So NaN inputs are treated as 0, and out initialises to 0 not NaN.
    """
    # Pine nz() on input: NaN → 0
    vals = series.fillna(0.0).values.astype(float)
    n    = len(vals)
    out  = np.zeros(n)   # Pine var float = 0 initialisation

    rolling_sum = 0.0
    buf     = np.zeros(length)   # circular buffer
    buf_idx = 0

    for i in range(n):
        # Pine: sumf := nz(sumf[1]) - nz(src[len]) + src
        old_val     = buf[buf_idx]   # oldest value (src[len])
        buf[buf_idx] = vals[i]
        buf_idx      = (buf_idx + 1) % length
        rolling_sum  = rolling_sum - old_val + vals[i]

        # Pine: ma := na(src[len]) ? na : sumf/len
        # src[len] is na for first `length` bars
        if i < length - 1:
            ma = np.nan
        else:
            ma = rolling_sum / length

        # Pine: out := na(out[1]) ? ma : (src*w + out[1]*(len-w)) / len
        if np.isnan(ma):
            out[i] = 0.0    # warmup: Pine var stays 0
        elif i == 0:
            out[i] = ma
        else:
            out[i] = (vals[i] * weight + out[i-1] * (length - weight)) / length

    return pd.Series(out, index=series.index)


def _pine_ema(series, length):
    """
    Exact Pine ema(src, length) = ewm with alpha=2/(length+1), adjust=False.
    Standard pandas ewm matches Pine exactly.
    """
    return series.ewm(span=length, adjust=False).mean()


def compute_whale_history(df, bars=5, lookback=33):
    """
    Exact port of Pine Script whale pump/oust logic (blackcat1402).
    Returns list of last `bars` whale states, oldest first:
      [{"type": "P"|"U"|"W"|"-", "val": float}, ...]
    P = pump  (ema_low_condition rising  → green bar)
    U = oust  (ema_low_condition falling → red bar)
    W = weak  (flat, non-zero)
    - = inactive (zero / below threshold)

    Pine source:
      previous_avg_price = ((low+open+close+high)/4)[1]
      price_deviation_ratio = smoothed_average(abs(low-prev_avg),13,1)
                            / smoothed_average(max(low-prev_avg,0),10,1)
      ema_price_deviation = ema(price_deviation_ratio, 10)
      lowest_low_33 = lowest(low, 33)
      ema_low_condition = ema(low<=lowest_low_33 ? ema_price_deviation : 0, 3)
    """
    if df is None or len(df) < lookback + 30:
        return [{"type": "-", "val": 0.0}] * bars
    try:
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)

        required = ["Low", "Open", "Close", "High"]
        if not all(c in df.columns for c in required):
            return [{"type": "-", "val": 0.0}] * bars

        # previous_avg_price = ((low+open+close+high)/4)[1]
        avg_price = (df["Low"] + df["Open"] + df["Close"] + df["High"]) / 4.0
        prev_avg  = avg_price.shift(1)

        # abs(low - previous_avg_price)
        abs_dev  = (df["Low"] - prev_avg).abs()
        # max(low - previous_avg_price, 0)
        down_dev = (df["Low"] - prev_avg).clip(lower=0)

        # smoothed_average(abs_dev,  13, 1) — exact Pine port
        smooth_abs  = _pine_smoothed_avg(abs_dev,  13, 1)
        # smoothed_average(down_dev, 10, 1) — exact Pine port
        smooth_down = _pine_smoothed_avg(down_dev, 10, 1)

        # price_deviation_ratio = smooth_abs / smooth_down
        # guard against division by zero (Pine nz behaviour)
        ratio = smooth_abs / smooth_down.replace(0.0, np.nan)
        ratio = ratio.fillna(0.0)

        # ema_price_deviation = ema(ratio, 10)
        ema_ratio = _pine_ema(ratio, 10)

        # lowest_low_33 = lowest(low, 33)
        lowest_low = df["Low"].rolling(lookback, min_periods=lookback).min()

        # condition: low <= lowest_low_33
        active = df["Low"] <= lowest_low

        # ema_low_condition = ema(active ? ema_price_deviation : 0, 3)
        signal_raw    = ema_ratio.where(active, 0.0)
        ema_low       = _pine_ema(signal_raw, 3)

        # extract last (bars+1) values to determine direction
        needed = bars + 1
        if len(ema_low) < needed:
            return [{"type": "-", "val": 0.0}] * bars

        vals = ema_low.iloc[-needed:].values
        result = []
        for i in range(1, needed):
            cur  = float(vals[i])
            prev = float(vals[i - 1])
            if cur <= 0.0001:
                t = "-"
            elif cur > prev + 0.0001:
                t = "P"   # pump: rising
            elif cur < prev - 0.0001:
                t = "U"   # oust: falling
            else:
                t = "W"   # weak: flat
            result.append({"type": t, "val": round(cur, 1)})
        return result   # length == bars, oldest first

    except Exception:
        return [{"type": "-", "val": 0.0}] * bars


def format_whale_history(history):
    """
    Returns a list of dicts ready for Jinja2:
    [{"type": "P", "val": "2.1"}, ...]
    Filters out leading dashes so column stays clean.
    """
    # drop leading inactive entries
    start = 0
    for i, h in enumerate(history):
        if h["type"] != "-":
            start = i
            break
    trimmed = history[start:]
    if not trimmed or all(h["type"] == "-" for h in trimmed):
        return []   # all inactive → show "—"
    return [{"type": h["type"], "val": str(h["val"])} for h in trimmed]

