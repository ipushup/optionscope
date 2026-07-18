# -*- coding: utf-8 -*-
# =====================================================================
#  turnaround_radar.py — S1/S2/S3 情境買入雷達 (Turnaround Radar)
#  ---------------------------------------------------------------
#  Companion module for daily_brief.py  (baseline: v21, 3872 lines)
#
#  Usage in daily_brief.py:
#      from turnaround_radar import compute_turnaround_radar, render_radar_html
#      ...
#      radar_cards, radar_meta = compute_turnaround_radar(
#          WATCHLIST_US, WATCHLIST_HK, fetch_df, get_closed_df)
#      radar_html = render_radar_html(radar_cards, radar_meta)
#      # pass  radar_html=radar_html  into Template(...).render(...)
#      # add   {{ radar_html }}       in HTML_TEMPLATE where the section goes
#
#  All signal logic runs on CLOSED candles only (via injected get_closed_df).
#  SuperTrend / UT Bot algorithms are EXACT copies of daily_brief v21 —
#  if you change them there, keep these in sync.
#
#  Pine sources ported (confirmed against user's TradingView):
#    KDJ     : blackcat n1=18 m1=4 m2=4 + ALMA(3,0.85,6)        [KDJ+Whale]
#    CMF     : period 21, 紅/白 = zero cross                     [KDJ+Whale]
#    BigChing: MACD>0 RSI13>50 RSI48>50 P>EMA20/50/89/250 (7)
#              + RS>0 gold row ("轉黃")                           [BSP+BigChing]
#    BSP     : HMA14 buy/sell pressure, 綠 x 粉                   [BSP+BigChing]
#    Channel : pivot half-window 12, min 10 bars, last-2-pivots   [Multi Parallel Channel]
#
#  User-confirmed decisions:
#    B.4  keep — bypass stocks still need a recent B signal
#    G3.3 relaxed — S3 weekly EMA89 gate passes within <10%
#    V.5  on — earnings within 7 trading days flags ⚠ER
#    KDJ veto (a): J>80 overbought / J<20 oversold
#    UT Bot: plain close source (no Heikin Ashi)
# =====================================================================

import numpy as np
import pandas as pd
from jinja2 import Template

# ---------------------------------------------------------------------
#  CONFIG
# ---------------------------------------------------------------------
ST_PERIODS    = 10
ST_MULTIPLIER = 3.0
UT_KEY_VALUE  = 2
UT_ATR_PERIOD = 1

RS_MA_LEN       = 180
RS_SLOPE_LOOKBK = 20

L1_PRICE_BAND     = 0.25
L1_SIGNAL_WINDOW  = 10
L1_MIN_DOLLAR_US  = 5_000_000
L1_MIN_DOLLAR_HK  = 2_000_000

S3_FLAT_SLOPE_MAX = -0.5     # %/week
S3_LINE_DIST_MAX  = 5.0      # %
G33_EMA89_RELAX   = 10.0     # % (user: 放寬)

KDJ_OVERBOUGHT = 80
KDJ_OVERSOLD   = 20
V3_EMA_DIST    = 2.0
V4_CH_DIST     = 3.0
V5_EARN_DAYS   = 7

MAX_CARDS   = 30
MIN_GATE_IN = 3

SCEN_META = {
    "S1": {"name": "S1 強勢延續", "en": "Momentum",    "pos": "1/1",
           "stop_lbl": "Weekly EMA10",  "tagcls": "tag-s1", "grpcls": "s1",
           "buy": "動能股：回踩 EMA10 即買，唔等深回。"},
    "S2": {"name": "S2 強勢修復", "en": "RS Recovery", "pos": "2/3",
           "stop_lbl": "Weekly EMA20",   "tagcls": "tag-s2", "grpcls": "s2",
           "buy": "修復股：等 RS 轉正日或 BigChing 7/7 全綠日入。"},
    "S3": {"name": "S3 轉勢初期", "en": "Turnaround",  "pos": "1/2",
           "stop_lbl": "UT Bot 止損線", "tagcls": "tag-s3", "grpcls": "s3",
           "buy": "轉勢股：唔追阻力/通道上軌，等回踩 EMA20/50 企穩先入。"},
}

# =====================================================================
#  SHARED-WITH-DAILY_BRIEF ALGORITHMS (exact copies)
# =====================================================================
def _flatten(df):
    if isinstance(df.columns, pd.MultiIndex):
        df = df.copy()
        df.columns = df.columns.get_level_values(0)
    return df


def supertrend_series(df):
    """daily_brief.compute_supertrend algorithm, extended to full series.
    Returns (trend +1/-1 array, active line array)."""
    df = _flatten(df)
    if len(df) < ST_PERIODS + 30:
        return None, None
    hl  = df['High'] - df['Low']
    hc  = (df['High'] - df['Close'].shift(1)).abs()
    lc  = (df['Low']  - df['Close'].shift(1)).abs()
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
        else:                                        trend[i] = trend[i-1]
    line = np.where(trend == 1, f_up, f_dn)
    return trend, line


def ut_bot_events(df, key_value=UT_KEY_VALUE, atr_period=UT_ATR_PERIOD, lookback=120):
    """daily_brief.compute_ut_bot_history trailing/crossover logic.
    Returns (events [(bar_idx, 'B'|'S')...], trail array)."""
    df = _flatten(df)
    if len(df) < atr_period + 10:
        return [], None
    hl  = df['High'] - df['Low']
    hc  = (df['High'] - df['Close'].shift(1)).abs()
    lc  = (df['Low']  - df['Close'].shift(1)).abs()
    tr  = pd.concat([hl, hc, lc], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1.0/atr_period, adjust=False).mean()
    src  = df['Close'].values
    loss = (key_value * atr).values
    n    = len(src)
    trail = np.zeros(n)
    for i in range(1, n):
        ps, pt, cs, lo = src[i-1], trail[i-1], src[i], loss[i]
        if   cs > pt and ps > pt: trail[i] = max(pt, cs - lo)
        elif cs < pt and ps < pt: trail[i] = min(pt, cs + lo)
        elif cs > pt:             trail[i] = cs - lo
        else:                     trail[i] = cs + lo
    start = max(1, n - lookback)
    events = []
    for i in range(start, n):
        above = (src[i-1] <= trail[i-1]) and (src[i] > trail[i])
        below = (trail[i-1] <= src[i-1]) and (trail[i] > src[i])
        if src[i] > trail[i] and above:   events.append((i, "B"))
        elif src[i] < trail[i] and below: events.append((i, "S"))
    return events, trail


