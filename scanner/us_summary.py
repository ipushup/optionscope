"""
us_summary.py — Home 第三區「US AFTER-MARKET」自動摘要

流程：Longbridge（報價 + 新聞）→ Claude 寫繁體中文摘要 → 驗證 → 寫 summary.json（之後由 push_private.sh 上載）
  1. 報價：4 個指數 + 一籃子權重股（常規節升跌 + 盤後升跌）+ 美股溫度
  2. 新聞：指數同異動股嘅 Longbridge 新聞（標題 + 簡介，冇全文）
  3. Claude：只准用以上資料；輸出 JSON
  4. 驗證：格式、長度、標普／納指收市價必須同我哋嘅報價一致 → 唔過就唔上載（網站保留上一份）

需要環境變數：LONGBRIDGE_APP_KEY / _APP_SECRET / _ACCESS_TOKEN（LONGBRIDGE_LANGUAGE=zh-HK 取中文新聞）、
ANTHROPIC_API_KEY（可選 ANTHROPIC_MODEL）。
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

OUT_PATH = os.environ.get("SUMMARY_OUT", "summaries_out/summary.json")
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")
HERE = os.path.dirname(os.path.abspath(__file__))

INDICES = [("spx", ".SPX.US", "S&P 500"), ("ndx", ".IXIC.US", "NASDAQ"),
           ("dji", ".DJI.US", "Dow Jones"), ("vix", ".VIX.US", "VIX")]
BELLWETHERS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "AMD", "INTC", "MU",
               "TSM", "ORCL", "NFLX", "JPM", "GS", "COIN", "MSTR", "HOOD", "XOM", "CVX", "SBUX",
               "SNDK", "PLTR", "BA", "WMT", "UNH", "LLY", "CRM", "QCOM"]
TAGS = ["大市", "導火線", "AI 鏈", "科技股", "跨資產", "加密", "財報季", "個股", "後市", "宏觀", "能源", "板塊"]
MAX_NEWS = 24
NEWS_WINDOW_H = 30


# ---------- 取數 ----------
def _ts(x):
    if x is None:
        return None
    if isinstance(x, datetime):
        return x.replace(tzinfo=timezone.utc) if x.tzinfo is None else x.astimezone(timezone.utc)
    if isinstance(x, (int, float)):
        return datetime.fromtimestamp(x, timezone.utc)
    return None


def _pct(a, b):
    return None if not a or not b else (a / b - 1.0) * 100.0


def gather():
    """回 (facts, news)。要 Longbridge credentials。"""
    from longbridge.openapi import Config, ContentContext, Market, QuoteContext
    cfg = Config.from_apikey_env()
    qc = QuoteContext(cfg)
    syms = [s for _, s, _ in INDICES] + [f"{t}.US" for t in BELLWETHERS]
    quotes = {q.symbol: q for q in qc.quote(syms)}

    indices = {}
    for cid, sym, name in INDICES:
        q = quotes.get(sym)
        if not q or not q.last_done or not q.prev_close:
            continue
        last, prev = float(q.last_done), float(q.prev_close)
        indices[cid] = {"name": name, "close": round(last, 2), "change": round(last - prev, 2),
                        "pct": round(_pct(last, prev), 2), "asof": _ts(q.timestamp).isoformat()}

    movers = []
    for t in BELLWETHERS:
        q = quotes.get(f"{t}.US")
        if not q or not q.last_done or not q.prev_close:
            continue
        last, prev = float(q.last_done), float(q.prev_close)
        post = getattr(q, "post_market_quote", None)
        post_pct = None
        if post is not None and getattr(post, "last_done", None) and float(post.last_done) > 0:
            post_pct = round(_pct(float(post.last_done), last), 2)
        movers.append({"symbol": t, "close": round(last, 2), "pct": round(_pct(last, prev), 2), "after_hours_pct": post_pct})

    temp = None
    try:
        mt = qc.market_temperature(Market.US)
        temp = {"value": int(mt.temperature), "label": mt.description or ""}
    except Exception as e:  # noqa: BLE001
        print(f"⚠ market_temperature: {e}")

    asof = _ts(quotes[".SPX.US"].timestamp) if ".SPX.US" in quotes else None
    facts = {"date": asof.astimezone(timezone(timedelta(hours=-5))).strftime("%Y-%m-%d") if asof else None,
             "asof": asof.isoformat() if asof else None, "indices": indices, "movers": movers, "temperature": temp}

    # 新聞：指數 + 變動最大嘅幾隻
    top = sorted((m for m in movers), key=lambda m: -abs(m["pct"]))[:5]
    news_syms = [s for _, s, n in INDICES if n != "VIX"] + [f"{m['symbol']}.US" for m in top]
    since = datetime.now(timezone.utc) - timedelta(hours=NEWS_WINDOW_H)
    cc = ContentContext(cfg)
    seen, news = set(), []
    for s in news_syms:
        try:
            items = cc.news(s)
        except Exception as e:  # noqa: BLE001
            print(f"⚠ news {s}: {e}")
            continue
        for it in items:
            t = _ts(it.published_at)
            if it.id in seen or not (it.title or "").strip() or not t or t < since:
                continue
            seen.add(it.id)
            news.append({"time": t.isoformat(), "title": it.title.strip(), "text": (it.description or "").strip()[:600]})
    news.sort(key=lambda n: n["time"], reverse=True)
    return facts, news[:MAX_NEWS]


# ---------- Claude ----------
SYSTEM = """你係一位為個人交易者寫「美股收市摘要」嘅編輯。用繁體中文（香港用語），簡潔、客觀。

