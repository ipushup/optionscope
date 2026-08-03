# Triple Band → OptionScope 整合指南

## 1. 檔案放邊度

```
optionscope/
├── .github/workflows/
│   ├── radar_scan.yml        (現有)
│   └── band_scan.yml         ← 新增
├── scanner/
│   ├── band_scanner.py       ← 新增（同 daily_brief 嗰個一模一樣）
│   ├── band_scan.py          ← 新增（完整掃描 → band.json）
│   └── band_quotes.py        ← 新增（輕量報價 → band_quotes.json）
└── frontend/src/
    ├── App.jsx               ← 改 3 行
    └── Band.jsx              ← 新增
```

`band_scanner.py` 由 `daily_brief` 個 repo 直接抄過嚟，兩邊必須一樣。
**唔好喺 optionscope 呢邊改訊號邏輯** —— 一改就會同回測分歧，而分歧唔會有人發現。

## 2. App.jsx 三個改動

**① 頂部 import**
```jsx
import BandView from "./Band";
```

**② Tab 按鈕 — 搵嗰行 `[["premium","💰"],["compass","🧭"],["radar","📡"]]`，加多一個：**
```jsx
{[["premium","💰"],["compass","🧭"],["radar","📡"],["band","🎯"]].map(([id,icon])=>(
  <button key={id} onClick={()=>setView(id)} style={{
    padding:"5px 12px", borderRadius:6, border:"none", cursor:"pointer",
    fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif",
    background:view===id?"#1a3555":"transparent", color:view===id?"#3b9eff":"#3a5060",
  }}>{isMobile?icon:(id==="premium"?"💰 Premium":id==="compass"?"🧭 Compass":id==="radar"?"📡 Radar":"🎯 Band")}</button>
))}
```

**③ 加 view — 喺 `{/* RADAR VIEW */}` 個 block 後面：**
```jsx
{/* BAND VIEW */}
{view==="band" && <BandView isMobile={isMobile} />}
```
同 Radar 一樣，唔好包 `!loading && !error &&`。

## 3. 資料流

```
band.json         訊號／ext／rU60／UT stop／死線   （收市後，一日兩次）
band_quotes.json  即時價 + day_low                （每 15 分鐘）
        ↓
    Band.jsx 前端合併：
      • vs訊號 = 現價 vs 訊號價（追高成本）
      • 形成中：day_low vs kill_low、現價 vs kill_close
      • 距 UT stop：ut_pos == 1 先有意義
```

**前端一行訊號邏輯都冇。** pivot / ext / rU60 / UT Bot 全部喺 `band_scan.py`
用收咗市嘅棒計死。intraday 重算會出假訊號 —— 成套方法係 closed-candle based。

## 4. 五個 tab

| Tab | 意思 | 你要做咩 |
|---|---|---|
| ✅ 已確認 | pivot 七支棒封晒，**鎖死唔會 repaint** | 明早開市市價買 |
| ⏳ 形成中 | 今日收市先知，兩條死線即時監察 | 睇住，唔好提早買 |
| ● 有效候選 | 已成立未出場，訊號日新→舊 | 有錢就入，睇住「vs訊號」 |
| ▼ 出場 | 今日 UT 翻空 | 收市價平 |
| ○ 觀察 | 美股 small + 港股 | **唔落注**，淨係睇市況 |

## 5. 形成中嘅兩條死線

pivot 窗口 `[p−3, p+3]`，`p+3` 就係今日嗰支未收嘅棒。所以今日盤中仲有變數，
但**只有兩個死因**：

| 死因 | 條件 | 後果 |
|---|---|---|
| ① pivot 破 | 今日 Low ≤ `kill_low` | 唔再係窗口唯一最低 → 訊號消失 |
| ② tier 跌級 | 今日 Close > `kill_close` | rU60 升穿 −5% → 變 small → 唔入場 |

`ext` **唔會**變 —— 佢用 pivot 當日嘅 m1/w1，唔係今日。冷卻同左邊三棒亦已封。
兩條線守得住，收市就升級做「已確認」。

## 6. GitHub Actions

