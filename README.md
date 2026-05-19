# ⚡ OptionScope — Option IV Scanner
### High IV + Strong Trend · Runs FREE on GitHub Actions · iPhone PWA

---

## How It Works

```
GitHub Actions (runs 5x per trading day, free)
    ↓  scanner/run_scan.py  (Python + yfinance)
    ↓  saves results.json
    
GitHub Pages (free static hosting)
    ↓  serves React app + results.json
    
Your iPhone Safari → opens app → sees live data 📱
```

**Zero servers. Zero cost. Zero maintenance.**

---

## ⚙️ Setup — Step by Step (15 minutes)

### STEP 1 — Fork or create repo

Option A — Fork this repo on GitHub (recommended):
1. Click the **Fork** button top-right on GitHub
2. Name it `optionscope` (or anything you like)

Option B — Create new repo:
1. Go to github.com → New repository
2. Name: `optionscope`  |  Public ✅  |  Click Create

---

### STEP 2 — Upload these files

If you forked: files are already there. Skip to Step 3.

If new repo, upload this folder structure:
```
optionscope/
├── .github/
│   └── workflows/
│       ├── scan.yml          ← runs scanner on schedule
│       └── deploy.yml        ← builds React app once
├── scanner/
│   ├── run_scan.py           ← IV + trend scanner
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── App.jsx           ← React UI
    │   └── index.js
    ├── public/
    │   └── index.html
    └── package.json
```

---

### STEP 3 — Enable GitHub Pages

1. Go to your repo on GitHub
2. Click **Settings** tab (top menu)
3. Left sidebar → **Pages**
4. Under "Source" → select **Deploy from a branch**
5. Branch: `gh-pages`  |  Folder: `/ (root)`
6. Click **Save**

---

### STEP 4 — Enable Actions write permission

1. Still in Settings → left sidebar → **Actions** → **General**
2. Scroll to "Workflow permissions"
3. Select **Read and write permissions** ✅
4. Click **Save**

---

### STEP 5 — Deploy the React frontend (one time)

1. Go to **Actions** tab in your repo
2. Click **Deploy Frontend** workflow (left sidebar)
3. Click **Run workflow** → **Run workflow** (green button)
4. Wait ~2 minutes for it to complete ✅

This builds the React app and pushes it to `gh-pages` branch.

---

### STEP 6 — Run your first scan

1. Still in Actions tab
2. Click **OptionScope Scanner** workflow
3. Click **Run workflow** → **Run workflow**
4. Watch it run — takes ~5-8 minutes to scan 100 stocks
5. When complete, it saves `results.json` to GitHub Pages ✅

---

### STEP 7 — Open on iPhone 📱

1. Find your GitHub Pages URL:
   - Settings → Pages → it shows: `https://YOUR_USERNAME.github.io/optionscope`

2. Open that URL in **iPhone Safari**

3. Add to Home Screen:
   - Tap the **Share** button (box with arrow)
   - Tap **"Add to Home Screen"**
   - Tap **Add**

4. Now you have a full-screen app icon on your iPhone! 🎉

---

## 📅 Automatic Scan Schedule

The scanner runs automatically Monday–Friday at:
- 9:30 AM ET (market open)
- 11:00 AM ET
- 1:00 PM ET  
- 3:00 PM ET
- 3:55 PM ET (near close)

You can also trigger it manually anytime from the Actions tab.

---

## 📖 How to Read Results

### IV Rank
```
85–100  🔥 Very high IV → sell premium (Iron Condor, Short Strangle)
60–84   ✅ High IV      → sell spreads (Bull Put, Bear Call)
40–59   ⚠  Moderate    → selective plays
0–39    ❌ Low IV       → buy options (debit spreads, calendars)
```

### ADX (Trend Strength)
```
> 40    Very strong trend → trade with confidence
25–40   Good trend
< 25    No trend → avoid directional plays, use Iron Condors
```

### RSI
```
> 70    Overbought → bearish bias
< 30    Oversold   → bullish bias
50–70   Uptrend
30–50   Downtrend
```

### Compass Quadrants
```
Top-Right  Expensive Vol · Bullish → Bull Put Spread, Short Put
Top-Left   Expensive Vol · Bearish → Bear Call Spread, Iron Condor
Bot-Right  Cheap Vol · Bullish     → Bull Call Debit Spread
Bot-Left   Cheap Vol · Bearish     → Bear Put Debit Spread
```

---

## 🔧 Customize

**Change scan frequency** → edit `.github/workflows/scan.yml` cron lines

**Change which stocks** → edit `scanner/run_scan.py` SP100 list

**Filter minimum IV** → in the app, use the "IV >" dropdown

**Add more stocks** → append tickers to SP100 list in run_scan.py

---

## ⚠️ Disclaimer

This tool is for educational/research purposes only.
Options trading involves significant risk. Always do your own research.
Data from yfinance is delayed ~15 minutes and may have inaccuracies.

---

Built with ❤️ using Python, React, GitHub Actions, and Claude (claude.ai)
