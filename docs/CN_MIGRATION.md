# 登记系统迁往中国境内（阿里云）操作手册

> 适用对象：负责迁移的运维人员、复核人、课题负责人代表、医院信息科与伦理/合规审查人员。
> 适用代码：PR #110 整合版本 + 本批改动（迁移 0032–0040；0040 为化验/用药/终点事件批量导入）。调研基线为提交 749bb5d，2026-10-12。
> 本手册只描述操作和核对方法，不构成法律意见；涉及法律判断的事项列在第 11 节，由运营方与法务决定。

## 0. 先读

**要做什么。** 登记站网页已经部署在阿里云 ECS（`/var/www/kidneysphere-registry`），但账户认证、登记数据库和附件存储仍在 Supabase 云服务的美国西部区域（us-west-2，项目 `etsyglgpiutflethgirs`）。本手册把数据库、认证、附件和备份整体迁到阿里云，迁移后浏览器只访问境内主机。

**顺序要点。** 线上生产仍是 #110 之前的结构（迁移 0001–0031）。#110 与本批的增量（0032–0040）不在美国旧环境执行，而是在新环境恢复旧数据后执行，再发布新版前端。所以“切换数据库”和“发布新版前端”必须在同一个维护窗口内完成。

**基本规则。**

- 所有命令在受控终端执行（阿里云 Workbench 或运维主机）。数据库密码、服务密钥只放在当前终端的环境变量中，用 `read -rs` 输入，不写进命令历史、仓库、聊天或邮件。
- 标注“只读”的 SQL 不修改数据；标注“写入”的步骤必须两人在场（执行人 + 复核人）。
- 任何一步结果与“预期”不符：停止，记录，按第 8 节判断是否回滚。不要跳过核对，不要为通过核对去修改核对脚本。
- 维护窗口内不在任何生产数据库上做与本手册无关的操作。

**配套文件（`docs/cn-migration/`）。**

| 文件 | 用途 |
|---|---|
| `checklist.md` | 逐项勾选的执行清单（打印后签字留档） |
| `snapshot.sql` | 只读快照：关键表行数、每张业务表内容指纹、账号登录指纹、随访链接摘要指纹、附件清单指纹、迁移版本。只输出计数和摘要 |
| `compare_snapshots.py` | 比较两份快照：`freeze`（冻结期间无变化）、`restore`（恢复后与旧库逐表一致）、`upgrade`（升级后关键计数与指纹一致） |
| `config.example.js` | 迁移后服务器 `config.js` 的参考写法 |
| `selfhost.env.example` | 自托管服务环境变量参考 |
| `../../scripts/check_external_hosts.py` | 境外依赖检查（附录 A） |

本手册的恢复、升级、清除明文和时区步骤，已在本地两个合成 PostgreSQL 17.6 实例上按同样顺序演练过一次（合成的认证/存储表结构，0001–0031 → 备份 → 恢复 → 0032–0040 → 清除明文 → 改时区，三个阶段的快照比较均一致）。合成演练不能代替第 4.11 节在真实新环境上的全流程演练。

## 1. 现状清点（迁移会涉及的全部部分）

| 部分 | 现状（基线 749bb5d） | 迁移动作 |
|---|---|---|
| 网页文件 | 阿里云 ECS，Nginx 站点目录 `/var/www/kidneysphere-registry`（发布工具 `scripts/registry_integrated_release.py` 的 `TARGET`）。同机还有另外四个网站（发布工具 `SENTINELS` 列出的路径） | 不迁移；只替换 `config.js`，并发布新版前端 |
| `config.js`（服务器专属，发布工具只校验不覆盖） | `SUPABASE_URL=https://etsyglgpiutflethgirs.supabase.co`；`SUPABASE_ANON_KEY` 为新格式公开密钥 `sb_publishable_…`；`BILLING.WECHAT_QR_IMG`、`ALIPAY_QR_IMG` 指向同一 Supabase 项目的公开桶 `billing` | 改为境内地址与新密钥（6.14），模板见 `config.example.js` |
| 数据库 | Supabase 云，PostgreSQL 17，us-west-2。评估时规模：5 个项目、24 名患者、67 条随访、56 个随访链接、35 个账号、基因变异 0 条（以冻结时实际计数为准） | 备份、恢复到新环境，执行 0032–0040 |
| 认证（GoTrue） | 密码登录（`login.html`、`staff.js`）；邮箱注册并确认（`signup.html`，回跳 `/auth-callback?returnTo=/signup`）；找回密码（回跳 `/auth-callback?recovery=1&returnTo=/staff` 或 `/auth-callback?returnTo=/staff`）；`auth-callback.html` 同时处理 PKCE `code` 和地址栏 `#access_token` 两种回调。现有代码没有调用邮件魔法链接登录（`staff.js` 的 `sendMagicLink` 实际是密码登录），但认证服务的魔法链接邮件模板仍需按中文配置或停用 | 自托管 GoTrue；恢复 `auth.users`（含密码哈希）和 `auth.identities`；配置回跳白名单与境内 SMTP |
| 数据接口（PostgREST） | 浏览器经 supabase-js 直接读写十余张表（`.from(...)`）并调用 RPC；没有使用 Realtime（无 `.channel(`），没有使用 Edge Functions（无 `functions.invoke`） | 自托管 PostgREST，只暴露 `public` |
| 附件（Storage） | 公开桶 `billing`：两张收款码图片（在控制台手工创建，不在迁移脚本里）。私有桶 `payment-proofs`：0027 创建（10MB；png/jpeg/webp/pdf），策略 0027 → 0033（按 `auth.uid()` 目录隔离，平台管理员可读）；`checkout.js` 上传付款凭证，`staff.js` 管理员用 120 秒签名链接查看 | 自托管 Storage（本地文件后端）；桶配置用数据恢复，文件经接口重新上传并逐个核对 SHA-256 |
| 数据库扩展 | 0001 执行 `create extension pgcrypto`；0028 起函数改用内置 `sha256()`、`gen_random_uuid()`；0032–0040 只用内置函数；0039 用内置 `sha256` 计算随访链接摘要（与 0032 起 `security_audit_logs.token_hash` 算法相同） | 新环境无需额外扩展（pgcrypto 可保留）；6.12 核对没有函数再调用 pgcrypto |
| 浏览器加载的外部主机 | `kidneysphere.com` 共享顶栏 CSS/JS（多数页面）——在允许清单内，但需核实其服务器同在境内（发布工具哨兵包含 `/var/www/kidneysphere/`，推测同机部署，需人工确认）；`plausible.io`（`analytics.js`，11 个页面引用）——境外统计，必须关闭；`beian.miit.gov.cn`、`beian.mps.gov.cn`、`www.cac.gov.cn`、`escholarship.org` 只出现在链接中；`lib/vendor` 内的 `github.com` 等只是库内文档字符串 | 附录 A 的检查器在迁移前后各运行一次 |
| 发布与核验工具 | `registry_integrated_release.py`：`PROJECT_REF='etsyglgpiutflethgirs'`、`TARGET`、`SENTINELS`；`capture_registry_database.py`：`PROJECT_REF`，且只接受 `db.<ref>.supabase.co` 或 `*.pooler.supabase.com` + 用户 `postgres.<ref>`；`refresh_release_manifest.py` 的 `project_ref` 继承自上一版清单；`tests/pg17-preflight.mjs` 写死了 `project_ref` | 需要代码改动，见第 9 节（不在本手册执行） |
| 测试夹具 | `tests/helpers/pg17-fixture.mjs` 合成了：`anon`/`authenticated`/`service_role`（BYPASSRLS）三个角色；`extensions` schema 与 pgcrypto；只有 `id/email/created_at/email_confirmed_at` 的 `auth.users`；只读 `request.jwt.claim.sub` 的 `auth.uid()`、`auth.jwt()`；最简 `storage.buckets/objects` 与 `storage.foldername()`；没有 `authenticator`、`supabase_admin`、`supabase_auth_admin`、`supabase_storage_admin` 角色 | 夹具证明 SQL 逻辑，不证明真实 GoTrue/Storage 行为；新环境必须做 4.11 全流程演练 |
| 历史安全头 | `netlify.toml`（已停用）的 CSP 含 `*.supabase.co`、`plausible.io`、`cdn.jsdelivr.net`；服务器 Nginx 实际配置不在仓库中 | 6.14 检查服务器 Nginx 是否有同类 CSP 并修改 |

参考文档：`docs/REGISTRY_PG17_RELEASE.md`（PG17 增量流程与发布核验）、`docs/REGISTRY_RECOVERY.md`（恢复说明与先做只读清点的要求）、`docs/REGISTRY_INTEGRATED_RELEASE.md`（捕获、发布、回退命令）。

## 2. 目标架构：两个方案与推荐

### 2.1 方案 A：阿里云 ECS 上自托管 Supabase（docker compose）

在一台专用 ECS 上用 docker compose 运行 Supabase 开源组件，只保留本系统用到的：数据库（Supabase 的 PostgreSQL 17 镜像）、GoTrue（认证）、PostgREST（数据接口）、Storage（附件，本地文件后端）、Kong（网关）。镜像从阿里云容器镜像服务（ACR）私有仓库拉取。

### 2.2 方案 B：阿里云 RDS PostgreSQL 17 + 自托管 GoTrue/PostgREST/Storage

数据库使用 RDS（托管），认证、接口、存储、网关仍以容器运行在 ECS 上，连接 RDS。

### 2.3 对比

| 维度 | 方案 A：ECS 自托管 | 方案 B：RDS + 自托管服务 |
|---|---|---|
| 与现有代码和发布核验的兼容性 | 与 Supabase 云使用同一套数据库镜像和角色（`postgres`、`supabase_admin`、`anon`、`authenticated`、`service_role`、`authenticator` 及认证/存储专用角色），`auth`/`storage` schema 由服务自身创建。发布契约要求的对象属主（`postgres`）和代码里按角色名判断的维护逻辑（0032 `_set_updated_meta` 等认 `postgres`/`supabase_admin`）可以原样满足 | RDS 不提供超级用户。需手工建立上述角色、`auth`/`storage` schema 的属主与授权；高权限账号若不能命名为 `postgres`，发布契约中的属主、0032/0033 中按角色名放行的维护逻辑都会不一致，需要另行审查和改代码；`pg_restore --disable-triggers` 等需要超级用户的操作要换方法 |
| 运维工作量 | 较多：数据库补丁、备份、监控、磁盘与容量都由运维负责 | 较少：数据库补丁、备份、主备切换、监控由 RDS 提供；仍需维护三个服务容器 |
| 备份与恢复 | 自建：每日逻辑备份 + 云盘快照 + OSS 异地（境内）副本；时间点恢复需另建 WAL 归档 | 自动备份与按时间点恢复（保留天数可配），控制台可一键克隆实例做演练 |
| 等级保护 | 主机、数据库、日志审计、备份等控制项需要运营方自行落实并准备证据 | 数据库层的审计（SQL 洞察）、备份、加密、高可用有现成能力和材料，证据准备较容易；主机与服务层仍需自行落实 |
| 成本 | 一台 ECS（建议 4 vCPU / 8 GiB、ESSD 数据盘）+ 快照 + OSS | RDS 实例（高可用版为主备两节点）+ 一台运行服务的 ECS + 备份存储，月费明显高于 A。具体以阿里云价格计算器为准 |
| 迁移风险 | 低：恢复路径与 Supabase 官方自托管迁移方式一致，本手册命令已做合成演练 | 中：角色/属主改造需要额外开发与审查，发布契约可能需要重新建立 |

