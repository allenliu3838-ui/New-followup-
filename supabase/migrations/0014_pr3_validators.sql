-- =============================================================
-- PR-3 核心校验器：日期链 / 重复 / 跳变 / eGFR 版本化
-- 目的：在数据写入时自动拦截明显错误，同时保留"留痕后保存"通道
--
-- 三种处理级别：
--   ERROR   → 直接拒绝，返回 HTTP 400，必须改正
--   WARNING → 弹窗提示 + 必填 reason 后才能保存
--   INFO    → 前端提示，不阻止保存
-- =============================================================

-- ─── 1. 给需要留痕 reason 的表加 qc_reason 列 ─────────────────────────────
-- visits_long：随访记录留痕原因
ALTER TABLE visits_long
  ADD COLUMN IF NOT EXISTS qc_reason text;

-- labs_long：化验记录留痕原因
ALTER TABLE labs_long
  ADD COLUMN IF NOT EXISTS qc_reason text;

COMMENT ON COLUMN visits_long.qc_reason IS
  '质控留痕原因。当数据触发跳变警告或同日重复时，必须填写原因才能保存。
  例："患者住院期间急性肾损伤，Scr快速升高，已与主治医生确认"';

COMMENT ON COLUMN labs_long.qc_reason IS
  '质控留痕原因。例："同日两次检测，第一次采血失误，本次为复查确认值"';

-- ─── 2. 硬范围限制更新（visits_long）────────────────────────────────────────
-- 原有约束已有 sbp/dbp/scr 范围，补充更明确的说明
-- upcr 单位为 g/g 时最大 50；为 mg/g 时最大 50000（历史数据兼容）
-- 这里先更新 upcr 上限（原来只有 >=0）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'visits_long_upcr_range'
      AND table_name = 'visits_long'
  ) THEN
    ALTER TABLE visits_long
      ADD CONSTRAINT visits_long_upcr_range CHECK (upcr IS NULL OR (upcr >= 0 AND upcr <= 50000));
  END IF;
END $$;

-- ─── 3. 日期链校验函数：validate_date_chain() ───────────────────────────────
-- 验证：biopsy_date ≤ baseline_date ≤ visit_date ≤ event_date
-- 返回：错误信息 text，NULL 表示通过
CREATE OR REPLACE FUNCTION validate_date_chain(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date  DEFAULT NULL,
  p_event_date   date  DEFAULT NULL
)
RETURNS text   -- NULL=通过；非NULL=错误原因
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
BEGIN
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id  = p_project_id
    AND patient_code = p_patient_code;

  -- 没有基线数据，无法校验，放行
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 随访日期必须 ≥ 基线日期
  IF p_visit_date IS NOT NULL AND v_baseline.baseline_date IS NOT NULL THEN
    IF p_visit_date < v_baseline.baseline_date THEN
      RETURN '随访日期（' || p_visit_date || '）早于基线日期（'
           || v_baseline.baseline_date || '），请检查。'
           || '如是基线前检查，请改录入基线数据。';
    END IF;
  END IF;

  -- 终点日期必须 ≥ 基线日期
  IF p_event_date IS NOT NULL AND v_baseline.baseline_date IS NOT NULL THEN
    IF p_event_date < v_baseline.baseline_date THEN
      RETURN '终点日期（' || p_event_date || '）早于基线日期（'
           || v_baseline.baseline_date || '），请检查。';
    END IF;
  END IF;

  RETURN NULL;  -- 通过
END;
$$;

COMMENT ON FUNCTION validate_date_chain IS
  '校验日期链：随访/终点日期必须不早于基线日期。返回NULL表示通过，非NULL为错误说明。';

