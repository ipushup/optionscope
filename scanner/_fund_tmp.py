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
            sh = float(getattr(inf, "total_shares", 0) or 0)
            eps = float(getattr(inf, "eps_ttm", 0) or 0)
            if sh > 0: out[back[inf.symbol]] = [round(sh), round(eps, 4)]
    except Exception as ex:
        print("batch fail", i, ex)
print(len(out), "of", len(syms))
Path("frontend/src/fundamentals.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