### 2.4 推荐：方案 A

理由：

1. **最少改动、最小迁移风险。** 本系统的迁移、RLS 策略、发布契约和维护逻辑都按 Supabase 的角色体系编写和审查过；方案 A 不需要改任何 SQL，只改 `config.js` 和发布工具中的项目身份。
2. **规模很小。** 35 个账号、几十条随访，单台 ECS 的性能绰绰有余；主要风险在操作正确性，而不是容量。
3. **备份和等保的不足可以补齐。** 第 4.10、10.1 节给出每日逻辑备份、云盘快照、境内 OSS 副本和每月恢复演练；等保需要的日志与审计在第 11.2 节列出。

何时考虑转到方案 B：定级为第三级且测评要求数据库高可用、或数据量和机构数量明显增长、或运维人手无法保证每月恢复演练。转换时需先完成角色/属主改造的代码审查，并按本手册同样的快照比较方法验证。

### 2.5 方案 A 的部署拓扑

```
浏览器 ──HTTPS──> 现网站 ECS（Nginx，已有）
                   ├─ kidneysphereregistry.cn        → /var/www/kidneysphere-registry（静态页面，不变）
                   └─ api.kidneysphereregistry.cn    → 反向代理到 新 ECS 内网 IP:8000（Kong）
新 ECS（同地域、同专有网络 VPC，无公网 IP）
   docker compose：Kong:8000 → GoTrue / PostgREST / Storage → PostgreSQL 17（数据盘）
   Storage 文件 → 数据盘 /data/registry-storage
   备份 → 本机 /data/backups + 同地域 OSS 私有桶（服务端加密、版本控制）
```

- 新域名 `api.kidneysphereregistry.cn` 是已备案域名的子域，Nginx 仍在现有 ECS 上，对外入口和 ICP 备案的接入信息不变（11.3 节仍需核对）。
- 新 ECS 的安全组只放行来自现网站 ECS 内网地址的 8000 端口和运维通道；5432、8443、3000 等端口不对任何公网地址开放。
- 也可以让 Nginx 运行在新 ECS 上并绑定公网 IP；那样需要核对该 IP 的备案接入信息，其他步骤相同。

## 3. 时间表与分工

| 时间 | 事项 | 负责人 |
|---|---|---|
| T-21 | 确定方案与地域；确认 `kidneysphere.com` 共享顶栏的服务器位置；启动合规事项（第 11 节） | 运营方、运维、法务 |
| T-14 | 搭建新环境（第 4 节）；完成第 9 节代码适配并审查；编写中文邮件模板 | 运维、开发 |
| T-10 | 用一份旧库备份在新环境完成全流程演练（4.11），记录耗时；演练后清空新环境 | 运维、复核人 |
| T-7 | 发出迁移通知（5.1）；抄录旧控制台配置（5.2）；只读清点（5.3） | 运营方、运维 |
| T-3 | 建立迁移验证用测试账号与测试链接（5.4）；配置 `api.` 域名解析与证书；Nginx 预置维护开关（6.1） | 运维 |
| T0 | 维护窗口（建议 4 小时，演练耗时的 2 倍以上）：第 6 节 | 执行人、复核人、验收人 |
| T+1 ~ T+7 | 观察期：每日核对备份、错误日志、用户反馈 | 运维 |
| T+7 | 验收签字；若需回滚，只能在此之前按第 8 节评估 | 验收人 |
| T+30 | 确认无回滚需要后，下线旧 Supabase 项目并保留删除记录（10.3） | 运营方、运维、法务 |

## 4. 新环境搭建（迁移前完成，不含真实数据）

### 4.1 云资源

1. 新建 ECS：与现网站 ECS 同一地域、同一专有网络（如华东2 上海），建议 4 vCPU / 8 GiB，系统盘 + 独立 ESSD 数据盘（100 GiB 起，开启云盘加密），不分配公网 IP。
2. 安全组：入方向只允许现网站 ECS 内网地址访问 TCP 8000；运维通过 Workbench/堡垒机登录。出方向在迁移窗口内需要能访问旧 Supabase（下载备份），窗口结束后收紧。
3. 数据盘挂载到 `/data`：`/data/postgres`（数据库卷）、`/data/registry-storage`（附件文件）、`/data/backups`（本机备份）。
4. 快照策略：先建好，**上线并完成 6.9 后再关联到数据盘**（避免快照中保留升级前的明文随访链接）。
5. OSS：同地域私有桶 `registry-backup-<随机后缀>`，开启服务端加密、版本控制、生命周期（例如每日备份保留 35 天、每月备份保留 13 个月，按运营方的保留策略调整）。
6. DNS：在现有域名下增加 `api.kidneysphereregistry.cn` 指向现网站 ECS 公网 IP；申请或扩展 HTTPS 证书。

### 4.2 镜像

1. 记录旧环境组件版本：Supabase 控制台的项目设置中可以看到 PostgreSQL、Auth（GoTrue）、PostgREST 版本；Storage 版本以控制台或 5.3 清点出的 `storage.migrations` 为准。
2. 选择与官方 docker 自托管目录同一发布批次的镜像标签：PostgreSQL 必须是 17 系列的 Supabase 镜像（发布核验只接受 PG17）；GoTrue 与 Storage 版本**不低于**旧环境（它们的库表迁移只能向前）；PostgREST 主版本与旧环境一致。
3. 在能访问官方镜像仓库的环境拉取这些镜像，按 digest 固定；`docker save` 后传入境内，`docker load`、`docker tag`、`docker push` 到同地域 ACR 私有仓库；compose 文件里一律写 `registry-vpc.<地域>.aliyuncs.com/<命名空间>/<镜像>@sha256:<digest>`。核对推送后的 digest 与原始 digest 一致。
4. 运行时不再访问任何境外镜像仓库。

### 4.3 精简 compose

以固定版本的官方自托管 `docker-compose.yml` 为起点，放在 `/opt/registry-supabase/`：

- 保留：`db`、`kong`、`auth`、`rest`、`storage`。
- 不部署：`realtime`、`functions`、`analytics`、`vector`、`imgproxy`、`supavisor`（本系统没有使用；删除这些服务时同时删除其他服务里对它们的 `depends_on`）。
- 管理界面 `studio` 与 `meta`：建议不部署；如需要，只绑定 `127.0.0.1`，通过运维通道访问，不经 Kong 对外。
- `db` 的数据目录挂载 `/data/postgres`；`storage` 使用文件后端，挂载 `/data/registry-storage`（参数见 `selfhost.env.example` 末尾）。
- Kong 只映射到新 ECS 内网地址的 8000（供现网站 ECS 的 Nginx 访问），不映射 8443。
- Kong 的跨域设置限定来源 `https://kidneysphereregistry.cn`。

### 4.4 生成密钥（本地生成，不用在线工具）

在新 ECS 上执行，输出写入仅 root 可读的文件，之后填入 `.env`：

```bash
install -d -m 700 /root/cn-migration
python3 -I - > /root/cn-migration/keys.env <<'EOF'
import base64, hashlib, hmac, json, secrets, time
def b64(raw): return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()
secret = secrets.token_urlsafe(48)
def token(role):
    now = int(time.time())
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(',', ':')).encode())
    body = b64(json.dumps({"role": role, "iss": "supabase", "iat": now, "exp": now + 5 * 365 * 86400},
                          separators=(',', ':')).encode())
    sig = b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"
print(f"JWT_SECRET={secret}")
print(f"ANON_KEY={token('anon')}")
print(f"SERVICE_ROLE_KEY={token('service_role')}")
print(f"POSTGRES_PASSWORD={secrets.token_urlsafe(32)}")
EOF
chmod 600 /root/cn-migration/keys.env
```

`ANON_KEY` 将写入服务器 `config.js`（公开）；`SERVICE_ROLE_KEY`、`JWT_SECRET`、`POSTGRES_PASSWORD` 只在服务器上。两个密钥有效期 5 年，到期前需重新签发并同步更新 `config.js`（届时按正常发布流程审查）。

### 4.5 环境变量与服务配置

按 `docs/cn-migration/selfhost.env.example` 填写 `/opt/registry-supabase/.env`（权限 600）。要点：

- `PGRST_DB_SCHEMAS=public`，不暴露 `registry_private`（冻结数据版本正文所在）。
- `SITE_URL=https://kidneysphereregistry.cn`；`API_EXTERNAL_URL=https://api.kidneysphereregistry.cn`。
- 回跳白名单 `ADDITIONAL_REDIRECT_URLS`：先抄录旧控制台的列表（5.2），至少要覆盖 `https://kidneysphereregistry.cn/auth-callback` 带查询参数的形式；推荐写 `https://kidneysphereregistry.cn/**`，并在 4.11 演练中用注册确认和找回密码两条流程实际验证。
- 注册确认、速率限制、JWT 有效期等与旧控制台设置保持一致（5.2 抄录）。

### 4.6 数据库连接加密（供发布核验工具使用）

发布核验工具 `capture_registry_database.py` 要求 `verify-full` TLS。为数据库配置服务器证书：

1. 用 openssl 建一个私有 CA，签发主机名为 `db.registry.internal`（示例，自定）的服务器证书。
2. 把证书、私钥挂载进 `db` 容器，设置 `ssl=on`、`ssl_cert_file`、`ssl_key_file`（私钥权限 600、属主为容器内 postgres 用户）。
3. 在现网站 ECS（运行核验工具的地方）把 `db.registry.internal` 解析到新 ECS 内网 IP（`/etc/hosts` 或云解析 PrivateZone），安全组只对该 IP 放行 5432。
4. CA 证书保存为 `/root/registry-db-ca.crt`，核验时用 `--ssl-root-cert` 指定。

数据库时区在恢复和升级完成后再改（6.10），使升级过程与审查过的测试环境（UTC）一致。

### 4.7 Nginx 反向代理

