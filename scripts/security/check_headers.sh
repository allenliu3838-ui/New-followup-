#!/usr/bin/env bash
# scripts/security/check_headers.sh
# 用途：检查公开页面的 HTTP 安全响应头，输出可读报告
# 用法：bash scripts/security/check_headers.sh configs/urls_public.txt
# 输出：stdout（建议重定向到 artifacts/security_headers_report.md）
# 需要：curl（无需生产凭证）

set -euo pipefail

URLS_FILE="${1:-configs/urls_public.txt}"

if [[ ! -f "$URLS_FILE" ]]; then
  echo "ERROR: URL 文件不存在: $URLS_FILE" >&2
  exit 1
fi

# 预检
if ! command -v curl &>/dev/null; then
  echo "ERROR: 需要 curl" >&2
  exit 1
fi

REQUIRED_HEADERS=(
  "strict-transport-security"
  "x-content-type-options"
  "x-frame-options"
  "referrer-policy"
  "permissions-policy"
)

MISSING_ANY=0

echo "# 安全响应头检查报告"
echo "生成时间：$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo ""

while IFS= read -r url || [[ -n "$url" ]]; do
  # 跳过注释与空行
  [[ "$url" =~ ^#.*$ || -z "$url" ]] && continue

  echo "## $url"

  # 获取响应头（跟随重定向，最多 5 次，10s 超时）
  headers=$(curl -sIL --max-redirs 5 --connect-timeout 10 --max-time 15 "$url" 2>/dev/null | tr '[:upper:]' '[:lower:]')

  if [[ -z "$headers" ]]; then
    echo "⚠️  无法获取响应头（超时或连接失败）"
    echo ""
    continue
  fi

  # HTTP 状态码
  status=$(curl -sIL --max-redirs 5 --connect-timeout 10 --max-time 15 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  echo "HTTP 状态：$status"
  echo ""
  echo "| 头部 | 状态 | 值 |"
  echo "|------|------|----|"

  for header in "${REQUIRED_HEADERS[@]}"; do
    value=$(echo "$headers" | grep "^${header}:" | head -1 | sed "s/^${header}:[[:space:]]*//" | tr -d '\r')
    if [[ -n "$value" ]]; then
      echo "| \`$header\` | ✅ | \`$value\` |"
    else
      echo "| \`$header\` | ❌ 缺失 | — |"
      MISSING_ANY=1
    fi
  done

  echo ""
done < "$URLS_FILE"

echo "---"
if [[ "$MISSING_ANY" -eq 0 ]]; then
  echo "✅ 所有页面安全头完整"
else
  echo "❌ 存在缺失的安全头，请对照上方报告修复"
fi

exit "$MISSING_ANY"
