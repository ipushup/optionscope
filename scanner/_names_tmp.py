import json, re, sys
from pathlib import Path
sys.path.insert(0, "scanner")
import indicator_scan as I
from longbridge.openapi import Config, QuoteContext
ents = [e for e in I.parse_watchlist(Path("scanner/Watchlists.txt")) if e["ticker"]]
back = {}
for e in ents:
    t = e["ticker"]; m = re.match(r"^(\d{1,5})\.HK$", t)
    if m: back[f"{int(m.group(1))}.HK"] = t
    elif re.match(r"^[A-Z]{1,5}$", t): back[f"{t}.US"] = t
ctx = QuoteContext(Config.from_apikey_env())
out = {}; syms = list(back)
for i in range(0, len(syms), 100):
    try:
        for inf in ctx.static_info(syms[i:i+100]):
            hk = inf.symbol.endswith(".HK")   # 同 My List 一樣：港股 name_cn，美股 name_en
            n = ((getattr(inf, "name_cn", "") or getattr(inf, "name_en", "")) if hk else (getattr(inf, "name_en", "") or getattr(inf, "name_cn", ""))) or ""
            n = n.strip()
            if n: out[back[inf.symbol]] = n
    except Exception as ex:
        print("batch fail", i, ex)
print(len(out), "names of", len(syms))
Path("frontend/public").mkdir(parents=True, exist_ok=True)
Path("frontend/public/names.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
