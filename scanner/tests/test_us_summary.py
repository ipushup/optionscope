import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import us_summary as u

facts = {"date": "2026-10-30", "asof": "2026-10-30T20:00:00+00:00", "temperature": {"value": 34, "label": "中性偏降"},
         "indices": {"spx": {"name": "S&P 500", "close": 7580.07, "pct": -1.82, "change": -140.32},
                     "ndx": {"name": "NASDAQ", "close": 25437.00, "pct": -2.86, "change": -747.73}}}
good = json.load(open(os.path.join(os.path.dirname(__file__), "..", "summary_example.json"), encoding="utf-8"))
assert u.validate(good, facts) == [], u.validate(good, facts)
assert u.assemble(good, facts)["date"] == "2026-10-30"
bad = json.loads(json.dumps(good)); bad["bullets"][0]["text"] = "大市下跌，標普 500 收 7,500.00，跌 1.82%，納指 25,437.00 跌 2.86%。"
assert any("7,580.07" in e for e in u.validate(bad, facts))
adv = json.loads(json.dumps(good)); adv["bullets"][1]["text"] += " 建議買入 Intel。"
assert any("advice" in e for e in u.validate(adv, facts))
short = json.loads(json.dumps(good)); short["bullets"] = short["bullets"][:2]
assert u.validate(short, facts)
assert u.parse_json("```json\n" + json.dumps(good, ensure_ascii=False) + "\n```")["headline"] == good["headline"]
print("us_summary offline tests OK")
