# 大学合作页面改版：发布范围与核对记录

## 版本依据

- 服务器截图中的源码目录：`/opt/kidneysphere-followup`。
- 截图中的提交：`742b279f343c6cbc8cd0472f286dad645270fe3e`，日期 2026-03-31。
- 对应 GitHub 仓库：`allenliu3838-ui/New-followup-`；准备本次改版时 `main` 指向同一提交。
- 截图中的 `git status --short` 没有输出；这仅表示源码工作区未显示变更，不能证明网站发布目录与仓库一致。
- 已看到配置文件名 `/etc/nginx/conf.d/kidneysphereregistry.conf`，但尚未读取其路由设置，不能仅凭文件名确认服务边界。

## 本次可发布文件

只包含以下两个现有网页：

| 仓库文件 | 拟核对的服务器文件 | 基线 SHA-256 |
| --- | --- | --- |
| `site/index.html` | `/var/www/kidneysphere-registry/index.html` | `1df317b50eb330234f05e277442e2a6ff7574f0671e539ca1d076b3a4611f381` |
| `site/collaboration.html` | `/var/www/kidneysphere-registry/collaboration.html` | `07aa6cc9ddfbf31c095646f0621c8f93b8d02b0279f6e6ac4bc285667d91e494` |

页面增加大学及附属医院的合作入口、建议分工、拟议的 90 天试点评估流程和启动前需落实的事项。该试点安排是合作讨论框架，不是已经签署的合作、已经批准的伦理方案或已实现的系统能力。

现有登录、注册、认证回跳脚本、项目卡片渲染脚本、价格绑定及页脚信息须保持。新增说明不改变账户、付费或试用条款。研究计算的独立审查记录见 `REGISTRY_RESEARCH_INTEGRITY_REVIEW.md`；本次页面改版不代表分析脚本已修复或经过临床验证。

## 服务器上的只读核对

读取指定配置的域名和目录字段，不显示整个配置或代理目标：

```bash
awk '
{
  s=$0
  sub(/#.*/, "", s)
  if (s ~ /(^|[;{}[:space:]])proxy_pass([[:space:]]|$)/) proxy=1
  if (s ~ /^[[:space:]]*(server_name|root|alias|listen|include)[[:space:]]/) {
    sub(/;.*/, ";", s)
    print s
  }
}
END { print "proxy_pass in this file: " (proxy ? "detected; target hidden" : "not detected") }
' /etc/nginx/conf.d/kidneysphereregistry.conf
sha256sum /var/www/kidneysphere-registry/index.html /var/www/kidneysphere-registry/collaboration.html
```

这只是常见单行指令的摘录，不是完整 Nginx 解析器。包含文件、同一行中的其他指令、别名、上游代理和当前实际加载的配置仍需按输出进一步确认。若哈希与上表不同，须取得当前网页文件并比较差异，再准备补丁，不能覆盖服务器上独有的修改。

## 定向发布和回退原则

1. 确认登记域名实际读取的目录，检查路径及文件是否为符号链接，确认这两个文件未被其他站点复用。
2. 记录五个网站关键公开页面的发布前状态。读取检查不使用患者记录或真实账号提交。
3. 在网站目录以外创建本次专用备份，保留这两个原始文件、权限和哈希；不要复用三月份旧备份。
4. 在独立暂存位置准备这两个经审查的页面。发布前再次比对线上哈希，发现并行更新就停止。
5. 仅替换经确认的两个页面，保留原权限。若任一替换或发布检查失败，恢复本次备份中的两份原文件。
6. 验证首页、合作页、登录入口、试用入口、价格显示及项目筛选，并对另外四个站点作回归检查。只改静态页面通常不需要重启服务；只有实际配置证明需要时才另行评估。

不要执行未经检查的 `/opt/deploy-registry.sh`，也不要把整份仓库同步到 `/var/www`。本次变更不需要修改数据库、认证配置、共享导航、Nginx 配置或系统软件。

## 当前发布状态

隔离副本的静态核查已通过：两页所有原始 script 块及页脚逐字保持；首页价格区块逐字保持；新增站内链接及锚点有效，无重复 ID；内联 JavaScript 语法检查及 `git diff --check` 通过。网站文件的差异范围只有上列两个 HTML 文件。尚未完成浏览器视觉检查或认证、付款等真实业务验证，不能把静态检查当作端到端测试。

本文件记录的是待核对的发布方案。服务器路由、线上文件哈希及发布后的五站回归尚未验证；创建代码分支或草稿 PR 不等于已发布至阿里云。