硬性規則：
1. 只可以使用「資料」入面出現嘅事實同數字。資料冇寫嘅原因、數字、公司消息，一律唔好寫，唔好憑記憶補充。
2. 標普 500、納指、道指嘅收市價同升跌 %，必須逐字照抄資料入面 indices 嘅數值（收市價用千分位、兩位小數，例如 7,580.07）。
3. 如果新聞之間有矛盾，只寫有共識嘅部分，或者寫「報道不一」。
4. 用自己嘅文字總結，唔好逐字抄新聞句子。唔好寫投資建議（買入、賣出、目標價）。
5. 後市／盤後異動（after_hours_pct）有明顯變動先寫；冇就唔好寫。
6. 「ahead」（下週重點）只喺新聞明確提到未來事件時先寫，否則留空字串。

只輸出一個 JSON 物件，唔好加解釋或 markdown：
{"headline": "一句標題（約 25 字內）",
 "bullets": [{"tag": "短標籤（2-4 字）", "text": "一至三句"}] ,  // 4 至 6 項，第一項必須係「大市」
 "ahead": ""}
可用標籤例子：""" + "、".join(TAGS) + "。"


def build_user(facts, news, example):
    return ("以下係格式與語氣示範（只參考格式，唔好抄內容）：\n" + json.dumps(example, ensure_ascii=False)
            + "\n\n====== 資料（唯一事實來源）======\n" + json.dumps({"facts": facts, "news": news}, ensure_ascii=False)
            + "\n\n請寫出今日嘅摘要 JSON。")


def call_claude(system, user):
    import anthropic
    client = anthropic.Anthropic()
    r = client.messages.create(model=MODEL, max_tokens=1800, system=system,
                               messages=[{"role": "user", "content": user}])
    print(f"tokens: in={r.usage.input_tokens} out={r.usage.output_tokens}")
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text")


# ---------- 驗證 ----------
def parse_json(txt):
    txt = txt.strip()
    txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt)
    a, b = txt.find("{"), txt.rfind("}")
    return json.loads(txt[a:b + 1])


def validate(out, facts):
    """回錯誤列表；空 = 通過。"""
    errs = []
    if not isinstance(out, dict):
        return ["not an object"]
    if not (isinstance(out.get("headline"), str) and 5 <= len(out["headline"]) <= 60):
        errs.append("headline missing/too long")
    bl = out.get("bullets")
    if not (isinstance(bl, list) and 3 <= len(bl) <= 7):
        return errs + ["bullets must be 3-7 items"]
    for i, b in enumerate(bl):
        if not (isinstance(b, dict) and isinstance(b.get("tag"), str) and isinstance(b.get("text"), str)):
            errs.append(f"bullet {i} malformed")
            continue
        if not (1 <= len(b["tag"]) <= 8) or not (8 <= len(b["text"]) <= 450):
            errs.append(f"bullet {i} length")
    if bl and isinstance(bl[0], dict) and bl[0].get("tag") != "大市":
        errs.append("first bullet must be 大市")
    if not isinstance(out.get("ahead", ""), str):
        errs.append("ahead must be string")
    blob = " ".join(b.get("text", "") for b in bl if isinstance(b, dict))
    for cid in ("spx", "ndx"):
        ix = facts["indices"].get(cid)
        if ix and f"{ix['close']:,.2f}" not in blob:
            errs.append(f"{ix['name']} close {ix['close']:,.2f} not found in text")
        if ix and f"{abs(ix['pct']):.2f}%" not in blob:
            errs.append(f"{ix['name']} pct {abs(ix['pct']):.2f}% not found in text")
    if re.search(r"買入|賣出|目標價|建議買|建議賣", blob):
        errs.append("contains advice wording")
    return errs


def assemble(out, facts):
    return {"market": "US", "date": facts["date"], "generated_at": datetime.now(timezone.utc).isoformat(),
            "headline": out["headline"].strip(),
            "bullets": [{"tag": b["tag"].strip(), "text": b["text"].strip()} for b in out["bullets"]],
            "ahead": (out.get("ahead") or "").strip(),
            "temperature": facts.get("temperature"),
            "sources": [{"name": "Longbridge News", "title": "", "time": facts["date"]}]}


def main():
    facts, news = gather()
    if not facts["indices"].get("spx") or not facts["indices"].get("ndx"):
        raise SystemExit("index quotes missing")
    force = os.environ.get("SUMMARY_FORCE") == "1"
    dry = os.environ.get("SUMMARY_DRY_RUN") == "1"
    age_h = (datetime.now(timezone.utc) - datetime.fromisoformat(facts["asof"])).total_seconds() / 3600
    print(f"::notice::facts date={facts['date']} age_h={age_h:.0f} indices={list(facts['indices'])} "
          f"movers={len(facts['movers'])} news={len(news)} temp={facts['temperature']}")
    if age_h > 30 and not force:
        print(f"ℹ 最新常規節收市已係 {age_h:.0f} 小時前（假期／未開市），唔更新摘要")
        return
    if len(news) < 3:
        raise SystemExit(f"only {len(news)} news items — not enough to summarise")
    if dry:
        titles = " | ".join(n["title"][:40] for n in news[:6])
        print(f"::notice::DRY RUN — Claude not called. latest news: {titles}")
        return
    example = json.load(open(os.path.join(HERE, "summary_example.json"), encoding="utf-8"))
    example = {k: example[k] for k in ("headline", "bullets", "ahead")}
    out = None
    for attempt in (1, 2):
        txt = call_claude(SYSTEM, build_user(facts, news, example))
        try:
            out = parse_json(txt)
            errs = validate(out, facts)
        except Exception as e:  # noqa: BLE001
            errs = [f"parse error: {e}"]
        if not errs:
            break
        print(f"⚠ attempt {attempt} failed validation: {errs}")
        out = None
    if out is None:
        raise SystemExit("summary failed validation twice — keeping the previous summary")
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(assemble(out, facts), f, ensure_ascii=False, indent=1)
    print(f"✓ {OUT_PATH} ({facts['date']})")


if __name__ == "__main__":
    main()
