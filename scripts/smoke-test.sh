#!/usr/bin/env bash
# smoke-test.sh — Quick health check for critical pages.
# Usage: ./scripts/smoke-test.sh [BASE_URL]
# Exit codes: 0 = all pass, 1 = at least one failure.

set -euo pipefail

BASE="${1:-https://kidneysphereregistry.cn}"
FAIL=0

check() {
  local path="$1"
  local expect_text="$2"
  local url="${BASE}${path}"

  HTTP_CODE=$(curl -s -o /tmp/smoke_body.txt -w "%{http_code}" -L --max-time 15 "$url" 2>/dev/null || echo "000")

  if [[ "$HTTP_CODE" == "200" ]]; then
    if [[ -n "$expect_text" ]]; then
      if grep -q "$expect_text" /tmp/smoke_body.txt 2>/dev/null; then
        echo "  ✅ ${path} — 200 OK, text found"
      else
        echo "  ❌ ${path} — 200 but expected text '${expect_text}' not found"
        FAIL=1
      fi
    else
      echo "  ✅ ${path} — 200 OK"
    fi
  else
    echo "  ❌ ${path} — HTTP ${HTTP_CODE}"
    FAIL=1
  fi
}

echo "🔍 Smoke test: ${BASE}"
echo ""
check "/" "肾域·科研"
check "/pricing" "定价与试用"
check "/demo" "研究合作咨询"
check "/staff" "登录"
check "/checkout" "支付中心"
check "/guide" ""
check "/security" ""
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ All smoke tests passed."
else
  echo "❌ Some smoke tests failed."
  exit 1
fi