在现网站 ECS 新增独立配置文件（不改 `kidneysphereregistry.conf` 和 `nginx.conf`，它们是发布工具的哨兵文件），示例：

```nginx
# /etc/nginx/conf.d/registry-api.conf（示例，按实际证书路径与内网 IP 调整，nginx -t 通过后再 reload）
server {
    listen 443 ssl;
    server_name api.kidneysphereregistry.cn;
    ssl_certificate     /etc/nginx/ssl/api.kidneysphereregistry.cn.pem;
    ssl_certificate_key /etc/nginx/ssl/api.kidneysphereregistry.cn.key;
    client_max_body_size 12m;                     # 付款凭证上限 10MB
    allow <运维出口IP>;                            # 上线前只允许运维访问；6.17 开放时删除这两行
    deny all;
    location / {
        proxy_pass http://<新ECS内网IP>:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### 4.8 邮件

1. 选用境内 SMTP 服务（例如阿里云邮件推送或企业邮箱的 SMTP），发信域名如 `mail.kidneysphereregistry.cn`，配置 SPF、DKIM、DMARC。
2. 从旧控制台抄录现有邮件模板（注册确认、找回密码、魔法链接、邀请、修改邮箱），改为中文、平实措辞，存为 HTML 文件，放在新 ECS 内部可访问的地址，用 GoTrue 的模板地址与主题变量配置（变量名以所用版本为准）。
3. 魔法链接和邀请当前代码未使用：模板仍写成中文，防止误触发时出现英文邮件。

### 4.9 空环境自检

```bash
cd /opt/registry-supabase && docker compose up -d && docker compose ps     # 五个服务均为 healthy/running
. /root/cn-migration/keys.env
NEW_URL=http://<新ECS内网IP>:8000
curl -fsS "$NEW_URL/auth/v1/health" -H "apikey: $ANON_KEY"                                # 预期返回 GoTrue 版本信息
curl -fsS -o /dev/null -w '%{http_code}\n' "$NEW_URL/rest/v1/" -H "apikey: $ANON_KEY"   # 预期 200
docker compose exec -T db psql -U postgres -d postgres -X -c "SELECT version();"   # 预期 PostgreSQL 17.x
# 在运维出口的终端再经域名访问一次，验证 Nginx 反代与证书（非运维出口应返回 403）：
# curl -fsS https://api.kidneysphereregistry.cn/auth/v1/health -H "apikey: <ANON_KEY>"
```

核对角色（只读）：

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
WHERE rolname IN ('postgres','supabase_admin','authenticator','anon','authenticated','service_role',
                  'supabase_auth_admin','supabase_storage_admin') ORDER BY 1;
-- 预期：8 个角色都存在；supabase_admin 为超级用户；service_role 可绕过 RLS
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public';
-- 预期：0（public 为空，等待恢复）
SELECT (SELECT count(*) FROM auth.users) AS users, (SELECT count(*) FROM storage.buckets) AS buckets,
       (SELECT count(*) FROM storage.objects) AS objects;
-- 预期：0 / 0 / 0（不能有人在空环境注册或上传；4.7 的访问限制保证这一点）
```

### 4.10 备份与监控（上线后启用）

- 每日 02:00 逻辑备份：对 `public`、`registry_private`、`auth`、`storage` 做 `pg_dump --format=custom`，生成 SHA-256，用 `gpg --symmetric --cipher-algo AES256` 加密后放 `/data/backups` 并上传 OSS；附件目录 `/data/registry-storage` 每日同步到 OSS。
- 云盘快照：6.9 完成后关联快照策略（例如每 6 小时一次，保留 7 天）。
- 每月一次恢复演练：把最近一份备份恢复到临时容器，运行 `snapshot.sql` 与线上快照比较（`--phase restore`），并核对冻结数据版本的 SHA-256（7 节第 12 项）。
- 监控：云监控告警（磁盘 80%、内存、容器退出）；网络与登录日志保留不少于 6 个月（11.2）。

### 4.11 全流程演练（T-10，必做）

在新环境把第 6 节完整执行一遍（不切换 `config.js`、不发布前端、不开维护页），数据来自一份旧库备份。记录每步耗时与问题，修订本手册的具体参数（主机名、镜像 digest、命令路径）。演练结束后：

```bash
cd /opt/registry-supabase && docker compose down
rm -rf /data/postgres/* /data/registry-storage/*        # 清空演练数据（确认路径后执行）
shred -u /root/cn-migration/*.dump                      # 删除演练用备份（加密副本按 6.3 的规定保管或销毁）
docker compose up -d                                     # 重新初始化空环境，回到 4.9 自检
```

演练中如出现以下情况，迁移推迟：恢复报错、快照比较不一致、0032–0040 任一失败、旧随访链接打不开、测试账号无法登录、发布核验报告不通过。

## 5. 迁移前准备

### 5.1 冻结窗口与通知

窗口选在用户最少的时段（例如周六 22:00 至次日 02:00）。窗口内网站显示维护页，工作台和随访链接都不可用。T-7 通知所有账号（35 个）和项目负责人，T-1 再提醒一次。通知示例（面向用户，不出现技术名词）：

> 【肾域·科研 系统迁移通知】为把账户、登记数据和附件全部存放在中国境内，我们将于 X 月 X 日 22:00 至次日 02:00 进行系统迁移，期间网站暂停使用，请勿录入数据。网址不变；已经发给研究参与者的随访链接迁移后继续有效；迁移后需要重新登录一次，密码不变。系统邮件将改由 noreply@mail.kidneysphereregistry.cn 发出。如有问题请联系 china@kidneysphere.com。

请各项目负责人提醒研究参与者：窗口期间打开随访链接会看到维护提示，可在窗口结束后再填写。

### 5.2 抄录旧控制台配置（只看不改）

在 Supabase 控制台抄录并截图保存到 `/root/cn-migration/old-console/`：项目区域；PostgreSQL / Auth / PostgREST 版本；Authentication 的 Site URL、Redirect URLs、是否要求邮箱确认、密码规则、速率限制、JWT 有效期、自定义 SMTP；五种邮件模板的主题与正文；Storage 中的桶列表与公开属性；API 密钥类型（新格式 `sb_publishable_…`/`sb_secret_…` 或旧版 JWT 密钥）；Database 的连接方式（Session pooler 主机名）与 SSL 证书（下载 CA 证书 `supabase-prod-ca.crt`）；备份计划。

### 5.3 只读清点（T-7，在旧库执行）

`$REPO`（已审查发布提交的仓库副本）与 `$OLD_DB_URL`（旧库连接串，Session pooler 端口 5432，不要用 6543 的事务模式）的设置见 5.5。

```bash
psql "$OLD_DB_URL" -X -q -v ON_ERROR_STOP=1 -f $REPO/scripts/db/production_inventory.sql > /root/cn-migration/inventory-old.json
psql "$OLD_DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f $REPO/docs/cn-migration/snapshot.sql > /root/cn-migration/snapshot-old-T-7.json
```

另运行以下只读查询并保存结果：

```sql
-- 自定义角色（恢复前需在新环境存在，否则授权语句报错）
SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1;
-- 扩展
SELECT extname, extversion FROM pg_extension ORDER BY 1;
-- 存储策略（0033 会重建 payment_proofs_* 三条；其他策略需逐条复核是否要在新环境重建）
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'storage' ORDER BY 1;
-- 认证附加数据（MFA 等，若非 0 需在 6.6 一并恢复）
SELECT (SELECT count(*) FROM auth.mfa_factors) AS mfa_factors;
-- 定时任务、数据库钩子（若存在需评估）
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net','pgsodium','supabase_vault');
```

把 `snapshot-old-T-7.json` 的 `key_counts` 与第 1 节的规模对照；差异较大时先查明原因。

### 5.4 迁移验证用测试账号与测试链接（T-3，合成数据）

1. 注册一个专用测试账号（例如 `migration-test@kidneysphere.com`），密码由执行人保管。
2. 用它新建项目“迁移验证（合成）”，录入一名研究编号为 `MIG-TEST-001` 的合成患者（不是任何真实的人），生成一个随访链接，把完整链接记在执行人的离线记录中（这是“旧链接”测试样本，也用于 6.9 的明文残留检查）。
3. 上传一张合成付款凭证（可选，用于附件验证）。

迁移完成并验收后删除该项目与账号（10.2）。

### 5.5 工具准备（在新 ECS）

```bash
REPO=/root/cn-migration/repo        # 已审查发布提交的仓库副本（git clone 后 git checkout <提交>，核对提交号）
PGIMG=registry-vpc.<地域>.aliyuncs.com/<命名空间>/postgres@sha256:<digest>   # 与 db 服务同一镜像
docker run --rm --entrypoint pg_dump "$PGIMG" --version     # 预期 pg_dump (PostgreSQL) 17.x
docker run --rm --entrypoint pg_restore "$PGIMG" --version  # 预期 17.x
cp <5.2 下载的 CA 证书> /root/cn-migration/supabase-prod-ca.crt
```

如镜像内没有这两个命令，用阿里云镜像站提供的 PostgreSQL 官方软件源安装 17 版客户端（`postgresql-client-17`）。执行快照 SQL 的 `psql` 用主机上已有的客户端即可（14 及以上版本）。

旧库连接串只放在环境变量里，使用 Session pooler（端口 5432）与 5.2 下载的 CA 证书：

```bash
read -rs OLD_DB_URL; export OLD_DB_URL
# 形如 postgresql://postgres.etsyglgpiutflethgirs:<密码>@<Session pooler 主机>:5432/postgres?sslmode=verify-full&sslrootcert=/root/cn-migration/supabase-prod-ca.crt
```

## 6. 迁移当天步骤（维护窗口）

每一步完成后在 `checklist.md` 上勾选并记录时间。以下 `R` 表示执行人，`C` 表示复核人。

### 6.1 开启维护页（R，C 复核）

T-3 已在 `kidneysphereregistry.conf` 的 `server` 块中加入一行 `include /etc/nginx/registry-maintenance/*.conf;`（目录为空时不生效）。开启：

```nginx
# /etc/nginx/registry-maintenance/on.conf（存在即维护；示例）
set $registry_maint 1;
if ($remote_addr = <运维出口IP>) { set $registry_maint 0; }
if ($uri = /maintenance.html) { set $registry_maint 0; }
if ($registry_maint = 1) { return 503; }
error_page 503 /maintenance.html;
location = /maintenance.html { root /var/www/registry-maintenance; add_header Retry-After 3600 always; }
```

```bash
nginx -t && systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' https://kidneysphereregistry.cn/staff   # 非运维出口：预期 503
curl -s -o /dev/null -w '%{http_code}\n' https://kidneysphereregistry.cn/p/test  # 预期 503
```

