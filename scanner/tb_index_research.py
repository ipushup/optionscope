"""Triple Band（TB 買入確認／TS 賣出）同指數關係研究（一次性，唔入主流程）。

問題：
  1. 同日／領先落後：每日 TB／TS 隻數 vs 指數回報（互相關 lag -5..+5）
  2. TB／TS 暴增日（頂 10%）之後指數 1／5／10／20 日點走？
  3. TB 暴增日係咪集中喺指數低位（接近 20 日低／離 60 日高回撤）？
  4. 個股層面：每個 TB／TS 訊號之後 5／10／20 日個股回報、超額（vs 指數）、勝率；按指數狀態分（200 日線上下、回撤 ≥5%）
  US = watchlist 內美股 vs ^GSPC；HK = 港股 vs ^HSI。樣本：5 年日線。
留意：用而家 watchlist 回望 = 倖存者偏差；持有期重疊令顯著性偏高；TB 事件稀疏。
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).parent))
from indicator_scan import parse_watchlist, _clean, chunked  # noqa: E402
import intraday_signals as S  # noqa: E402

HZ = (1, 5, 10, 20)
INDEX = {"US": "^GSPC", "HK": "^HSI"}
WARM = 120


def collect(wl_path):
    tickers = sorted({e["ticker"] for e in parse_watchlist(wl_path) if e["ticker"]})
    valid = {"US": {}, "HK": {}}      # mk -> date -> 有效股票數
    daily = {"US": {}, "HK": {}}      # mk -> date -> [TB, TS, TBskip]
    events = []                       # (mk, date, kind, {h: stock fwd ret %})
    for batch in chunked(tickers, 60):
        try:
            data = yf.download(tickers=batch, period="5y", interval="1d", group_by="ticker",
                               threads=True, progress=False, auto_adjust=False)
        except Exception as ex:  # noqa: BLE001
            print(f"batch failed: {ex}", file=sys.stderr)
            continue
        for t in batch:
            try:
                df = _clean(data, batch, t)
                if len(df) < WARM + 30:
                    continue
                mk = "HK" if t.endswith(".HK") else "US"
                idx = [str(d.date()) for d in df.index]
                close = df["Close"].values
                for i in range(WARM, len(df)):
                    valid[mk][idx[i]] = valid[mk].get(idx[i], 0) + 1
                for e in S.triple_band(df):
                    i = e["i"]
                    if i < WARM:
                        continue
                    a = daily[mk].setdefault(idx[i], [0, 0, 0])
                    a[{"TB": 0, "TS": 1, "TBskip": 2}[e["kind"]]] += 1
                    if e["kind"] in ("TB", "TS"):
                        fw = {h: (close[i + h] / close[i] - 1) * 100 for h in HZ if i + h < len(df)}
                        events.append((mk, idx[i], e["kind"], fw))
            except Exception as ex:  # noqa: BLE001
                print(f"skip {t}: {ex}", file=sys.stderr)
        time.sleep(1)
    return valid, daily, events


def sp(x, y):
    d = pd.concat([pd.Series(x).reset_index(drop=True), pd.Series(y).reset_index(drop=True)], axis=1).dropna()
    return round(float(d.iloc[:, 0].rank().corr(d.iloc[:, 1].rank())), 3) if len(d) > 20 else None


def analyse(mk, valid, daily, events):
    px = yf.download(INDEX[mk], period="5y", interval="1d", progress=False, auto_adjust=False)["Close"].squeeze().dropna()
    px.index = [str(d.date()) for d in px.index]
    df = pd.DataFrame({"n": pd.Series(valid[mk])})
    for k, name in enumerate(("TB", "TS", "TBskip")):
        df[name] = pd.Series({d: v[k] for d, v in daily[mk].items()})
    df = df.fillna(0).sort_index()
    df = df[df["n"] >= 0.6 * df["n"].max()]
    df = df.join(px.rename("px"), how="inner")
    df["ret0"] = df["px"].pct_change() * 100
    for h in HZ:
        df[f"f{h}"] = (df["px"].shift(-h) / df["px"] - 1) * 100
    df["ma200"] = df["px"].rolling(200).mean()
    df["dd60"] = (df["px"] / df["px"].rolling(60).max() - 1) * 100
    df["near_low20"] = (df["px"] / df["px"].rolling(20).min() - 1) * 100
    df["TBp"] = df["TB"] / df["n"] * 100
    df["TSp"] = df["TS"] / df["n"] * 100
    df["NET"] = df["TB"] - df["TS"]
    out = {"market": mk, "index": INDEX[mk], "days": int(len(df)), "from": df.index[0], "to": df.index[-1],
           "avg_TB_per_day": round(df["TB"].mean(), 2), "avg_TS_per_day": round(df["TS"].mean(), 2),
           "avg_valid_stocks": round(df["n"].mean(), 0), "total_TB": int(df["TB"].sum()), "total_TS": int(df["TS"].sum())}
    base = {h: round(df[f"f{h}"].mean(), 3) for h in HZ}
    out["baseline_mean_fwd_index"] = base
    # 1. 互相關：TB／TS 比例（t）vs 指數回報（t+lag）
    xc = {}
    for k in ("TBp", "TSp"):
        xc[k] = {lag: sp(df[k], df["ret0"].shift(-lag)) for lag in range(-5, 6)}
    out["xcorr_vs_index_ret(lag>0 = indicator leads)"] = xc
    # 2. 暴增日之後
    ev = {}
    for k in ("TBp", "TSp"):
        thr = df[k].quantile(0.9)
        sub = df[(df[k] >= thr) & (df[k] > 0)]
        ev[f"{k}_top10pct"] = {"threshold_pct": round(float(thr), 2), "n_days": int(len(sub)),
            **{f"fwd{h}_mean": round(float(sub[f"f{h}"].mean()), 3) for h in HZ},
            **{f"fwd{h}_win": round(float((sub[f"f{h}"] > 0).mean() * 100), 1) for h in HZ},
            "avg_dd60_pct": round(float(sub["dd60"].mean()), 2), "avg_dist_20d_low_pct": round(float(sub["near_low20"].mean()), 2)}
    ev["all_days"] = {"avg_dd60_pct": round(float(df["dd60"].mean()), 2), "avg_dist_20d_low_pct": round(float(df["near_low20"].mean()), 2)}
    # 3. 低位集中度：TB 暴增日有幾多喺 20 日低 +2% 內
    for k in ("TBp", "TSp"):
        thr = df[k].quantile(0.9)
        sub = df[(df[k] >= thr) & (df[k] > 0)]
        ev[f"{k}_top10_share_within2pct_of_20d_low"] = round(float((sub["near_low20"] <= 2).mean() * 100), 1)
    ev["baseline_share_within2pct_of_20d_low"] = round(float((df["near_low20"] <= 2).mean() * 100), 1)
    out["events_index"] = ev
    # 4. 個股事件
    reg = pd.DataFrame({"above200": df["px"] > df["ma200"], "dd5": df["dd60"] <= -5, "f": 1}, index=df.index)
    ixf = {h: df[f"f{h}"] for h in HZ}
    rows = []
    for m, d, kind, fw in events:
        if m != mk or d not in df.index:
            continue
        r = {"kind": kind, "above200": bool(reg.loc[d, "above200"]) if pd.notna(df.loc[d, "ma200"]) else None, "dd5": bool(reg.loc[d, "dd5"])}
        for h in HZ:
            v, iv = fw.get(h), ixf[h].get(d)
            r[f"s{h}"] = v
            r[f"x{h}"] = (v - iv) if (v is not None and pd.notna(iv)) else None
        rows.append(r)
    E = pd.DataFrame(rows)
    st = {}
    def summ(sub):
        o = {"n": int(len(sub))}
        for h in HZ:
            s = sub[f"s{h}"].dropna()
            x = sub[f"x{h}"].dropna()
            if len(s) >= 5:
                o[f"fwd{h}_mean"] = round(float(s.mean()), 2)
                o[f"fwd{h}_median"] = round(float(s.median()), 2)
                o[f"fwd{h}_win"] = round(float((s > 0).mean() * 100), 1)
                o[f"fwd{h}_excess_vs_idx"] = round(float(x.mean()), 2)
        return o
    if len(E):
        for kind in ("TB", "TS"):
            K = E[E["kind"] == kind]
            st[kind] = summ(K)
            st[f"{kind}|index above 200d"] = summ(K[K["above200"] == True])   # noqa: E712
            st[f"{kind}|index below 200d"] = summ(K[K["above200"] == False])  # noqa: E712
            st[f"{kind}|index drawdown>=5% from 60d high"] = summ(K[K["dd5"]])
            st[f"{kind}|index drawdown<5%"] = summ(K[~K["dd5"]])
    out["stock_level_events"] = st
    return out, df


def main():
    valid, daily, events = collect(Path(sys.argv[1] if len(sys.argv) > 1 else "scanner/Watchlists.txt"))
    res = {}
    print("# Triple Band vs index research\n")
    for mk in ("US", "HK"):
        try:
            o, df = analyse(mk, valid, daily, events)
        except Exception as ex:  # noqa: BLE001
            print(f"## {mk}: failed {ex}")
            continue
        res[mk] = o
        print(f"## {mk} ({o['index']}) {o['from']} → {o['to']}, {o['days']} days")
        print(json.dumps({k: v for k, v in o.items() if k not in ("market", "index", "from", "to")}, indent=1, ensure_ascii=False))
        df.to_csv(f"tb_index_{mk}.csv")
    Path("tb_index_research.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
