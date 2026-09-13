# 大学合作页面改版：发布范围与核对记录

## 版本依据

- 服务器截图中的源码目录：`/opt/kidneysphere-followup`。
- 截图中的提交：`742b279f343c6cbc8cd0472f286dad645270fe3e`，日期 2026-03-31。
- 对应 GitHub 仓库：`allenliu3838-ui/New-followup-`；准备本次改版时 `main` 指向同一提交。
- 截图中的 `git status --short` 没有输出；这仅表示源码工作区未显示变更，不能证明网站发布目录与仓库一致。
- 2026-09-13 的后续服务器截图显示，`/etc/nginx/conf.d/kidneysphereregistry.conf` 中的 `server_name` 为 `kidneysphereregistry.cn www.kidneysphereregistry.cn`，`root` 为 `/var/www/kidneysphere-registry`。
- 同一截图中，下列两个已部署文件的 SHA-256 与基线完全一致。配置摘录不等于完整的已加载配置审计，也不能证明其他域名没有复用此目录。

## 本次可发布文件

只包含以下两个现有网页：

| 仓库文件 | 已核对的服务器文件 | 基线 SHA-256 |
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

## 定向发布工具

`scripts/registry_pages_release.py` 是独立的 Python 3 标准库工具。CLI 固定目标为 `/var/www/kidneysphere-registry`，只允许 `index.html` 和 `collaboration.html`；备份固定保存于 `/root/registry-page-releases` 的本次专用子目录。

HTML 固定取自提交 `9d8528edf00f8fe7bb2ff8fd70f9a70add1a3f52`，不跟随分支变化。两个新版 SHA-256 为：

```text
abbb6ebf61ed52c6e3200cb8606a9915a2d107f449c42d2b4e5c1585a5576864  index.html
da84f9e46a193fde9d4defb285cb03a605bee0a78258adbce464c4e238a857db  collaboration.html
```

使用经独立 SHA-256 核验、保存在服务器上的工具文件：

```bash
python3 /absolute/path/to/release.py
python3 /absolute/path/to/release.py --apply
python3 /absolute/path/to/release.py --rollback /root/registry-page-releases/本次备份目录
```

第一行仅检查文件，不写入。第二行执行实际更新；第三行是需要回退时使用的独立命令，不应与更新命令一并执行。成功更新时工具打印实际的 `BACKUP` 路径和完整 `ROLLBACK_COMMAND`。

执行 `--apply` 时：

1. 检查目标路径，拒绝符号链接、硬链接及非普通文件；要求两页均匹配已核对基线。若已是本次新版，直接退出，不重复替换。
2. 下载固定版本的两页并校验完整内容哈希；下载失败时不会替换网页。
3. 在网站目录外保留两份原文件、权限和本次清单，写入并同步备份及暂存文件。
4. 再次检查现有文件；每次替换前核验临时文件哈希，并保留原始属主、属组、权限及平台支持的扩展属性，更新修改时间。
5. 逐个原子替换文件，核验最终哈希。普通异常时，只尝试恢复本进程已经替换的文件，保留备份；未替换的他人文件不在自动回退范围内。

两次替换不是一个事务。断电、强制结束或两次替换之间的短暂混合版本不能完全避免；中断后可用该次备份执行显式回退。回退会先核验所选文件和备份，检测到第三种内容哈希时拒绝覆盖，不提供强制覆盖选项。工具锁只协调同一工具，发布期间应暂停其他部署操作。

工具不执行 `/opt/deploy-registry.sh`、整站同步、数据库修改、认证配置修改、Nginx 配置修改、系统升级或服务重启。它不修改 `/opt/kidneysphere-followup` 源码目录；GitHub 草稿 PR 保存此次变更，源码仓库的后续部署流程需要采用这些已审查的页面，避免旧流程再次覆盖。

## 验证范围

部署工具的测试仅在合成临时目录中运行，不访问患者记录、真实数据库或生产文件。运行命令：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_registry_pages_release.py' -v
```

测试覆盖成功、重复执行、回退、权限保留、相邻四个站点及配置哨兵文件保持、错误基线/下载内容、缺失文件、符号链接、硬链接、第二次替换失败恢复、混合版本恢复以及第三方修改和备份损坏时停止。并行修改、替换后同步失败和 FIFO 的针对性回归检查同样使用临时目录。哨兵测试只验证代码的文件操作范围，不等于真实五个网站的回归验证。

实际发布后仍须核对首页、合作页、登录入口、试用入口、价格显示及项目筛选，检查其余站点的关键公开页面。服务器上两页哈希成功只说明文件更新，不代表真实业务验证完成。

## 当前发布状态

隔离副本的静态核查已通过：两页所有原始 script 块及页脚逐字保持；首页价格区块逐字保持；新增站内链接及锚点有效，无重复 ID；内联 JavaScript 语法检查及 `git diff --check` 通过。网站文件的差异范围只有上列两个 HTML 文件。尚未完成浏览器视觉检查或认证、付款等真实业务验证，不能把静态检查当作端到端测试。

指定配置中的登记域名和根目录、两页基线哈希已经通过服务器截图核对。尚未执行服务器更新，亦未完成发布后的五站回归；创建代码分支或草稿 PR 不等于已发布至阿里云。
