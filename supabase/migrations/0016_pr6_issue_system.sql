-- =============================================================
-- PR-6 Issue/Query 质控闭环系统
-- 目的：把"质控警告"变成"可追踪的任务"，直到问题解决才关闭
--
-- 类比：这是数据版的"Bug 跟踪系统"
--   ● 数据写入时自动检测问题 → 生成 Issue（OPEN）
--   ● 研究者修正数据 → Issue 自动关闭（RESOLVED）
--   ● 无法修正但有理由 → 手动标记 WONT_FIX（必须填理由）
--   ● 仪表盘展示：哪些患者还有未解决的数据质量问题
-- =============================================================

-- ─── 1. Issue 主表：data_issues ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_issues (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  center_code     text,                 -- 来自项目的中心编码，方便按中心筛查
  patient_code    text NOT NULL,        -- 问题关联的患者
  record_type     text NOT NULL,        -- 问题关联的记录类型：visit/lab/baseline/event
  record_id       uuid,                 -- 问题记录的 ID（可 NULL，如缺失数据没有ID）
  rule_code       text NOT NULL,        -- 触发的规则编码（见下方说明）
  severity        text NOT NULL DEFAULT 'warning',  -- critical/warning/info
  status          text NOT NULL DEFAULT 'OPEN',     -- OPEN/IN_PROGRESS/RESOLVED/WONT_FIX
  assigned_to     uuid REFERENCES auth.users(id),   -- 指派给哪位研究者处理
  message         text NOT NULL,        -- 问题描述（面向研究者的中文说明）
  resolution_note text,                 -- 解决说明（RESOLVED 或 WONT_FIX 时必填）
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  resolved_at     timestamptz,          -- 自动解决时间
  created_by      uuid REFERENCES auth.users(id),   -- 系统自动创建或人工创建

  CONSTRAINT data_issues_severity_check
    CHECK (severity IN ('critical', 'warning', 'info')),
  CONSTRAINT data_issues_status_check
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX')),
  CONSTRAINT data_issues_record_type_check
    CHECK (record_type IN ('visit', 'lab', 'baseline', 'event', 'medication'))
);

-- 去重索引：同一规则+同一记录只生成一个 Issue
CREATE UNIQUE INDEX IF NOT EXISTS data_issues_dedup
  ON data_issues(project_id, patient_code, record_type, COALESCE(record_id::text,'NULL'), rule_code)
  WHERE status NOT IN ('RESOLVED', 'WONT_FIX');

CREATE INDEX IF NOT EXISTS data_issues_project_status
  ON data_issues(project_id, status, severity);

CREATE INDEX IF NOT EXISTS data_issues_patient
  ON data_issues(project_id, patient_code, status);

COMMENT ON TABLE data_issues IS
  'Issue质控系统：记录每条数据的质量问题，跟踪解决状态。
  类似GitHub Issues，每个数据问题是一个Issue，修复后自动关闭。';

COMMENT ON COLUMN data_issues.rule_code IS
  '触发规则编码，可选值：
  MISSING_CORE_FIELD   - 缺失核心字段（必填项为空）
  OUT_OF_RANGE         - 超出合理范围
  UNIT_NOT_ALLOWED     - 化验单位不在允许列表中
  DATE_CONFLICT        - 日期链冲突（如随访早于基线）
  DUPLICATE_SAME_DAY   - 同日重复录入
  JUMP_SPIKE           - 数值异常跳变
  MISSING_EGFR_INPUTS  - 缺性别/出生年导致无法计算eGFR
  PII_SUSPECTED        - 疑似含个人身份信息（严重）';

COMMENT ON COLUMN data_issues.severity IS
  'critical=数据无法用于分析（如日期冲突）；
  warning=数据可疑需确认（如跳变）；
  info=建议补充（如eGFR无法计算）';

