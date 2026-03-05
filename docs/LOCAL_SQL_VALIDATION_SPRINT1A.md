# Sprint 1A 离线 SQL / 本地验证说明（最小方案）

> 目标：在本地 PostgreSQL 或 staging Supabase 上，以最小步骤验证 Sprint 1A 的数据库与导出元数据行为。

---

## 1. 适用范围与准备

- 适用对象：研发、测试、运维。
- 验证对象：
  - migration 成功
  - RLS 生效
  - legacy 项目兼容
  - template 绑定写入正确
  - 导出 metadata 包含：`template_code` / `template_version` / `template_binding_status`
- 工具：`psql`（必需），可选 Supabase SQL Editor。

建议先准备环境变量：

```bash
export DATABASE_URL='postgresql://user:pass@host:5432/dbname'
```

---

## 2. Migration 成功验证

### 2.1 执行迁移

#### 场景 A：新库

```bash
psql "$DATABASE_URL" -f supabase/run_all_migrations.sql
```

#### 场景 B：已有库增量

```bash
psql "$DATABASE_URL" -f supabase/migrations/0020_sprint1a_templates_readonly.sql
```

### 2.2 验证结构与种子

```sql
-- 表是否存在
select to_regclass('public.project_templates') as project_templates,
       to_regclass('public.template_fields') as template_fields;

-- projects 是否有模板绑定字段
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='projects'
  and column_name in ('template_code','template_version')
order by column_name;

-- 3 个模板是否存在
select template_code, template_version, is_active
from public.project_templates
where template_code in ('IGAN_CORE','LN_INDUCTION','CKD_GENERAL')
order by template_code;
```

判定：3 条模板记录齐全 + `projects` 存在绑定字段 = migration 基本通过。

---

## 3. RLS 生效验证

### 3.1 检查策略与开关

```sql
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('project_templates','template_fields');

select tablename, policyname, cmd, roles
from pg_policies
where schemaname='public'
  and tablename in ('project_templates','template_fields')
order by tablename, policyname;
```

### 3.2 行为验证（推荐）

- 使用普通 authenticated 用户（非 service_role）做两类请求：
  1. SELECT `project_templates` / `template_fields`（应成功）
  2. INSERT/UPDATE/DELETE（应失败）

若你通过 SQL 模拟角色，请确保不是超级用户绕过 RLS。

判定：**可读不可写** 为通过。

---

## 4. Legacy 项目兼容验证

### 4.1 构造 legacy 项目（不绑定模板）

```sql
insert into public.projects(name, center_code, module)
values ('LOCAL-LEGACY-001', 'TEST01', 'IGAN')
returning id, name, module, template_code, template_version;
```

### 4.2 检查兼容性

- 打开前端项目设置/字段页，选择该项目：应可访问。
- 执行导出：应成功。

SQL 抽查：

```sql
select id, name, module, template_code, template_version
from public.projects
where name='LOCAL-LEGACY-001';
```

判定：legacy 项目在 `template_code/template_version` 为空时仍可用。

---

## 5. Template 绑定写入正确性验证

### 5.1 创建模板项目

```sql
insert into public.projects(name, center_code, module, template_code, template_version)
values
('LOCAL-IGAN-TPL', 'TEST01', 'IGAN', 'IGAN_CORE', '1.0.0'),
('LOCAL-LN-TPL',   'TEST01', 'LN',   'LN_INDUCTION', '1.0.0'),
('LOCAL-CKD-TPL',  'TEST01', 'GENERAL', 'CKD_GENERAL', '1.0.0');
```

### 5.2 校验绑定

```sql
select name, module, template_code, template_version
from public.projects
where name like 'LOCAL-%-TPL'
order by name;
```

判定：3 个项目的 `module` 与 `template_code` 一一对应，版本非空。

---

## 6. 导出 metadata 验证（template 字段）

> 此项需前端联动（`/staff` 导出 paper pack 或 metadata 文件）。

### 6.1 操作步骤

1. 登录 `/staff`，选择一个模板项目与一个 legacy 项目。
2. 分别执行导出（建议 paper pack）。
3. 解压并打开 `EXPORT_METADATA.json`（或当前实现中的 metadata 文件）。

### 6.2 验证键

应至少存在以下键：

- `template_code`
- `template_version`
- `template_binding_status`（示例：`BOUND` / `LEGACY`）

### 6.3 判定标准

- 模板项目：`template_binding_status=BOUND`，且 code/version 与项目一致。
- legacy 项目：`template_binding_status=LEGACY`，且 code/version 允许为空或为 legacy 占位。

---

## 7. 常见失败与定位建议

- **迁移失败（对象已存在）**：补充幂等语句（`if exists/if not exists`），避免直接重放报错。
- **RLS 异常可写**：优先检查是否用 service_role 测试导致误判。
- **legacy 导出报错**：检查前端是否对 `template_code` 做了硬必填。
- **metadata 缺字段**：核对导出构建逻辑是否已把模板绑定信息写入。

---

## 8. 清理 SQL（可选）

```sql
delete from public.projects
where name in (
  'LOCAL-LEGACY-001',
  'LOCAL-IGAN-TPL',
  'LOCAL-LN-TPL',
  'LOCAL-CKD-TPL'
);
```

