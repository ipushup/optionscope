"""
band_scanner.py — Triple Band 策略每日掃描
=============================================================
呢個 module 係 band_backtest.py 嘅「最後一支棒」版本：同一條
入場規則、同一個 UT Bot 出場、同一個一次一倉狀態機，只不過
唔計 PnL，淨係報今日觸發乜。

已驗證規格（5,849 筆、407 隻、2024-01 → 2026-08）
    PF 2.07 · 勝率 47.5% · Calmar 19.41 · Sharpe 2.31 · t 8.3

    exit_mode  = ut            UT Bot only (KV=2 / ATR=1)
    sizing     = tiered
    size_big   = 5%            美股 rU60 ≤ −5%
    size_small = 2.5%          美股其餘
    HK         = flat 5%       港股唔分級 (分級 p=0.317，無顯著性)
    hardstop   = off
    pyramiding = 1

介面同 turnaround_radar / whale_tracker 一致：
    rows, meta = compute_band_scan(WATCHLIST_US, WATCHLIST_HK, fetch_df)
    html       = render_band_html(rows, meta)

⚠️ 校驗 pivot 定義
   Pine ta.pivotlow(low, 3, 3) 對「平手」嘅處理冇正式文檔。呢度用
   兩邊都 strict（left/right 全部 low 都要高過 pivot）。如果
   band_backtest.py 入面嘅 pivot_low() 用緊 <= ，改下面 _PIVOT_STRICT_RIGHT
   就對得返。用 `python band_scanner.py AAPL` 印出歷史訊號日期，
   同 trades_*.csv 嘅 entry_date 逐個對，係最直接嘅驗證方法。
"""

import os
import numpy as np
import pandas as pd
from datetime import datetime, timezone

# ═══════════════════ 已驗證參數（唔好隨手改）═══════════════════
BAND_LEN   = 30      # fast group len1
BAND_K     = 0.5     # kWidth
PIVOT_LEN  = 3       # pvLen
STRETCH_K  = 2.0     # 入場門檻：pivot 距 mid 幾多條 band width
COOL_BARS  = 5       # 冷卻（以 pivot bar 計）
RU_LEN     = 60      # rU60 lookback
RU_THR     = -5.0    # 早期門檻 rU60 ≤ −5%

UT_KEY     = 2.0     # UT Bot key value
UT_ATR     = 1       # UT Bot ATR period

# ── 已驗證配置（10 年 / 5,645 筆 / cap30 fifo）────────────────
#    市場   美股 only（港股 big-filter 之下 PF 只有 1.52，唔落注）
#    入場   entry-tier big，即 rU60 ≤ −5%；small 完全唔入場
#    上限   30 隻並存，額滿先到先得（fifo 同 random 打和，
#           ru / sA / dM 全部贏唔到 random，所以唔加揀訊號規則）
#    注碼   3.3% = 1/30，統一 —— small 已經唔入場，分級只剩過濾作用
#    實測   年化 ~25% 名義本金 · maxDD −19.0% · Calmar 1.32
SIZE_PCT       = 100.0 / 30      # 3.33%
MAX_CONCURRENT = 30
TRADE_MARKETS  = ("US",)         # 港股只觀察，唔出倉位

_PIVOT_STRICT_RIGHT = True   # 見 module docstring 嘅校驗說明

# 設咗 BAND_EQUITY（美元）就會多出「股數 / 金額」欄，唔設就淨係顯示 %
ACCOUNT_EQUITY = float(os.getenv("BAND_EQUITY", "0") or 0)
# 港元換算（只影響港股嘅股數估算，唔影響訊號）
USD_HKD = float(os.getenv("BAND_USDHKD", "7.8") or 7.8)
# 持倉表最多顯示幾行（365 行會食五版 PDF）
HOLD_MAX_ROWS = int(os.getenv("BAND_HOLD_ROWS", "40") or 40)
OBSERVE_MAX_ROWS = int(os.getenv("BAND_OBSERVE_ROWS", "15") or 15)

WARMUP = max(BAND_LEN, RU_LEN) + PIVOT_LEN + 10


# ═══════════════════ 指標 ═══════════════════
def _ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def compute_bands(df):
    """m1 = ema(close,30)；w1 = 0.5 × ema(high−low,30)"""
    m1 = _ema(df["Close"], BAND_LEN)
    w1 = BAND_K * _ema(df["High"] - df["Low"], BAND_LEN)
    return m1.values, w1.values


def pivot_lows(low_v, p=PIVOT_LEN):
    """ta.pivotlow(low, p, p) — 喺 index i 成立，喺 i+p 先確認。"""
    n = len(low_v)
    out = np.full(n, np.nan)
    for i in range(p, n - p):
        v = low_v[i]
        if not np.isfinite(v):
            continue
        left = low_v[i - p:i]
        right = low_v[i + 1:i + p + 1]
        if left.size == 0 or right.size == 0:
            continue
        ok_l = v < np.nanmin(left)
        ok_r = v < np.nanmin(right) if _PIVOT_STRICT_RIGHT else v <= np.nanmin(right)
        if ok_l and ok_r:
            out[i] = v
    return out


