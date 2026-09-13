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

隔离副本的静态核查已通过：两页所有原始 script 块及页脚逐字保持；首页价格区块逐字保持；新增站内链接及锚点有效，无重复 ID；内联 JavaScript 语法检查及 `git diff --check` 通过。网站文件的差异范围只有上列两个 HTML 文件。后续上线核验见下文；尚未完成认证、付款等真实业务验证，不能把静态检查当作端到端测试。

指定配置中的登记域名和根目录、两页基线哈希已经通过服务器截图核对。用户现已通过离线包完成两页更新，公开网页内容亦已核验。PR 仍为草稿；服务器源码仓库未同步本分支，后续部署须避免以旧源码覆盖新版网页。

## GitHub 下载超时后的离线交付

用户后续截图显示两次 `curl` 下载失败：一次等待 60 秒收到 0 字节，另一次连接 `raw.githubusercontent.com:443` 超时。此前提供的命令包含 `set -euo pipefail`，因此在下载失败处停止，没有执行 Python 更新程序。

`scripts/build_registry_offline.py` 从同一份 helper 和两页经哈希校验的 HTML 创建 Python zipapp。包内只包含入口、helper 及 `pages/index.html`、`pages/collaboration.html`，不解压到网站目录。执行入口显式使用包内加载器，因此检查、更新和回退都不需要连接 GitHub。核心备份与替换函数保持不变；只向 `main` 增加内容加载器及回退命令路径的可选参数。

构建命令（在源码仓库的开发副本中运行）：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/build_registry_offline.py /absolute/output/registry-university-offline-20260913.pyz
```

操作人员下载交付的 `.pyz` 文件，通过阿里云 Workbench 左侧“文件管理”上传到 `/root`，等待上传完成。以另行提供的整包 SHA-256 校验成功为执行条件，之后运行 `python3 /root/registry-university-offline-20260913.pyz --apply`。没有 `--apply` 时只读检查。成功后保存打印出的 `BACKUP` 和 `ROLLBACK_COMMAND`；需要回退时仍使用同一个 `.pyz` 文件。不要同时执行更新和回退。

文件上传本身仍需要阿里云上传服务的网络连接；仅更新包的执行不再依赖外部下载。上传入口依据：[阿里云 Workbench 文件传输文档](https://help.aliyun.com/zh/simple-application-server/user-guide/use-workbench-to-transfer-files-to-a-linux-server)。

`tests/test_registry_offline_bundle.py` 验证精确包成员及原文一致、禁止网络时的更新/回退、正确的 `.pyz` 回退命令，以及损坏或缺失页面时在替换前拒绝。基础文件操作测试仍使用合成临时目录；离线交付不代表服务器已更新。

## 2026-09-13 上线核验记录

用户服务器截图显示整包 SHA-256 校验 `OK`，之后打印 `RELEASE_OK: both local page hashes verified; no services restarted`。备份目录为 `/root/registry-page-releases/20260913T160027Z-xum5pugy`，保留的工具为 `/root/registry-university-offline-20260913.pyz`。只有需要回退时才使用该工具的 `--rollback` 参数；本次未执行回退。

随后进行公开页面的只读核验，未登录、注册账号、提交表单或读取患者记录：

- 登记站 `/`、`/index.html`、`/collaboration` 直接 HTTP 请求均返回 200。两页响应体 SHA-256 与上列新版哈希完全一致；`Last-Modified` 为 `Sun, 13 Sep 2026 16:00:27 GMT`。
- 网页检索工具最初返回了旧首页内容，随后直接请求及真实浏览器均确认新版，以后两者作为上线依据。
- 浏览器首页显示大学合作新入口，点击“查看90天试点安排”到达 `/collaboration#pilot-plan`。合作页的研究项目筛选可切换到肾移植项目并恢复全部；另外六张团队和阶段说明卡保持显示。桌面当前视口截图未见明显重叠；未完成手机尺寸验证。
- `/login`、`/signup?trial=1`、`/pricing` 返回 200，页面标题分别为登录、注册、价格与方案。首页价格内容显示正常；未执行真实认证或付款。

浏览器可见导航明确提供另外四个域名，公开入口结果如下：

| 站点 | 本次公开首页核验 | 限制 |
| --- | --- | --- |
| `https://kidneysphere.com/` | HTTP 200，无重定向 | 未测试登录后视频、付款等业务 |
| `https://kidneyspheredoctorapp.cn/` | HTTP 200，无重定向 | JavaScript 应用入口，未测试登录和临床业务 |
| `https://kidneyspherefollowup.cn/` | HTTP 200，无重定向 | 未测试记录业务 |
| `https://kidneysphereremote.cn/` | 检查失败，需核查 TLS 证书 | 检查网关返回 502；正文为 `Certificate verify failed: certificate has expired`，响应 Server 为 `mitmproxy 12.2.3`。不能将其直接称为源站应用的 502 |

随诊站错误经一次有限复核仍存在。未关闭证书校验、未改网络路径，也未修改该站文件、证书、Nginx 或服务。尚无更新前的该站实时基线或服务器证书日期，不能据此归因于本次发布；应先只读核查指定配置引用的公开证书及到期时间。不能报告五站业务全部正常。
