# Sprint 1A 上线前联机验收 Runbook

> 状态定义：**Sprint 1A = Code Complete, Environment Verification Pending**  
> 范围限制：本 Runbook 仅覆盖 Sprint 1A（模板层 + 只读配置层）验收，不包含 Sprint 1B/2。

---

## 0. 验收环境约定（统一前置）

- 目标环境：staging Supabase（建议）或生产影子库。
- 前端部署：已部署包含 Sprint 1A 改动的 `/staff`。
- 验收账号：
  - `owner_user`：普通项目拥有者（authenticated）。
  - `readonly_user`：普通登录用户（非项目拥有者）。
  - `service_role`：仅用于 SQL 管理验证（不可用于前端行为结论）。
- 浏览器建议：Chrome 最新版。
- 所有步骤建议同时记录：时间、执行人、环境、截图/SQL 输出。

---

## 1) 新建 3 个模板项目（IGAN / LN / CKD_GENERAL）

### 前置条件

- migration 已执行完成（至少包含 `project_templates` / `template_fields` / `projects` 模板绑定字段）。
- `project_templates` 已有 3 个激活模板：`IGAN_CORE`、`LN_INDUCTION`、`CKD_GENERAL`。
- `owner_user` 可正常登录 `/staff`。

### 执行命令 / 操作步骤

1. 打开 `/staff/project-settings`（或 staff 中对应项目设置入口）。
2. 使用 `owner_user` 登录。
3. 依次创建 3 个项目：
   - 项目 A：module=IGAN，template=IGAN_CORE。
   - 项目 B：module=LN，template=LN_INDUCTION。
   - 项目 C：module=GENERAL/CKD 对应模块，template=CKD_GENERAL。
4. 在项目详情或项目列表中检查模板版本显示。
5. SQL 复核（SQL Editor 或 psql）：

```sql
select name, module, template_code, template_version
from public.projects
where name in ('S1A-IGAN', 'S1A-LN', 'S1A-CKD')
order by name;
```

### 预期结果

- 3 个项目均创建成功。
- 每个项目均写入正确 `template_code` + `template_version`。
- UI 能看到模板版本（不是空值）。

### 失败时怎么判断

- 创建时报错（如 template 不存在/校验失败）。
- 项目创建成功但 `template_code` 或 `template_version` 为 `NULL`。
- UI 未显示模板版本或显示与数据库不一致。

### 回滚 / 处理建议

- 删除错误测试项目后重建：

```sql
delete from public.projects where name in ('S1A-IGAN', 'S1A-LN', 'S1A-CKD');
```

- 核对模板 seed 是否缺失；必要时重跑 0020 migration（先在 staging）。
- 若仅前端显示异常，优先排查前端字段映射与缓存。

---

## 2) module/template 错配拦截

### 前置条件

- 存在 module 与 template 的绑定规则（前端校验或数据库约束/RPC 校验至少一层）。

### 执行命令 / 操作步骤

1. 前端尝试创建错配项目：
   - module=IGAN + template=LN_INDUCTION。
   - module=LN + template=CKD_GENERAL。
2. 记录前端提示。
3. SQL/API 旁路验证（可选，确认后端同样拦截）：

```sql
-- 仅示意：若允许直接 insert，尝试写入错配值
insert into public.projects(name, center_code, module, template_code, template_version)
values ('S1A-BAD-MAP', 'TEST01', 'IGAN', 'LN_INDUCTION', '1.0.0');
```

### 预期结果

- 前端不允许提交，或提交后被后端拒绝。
- 数据库最终不存在错配项目记录。

### 失败时怎么判断

- 错配项目被成功创建并持久化。
- 前端拦截但后端可被绕过写入。

### 回滚 / 处理建议

- 立即删除错配测试数据。
- 在后端增加强约束（推荐 DB 约束/触发器/RPC 校验优先于纯前端校验）。
- 补回归测试：正确匹配通过、错配拒绝。

---

## 3) 旧项目 LEGACY 兼容

### 前置条件

- 数据库中存在 Sprint 1A 前创建的旧项目（`template_code` 为空）。

### 执行命令 / 操作步骤

1. SQL 创建或确认旧项目样本：

```sql
insert into public.projects(name, center_code, module)
values ('S1A-LEGACY', 'TEST01', 'IGAN')
returning id, name, module, template_code, template_version;
```

2. 在 `/staff/project-settings` 与 `/staff/project-fields` 打开该项目。
3. 执行一次普通导出（CSV 或 paper pack）。
4. 查看导出 metadata 的模板绑定状态字段。

### 预期结果

- 旧项目可正常打开、编辑、导出。
- UI 显示 `LEGACY`/“未绑定模板”状态，而非报错。
- metadata 中存在 `template_binding_status=LEGACY`（或等价值）。

### 失败时怎么判断

- 打开旧项目时报空指针/页面崩溃。
- 导出失败，提示模板必填。
- metadata 缺失绑定状态字段。

### 回滚 / 处理建议

