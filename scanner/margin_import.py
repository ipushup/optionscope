#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
margin_import.py — 將手抄嘅富途孖展保證金率轉成 margin_cache.json
                   零安裝，唔使 FutuOpenD，唔使 futu-api

用法：
  1. 開 margin.txt，逐行寫 "代號 百分比"
  2. python margin_import.py
  3. git add margin_cache.json && git commit && git push

margin.txt 格式（好鬆，點寫都收）：
  BABA 40
  NOW  45
  ONDS 0          <- 0 = 不可融資
  hood 50         <- 大細楷唔緊要
  0700.HK 30      <- 港股用 daily_brief 格式 (4位 + .HK)
  700 30          <- 或者淨係寫數字，會自動當港股補零
  # 呢行係註解，會 skip
  IONQ, 80        <- 逗號、tab、多個空格都得

會保留舊 cache 入面未被覆蓋嘅代號 (增量更新)，
所以你可以分幾次抄，唔使一次過抄晒。
"""

import json
import os
import re
import sys
from datetime import datetime

INPUT_FILE  = "margin.txt"
OUTPUT_FILE = "margin_cache.json"

LINE_RE = re.compile(r'^\s*([A-Za-z0-9._\-]+)\s*[,\t ]\s*([0-9]+(?:\.[0-9]+)?)\s*%?\s*$')


def normalise(sym: str) -> str:
    """統一成 daily_brief.py 用嘅 Symbol key"""
    s = sym.strip().upper()

    # 已經係 .HK 格式 -> 補零到 4 位
    if s.endswith(".HK"):
        return s[:-3].lstrip("0").zfill(4) + ".HK"

    # 純數字 -> 當港股
    if s.isdigit():
        return s.lstrip("0").zfill(4) + ".HK"

    return s


def main():
    if not os.path.exists(INPUT_FILE):
        # 第一次跑，起個樣本檔
        with open(INPUT_FILE, "w", encoding="utf-8") as f:
            f.write(
                "# 富途孖展保證金率 — 每行: 代號 百分比\n"
                "# 0 = 不可融資 ; # 開頭 = 註解\n"
                "# 抄完存檔，再跑 python margin_import.py\n\n"
                "BABA 40\nNOW 45\nONDS 0\nFUTU 40\nNEE 50\n"
                "AAPU 60\nSCHD 55\nPYPL 45\nINTC 40\nSKHY 50\n"
                "SOFI 80\nHOOD 50\nSPCX 50\nKTOS 70\nIBM 40\n"
                "IONQ 80\nOKLO 70\n"
            )
        print(f"✓ 已建立樣本 {INPUT_FILE}（已填入你之前畀嘅 17 隻）")
        print("  編輯完再跑一次呢個 script。")
        return

    # ── 解析 ──
    new, bad = {}, []
    with open(INPUT_FILE, encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = LINE_RE.match(line)
            if not m:
                bad.append((ln, line))
                continue
            sym = normalise(m.group(1))
            val = int(round(float(m.group(2))))
            if not 0 <= val <= 100:
                bad.append((ln, f"{line}  (百分比超出 0-100)"))
                continue
            if sym in new and new[sym] != val:
                print(f"  ⚠️  L{ln}: {sym} 重複 ({new[sym]}% -> {val}%)，用後者")
            new[sym] = val

    if bad:
        print(f"⚠️  {len(bad)} 行讀唔到，已 skip:")
        for ln, txt in bad[:10]:
            print(f"     L{ln}: {txt}")
        if len(bad) > 10:
            print(f"     ... 仲有 {len(bad)-10} 行")

    if not new:
        sys.exit("❌ 一行都解析唔到，唔覆蓋現有 cache")

    # ── 合併舊 cache（增量更新）──
    old, old_asof = {}, None
    if os.path.exists(OUTPUT_FILE):
        try:
            raw = json.load(open(OUTPUT_FILE, encoding="utf-8"))
            old = raw.get("data", {})
            old_asof = raw.get("as_of")
        except Exception as e:
            print(f"⚠️  舊 cache 讀唔到 ({e})，當空白處理")

    merged = dict(old)
    merged.update(new)

    # ── 變動報告 ──
    added   = [k for k in new if k not in old]
    changed = [(k, old[k], new[k]) for k in new
               if k in old and old[k] != new[k]]

    print(f"\n{'='*46}")
    print(f"  新增 {len(added)} 隻 · 更新 {len(changed)} 隻 · 總計 {len(merged)} 隻")
    if old_asof:
        print(f"  舊 cache 日期: {old_asof}")

    if changed:
        print("\n  變動:")
        for k, o, n in sorted(changed, key=lambda x: -(x[2] - x[1])):
            arrow = "🔺" if n > o else "🔻"
            flag  = "  <- 可能係風控加辣" if n - o >= 10 else ""
            print(f"    {arrow} {k}: {o}% → {n}%{flag}")

    vals = [v for v in merged.values() if v > 0]
    if vals:
        print(f"\n  分佈: min {min(vals)}%  median "
              f"{sorted(vals)[len(vals)//2]}%  max {max(vals)}%")
    print(f"  不可融資: {sum(1 for v in merged.values() if v == 0)} 隻")

    hi = sorted([(k, v) for k, v in merged.items() if v >= 70],
                key=lambda x: -x[1])
    if hi:
        print("  ⚠️  高保證金 (≥70%): "
              + ", ".join(f"{k} {v}%" for k, v in hi[:12]))

    # ── 寫檔 ──
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"as_of": datetime.now().strftime("%Y-%m-%d"),
                   "data": dict(sorted(merged.items()))},
                  f, ensure_ascii=False, indent=1)
    print(f"\n✅ 已寫入 {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