维护页内容（`/var/www/registry-maintenance/maintenance.html`）为一句中文说明和预计恢复时间，不放在发布工具管理的目录中。新接口域名 `api.kidneysphereregistry.cn` 在整个窗口内保持 4.7 的“只允许运维出口”限制。

可选（权限允许时）：在旧库执行 `ALTER DATABASE postgres SET default_transaction_read_only = on;` 并断开现有接口连接，使旧库只读；如果报权限不足，不要强行处理，依靠维护页和 6.5 的冻结复核即可。回滚时执行 `ALTER DATABASE postgres RESET default_transaction_read_only;`。

### 6.2 冻结快照 S0（只读）

```bash
cd /root/cn-migration
psql "$OLD_DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f $REPO/docs/cn-migration/snapshot.sql > snapshot-S0-old-freeze.json
```

预期：`key_counts` 与 T-7 清点相比只有窗口前正常业务带来的增长。

### 6.3 全量备份（只读）

```bash
cd /root/cn-migration
read -rs PGPASSWORD; export PGPASSWORD                 # 旧库 postgres 密码
OLD_CONN="host=<Session pooler 主机> port=5432 dbname=postgres user=postgres.etsyglgpiutflethgirs sslmode=verify-full sslrootcert=/work/supabase-prod-ca.crt"
STAMP=$(date -u +%Y%m%dT%H%MZ)
docker run --rm --user "$(id -u):$(id -g)" -e PGPASSWORD -v /root/cn-migration:/work --entrypoint pg_dump "$PGIMG" \
  "$OLD_CONN" --format=custom --no-password \
  --schema=public --schema=auth --schema=storage --schema=registry_private \
  --file=/work/registry-us-west-2-$STAMP.dump
DUMP=/root/cn-migration/registry-us-west-2-$STAMP.dump
sha256sum "$DUMP" | tee "$DUMP.sha256"
docker run --rm -v /root/cn-migration:/work --entrypoint pg_restore "$PGIMG" --list /work/$(basename "$DUMP") > toc.txt
grep -cE 'TABLE DATA (public|auth|storage) ' toc.txt
grep -E 'TABLE DATA auth (users|identities) |TABLE DATA public (projects|patients_baseline|visits_long|patient_tokens) ' toc.txt
```

预期：`pg_dump` 无错误退出；`toc.txt` 中有上述 6 张表的 `TABLE DATA` 行。`--schema=registry_private` 在旧库中不存在，不会报错。

如 `pg_dump` 报某个 `storage` 内部表权限不足（较新 Supabase 版本的向量桶等表，与本系统无关），对该表加 `--exclude-table-data=<schema.table>` 重试并在记录中注明。

**这份备份含：全部研究数据、账号邮箱与密码哈希、随访链接明文（0039 之前）。** 处理规定：

```bash
gpg --symmetric --cipher-algo AES256 --output "$DUMP.gpg" "$DUMP"   # 口令由两人分段保管
sha256sum "$DUMP.gpg" >> "$DUMP.sha256"
```

加密副本放入 OSS 私有桶的独立目录，保留期由运营方与法务确定（建议不短于观察期 + 30 天、不长于必要期限），到期销毁并记录；明文 `.dump` 在窗口结束时（6.17）用 `shred -u` 删除，窗口内如需重做恢复可继续使用。不得拷贝到个人电脑或境外。

### 6.4 下载附件文件（只读）

旧项目的服务密钥用 `read -rs` 输入。旧版 `service_role` JWT 密钥同时放在 `apikey` 和 `Authorization: Bearer` 两个请求头；若使用新格式 `sb_secret_…` 密钥，只放 `apikey` 头。先用一个对象试下载。

```bash
cd /root/cn-migration && install -d -m 700 storage && cd storage
read -rs OLD_KEY; export OLD_KEY
OLD_URL=https://etsyglgpiutflethgirs.supabase.co
psql "$OLD_DB_URL" -X -q -t -A -F $'\t' -c \
  "SELECT bucket_id, name, coalesce(metadata->>'mimetype','application/octet-stream') FROM storage.objects ORDER BY 1, 2" > objects.tsv
wc -l objects.tsv                                    # 与 S0 的 key_counts."storage.objects" 一致
while IFS=$'\t' read -r bucket name mime; do
  enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")
  mkdir -p "old/$bucket/$(dirname "$name")"
  curl -fsS -H "apikey: $OLD_KEY" -H "Authorization: Bearer $OLD_KEY" \
    "$OLD_URL/storage/v1/object/authenticated/$bucket/$enc" -o "old/$bucket/$name" || echo "FAILED $bucket/$name"
done < objects.tsv
(cd old && find . -type f -exec sha256sum {} + | sort -k2) > sha256-old.txt
wc -l sha256-old.txt                                  # 预期与 objects.tsv 行数相同，且没有 FAILED
```

`old/` 目录同样属于含个人信息的备份（付款凭证）。打包加密后与 6.3 的备份一同保管，明文在 6.17 删除：

```bash
tar -C /root/cn-migration/storage -cf - old objects.tsv sha256-old.txt \
  | gpg --symmetric --cipher-algo AES256 --output /root/cn-migration/storage-us-west-2-$STAMP.tar.gpg
```

### 6.5 冻结复核 S1（只读）

```bash
cd /root/cn-migration
psql "$OLD_DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f $REPO/docs/cn-migration/snapshot.sql > snapshot-S1-old-after-backup.json
python3 -I $REPO/docs/cn-migration/compare_snapshots.py --phase freeze snapshot-S0-old-freeze.json snapshot-S1-old-after-backup.json
```

预期：`结论（freeze）：一致`。不一致说明备份期间旧库有写入：查明来源，重做 6.2–6.5。

### 6.6 恢复到新环境（写入，R 执行、C 复核）

新环境处于 4.9 自检通过后的空状态（再执行一次 4.9 的两条只读查询，`public` 为空，账号、存储桶、对象均为 0）。先确认备份里引用的角色在新环境都存在：

```bash
cd /opt/registry-supabase
docker compose cp "$DUMP" db:/tmp/registry.dump
docker compose exec -T db pg_restore --schema=public --file=- /tmp/registry.dump \
  | grep -E '^(ALTER .* OWNER TO|GRANT .* TO|ALTER DEFAULT PRIVILEGES FOR ROLE) ' \
  | grep -oE '(OWNER TO|TO|FOR ROLE) [a-z_]+' | awk '{print $NF}' | sort -u
# 合成演练输出为 anon、authenticated、postgres、service_role。列出的每个角色都应在 4.9 的角色查询中存在；
# 缺少的角色先评估来源，确需保留的以 NOLOGIN 方式创建并记录
# 如提示无法读取 /tmp/registry.dump，在本节各条 docker compose exec 后加 -u root
```

依次恢复（以超级用户 `supabase_admin` 执行；每条都是单事务，出错整体回滚）：

```bash
read -rs PGPASSWORD                                    # 新环境 POSTGRES_PASSWORD
R="docker compose exec -T -e PGPASSWORD=$PGPASSWORD db pg_restore -h 127.0.0.1 -U supabase_admin -d postgres --no-password --exit-on-error --single-transaction"
# 1) 账号：只恢复数据，表结构由新 GoTrue 建立。登录会话不恢复，用户迁移后重新登录一次。
$R --data-only --disable-triggers --schema=auth --table=users --table=identities /tmp/registry.dump
#    若 5.3 显示 mfa_factors 非 0，在上一行追加 --table=mfa_factors
# 2) 存储桶配置：只恢复数据，表结构由新 Storage 建立；文件在 6.11 上传
$R --data-only --disable-triggers --schema=storage --table=buckets /tmp/registry.dump
# 3) 业务数据：结构 + 数据 + 索引 + 约束 + 策略 + 授权
$R --schema=public --schema=registry_private /tmp/registry.dump
docker compose exec -T db rm -f /tmp/registry.dump
```

说明：

- 顺序不能颠倒：`public` 中有 7 个外键引用 `auth.users`，必须先恢复账号。
- 业务数据（第 3 步）必须按上面的方式**结构与数据一起**恢复：pg_restore 先装载数据、最后才创建触发器，已验证可行。不要对 `public` 单独做 `--data-only` 恢复：那样触发器会在装载时执行，已退出研究患者的行会被拒绝（`study_status_requires_dedicated_action`），研究状态会被重复写入审计。确需 data-only 时必须加 `--disable-triggers`（需超级用户）。
- 新 GoTrue/Storage 版本较新时，表上多出的列会取默认值；若报“列不存在”，说明新版本低于旧版本，停止并回到 4.2。
- 认证审计日志 `auth.audit_log_entries` 不迁入新库，随 6.3 的加密备份按保留期保存（如运营方决定迁入，追加 `--table=audit_log_entries`）。
- 旧库 `storage.objects` 上的旧策略不恢复；0033 会重建付款凭证的三条策略。5.3 中如有其他存储策略，在 6.12 之后评估是否重建。

### 6.7 恢复核对（只读）

```bash
cd /root/cn-migration
docker compose -f /opt/registry-supabase/docker-compose.yml exec -T -e PGPASSWORD=$PGPASSWORD db \
  psql -h 127.0.0.1 -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 -f - \
  < $REPO/docs/cn-migration/snapshot.sql > snapshot-S2-new-restored.json
python3 -I $REPO/docs/cn-migration/compare_snapshots.py --phase restore snapshot-S1-old-after-backup.json snapshot-S2-new-restored.json
```

预期：`结论（restore）：一致`。这一步逐表比较了全部业务表的行数与内容指纹（UTC 下的整行文本 md5），并比较账号登录指纹（id + 邮箱 + 密码哈希）、随访链接摘要指纹，以及新环境认证/存储服务的迁移版本是否覆盖旧环境。快照只含计数与摘要，可以保存在迁移记录中。

（自托管默认配置中，`postgres`、`supabase_admin` 等内部角色都使用 `POSTGRES_PASSWORD`；以 4.9 自检时实际能登录为准。以下各步同理。）

### 6.8 执行 0032–0040（写入）

按 `docs/REGISTRY_PG17_RELEASE.md` 的增量原则：只执行增量，不重跑历史全量 SQL；逐个文件执行，遇错即停。以 `postgres` 用户执行（发布契约要求这些对象的属主为 `postgres`；不要改用 `supabase_admin`）。

先核对迁移文件与审查清单一致（在仓库目录执行）：

```bash
cd "$REPO" && python3 -I -c "
import hashlib, json
for m in json.load(open('supabase/migration-manifest.json'))['migrations']:
    if m['file'][:4] >= '0032':
        ok = hashlib.sha256(open('supabase/migrations/' + m['file'], 'rb').read()).hexdigest() == m['sha256']
        print(m['file'], 'OK' if ok else 'MISMATCH')"
# 预期：0032 至 0040 共 9 行，全部 OK
```

