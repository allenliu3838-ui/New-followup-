#!/bin/bash
# ============================================================
# KidneySphere 阿里云部署/更新脚本
#
# 用法：
#   bash update.sh              # 从 main 分支部署
#   bash update.sh branch-name  # 从指定分支部署
#
# 站点目录映射（与 Nginx 配置一致）：
#   kidneysphereregistry.cn  → /var/www/kidneysphere-registry
#   kidneysphere.cn          → /var/www/kidneysphere
#   kidneysphereremote.cn    → /var/www/kidneysphere-remote
#   kidneysphere-followup.cn → /var/www/followup
# ============================================================

set -e

# ── 配置 ──────────────────────────────────────────────────────
REPO_URL="https://github.com/allenliu3838-ui/New-followup-.git"
BRANCH="${1:-main}"
TEMP_DIR="/tmp/ks-deploy-$$"

# 所有需要同步的站点目录
SITE_DIRS=(
  "/var/www/kidneysphere-registry"
  "/var/www/kidneysphere"
)

# ── 开始部署 ──────────────────────────────────────────────────
echo "====================================="
echo "  KidneySphere 部署"
echo "  分支: $BRANCH"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "====================================="

echo ""
echo ">>> [1/4] 拉取代码 ($BRANCH)..."
rm -rf "$TEMP_DIR"
git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$TEMP_DIR"

echo ""
echo ">>> [2/4] 同步站点文件..."
for dir in "${SITE_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    cp -r "$TEMP_DIR/site/"* "$dir/"
    echo "    ✓ $dir"
  else
    echo "    ⚠ $dir 不存在，跳过"
  fi
done

echo ""
echo ">>> [3/4] 验证关键文件..."
for dir in "${SITE_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    if [ -f "$dir/staff.js" ]; then
      echo "    ✓ $dir/staff.js 存在"
    else
      echo "    ✗ $dir/staff.js 缺失！"
      exit 1
    fi
  fi
done

echo ""
echo ">>> [4/4] 更新 Nginx 配置并重载..."
if [ -f "$TEMP_DIR/deploy/nginx.conf" ]; then
  cp "$TEMP_DIR/deploy/nginx.conf" /etc/nginx/conf.d/kidneysphere.conf 2>/dev/null || \
  cp "$TEMP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/kidneysphere 2>/dev/null || \
  echo "    ⚠ Nginx 配置未自动更新，请手动复制 deploy/nginx.conf"
fi
nginx -t && systemctl reload nginx
echo "    ✓ Nginx 已重载"

echo ""
echo ">>> 清理临时文件..."
rm -rf "$TEMP_DIR"

echo ""
echo "====================================="
echo "  ✅ 部署完成！"
echo "  请 Ctrl+Shift+R 刷新浏览器验证"
echo "====================================="