-- ─── 4. 重复录入检测：check_duplicate_lab() ─────────────────────────────────
-- 同一患者、同一日期、同一化验项目已有记录时返回提示
-- 返回：NULL=无重复；非NULL=已有记录信息
CREATE OR REPLACE FUNCTION check_duplicate_lab(
  p_project_id    uuid,
  p_patient_code  text,
  p_lab_date      date,
  p_lab_test_code text,
  p_exclude_id    uuid DEFAULT NULL  -- 编辑时排除自身
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_existing labs_long%ROWTYPE;
BEGIN
  SELECT * INTO v_existing
  FROM labs_long
  WHERE project_id    = p_project_id
    AND patient_code  = p_patient_code
    AND lab_date      = p_lab_date
    AND lab_test_code = p_lab_test_code
    AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN '该患者在 ' || p_lab_date || ' 已有一条 '
         || p_lab_test_code || ' 记录（值：'
         || COALESCE(v_existing.value_raw::text, v_existing.lab_value::text, '?')
         || ' ' || COALESCE(v_existing.unit_symbol, v_existing.lab_unit, '')
         || '）。如确需保存，请在"留痕原因"中说明（如：复查确认值）。';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 5. 跳变检测：check_jump_spike() ────────────────────────────────────────
-- 与同患者上一次同化验项目的标准值相比，变化超过阈值则提示
-- 返回：NULL=正常；非NULL=跳变说明
CREATE OR REPLACE FUNCTION check_jump_spike(
  p_project_id    uuid,
  p_patient_code  text,
  p_lab_test_code text,
  p_value_std     numeric,  -- 本次标准值
  p_lab_date      date,
  p_exclude_id    uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_prev_value numeric;
  v_prev_date  date;
  v_ratio      numeric;
  v_threshold  numeric;
BEGIN
  -- 找最近一次同项目记录
  SELECT value_standard, lab_date INTO v_prev_value, v_prev_date
  FROM labs_long
  WHERE project_id    = p_project_id
    AND patient_code  = p_patient_code
    AND lab_test_code = p_lab_test_code
    AND value_standard IS NOT NULL
    AND lab_date < p_lab_date          -- 只和更早的比
    AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  ORDER BY lab_date DESC
  LIMIT 1;

  IF NOT FOUND OR v_prev_value IS NULL OR v_prev_value = 0 THEN
    RETURN NULL;  -- 没有历史值或历史值为0，无法判断跳变
  END IF;

  v_ratio := p_value_std / v_prev_value;

  -- 不同项目用不同阈值（倍数）
  v_threshold := CASE p_lab_test_code
    WHEN 'CREAT' THEN 3.0   -- 血肌酐：涨3倍触发（AKI可能）
    WHEN 'UPCR'  THEN 5.0   -- 尿蛋白：涨5倍触发（波动本身大）
    WHEN 'K'     THEN 2.0   -- 血钾：涨2倍触发（高钾危险）
    ELSE 4.0                 -- 其他指标默认4倍
  END;

  IF v_ratio > v_threshold OR v_ratio < (1.0 / v_threshold) THEN
    RETURN p_lab_test_code || ' 本次值（' || p_value_std || '）与上次（'
         || v_prev_date || '，' || v_prev_value || '）相差超过 '
         || ROUND((v_ratio - 1) * 100) || '%，存在异常跳变。'
         || '如确认无误，请在"留痕原因"中说明（如：患者住院期间AKI，已与上级确认）。';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 6. 随访记录综合校验：validate_visit_record() ──────────────────────────
-- 前端和 RPC 都调用这个函数，返回 errors + warnings
-- errors   → 必须修正，无法保存
-- warnings → 需要填 reason，填完才能保存
CREATE OR REPLACE FUNCTION validate_visit_record(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date,
  p_sbp          numeric DEFAULT NULL,
  p_dbp          numeric DEFAULT NULL,
  p_scr_umol_l   numeric DEFAULT NULL,
  p_upcr         numeric DEFAULT NULL,
  p_egfr         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_exclude_id   uuid    DEFAULT NULL
)
RETURNS jsonb   -- { "errors": [...], "warnings": [...] }
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_date_err text;
  v_prev_scr numeric;
  v_prev_date date;
  v_ratio    numeric;
  v_dup_cnt  int;
BEGIN
  -- ① 日期链校验（ERROR）
  v_date_err := validate_date_chain(p_project_id, p_patient_code, p_visit_date, NULL);
  IF v_date_err IS NOT NULL THEN
    v_errors := array_append(v_errors, v_date_err);
  END IF;

  -- ② 血压范围（ERROR）
  IF p_sbp IS NOT NULL AND (p_sbp < 30 OR p_sbp > 300) THEN
    v_errors := array_append(v_errors,
      '收缩压（SBP）' || p_sbp || ' mmHg 超出合理范围 30–300 mmHg，请检查是否录入有误');
  END IF;
  IF p_dbp IS NOT NULL AND (p_dbp < 30 OR p_dbp > 300) THEN
    v_errors := array_append(v_errors,
      '舒张压（DBP）' || p_dbp || ' mmHg 超出合理范围 30–300 mmHg');
  END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp >= p_sbp THEN
    v_errors := array_append(v_errors,
      '舒张压（' || p_dbp || '）≥ 收缩压（' || p_sbp || '），请检查血压录入顺序');
  END IF;

  -- ③ 血肌酐范围（单位 μmol/L）（ERROR）
  IF p_scr_umol_l IS NOT NULL AND (p_scr_umol_l < 10 OR p_scr_umol_l > 5000) THEN
    v_errors := array_append(v_errors,
      '血肌酐 ' || p_scr_umol_l || ' μmol/L 超出合理范围 10–5000 μmol/L');
  END IF;

  -- ④ UPCR 范围（单位 g/g 标准化后；visits_long 存的是原始值，以 mg/g 为主）
  IF p_upcr IS NOT NULL AND p_upcr < 0 THEN
    v_errors := array_append(v_errors, 'UPCR 不能为负数');
  END IF;

  -- ⑤ PII 检测（ERROR）
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    v_errors := array_append(v_errors,
      '备注疑似包含个人身份信息（手机号/身份证/住院号等）。'
      || '请删除后重新保存，系统拒绝存储任何可识别个人信息（PII）。');
  END IF;

  -- ⑥ 同日重复随访（WARNING，允许填 reason 后保存）
  SELECT COUNT(*) INTO v_dup_cnt
  FROM visits_long
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND visit_date   = p_visit_date
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);

  IF v_dup_cnt > 0 THEN
    v_warnings := array_append(v_warnings,
      '该患者在 ' || p_visit_date || ' 已有 ' || v_dup_cnt
      || ' 条随访记录，请确认是否为重复录入。如为同日多次测量，请在"留痕原因"中说明。');
  END IF;

  -- ⑦ 血肌酐跳变检测（WARNING）
  IF p_scr_umol_l IS NOT NULL THEN
    SELECT v.scr_umol_l, v.visit_date INTO v_prev_scr, v_prev_date
    FROM visits_long v
    WHERE v.project_id   = p_project_id
      AND v.patient_code = p_patient_code
      AND v.scr_umol_l  IS NOT NULL
      AND v.visit_date   < p_visit_date
      AND (p_exclude_id IS NULL OR v.id <> p_exclude_id)
    ORDER BY v.visit_date DESC
    LIMIT 1;

    IF FOUND AND v_prev_scr > 0 THEN
      v_ratio := p_scr_umol_l / v_prev_scr;
      IF v_ratio > 3.0 OR v_ratio < (1.0/3.0) THEN
        v_warnings := array_append(v_warnings,
          '血肌酐本次（' || p_scr_umol_l || ' μmol/L）与上次（'
          || v_prev_date || '，' || v_prev_scr
          || ' μmol/L）相差超过 3 倍，请确认是否为急性肾损伤或测量误差。'
          || '如确认无误，请填写"留痕原因"。');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errors',   to_jsonb(v_errors),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_visit_record    TO authenticated, anon;
GRANT EXECUTE ON FUNCTION validate_date_chain      TO authenticated;
GRANT EXECUTE ON FUNCTION check_duplicate_lab      TO authenticated;
GRANT EXECUTE ON FUNCTION check_jump_spike         TO authenticated;

COMMENT ON FUNCTION validate_visit_record IS
  '随访记录综合校验。返回 {errors:[...], warnings:[...]}。
  errors 必须修正才能保存；warnings 需要填写 qc_reason 才能保存。
  例：validate_visit_record(pid, ''P001'', ''2024-01-15'', 160, 95, 150, 1.2)';

-- ─── 7. eGFR 计算函数：ckd_epi_2021() ──────────────────────────────────────
-- 公式：CKD-EPI 2021（无种族项，国际主流，可直接引用）
-- 输入：血肌酐（mg/dL）、性别（M/F）、年龄（岁）
-- 输出：eGFR（mL/min/1.73m²）
-- 论文引用：Inker et al., NEJM 2021;385:1737–1749
CREATE OR REPLACE FUNCTION ckd_epi_2021(
  p_scr_mg_dl numeric,   -- 血肌酐，单位必须是 mg/dL
  p_sex       text,      -- 'M' 或 'F'
  p_age_years numeric    -- 年龄（岁）
)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_kappa    numeric;
  v_alpha    numeric;
  v_sex_mult numeric;
  v_scr_k    numeric;
BEGIN
  IF p_scr_mg_dl IS NULL OR p_sex IS NULL OR p_age_years IS NULL THEN
    RETURN NULL;
  END IF;

  -- 按性别设定参数（CKD-EPI 2021 原文参数）
  IF upper(p_sex) = 'F' THEN
    v_kappa    := 0.7;
    v_alpha    := -0.241;
    v_sex_mult := 1.012;
  ELSE
    v_kappa    := 0.9;
    v_alpha    := -0.302;
    v_sex_mult := 1.0;
  END IF;

  v_scr_k := p_scr_mg_dl / v_kappa;

  RETURN ROUND(
    142.0
    * POWER(LEAST(v_scr_k, 1.0), v_alpha)
    * POWER(GREATEST(v_scr_k, 1.0), -1.200)
    * POWER(0.9938, p_age_years)
    * v_sex_mult
  , 1);
END;
$$;

COMMENT ON FUNCTION ckd_epi_2021 IS
  'CKD-EPI 2021 公式计算eGFR（无种族项）。
  输入：血肌酐mg/dL、性别(M/F)、年龄（岁）。
  论文：Inker et al., NEJM 2021;385:1737-1749。
  例：ckd_epi_2021(1.0, ''M'', 50) → 约87 mL/min/1.73m²';

-- ─── 8. 自动计算 eGFR 的触发器（visits_long） ────────────────────────────
-- 每次写入/更新 scr_umol_l 时，若有患者年龄和性别，自动计算 eGFR
CREATE OR REPLACE FUNCTION _auto_compute_egfr()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
  v_age      numeric;
  v_scr_mgdl numeric;
BEGIN
  -- 只在有 scr_umol_l 时才计算
  IF NEW.scr_umol_l IS NULL THEN
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 查基线（获取性别和出生年）
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id  = NEW.project_id
    AND patient_code = NEW.patient_code;

  IF NOT FOUND OR v_baseline.sex IS NULL OR v_baseline.birth_year IS NULL THEN
    -- 缺性别或出生年，无法计算
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 从 μmol/L 换算 mg/dL
  v_scr_mgdl := NEW.scr_umol_l * 0.01130996;

  -- 计算年龄
  v_age := EXTRACT(YEAR FROM NEW.visit_date) - v_baseline.birth_year;
  IF v_age < 18 OR v_age > 120 THEN
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 仅当用户没有手动填 egfr 时，才用公式覆盖
  -- 若用户手填了 egfr，则 formula_version='manual'
  IF NEW.egfr IS NOT NULL AND (TG_OP = 'UPDATE' AND OLD.egfr IS NOT NULL AND NEW.egfr = OLD.egfr)
     OR (TG_OP = 'INSERT' AND NEW.egfr_formula_version = 'manual') THEN
    -- 手动填写，保留
    RETURN NEW;
  END IF;

  NEW.egfr := ckd_epi_2021(v_scr_mgdl, v_baseline.sex, v_age);
  NEW.egfr_formula_version := 'CKD-EPI-2021-Cr';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_egfr ON visits_long;
CREATE TRIGGER trg_auto_egfr
  BEFORE INSERT OR UPDATE OF scr_umol_l ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _auto_compute_egfr();

COMMENT ON TRIGGER trg_auto_egfr ON visits_long IS
  '每次录入/更新血肌酐时，自动用 CKD-EPI 2021 公式计算 eGFR 并记录公式版本';

GRANT EXECUTE ON FUNCTION ckd_epi_2021 TO authenticated;