-- ─── 2. Issue 评论表：data_issue_comments ────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_issue_comments (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  issue_id   uuid NOT NULL REFERENCES data_issues(id) ON DELETE CASCADE,
  comment    text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_issue_comments_issue
  ON data_issue_comments(issue_id, created_at);

COMMENT ON TABLE data_issue_comments IS
  'Issue 讨论记录：研究者可以在Issue下留言，说明情况、协商处理方案';

-- ─── 3. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE data_issues         ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_issue_comments ENABLE ROW LEVEL SECURITY;

-- 项目成员可以查看/操作自己项目的 Issue
CREATE POLICY "issues_project_owner"
  ON data_issues FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = data_issues.project_id
      AND p.created_by = auth.uid()
  ));

CREATE POLICY "comments_issue_owner"
  ON data_issue_comments FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM data_issues i
    JOIN projects p ON p.id = i.project_id
    WHERE i.id = data_issue_comments.issue_id
      AND p.created_by = auth.uid()
  ));

-- ─── 4. 自动生成/更新 Issue 的函数：raise_or_update_issue() ──────────────────
-- 每次数据写入后由触发器调用
-- 去重逻辑：同一规则+同一记录，只有一个 OPEN/IN_PROGRESS Issue
CREATE OR REPLACE FUNCTION raise_or_update_issue(
  p_project_id   uuid,
  p_patient_code text,
  p_record_type  text,
  p_record_id    uuid,
  p_rule_code    text,
  p_severity     text,
  p_message      text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_issue_id   uuid;
  v_center     text;
BEGIN
  SELECT center_code INTO v_center FROM projects WHERE id = p_project_id;

  -- 尝试找已有的 OPEN 或 IN_PROGRESS Issue（去重）
  SELECT id INTO v_issue_id
  FROM data_issues
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND record_type  = p_record_type
    AND (record_id = p_record_id OR (record_id IS NULL AND p_record_id IS NULL))
    AND rule_code    = p_rule_code
    AND status NOT IN ('RESOLVED', 'WONT_FIX')
  LIMIT 1;

  IF FOUND THEN
    -- 更新已有 Issue（信息可能有变化）
    UPDATE data_issues SET
      message    = p_message,
      severity   = p_severity,
      updated_at = now()
    WHERE id = v_issue_id;
  ELSE
    -- 新建 Issue
    INSERT INTO data_issues(
      project_id, center_code, patient_code,
      record_type, record_id, rule_code,
      severity, status, message
    ) VALUES (
      p_project_id, v_center, p_patient_code,
      p_record_type, p_record_id, p_rule_code,
      p_severity, 'OPEN', p_message
    )
    RETURNING id INTO v_issue_id;
  END IF;

  RETURN v_issue_id;
END;
$$;

-- ─── 5. 自动关闭 Issue 的函数：resolve_issue_if_exists() ─────────────────────
-- 数据修正后调用，自动把对应 Issue 改为 RESOLVED
CREATE OR REPLACE FUNCTION resolve_issue_if_exists(
  p_project_id   uuid,
  p_patient_code text,
  p_record_type  text,
  p_record_id    uuid,
  p_rule_code    text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE data_issues SET
    status       = 'RESOLVED',
    resolved_at  = now(),
    resolution_note = '数据已修正，系统自动关闭',
    updated_at   = now()
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND record_type  = p_record_type
    AND (record_id = p_record_id OR (record_id IS NULL AND p_record_id IS NULL))
    AND rule_code    = p_rule_code
    AND status NOT IN ('RESOLVED', 'WONT_FIX');
END;
$$;

-- ─── 6. 手动关闭 Issue（WONT_FIX）：close_issue_wont_fix() ─────────────────
CREATE OR REPLACE FUNCTION close_issue_wont_fix(
  p_issue_id      uuid,
  p_resolution    text  -- 必填！说明为什么不修复
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF p_resolution IS NULL OR trim(p_resolution) = '' THEN
    RAISE EXCEPTION 'resolution_required'
      USING HINT = '标记为"不修复"时必须填写原因，例："该患者是历史数据导入，日期无法追溯"';
  END IF;

  UPDATE data_issues SET
    status          = 'WONT_FIX',
    resolution_note = p_resolution,
    resolved_at     = now(),
    updated_at      = now()
  WHERE id = p_issue_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = data_issues.project_id
        AND p.created_by = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue_not_found' USING HINT = 'Issue不存在或无权操作';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION close_issue_wont_fix  TO authenticated;
GRANT EXECUTE ON FUNCTION raise_or_update_issue TO authenticated;
GRANT EXECUTE ON FUNCTION resolve_issue_if_exists TO authenticated;

-- ─── 7. QC 规则触发器：visits_long ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION _qc_check_visit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
BEGIN
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id = NEW.project_id AND patient_code = NEW.patient_code;

  -- 规则①：随访日期早于基线 → critical
  IF FOUND AND v_baseline.baseline_date IS NOT NULL
     AND NEW.visit_date < v_baseline.baseline_date THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'DATE_CONFLICT', 'critical',
      '随访日期（' || NEW.visit_date || '）早于基线日期（'
      || v_baseline.baseline_date || '），数据无法用于时序分析'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'DATE_CONFLICT'
    );
  END IF;

  -- 规则②：缺核心字段（scr 或 upcr）→ warning
  IF NEW.scr_umol_l IS NULL AND NEW.upcr IS NULL THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_CORE_FIELD', 'warning',
      '随访记录（' || NEW.visit_date || '）缺少血肌酐和UPCR，eGFR及蛋白尿无法分析'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_CORE_FIELD'
    );
  END IF;

  -- 规则③：eGFR 因缺输入无法计算 → info
  IF NEW.egfr IS NULL AND NEW.scr_umol_l IS NOT NULL THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_EGFR_INPUTS', 'info',
      '有血肌酐数据，但缺少患者性别或出生年，无法自动计算eGFR。请完善基线信息。'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_EGFR_INPUTS'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qc_visit ON visits_long;
CREATE TRIGGER trg_qc_visit
  AFTER INSERT OR UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _qc_check_visit();

-- ─── 8. QC 规则触发器：labs_long ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _qc_check_lab()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- 规则：单位不在允许列表 → warning
  IF NEW.lab_test_code IS NOT NULL AND NEW.unit_symbol IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM lab_test_unit_map
      WHERE lab_test_code = NEW.lab_test_code
        AND unit_symbol   = NEW.unit_symbol
    ) THEN
      PERFORM raise_or_update_issue(
        NEW.project_id, NEW.patient_code, 'lab', NEW.id,
        'UNIT_NOT_ALLOWED', 'warning',
        '化验项目 ' || NEW.lab_test_code || ' 使用了不允许的单位 "'
        || NEW.unit_symbol || '"，标准化换算失败，无法合并分析'
      );
    ELSE
      PERFORM resolve_issue_if_exists(
        NEW.project_id, NEW.patient_code, 'lab', NEW.id, 'UNIT_NOT_ALLOWED'
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qc_lab ON labs_long;
CREATE TRIGGER trg_qc_lab
  AFTER INSERT OR UPDATE ON labs_long
  FOR EACH ROW EXECUTE FUNCTION _qc_check_lab();

-- ─── 9. 查询 Issue 统计的 RPC（仪表盘用） ───────────────────────────────────
CREATE OR REPLACE FUNCTION get_issue_summary(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_open',    COUNT(*) FILTER (WHERE status = 'OPEN'),
    'total_in_prog', COUNT(*) FILTER (WHERE status = 'IN_PROGRESS'),
    'total_resolved',COUNT(*) FILTER (WHERE status = 'RESOLVED'),
    'total_wontfix', COUNT(*) FILTER (WHERE status = 'WONT_FIX'),
    'by_severity', jsonb_build_object(
      'critical', COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='critical'),
      'warning',  COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='warning'),
      'info',     COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='info')
    ),
    'close_rate_pct', ROUND(
      100.0 * COUNT(*) FILTER (WHERE status IN ('RESOLVED','WONT_FIX'))
      / NULLIF(COUNT(*), 0)
    , 1)
  )
  INTO v_result
  FROM data_issues
  WHERE project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = p_project_id AND p.created_by = auth.uid()
    );

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_issue_summary TO authenticated;
