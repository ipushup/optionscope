"""UT B1／S1 市場廣度研究（一次性，唔入主流程）。

問題：每日「UT 當日轉多（B1）／轉空（S1）佔比」暴增嘅日子，指數之後 1／5／10 日點走？
  - US：watchlist 內美股 vs ^GSPC；HK：watchlist 內港股 vs ^HSI
  - 樣本：最近 ~250 個交易日（下載 2 年日線，等 UT 暖機）
輸出 Markdown 到 stdout（workflow log 睇）+ ut_breadth_research.json（artifact）。

留意（報告都會寫）：用「而家嘅 watchlist」回望歷史 = 有倖存者／選股偏差；
重疊持有期令 t 值偏高；每個分組只有 ~25 日，結論只可當線索。
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).parent))
from indicator_scan import parse_watchlist, ut_pos_series, _clean, chunked  # noqa: E402

HORIZONS = (1, 5, 10)
N_DAYS = 250
INDEX = {"US": "^GSPC", "HK": "^HSI"}


def breadth(wl_path: Path):
    entries = [e for e in parse_watchlist(wl_path) if e["ticker"]]
    tickers = sorted({e["ticker"] for e in entries})
    rows = {"US": {}, "HK": {}}    # market -> date -> [b, s, valid]
    for batch in chunked(tickers, 80):
        try:
            data = yf.download(tickers=batch, period="2y", interval="1d", group_by="ticker",
                               threads=True, progress=False, auto_adjust=False)
        except Exception as ex:  # noqa: BLE001
            print(f"batch failed: {ex}", file=sys.stderr)
            continue
        for t in batch:
            try:
                df = _clean(data, batch, t)
                pos = ut_pos_series(df)
                if pos is None:
                    continue
                mk = "HK" if t.endswith(".HK") else "US"
                idx = [str(d.date()) for d in df.index]
                for i in range(30, len(pos)):    # 前 30 棒當暖機
                    if pos[i] == 0:
                        continue
                    a = rows[mk].setdefault(idx[i], [0, 0, 0])
                    a[2] += 1
                    a[0] += 1 if (pos[i] == 1 and pos[i - 1] != 1) else 0
                    a[1] += 1 if (pos[i] == -1 and pos[i - 1] != -1) else 0
            except Exception as ex:  # noqa: BLE001
                print(f"skip {t}: {ex}", file=sys.stderr)
        time.sleep(1)
    return rows


def spearman(x, y):
    return float(pd.Series(x).rank().corr(pd.Series(y).rank()))


def analyse(mk, rows):
    px = yf.download(INDEX[mk], period="2y", interval="1d", progress=False, auto_adjust=False)
    close = px["Close"].squeeze().dropna()
    close.index = [str(d.date()) for d in close.index]
    df = pd.DataFrame(rows[mk], index=["b", "s", "n"]).T.sort_index()
    df = df[df["n"] >= 0.6 * df["n"].max()]            # 去掉樣本唔齊嘅日子
    df["B"] = df["b"] / df["n"] * 100
    df["S"] = df["s"] / df["n"] * 100
    df["NET"] = df["B"] - df["S"]
    df = df.join(close.rename("px"), how="inner").tail(N_DAYS)
    df["ret0"] = df["px"].pct_change() * 100
    for h in HORIZONS:
        df[f"f{h}"] = (df["px"].shift(-h) / df["px"] - 1) * 100
    out = {"market": mk, "index": INDEX[mk], "days": len(df), "from": df.index[0], "to": df.index[-1],
           "avg_B": round(df["B"].mean(), 2), "avg_S": round(df["S"].mean(), 2)}
    base = {h: round(df[f"f{h}"].mean(), 3) for h in HORIZONS}
    out["baseline_mean_fwd"] = base
    # 同日相關（sanity：S1 多 = 指數當日跌？）
    d0 = df.dropna(subset=["ret0"])
    out["same_day_spearman_vs_ret"] = {k: round(spearman(d0[k], d0["ret0"]), 3) for k in ("B", "S", "NET")}
    # 預測力：當日指標 vs 之後 h 日回報（Spearman）
    out["spearman_vs_fwd"] = {k: {h: round(spearman(df.dropna(subset=[f"f{h}"])[k], df.dropna(subset=[f"f{h}"])[f"f{h}"]), 3) for h in HORIZONS} for k in ("B", "S", "NET")}
    # 事件研究：極端日（頂 10%）之後嘅平均回報／勝率 vs 全樣本
    ev = {}
    for k in ("B", "S"):
        thr = df[k].quantile(0.9)
        sub = df[df[k] >= thr]
        ev[f"{k}_top10pct"] = {"threshold_pct": round(float(thr), 2), "n_days": int(len(sub)),
                               **{f"fwd{h}_mean": round(float(sub[f"f{h}"].mean()), 3) for h in HORIZONS},
                               **{f"fwd{h}_win": round(float((sub[f"f{h}"] > 0).mean() * 100), 1) for h in HORIZONS}}
    # 洗倉反轉：S 頂 10% 之後 3 日內 B 頂 10%
    ts, tb = df["S"].quantile(0.9), df["B"].quantile(0.9)
    flag = []
    for i in range(len(df)):
        lo = max(0, i - 3)
        flag.append(bool(df["B"].iloc[i] >= tb and (df["S"].iloc[lo:i + 1] >= ts).any()))
    sub = df[pd.Series(flag, index=df.index)]
    ev["washout_reversal(S top10 then B top10 within 3d)"] = {"n_days": int(len(sub)),
        **{f"fwd{h}_mean": (round(float(sub[f"f{h}"].mean()), 3) if len(sub) else None) for h in HORIZONS},
        **{f"fwd{h}_win": (round(float((sub[f"f{h}"] > 0).mean() * 100), 1) if len(sub) else None) for h in HORIZONS}}
    # 淨值五分位
    q = pd.qcut(df["NET"], 5, labels=False, duplicates="drop")
    ev["NET_quintiles(0=most bearish)"] = {int(g): {"n": int(len(s)), **{f"fwd{h}_mean": round(float(s[f"f{h}"].mean()), 3) for h in HORIZONS}} for g, s in df.groupby(q)}
    out["events"] = ev
    return out, df


def main():
    rows = breadth(Path(sys.argv[1] if len(sys.argv) > 1 else "scanner/Watchlists.txt"))
    res = {}
    print("# UT B1 / S1 breadth research\n")
    for mk in ("US", "HK"):
        try:
            o, df = analyse(mk, rows)
        except Exception as ex:  # noqa: BLE001
            print(f"## {mk}: failed {ex}")
            continue
        res[mk] = o
        print(f"## {mk} ({o['index']}) {o['from']} → {o['to']}, {o['days']} days; avg B1 {o['avg_B']}%  avg S1 {o['avg_S']}%")
        print(json.dumps({k: v for k, v in o.items() if k not in ("market", "index", "days", "from", "to", "avg_B", "avg_S")}, indent=1, ensure_ascii=False))
        df.to_csv(f"ut_breadth_{mk}.csv")
    Path("ut_breadth_research.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