```bash
for f in 0032_security_integrity 0033_billing_registration 0034_import_corrections 0035_frozen_exports \
         0036_project_members 0037_concept_view_security 0038_followup_workflow 0039_patient_token_hashing \
         0040_batch_import; do
  echo "== $f"
  docker compose -f /opt/registry-supabase/docker-compose.yml exec -T -e PGPASSWORD=$PGPASSWORD db \
    psql -h 127.0.0.1 -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < supabase/migrations/$f.sql || { echo "STOP at $f"; break; }
done
```

预期：9 个文件全部无错误；每个文件自带 `BEGIN … COMMIT`，失败的文件整体回滚。任一失败：停止，保存错误输出，按第 8 节处理（此时旧环境未受影响）。

升级带来的预期数据变化（不是错误）：

- 0038：`patients_baseline.consent_research` 全部置空，`consent_status` 全部为 `unconfirmed`（旧值只是从未有人填写的默认值）；变化逐条写入字段审计。迁移后由各项目按实际知情同意情况在工作台补录。
- 0039：`patient_tokens.token` 全部置空，改存 `token_hash`；患者手里的链接继续可用（摘要算法相同）。
- 0040：只新增列、函数和约束，不改已有数据。它新增“停药日期不早于开始日期”约束：如已有用药记录违反，0040 会中止并整体回滚。执行 0032 之前先查 `SELECT count(*) FROM public.meds_long WHERE end_date < start_date;`，结果须为 0，否则先在旧环境人工更正。

### 6.9 清除旧明文（写入，必须在上线前完成）

0039 把明文随访链接清空后，旧值仍留在表的死元组和预写日志（WAL）中。以 `supabase_admin` 执行（以下语句不能放在一个事务里，用 `-f -` 逐条执行）：

```bash
docker compose -f /opt/registry-supabase/docker-compose.yml exec -T -e PGPASSWORD=$PGPASSWORD db \
  psql -h 127.0.0.1 -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -f - <<'SQL'
SELECT count(*) AS replication_slots FROM pg_replication_slots;      -- 预期 0（有复制槽时 WAL 不会被删除）
SELECT pg_relation_filepath('public.patient_tokens') AS before_file;
ALTER SYSTEM SET wal_recycle = off;
SELECT pg_reload_conf();
VACUUM FULL public.patient_tokens;
ANALYZE public.patient_tokens;                 -- 恢复后自动分析会把链接码样本写进列统计
VACUUM FULL pg_catalog.pg_statistic;            -- 重写统计表，清除旧样本（2026-10-17 实际迁移中发现）
SELECT pg_relation_filepath('public.patient_tokens') AS after_file;  -- 预期与 before_file 不同（表已重写）
CHECKPOINT; SELECT pg_switch_wal();
CHECKPOINT; SELECT pg_switch_wal();
CHECKPOINT; SELECT pg_switch_wal();
CHECKPOINT;
ALTER SYSTEM RESET wal_recycle;
SELECT pg_reload_conf();
SQL
```

用 5.4 的测试链接字符串（合成数据，不要用真实链接）核对磁盘上不再有明文：

```bash
docker compose -f /opt/registry-supabase/docker-compose.yml exec -T db \
  sh -c 'grep -rlaF "<测试随访链接 /p/ 后面的字符串>" "$PGDATA/base" "$PGDATA/pg_wal" | wc -l'   # 预期 0
```

（`$PGDATA` 为容器内数据目录，一般是 `/var/lib/postgresql/data`；以 `docker compose exec db env` 的输出为准。）

合成演练结果：`VACUUM FULL` 前表文件含旧明文、之后不含；关闭 `wal_recycle` 并做三轮检查点与日志切换后，`pg_wal` 中不再含旧明文。仍需知道：

- **0039 之前的所有备份仍含明文**：6.3 的旧库备份、6.4 之前旧 Supabase 的自动备份、4.11 演练用的备份。按 6.3 规定加密保管并到期销毁；旧 Supabase 项目在 10.3 删除。
- 已删除文件占用过的磁盘块在被覆盖前理论上仍可能残留，这与普通删除文件相同；云盘快照必须在本步之后才开始（4.1 第 4 项）。
- 数据库以外也有明文：随访链接的链接码在网址路径 `/p/<链接码>` 中，现网站 Nginx 的访问日志会原样记录。0039 不改变这一点。建议另行在 Nginx 日志格式中把 `/p/` 之后的部分替换为固定文字（例如用 `map $request_uri` 生成脱敏后的路径再写日志），并限制历史访问日志的读取权限、按日志保留期删除。该修改涉及发布工具的哨兵文件，须在 6.15 捕获之前或另一个变更窗口进行。

### 6.10 数据库时区改为 Asia/Shanghai（写入）

0038 的随访视图用 `current_date` 计算“距上次随访天数”“逾期/即将到期”和“近 30 天随访数”，录入时的“日期不能晚于今天”也用 `current_date`。数据库默认 UTC 时，北京时间 0–8 点之间的“今天”会被当作昨天，当天日期会被判为未来日期。

```bash
docker compose -f /opt/registry-supabase/docker-compose.yml exec -T -e PGPASSWORD=$PGPASSWORD db \
  psql -h 127.0.0.1 -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 -f - <<'SQL'
ALTER DATABASE postgres SET timezone TO 'Asia/Shanghai';
SELECT r.rolname, d.datname, s.setconfig FROM pg_db_role_setting s
  LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase;
SQL
cd /opt/registry-supabase && docker compose restart rest auth storage
docker compose exec -T -e PGPASSWORD=$PGPASSWORD db psql -h 127.0.0.1 -U postgres -d postgres -X -t -A -c "SHOW TimeZone"
# 预期：Asia/Shanghai；pg_db_role_setting 中没有角色级的 TimeZone 覆盖（如有，评估后移除）
```

不受影响的部分：`snapshot.sql` 和发布核验 SQL 都在事务内固定 `TimeZone='UTC'`，指纹和契约不变（演练已核对）；已经生成的冻结数据版本保存的是当时的正文，SHA-256 不变。此后新生成的冻结数据版本中的时间戳以 `+08:00` 表示。

### 6.11 上传附件并核对（写入）

```bash
cd /root/cn-migration/storage
. /root/cn-migration/keys.env                              # 新环境 SERVICE_ROLE_KEY
NEW_URL=http://<新ECS内网IP>:8000                           # 或 https://api.kidneysphereregistry.cn
while IFS=$'\t' read -r bucket name mime; do
  enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")
  curl -fsS -X POST -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H "Content-Type: $mime" -H "x-upsert: false" --data-binary "@old/$bucket/$name" \
    "$NEW_URL/storage/v1/object/$bucket/$enc" > /dev/null || echo "FAILED $bucket/$name"
done < objects.tsv
while IFS=$'\t' read -r bucket name mime; do
  enc=$(python3 -I -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")
  mkdir -p "new/$bucket/$(dirname "$name")"
  curl -fsS -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    "$NEW_URL/storage/v1/object/authenticated/$bucket/$enc" -o "new/$bucket/$name" || echo "FAILED $bucket/$name"
done < objects.tsv
(cd new && find . -type f -exec sha256sum {} + | sort -k2) > sha256-new.txt
diff sha256-old.txt sha256-new.txt && echo "附件逐个一致"
```

预期：没有 `FAILED`，`diff` 无输出。对象名（例如付款凭证路径 `<用户id>/<订单id>/<时间戳>.<扩展名>`）与旧库完全相同，`billing_payment_proofs.file_url` 的引用因此保持有效。对象的内部编号、上传者字段和上传时间会改变，付款凭证的访问策略按路径判断，不受影响。

### 6.12 升级核对（只读）

```bash
cd /root/cn-migration
docker compose -f /opt/registry-supabase/docker-compose.yml exec -T -e PGPASSWORD=$PGPASSWORD db \
  psql -h 127.0.0.1 -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 -f - \
  < $REPO/docs/cn-migration/snapshot.sql > snapshot-S3-new-upgraded.json
python3 -I $REPO/docs/cn-migration/compare_snapshots.py --phase upgrade snapshot-S1-old-after-backup.json snapshot-S3-new-upgraded.json
```

预期：`结论（upgrade）：一致`——关键表行数、账号登录指纹、随访链接摘要指纹（旧库由明文计算、新库直接读摘要）、附件清单（桶/名称/大小/类型）均与旧库一致；明文随访链接 0 行；版本登记含 0032–0040。

补充只读检查：

```sql
SELECT consent_status, count(*) FROM public.patients_baseline GROUP BY 1;             -- 全部 unconfirmed
SELECT count(*) FROM public.patients_baseline WHERE consent_research IS NOT NULL;      -- 0
SELECT policyname FROM pg_policies WHERE schemaname = 'storage' ORDER BY 1;           -- 含 payment_proofs_delete_own/insert_own/select_own
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public','registry_private') AND p.prokind = 'f'
   AND pg_get_functiondef(p.oid) ~ '\m(digest|gen_random_bytes|crypt|gen_salt|hmac)\s*\(';  -- 0 行：不再依赖 pgcrypto
SELECT count(*) FILTER (WHERE content_sha256 <> encode(sha256(convert_to(content_text,'UTF8')),'hex')) AS mismatched,
       count(*) AS total FROM registry_private.export_contents;                           -- mismatched = 0
```

### 6.13 发布核验报告

需要第 9 节的工具适配已经审查合并，并已生成新的发布包（发布身份、`config_sha256`、项目身份都对应新环境）。

实际采用的方式（见附录 C）：在**数据库所在主机**上运行核验工具。工具通过 `docker exec` 在数据库容器内用本地套接字执行审查过的只读预检，不需要数据库密码，也不开放 5432；身份由 PostgreSQL 的 `system_identifier`（预检前后各核对一次，须等于发布工具中固定的值）确认。报告不含秘密，复制到网站服务器供发布工具使用（24 小时内有效）。

```bash
cd <已核对哈希的发布提交目录>
python3 -I scripts/capture_registry_database.py --sql registry-<版本>.database-preflight.sql --output /root/cn-migration/db-preflight.json
# 复制到网站服务器：/root/db-preflight.json（权限 600）
```

预期：报告中全部检查为 `true`（包括 `0038_followup_workflow`、`0039_patient_token_hashing`、`0040_batch_import`、`followup_views`、`token_hash_only`、`token_revoke_by_id` 等），数据库主版本 17，版本登记为 0032–0040，目录契约与审查过的某一完整版本一致。不一致时不要发布前端；对差异逐项分析（例如旧库里控制台手工建过的对象），按 `docs/REGISTRY_INTEGRATED_RELEASE.md` 的原则处理，不能删减报告内容绕过。

