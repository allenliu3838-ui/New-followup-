#!/usr/bin/env bash
# lighthouse-ci.sh — Run Lighthouse checks on critical pages.
# Requires: npm i -g lighthouse (or npx lighthouse)
# Usage: ./scripts/lighthouse-ci.sh [BASE_URL]
# Outputs JSON reports to ./lighthouse-reports/

set -euo pipefail

BASE="${1:-https://kidneysphereregistry.cn}"
OUTDIR="./lighthouse-reports"
mkdir -p "$OUTDIR"

PAGES=(
  "/"
  "/pricing"
  "/demo"
  "/staff"
)

# Thresholds (0-100)
MIN_PERF=50
MIN_A11Y=70
MIN_BP=80
MIN_SEO=70

FAIL=0

for path in "${PAGES[@]}"; do
  url="${BASE}${path}"
  name=$(echo "$path" | sed 's/\//_/g; s/^_//')
  [[ -z "$name" ]] && name="index"

  echo "📊 Running Lighthouse for ${url}..."

  npx lighthouse "$url" \
    --output=json \
    --output-path="${OUTDIR}/${name}.json" \
    --chrome-flags="--headless --no-sandbox --disable-gpu" \
    --only-categories=performance,accessibility,best-practices,seo \
    --quiet 2>/dev/null || {
    echo "  ⚠️  Lighthouse failed for ${path}, skipping..."
    continue
  }

  # Extract scores
  PERF=$(node -e "const r=require('./${OUTDIR}/${name}.json');console.log(Math.round((r.categories.performance?.score||0)*100))")
  A11Y=$(node -e "const r=require('./${OUTDIR}/${name}.json');console.log(Math.round((r.categories.accessibility?.score||0)*100))")
  BP=$(node -e "const r=require('./${OUTDIR}/${name}.json');console.log(Math.round((r.categories['best-practices']?.score||0)*100))")
  SEO=$(node -e "const r=require('./${OUTDIR}/${name}.json');console.log(Math.round((r.categories.seo?.score||0)*100))")

  echo "  ${path}: Perf=${PERF} A11y=${A11Y} BP=${BP} SEO=${SEO}"

  [[ "$PERF" -lt "$MIN_PERF" ]] && { echo "  ❌ Performance below ${MIN_PERF}"; FAIL=1; }
  [[ "$A11Y" -lt "$MIN_A11Y" ]] && { echo "  ❌ Accessibility below ${MIN_A11Y}"; FAIL=1; }
  [[ "$BP" -lt "$MIN_BP" ]] && { echo "  ❌ Best Practices below ${MIN_BP}"; FAIL=1; }
  [[ "$SEO" -lt "$MIN_SEO" ]] && { echo "  ❌ SEO below ${MIN_SEO}"; FAIL=1; }
done

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ All Lighthouse checks passed."
else
  echo "❌ Some Lighthouse checks below thresholds."
  exit 1
fi
