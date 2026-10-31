# optionscope-gateway（私人只讀站）

一個 Cloudflare Worker 同時做三件事：登入、俾 React app、守住數據 JSON。
App 同數據喺**同一個網址**，所以登入 cookie 係 first-party，Safari 都唔會擋。

| 路徑 | 行為 |
|---|---|
| `GET /` | 未登入 → 登入頁；已登入 → React app |
| `POST /api/login` | 密碼啱 → HttpOnly cookie。剔「記住」= 30 日，否則 12 小時。15 分鐘內錯 8 次 → 429 |
| `POST /api/logout` | 清 cookie |
| `GET /<name>.json` | 要有效 cookie，從 KV 讀 |
| `PUT /_ingest/<name>.json` | `Authorization: Bearer INGEST_TOKEN`，GitHub Actions 上傳數據用 |

## 一次性設定（Cloudflare 戶口，約 10 分鐘）

```bash
cd worker && npm install
npx wrangler login
npx wrangler kv namespace create DATA        # 將輸出嘅 id 貼入 wrangler.toml
npx wrangler secret put SITE_PASSWORD         # 你嘅登入密碼（長啲好）
npx wrangler secret put SESSION_SECRET        # 隨機 32+ 字元：openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN          # 隨機 32+ 字元：openssl rand -hex 32
```

然後去 GitHub repo → Settings → Secrets and variables → Actions，加：

- `GATEWAY_URL` — Worker 網址（部署後 wrangler 會印，如 `https://optionscope-gateway.<你>.workers.dev`）
- `INGEST_TOKEN` — 同上面一樣
- `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` — 俾 `deploy_gateway.yml` 自動部署用（API token 揀 "Edit Cloudflare Workers" 模板）

跑一次 "Deploy Private Gateway"，再手動跑各 scan workflow，數據就會上去 KV。

## 邊度仍然係公開
- GitHub Pages 上面舊嘅 `*.json` 同舊站仍然公開；而且 gh-pages 歷史 commit 入面嘅舊數據永遠喺度。
- scan workflow 仍以 gh-pages 做狀態存儲（`band.json` 等）。所以要做到「真・全私」，下一步係將狀態搬去 KV／私有位置，再停 gh-pages 發佈。
- repo 本身係 public，掃描 code、watchlist 名單都睇得到。
