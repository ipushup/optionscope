#!/usr/bin/env bash
# update.sh — 重新部署 gateway（前端 + Worker），並可選擇設定 Longbridge 即時報價 secrets。
# 喺 Codespace 行：  bash worker/update.sh
# 唔會改 SITE_PASSWORD / SESSION_SECRET / INGEST_TOKEN。
set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT_ID_DEFAULT="bf74daef7a128255fad241f55d992ccd"
read -rp "Cloudflare Account ID [$ACCOUNT_ID_DEFAULT]: " ACC
export CLOUDFLARE_ACCOUNT_ID="${ACC:-$ACCOUNT_ID_DEFAULT}"
read -rsp "Cloudflare API token (輸入時唔會顯示): " TOK; echo
export CLOUDFLARE_API_TOKEN="$TOK"

echo "▶ 建置前端…"
(cd ../frontend && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
npm install --no-audit --no-fund >/dev/null
echo "▶ 部署…"
npx wrangler deploy 2>&1 | grep -v -i "warning\|out-of-date\|update to the latest\|npm install --save-dev\|After installation" | tail -6

echo
echo "要啟用即時報價，請輸入 Longbridge 嘅三個值（唔想改就直接按 Enter 跳過）："
for NAME in LB_APP_KEY LB_APP_SECRET LB_ACCESS_TOKEN; do
  read -rsp "$NAME: " V; echo
  if [ -n "$V" ]; then printf %s "$V" | npx wrangler secret put "$NAME" >/dev/null 2>&1 && echo "  ✓ $NAME 已設定"; fi
done
echo "完成。"
