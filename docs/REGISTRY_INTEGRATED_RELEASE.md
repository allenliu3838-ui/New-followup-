> 当前可用构建和测试命令以 [REGISTRY_PG17_RELEASE.md](REGISTRY_PG17_RELEASE.md) 为准。下列旧开发构建链有部分源码未恢复；生产核验、备份与发布边界仍适用。旧 v1 包不适用于当前 PG17 发布校验。

# 登记系统整合修复发布说明

代码包分为数据库增量和前端整包。源码、测试或打包成功不表示生产数据库已经升级。当前没有 SSH 连接；服务器操作由有权限的运维人员在阿里云 Workbench 或受控终端执行。

## 唯一源码与迁移

生产前端以 `site/` 为准，已批准的科技首页和图片已归并。`previews/` 仅保存历史设计。旧两页离线包的固定内容移至 `releases/registry-university-20260913/`，原保护与哈希保持不变。

`supabase/migrations/` 是 SQL 唯一编辑入口，完整文件名决定顺序。保留历史重复数字前缀，不能直接切换成仅认数字版本的迁移工具。`python3 scripts/build_migration_bundle.py` 同步清单、两份完整 SQL 和六份兼容分批文件；`--check` 在副本过期时失败。

本次增量：0032 安全/数据约束、0033 注册/计费、0034 导入/更正、0035 冻结导出、0036 项目成员权限。先只读核对生产对象和历史迁移，再在隔离克隆中升级。不能向生产盲目重跑旧全量 SQL，也不能遇错继续。0025 的历史修正用于全新测试库；生产差异通过追加迁移解决。

0032 的八条复合外键采用 `NOT VALID`，会约束后续新增和变更，但不会证明历史孤儿记录已清理。契约如实记录该状态。生产数据核对与后续 `VALIDATE CONSTRAINT` 需要单独安排，验证状态变化后重新审查契约；不能把迁移通过写成“全部历史数据已验证”。

## 本地构建

```bash
npm ci --ignore-scripts
python3 -m pip install -r site/assets/template/requirements.txt
npm test
python3 scripts/build_migration_bundle.py
node scripts/build_database_contract.mjs
node scripts/build_vendor.mjs
python3 scripts/version_static_assets.py --check
python3 scripts/build_registry_integrated.py /安全目录/registry-integrated.pyz
```

构建器从审核旧提交读取历史文件哈希，按固定 allowlist 打包当前 `site/`，另生成 `.database-preflight.sql`、`.manifest.json` 和 `.database-migrations.zip`。最后一份包含增量 SQL、只读初始清点与复核工具、清单和说明，供人工审查；它不自动执行。所有输出文件必须不存在。

数据库契约来自严格执行全部迁移的隔离 PGlite。合成测试库的 auth/storage 表及基础角色权限由测试 harness 建立；不能假设它与实际 Supabase 项目完全相同。生产 public/registry_private 全部应用函数定义/EXECUTE 权限、触发器定义和启用状态、RLS 策略表达式、表权限及约束定义/验证状态必须与审查契约一致，扩展自带函数除外。托管 storage.objects 不比较表约束。额外旧重载、策略或其他应用对象也会使严格核验拒绝上线，需要对差异重新审查，不能删除报告字段绕过。目录查询固定 search_path，并对策略角色名排序，减少环境顺序引起的误差；不同 PostgreSQL 版本的目录格式差异仍要在隔离环境验证。

Supabase SDK 与 JSZip 锁版本、自托管并保留许可证，构建不接受外部 runtime import。共享顶栏和统计服务仍依赖指定外部域。数据地区须核对实际 registry 项目 `etsyglgpiutflethgirs`，不能以另一个项目的截图代替。

本地脚本、样式及模块依赖附带本次发布版本参数，避免新页面引用浏览器缓存中的旧模块。后续代码发布需同步更新该版本；HTML 缓存策略仍应由实际服务配置核验。

## 当前状态与备份

上传 `.pyz` 至 `/root`，用单独交付的 SHA-256 核验文件。先执行只读检查和当期捕获：

```bash
python3 /root/registry-integrated.pyz
python3 /root/registry-integrated.pyz --capture
```

无参数只检查已知文件哈希，不证明数据库完成。capture 在 `/root/registry-integrated-releases/capture-...` 私有目录保留原文件、权限、哈希、config 指纹及四个相邻网站/配置哨兵。备份在网站目录外。已有文件与审查基线不同会拒绝发布，必须比较差异后重新制包，无强制覆盖选项。