def ut_bot(df, key=UT_KEY, atr_period=UT_ATR):
    """同 daily_brief.compute_ut_bot 一樣嘅 RMA-ATR trailing stop，
    但回傳成條 trail / pos 序列俾狀態機用。"""
    hl = df["High"] - df["Low"]
    hc = (df["High"] - df["Close"].shift(1)).abs()
    lc = (df["Low"] - df["Close"].shift(1)).abs()
    tr = pd.concat([hl, hc, lc], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1.0 / atr_period, adjust=False).mean()

    src = df["Close"].values
    loss = (key * atr).values
    n = len(src)

    trail = np.zeros(n)
    for i in range(1, n):
        ps, pt, cs, lo = src[i - 1], trail[i - 1], src[i], loss[i]
        if not np.isfinite(lo) or not np.isfinite(cs):
            trail[i] = pt
            continue
        if cs > pt and ps > pt:
            trail[i] = max(pt, cs - lo)
        elif cs < pt and ps < pt:
            trail[i] = min(pt, cs + lo)
        elif cs > pt:
            trail[i] = cs - lo
        else:
            trail[i] = cs + lo

    pos = np.zeros(n, dtype=int)
    for i in range(1, n):
        if src[i - 1] < trail[i - 1] and src[i] > trail[i - 1]:
            pos[i] = 1
        elif src[i - 1] > trail[i - 1] and src[i] < trail[i - 1]:
            pos[i] = -1
        else:
            pos[i] = pos[i - 1]

    sell = np.zeros(n, dtype=bool)
    for i in range(1, n):
        sell[i] = pos[i] == -1 and pos[i - 1] != -1
    return trail, pos, sell