### 6.14 Nginx 与 config.js（写入）

发布工具在“捕获”和“发布”之间会核对 `config.js` 与 Nginx 哨兵文件没有变化，所以这一步必须在 6.15 的捕获之前完成。

```bash
cd /var/www/kidneysphere-registry
cp -p config.js /root/cn-migration/config.js.us-west-2.bak && sha256sum /root/cn-migration/config.js.us-west-2.bak
# config.js.new 必须与已审查的新版仓库 site/config.js 逐字节相同（发布清单记录了它的 SHA-256）
install -m "$(stat -c %a config.js)" -o "$(stat -c %U config.js)" -g "$(stat -c %G config.js)" /root/cn-migration/config.js.new config.js
sha256sum config.js                                   # 预期等于新发布清单中的 config_sha256
python3 -I $REPO/scripts/check_external_hosts.py --site /var/www/kidneysphere-registry --require-domestic-db
# 预期：退出码 0；数据库主机 api.kidneysphereregistry.cn 在允许清单内；没有违规
grep -nE 'supabase|plausible|jsdelivr' /etc/nginx/nginx.conf /etc/nginx/conf.d/kidneysphereregistry.conf
# 如有 Content-Security-Policy 等引用旧主机：把 connect-src、img-src 改为 'self' https://api.kidneysphereregistry.cn
# 并删除 plausible.io、*.supabase.co、cdn.jsdelivr.net；nginx -t && systemctl reload nginx
```

`config.js.new` 按 `docs/cn-migration/config.example.js` 编写：`SUPABASE_URL`、`SUPABASE_ANON_KEY`、两张收款码地址改为新环境；`FEATURES.GENETICS` 与 `FEATURES.ANALYTICS` 显式为 `false`。两个开关在代码中的缺省值都是关闭（只有严格等于 `true` 才开启）：

- `GENETICS`：基因变异模块。迁移完成且人类遗传资源合规评估（11.4）完成之前保持关闭。
- `ANALYTICS`：页面访问统计。保持关闭。开启前必须改用境内自托管的统计服务（`ANALYTICS_SRC` 指向境内主机），并先更新隐私政策；未设置 `ANALYTICS_SRC` 时代码会请求境外 `plausible.io`，检查器会判为违规。

### 6.15 发布新版前端

按 `docs/REGISTRY_INTEGRATED_RELEASE.md` 执行（维护页仍开启，运维出口可访问）：

```bash
python3 /root/registry-<新版本>.pyz                 # 只读检查
python3 /root/registry-<新版本>.pyz --capture
python3 /root/registry-<新版本>.pyz --apply \
  --capture-dir /root/registry-integrated-releases/capture-<实际目录> --db-report /root/db-preflight.json
```

预期：发布成功，无哨兵或配置变化报错。

### 6.16 功能验证（维护页开启，仅运维出口访问）

见第 7 节第 13–24 项，全部通过后进入 6.17。

### 6.17 关闭维护页并通知

```bash
rm /etc/nginx/registry-maintenance/on.conf
# 同时删除 /etc/nginx/conf.d/registry-api.conf 中的 allow/deny 两行，使浏览器可以访问新接口
nginx -t && systemctl reload nginx
shred -u "$DUMP"                                   # 明文备份；加密副本按 6.3 规定保管
find /root/cn-migration/storage/old /root/cn-migration/storage/new -type f -exec shred -u {} +   # 附件明文副本
unset PGPASSWORD OLD_DB_URL OLD_KEY
```

通知用户迁移完成；请两三位实际用户登录确认；观察期开始。把 `/root/cn-migration/` 中的快照、比较输出、清单签字页归档（不含备份文件）。

## 7. 验证清单（命令与预期结果汇总）

| # | 时机 | 验证内容 | 方法 | 预期 |
|---|---|---|---|---|
| 1 | 4.9 | 新环境服务与角色 | `docker compose ps`；健康检查；角色查询 | 五个服务运行；8 个角色存在；`public` 为空 |
| 2 | 4.11 | 全流程演练 | 第 6 节完整执行 | 全部步骤通过，记录耗时 |
| 3 | 6.1 | 维护页 | `curl` 站点与随访链接 | 503（运维出口除外） |
| 4 | 6.3 | 备份完整 | `pg_dump` 退出码；`toc.txt` | 无错误；6 张关键表有数据段 |
| 5 | 6.4 | 附件下载 | `objects.tsv` 与 `sha256-old.txt` 行数 | 相等，无 FAILED |
| 6 | 6.5 | 冻结期间无写入 | `compare_snapshots.py --phase freeze` | 一致 |
| 7 | 6.7 | 恢复逐表一致 | `--phase restore` | 全部业务表行数与内容指纹、账号登录指纹、随访链接摘要指纹一致；认证/存储版本不低于旧环境 |
| 8 | 6.8 | 增量迁移 | 逐文件执行 | 0032–0040 全部成功 |
| 9 | 6.9 | 明文清除 | 表文件路径变化；`grep` 测试链接 | 路径不同；0 个文件命中 |
| 10 | 6.10 | 时区 | `SHOW TimeZone` | Asia/Shanghai |
| 11 | 6.11 | 附件逐个一致 | `diff sha256-old.txt sha256-new.txt` | 无输出 |
| 12 | 6.12 | 升级后计数与指纹 | `--phase upgrade`；补充 SQL | 一致；明文 0；同意状态全部未确认；无 pgcrypto 调用；冻结数据版本校验不一致数 0 |
| 13 | 6.13 | 发布核验 | `capture_registry_database.py` 报告 | 全部检查 `true`，契约匹配 |
| 14 | 6.14 | 境外依赖 | `check_external_hosts.py --require-domestic-db` | 退出码 0 |
| 15 | 6.16 | 浏览器实际请求 | 开发者工具“网络”面板逐页查看首页、登录、工作台、随访页、付款页 | 只出现 `kidneysphereregistry.cn`、`api.kidneysphereregistry.cn`、`kidneysphere.com`（共享顶栏）；控制台无报错 |
| 16 | 6.16 | 原账号可登录 | 测试账号用旧密码登录；开放后请 2–3 位真实用户登录 | 成功（密码哈希已迁移） |
| 17 | 6.16 | 找回密码 | 测试账号发起找回密码 | 收到境内发信域名的中文邮件；链接经 `api.kidneysphereregistry.cn/auth/v1/verify` 回到 `/auth-callback`，可设置新密码 |
| 18 | 6.16 | 注册确认 | 新注册一个临时账号 | 收到确认邮件，确认后可登录（验证后删除该账号） |
| 19 | 6.16 | 患者旧链接 | 打开 5.4 记录的测试链接 `/p/<链接码>` | 显示患者随访页（研究名称等）；全部旧链接由第 12 项的摘要指纹一致性保证 |
| 20 | 6.16 | 链接管理 | 工作台为测试患者新建随访链接，再撤销 | 新链接可打开；撤销后提示失效 |
| 21 | 6.16 | 录入随访 | 测试项目录入一次随访，再录入同日随访 | 新增成功；同日重复有中文提示 |
| 22 | 6.16 | 冻结数据版本 SHA-256 可复现 | 测试项目创建冻结数据版本，下载 JSON 与 `_sha256.txt`，执行 `sha256sum -c registry_frozen_<编号>_sha256.txt`；稍后再次下载同一版本 | 校验 OK；两次下载 SHA-256 相同 |
| 23 | 6.16 | 附件 | 结算页显示两张收款码；测试账号上传凭证，平台管理员查看 | 图片正常；上传与查看成功 |
| 24 | 6.16 | 权限与暴露面 | 另一测试账号看不到测试项目；外网探测 5432/8000/8443/3000；`curl -H "apikey: <ANON_KEY>" https://api.kidneysphereregistry.cn/rest/v1/patients_baseline?select=id` | 看不到；端口不可达；返回 `[]` |
| 25 | 观察期每日 | 备份 | 检查当日备份文件、SHA-256、OSS 副本 | 存在且可解密 |
| 26 | T+7 前 | 恢复演练 | 最新备份恢复到临时容器，`--phase restore` 与线上快照比较 | 一致 |

抽样比对：除第 7、12 项的全表指纹外，请各项目负责人在工作台抽看 2–3 个研究编号的最近一次随访，与自己掌握的记录核对。

## 8. 回滚方案

| 阶段 | 判断 | 回滚操作 | 数据影响 |
|---|---|---|---|
| 6.1–6.13（前端与 `config.js` 未改） | 任一步失败且窗口内无法解决 | 删除维护开关文件并 reload Nginx；如在 6.1 设置了旧库只读，执行 `ALTER DATABASE postgres RESET default_transaction_read_only;`。新环境 `docker compose down` 后清空 `/data/postgres`、`/data/registry-storage`，备份按 6.3 规定保管 | 无。用户继续使用旧系统；另约窗口 |
| 6.14–6.16（已改 `config.js` 或已发布前端，尚未开放） | 功能验证不通过 | ① `python3 /root/registry-<新版本>.pyz --rollback /root/registry-integrated-releases/capture-<实际目录>`（恢复旧前端文件，不动配置）；② 恢复旧配置：`install -m <原权限> -o <原属主> -g <原属组> /root/cn-migration/config.js.us-west-2.bak /var/www/kidneysphere-registry/config.js`，核对 SHA-256 与 6.14 记录一致；③ Nginx 若改过 CSP，恢复原文件；④ 同上一行撤销旧库只读、关闭维护页 | 无。新环境中只有验证用的合成操作，随新环境一起清空 |
| 6.17 之后（已开放，观察期内） | 出现无法在线修复的严重问题 | 优先在新环境修复。确需回到旧环境时：重新开启维护页；从新环境导出开放以来新增或修改的记录（按 `created_at`/`updated_at` 与审计表），人工评估后在旧系统补录；再执行上一行的 ①–④ | 有损：0038–0040 之后的新字段（同意状态、随访状态、化验定性结果、用药剂量单位、事件判定依据等）在旧结构中无处存放；回到旧环境也意味着数据重新存放在境外。因此观察期内保持旧项目只读、不删除，但回滚只作为最后手段 |

前端发布工具的回退只恢复本次前端文件，不回退数据库，也不恢复 `config.js`（`docs/REGISTRY_INTEGRATED_RELEASE.md`）；以上步骤中的 `config.js` 恢复是单独操作。

## 9. 发布工具与代码需要的适配（不在本手册执行）

以下改动由集成/发布负责人在单独的审查提交中完成，完成后用 `scripts/refresh_release_manifest.py` 生成新的发布身份（新的 `VERSION`），再走正常审查与 `npm test`。

