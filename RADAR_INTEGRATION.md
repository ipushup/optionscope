# Turnaround Radar → OptionScope 整合指南

## 1. 檔案放邊度

```
optionscope/
├── .github/workflows/
│   ├── scan.yml              (現有)
│   ├── deploy.yml            (現有)
│   └── radar_scan.yml        ← 新增
├── scanner/
│   ├── run_scan.py           (現有)
│   ├── turnaround_radar.py   ← 新增（同 daily_brief 嗰個一模一樣）
│   ├── radar_scan.py         ← 新增（重掃描 → radar.json）
│   └── radar_quotes.py       ← 新增（輕量報價 → radar_quotes.json）
└── frontend/src/
    ├── App.jsx               ← 改 3 行
    └── Radar.jsx             ← 新增
```

## 2. App.jsx 三個改動

**① 頂部 import（第 1-2 行附近）**
```jsx
import RadarView from "./Radar";
```

**② Tab 按鈕 — 搵 `[["premium","💰"],["compass","🧭"]]` 呢行，改成：**
```jsx
{[["premium","💰"],["compass","🧭"],["radar","📡"]].map(([id,icon])=>(
  <button key={id} onClick={()=>setView(id)} style={{
    padding:"5px 12px", borderRadius:6, border:"none", cursor:"pointer",
    fontSize:11, fontWeight:700, fontFamily:"'Syne',sans-serif",
    background:view===id?"#1a3555":"transparent", color:view===id?"#3b9eff":"#3a5060",
  }}>{isMobile?icon:(id==="premium"?"💰 Premium":id==="compass"?"🧭 Compass":"📡 Radar")}</button>
))}
```

**③ 加 view — 搵 `{/* COMPASS VIEW */}` 嗰個 block，喺佢後面加：**
```jsx
{/* RADAR VIEW */}
{view==="radar" && <RadarView isMobile={isMobile} />}
```
注意：radar 有自己嘅 loading/error 處理，所以唔好包 `!loading && !error &&`
（嗰兩個 state 係 OptionScope 掃描器嘅，同 radar 無關）。

## 3. GitHub Actions 設定

`radar_scan.yml` 一個 workflow 做兩件事：
- **20:15 UTC（美股收市後）** → 完整 radar 掃描，重新計晒指標
- **其餘 cron（每 15 分鐘，覆蓋 pre/regular/post + 港股時段）** → 只刷新報價

Quote-only 嘅 run 會由 gh-pages 攞返上次嘅 radar.json，唔會重新計指標 —
所以每次 run 得 30-60 秒，唔會燒爆 Action 額度。

首次執行：Actions → Turnaround Radar → Run workflow → 剔 `full_scan` ✅

## 4. 資料流

```
radar.json        指標/GATE/SCORE/VETO/卡片內容 + levels（收市值，每日一次）
radar_quotes.json 即時價格 incl. pre/post market（每 15 分鐘）
        ↓
    Radar.jsx 前端合併：
      • 價格 = post ?? pre ?? regular ?? 收市價
      • 所有距離（vs EMA10/EMA20/止蝕/UT Bot/通道）用即時價重算
      • 狀態自動覆蓋：穿止蝕 → 🔴 / 穿 UT Bot → 🟠 / 到買入區 → 🟢
```

指標本身唔會 intraday 重算 —— 因為你成套方法係 closed-candle based，
intraday 重算 SuperTrend/UT Bot 會出假訊號。

## 5. 港股「夜市」

港股現貨無 pre/post market，所以 HK ticker 只會顯示 regular 價。
如果隻股有美股 ADR（例如 BABA），可以之後喺 radar_quotes.py 加 ADR mapping
攞美股時段價做「夜市價」。而家版本未做。