# ═══════════════════ 單一 symbol 狀態機 ═══════════════════
def scan_symbol(df, sym, market, entry_tier="big", return_trades=False):
    """
    行返成段歷史（同 backtest 一樣：出場先於入場、一次一倉、
    冷卻計時器喺訊號成立即更新），回傳最後一支棒嘅事件 list。

    每個 event 嘅 kind：
        "ENTRY" 今日觸發入場
        "EXIT"  今日 UT 出場（模型持倉）
        "HOLD"  模型持有中，今日無動作
    同一日可以有兩個 event（EXIT 之後即刻 re-entry），所以回 list。
    """
    if df is None or len(df) < WARMUP + PIVOT_LEN + 2:
        return ([], []) if return_trades else []
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    idx = df.index
    close = df["Close"].values
    low_v = df["Low"].values
    n = len(df)

    m1, w1 = compute_bands(df)
    pl = pivot_lows(low_v)
    trail, pos, ut_sell = ut_bot(df)

    in_pos = False
    entry_i = None
    entry_px = None
    entry_tier = None
    last_buy_bar = -10 ** 6
    events = []
    # 完整交易序列，畀 compute_band_scan 做全局 cap 重放用
    hist = []

    for i in range(WARMUP, n):
        pi = i - PIVOT_LEN
        is_last = (i == n - 1)

        # ── 入場訊號（喺確認棒 i 成立，pivot 喺 pi）──
        buy_fire = False
        ext = np.nan
        plv = pl[pi]
        w1p, m1p = w1[pi], m1[pi]
        if np.isfinite(plv) and np.isfinite(w1p) and w1p > 0:
            ext = (m1p - plv) / w1p
            if ext >= STRETCH_K and (pi - last_buy_bar) >= COOL_BARS:
                buy_fire = True
                last_buy_bar = pi          # 即使持倉被略過都照更新

        # ── 出場先 ──
        exited_today = False
        if in_pos and ut_sell[i]:
            if is_last:
                events.append({
                    "kind": "EXIT",
                    "entry_date": idx[entry_i].date(),
                    "entry_price": float(entry_px),
                    "tier": entry_tier,
                    "bars": i - entry_i,
                    "ret_pct": (close[i] / entry_px - 1) * 100,
                })
            in_pos = False
            exited_today = True
            hist.append({"symbol": sym, "entry_date": idx[entry_i].date(),
                         "exit_date": idx[i].date()})

        # ── 再入場 ──
        # entry_tier="big"：small 訊號完全唔入場（同 band_backtest
        # 嘅 --entry-tier big 一致）。被濾走嘅訊號唔會佔位，所以之後
        # 嘅 big 訊號入得到 —— 呢個係回測入面 US big 由 4,488 升到
        # 5,645 筆嘅原因，狀態機一定要跟返。
        if buy_fire and not in_pos and entry_tier == "big" \
                and _tier(close, i, market) != "big":
            if is_last:
                events.append({"kind": "OBSERVE", "ext": float(ext),
                               "tier": _tier(close, i, market),
                               "pivot_date": idx[pi].date()})
            buy_fire = False

        if buy_fire and not in_pos:
            in_pos = True
            entry_i = i
            entry_px = close[i]
            entry_tier = _tier(close, i, market)
            if is_last:
                events.append({
                    "kind": "ENTRY",
                    "ext": float(ext),
                    "tier": entry_tier,
                    "pivot_date": idx[pi].date(),
                    "re_entry": exited_today,
                })
        elif buy_fire and is_last:
            # 有訊號但模型仲有倉 → 唔會加倉（pyramiding=1），只記喺 HOLD 度
            pass

    # 最後一支棒冇動作但模型仲揸住
    if in_pos and not any(e["kind"] == "ENTRY" for e in events):
        events.append({
            "kind": "HOLD",
            "entry_date": idx[entry_i].date(),
            "entry_price": float(entry_px),
            "tier": entry_tier,
            "bars": (n - 1) - entry_i,
            "ret_pct": (close[-1] / entry_px - 1) * 100,
        })
    # ── 形成中訊號（今日收市先知成唔成立）──
    # pivot 喺 n-3，右邊三支棒入面兩支已封（n-2, n-1），第三支就係今日
    # 嗰支未收嘅棒。即係話今日盤中一切都可能令佢作廢 —— 但只有兩個死因：
    #   1. 今日 Low 跌穿 pivot low  → pivot 唔再係窗口唯一最低 → 訊號消失
    #   2. 今日 Close 收高過 C[n-60]×0.95 → rU60 升穿 −5% → 變 small → 唔入場
    # ext 唔會變（用 pivot 當日嘅 m1/w1），冷卻同左邊三棒亦已封。
    if not in_pos and entry_tier == "big" and n - RU_LEN - 1 >= 0:
        pf = n - PIVOT_LEN
        if pf >= WARMUP and np.isfinite(w1[pf]) and w1[pf] > 0:
            plv, left, right = low_v[pf], low_v[pf - PIVOT_LEN:pf], low_v[pf + 1:n]
            if (np.isfinite(plv) and left.size and right.size
                    and plv < np.nanmin(left) and plv < np.nanmin(right)):
                ext_f = (m1[pf] - plv) / w1[pf]
                if ext_f >= STRETCH_K and (pf - last_buy_bar) >= COOL_BARS:
                    kc = float(close[n - RU_LEN] * (1 + RU_THR / 100))
                    # tier_ok：以最後收市價計，rU60 而家已經合格。
                    # 唔合格嘅要今日跌 tier_gap_pct 先入到 big —— 見過要跌
                    # 20% 嘅（AMD rU60 +34%），擺出嚟純粹係雜訊。
                    events.append({
                        "kind": "FORMING",
                        "ext": float(ext_f),
                        "pivot_date": idx[pf].date(),
                        "kill_low": float(plv),          # 今日 Low ≤ 呢個 → pivot 破，作廢
                        "kill_close": kc,                # 今日 Close > 呢個 → 變 small，唔入場
                        "tier_ok": bool(close[n - 1] <= kc),
                        "tier_gap_pct": float((kc / close[n - 1] - 1) * 100),
                    })

    if in_pos:                       # 收盤仲揸住
        hist.append({"symbol": sym, "entry_date": idx[entry_i].date(),
                     "exit_date": None})
    if not events:
        return ([], hist) if return_trades else []

    px = float(close[-1])
    stop = float(trail[-1])
    base = {
        "symbol": sym,
        "market": market,
        "price": px,
        "date": idx[-1].date(),
        "ut_stop": stop,
        # UT 現時方向。入場嗰陣 UT 可能仲係 short（stop 喺價之上）——
        # backtest 只認「新鮮嘅 utSell flip」做出場，所以呢種情況個
        # stop 距離冇實際意義，render 會標「未轉多」。
        "ut_pos": int(pos[-1]),
        # 停牌／零波幅：近 20 支棒 true range 全部 = 0（HK 停牌股常見）。
        # ATR=0 → UT trail == close → pos 永遠唔會 flip → 倉位永遠關唔到。
        # 呢啲唔應該當正常持倉睇，backtest 亦應該剔走。
        "stale": bool(_flat_tail(df)),
        "stop_dist_pct": (px - stop) / px * 100 if px else None,
        "ru60": _ru60(close, n - 1),
    }
    out = []
    for ev in events:
        row = dict(base)
        row.update(ev)
        if row["kind"] == "ENTRY":
            row["size_pct"] = _size_pct(row["tier"])
            row["shares"] = _shares(px, row["size_pct"], market)
        out.append(row)
    return (out, hist) if return_trades else out


def _flat_tail(df, bars=20):
    """近 N 支棒完全冇波幅（停牌／零成交）→ UT 永遠 flip 唔到。"""
    if len(df) < bars + 2:
        return False
    tail = df.iloc[-bars:]
    hl = (tail["High"] - tail["Low"]).abs().sum()
    cc = tail["Close"].diff().abs().sum()
    return float(hl) == 0.0 and float(cc) == 0.0


def _ru60(close, i):
    j = i - RU_LEN
    if j < 0 or not np.isfinite(close[j]) or close[j] <= 0:
        return None
    return (close[i] - close[j]) / close[j] * 100


def _tier(close, i, market):
    """港股 flat；美股 rU60 ≤ −5% = big。"""
    if market == "HK":
        return "hk"
    r = _ru60(close, i)
    if r is None:
        return "small"
    return "big" if r <= RU_THR else "small"


def _size_pct(tier=None):
    """統一 3.3%。tier 只剩過濾作用，唔再影響注碼。"""
    return SIZE_PCT