| 文件 | 位置 | 现状 | 需要的改动 |
|---|---|---|---|
| `scripts/capture_registry_database.py` | 第 13 行 `PROJECT_REF`；`connection_environment()`（约第 30–49 行） | 只接受 `db.etsyglgpiutflethgirs.supabase.co`，或 `*.pooler.supabase.com` 且用户为 `postgres.etsyglgpiutflethgirs` | 新的项目身份（例如 `ksr-aliyun-<地域>-1`）；主机规则改为精确匹配新数据库主机名（如 `db.registry.internal`）与用户 `postgres`；保留 `verify-full` TLS、清除继承的 `PG*` 变量、只读事务、只接受审查过的预检 SQL 等全部现有约束。可选加强：在预检 SQL 中输出 `pg_control_system()` 的 `system_identifier` 并在工具中固定比对，因为自托管主机名不像 Supabase 项目编号那样全局唯一 |
| `scripts/registry_integrated_release.py` | 第 19 行 `PROJECT_REF` | `etsyglgpiutflethgirs`，`load_bundle()` 与 `verify_db()` 都比对它 | 与上一行相同的新身份。`TARGET`（第 17 行）、`SENTINELS`（第 29 行）在网页仍由同一台 ECS 提供时不变；如 Nginx 改到新 ECS，需要相应调整 |
| `scripts/refresh_release_manifest.py` | 第 98–108 行 `manifest.update(...)` | `project_ref` 从上一版清单原样继承，不读取 `release.PROJECT_REF` | 增加 `'project_ref': release.PROJECT_REF`，否则改了常量后新清单仍是旧身份 |
| `site/config.js`（仓库副本） | 全文 | 旧 Supabase 地址与密钥 | 与服务器新 `config.js` 逐字节一致，使发布清单中的 `config_sha256` 与服务器相符（发布工具不覆盖、只校验此文件） |
| `tests/pg17-preflight.mjs` | 第 18 行 | `report.project_ref='etsyglgpiutflethgirs'` | 改为新身份 |
| `docs/REGISTRY_*.md` | 提到 `etsyglgpiutflethgirs` 与 Supabase SQL Editor 的段落 | 旧环境说明 | 迁移完成后更新为新环境的核验方式 |
| `site/` 中描述数据存放位置的页面 | 见 11.6 | 写的是 Supabase/境外 | 迁移完成后更新 |

数据库名必须保持 `postgres`（`verify_db()` 要求报告中 `database == 'postgres'`）；迁移文件以 `postgres` 用户执行，使对象属主与审查契约一致。

## 10. 上线后

### 10.1 备份与恢复演练

按 4.10 启用每日备份、快照、OSS 同步与每月恢复演练。恢复演练记录（日期、备份文件、比较结论、耗时）保存为等保与机构审查的证据。机构要求的 RPO（可接受数据损失时间）和 RTO（恢复服务时间）由机构与运维方书面确定后，再调整备份频率。

### 10.2 观察期清理（T+7 验收后）

- 删除“迁移验证（合成）”项目、测试患者、测试链接、临时注册的账号和测试付款凭证（工作台或运维 SQL，留记录）。
- 新 ECS 安全组收紧出方向（不再需要访问旧 Supabase）。
- 撤销迁移期间使用的旧 Supabase 数据库密码与服务密钥在运维终端中的残留（`unset`，删除临时文件）。
- 各项目负责人开始在工作台补录知情同意状态（0038 后全部为“未确认”）。

### 10.3 下线旧 Supabase 项目（T+30，确认无回滚需要后）

1. 验收人与运营方书面确认不再需要回滚。
2. 在旧控制台查看近 30 天的接口与数据库访问，确认没有来自正式站点的流量（如有，查明来源）。
3. 再做一次只读快照存档（可选，用于删除记录）。
4. 轮换旧项目的 API 密钥与数据库密码，切断任何残留访问。
5. 删除存储桶中的全部文件，然后删除项目（项目设置中的删除操作）；向 Supabase 书面询问其备份副本的删除时限并保存答复。
6. 取消付费计划，移除组织成员。
7. 填写删除记录并与合规材料一起保存：

```
旧环境删除记录
项目编号：etsyglgpiutflethgirs        区域：us-west-2（美国西部）
数据范围：登记数据库（public/auth/storage）、附件存储、平台自动备份
迁移完成日期：            删除操作日期：            操作人 / 复核人：
删除前最后快照文件及 SHA-256：
控制台删除确认截图：              Supabase 关于备份删除时限的答复：
境内保留的迁移备份（加密）位置、保管人、计划销毁日期：
```

## 11. 合规清单

以下为需要运营方、研究机构和法务决定的事项及建议的准备材料，本手册不作法律结论。

### 11.1 既往数据存储在境外的处置

事实：迁移前，账户信息（邮箱、密码哈希）、登记数据（研究编号下的临床随访数据，属于医疗健康信息）、随访链接、付款凭证存放于 Supabase 云服务的美国西部区域。现行隐私政策（`privacy.html` v2.0）写明使用 Supabase 云服务并“不作数据不出境的声明”。

建议由法务评估并决定：

1. 整理事实材料：起止时间、涉及的个人信息类别与人数（账号数、研究参与者人数）、是否含敏感个人信息、接收方（Supabase 及其云基础设施）与所在地、当时的告知与同意情况、各机构的伦理批件与数据管理承诺中对存储地点的表述。
2. 对照《个人信息保护法》关于向境外提供个人信息、个人信息保护影响评估、委托处理的规定，以及数据出境安全评估、个人信息出境标准合同、《促进和规范数据跨境流动规定》等文件，判断既往情况应如何处理（例如补充评估记录、是否需要向机构和研究参与者说明）。
3. 向使用本平台的研究机构/项目负责人书面说明迁移情况与时间，由机构判断是否需要告知伦理委员会或研究参与者。
4. 保存迁移完成与旧环境删除的证明（10.3 的删除记录），作为数据已不再存放境外的依据。

### 11.2 网络安全等级保护

- 迁移后系统边界发生变化（新增数据库服务器、认证与存储服务）。如尚未定级备案，结合定级指南确定等级（研究医疗数据系统可能为第二级或第三级，由运营方与测评机构确定），按《信息安全等级保护管理办法》在定级后向所在地公安机关备案；已备案的，按变更办理。
- 需要落实并留存证据的方面：主机安全加固与漏洞修补、数据库与操作审计日志、网络与登录日志保存不少于 6 个月（《网络安全法》第二十一条）、备份与恢复演练记录、账号与权限管理、安全事件应急预案。
- 方案 A 中数据库层的审计可用 PostgreSQL 的 pgaudit 扩展（Supabase 镜像自带，启用前评估日志量）或连接与语句日志；日志同步到境内日志服务。

### 11.3 ICP 备案与公安联网备案

- 已具备：`kidneysphereregistry.cn` 的 ICP 备案（沪ICP备2026008040号-1）与公安联网备案（鲁公网安备37091102000922号）。
- `api.kidneysphereregistry.cn` 属于已备案域名的子域。按 2.5 的拓扑，对外仍由现网站 ECS 提供服务，接入信息不变；若改为新 ECS 公网 IP 对外，向阿里云备案系统确认接入信息是否需要变更。
- 核对公安联网备案登记的网站服务信息是否需要更新。

### 11.4 人类遗传资源

- 迁移前基因变异记录为 0 条。基因模块在迁移完成且评估完成前保持关闭（`FEATURES.GENETICS` 不设为 `true`；代码缺省关闭）。
- 开启前由研究方与机构对照《人类遗传资源管理条例》及其实施细则评估：采集、保藏、利用、对外提供人类遗传资源信息的适用要求，是否涉及外方单位，信息备份与报告义务。评估结论和批准文件存档后再开启。

### 11.5 数据处理协议（模板需求）

需要法务起草一份平台与研究机构之间的数据处理协议模板，至少写明：处理目的、方式、期限与数据种类；数据存放地点（中国境内，阿里云地域）；受托方使用的服务商清单（阿里云 ECS/OSS/邮件推送等）及转委托规则；安全措施（权限、审计、加密、备份）；个人信息安全事件的通知时限与配合；机构的审计/检查权利；协议终止后的数据返还与删除（含备份与冻结数据版本）；人员保密义务；基因数据另行约定。`privacy.html` 的“研究机构与平台的责任”已提到项目启动前应签订此类协议。

### 11.6 迁移完成后需要更新的页面文字

行号以基线 749bb5d 为准；并行修改（统一术语与如实说明的文案改动）合入后行号可能变化，按“定位文字”查找。

| 文件 | 位置（基线行号） | 定位文字 | 需要更新的内容 |
|---|---|---|---|
| `site/privacy.html` | 第 23 行 | “版本：v2.0 · 本次更新” | 版本号与更新日期 |
| `site/privacy.html` | 第 43–44 行 | “2.5 自动收集的信息”“Plausible Analytics” | 不使用第三方访问统计；服务器日志的存放地点（阿里云境内）与保存期限 |
| `site/privacy.html` | 第 51 行 | “改善产品体验（基于匿名统计数据）” | 与实际一致（不再有统计数据时删去或改写） |
| `site/privacy.html` | 第 55–56 行 | “四、信息存储与安全”“使用配置的 Supabase 项目” | 认证、数据库、附件、备份均位于阿里云（写明地域）；备份频率与保留期按 10.1 的实际配置；随访链接只存摘要 |
| `site/privacy.html` | 第 62 行 | “五、信息共享”第二项“提供账户认证、数据库和附件存储的 Supabase” | 受托服务商改为阿里云（ECS、OSS、邮件推送等）；删去 Supabase |
| `site/privacy.html` | 第 66–67 行 | “六、数据跨境传输” | 如实写明：某日前数据存放于美国（Supabase us-west-2），某日迁至境内，旧环境于某日删除；此后不再向境外提供（以实际情况为准） |
| `site/privacy.html` | 第 80–81 行 | “八、数据保留” | 增加备份保留期与迁移备份的销毁安排 |
| `site/security.html` | 第 34 行 | “数据库、附件与备份所在区域及恢复能力” | 写明实际区域与备份/恢复演练安排 |
| `site/deployment.html` | 第 26 行 | “账户认证、数据库和附件使用 Supabase 项目” | 改为境内部署说明 |
| `site/slides.html` | 第 456 行 | “数据存在哪里？” | 同上 |
| `site/staff.html` | 第 215 行 | “数据存储说明：…科研数据库另由 Supabase 服务提供” | 同上 |
| `site/guide.html` | 第 51 行 | “网站前端在阿里云不等于数据库…均在境内” | 迁移后改为实际情况 |
| `site/terms.html`、`site/index.html`、`site/user-manual-cn.html` | 并行文案修改中新增的“计划迁移至境内”“登记数据库目前使用境外云服务”等句子 | “境外”“迁移” | 迁移完成后改为已完成的表述 |