def mansfield_rs(price, bench, n=RS_MA_LEN):
    ratio = price / bench
    return (ratio / ratio.rolling(n).mean() - 1) * 100


# =====================================================================
#  PINE PORTS
# =====================================================================
def pine_smoothed_avg(series, length, weight):
    src = np.asarray(series, dtype=float)
    n = len(src); out = np.full(n, np.nan)
    ma = pd.Series(src).rolling(length).mean().values
    for i in range(n):
        # Pine: ma valid only when src[length] exists (i >= length) — exact warm-up parity
        if i < length or np.isnan(ma[i]): continue
        if np.isnan(out[i-1]): out[i] = ma[i]
        else: out[i] = (src[i] * weight + out[i-1] * (length - weight)) / length
    return out


def pine_alma(series, length=3, offset=0.85, sigma=6.0):
    src = np.asarray(series, dtype=float)
    n = len(src)
    m = offset * (length - 1); s = length / sigma
    w = np.exp(-((np.arange(length) - m) ** 2) / (2 * s * s)); w /= w.sum()
    out = np.full(n, np.nan)
    for i in range(length - 1, n):
        win = src[i - length + 1: i + 1]
        if np.isnan(win).any(): continue
        out[i] = float(np.dot(win, w))
    return out


def compute_kdj(df, n1=18, m1=4, m2=4):
    df = _flatten(df)
    high, low, close = df['High'].astype(float), df['Low'].astype(float), df['Close'].astype(float)
    ll = low.rolling(n1).min(); hh = high.rolling(n1).max()
    rng = (hh - ll).replace(0, np.nan)
    rsv = ((close - ll) / rng * 100).values
    k = pine_alma(pine_smoothed_avg(rsv, m1, 1))
    d = pine_alma(pine_smoothed_avg(k,   m2, 1))
    j = pine_alma(3 * k - 2 * d)
    return k, d, j


def compute_cmf(df, length=21):
    df = _flatten(df)
    high, low  = df['High'].astype(float), df['Low'].astype(float)
    close, vol = df['Close'].astype(float), df['Volume'].astype(float)
    rng = high - low
    mult = np.where(rng != 0, ((close - low) - (high - close)) / rng, 0.0)
    mf   = pd.Series(mult * vol.values, index=df.index)
    return mf.rolling(length).mean() / vol.rolling(length).mean()


def cmf_status_label(v):
    if v >= 0.25:  return "超流入🚀🚀"
    if v >= 0.15:  return "強流入🚀"
    if v >= 0.05:  return "流入✅"
    if v <= -0.25: return "超流出⚠️⚠️"
    if v <= -0.15: return "強流出⚠️"
    if v <= -0.05: return "流出❌"
    return "中性"


def pine_rsi(s, length):
    delta = s.diff()
    up, dn = delta.clip(lower=0), (-delta).clip(lower=0)
    rma_up = up.ewm(alpha=1/length, adjust=False).mean()
    rma_dn = dn.ewm(alpha=1/length, adjust=False).mean()
    rs = rma_up / rma_dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def _gap_txt(c, lvl):
    if not np.isfinite(lvl) or lvl == 0: return "—"
    return f"{(c / lvl - 1) * 100:+.1f}%"


def compute_bigching(df):
    """7 trend conditions. RS gold row ('轉黃') handled by caller via mansfield_rs."""
    df = _flatten(df)
    close = df['Close'].astype(float)
    macd = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
    rsi13, rsi48 = pine_rsi(close, 13), pine_rsi(close, 48)
    e = {p: float(close.ewm(span=p, adjust=False).mean().iloc[-1]) for p in (20, 50, 89, 250)}
    c = float(close.iloc[-1])
    conds = [
        ("MACD>0",   float(macd.iloc[-1]) > 0,  f"{float(macd.iloc[-1]):.3f}"),
        ("RSI13>50", float(rsi13.iloc[-1]) > 50, f"{float(rsi13.iloc[-1]):.1f}"),
        ("RSI48>50", float(rsi48.iloc[-1]) > 50, f"{float(rsi48.iloc[-1]):.1f}"),
        ("P>EMA20",  c > e[20],  _gap_txt(c, e[20])),
        ("P>EMA50",  c > e[50],  _gap_txt(c, e[50])),
        ("P>EMA89",  c > e[89],  _gap_txt(c, e[89])),
        ("P>EMA250", c > e[250], _gap_txt(c, e[250])),
    ]
    return {"conds": conds, "green": sum(1 for _, ok, _ in conds if ok)}


def _wma(s, length):
    w = np.arange(1, length + 1, dtype=float)
    return s.rolling(length).apply(lambda x: np.dot(x, w) / w.sum(), raw=True)