def _shares(px, size_pct, market):
    if ACCOUNT_EQUITY <= 0 or not px:
        return None
    cap = ACCOUNT_EQUITY * size_pct / 100.0
    if market == "HK":
        cap *= USD_HKD
    return int(cap / px)


def _cap_replay(all_trades, cap):
    """
    全局並存上限重放（同 concurrency_cap.py / 回測驗證用嘅係同一套）：
    按入場日順序行，額滿就唔入，同日之間用 symbol 排（fifo，可重現）。
    掃描過五條揀訊號規則，ru / sA / dM 全部贏唔到 random，fifo 同
    random 打和 —— 所以唔加規則，用最機械嗰個。
    回傳被取用嘅 (symbol, entry_date) set。
    """
    taken, open_ex = set(), []
    for t in sorted(all_trades, key=lambda x: (x["entry_date"], x["symbol"])):
        d = t["entry_date"]
        open_ex = [e for e in open_ex if e is None or e >= d]
        if len(open_ex) >= cap:
            continue
        taken.add((t["symbol"], d))
        open_ex.append(t["exit_date"])
    return taken


# ═══════════════════ 全宇宙掃描 ═══════════════════
def compute_band_scan(watchlist_us, watchlist_hk, fetch_df, earnings_veto=None):
    """
    fetch_df(ticker, "1d", period) — 同 daily_brief 共用個 cache，
    所以呢個 section 基本上唔會多打 Yahoo。
    earnings_veto: {symbol: 交易日數} — 入場會標 ⛔（唔會靜靜地照做）
    """
    earnings_veto = earnings_veto or {}
    entries, exits, holds, observe = [], [], [], []
    all_trades = []
    errs = 0

    for wl, mkt in ((watchlist_us, "US"), (watchlist_hk, "HK")):
        tradeable = mkt in TRADE_MARKETS
        # 港股：唔落注，所以唔跑 big 過濾（否則全部訊號都會被濾走），
        # 亦唔追蹤持倉／出場 —— 淨係報今日觸發乜，純觀察。
        tier_mode = "big" if tradeable else "all"
        for sym in wl:
            try:
                found, hist = scan_symbol(fetch_df(sym, "1d", "2y"), sym, mkt,
                                          entry_tier=tier_mode, return_trades=True)
            except Exception:
                errs += 1
                continue
            if tradeable:
                all_trades.extend(hist)
            for row in found:
                if not tradeable:
                    if row["kind"] == "ENTRY":
                        row["kind"] = "OBSERVE"
                        observe.append(row)
                    continue
                if row["kind"] == "ENTRY":
                    veto_d = earnings_veto.get(sym)
                    row["veto_days"] = veto_d
                    row["blocked"] = veto_d is not None
                    entries.append(row)
                elif row["kind"] == "EXIT":
                    exits.append(row)
                elif row["kind"] == "HOLD":
                    # 業績 veto 唔止喺入場日重要 —— 你可能喺訊號成立幾日之後
                    # 先有錢落單，而落單嗰一刻先係 process rule 生效嗰刻。
                    row["veto_days"] = earnings_veto.get(sym)
                    holds.append(row)
                elif row["kind"] == "OBSERVE":
                    observe.append(row)

    entries.sort(key=lambda r: (r["blocked"], -r.get("ext", 0)))
    observe.sort(key=lambda r: (r["market"] != "US", -r.get("ext", 0)))
    exits.sort(key=lambda r: -r.get("ret_pct", 0))
    # UT 已轉多 → stop 距離有意義，最貼 stop 排最前（今日最可能出場）
    # UT 未轉多 → stop 無意義，用浮虧排（蝕得最甘排前）
    # 最新訊號排最前 —— 你係由新到舊揀，唔係由「幾接近止蝕」揀
    holds.sort(key=lambda r: (r.get("stale", False), r["entry_date"]), reverse=True)

    # ── 全局 cap 重放 ──
    # 之前 scanner 重建嘅係「無上限」組合（今朝 68 隻），而 cap 30 從來
    # 冇施加，所以「額滿」會日日亮住紅字，等於冇警告。而家喺呢度做返
    # fifo 重放，模型持倉自然企喺 cap 以下，「今日入唔入到」先係真答案。
    # ── cap 重放：只做統計對照，唔過濾個表 ──
    # 個表要顯示「策略而家仲揸緊嘅全部」，由訊號成立一直到 UT 出場為止，
    # 走完整個買賣周期 —— 因為實際落唔落單由你嘅現金決定，唔係由 cap 決定。
    # cap 30 淨係回測度量表現嘅約束，攞嚟過濾個表會令仲未出場嘅倉無故消失。
    taken = _cap_replay(all_trades, MAX_CONCURRENT)
    n_capped = sum(1 for r in holds if (r["symbol"], r.get("entry_date")) in taken)
    for r in entries:
        r["no_room"] = False
    room = MAX_CONCURRENT - n_capped

    rows = {"entries": entries, "exits": exits, "holds": holds,
            "observe": observe}
    meta = {
        "n_entry": len(entries),
        "n_exit": len(exits),
        "n_hold": len(holds),
        "n_hold_capped": n_capped,
        "n_observe": len(observe),
        "cap": MAX_CONCURRENT,
        "room": room,
        "n_no_room": sum(1 for r in entries if r.get("no_room")),
        "n_hold_veto": sum(1 for r in holds if r.get("veto_days") is not None),
        "n_hold_armed": sum(1 for r in holds if r.get("ut_pos") == 1),
        "n_hold_stale": sum(1 for r in holds if r.get("stale")),
        "hold_ret_mean": (sum(r["ret_pct"] for r in holds) / len(holds)) if holds else None,
        "hold_ret_neg": sum(1 for r in holds if r["ret_pct"] < 0),
        "hold_worst": min((r["ret_pct"] for r in holds), default=None),
        "n_blocked": sum(1 for r in entries if r["blocked"]),
        "universe": len(watchlist_us) + len(watchlist_hk),
        "errors": errs,
        "equity": ACCOUNT_EQUITY,
        "asof": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    return rows, meta


# ═══════════════════ HTML ═══════════════════
_HDR = ('font-family:\'Trebuchet MS\',sans-serif;font-size:6.5pt;font-weight:700;'
        'letter-spacing:0.08em;text-transform:uppercase;color:var(--text-hi);'
        'background:var(--bg3);border:1px solid var(--border-hi);border-radius:5px;'
        'padding:3px 8px;margin-bottom:4px;display:flex;align-items:center;gap:6px;')
_SUB = ('font-size:5.5pt;font-weight:700;letter-spacing:0.05em;color:var(--text-sub);'
        'padding:2px 4px;margin:5px 0 2px;border-left:2px solid var(--accent-conf);')


def _f(v, d=2, plus=False):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "—"
    s = f"{v:+.{d}f}" if plus else f"{v:.{d}f}"
    return s


def render_band_html(rows, meta):
    if not rows or not (rows["entries"] or rows["exits"] or rows["holds"]
                        or rows.get("observe")):
        return ""

    show_sh = meta.get("equity", 0) > 0
    out = ['<div style="margin-bottom:6px;">']
    out.append(
        f'<div style="{_HDR}"><span style="color:var(--accent-conf);">◆</span> '
        f'TRIPLE BAND 掃描 · 入場 {meta["n_entry"]} / 出場 {meta["n_exit"]} / '
        f'持倉 {meta["n_hold"]}/{meta["cap"]}'
        f'<span style="font-size:4.5pt;color:var(--text-dim);font-weight:400;margin-left:auto;">'
        f'美股 big only (rU60≤{RU_THR:g}%) · 每注 {SIZE_PCT:.1f}% · cap {meta["cap"]} fifo · '
        f'UT KV{UT_KEY:g}/ATR{UT_ATR} · 10年 5,645筆 · 年化 23.5% vs SPX 13.3% · '
        f'maxDD −33.9%</span></div>')

    # ── 入場 ──
    room_txt = (f'仲有 {meta["room"]} 個位' if meta["room"] > 0
                else f'<span style="color:var(--accent-sell);">額滿（超 {-meta["room"]} 隻）</span>')
    out.append(f'<div style="{_SUB}">▲ 今日入場訊號 · ENTRIES　'
               f'<span style="font-weight:400;color:var(--text-dim);">'
               f'持倉 {meta["n_hold"]}/{meta["cap"]} · {room_txt}</span></div>')
    if rows["entries"]:
        cols = ("<th>標的</th><th class='c'>市場</th><th class='r'>收市價</th>"
                "<th class='r'>ext</th><th class='r'>rU60%</th><th class='c'>分級</th>"
                "<th class='c'>倉位</th>"
                + ("<th class='r'>股數</th>" if show_sh else "")
                + "<th class='r'>UT stop</th><th class='r'>距stop</th><th class='c'>備註</th>")
        out.append(f"<table><thead><tr>{cols}</tr></thead><tbody>")
        for r in rows["entries"]:
            tier_pill = ("<span class='pill pill-up'>BIG</span>" if r["tier"] == "big"
                         else "<span class='pill pill-na'>HK</span>" if r["tier"] == "hk"
                         else "<span class='pill pill-dn'>small</span>")
            note = (f"⛔ 業績 {r['veto_days']}d 內 — 唔入" if r["blocked"]
                    else "⛔ 額滿 — 唔入" if r.get("no_room")
                    else ("↻ 同日出場後再入" if r.get("re_entry") else "—"))
            row_cls = "sell-row" if (r["blocked"] or r.get("no_room")) else "buy-row"
            ru_cls = "pos" if (r["ru60"] or 0) > 0 else "neg"
            cells = [
                f"<td class='sym'>{r['symbol']}</td>",
                f"<td class='c'>{r['market']}</td>",
                f"<td class='r' style='color:var(--text-hi);'>{_f(r['price'])}</td>",
                f"<td class='r' style='color:var(--accent-conf);font-weight:700;'>{_f(r.get('ext'))}</td>",
                f"<td class='r {ru_cls}'>{_f(r['ru60'], 1, True)}</td>",
                f"<td class='c'>{tier_pill}</td>",
                f"<td class='c' style='font-weight:700;'>{r['size_pct']:g}%</td>",
            ]
            if show_sh:
                cells.append(f"<td class='r'>{r['shares'] if r['shares'] else '—'}</td>")
            cells.append(f"<td class='r' style='color:var(--accent-sell);'>{_f(r['ut_stop'])}</td>")
            cells.append(f"<td class='r'>{_f(r['stop_dist_pct'], 1)}%</td>" if r.get("ut_pos") == 1
                         else "<td class='r dim' style='font-size:5pt;'>UT未轉多</td>")
            cells.append(f"<td class='c' style='font-size:5pt;'>{note}</td>")
            out.append(f"<tr class='{row_cls}'>" + "".join(cells) + "</tr>")
        out.append("</tbody></table>")
    else:
        out.append('<div class="empty">今日無美股 big tier 入場訊號</div>')

    # ── 出場 ──
    if rows["exits"]:
        out.append(f'<div style="{_SUB}">▼ 今日 UT 出場 · EXITS</div>')
        out.append("<table><thead><tr><th>標的</th><th class='c'>市場</th>"
                   "<th class='r'>收市價</th><th class='c'>入場日</th><th class='r'>入場價</th>"
                   "<th class='r'>回報</th><th class='r'>持有</th></tr></thead><tbody>")
        for r in rows["exits"]:
            cls = "pos" if r["ret_pct"] >= 0 else "neg"
            out.append(
                f"<tr class='sell-row'><td class='sym'>{r['symbol']}</td>"
                f"<td class='c'>{r['market']}</td>"
                f"<td class='r' style='color:var(--text-hi);'>{_f(r['price'])}</td>"
                f"<td class='c' style='font-size:5pt;'>{r['entry_date']}</td>"
                f"<td class='r'>{_f(r['entry_price'])}</td>"
                f"<td class='r {cls}' style='font-weight:700;'>{_f(r['ret_pct'], 1, True)}%</td>"
                f"<td class='r'>{r['bars']}d</td></tr>")
        out.append("</tbody></table>")

    # ── 持倉 ──
    if rows["holds"]:
        hm = meta.get("hold_ret_mean")
        out.append(
            f'<div style="{_SUB}">● 有效候選 · 未出場 — 共 {meta["n_hold"]} 隻'
            f'（cap {meta["cap"]} 之下會係 {meta.get("n_hold_capped", meta["n_hold"])} 隻）'
            f'（UT 已轉多 {meta.get("n_hold_armed", 0)} · 浮虧 {meta.get("hold_ret_neg", 0)}'
            f' · 平均 {_f(hm, 1, True) if hm is not None else "—"}%'
            f' · 最差 {_f(meta.get("hold_worst"), 1, True)}%）'
            f'　訊號由新到舊 · 顯示頭 {min(HOLD_MAX_ROWS, meta["n_hold"])} 行 · '
            f'訊號成立後一直顯示到 UT 出場為止'
            + (f'　<span style="color:var(--accent-sell);">⛔ {meta["n_hold_veto"]} 隻'
               f'業績窗口內，今日唔好入</span>' if meta.get("n_hold_veto") else '')
            + '</div>')
        out.append("<table><thead><tr><th>標的</th><th class='c'>訊號日</th>"
                   "<th class='r'>訊號價</th><th class='r'>今日價</th><th class='r'>今日入貴/平</th>"
                   "<th class='r'>UT stop</th><th class='r'>距stop</th>"
                   "<th class='c'>UT</th><th class='r'>已過</th>"
                   "<th class='c'>業績</th></tr></thead><tbody>")
        for r in rows["holds"][:HOLD_MAX_ROWS]:
            cls = "pos" if r["ret_pct"] >= 0 else "neg"
            d = r["stop_dist_pct"]
            warn = "style='color:var(--accent-sell);font-weight:700;'" if (d is not None and d < 3) else ""
            # ret_pct = 由訊號價計嘅浮動 = 今日入場比訊號日貴/平幾多。
            # 回測嘅入場價係確認棒收市，你隔幾日先買，成本就唔同 ——
            # 呢一欄就係量度嗰個偏離：正數 = 追高，負數 = 比原訊號更平。
            gap = r["ret_pct"]
            gcls = "neg" if gap > 0 else "pos"      # 追高係壞事，所以反色
            cells = [
                f"<td class='sym'>{r['symbol']}</td>",
                f"<td class='c' style='font-size:5pt;'>{r['entry_date']}</td>",
                f"<td class='r dim'>{_f(r['entry_price'])}</td>",
                f"<td class='r' style='color:var(--text-hi);'>{_f(r['price'])}</td>",
                f"<td class='r {gcls}' style='font-weight:700;'>{_f(gap, 1, True)}%</td>",
                f"<td class='r'>{_f(r['ut_stop'])}</td>",
                (f"<td class='r' {warn}>{_f(d, 1)}%</td>" if r.get("ut_pos") == 1
                 else "<td class='r dim' style='font-size:5pt;'>—</td>"),
                ("<td class='c pos'>✓多</td>" if r.get("ut_pos") == 1
                 else "<td class='c dim'>未轉多</td>"),
                f"<td class='r'>{r['bars']}d</td>",
                (f"<td class='c' style='color:var(--accent-sell);font-weight:700;"
                 f"font-size:5pt;'>⛔{r['veto_days']}d</td>"
                 if r.get("veto_days") is not None else "<td class='c dim'>—</td>"),
            ]
            vcls = " class='sell-row'" if r.get("veto_days") is not None else ""
            out.append(f"<tr{vcls}>" + "".join(cells) + "</tr>")
        out.append("</tbody></table>")

    # ── 觀察組（唔落注）──
    if rows.get("observe"):
        n_hk = sum(1 for r in rows["observe"] if r["market"] == "HK")
        n_us = len(rows["observe"]) - n_hk
        out.append(
            f'<div style="{_SUB}opacity:.55;border-left-color:var(--text-dim);">'
            f'○ 觀察組 · 唔落注 — 美股 small {n_us} / 港股 {n_hk}'
            f'<span style="font-weight:400;"> — 唔喺已驗證配置入面'
            f'（港股 big-filter PF 只有 1.52；美股 small PF 1.64 vs big 2.03）</span></div>')
        out.append('<table style="opacity:.55;"><thead><tr><th>標的</th>'
                   "<th class='c'>市場</th><th class='r'>收市價</th><th class='r'>EXT</th>"
                   "<th class='r'>RU60%</th><th class='c'>類別</th>"
                   "<th class='r'>UT stop</th></tr></thead><tbody>")
        for r in rows["observe"][:OBSERVE_MAX_ROWS]:
            lbl = "港股" if r["market"] == "HK" else "small"
            out.append(
                f"<tr><td class='sym'>{r['symbol']}</td>"
                f"<td class='c'>{r['market']}</td>"
                f"<td class='r'>{_f(r['price'])}</td>"
                f"<td class='r'>{_f(r.get('ext'))}</td>"
                f"<td class='r'>{_f(r['ru60'], 1, True)}</td>"
                f"<td class='c dim'>{lbl}</td>"
                f"<td class='r'>{_f(r['ut_stop'])}</td></tr>")
        out.append("</tbody></table>")
        if len(rows["observe"]) > OBSERVE_MAX_ROWS:
            out.append(f'<div style="font-size:4.5pt;color:var(--text-dim);">'
                       f'另外 {len(rows["observe"]) - OBSERVE_MAX_ROWS} 隻未顯示</div>')

    if meta["n_hold"] > HOLD_MAX_ROWS:
        out.append(f'<div style="font-size:4.5pt;color:var(--text-dim);margin:1px 0 3px;">'
                   f'另外 {meta["n_hold"] - HOLD_MAX_ROWS} 隻持倉未顯示'
                   f'（其中 {meta.get("n_hold_stale", 0)} 隻停牌／零波幅，UT 永遠 flip 唔到，'
                   f'排喺最後）· 改 BAND_HOLD_ROWS 可調行數</div>')

    out.append(
        f'<div style="font-size:4.5pt;color:var(--text-dim);margin-top:3px;">'
        f'掃描 {meta["universe"]} 隻 · 資料錯誤 {meta["errors"]} 隻 · '
        f'模型持倉狀態由現有 2y 數據重建（唔係實際倉位）· '
        f'入場價 = 確認棒收市（即今日收市）· '
        f'持倉浮盈未計入回測 PF／Calmar · {meta["asof"]}</div>')
    out.append("</div>")
    return "\n".join(out)


# ═══════════════════ 校驗用 CLI ═══════════════════
def _standalone_fetch(ticker, interval, period):
    import yfinance as yf
    df = yf.download(ticker, period=period, interval=interval,
                     progress=False, auto_adjust=True)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df[df["Close"].notna()]


def signal_history(df, market="US"):
    """印晒歷史入場／出場，同 trades_*.csv 對數用。"""
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    idx, close, low_v = df.index, df["Close"].values, df["Low"].values
    m1, w1 = compute_bands(df)
    pl = pivot_lows(low_v)
    trail, pos, ut_sell = ut_bot(df)
    trades, in_pos, last_buy_bar = [], False, -10 ** 6
    e_i = e_px = e_tier = None
    for i in range(WARMUP, len(df)):
        pi = i - PIVOT_LEN
        buy_fire, ext = False, np.nan
        if np.isfinite(pl[pi]) and np.isfinite(w1[pi]) and w1[pi] > 0:
            ext = (m1[pi] - pl[pi]) / w1[pi]
            if ext >= STRETCH_K and (pi - last_buy_bar) >= COOL_BARS:
                buy_fire, last_buy_bar = True, pi
        if in_pos and ut_sell[i]:
            trades.append({"entry_date": idx[e_i].date(), "entry_price": round(e_px, 4),
                           "exit_date": idx[i].date(), "exit_price": round(float(close[i]), 4),
                           "ret_pct": round((close[i] / e_px - 1) * 100, 3),
                           "bars": i - e_i, "tier": e_tier})
            in_pos = False
        if buy_fire and not in_pos:
            in_pos, e_i, e_px = True, i, float(close[i])
            e_tier = _tier(close, i, market)
    return pd.DataFrame(trades), in_pos


if __name__ == "__main__":
    import sys
    sym = sys.argv[1] if len(sys.argv) > 1 else "AAPL"
    mkt = "HK" if sym.endswith(".HK") else "US"
    d = _standalone_fetch(sym, "1d", "2y")
    t, open_now = signal_history(d, mkt)
    print(f"\n{sym} — {len(t)} 筆 (2y)   模型現時持倉: {open_now}")
    if len(t):
        print(t.to_string(index=False))
        print(f"\nwin% {(t.ret_pct > 0).mean()*100:.1f}   avg {t.ret_pct.mean():+.2f}%")
    for row in scan_symbol(d, sym, mkt):
        print(f"\n今日狀態: {row}")


# ═══════════════════ OptionScope Radar payload ═══════════════════
def compute_band_radar(watchlist_us, watchlist_hk, fetch_df, earnings_veto=None):
    """
    同 compute_band_scan 用同一個 scan_symbol，但輸出 JSON-ready 結構，
    畀 scanner/band_scan.py 寫 frontend/public/band.json。

    五組：
      confirmed  今日收市確認 —— 明早開市可買，pivot 已封死，唔會 repaint
      forming    今日收市先知 —— 附兩條死線（kill_low / kill_close）
      candidates 有效候選 —— 已成立未出場，你有錢就可以入
      exits      今日 UT 出場
      observe    美股 small / 港股 —— 唔落注，只睇

    ⚠️ 前端唔准重算訊號。所有 pivot / ext / rU60 / UT 都係喺呢度用
       closed candle 計死，網頁淨係更新報價同「距死線幾遠」。
    """
    earnings_veto = earnings_veto or {}
    confirmed, forming, candidates, exits, observe = [], [], [], [], []
    all_trades, errs = [], 0

    for wl, mkt in ((watchlist_us, "US"), (watchlist_hk, "HK")):
        tradeable = mkt in TRADE_MARKETS
        tier_mode = "big" if tradeable else "all"
        for sym in wl:
            try:
                found, hist = scan_symbol(fetch_df(sym, "1d", "2y"), sym, mkt,
                                          entry_tier=tier_mode, return_trades=True)
            except Exception:
                errs += 1
                continue
            if tradeable:
                all_trades.extend(hist)
            for r in found:
                r = dict(r)
                r["veto_days"] = earnings_veto.get(sym)
                if not tradeable:
                    if r["kind"] in ("ENTRY", "FORMING"):
                        observe.append(r)
                    continue
                {"ENTRY": confirmed, "FORMING": forming, "HOLD": candidates,
                 "EXIT": exits, "OBSERVE": observe}.get(r["kind"], []).append(r)

    taken = _cap_replay(all_trades, MAX_CONCURRENT)
    n_capped = sum(1 for r in candidates
                   if (r["symbol"], r.get("entry_date")) in taken)

    confirmed.sort(key=lambda r: -r.get("ext", 0))
    # 有機會嘅排前，冇機會嘅（今日要崩先合格）沉底
    forming.sort(key=lambda r: (not r.get("tier_ok", True), -r.get("ext", 0)))
    candidates.sort(key=lambda r: r["entry_date"], reverse=True)
    exits.sort(key=lambda r: -r.get("ret_pct", 0))
    observe.sort(key=lambda r: (r["market"] != "US", -r.get("ext", 0)))

    def js(r):
        o = {k: v for k, v in r.items() if k != "kind"}
        for k in ("date", "entry_date", "pivot_date"):
            if o.get(k) is not None:
                o[k] = str(o[k])
        for k, v in list(o.items()):
            if isinstance(v, (np.floating, np.integer)):
                o[k] = float(v)
            elif isinstance(v, np.bool_):
                o[k] = bool(v)
        return o

    tickers = sorted({r["symbol"] for grp in
                      (confirmed, forming, candidates, exits, observe)
                      for r in grp})
    return {
        "scanned_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "config": {
            "markets": list(TRADE_MARKETS), "entry_tier": "big",
            "ru_thr": RU_THR, "stretch_k": STRETCH_K, "pivot_len": PIVOT_LEN,
            "cool_bars": COOL_BARS, "ut_key": UT_KEY, "ut_atr": UT_ATR,
            "size_pct": round(SIZE_PCT, 2), "cap": MAX_CONCURRENT,
            "entry_timing": "next_open",
            "verified": "2016-2026 · 5,645 筆 · 年化 25.2% vs SPX 13.2% · maxDD −33.3%",
        },
        # 訊號基準棒。前端要用嚟判斷「下一個開市」過咗未 —— 盤中手動跑
        # full scan 嘅話，confirmed 嗰批嘅執行窗口其實已經關咗。
        "bar_date": str(max((r["date"] for grp in (confirmed, forming, candidates, exits)
                             for r in grp), default="")),
        "counts": {"confirmed": len(confirmed), "forming": len(forming),
                   "forming_live": sum(1 for r in forming if r.get("tier_ok")),
                   "candidates": len(candidates), "candidates_capped": n_capped,
                   "exits": len(exits), "observe": len(observe),
                   "universe": len(watchlist_us) + len(watchlist_hk),
                   "errors": errs},
        "confirmed": [js(r) for r in confirmed],
        "forming": [js(r) for r in forming],
        "candidates": [js(r) for r in candidates],
        "exits": [js(r) for r in exits],
        "observe": [js(r) for r in observe],
        "tickers": tickers,
    }
