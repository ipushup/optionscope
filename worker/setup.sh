#!/usr/bin/env bash
# setup.sh — 一次過部署 gateway 並設好 3 個 Worker secrets。
# 喺 Codespace（或本機）行：  bash worker/setup.sh
# 需要：Cloudflare API token（Edit Cloudflare Workers 模板）同 Account ID。
set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT_ID_DEFAULT="bf74daef7a128255fad241f55d992ccd"
read -rp "Cloudflare Account ID [$ACCOUNT_ID_DEFAULT]: " ACC
export CLOUDFLARE_ACCOUNT_ID="${ACC:-$ACCOUNT_ID_DEFAULT}"
read -rsp "Cloudflare API token (輸入時唔會顯示): " TOK; echo
export CLOUDFLARE_API_TOKEN="$TOK"
read -rsp "網站登入密碼（你自己揀，長啲好）: " PW; echo
read -rsp "再輸入一次: " PW2; echo
[ "$PW" = "$PW2" ] || { echo "兩次密碼唔一樣，中止"; exit 1; }
[ "${#PW}" -ge 10 ] || { echo "密碼要至少 10 個字元，中止"; exit 1; }

echo "▶ 建置前端…"
(cd ../frontend && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
echo "▶ 安裝 wrangler 並部署…"
npm install --no-audit --no-fund >/dev/null
OUT=$(npx wrangler deploy 2>&1) || { echo "$OUT"; exit 1; }
echo "$OUT" | tail -5
URL=$(echo "$OUT" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1)

SESSION=$(openssl rand -hex 32)
INGEST=$(openssl rand -hex 32)
echo "▶ 設定 Worker secrets…"
printf %s "$PW"      | npx wrangler secret put SITE_PASSWORD  >/dev/null
printf %s "$SESSION" | npx wrangler secret put SESSION_SECRET >/dev/null
printf %s "$INGEST"  | npx wrangler secret put INGEST_TOKEN   >/dev/null

echo
echo "════════════════════════════════════════════════"
echo "完成。去 GitHub → Settings → Secrets and variables → Actions，加兩個 secret："
echo "  GATEWAY_URL  = ${URL:-<上面 deploy 輸出嘅 workers.dev 網址>}"
echo "  INGEST_TOKEN = $INGEST"
echo "（INGEST_TOKEN 只會顯示呢一次，請即刻抄低。）"
echo "════════════════════════════════════════════════"
