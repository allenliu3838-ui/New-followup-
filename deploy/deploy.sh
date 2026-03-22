#!/bin/bash
# ============================================================
# KidneySphere 阿里云部署脚本
# 用法：在阿里云服务器上执行
#   bash deploy.sh
# ============================================================

set -e

SITE_DIR="/var/www/kidneysphere/site"
NGINX_CONF="/etc/nginx/conf.d/kidneysphere.conf"
REPO_URL="https://github.com/allenliu3838-ui/New-followup-.git"
TEMP_DIR="/tmp/kidneysphere-deploy"

echo "=== KidneySphere 部署开始 ==="

# 1. 安装 git（如果没有）
if ! command -v git &> /dev/null; then
    echo ">>> 安装 git..."
    yum install -y git 2>/dev/null || apt-get install -y git
fi

# 2. 确认 nginx 已安装
if ! command -v nginx &> /dev/null; then
    echo ">>> 错误：未安装 Nginx，请先安装：yum install -y nginx"
    exit 1
fi

# 3. 克隆/更新代码
echo ">>> 拉取最新代码..."
rm -rf "$TEMP_DIR"
git clone --depth 1 "$REPO_URL" "$TEMP_DIR"

# 4. 复制站点文件
echo ">>> 部署站点文件到 $SITE_DIR..."
mkdir -p "$SITE_DIR"
rsync -av --delete "$TEMP_DIR/site/" "$SITE_DIR/"

# 5. 设置权限
chown -R nginx:nginx "$SITE_DIR" 2>/dev/null || chown -R www-data:www-data "$SITE_DIR" 2>/dev/null || true
chmod -R 755 "$SITE_DIR"

# 6. 安装 nginx 配置
echo ">>> 安装 Nginx 配置..."
cp "$TEMP_DIR/deploy/nginx.conf" "$NGINX_CONF"

# 7. 测试 nginx 配置
echo ">>> 测试 Nginx 配置..."
nginx -t

# 8. 重载 nginx
echo ">>> 重载 Nginx..."
systemctl reload nginx || nginx -s reload

# 9. 清理
rm -rf "$TEMP_DIR"

echo ""
echo "=== 部署完成！==="
echo "站点目录：$SITE_DIR"
echo "Nginx 配置：$NGINX_CONF"
echo ""
echo "如需配置域名和 SSL，编辑 $NGINX_CONF 中的 server_name，"
echo "然后运行：certbot --nginx -d your-domain.com"