def compute_bsp(df, length=14):
    df = _flatten(df)
    close = df['Close'].astype(float)
    high, low = df['High'].astype(float), df['Low'].astype(float)
    bp = close - pd.concat([low,  close.shift(1)], axis=1).min(axis=1)
    sp = pd.concat([high, close.shift(1)], axis=1).max(axis=1) - close

    def hma(s, n):
        half, rt = max(1, n // 2), max(1, int(round(np.sqrt(n))))
        return _wma(2 * _wma(s, half) - _wma(s, n), rt)

    bpma, spma = hma(bp, length), hma(sp, length)
    above    = bpma > spma
    cross_up = above & ~above.shift(1).fillna(False).astype(bool)
    gap      = spma - bpma
    conv = (~above) & (gap < gap.shift(1)) & (gap.shift(1) < gap.shift(2)) & (gap.shift(2) < gap.shift(3))
    xs = np.where(cross_up.values)[0]
    return {"green_above":  bool(above.iloc[-1]),
            "green_rising": bool((bpma > bpma.shift(1)).iloc[-1]),
            "converging":   bool(conv.iloc[-1]) if len(conv) else False,
            "bars_since_x": int(len(df) - 1 - xs[-1]) if len(xs) else None}


def compute_channels(df, depth=240, min_bars=10):
    df = _flatten(df).reset_index(drop=True)
    half_win = max(3, depth // 10 // 2)
    high, low = df['High'].astype(float), df['Low'].astype(float)
    n = len(df); last = n - 1

    def find_pivots(series, is_high):
        vals = series.values
        idx_l, prc_l = [], []
        for i in range(half_win, n - half_win):
            win = vals[i - half_win: i + half_win + 1]
            ok = (vals[i] >= win.max()) if is_high else (vals[i] <= win.min())
            if not ok: continue
            if idx_l and (i - idx_l[-1]) < min_bars: continue
            idx_l.append(i); prc_l.append(float(vals[i]))
            if len(idx_l) > 4: idx_l.pop(0); prc_l.pop(0)
        return idx_l, prc_l

    h_idx, h_prc = find_pivots(high, True)
    l_idx, l_prc = find_pivots(low,  False)
    out = {"desc_upper": None, "desc_lower": None,
           "asc_upper": None,  "asc_lower": None, "desc_upper_dist_pct": None}

    if len(h_idx) >= 2:
        i1, p1, i2, p2 = h_idx[-2], h_prc[-2], h_idx[-1], h_prc[-1]
        if p2 < p1 and (i2 - i1) >= min_bars:
            seg = low.iloc[i1:i2 + 1]
            lo, lo_bar = float(seg.min()), int(seg.reset_index(drop=True).idxmin() + i1)
            slope = (p2 - p1) / max(i2 - i1, 1)
            vb = slope * last + (p1 - slope * i1)
            vp = slope * last + (lo - slope * lo_bar)
            out["desc_upper"], out["desc_lower"] = max(vb, vp), min(vb, vp)

    if len(l_idx) >= 2:
        i1, p1, i2, p2 = l_idx[-2], l_prc[-2], l_idx[-1], l_prc[-1]
        if p2 > p1 and (i2 - i1) >= min_bars:
            seg = high.iloc[i1:i2 + 1]
            hi, hi_bar = float(seg.max()), int(seg.reset_index(drop=True).idxmax() + i1)
            slope = (p2 - p1) / max(i2 - i1, 1)
            vb = slope * last + (p1 - slope * i1)
            vp = slope * last + (hi - slope * hi_bar)
            out["asc_upper"], out["asc_lower"] = max(vb, vp), min(vb, vp)

    close = float(df['Close'].iloc[-1])
    if out["desc_upper"] and out["desc_lower"] and out["desc_lower"] <= close <= out["desc_upper"]:
        out["desc_upper_dist_pct"] = round((out["desc_upper"] / close - 1) * 100, 2)
    return out


# =====================================================================
#  PIPELINE HELPERS
# =====================================================================
def _rs_now_slope(price, bench_close):
    b = bench_close.reindex(price.index, method='ffill')
    rs = mansfield_rs(price, b)
    rs_valid = rs.dropna()
    if len(rs_valid) < RS_SLOPE_LOOKBK + 2:
        return None, None
    tail = rs_valid.iloc[-RS_SLOPE_LOOKBK:]
    return float(rs_valid.iloc[-1]), float(np.polyfit(np.arange(len(tail)), tail.values, 1)[0])


def _st_flat(weekly_line, weekly_trend, close):
    if weekly_trend is None or weekly_trend[-1] != -1 or len(weekly_line) < 21:
        return None
    seg, prev = weekly_line[-10:], weekly_line[-20:-10]
    if np.isnan(seg).any() or np.isnan(prev).any() or seg.mean() == 0:
        return None
    sl  = float(np.polyfit(np.arange(10), seg, 1)[0]) / seg.mean() * 100
    slp = float(np.polyfit(np.arange(10), prev, 1)[0]) / prev.mean() * 100
    dist = (seg[-1] - close) / close * 100
    return {"slope": round(sl, 2), "prev_slope": round(slp, 2),
            "dist": round(dist, 2), "line": round(float(seg[-1]), 2),
            "flat_ok": sl > S3_FLAT_SLOPE_MAX and sl > slp,
            "near_ok": 0 <= dist < S3_LINE_DIST_MAX}


def _recent_b(daily_trend, ut_events, n_bars, window=L1_SIGNAL_WINDOW):
    best = None
    if daily_trend is not None:
        for i in range(max(1, n_bars - window), n_bars):
            if daily_trend[i] == 1 and daily_trend[i-1] == -1:
                best = ("ST B", n_bars - i, i)
    for idx, sig in ut_events:
        if sig == "B" and (n_bars - idx) <= window:
            if best is None or idx > best[2]:
                best = ("UT Bot B", n_bars - idx, idx)
    return best


def _run_len(trend, val):
    n = 0
    for t in trend[::-1]:
        if t == val: n += 1
        else: break
    return n


def _earnings_in_days(ticker, trading_days=V5_EARN_DAYS):
    try:
        import yfinance as yf
        cal = yf.Ticker(ticker).calendar
        dates = None
        if isinstance(cal, dict):
            dates = cal.get("Earnings Date")
        elif cal is not None and hasattr(cal, "loc") and "Earnings Date" in getattr(cal, "index", []):
            dates = list(cal.loc["Earnings Date"])
        if not dates:
            return None
        d0 = pd.Timestamp(dates[0] if isinstance(dates, (list, tuple)) else dates)
        bd = int(np.busday_count(pd.Timestamp.now().date(), d0.date()))
        return bd if 0 <= bd <= trading_days else None
    except Exception:
        return None


# =====================================================================
#  PER-TICKER ANALYSIS
# =====================================================================
def _analyze_ticker(ticker, market, fetch_df, get_closed_df, bench_close, breadth_acc=None):
    daily_raw = fetch_df(ticker, "1d", "2y")
    if daily_raw is None or daily_raw.empty:
        return None
    daily_full = _flatten(daily_raw).dropna(subset=["Close"])
    if len(daily_full) < 120:                                     # Layer 0.1
        return None
    try:                                                          # Layer 0.3 staleness
        now = pd.Timestamp.now(tz=getattr(daily_full.index[-1], "tzinfo", None))
        if (now - daily_full.index[-1]).days > 7:
            return None
    except Exception:
        pass
    daily = get_closed_df(daily_full, "1d")
    close = daily['Close'].astype(float)
    c = float(close.iloc[-1])
    emas = {p: close.ewm(span=p, adjust=False).mean() for p in (10, 20, 50, 89, 250)}
    e250 = float(emas[250].iloc[-1])

    # ── market breadth: count this ticker regardless of scenario outcome ──
    if breadth_acc is not None:
        try:
            e50 = float(emas[50].iloc[-1])
            e200 = float(close.ewm(span=200, adjust=False).mean().iloc[-1])
            btrend, _ = supertrend_series(daily)
            breadth_acc["n"] += 1
            if btrend is not None and btrend[-1] == 1:
                breadth_acc["st_b"] += 1
            if c > e50:
                breadth_acc["e50"] += 1
            if c > e200:
                breadth_acc["e200"] += 1
        except Exception:
            pass

    # ---- Layer 1 ------------------------------------------------------
    rs = _rs_now_slope(close, bench_close)
    if rs[0] is None:
        return None
    rs_now, rs_slope = rs
    in_band  = abs(c / e250 - 1) <= L1_PRICE_BAND
    bypass_r = (c > e250) and (rs_now < 0) and (rs_slope > 0)      # S2 通道 (user-confirmed)
    bypass_m = (c > e250) and (rs_now > 0)                          # S1 通道 (leadership;
    #   needed so真·強勢股唔會被 ±25% band 排除 — weekly checks below決定佢係咪 S1)
    if not (in_band or bypass_r or bypass_m):
        return None

    daily_trend, daily_line = supertrend_series(daily)
    ut_ev, ut_trail = ut_bot_events(daily)
    if daily_trend is None:
        return None
    recent = _recent_b(daily_trend, ut_ev, len(daily))              # B.4: 全部照查
    if recent is None:
        return None

    vol = daily['Volume'].astype(float)
    dollar20 = float((close * vol).rolling(20).mean().iloc[-1])
    if not np.isfinite(dollar20) or dollar20 < (L1_MIN_DOLLAR_HK if market == "HK" else L1_MIN_DOLLAR_US):
        return None

    # ---- weekly (lazy) -------------------------------------------------
    weekly_raw = fetch_df(ticker, "1wk", "5y")
    if weekly_raw is None or weekly_raw.empty:
        return None
    weekly = get_closed_df(_flatten(weekly_raw).dropna(subset=["Close"]), "1wk")
    wclose = weekly['Close'].astype(float)
    e10w = float(wclose.ewm(span=10, adjust=False).mean().iloc[-1])
    e20w = float(wclose.ewm(span=20, adjust=False).mean().iloc[-1])
    e89w = float(wclose.ewm(span=89, adjust=False).mean().iloc[-1])
    ema89w_short = len(wclose) < 89
    weekly_trend, weekly_line = supertrend_series(weekly)
    if weekly_trend is None:
        return None
    w_stack = c > e10w > e20w
    flat = _st_flat(weekly_line, weekly_trend, c)

    # ---- Layer 2: scenario ---------------------------------------------
    scen, scen_rows = None, []
    if w_stack and weekly_trend[-1] == 1 and rs_now > 0:
        scen = "S1"
        scen_rows = [
            ("Weekly EMA stack", True, f"P > E10w {e10w:.2f} > E20w {e20w:.2f}"),
            ("Weekly ST = B",    True, f"buy line，連續 {_run_len(weekly_trend, 1)} 週"),
            ("Daily RS > 0",     True, f"Mansfield RS {rs_now:+.1f}"),
        ]
    elif (c > e250) and (c >= e89w) and (weekly_trend[-1] == 1) and (rs_now < 0) and (rs_slope > 0):
        scen = "S2"
        eta = abs(rs_now / rs_slope) if rs_slope > 0 else None
        scen_rows = [
            ("價 > EMA250",         True, f"{_gap_txt(c, e250)} vs EMA250 {e250:.2f}"),
            ("Weekly 結構完好",     True, f"P ≥ EMA89w {e89w:.2f} ✓ · Weekly ST = B ✓"),
            ("Daily RS < 0 改善中", True,
             f"RS {rs_now:+.1f}，斜率 {rs_slope:+.2f}/日"
             + (f"（約 {eta:.0f} 日轉正）" if eta and eta < 30 else "")),
        ]
        if flat and flat["flat_ok"]:
            scen_rows.append(("亦具 S3 特徵", True, "weekly ST 紅線曾走平"))
    elif flat is not None and flat["flat_ok"] and flat["near_ok"]:
        cmf_d0 = compute_cmf(daily)
        cmf_l  = float(cmf_d0.iloc[-1])
        if cmf_l > 0 or bool((cmf_d0.iloc[-5:] > 0).any()):
            scen = "S3"
            scen_rows = [
                ("Weekly ST = Sell", True, f"紅線 {flat['line']:.2f}，維持 {_run_len(weekly_trend, -1)} 週"),
                ("紅線走平",         True,
                 f"近10週 {flat['slope']:+.2f}%/週（前10週 {flat['prev_slope']:+.2f}%/週）"),
                ("價貼紅線",         True, f"距離 {flat['dist']:.1f}% < {S3_LINE_DIST_MAX:.0f}%"),
                ("Daily B 訊號",     True, f"{recent[0]} {recent[1]} bar 前"),
                ("Daily CMF 轉正",   True, f"{cmf_l:+.3f}"),
            ]
    if scen is None:
        return None

    # ---- indicators for GATE/SCORE/VETO ---------------------------------
    cmf_dv = float(compute_cmf(daily).iloc[-1])
    cmf_w  = compute_cmf(weekly)
    cmf_wv = float(cmf_w.iloc[-1])
    _, _, j = compute_kdj(daily)
    j_now = float(j[-1]) if len(j) and not np.isnan(j[-1]) else None
    bc  = compute_bigching(daily)
    bsp = compute_bsp(daily)
    ch  = compute_channels(daily.iloc[-260:] if len(daily) > 260 else daily)
    e10d, e20d = float(emas[10].iloc[-1]), float(emas[20].iloc[-1])
    d_stack = c > e10d > e20d
    e10_rising = bool(emas[10].diff().iloc[-1] > 0)
    ut_pos_up = ut_trail is not None and c > float(ut_trail[-1])
    st_b = daily_trend[-1] == 1

    sig_i = recent[2]
    v20 = vol.rolling(20).mean()
    vr = float(vol.iloc[sig_i] / v20.iloc[sig_i]) if np.isfinite(v20.iloc[sig_i]) and v20.iloc[sig_i] > 0 else None

    # ---- Layer 3: GATE ---------------------------------------------------
    if scen == "S1":
        gates = [
            ("Daily SuperTrend = B", st_b, f"連續 {_run_len(daily_trend, 1)} 日"),
            ("Daily UT Bot = B",     ut_pos_up, f"stop {float(ut_trail[-1]):.2f}"),
            ("Daily CMF > 0",        cmf_dv > 0, f"{cmf_dv:+.3f} {cmf_status_label(cmf_dv)}"),
            ("Daily EMA stack",      d_stack,
             f"E10 {e10d:.2f} {'>' if e10d > e20d else '<'} E20 {e20d:.2f}"),
        ]
    elif scen == "S2":
        gates = [
            ("Daily ST B + UT Bot B", st_b and ut_pos_up,
             f"ST {'✓' if st_b else '✗'} · UT {'✓' if ut_pos_up else '✗'}"),
            ("Daily CMF > 0",         cmf_dv > 0, f"{cmf_dv:+.3f} {cmf_status_label(cmf_dv)}"),
            ("Weekly P ≥ EMA89",      c >= e89w, _gap_txt(c, e89w)),
            ("Weekly ST = B",         weekly_trend[-1] == 1,
             f"連續 {_run_len(weekly_trend, 1)} 週"),
        ]
    else:
        e89_dist = (e89w / c - 1) * 100 if c < e89w else 0.0
        g33 = (c >= e89w) or (e89_dist < G33_EMA89_RELAX)
        g33_txt = _gap_txt(c, e89w) + ("" if c >= e89w else f"（放寬 <{G33_EMA89_RELAX:.0f}% 過）")
        gates = [
            ("Daily ST B + UT Bot B", st_b and ut_pos_up,
             f"ST {'✓' if st_b else '✗'} · UT {'✓' if ut_pos_up else '✗'}"),
            ("Daily CMF > 0",         cmf_dv > 0, f"{cmf_dv:+.3f} {cmf_status_label(cmf_dv)}"),
            ("Weekly P ≥ EMA89（放寬）", g33, g33_txt),
            ("Weekly ST 走平+貼線",   flat["flat_ok"] and flat["near_ok"],
             f"{flat['slope']:+.2f}%/週 · 距 {flat['dist']:.1f}%"),
        ]
    gate_n = sum(1 for _, ok, _ in gates if ok)
    if gate_n < MIN_GATE_IN:
        return None

    # ---- Layer 4: SCORE (14) ---------------------------------------------
    sc = []
    p = (2 if rs_slope > 0 else 0) + (1 if rs_now > 0 else 0)
    sc.append(("RS 改善", p, 3, f"斜率 {rs_slope:+.2f}/日 {'✓' if rs_slope>0 else '✗'} · RS {rs_now:+.1f}"))
    p = int(bc["green"] / 7 * 3)          # floor: 7/7=3, 5-6/7=2, 3-4/7=1
    miss = [f"{n_} {v_}" for n_, ok_, v_ in bc["conds"] if not ok_]
    sc.append(("BigChing 7 條件", p, 3,
               f"{bc['green']}/7" + (f"（欠 {'; '.join(miss[:3])}）" if miss else " 全綠")))
    p = 2 if d_stack else (1 if e10_rising else 0)
    sc.append(("Daily EMA stack", p, 2,
               "P>E10>E20 成立" if d_stack else ("EMA10 斜率轉正" if e10_rising else "未成形")))
    cmf_w_rising = bool((cmf_w.diff().iloc[-4:] > 0).sum() >= 3)
    p = 2 if cmf_wv > 0 else (1 if cmf_w_rising else 0)
    sc.append(("Weekly CMF", p, 2, f"{cmf_wv:+.3f}" + ("" if cmf_wv > 0 else (" 改善中" if cmf_w_rising else ""))))
    p = 2 if (vr or 0) >= 1.5 else (1 if (vr or 0) >= 1.2 else 0)
    sc.append(("Volume 確認", p, 2, f"{recent[0]}日 vol {vr:.2f}x" if vr else "N/A"))
    p = 2 if (bsp["green_above"] and bsp["green_rising"]) else \
        (1 if (bsp["converging"] or (bsp["bars_since_x"] is not None and bsp["bars_since_x"] <= 5)) else 0)
    bsp_txt = ("綠線在上升緊" if p == 2 else
               ("收斂中" if bsp["converging"] else
                (f"{bsp['bars_since_x']} bar 前上穿" if bsp["bars_since_x"] is not None and bsp["bars_since_x"] <= 5
                 else "綠線在下")))
    sc.append(("BSP 綠x粉", p, 2, bsp_txt))
    score = sum(p_ for _, p_, _, _ in sc)

    # ---- Layer 5: VETO -----------------------------------------------------
    vetoes = []
    v1 = j_now is not None and j_now > KDJ_OVERBOUGHT
    if v1:
        vetoes.append(("⚠️", "KDJ 超買", f"J={j_now:.1f} > {KDJ_OVERBOUGHT} → 等回落"))
    if j_now is not None and j_now < KDJ_OVERSOLD and c > float(close.iloc[-2]):
        vetoes.append(("ℹ️", "KDJ 矛盾", f"J={j_now:.1f} 超賣但價升 → 等回踩"))
    overhead = [(f"EMA{p_}", float(emas[p_].iloc[-1])) for p_ in (20, 50, 89, 250)
                if float(emas[p_].iloc[-1]) > c]
    if overhead:
        nm, lvl = min(overhead, key=lambda x: x[1])
        dist = (lvl / c - 1) * 100
        if dist < V3_EMA_DIST:
            vetoes.append(("ℹ️" if d_stack else "⚠️", "EMA 阻力",
                           f"{nm} 於 +{dist:.1f}% ({lvl:.2f})" + ("（stack 成立→提示）" if d_stack else "")))
    v4 = ch["desc_upper_dist_pct"] is not None and ch["desc_upper_dist_pct"] < V4_CH_DIST
    if v4:
        vetoes.append(("⚠️", "下降通道上軌",
                       f"距上軌 {ch['desc_upper_dist_pct']:.1f}% ({ch['desc_upper']:.2f}) → 唔追"))
    earn = _earnings_in_days(ticker)
    if earn is not None:
        vetoes.append(("⚠️", "Earnings 臨近", f"{earn} 個交易日內業績 ⚠ER"))
    warn_n = sum(1 for ic, _, _ in vetoes if ic == "⚠️")

    # ---- Layer 6: conclusion / stop / position -------------------------------
    if gate_n == 4 and not v1 and not v4 and (scen == "S1" or w_stack):
        concl, ccls = ("🟢 回踩 EMA10 即買" if scen == "S1" else "🟢 可入"), "concl-green"
    elif gate_n == 4:
        if scen == "S2":   concl = "🟡 RS 轉正日入"
        elif scen == "S3": concl = f"🟡 等回踩 EMA20 ({e20d:.2f})"
        else:              concl = "🟡 等回踩"
        ccls = "concl-amber"
    else:
        concl, ccls = "⚪ 觀察", "concl-gray"

    if scen == "S1":
        stop = e10w                                      # weekly EMA10 (動能股紀律止蝕)
    elif scen == "S2":
        stop = e20w                                      # weekly EMA20
    else:                                                # S3: 紅線在價上方，唔可以做止蝕
        stop = float(ut_trail[-1])                       # daily UT Bot 止損線
        if stop >= c:                                    # 罕見 fallback: 20 日低點
            stop = float(daily['Low'].astype(float).rolling(20).min().iloc[-1])
    stop_pct = (stop / c - 1) * 100

    levels = {
        "ema10d": round(e10d, 4), "ema20d": round(e20d, 4),
        "ema50d": round(float(emas[50].iloc[-1]), 4),
        "ema250d": round(e250, 4),
        "ema10w": round(e10w, 4), "ema20w": round(e20w, 4), "ema89w": round(e89w, 4),
        "ut_stop": round(float(ut_trail[-1]), 4) if ut_trail is not None else None,
        "st_line_d": round(float(daily_line[-1]), 4),
        "st_line_w": round(flat["line"], 4) if flat else None,
        "ch_upper": round(ch["desc_upper"], 4) if ch["desc_upper"] else None,
        "ch_lower": round(ch["desc_lower"], 4) if ch["desc_lower"] else None,
        "kdj_j": round(j_now, 1) if j_now is not None else None,
        "cmf_d": round(cmf_dv, 3),
        "bigching": bc["green"],
    }

    return {"ticker": ticker, "market": market, "price": c, "scen": scen,
            "levels": levels,
            "scen_rows": scen_rows, "gates": gates, "gate_n": gate_n,
            "scores": sc, "score": score, "max_score": 14,
            "vetoes": vetoes, "warn_n": warn_n,
            "concl": concl, "concl_cls": ccls,
            "stop": stop, "stop_pct": stop_pct,
            "rs_now": rs_now, "rs_slope": rs_slope,
            "w_stack": w_stack, "ema89w_short": ema89w_short,
            "meta": SCEN_META[scen]}


# =====================================================================
#  ENTRY POINT
# =====================================================================
# ── index regime: daily ST + price vs EMA20/EMA50 ───────────────────
US_INDICES = [("S&P", "^GSPC"), ("NAS", "^IXIC"), ("DOW", "^DJI")]
HK_INDICES = [("HSI", "^HSI"), ("HSCE", "^HSCE")]


def _index_state(tkr, fetch_df, get_closed_df):
    """One index → dict(st, above20, above50, chg_pct) or None."""
    raw = fetch_df(tkr, "1d", "2y")
    if raw is None or raw.empty:
        return None
    df = get_closed_df(_flatten(raw).dropna(subset=["Close"]), "1d")
    if len(df) < 60:
        return None
    close = df["Close"].astype(float)
    c = float(close.iloc[-1])
    e20 = float(close.ewm(span=20, adjust=False).mean().iloc[-1])
    e50 = float(close.ewm(span=50, adjust=False).mean().iloc[-1])
    trend, _ = supertrend_series(df)
    prev = float(close.iloc[-2]) if len(close) > 1 else c
    return {
        "st": "B" if (trend is not None and trend[-1] == 1) else "S",
        "above20": c > e20, "above50": c > e50,
        "chg_pct": round((c / prev - 1) * 100, 2) if prev else 0.0,
    }


def _regime_from_indices(states):
    """🟢/🟡/🔴 from a list of index-state dicts.
    Risk On  = every index ST=B and price>EMA20.
    Risk Off = majority ST=S or below EMA20.
    else Mixed."""
    valid = [s for s in states if s]
    if not valid:
        return "unknown"
    on  = sum(1 for s in valid if s["st"] == "B" and s["above20"])
    off = sum(1 for s in valid if s["st"] == "S" or not s["above20"])
    if on == len(valid):
        return "on"
    if off > len(valid) / 2:
        return "off"
    return "mixed"


def compute_turnaround_radar(watchlist_us, watchlist_hk, fetch_df, get_closed_df,
                             bench_us_ticker="SPY", bench_hk_ticker="^HSI",
                             prev_breadth=None):
    """Returns (cards, meta). cards sorted S1→S2→S3, gate4 first, score desc.
    Market regime downgrade (B): when a market is Risk Off, its S1+S2 🟢 cards
    become 🟡; when Mixed, only S1 🟢 downgrades. S3 and alerts never downgrade."""
    def bench_close(tkr):
        b = fetch_df(tkr, "1d", "2y")
        if b is None or b.empty:
            return None
        return _flatten(b)['Close'].astype(float)

    bench_us, bench_hk = bench_close(bench_us_ticker), bench_close(bench_hk_ticker)

    # ── breadth accumulators (counted while scanning, zero extra fetches) ──
    breadth = {"US": {"st_b": 0, "e50": 0, "e200": 0, "n": 0},
               "HK": {"st_b": 0, "e50": 0, "e200": 0, "n": 0}}

    cards = []
    for market, wl, bench in (("US", watchlist_us, bench_us), ("HK", watchlist_hk, bench_hk)):
        if bench is None:
            print(f"  radar: {market} benchmark missing — skipped")
            continue
        for t in wl:
            try:
                r = _analyze_ticker(t, market, fetch_df, get_closed_df, bench,
                                    breadth_acc=breadth[market])
            except Exception as e:
                print(f"  radar warn {t}: {e}")
                r = None
            if r is not None:
                cards.append(r)

    # ── index regimes + VIX ──
    us_idx = {nm: _index_state(tk, fetch_df, get_closed_df) for nm, tk in US_INDICES}
    hk_idx = {nm: _index_state(tk, fetch_df, get_closed_df) for nm, tk in HK_INDICES}
    us_regime = _regime_from_indices(list(us_idx.values()))
    hk_regime = _regime_from_indices(list(hk_idx.values()))
    vix_raw = fetch_df("^VIX", "1d", "6mo")
    vix = None
    if vix_raw is not None and not vix_raw.empty:
        vc = _flatten(vix_raw)["Close"].astype(float)
        vix = {"val": round(float(vc.iloc[-1]), 1),
               "up": bool(len(vc) > 1 and vc.iloc[-1] > vc.iloc[-2])}

    def breadth_pct(m):
        b = breadth[m]; n = max(b["n"], 1)
        return {"st_b": round(b["st_b"] / n * 100),
                "e50": round(b["e50"] / n * 100),
                "e200": round(b["e200"] / n * 100),
                "n": b["n"]}
    breadth_out = {"US": breadth_pct("US"), "HK": breadth_pct("HK")}

    # attach yesterday deltas if provided
    if prev_breadth:
        for m in ("US", "HK"):
            pv = prev_breadth.get(m, {})
            for k in ("st_b", "e50", "e200"):
                if k in pv:
                    breadth_out[m][f"{k}_prev"] = pv[k]

    market = {
        "US": {"regime": us_regime, "indices": us_idx, "breadth": breadth_out["US"]},
        "HK": {"regime": hk_regime, "indices": hk_idx, "breadth": breadth_out["HK"]},
        "vix": vix,
    }

    # ── (B) downgrade conclusions per market regime ──
    def maybe_downgrade(card):
        reg = us_regime if card["market"] == "US" else hk_regime
        if reg in ("on", "unknown", "mixed" if card["scen"] != "S1" else "___"):
            # Risk On / unknown → no change.
            # Mixed → only S1 downgrades (handled by the condition below).
            if not (reg == "mixed" and card["scen"] == "S1"):
                return card
        if reg == "off" and card["scen"] == "S3":
            return card  # S3 (turnaround) never downgraded
        if reg == "mixed" and card["scen"] in ("S2", "S3"):
            return card
        # downgrade a green conclusion to amber "等回踩"
        if card["concl_cls"] == "concl-green":
            tag = "Risk Off" if reg == "off" else "大盤 Mixed"
            card = dict(card)
            card["concl"] = "🟡 等回踩"
            card["concl_cls"] = "concl-amber"
            card["downgraded"] = tag
        return card

    cards = [maybe_downgrade(c) for c in cards]

    order = {"S1": 0, "S2": 1, "S3": 2}
    cards.sort(key=lambda x: (order[x["scen"]], -(x["gate_n"] == 4), -x["score"], -x["rs_slope"]))
    scen_counts = {s: sum(1 for c in cards if c["scen"] == s) for s in ("S1", "S2", "S3")}
    truncated = max(0, len(cards) - MAX_CARDS)
    cards = cards[:MAX_CARDS]
    return cards, {"universe": len(watchlist_us) + len(watchlist_hk),
                   "carded": len(cards), "scen_counts": scen_counts,
                   "truncated": truncated, "market": market,
                   "breadth_raw": breadth_out}


# =====================================================================
#  HTML RENDER — WeasyPrint-safe (static blocks, no <details>)
# =====================================================================
_RADAR_TPL = Template(r"""
<style>
.tr-radar h2 { font-size:15pt; border-left:4px solid #58a6ff; padding-left:8px; margin:16px 0 2px; }
.tr-radar .sub { color:#8b949e; font-size:8pt; margin:0 0 8px 12px; }
.tr-radar table.sum { width:100%; border-collapse:collapse; font-size:8pt; margin-bottom:12px; }
.tr-radar table.sum th { color:#8b949e; text-align:left; padding:3px 6px; border-bottom:1px solid #2d333b; }
.tr-radar table.sum td { padding:4px 6px; border-bottom:1px solid #1f242c; }
.tr-radar tr.grp td { background:#1c2330; font-weight:bold; }
.tr-radar .s1 { color:#3fb950; } .tr-radar .s2 { color:#d29922; } .tr-radar .s3 { color:#f0883e; }
.tr-radar .concl-green { color:#3fb950; font-weight:bold; }
.tr-radar .concl-amber { color:#d29922; font-weight:bold; }
.tr-radar .concl-gray  { color:#6e7681; font-weight:bold; }
.tr-radar table.grid { width:100%; border-collapse:separate; border-spacing:5px 0; }
.tr-radar table.grid > tbody > tr > td { width:50%; vertical-align:top; padding:0 0 8px; }
.tr-radar .card { background:#161b22; border:1px solid #2d333b; border-radius:6px;
                  page-break-inside:avoid; }
.tr-radar .card-head { padding:6px 8px; border-bottom:1px solid #2d333b; }
.tr-radar .tkr { font-size:11pt; font-weight:bold; color:#fff; }
.tr-radar .px  { font-size:9pt; margin-left:5px; }
.tr-radar .tag { font-size:6.5pt; padding:1px 5px; border-radius:8px; font-weight:bold; margin-left:8px; }
.tr-radar .tag-s1 { background:#0d2818; color:#3fb950; border:1px solid #3fb950; }
.tr-radar .tag-s2 { background:#2a2110; color:#d29922; border:1px solid #d29922; }
.tr-radar .tag-s3 { background:#2a1a10; color:#f0883e; border:1px solid #f0883e; }
.tr-radar .headr { float:right; font-size:8pt; }
.tr-radar .cmeta { padding:3px 8px; color:#8b949e; font-size:7pt; line-height:1.35; border-bottom:1px solid #2d333b; }
.tr-radar .cmeta b { color:#c9d1d9; }
.tr-radar .stop { color:#f85149; }
.tr-radar .blk { padding:4px 8px 1px; }
.tr-radar .btitle { font-size:7pt; color:#8b949e; letter-spacing:1px; font-weight:bold; }
.tr-radar table.cond { width:100%; border-collapse:collapse; font-size:7.5pt;
                       table-layout:fixed; word-break:break-word; }
.tr-radar table.cond td { padding:1px 3px; vertical-align:top; line-height:1.3; }
.tr-radar td.ic { width:26px; text-align:center; }
.tr-radar td.nm { width:118px; }
.tr-radar td.vl { color:#8b949e; }
.tr-radar .ok { color:#3fb950; } .tr-radar .no { color:#6e7681; }
.tr-radar .buy { padding:4px 8px; border-top:1px dashed #2d333b; font-size:7pt; line-height:1.35; }
.tr-radar .buy .lab { color:#8b949e; font-size:7pt; letter-spacing:1px; }
.tr-radar .foot { color:#586069; font-size:7pt; margin-top:6px; }
</style>
<div class="tr-radar">
<h2>⚡ 轉勢雷達 Turnaround Radar</h2>
<p class="sub">Universe {{ meta.universe }} → S1:{{ meta.scen_counts.S1 }} / S2:{{ meta.scen_counts.S2 }} / S3:{{ meta.scen_counts.S3 }} → 入卡 {{ meta.carded }} 隻{% if meta.truncated %}（超額截走 {{ meta.truncated }}）{% endif %} · SCORE 14 分制 · closed candle</p>

{% if cards %}
<table class="sum">
<tr><th>Ticker</th><th>價格</th><th>GATE</th><th>SCORE</th><th>VETO</th><th>結論</th></tr>
{% for grp in ["S1","S2","S3"] %}
  {% set gc = cards | selectattr("scen","equalto",grp) | list %}
  {% if gc %}
  <tr class="grp"><td colspan="6" class="{{ gc[0].meta.grpcls }}">{{ gc[0].meta.name }} {{ gc[0].meta.en }}（倉位 {{ gc[0].meta.pos }} · 止蝕 {{ gc[0].meta.stop_lbl }}）</td></tr>
  {% for cd in gc %}
  <tr>
    <td><b>{{ cd.ticker }}</b></td>
    <td>{{ "%.2f"|format(cd.price) }}</td>
    <td>{% for g in cd.gates %}{{ "✅" if g[1] else "❌" }}{% endfor %}</td>
    <td>{{ cd.score }}/{{ cd.max_score }}</td>
    <td>{{ ("⚠×" ~ cd.warn_n) if cd.warn_n else "—" }}</td>
    <td class="{{ cd.concl_cls }}">{{ cd.concl }}</td>
  </tr>
  {% endfor %}
  {% endif %}
{% endfor %}
</table>

<table class="grid"><tbody>
{% for row in cards | batch(2) %}
<tr>
{% for cd in row %}
<td>
<div class="card">
  <div class="card-head">
    <span class="headr {{ cd.concl_cls }}">{{ cd.concl }}</span>
    <span class="tkr">{{ cd.ticker }}</span><span class="px">{{ "%.2f"|format(cd.price) }}</span>
    <span class="tag {{ cd.meta.tagcls }}">{{ cd.meta.name }}</span>
  </div>
  <div class="cmeta">倉位 <b>{{ cd.meta.pos }}</b> ｜
    <span class="stop">止蝕：{{ cd.meta.stop_lbl }} {{ "%.2f"|format(cd.stop) }}（{{ "%+.1f"|format(cd.stop_pct) }}%）</span>
    ｜ RS {{ "%+.1f"|format(cd.rs_now) }}（斜率 {{ "%+.2f"|format(cd.rs_slope) }}/日）
    {%- if cd.ema89w_short %} ｜ EMA89w 樣本不足{% endif %}</div>

  <div class="blk"><div class="btitle">【SCENARIO — {{ cd.scen }}】</div>
  <table class="cond">
  {% for row in cd.scen_rows %}
    <tr><td class="ic {{ 'ok' if row[1] else 'no' }}">{{ "✅" if row[1] else "❌" }}</td><td class="nm">{{ row[0] }}</td><td class="vl">{{ row[2] }}</td></tr>
  {% endfor %}
  </table></div>

  <div class="blk"><div class="btitle">【GATE {{ cd.gate_n }}/4】</div>
  <table class="cond">
  {% for g in cd.gates %}
    <tr><td class="ic {{ 'ok' if g[1] else 'no' }}">{{ "✅" if g[1] else "❌" }}</td><td class="nm">{{ g[0] }}</td><td class="vl">{{ g[2] }}</td></tr>
  {% endfor %}
  </table></div>

  <div class="blk"><div class="btitle">【SCORE {{ cd.score }}/{{ cd.max_score }}】</div>
  <table class="cond">
  {% for s in cd.scores %}
    <tr><td class="ic {{ 'ok' if s[1] > 0 else 'no' }}">{{ s[1] }}/{{ s[2] }}</td><td class="nm">{{ s[0] }}</td><td class="vl">{{ s[3] }}</td></tr>
  {% endfor %}
  </table></div>

  {% if cd.vetoes %}
  <div class="blk"><div class="btitle">【VETO — {{ cd.vetoes | length }} 項】</div>
  <table class="cond">
  {% for v in cd.vetoes %}
    <tr><td class="ic">{{ v[0] }}</td><td class="nm">{{ v[1] }}</td><td class="vl">{{ v[2] }}</td></tr>
  {% endfor %}
  </table></div>
  {% endif %}

  <div class="buy"><span class="lab">買入邏輯 ▸ </span>{{ cd.meta.buy }}</div>
</div>
</td>
{% endfor %}
{% if row | length == 1 %}<td></td>{% endif %}
</tr>
{% endfor %}
</tbody></table>
{% else %}
<p class="sub">今日無符合條件嘅股票。</p>
{% endif %}
<p class="foot">GATE 3/4 = ⚪觀察入卡 · S3 EMA89w 放寬版（&lt;{{ relax }}%）· KDJ veto J&gt;{{ kdj_ob }} · earnings ≤{{ earn_d }} 交易日標 ⚠ER · 所有訊號 closed candle</p>
</div>
""")


def render_radar_html(cards, meta):
    return _RADAR_TPL.render(cards=cards, meta=meta,
                             kdj_ob=KDJ_OVERBOUGHT, relax=int(G33_EMA89_RELAX),
                             earn_d=V5_EARN_DAYS)