照 `radar_scan.yml` 同一個 pattern：**輸出 push 去 `gh-pages` 分支根目錄**
（唔係 commit 落 main）—— 前端讀嘅係已部署嗰份。

靠 cron 分鐘位分辨模式：

- **:40**（20:40 UTC 美股收市後、08:40 UTC 港股收市後）→ 完整掃描
- **:05/:20/:35/:50** → 只刷報價，由 gh-pages 攞返上次嘅 band.json

**分鐘位特登錯開。** Radar 用 `15 20`（heavy）同 `*/15`（quotes）；band 用
`40`（heavy）同 `5,20,35,50`。兩個 workflow 唔會同一分鐘一齊打 Yahoo。

`QUOTE_MARKETS` 同 radar 一樣：HK cron 只抽港股、US cron 只抽美股、
full scan 同手動 run 兩邊都抽。另一邊市場嘅報價會由上次 `band_quotes.json`
保留落嚟，唔會被抹走。

首次執行：Actions → Triple Band Radar → Run workflow → `quotes_only` **唔好剔**

**`drop_forming()` 同 `radar_scan.py` 嘅 `get_closed_df()` 唔同**：後者見到
「最後一支棒日期 == 今日 UTC 日期」就掉，即係 20:15 UTC 跑嗰陣會連當日已經
收咗市嘅美股棒都掉埋，白白蝕一日。呢度改成用收市時間判斷（美股 20:05 UTC 後、
港股 08:10 UTC 後當日棒先算封）。

## 7. 業績 veto

`band_scan.py` 讀 `frontend/public/earnings.json`（格式 `{"AAPL": "2026-08-05"}`），
7 個交易日內出業績嘅會標 ⛔ 並轉紅底。冇呢個檔就唔標。

覆蓋範圍有缺口：攞唔到業績日期嗰啲會靜靜咁冇標記。ADR、新上市、細價股容易中招，
落大注之前自己核一核。

## 8. 環境變數

| 變數 | 預設 | 用途 |
|---|---|---|
| `BAND_OUT` | `frontend/public/band.json` | 掃描輸出 |
| `BAND_QUOTES_OUT` | `frontend/public/band_quotes.json` | 報價輸出 |
| `BAND_EARNINGS` | `frontend/public/earnings.json` | 業績日期來源 |
| `BAND_VETO_DAYS` | `7` | veto 窗口（交易日） |

---

## 已驗證規格（2016–2026 · 5,645 筆 · 212 隻）

```
市場   美股 only          港股 big-filter PF 只有 1.52，唔落注
入場   rU60 ≤ −5%         small tier 完全唔入場（PF 2.03 vs 1.64）
       ext ≥ 2.0          pivot(3,3) 距 fast mid 兩條帶寬
       冷卻 5 棒
       次日開市成交        跳空成本平均 +0.153%
出場   UT Bot KV2/ATR1    新鮮翻空。冇止蝕、冇止賺、冇時間止蝕
上限   30 隻 fifo          揀訊號規則掃過五條，冇一條贏到 random
注碼   3.3% = 1/30
```

| | 策略 | SPX |
|---|---|---|
| 年化 | 25.2% | 13.2% |
| maxDD | −33.3% | −33.9% |
| Sharpe | 1.26 | 0.74 |
| Calmar | 0.76 | 0.39 |

alpha +12.6%/年 · beta 0.85 · 跑贏 8/11 年 · 2022 −13.0% vs SPX −19.4%

**三個要記住嘅限制**

1. universe 係 2026 年名單，早年有幸存者偏差，而早年正正係跑贏最少嗰幾年
2. 超額回報高度集中喺 2023–25；剔走嗰兩年大約只係 SPX + 5–8%
3. cap 重放嘅噪音底線至少 ±1.7% 年化 —— 細過呢個嘅差異唔可以當真

**入場後 UT 可能永遠轉唔到多**（band 入場必然喺 UT 空頭狀態，要 −1→+1→−1
行完一轉先有出場訊號）。嗰批倉冇止蝕保護，10 年最差單筆 −43.6%，每年都有
−40% 以上嘅。呢個係策略嘅左尾，唔係意外。