- 紧急策略：允许 legacy fallback（默认核心字段集合）。
- 对关键旧项目可人工补绑模板（需审计记录）。
- 在发布说明中明确 legacy 行为与迁移窗口。

---

## 4) 模板表 RLS 权限验证

### 前置条件

- `project_templates` 与 `template_fields` 已启用 RLS。
- 已定义“authenticated 只读”策略（SELECT 可用，写入受限）。

### 执行命令 / 操作步骤

> 建议在 Supabase SQL Editor 使用不同 role/JWT 模拟，或通过前端 + SQL 双验证。

1. 用普通登录用户（authenticated）从前端读取模板列表（应可见）。
2. 尝试前端或 API 写入模板（应被拒绝）。
3. SQL 检查策略：

```sql
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname='public'
  and tablename in ('project_templates','template_fields')
order by tablename, policyname;
```

4. SQL 检查 RLS 开关：

```sql
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('project_templates','template_fields');
```

### 预期结果

- authenticated 可 SELECT。
- authenticated 不可 INSERT/UPDATE/DELETE。
- 策略可在 `pg_policies` 中清晰看到。

### 失败时怎么判断

- 普通用户无法读取模板（策略过严）。
- 普通用户能写模板（策略过宽，严重问题）。

### 回滚 / 处理建议

- 先撤销过宽写策略（hotfix）。
- 仅保留 SELECT policy 给 authenticated。
- 模板写入统一走 migration/service_role。

---

## 5) 模板字段面板只显示 clinical core + template fields，不显示 system fields

### 前置条件

- `/staff/project-fields` 已接入字段面板。
- 已定义 system fields 列表（如 `id/project_id/created_at/updated_at/created_by/snapshot_id` 等）。

### 执行命令 / 操作步骤

1. 打开任一模板项目的 `/staff/project-fields`。
2. 观察字段分组：
   - clinical core（核心字段）
   - template fields（模板扩展字段）
3. 明确检查是否出现 system fields。
4. 用开发者工具/接口响应核对返回字段全集，确认 UI 过滤正确。

### 预期结果

- 仅显示 clinical core + template fields。
- system fields 在面板不可见，不可编辑。

### 失败时怎么判断

- 出现 `id`、`project_id`、时间戳、审计字段等系统字段。
- 核心字段缺失或被错误归类。

### 回滚 / 处理建议

- 前端增加 denylist + allowlist 双保险。
- 若后端返回过宽，增加只读视图供前端消费。
- 验收前冻结字段字典，避免热更新造成字段泄露。

---

## 6) 双迁移场景验证

### 6A 全新库跑 `run_all_migrations.sql`

#### 前置条件

- 新建空库（无业务数据）。

#### 执行命令 / 操作步骤

```bash
# 示例（本地 psql）
psql "$DATABASE_URL" -f supabase/run_all_migrations.sql
```

SQL 复核：

```sql
select to_regclass('public.project_templates') as project_templates,
       to_regclass('public.template_fields') as template_fields;

select template_code, template_version
from public.project_templates
order by template_code;
```

#### 预期结果

- 全量迁移成功，无中断。
- 模板表存在，3 个模板 seed 存在。

#### 失败时怎么判断

- `run_all_migrations.sql` 执行报错并中断。
- 表存在但 seed 缺失。

#### 回滚 / 处理建议

- 丢弃新库重建（全新库场景最干净）。
- 修复迁移顺序/幂等性后重跑。

---

### 6B 已有库跑 `0020_sprint1a_templates_readonly.sql`

#### 前置条件

- 库已运行旧版本（含历史项目与数据）。

#### 执行命令 / 操作步骤

```bash
psql "$DATABASE_URL" -f supabase/migrations/0020_sprint1a_templates_readonly.sql
```

SQL 复核：

```sql
-- 历史项目是否保留
select count(*) from public.projects;

-- 新增列是否已加
select column_name
from information_schema.columns
where table_schema='public' and table_name='projects'
  and column_name in ('template_code','template_version')
order by column_name;

-- 旧项目兼容状态抽样
select id, name, module, template_code, template_version
from public.projects
order by created_at desc
limit 20;
```

#### 预期结果

- 增量迁移成功，历史数据不丢失。
- 新列与新表可用。
- 旧项目保持可读可导出。

#### 失败时怎么判断

- 迁移因对象已存在/约束冲突失败。
- 迁移成功但历史项目出现不可读或导出异常。

#### 回滚 / 处理建议

- 先从备份恢复（生产建议先快照）。
- 编写补丁 migration 做幂等修复（`if exists/if not exists`）。
- 必要时分两步发布：先结构迁移，再前端开关。

---

## 发布门禁建议（Go/No-Go）

满足以下全部条件再上线：

- 6 项验收全部通过。
- 无 P0/P1 缺陷（RLS 越权、错配可写、旧项目不可用均为 P0/P1）。
- 已验证回滚路径可执行（至少在 staging 演练一次）。