更新这些页面属于前端改动，需要走正常审查与发布流程；隐私政策的实质变更按其“十、政策更新”的约定通知用户。

## 附录 A：境外依赖检查器

`scripts/check_external_hosts.py` 只做静态文本分析，不联网。

```bash
python3 -I scripts/check_external_hosts.py                          # 检查仓库 site/
python3 -I scripts/check_external_hosts.py --site /var/www/kidneysphere-registry --require-domestic-db
python3 -I scripts/check_external_hosts.py --json                   # 机器可读输出
python3 -I -m unittest discover -s tests -p test_external_hosts.py   # 规则测试
```

规则：

- 允许清单：`kidneysphere.com` 及其子域、`kidneysphereregistry.cn` 及其子域、`beian.miit.gov.cn`、`beian.mps.gov.cn`、`www.cac.gov.cn`。`--allow-host` 可临时追加（精确匹配）。
- 违规（退出码 1）：浏览器会自动请求的非允许主机——`<script src>`、`<link rel=stylesheet/icon/preload…>`、`<img src/srcset>`、`<iframe>`、`<form action>`、CSS `url()`/`@import`、`fetch`/`XMLHttpRequest`、JS 字符串中的完整网址（静态分析无法确认用途，一律按可能请求处理，除非位于 `<a href>` 片段或页面跳转语句中）。
- 仅链接：只出现在 `<a href>`、`<link rel=canonical/alternate>`、`<meta>`、JSON-LD、页面文字或页面跳转中的主机。
- 第三方库：`site/lib/vendor/` 只做静态查找，字符串中的文档链接列为“第三方库字符串”；出现在 `fetch(`、`import(`、`.src=` 等请求写法中则判违规。
- 受开关保护：`plausible.io` 只在 `analytics.js` 中，且代码（不含注释）读取 `CONFIG.FEATURES.ANALYTICS`（`window.CONFIG?.FEATURES?.ANALYTICS`、`c.FEATURES` + `.ANALYTICS === true` 等写法）且缺省不为开启时放行；`config.js` 打开该开关而 `ANALYTICS_SRC` 不是允许主机时判违规。
- `config.js` 单独报告：数据库主机为 `*.supabase.co` 时输出警告“数据库仍在境外”，收款码等地址仍指向 Supabase 时输出“仍指向境外存储”；数据库主机不在允许清单时输出“无法确认位于境内”（人工核实后可用 `--domestic-db-host <主机>` 确认）；`--require-domestic-db` 时这些都判违规。`FEATURES.GENETICS` 为 `true` 时输出警告。
- 退出码：0 无违规；1 有违规；2 参数或读取错误。

基线 749bb5d 的检查结果：违规 1 处——`analytics.js` 无条件加载 `plausible.io`（为统计加开关的前端改动合入后，该处变为“受开关保护”，退出码为 0）；数据库与两张收款码仍在境外（警告）；`escholarship.org` 仅链接；`lib/vendor` 中的 `github.com` 等为库内字符串。迁移完成后在服务器目录上加 `--require-domestic-db` 运行，预期退出码 0。

## 附录 C：2026-10-17 实际执行记录与差异

本节记录真实迁移中与上文不同的做法，后续维护以本节为准。

**拓扑。** 数据库、认证、接口、存储运行在新 ECS `i-uf68fhsuuawzs5ve1lrv`（上海 g 区，内网 `172.24.34.36`），自托管目录 `/data/registry-supabase`。网站仍在原 ECS（内网 `172.24.33.51`），与新 ECS 同一专有网络。不新增 `api.` 子域：浏览器访问 `https://kidneysphereregistry.cn/sb/`，由原 ECS 的 Nginx 经内网转发到 `172.24.34.36:8000`（配置见 `docs/cn-migration/nginx-registry-sb.conf`）。新 ECS 安全组只允许 `172.24.33.51/32` 访问 8000，网关只绑定本机与该内网地址。

**compose 必须带四个文件。** 任何 `docker compose` 命令都写成：

```bash
cd /data/registry-supabase
docker compose -f docker-compose.yml -f docker-compose.loopback.yml \
  -f docker-compose.versions.yml -f docker-compose.prod.yml --env-file .env <命令>
```

`docker-compose.versions.yml` 把认证固定为 `gotrue@sha256:1736a630…`（v2.197.0）、存储固定为 `storage-api@sha256:ec2ad414…`（v1.82.1）；只用前两个文件会退回旧版本（v2.196.0 / v1.74.0），低于旧 Supabase 已执行的认证/存储迁移。`docker-compose.prod.yml` 设置网关端口（本机 + 内网地址）并只让认证服务接入可出网的网络（发信用）；其余服务仍在封闭网络。

**认证配置（`.env`）。** `SITE_URL=https://kidneysphereregistry.cn`；`ADDITIONAL_REDIRECT_URLS=https://kidneysphereregistry.cn/**`；`API_EXTERNAL_URL=https://kidneysphereregistry.cn/sb/auth/v1`；四个 `MAILER_URLPATHS_*=/sb/auth/v1/verify`；发信 `smtp.qiye.aliyun.com:465`，发件人 `china@kidneysphere.com`。修改前的副本为 `.env.bak-20261017-preprod`。

**备份方式。** 旧库备份在新 ECS 上用 Supabase PG17 镜像内的 `pg_dump` 经 Session pooler（`verify-full`，Supabase Root 2021 CA）完成；附件清单从备份中读取，附件以新格式 `sb_secret_…` 服务密钥下载。

**核对结果。** 备份前后冻结快照一致；恢复（restore）比对一致；0032–0040 全部成功；明文链接码在数据目录命中 0（含 `pg_statistic`）；时区 Asia/Shanghai；4 个附件 SHA-256 逐个一致；升级（upgrade）比对一致；发布预检全部检查为真、目录契约匹配 `historical_crlf`（旧库函数源码为 CRLF 换行）。数据库 `system_identifier` 为 `7697419573917356067`。

**切换（2026-10-17 10:40 前后，北京时间）。** 原网站服务器按 `nginx-registry-sb.conf` 加入 `/sb/` 转发并更新 CSP，替换 `config.js`，用发布包（提交 f1bd5b7）发布前端；回退命令保存在 `/root/cn-cutover/pre-cutover-2/ROLLBACK.txt`。两点经验：① `systemctl reload nginx` 后要等新配置生效再测，且必须按返回内容核对——旧配置下 `/sb/...` 会落到首页兜底返回 200，造成假通过；② 精确路由页面（`/staff` 等）原无缓存头，浏览器沿用旧 HTML 导致登录后无反应，已在 server 块加 `add_header Cache-Control "no-cache" always;`。线上 `signup.html` 是 9 月 24 日单独部署的修复版（81edb4c1…），已登记为发布基线后覆盖。

**仍保留、待按 6.3 处理的文件。** 明文备份与附件副本在 `/root/cn-migration/`（仅 root 可读）；合成演练数据目录 `volumes/db/data.synthetic-20261014`；隔离恢复目录 `/data/registry-isolated-restore/…`。观察期结束后加密保管或销毁并记录。

### C.1 后续增量 0041（随访看板：提醒起算日、批量确认知情同意）

生产库已按上文完成 0032–0040。0041 只新增一列（`patients_baseline.followup_start_date`，现有患者全部为空）、一张私有标记表、一个检查触发器、两个函数（`set_followup_start_date`、`set_consent_bulk`）并替换看板视图 `v_patient_followup_status`（末尾加一列；未设置提醒起算日的患者计算结果不变）。不改任何已有数据，可重复执行（再次执行无变化）；未登记 0040 时会中止并整体回滚。

**顺序：先在生产库执行 0041，确认成功后再发布新版前端。** 新前端读取看板视图的新列并调用新函数；数据库未升级时，看板的批量操作会报“数据库尚未升级”。反过来，先升级数据库、暂不发布前端没有影响（旧前端不使用新对象）。

在数据库主机上（新 ECS，目录 `/data/registry-supabase`），与 0032–0040 相同：以 `postgres` 用户、经 `docker exec` 在数据库容器内执行，遇错即停：

```bash
cd "$REPO" && python3 -I -c "
import hashlib, json
m = next(x for x in json.load(open('supabase/migration-manifest.json'))['migrations'] if x['file'] == '0041_followup_board.sql')
ok = hashlib.sha256(open('supabase/migrations/' + m['file'], 'rb').read()).hexdigest() == m['sha256']
print(m['file'], 'OK' if ok else 'MISMATCH')"
# 预期：0041_followup_board.sql OK

docker exec -i supabase-db psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - \
  < supabase/migrations/0041_followup_board.sql
docker exec -i supabase-db psql -U postgres -d postgres -X -t -A \
  -c "SELECT version FROM public.registry_schema_versions WHERE version='0041_followup_board'"
# 预期：0041_followup_board
```

然后按 6.12 重新生成只读预检报告（报告中 `0041_followup_board`、`followup_board_signatures`、`followup_start_column` 均须为 `true`，目录契约须与审查过的版本一致），再用发布工具发布前端。0041 失败时整体回滚、生产数据不变：保存错误输出，不要发布新前端。

使用提示：历史补录的患者在看板中勾选后点“设置提醒起算日”（默认今天），之后按“提醒起算日与最近一次随访中较晚的一天 + 随访间隔”计算下次随访；可随时改为其他日期或清除。“批量确认知情同意”按纸质同意书等原始记录登记，须填写依据，每位患者的修改与单个患者“研究状态”中的修改规则相同并逐字段留痕。

## 附录 B：常见问题

- **用户要重新设置密码吗？** 不需要。密码哈希随账号一起迁移；因为新环境使用新的签名密钥和接口地址，原来的登录状态失效，用户重新登录一次即可。
- **已经发出去的随访链接还能用吗？** 能。链接地址仍是 `https://kidneysphereregistry.cn/p/<链接码>`；0039 把库里的明文换成 SHA-256 摘要，患者打开链接时用同样算法比对。已过期或已撤销的链接仍然无效。
- **为什么不把登录会话也迁过去？** 会话依赖旧签名密钥，迁过去也无法使用，反而多存一份凭据。
- **新环境的认证服务版本比旧环境低怎么办？** 不能继续。认证与存储服务的库表迁移只能向前，必须换用不低于旧环境的版本（4.2），并重新演练。
- **能不能用管理界面（Studio）？** 可以只在本机或运维通道内使用，不对公网开放；生产数据的修改仍应通过工作台或经审查的 SQL，并留记录。
- **以后还会访问境外吗？** 运行时不应有。每次发布前运行附录 A 的检查器；页面访问统计保持关闭；镜像只从境内 ACR 拉取。
