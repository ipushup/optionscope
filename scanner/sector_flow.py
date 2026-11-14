#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sector_flow.py — 主頁「SECTOR FLOW · 板塊資金流向」數據（sector.json）

ETF 清單（SPDR 11 大板塊 / 主題 / 跨資產）→ 每隻：
  今日升跌（Longbridge 報價：現價 vs 上日收市）、5 日／20 日升跌（日線收市價）、
  5 日／20 日「組內排名」同上一個週期（5–10／20–40 個交易日前）嘅排名、即日資金淨流入（capital_flow 最後一點）、
  展開圖表：日／週／月 K 線（最近 60 棒）+ EMA 10/20/50/89/250（用全部棒計；唔夠 250 棒就唔畀 EMA250）。

環境變數：LONGBRIDGE_APP_KEY/_SECRET/_ACCESS_TOKEN；GATEWAY_URL / INGEST_TOKEN（有就推私人 gateway）
  SECTOR_OUT  輸出檔（預設 frontend/public/sector.json）
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import pandas as pd

GROUPS = [
    ("sector", "11 大板塊（SPDR）", [
        ("XLK", "科技"), ("XLF", "金融"), ("XLE", "能源"), ("XLV", "醫療"), ("XLY", "非必需消費"), ("XLP", "必需消費"),
        ("XLI", "工業"), ("XLU", "公用"), ("XLB", "物料"), ("XLRE", "地產"), ("XLC", "通訊")]),
    ("theme", "主題", [("SMH", "半導體"), ("IGV", "軟件"), ("XBI", "生科"), ("KRE", "區域銀行"), ("XME", "礦業")]),
    ("asset", "跨資產", [("GLD", "黃金"), ("TLT", "長債"), ("IBIT", "比特幣")]),
]
EMAS = (10, 20, 50, 89, 250)
CHART_N = 60
OUT = os.environ.get("SECTOR_OUT", "frontend/public/sector.json")


def pct(a, b):
    return None if not a or not b else (a / b - 1) * 100


def ranks(items, key):
    """組內排名（1 = 升幅最大）→ {sym: rank}"""
    ok = [it for it in items if it.get(key) is not None]
    ok.sort(key=lambda it: -it[key])
    return {it["sym"]: i + 1 for i, it in enumerate(ok)}


def chart_of(df):
    if df is None or len(df) < 20:
        return None
    c = df["Close"].astype(float)
    d = df.iloc[-CHART_N:]
    e = {}
    for k in EMAS:
        if k == 250 and len(c) < 250:
            continue
        e[str(k)] = [round(float(x), 2) for x in c.ewm(span=k, adjust=False).mean().iloc[-CHART_N:]]
    return {"b": [[round(float(o), 2), round(float(h), 2), round(float(l), 2), round(float(x), 2)]
                  for o, h, l, x in zip(d["Open"], d["High"], d["Low"], d["Close"])], "e": e}


def build():
    from longbridge.openapi import AdjustType, Config, Period, QuoteContext, TradeSessions
    import signal_board as sb
    sb.RATE = 6.0
    ctx = QuoteContext(Config.from_apikey_env())
    lb = lambda s: f"{s}.US"

    def pull(sym, period, count):
        err = None
        for k in range(3):
            try:
                sb._throttle()
                bars = ctx.candlesticks(lb(sym), period, count, AdjustType.ForwardAdjust, TradeSessions.Intraday)
                if not bars:
                    return None
                df = sb._df(bars)
                return df[~df.index.duplicated(keep="last")].sort_index()
            except Exception as e:  # noqa: BLE001
                err = e; time.sleep(1.5 * (k + 1))
        print(f"::warning::{sym} {period}: {err}", flush=True)
        return None

    allsyms = [s for _, _, g in GROUPS for s, _ in g]
    quotes = {}
    try:
        for q in ctx.quote([lb(s) for s in allsyms]):
            quotes[q.symbol.rsplit(".", 1)[0]] = (float(q.last_done), float(q.prev_close))
    except Exception as e:  # noqa: BLE001
        print(f"::warning::quote: {e}", flush=True)

    groups = []
    for key, title, g in GROUPS:
        items = []
        for sym, name in g:
            d = pull(sym, Period.Day, 300)
            w = pull(sym, Period.Week, 300)
            m = pull(sym, Period.Month, 300)
            it = {"sym": sym, "name": name}
            last, prev = quotes.get(sym, (None, None))
            c = d["Close"].astype(float).tolist() if d is not None else []
            it["last"] = last if last else (c[-1] if c else None)
            it["d1"] = pct(last, prev) if last and prev else (pct(c[-1], c[-2]) if len(c) > 1 else None)
            it["d5"] = pct(c[-1], c[-6]) if len(c) > 5 else None
            it["d20"] = pct(c[-1], c[-21]) if len(c) > 20 else None
            it["p5"] = pct(c[-6], c[-11]) if len(c) > 10 else None      # 上一個 5 日（5–10 個交易日前）
            it["p20"] = pct(c[-21], c[-41]) if len(c) > 40 else None    # 上一個 20 日
            try:
                sb._throttle()
                fl = ctx.capital_flow(lb(sym))
                it["flow"] = float(fl[-1].inflow) / 1e6 if fl else None
            except Exception as e:  # noqa: BLE001
                it["flow"] = None; print(f"::warning::{sym} flow: {e}", flush=True)
            it["chart"] = {k: v for k, v in (("D", chart_of(d)), ("W", chart_of(w)), ("M", chart_of(m))) if v}
            items.append(it)
        for k5, kp in (("d5", "p5"), ("d20", "p20")):
            now, prv = ranks(items, k5), ranks(items, kp)
            for it in items:
                n, p = now.get(it["sym"]), prv.get(it["sym"])
                it["r" + k5[1:]] = {"now": n, "prev": p} if n and p else None
        for it in items:
            for k in ("d1", "d5", "d20", "p5", "p20", "flow", "last"):
                if it.get(k) is not None:
                    it[k] = round(it[k], 2)
        groups.append({"key": key, "title": title, "items": items})
    return {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "groups": groups}


def push(path):
    gw, tok = os.getenv("GATEWAY_URL", "").rstrip("/"), os.getenv("INGEST_TOKEN", "")
    if not gw or not tok:
        print("ℹ GATEWAY_URL / INGEST_TOKEN 未設，跳過上傳")
        return
    req = urllib.request.Request(f"{gw}/_ingest/sector.json", data=Path(path).read_bytes(), method="PUT",
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                                          "User-Agent": "curl/8.5.0", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=30) as r:
        print("push", r.status, r.read().decode("utf-8", "ignore")[:120])


if __name__ == "__main__":
    out = build()
    n = sum(1 for g in out["groups"] for it in g["items"] if it.get("d5") is not None)
    if n < 10:
        raise SystemExit(f"only {n} ETFs have data — not publishing")
    Path(OUT).parent.mkdir(parents=True, exist_ok=True)
    Path(OUT).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({Path(OUT).stat().st_size // 1024} KB, {n} ETFs)")
    push(OUT)
