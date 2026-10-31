#!/usr/bin/env bash
# push_private.sh — 將 JSON 上傳去私人 gateway（Cloudflare Worker KV）。
# 用法：GATEWAY_URL=https://xxx INGEST_TOKEN=xxx scanner/push_private.sh file1.json ...
# 未設 secrets → 跳過（唔 fail），gateway 未建好都唔會搞壞現有 workflow。
set -u
if [ -z "${GATEWAY_URL:-}" ] || [ -z "${INGEST_TOKEN:-}" ]; then
  echo "ℹ GATEWAY_URL / INGEST_TOKEN 未設，跳過私人上傳"
  exit 0
fi
fail=0
for f in "$@"; do
  [ -f "$f" ] || { echo "ℹ 冇 $f，跳過"; continue; }
  name=$(basename "$f")
  code=$(curl -sS -o /tmp/ingest_out -w "%{http_code}" -X PUT \
    -H "Authorization: Bearer ${INGEST_TOKEN}" -H "Content-Type: application/json" \
    --data-binary @"$f" "${GATEWAY_URL%/}/_ingest/${name}") || code=000
  if [ "$code" = "200" ]; then echo "✓ $name"; else echo "::error::upload $name failed ($code): $(cat /tmp/ingest_out 2>/dev/null)"; fail=1; fi
done
exit $fail
