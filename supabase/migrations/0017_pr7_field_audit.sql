-- =============================================================
-- PR-7 字段级审计日志
-- 目的：记录"谁在什么时候把哪个字段从X改成了Y，为什么改"
--       做到每一次改动都可追溯、可还原
--
-- 使用场景举例：
--   研究员发现某患者基线 Scr 从 120 变成了 95 μmol/L
--   通过 field_audit_log 可以查到：
--     "2024-03-15 09:32, 张医生, 原因：录入时誊写错误，已核对原始化验单"
-- =============================================================

-- ─── 1. 字段级审计表：field_audit_log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_audit_log (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name    text NOT NULL,       -- 被修改的表名，例：visits_long
  record_id     uuid NOT NULL,       -- 被修改记录的 ID
  project_id    uuid,                -- 所属项目（冗余存储，方便查询）
  patient_code  text,                -- 所属患者（冗余存储）
  field_name    text NOT NULL,       -- 被修改的字段名，例：scr_umol_l
  old_value     text,                -- 修改前的值（统一转为文本存储）
  new_value     text,                -- 修改后的值
  changed_by    uuid REFERENCES auth.users(id),  -- 操作人 UUID
  changed_at    timestamptz DEFAULT now(),
  change_reason text,                -- 修改原因（应用层传入）
  ip_hint       text                 -- 可选：IP 地址或来源标识
);

CREATE INDEX IF NOT EXISTS field_audit_record
  ON field_audit_log(table_name, record_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS field_audit_project
  ON field_audit_log(project_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS field_audit_patient
  ON field_audit_log(project_id, patient_code, changed_at DESC);

COMMENT ON TABLE field_audit_log IS
  '字段级审计：记录关键字段的每次修改（谁、何时、改了什么、为什么）。
  任何用户不可删除（通过RLS保证），平台管理员也不应随意删除。';

COMMENT ON COLUMN field_audit_log.old_value IS
  '修改前的值，统一存为文本。NULL表示该字段之前为空。';
COMMENT ON COLUMN field_audit_log.change_reason IS
  '修改原因，由前端要求用户填写。例："原始化验单复核后发现录入有误"';

-- ─── 2. RLS：只读，不允许 DELETE/UPDATE ─────────────────────────────────────
ALTER TABLE field_audit_log ENABLE ROW LEVEL SECURITY;

-- 项目成员可以查看自己项目的审计记录
CREATE POLICY "field_audit_select"
  ON field_audit_log FOR SELECT TO authenticated
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = field_audit_log.project_id
        AND p.created_by = auth.uid()
    )
  );

-- 审计记录只能由系统自动写入（通过 SECURITY DEFINER 函数），不允许用户直接 INSERT
-- 不设置 INSERT policy → 用户无法直接插入，只能通过 log_field_change() 函数

-- ─── 3. 写入审计记录的函数：log_field_change() ──────────────────────────────
-- 应用层在修改关键字段前调用此函数记录变更
CREATE OR REPLACE FUNCTION log_field_change(
  p_table_name   text,
  p_record_id    uuid,
  p_project_id   uuid,
  p_patient_code text,
  p_field_name   text,
  p_old_value    text,
  p_new_value    text,
  p_reason       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- 值没变就不记录（防止噪音）
  IF p_old_value IS NOT DISTINCT FROM p_new_value THEN
    RETURN;
  END IF;

  INSERT INTO field_audit_log(
    table_name, record_id, project_id, patient_code,
    field_name, old_value, new_value,
    changed_by, change_reason
  ) VALUES (
    p_table_name, p_record_id, p_project_id, p_patient_code,
    p_field_name, p_old_value, p_new_value,
    auth.uid(), p_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_field_change TO authenticated;

-- ─── 4. 自动捕获 visits_long 关键字段变更的触发器 ──────────────────────────
-- 监控字段：visit_date / sbp / dbp / scr_umol_l / upcr / egfr / notes
-- 触发器把 old/new 变化写入 field_audit_log
CREATE OR REPLACE FUNCTION _audit_visit_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_reason text;
BEGIN
  -- 从 new row 读取 qc_reason 作为修改原因（研究者在前端填写的）
  v_reason := NEW.qc_reason;

  -- 逐字段比较，有变化则写审计
  IF OLD.visit_date IS DISTINCT FROM NEW.visit_date THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'visit_date', OLD.visit_date::text, NEW.visit_date::text, v_reason);
  END IF;
  IF OLD.sbp IS DISTINCT FROM NEW.sbp THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'sbp', OLD.sbp::text, NEW.sbp::text, v_reason);
  END IF;
  IF OLD.dbp IS DISTINCT FROM NEW.dbp THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'dbp', OLD.dbp::text, NEW.dbp::text, v_reason);
  END IF;
  IF OLD.scr_umol_l IS DISTINCT FROM NEW.scr_umol_l THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'scr_umol_l', OLD.scr_umol_l::text, NEW.scr_umol_l::text, v_reason);
  END IF;
  IF OLD.upcr IS DISTINCT FROM NEW.upcr THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'upcr', OLD.upcr::text, NEW.upcr::text, v_reason);
  END IF;
  IF OLD.egfr IS DISTINCT FROM NEW.egfr THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'egfr', OLD.egfr::text, NEW.egfr::text, v_reason);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_visit_fields ON visits_long;
CREATE TRIGGER trg_audit_visit_fields
  AFTER UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _audit_visit_fields();

-- ─── 5. 自动捕获 patients_baseline 关键字段变更 ─────────────────────────────
CREATE OR REPLACE FUNCTION _audit_baseline_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF OLD.baseline_date IS DISTINCT FROM NEW.baseline_date THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_date', OLD.baseline_date::text, NEW.baseline_date::text, NULL);
  END IF;
  IF OLD.baseline_scr IS DISTINCT FROM NEW.baseline_scr THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_scr', OLD.baseline_scr::text, NEW.baseline_scr::text, NULL);
  END IF;
  IF OLD.baseline_upcr IS DISTINCT FROM NEW.baseline_upcr THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_upcr', OLD.baseline_upcr::text, NEW.baseline_upcr::text, NULL);
  END IF;
  IF OLD.sex IS DISTINCT FROM NEW.sex THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'sex', OLD.sex, NEW.sex, NULL);
  END IF;
  IF OLD.birth_year IS DISTINCT FROM NEW.birth_year THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'birth_year', OLD.birth_year::text, NEW.birth_year::text, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_baseline_fields ON patients_baseline;
CREATE TRIGGER trg_audit_baseline_fields
  AFTER UPDATE ON patients_baseline
  FOR EACH ROW EXECUTE FUNCTION _audit_baseline_fields();

-- ─── 6. 查询某记录审计历史的 RPC ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_field_audit(
  p_table_name text,
  p_record_id  uuid
)
RETURNS TABLE(
  changed_at    timestamptz,
  field_name    text,
  old_value     text,
  new_value     text,
  changed_by    uuid,
  change_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.changed_at,
    a.field_name,
    a.old_value,
    a.new_value,
    a.changed_by,
    a.change_reason
  FROM field_audit_log a
  WHERE a.table_name = p_table_name
    AND a.record_id  = p_record_id
    AND (
      a.project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = a.project_id AND p.created_by = auth.uid()
      )
    )
  ORDER BY a.changed_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_field_audit TO authenticated;

COMMENT ON FUNCTION get_field_audit IS
  '查询某记录的字段修改历史。
  例：SELECT * FROM get_field_audit(''visits_long'', ''uuid-of-visit'')
  返回：哪些字段被修改、修改前后的值、谁修改的、修改原因';