另运行 `scripts/check_five_sites.py --run-readonly-checks --output before.json` 保存五站公网入口状态。原有证书/服务故障单独记录；入口 200 不等于登录后业务已验证。哨兵路径缺失会记录为缺失，不能当成对应站点业务已检查。

## 数据库核验

1. 先在 Supabase SQL Editor 运行 `scripts/db/production_inventory.sql`，它可在旧 schema 上执行，只输出目录与数量。核对当前项目身份、schema、授权和规模，保存结果；取得数据库/Storage 可恢复备份并完成恢复演练。页面 capture 不包含数据库。已有脏数据或旧 schema 与源码不同，需要先在隔离克隆中查明。
2. 隔离库完成增量和角色、导入、更正、计费、冻结导出测试后，按生产实际差异在维护窗口执行增量，遇错停止。
3. 使用本包生成的只读 SQL 核验实际生产。它返回目录、权限、版本和计数，不返回患者字段值。

在装有 psql 的受控终端，将连接串只放在本地环境变量 `KSR_DATABASE_URL`，不要发到聊天或写入仓库。

```bash
python3 scripts/capture_registry_database.py \
  --sql registry-integrated.database-preflight.sql \
  --output db-preflight.json
```

此程序仅接受由同版本源码和迁移清单生成的精确预检 SQL，拒绝任意 SQL 或 psql 元命令；连接默认也强制只读。它从连接 hostname/池化用户名核对实际项目，执行 `BEGIN READ ONLY` 查询，生成私有报告。强制 verify-full TLS 校验服务端身份，清除继承的 PGHOSTADDR/PGSERVICE 等连接覆盖；需要专用 CA 时指定 --ssl-root-cert。仅核验 postgres 数据库。它不执行数据库升级。Supabase SQL Editor 也能查看 SQL 结果，但人工复制的 JSON 不会被当成程序已核验连接身份。

报告必须在 24 小时内，五个版本标记、函数签名、受限访问、RLS、函数定义/权限、策略表达式及触发器均与本包匹配。失败、缺失或项目不符会拒绝前端上线。该报告不替代备份、区域、伦理或真实业务验收。

## 前端发布与回退

数据库兼容后，将 `db-preflight.json` 上传 `/root`，使用刚捕获且未变化的目录：

```bash
python3 /root/registry-integrated.pyz --apply \
  --capture-dir /root/registry-integrated-releases/capture-实际目录 \
  --db-report /root/db-preflight.json
```

发布先验证所有前提，然后逐文件原子替换，脚本/资源先于 HTML。它不执行 SQL，不改 config.js/Nginx，不重启服务，不向其余四站写文件。多文件不构成一个事务，必须安排维护窗口，避免用户跨版本操作。失败尝试恢复本次文件，第三方修改会使恢复停止并保留备份。

回退命令：

```bash
python3 /root/registry-integrated.pyz --rollback /root/registry-integrated-releases/capture-实际目录
```

它恢复原文件、移除本次新增文件，预检后在每个恢复操作前重新核对哈希与文件身份；其他部署造成的变更会停止恢复。操作系统的多文件变更并非一个事务，部署锁也不能约束其他工具，维护窗口内应暂停其他发布。它不会回退数据库。旧前端未必兼容新数据库，发布前必须验证数据库新版本与回退前端的边界，必要时维持维护窗口并采用独立数据库恢复方案。前端回退不能宣称数据也已恢复。

## 发布后验收与配置

重新检查五站公网并与 before.json 比较，核对 registry 哈希/资源；实际注册、录入、撤销 token、导出与权限用明确授权的合成项目核验。不能上传真实病例作测试。

浏览器验收只在隔离环境运行，需显式设置 `E2E_ISOLATED=1`、`BASE_URL` 与 `E2E_DATABASE_ORIGIN`（隔离后端）。Playwright 拒绝已知生产域/IP；默认 npm test 只做离线测试。

`deploy/registry-security-headers.review.conf` 是 registry HTTPS server 的审查片段，不会被发布器安装。Nginx 设置要核对真实站点配置、资源和其他四站边界；Netlify TOML 不会自动作用于阿里云。

`netlify.toml` 的旧自动构建现在明确失败，防止 Git 推送绕过数据库门禁向另一环境发布。路由和安全头仅保留为历史参考。没有访问或修改 Netlify 账号设置；如需恢复自动发布，必须先接入相同数据库门禁并核验目标环境。

安全头脚本检查最终响应，缺失或异常返回失败；Lighthouse 未完成也返回失败。已过期的数据库报告、未完成的浏览器或恢复演练不能写成“全部验收通过”。
