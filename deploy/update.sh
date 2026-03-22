#!/bin/bash
# ============================================================
# KidneySphere 快速更新脚本（日常更新用）
# 用法：bash update.sh
# ============================================================

set -e

SITE_DIR="/var/www/kidneysphere/site"
REPO_URL="https://github.com/allenliu3838-ui/New-followup-.git"
TEMP_DIR="/tmp/kidneysphere-deploy"

echo ">>> 拉取最新代码..."
rm -rf "$TEMP_DIR"
git clone --depth 1 "$REPO_URL" "$TEMP_DIR"

echo ">>> 更新站点文件..."
rsync -av --delete "$TEMP_DIR/site/" "$SITE_DIR/"

echo ">>> 清理..."
rm -rf "$TEMP_DIR"

echo "=== 更新完成！==="
