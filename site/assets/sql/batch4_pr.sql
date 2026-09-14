-- GENERATED compatibility batch 4/6; execute all six in order, stop on error.
-- MIGRATION 020: 0019_cn_friendly_layer.sql
-- =============================================================
-- PR-8 中文友好层（面向中国医生）
-- 目标：保留内部英文编码稳定性，同时提供中文优先展示与搜索能力
-- =============================================================

-- 1) 通用概念字典（内部 code + 中文展示元数据）
CREATE TABLE IF NOT EXISTS concept_dictionary (
  code                  text PRIMARY KEY,
  domain                text NOT NULL DEFAULT 'GENERAL',
  display_name_cn       text NOT NULL,
  short_name_cn         text NOT NULL,
  help_text_cn          text,
  when_to_fill_cn       text,
  example_value_cn      text,
  unit_cn               text,
  common_mistakes_cn    text,
  patient_friendly_cn   text,
  doctor_note_cn        text,
  is_required           boolean NOT NULL DEFAULT false,
  affects_export        boolean NOT NULL DEFAULT true,
  affects_qc            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE concept_dictionary IS '中文展示层概念字典：前台默认读中文名，内部仍可用英文 code。';
COMMENT ON COLUMN concept_dictionary.code IS '内部稳定英文编码，例如 dd_cfdna_fraction_pct。';
COMMENT ON COLUMN concept_dictionary.display_name_cn IS '面向临床一线的完整中文显示名（可含缩写）。';
COMMENT ON COLUMN concept_dictionary.short_name_cn IS '适合列表/表头的中文短名。';

CREATE INDEX IF NOT EXISTS idx_concept_dictionary_domain ON concept_dictionary(domain);
CREATE INDEX IF NOT EXISTS idx_concept_dictionary_display_name_cn ON concept_dictionary USING gin (to_tsvector('simple', coalesce(display_name_cn, '')));

CREATE OR REPLACE FUNCTION set_concept_dictionary_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_concept_dictionary_updated_at ON concept_dictionary;
CREATE TRIGGER trg_concept_dictionary_updated_at
BEFORE UPDATE ON concept_dictionary
FOR EACH ROW EXECUTE FUNCTION set_concept_dictionary_updated_at();

-- 2) 核心缩写词典（首次出现需中文解释）
CREATE TABLE IF NOT EXISTS abbreviation_dictionary (
  abbr               text PRIMARY KEY,
  full_name_cn       text NOT NULL,
  category_cn        text NOT NULL,
  first_use_note_cn  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE abbreviation_dictionary IS '肾内科研究常见缩写词典，用于首次出现自动解释。';

INSERT INTO abbreviation_dictionary (abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('KDPI', '肾供体概况指数', '移植相关', '首次显示建议：肾供体概况指数（KDPI）'),
  ('KDRI', '肾供体风险指数', '移植相关', '首次显示建议：肾供体风险指数（KDRI）'),
  ('DSA', '供者特异性抗体', '移植相关', '首次显示建议：供者特异性抗体（DSA）'),
  ('dnDSA', '新生供者特异性抗体', '移植相关', '首次显示建议：新生供者特异性抗体（dnDSA）'),
  ('dd-cfDNA', '供体来源细胞游离 DNA', '移植相关', '首次显示建议：供体来源细胞游离 DNA（dd-cfDNA）'),
  ('BK', 'BK 病毒', '感染监测', '首次显示建议：BK 病毒（BK）'),
  ('CMV', '巨细胞病毒', '感染监测', '首次显示建议：巨细胞病毒（CMV）'),
  ('EBV', 'EB 病毒', '感染监测', '首次显示建议：EB 病毒（EBV）'),
  ('Banff', '肾移植病理 Banff 分类', '病理相关', '首次显示建议：肾移植病理 Banff 分类（Banff）'),
  ('CNI', '钙调神经磷酸酶抑制剂', '免疫抑制', '首次显示建议：钙调神经磷酸酶抑制剂（CNI）'),
  ('mTORi', 'mTOR 抑制剂', '免疫抑制', '首次显示建议：mTOR 抑制剂（mTORi）'),
  ('UPCR', '尿蛋白/肌酐比', '肾功能与尿检', '首次显示建议：尿蛋白/肌酐比（UPCR）'),
  ('UACR', '尿白蛋白/肌酐比', '肾功能与尿检', '首次显示建议：尿白蛋白/肌酐比（UACR）'),
  ('eGFR', '估算肾小球滤过率', '肾功能与尿检', '首次显示建议：估算肾小球滤过率（eGFR）'),
  ('MCD', '微小病变病', '病种相关', '首次显示建议：微小病变病（MCD）'),
  ('MN', '膜性肾病', '病种相关', '首次显示建议：膜性肾病（MN）'),
  ('MGRS', '单克隆免疫球蛋白相关肾损害', '血液学与免疫相关', '首次显示建议：单克隆免疫球蛋白相关肾损害（MGRS）'),
  ('C3G', 'C3 肾小球病', '病种相关', '首次显示建议：C3 肾小球病（C3G）')
ON CONFLICT (abbr) DO UPDATE SET
  full_name_cn = EXCLUDED.full_name_cn,
  category_cn = EXCLUDED.category_cn,
  first_use_note_cn = EXCLUDED.first_use_note_cn;

-- 3) 中文别名检索表（支持“肌酐/尿蛋白/排斥/BK病毒”等中文搜索）
CREATE TABLE IF NOT EXISTS concept_alias_dictionary (
  concept_code   text NOT NULL REFERENCES concept_dictionary(code) ON DELETE CASCADE,
  alias_cn       text NOT NULL,
  alias_en       text,
  priority       integer NOT NULL DEFAULT 100,
  PRIMARY KEY (concept_code, alias_cn)
);

CREATE INDEX IF NOT EXISTS idx_concept_alias_cn_tsv
  ON concept_alias_dictionary USING gin (to_tsvector('simple', coalesce(alias_cn,'')));

-- 4) 兼容 lab_test_catalog：补充中文展示字段（如果已存在则跳过）
ALTER TABLE lab_test_catalog
  ADD COLUMN IF NOT EXISTS display_name_cn     text,
  ADD COLUMN IF NOT EXISTS short_name_cn       text,
  ADD COLUMN IF NOT EXISTS help_text_cn        text,
  ADD COLUMN IF NOT EXISTS when_to_fill_cn     text,
  ADD COLUMN IF NOT EXISTS example_value_cn    text,
  ADD COLUMN IF NOT EXISTS unit_cn             text,
  ADD COLUMN IF NOT EXISTS common_mistakes_cn  text,
  ADD COLUMN IF NOT EXISTS patient_friendly_cn text,
  ADD COLUMN IF NOT EXISTS doctor_note_cn      text;

UPDATE lab_test_catalog
SET
  display_name_cn = COALESCE(display_name_cn, name_cn),
  short_name_cn   = COALESCE(short_name_cn, name_cn),
  help_text_cn    = COALESCE(help_text_cn, display_note),
  unit_cn         = COALESCE(unit_cn, standard_unit)
WHERE display_name_cn IS NULL
   OR short_name_cn IS NULL
   OR help_text_cn IS NULL
   OR unit_cn IS NULL;

-- 5) KTX 常用字段预置（来自中文友好化规范）
INSERT INTO concept_dictionary(
  code, domain, display_name_cn, short_name_cn, help_text_cn, when_to_fill_cn, unit_cn,
  affects_export, affects_qc
) VALUES
  ('donor_type', 'KTX', '供体类型', '供体类型', '区分活体供者与尸体供者。', '创建移植基线时填写。', NULL, true, true),
  ('kdpi', 'KTX', '肾供体概况指数（KDPI）', 'KDPI', '评估尸体供肾质量。', '有尸体供者资料时填写。', NULL, true, false),
  ('kdri', 'KTX', '肾供体风险指数（KDRI）', 'KDRI', '用于供体风险分层。', '有供体风险评估时填写。', NULL, true, false),
  ('tacrolimus_c0', 'KTX', '他克莫司谷浓度（C0）', '他克莫司 C0', '下一次服药前测得的最低血药浓度。', '术后随访监测免疫抑制时填写。', 'ng/mL（纳克/毫升）', true, true),
  ('dd_cfdna_fraction_pct', 'KTX', '供体来源细胞游离 DNA（dd-cfDNA，百分比）', 'dd-cfDNA%', '建议明确是百分比结果。', '移植后生物标志物监测时填写。', '%（百分比）', true, false),
  ('bk_plasma_pcr', 'KTX', 'BK 病毒血浆核酸定量', 'BK 病毒 PCR', 'BK 病毒监测核心字段。', '术后病毒监测时填写。', 'copies/mL（拷贝/毫升）', true, true),
  ('cmv_pcr', 'KTX', '巨细胞病毒核酸定量', 'CMV PCR', 'CMV 复制监测字段。', '术后病毒监测时填写。', 'IU/mL（国际单位/毫升）', true, true),
  ('banff_diagnosis', 'KTX', 'Banff 病理诊断', 'Banff 诊断', '请记录 Banff 版本和分级。', '活检结果回报后填写。', NULL, true, true),
  ('abmr_event', 'KTX', '抗体介导排斥事件', 'ABMR 事件', '记录是否发生 ABMR 及日期。', '发生排斥事件时填写。', NULL, true, true),
  ('tcmr_event', 'KTX', 'T 细胞介导排斥事件', 'TCMR 事件', '记录是否发生 TCMR 及日期。', '发生排斥事件时填写。', NULL, true, true)
ON CONFLICT (code) DO UPDATE SET
  domain = EXCLUDED.domain,
  display_name_cn = EXCLUDED.display_name_cn,
  short_name_cn = EXCLUDED.short_name_cn,
  help_text_cn = EXCLUDED.help_text_cn,
  when_to_fill_cn = EXCLUDED.when_to_fill_cn,
  unit_cn = EXCLUDED.unit_cn,
  affects_export = EXCLUDED.affects_export,
  affects_qc = EXCLUDED.affects_qc;

INSERT INTO concept_alias_dictionary(concept_code, alias_cn, alias_en, priority) VALUES
  ('tacrolimus_c0', '谷浓度', 'tacrolimus_c0', 10),
  ('dd_cfdna_fraction_pct', 'dd-cfDNA', 'dd-cfDNA', 20),
  ('bk_plasma_pcr', 'BK 病毒', 'BK', 10),
  ('banff_diagnosis', '排斥', 'Banff', 30)
ON CONFLICT (concept_code, alias_cn) DO UPDATE SET
  alias_en = EXCLUDED.alias_en,
  priority = EXCLUDED.priority;

-- 6) 中文搜索入口：支持 code / 中文显示名 / 中文别名
CREATE OR REPLACE FUNCTION search_concepts_cn(
  p_keyword text,
  p_domain  text DEFAULT NULL,
  p_limit   integer DEFAULT 30
)
RETURNS TABLE (
  code             text,
  domain           text,
  display_name_cn  text,
  short_name_cn    text,
  matched_by       text
)
LANGUAGE sql
STABLE
AS $$
  WITH kw AS (
    SELECT trim(coalesce(p_keyword, '')) AS q
  )
  SELECT DISTINCT
    c.code,
    c.domain,
    c.display_name_cn,
    c.short_name_cn,
    CASE
      WHEN c.code ILIKE '%' || kw.q || '%' THEN 'code'
      WHEN c.display_name_cn ILIKE '%' || kw.q || '%' THEN 'display_name_cn'
      WHEN a.alias_cn ILIKE '%' || kw.q || '%' THEN 'alias_cn'
      ELSE 'other'
    END AS matched_by
  FROM concept_dictionary c
  CROSS JOIN kw
  LEFT JOIN concept_alias_dictionary a ON a.concept_code = c.code
  WHERE kw.q <> ''
    AND (p_domain IS NULL OR c.domain = p_domain)
    AND (
      c.code ILIKE '%' || kw.q || '%'
      OR c.display_name_cn ILIKE '%' || kw.q || '%'
      OR c.short_name_cn ILIKE '%' || kw.q || '%'
      OR a.alias_cn ILIKE '%' || kw.q || '%'
      OR coalesce(a.alias_en, '') ILIKE '%' || kw.q || '%'
    )
  ORDER BY c.domain, c.code
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 30), 200));
$$;

GRANT EXECUTE ON FUNCTION search_concepts_cn(text, text, integer) TO authenticated;

-- 7) 导出映射：中文版列名 + 英文 code
CREATE OR REPLACE VIEW v_concept_export_mapping AS
SELECT
  code AS english_code,
  display_name_cn AS chinese_column_name,
  short_name_cn AS chinese_short_name,
  domain,
  affects_export
FROM concept_dictionary
WHERE affects_export = true;

COMMENT ON VIEW v_concept_export_mapping IS '导出时使用的中英文字段对照表（中文列名导出默认来源）。';

-- MIGRATION 021: 0019_fix_visit_id_ambiguous.sql
-- 修复：patient_submit_visit_v2 中 "column reference visit_id is ambiguous"
-- 原因：RETURNS TABLE(visit_id uuid,...) 将 visit_id 注册为函数输出变量，
--       导致 ON CONFLICT (visit_id) 里 PostgreSQL 无法区分列名与输出变量。
-- 修复：改用 ON CONFLICT ON CONSTRAINT visit_receipts_pkey，消除歧义。

DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.patient_submit_visit_v2(
  p_token       text,
  p_visit_date  date,
  p_sbp         numeric DEFAULT NULL,
  p_dbp         numeric DEFAULT NULL,
  p_scr_umol_l  numeric DEFAULT NULL,
  p_upcr        numeric DEFAULT NULL,
  p_egfr        numeric DEFAULT NULL,
  p_notes       text    DEFAULT NULL
)
RETURNS TABLE(
  visit_id           uuid,
  server_time        timestamptz,
  receipt_token      text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token_row    patient_tokens%ROWTYPE;
  v_project_row  projects%ROWTYPE;
  v_visit_id     uuid;
  v_receipt      text;
  v_expires      timestamptz;
  v_recent_count int;
  v_same_day     int;
BEGIN
  -- ① 查 token，验证有效性
  SELECT * INTO v_token_row
  FROM patient_tokens t
  WHERE t.token = p_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found' USING HINT = 'token无效，请确认链接正确';
  END IF;

  -- ② token 是否已撤销
  IF v_token_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_revoked'
      USING HINT = '该随访链接已被管理员撤销：' || COALESCE(v_token_row.revoke_reason, '无原因说明');
  END IF;

  -- ③ token 是否已过期
  IF v_token_row.expires_at IS NOT NULL AND v_token_row.expires_at < now() THEN
    RAISE EXCEPTION 'token_expired' USING HINT = '随访链接已过期，请联系管理员重新生成';
  END IF;

  -- ④ token 是否仍激活
  IF NOT v_token_row.active THEN
    RAISE EXCEPTION 'token_inactive' USING HINT = '随访链接已停用';
  END IF;

  -- ⑤ 单次 token：已用过则拒绝
  IF v_token_row.single_use AND v_token_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_already_used'
      USING HINT = '该单次链接已于 ' || v_token_row.used_at::text || ' 提交过，如需重填请联系管理员';
  END IF;

  -- ⑥ 查项目
  SELECT * INTO v_project_row FROM projects WHERE id = v_token_row.project_id;

  -- ⑦ 检查写入权限（订阅/试用状态）
  PERFORM assert_project_write_allowed(v_token_row.project_id);

  -- ⑧ 核心字段校验
  IF p_visit_date IS NULL THEN
    RAISE EXCEPTION 'missing_visit_date' USING HINT = '随访日期必填';
  END IF;
  IF p_sbp IS NULL AND p_dbp IS NULL AND p_scr_umol_l IS NULL AND p_upcr IS NULL THEN
    RAISE EXCEPTION 'missing_core_fields'
      USING HINT = '至少填写一项核心指标（血压、血肌酐或尿蛋白/肌酐比）';
  END IF;

  -- ⑨ PII 检测
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    RAISE EXCEPTION 'pii_detected_blocked'
      USING HINT = '备注中疑似包含个人身份信息（手机号/身份证/住院号等），请删除后重新提交';
  END IF;

  -- ⑩ 频率限制：每分钟不超过 12 次
  SELECT COUNT(*) INTO v_recent_count
  FROM visits_long
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at  > now() - interval '1 minute';

  IF v_recent_count >= 12 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    INSERT INTO security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    VALUES (v_token_row.project_id, v_token_row.patient_code,
            encode(digest(p_token,'sha256'),'hex'),
            'rate_limit_exceeded', 'HIGH',
            jsonb_build_object('recent_count', v_recent_count, 'window', '1min'));
    RAISE EXCEPTION 'rate_limit_exceeded' USING HINT = '提交过于频繁，链接已被暂停';
  END IF;

  -- ⑪ 同日重复检测：每日不超过 6 次
  SELECT COUNT(*) INTO v_same_day
  FROM visits_long
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date  = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录
  INSERT INTO visits_long(
    project_id, patient_code, visit_date,
    sbp, dbp, scr_umol_l, upcr, egfr,
    egfr_formula_version,
    notes
  ) VALUES (
    v_token_row.project_id,
    v_token_row.patient_code,
    p_visit_date,
    p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr,
    CASE
      WHEN p_egfr IS NULL THEN NULL
      WHEN p_scr_umol_l IS NULL THEN 'missing_inputs'
      ELSE 'CKD-EPI-2021-Cr'
    END,
    LEFT(COALESCE(p_notes, ''), 500)
  )
  RETURNING id INTO v_visit_id;

  -- ⑬ 若 single_use，标记已使用
  IF v_token_row.single_use THEN
    UPDATE patient_tokens SET used_at = now() WHERE token = p_token;
  END IF;

  -- ⑭ 生成回执 token（24 小时有效）
  -- 使用 ON CONFLICT ON CONSTRAINT 而非 ON CONFLICT (visit_id)
  -- 避免与 RETURNS TABLE 中同名输出列产生歧义（PostgreSQL ambiguous 错误）
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT ON CONSTRAINT visit_receipts_pkey DO UPDATE
    SET receipt_token = v_receipt,
        expires_at    = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id',   v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;

-- MIGRATION 022: 0020_lab_extend_mn_ktx_dkd.sql
-- =============================================================
-- 0020 化验目录扩展：MN / KTX / DKD 专项化验项
--
-- 补充：
--   MN 模块   → PLA2R（抗PLA2R抗体）、CD19（CD19+ B细胞计数）
--   KTX 模块  → BKV（BK病毒载量）、CMV（巨细胞病毒载量）
--   GENERAL   → HBA1C（糖化血红蛋白）、UACR（尿白蛋白/肌酐比）
--
-- 依赖：0013_pr2_lab_catalog.sql（表结构已存在）
-- 所有 INSERT 均使用 ON CONFLICT DO NOTHING，可安全重跑
-- =============================================================

-- ─── 1. 单位字典扩展 ───────────────────────────────────────────────────────────
INSERT INTO unit_catalog(symbol, description) VALUES
  ('RU/mL',     '反应单位每毫升（PLA2R 抗体常用单位）'),
  ('cells/μL',  '细胞数每微升（B 细胞绝对计数）'),
  ('%',         '百分比（CD19% 或 HbA1c NGSP%）'),
  ('copies/mL', '拷贝数每毫升（病毒载量）'),
  ('mmol/mol',  '毫摩尔每摩尔（HbA1c IFCC 国际标准单位）')
ON CONFLICT (symbol) DO NOTHING;

-- ─── 2. 化验项目字典扩展 ───────────────────────────────────────────────────────
INSERT INTO lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  -- MN 专项：靶抗原抗体 + B 细胞监测
  ('PLA2R',  '抗PLA2R抗体',
             'Anti-PLA2R Antibody',
             'MN',      false, '56741-0', 'RU/mL',
             '<14 RU/mL 为阴性；≥14 RU/mL 阳性。滴度与疾病活动度相关，可预测缓解与复发。RTX/OBI 治疗后监测滴度下降。'),

  ('CD19',   'CD19+ B细胞计数',
             'CD19+ B-cell Count',
             'MN',      false, '8122-7',  'cells/μL',
             '正常成人约 100–500 cells/μL。RTX/OBI 治疗后 B 细胞耗竭监测，清除标准通常 <5 cells/μL，可用百分比（%）替代。'),

  -- KTX 专项：BK 病毒 + CMV 病毒载量
  ('BKV',    'BK病毒载量',
             'BK Virus DNA',
             'KTX',     false, '72495-5', 'copies/mL',
             '移植后常规筛查（术后 3 个月内每月 1 次，之后每 3 个月 1 次）。'
             '≥10,000 copies/mL 考虑减少免疫抑制剂；≥100,000 copies/mL 为高载量，需积极处理。'),

  ('CMV',    '巨细胞病毒载量',
             'CMV DNA',
             'KTX',     false, '72493-0', 'IU/mL',
             'WHO 国际标准单位 IU/mL。各中心治疗阈值不同，通常 >1000 IU/mL 考虑抗病毒治疗。'
             '高危受者（D+/R-）建议前 3–6 个月预防或监测。'),

  -- DKD / GENERAL 专项：血糖控制 + 尿白蛋白
  ('HBA1C',  '糖化血红蛋白',
             'Hemoglobin A1c',
             'GENERAL', false, '4548-4',  '%',
             'DKD 血糖控制目标：一般 <7.0%（<53 mmol/mol）；高龄/低血糖风险者可放宽至 <8.0%。'
             '反映过去 2–3 个月平均血糖水平。'),

  ('UACR',   '尿白蛋白/肌酐比',
             'Urine Albumin-Creatinine Ratio',
             'GENERAL', false, '9318-7',  'mg/g',
             '正常 <30 mg/g；微量白蛋白尿 30–300 mg/g；大量白蛋白尿 >300 mg/g。'
             '注意：UACR（测白蛋白）与 UPCR（测总蛋白）不同，DKD 研究优先用 UACR。')

ON CONFLICT (code) DO NOTHING;

-- ─── 3. 项目-单位换算表扩展 ───────────────────────────────────────────────────
-- 格式：value_standard = value_raw × multiplier + offset_val
INSERT INTO lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  -- PLA2R：仅 RU/mL 一种常用单位
  ('PLA2R', 'RU/mL',     1,       0,    true),

  -- CD19：绝对计数为标准；百分比原值存储（无绝对数无法换算）
  ('CD19',  'cells/μL',  1,       0,    true),
  ('CD19',  '%',         1,       0,    false),  -- 存原始%，不换算

  -- BKV：copies/mL 为标准；IU/mL 与 copies/mL 近似 1:1（WHO 标准差异 <5%，直接存）
  ('BKV',   'copies/mL', 1,       0,    true),
  ('BKV',   'IU/mL',     1,       0,    false),

  -- CMV：IU/mL 为 WHO 标准；copies/mL 与 IU/mL 近似等价直接记录
  ('CMV',   'IU/mL',     1,       0,    true),
  ('CMV',   'copies/mL', 1,       0,    false),

  -- HbA1c：% (NGSP) 为标准；mmol/mol (IFCC) 换算公式 % = mmol/mol × 0.0915 + 2.15
  ('HBA1C', '%',         1,       0,    true),
  ('HBA1C', 'mmol/mol',  0.0915,  2.15, false),  -- IFCC → NGSP%

  -- UACR：mg/g 为标准；mg/mmol (欧洲) 换算：1 mg/mmol × 8.842 = mg/g
  --        (肌酐分子量 113.12 g/mol，∴ 1 mmol = 113.12 mg，1 mg/mmol = 1000/113.12 mg/g ≈ 8.84)
  ('UACR',  'mg/g',      1,       0,    true),
  ('UACR',  'mg/mmol',   8.842,   0,    false)   -- 欧洲单位 → mg/g

ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- MIGRATION 023: 0021_project_custom_labs.sql
-- =============================================================
-- 0021 项目自定义化验目录
--
-- 每个研究项目可维护自己的化验目录（不在全局 lab_test_catalog 中的项目）。
-- 首次添加自定义化验时自动保存到本表，后续所有患者可直接从下拉中选用，
-- 保证同项目多患者、多中心录入时化验名称/单位一致。
-- =============================================================

CREATE TABLE IF NOT EXISTS project_custom_labs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,          -- 化验名，例如：补体因子H
  unit        text NOT NULL DEFAULT '',  -- 单位，例如：mg/L
  sort_order  int  NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)            -- 同一项目化验名不重复
);

COMMENT ON TABLE project_custom_labs IS
  '研究项目自定义化验目录；用户首次录入自定义化验时自动保存，后续同项目可直接选用。';

-- RLS：只有项目创建者可以读写
ALTER TABLE project_custom_labs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pcl_select" ON project_custom_labs;
CREATE POLICY "pcl_select" ON project_custom_labs
  FOR SELECT TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_insert" ON project_custom_labs;
CREATE POLICY "pcl_insert" ON project_custom_labs
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_update" ON project_custom_labs;
CREATE POLICY "pcl_update" ON project_custom_labs
  FOR UPDATE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_delete" ON project_custom_labs;
CREATE POLICY "pcl_delete" ON project_custom_labs
  FOR DELETE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

-- MIGRATION 024: 0022_admin_status_permissions.sql
-- ============================================================
-- 0022_admin_status_permissions.sql
-- 管理员状态权限增强
--
-- 新增：
--   1. 管理员永久写入豁免 — assert_project_write_allowed 检查创建者是否为管理员
--   2. admin_cancel_contract()   — 取消已批准/待审的合同
--   3. admin_update_contract()   — 修改合同字段（付款状态、到期时间、套餐等）
--   4. admin_set_expiry()        — 直接设定项目到期日期
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. 更新 assert_project_write_allowed：管理员项目永久放行
-- ──────────────────────────────────────────────────────────
create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trial_enabled  boolean;
  v_trial_expires  timestamptz;
  v_plan           text;
  v_sub_until      timestamptz;
  v_created_by     uuid;
begin
  select trial_enabled, trial_expires_at, subscription_plan, subscription_active_until, created_by
  into   v_trial_enabled, v_trial_expires, v_plan, v_sub_until, v_created_by
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- Rule 0: 项目创建者是平台管理员 → 永久放行
  if exists (
    select 1 from public.platform_admins pa
    join auth.users u on u.email = pa.email
    where u.id = v_created_by
  ) then
    return;
  end if;

  -- Rule A: 管理员已关闭试用限制
  if not v_trial_enabled then
    return;
  end if;

  -- Rule B: 付费订阅或合作伙伴计划有效
  if v_plan in ('pro', 'institution', 'partner') and
     (v_sub_until is null or now() <= v_sub_until) then
    return;
  end if;

  -- Rule C: 在试用期内
  if v_trial_expires is not null and now() <= v_trial_expires then
    return;
  end if;

  -- 以上均不满足 → 拒绝写入
  raise exception 'subscription_required';
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 2. admin_cancel_contract() — 取消合同（pending/approved → cancelled）
--    同时撤销该用户项目的订阅（如果已激活过）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_cancel_contract(
  p_contract_id uuid,
  p_admin_note  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_status  text;
  v_payment text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select user_id, status, payment_status
  into   v_user_id, v_status, v_payment
  from   public.partner_contracts
  where  id = p_contract_id;

  if not found then
    raise exception 'contract_not_found';
  end if;

  if v_status not in ('pending', 'approved') then
    raise exception 'only_pending_or_approved_can_cancel';
  end if;

  -- 取消合同
  update public.partner_contracts
  set
    status         = 'cancelled',
    admin_note     = coalesce(p_admin_note, admin_note),
    updated_at     = now()
  where id = p_contract_id;

  -- 如果已经付款激活过，撤销该用户所有项目的订阅 → 回到试用
  if v_payment = 'paid' then
    update public.projects
    set
      subscription_plan         = 'trial',
      subscription_active_until = null,
      trial_expires_at          = now() + interval '30 days',
      trial_grace_until         = now() + interval '37 days'
    where created_by = v_user_id;
  end if;
end;
$$;

grant execute on function public.admin_cancel_contract(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. admin_update_contract() — 通用合同更新
--    可修改：付款状态、到期时间、套餐、年费、折扣、备注
--    同时同步更新该用户的项目订阅
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_update_contract(
  p_contract_id      uuid,
  p_payment_status   text         default null,   -- 'unpaid'/'paid'/'overdue'
  p_expires_at       timestamptz  default null,
  p_plan             text         default null,   -- 'pro'/'institution'/'partner'
  p_annual_price     numeric      default null,
  p_discount_pct     int          default null,
  p_admin_note       text         default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_plan     text;
  v_expires  timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  -- 更新合同字段（只更新传入的非 null 参数）
  update public.partner_contracts
  set
    payment_status   = coalesce(p_payment_status, payment_status),
    expires_at       = coalesce(p_expires_at, expires_at),
    plan             = coalesce(p_plan, plan),
    annual_price_cny = coalesce(p_annual_price, annual_price_cny),
    discount_pct     = coalesce(p_discount_pct, discount_pct),
    admin_note       = coalesce(p_admin_note, admin_note),
    paid_at          = case
                         when p_payment_status = 'paid' and paid_at is null then now()
                         else paid_at
                       end,
    activated_at     = case
                         when p_payment_status = 'paid' and activated_at is null then now()
                         else activated_at
                       end,
    updated_at       = now()
  where id = p_contract_id
    and status in ('pending', 'approved');

  if not found then
    raise exception 'contract_not_found_or_not_editable';
  end if;

  -- 读取更新后的合同数据，同步到用户项目
  select user_id, coalesce(plan, apply_plan), expires_at
  into   v_user_id, v_plan, v_expires
  from   public.partner_contracts
  where  id = p_contract_id;

  -- 如果付款状态为 paid，同步更新项目订阅
  if coalesce(p_payment_status, (select payment_status from public.partner_contracts where id = p_contract_id)) = 'paid' then
    update public.projects
    set
      subscription_plan         = v_plan,
      subscription_active_until = v_expires
    where created_by = v_user_id;
  end if;
end;
$$;

grant execute on function public.admin_update_contract(uuid, text, timestamptz, text, numeric, int, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 4. admin_set_expiry() — 直接设定项目到期日期
--    可以同时修改 subscription_plan
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_set_expiry(
  p_project_id   uuid,
  p_expires_at   timestamptz,
  p_plan         text default null  -- 可选：同时修改计划
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_plan text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select subscription_plan into v_current_plan
  from public.projects where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- 根据当前计划更新对应字段
  if coalesce(p_plan, v_current_plan) = 'trial' then
    update public.projects
    set
      subscription_plan = 'trial',
      trial_expires_at  = p_expires_at,
      trial_grace_until = p_expires_at + interval '7 days'
    where id = p_project_id;
  else
    update public.projects
    set
      subscription_plan         = coalesce(p_plan, v_current_plan),
      subscription_active_until = p_expires_at
    where id = p_project_id;
  end if;
end;
$$;

grant execute on function public.admin_set_expiry(uuid, timestamptz, text) to authenticated;

-- MIGRATION 025: 0023_billing_orders.sql
-- ============================================================
-- 0023_billing_orders.sql
-- 半自动支付中心：订单、付款凭证、审计日志
--
-- 流程：
--   用户下单 → 扫码/转账 → 上传凭证 → 管理员核验 → 开通权益
--
-- 新增：
--   1. billing_orders          — 订单表
--   2. billing_payment_proofs  — 付款凭证
--   3. billing_audit_logs      — 审计日志
--   4. 用户权益字段扩展（project_quota 等）
--   5. RPC 函数：下单、上传凭证、管理员审核、开通
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. billing_orders 订单表
-- ──────────────────────────────────────────────────────────
create table if not exists public.billing_orders (
  id                  uuid        not null primary key default gen_random_uuid(),
  order_no            text        not null unique,       -- KS + YYYYMMDD + 6位随机码
  user_id             uuid        not null references auth.users(id) on delete cascade,

  -- 套餐信息
  plan_code           text        not null default 'pro'
                                  check (plan_code in ('pro','institutional')),
  billing_cycle       text        not null default 'monthly'
                                  check (billing_cycle in ('monthly','yearly')),
  project_quota       int         not null default 3,     -- 购买的项目配额
  extra_projects      int         not null default 0,     -- 超出基础3个的额外项目数

  -- 金额
  currency            text        not null default 'CNY',
  amount_due          numeric(10,2) not null,             -- 应付金额
  amount_paid         numeric(10,2),                      -- 实付金额（凭证上传时填）

  -- 支付
  payment_method      text        check (payment_method in ('wechat_qr','alipay_qr','bank_transfer')),

  -- 状态
  status              text        not null default 'unpaid'
                                  check (status in (
                                    'unpaid',                  -- 待付款
                                    'pending_verification',    -- 已提交凭证，待核验
                                    'paid',                    -- 已确认到账
                                    'activated',               -- 已开通权益
                                    'rejected',                -- 凭证驳回
                                    'cancelled',               -- 已取消
                                    'expired',                 -- 订单过期未支付
                                    'refund_pending',          -- 退款处理中
                                    'refunded'                 -- 已退款
                                  )),

  -- 付款人信息
  payer_name          text,
  payer_email         text,
  payer_hospital      text,
  payer_phone         text,

  -- 发票
  invoice_needed      boolean     not null default false,
  invoice_title       text,
  invoice_tax_no      text,
  invoice_email       text,
  invoice_status      text        default 'none'
                                  check (invoice_status in ('none','requested','issued')),

  -- 时间
  submitted_at        timestamptz,                        -- 凭证提交时间
  paid_at             timestamptz,                        -- 管理员确认到账时间
  activated_at        timestamptz,                        -- 权益开通时间
  start_at            timestamptz,                        -- 权益生效时间
  end_at              timestamptz,                        -- 权益到期时间

  -- 备注
  notes               text,                               -- 用户备注
  admin_notes         text,                               -- 管理员备注
  reject_reason       text,                               -- 驳回原因

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.billing_orders enable row level security;

-- 用户只能读自己的订单
drop policy if exists "user_own_orders_select" on billing_orders;
create policy "user_own_orders_select" on public.billing_orders
  for select using (auth.uid() = user_id);

-- 用户只能 insert 自己的订单（通过 RPC）
drop policy if exists "user_own_orders_insert" on billing_orders;
create policy "user_own_orders_insert" on public.billing_orders
  for insert with check (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────
-- 2. billing_payment_proofs 付款凭证表
-- ──────────────────────────────────────────────────────────
create table if not exists public.billing_payment_proofs (
  id            uuid        not null primary key default gen_random_uuid(),
  order_id      uuid        not null references public.billing_orders(id) on delete cascade,
  file_url      text        not null,
  file_name     text,
  file_type     text,                                     -- image/png, application/pdf 等
  uploaded_by   uuid        not null references auth.users(id),
  created_at    timestamptz not null default now()
);

alter table public.billing_payment_proofs enable row level security;

drop policy if exists "user_own_proofs_select" on billing_payment_proofs;
create policy "user_own_proofs_select" on public.billing_payment_proofs
  for select using (auth.uid() = uploaded_by);

drop policy if exists "user_own_proofs_insert" on billing_payment_proofs;
create policy "user_own_proofs_insert" on public.billing_payment_proofs
  for insert with check (auth.uid() = uploaded_by);

-- ──────────────────────────────────────────────────────────
-- 3. billing_audit_logs 审计日志表
-- ──────────────────────────────────────────────────────────
create table if not exists public.billing_audit_logs (
  id                uuid        not null primary key default gen_random_uuid(),
  order_id          uuid        not null references public.billing_orders(id) on delete cascade,
  action            text        not null,                 -- created, proof_uploaded, verified, activated, rejected, cancelled, refunded
  operator_user_id  uuid        references auth.users(id),
  before_json       jsonb,
  after_json        jsonb,
  created_at        timestamptz not null default now()
);

alter table public.billing_audit_logs enable row level security;

-- 仅管理员可读审计日志（通过 RPC）
-- 不给普通用户直接 select 权限

-- ──────────────────────────────────────────────────────────
-- 4. 用户权益扩展：在 user_profiles 加 project_quota
-- ──────────────────────────────────────────────────────────
alter table public.user_profiles
  add column if not exists project_quota int not null default 3;

-- ──────────────────────────────────────────────────────────
-- 5. 生成订单号的辅助函数
-- ──────────────────────────────────────────────────────────
create or replace function public.generate_order_no()
returns text
language plpgsql
as $$
declare
  v_date text;
  v_rand text;
  v_no   text;
begin
  v_date := to_char(now(), 'YYYYMMDD');
  -- 6位随机十六进制
  v_rand := upper(substr(md5(gen_random_uuid()::text), 1, 6));
  v_no   := 'KS' || v_date || v_rand;
  -- 碰撞检查
  while exists (select 1 from public.billing_orders where order_no = v_no) loop
    v_rand := upper(substr(md5(gen_random_uuid()::text), 1, 6));
    v_no   := 'KS' || v_date || v_rand;
  end loop;
  return v_no;
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 6. create_billing_order() — 用户下单
-- ──────────────────────────────────────────────────────────
create or replace function public.create_billing_order(
  p_plan_code       text,
  p_billing_cycle   text,
  p_extra_projects  int       default 0,
  p_payment_method  text      default null,
  p_payer_name      text      default null,
  p_payer_email     text      default null,
  p_payer_hospital  text      default null,
  p_payer_phone     text      default null,
  p_invoice_needed  boolean   default false,
  p_invoice_title   text      default null,
  p_invoice_tax_no  text      default null,
  p_invoice_email   text      default null,
  p_notes           text      default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_no      text;
  v_amount        numeric(10,2);
  v_extra         int;
  v_quota         int;
  v_order_id      uuid;
begin
  -- 验证参数
  if p_plan_code not in ('pro','institutional') then
    raise exception 'invalid_plan_code';
  end if;
  if p_billing_cycle not in ('monthly','yearly') then
    raise exception 'invalid_billing_cycle';
  end if;

  v_extra := greatest(coalesce(p_extra_projects, 0), 0);
  v_quota := 3 + v_extra;

  -- 价格计算：Pro 含 3 个项目
  if p_billing_cycle = 'monthly' then
    v_amount := 499 + v_extra * 99;
  else
    v_amount := 4790 + v_extra * 950;
  end if;

  v_order_no := public.generate_order_no();

  insert into public.billing_orders (
    order_no, user_id, plan_code, billing_cycle,
    project_quota, extra_projects, amount_due,
    payment_method,
    payer_name, payer_email, payer_hospital, payer_phone,
    invoice_needed, invoice_title, invoice_tax_no, invoice_email,
    notes, status
  ) values (
    v_order_no, auth.uid(), p_plan_code, p_billing_cycle,
    v_quota, v_extra, v_amount,
    p_payment_method,
    p_payer_name, p_payer_email, p_payer_hospital, p_payer_phone,
    coalesce(p_invoice_needed, false), p_invoice_title, p_invoice_tax_no, p_invoice_email,
    p_notes, 'unpaid'
  )
  returning id into v_order_id;

  -- 审计日志
  insert into public.billing_audit_logs (order_id, action, operator_user_id, after_json)
  values (v_order_id, 'created', auth.uid(), jsonb_build_object(
    'order_no', v_order_no, 'plan_code', p_plan_code,
    'billing_cycle', p_billing_cycle, 'amount_due', v_amount,
    'project_quota', v_quota
  ));

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_no', v_order_no,
    'amount_due', v_amount,
    'project_quota', v_quota
  );
end;
$$;

grant execute on function public.create_billing_order(text,text,int,text,text,text,text,text,boolean,text,text,text,text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. submit_payment_proof() — 用户上传凭证
-- ──────────────────────────────────────────────────────────
create or replace function public.submit_payment_proof(
  p_order_id      uuid,
  p_file_url      text,
  p_file_name     text      default null,
  p_file_type     text      default null,
  p_amount_paid   numeric   default null,
  p_payment_method text     default null,
  p_payer_name    text      default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 校验订单归属
  if not exists (
    select 1 from public.billing_orders
    where id = p_order_id and user_id = auth.uid()
      and status in ('unpaid', 'rejected')
  ) then
    raise exception 'order_not_found_or_not_payable';
  end if;

  -- 保存凭证
  insert into public.billing_payment_proofs (order_id, file_url, file_name, file_type, uploaded_by)
  values (p_order_id, p_file_url, p_file_name, p_file_type, auth.uid());

  -- 更新订单状态
  update public.billing_orders
  set
    status          = 'pending_verification',
    submitted_at    = now(),
    amount_paid     = coalesce(p_amount_paid, amount_paid),
    payment_method  = coalesce(p_payment_method, payment_method),
    payer_name      = coalesce(p_payer_name, payer_name),
    updated_at      = now()
  where id = p_order_id;

  -- 审计日志
  insert into public.billing_audit_logs (order_id, action, operator_user_id)
  values (p_order_id, 'proof_uploaded', auth.uid());
end;
$$;

grant execute on function public.submit_payment_proof(uuid,text,text,text,numeric,text,text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. get_my_orders() — 用户查看自己的订单列表
-- ──────────────────────────────────────────────────────────
create or replace function public.get_my_orders()
returns table (
  id              uuid,
  order_no        text,
  plan_code       text,
  billing_cycle   text,
  project_quota   int,
  amount_due      numeric,
  amount_paid     numeric,
  payment_method  text,
  status          text,
  start_at        timestamptz,
  end_at          timestamptz,
  created_at      timestamptz,
  submitted_at    timestamptz,
  reject_reason   text
)
language sql
security definer
set search_path = public
stable
as $$
  select id, order_no, plan_code, billing_cycle, project_quota,
         amount_due, amount_paid, payment_method, status,
         start_at, end_at, created_at, submitted_at, reject_reason
  from public.billing_orders
  where user_id = auth.uid()
  order by created_at desc;
$$;

grant execute on function public.get_my_orders() to authenticated;

-- ──────────────────────────────────────────────────────────
-- 9. admin_list_orders() — 管理员查看所有订单
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_list_orders(
  p_status text default null
)
returns table (
  id              uuid,
  order_no        text,
  user_id         uuid,
  owner_email     text,
  real_name       text,
  hospital        text,
  plan_code       text,
  billing_cycle   text,
  project_quota   int,
  amount_due      numeric,
  amount_paid     numeric,
  payment_method  text,
  status          text,
  payer_name      text,
  payer_email     text,
  payer_hospital  text,
  invoice_needed  boolean,
  invoice_status  text,
  submitted_at    timestamptz,
  paid_at         timestamptz,
  activated_at    timestamptz,
  start_at        timestamptz,
  end_at          timestamptz,
  notes           text,
  admin_notes     text,
  reject_reason   text,
  created_at      timestamptz,
  proof_count     bigint
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select
    o.id, o.order_no, o.user_id, u.email::text,
    pr.real_name, pr.hospital,
    o.plan_code, o.billing_cycle, o.project_quota,
    o.amount_due, o.amount_paid, o.payment_method,
    o.status, o.payer_name, o.payer_email, o.payer_hospital,
    o.invoice_needed, o.invoice_status,
    o.submitted_at, o.paid_at, o.activated_at,
    o.start_at, o.end_at,
    o.notes, o.admin_notes, o.reject_reason,
    o.created_at,
    (select count(*) from public.billing_payment_proofs bp where bp.order_id = o.id)
  from public.billing_orders o
  join auth.users u on u.id = o.user_id
  left join public.user_profiles pr on pr.user_id = o.user_id
  where (p_status is null or o.status = p_status)
  order by
    case o.status
      when 'pending_verification' then 0
      when 'unpaid' then 1
      when 'paid' then 2
      when 'activated' then 3
      else 4
    end,
    o.created_at desc;
end;
$$;

grant execute on function public.admin_list_orders(text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 10. admin_get_order_proofs() — 管理员查看订单凭证
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_get_order_proofs(p_order_id uuid)
returns table (
  id          uuid,
  file_url    text,
  file_name   text,
  file_type   text,
  created_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  return query
  select bp.id, bp.file_url, bp.file_name, bp.file_type, bp.created_at
  from public.billing_payment_proofs bp
  where bp.order_id = p_order_id
  order by bp.created_at desc;
end;
$$;

grant execute on function public.admin_get_order_proofs(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 11. admin_verify_order() — 管理员确认到账并开通
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_verify_order(
  p_order_id    uuid,
  p_start_at    timestamptz default null,
  p_end_at      timestamptz default null,
  p_admin_notes text        default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        public.billing_orders%rowtype;
  v_start        timestamptz;
  v_end          timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select * into v_order from public.billing_orders where id = p_order_id;
  if not found then
    raise exception 'order_not_found';
  end if;

  if v_order.status not in ('pending_verification', 'unpaid', 'paid') then
    raise exception 'order_status_invalid: %', v_order.status;
  end if;

  -- 计算生效/到期时间
  -- 如果用户还有剩余订阅，从到期日顺延
  v_start := coalesce(p_start_at, now());
  if v_order.billing_cycle = 'monthly' then
    v_end := coalesce(p_end_at, v_start + interval '1 month');
  else
    v_end := coalesce(p_end_at, v_start + interval '1 year');
  end if;

  -- 更新订单
  update public.billing_orders
  set
    status       = 'activated',
    paid_at      = coalesce(paid_at, now()),
    activated_at = now(),
    start_at     = v_start,
    end_at       = v_end,
    admin_notes  = coalesce(p_admin_notes, admin_notes),
    updated_at   = now()
  where id = p_order_id;

  -- 更新用户项目配额
  update public.user_profiles
  set
    project_quota = v_order.project_quota,
    updated_at    = now()
  where user_id = v_order.user_id;

  -- 升级该用户所有项目的订阅
  update public.projects
  set
    subscription_plan         = v_order.plan_code,
    subscription_active_until = v_end
  where created_by = v_order.user_id;

  -- 审计日志
  insert into public.billing_audit_logs (order_id, action, operator_user_id, after_json)
  values (p_order_id, 'activated', auth.uid(), jsonb_build_object(
    'start_at', v_start, 'end_at', v_end,
    'project_quota', v_order.project_quota,
    'plan_code', v_order.plan_code
  ));
end;
$$;

grant execute on function public.admin_verify_order(uuid, timestamptz, timestamptz, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 12. admin_reject_order() — 管理员驳回凭证
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_reject_order(
  p_order_id      uuid,
  p_reject_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  update public.billing_orders
  set
    status        = 'rejected',
    reject_reason = p_reject_reason,
    updated_at    = now()
  where id = p_order_id
    and status = 'pending_verification';

  if not found then
    raise exception 'order_not_found_or_not_pending';
  end if;

  insert into public.billing_audit_logs (order_id, action, operator_user_id, after_json)
  values (p_order_id, 'rejected', auth.uid(), jsonb_build_object('reason', p_reject_reason));
end;
$$;

grant execute on function public.admin_reject_order(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 13. 创建凭证上传的 Storage bucket
-- ──────────────────────────────────────────────────────────
-- NOTE: Supabase Storage bucket 需要在 Supabase Dashboard 创建：
--   名称：payment-proofs
--   公开：否（私有）
--   允许上传文件类型：image/png, image/jpeg, image/webp, application/pdf
--   最大文件大小：10MB

-- ──────────────────────────────────────────────────────────
-- 14. 用户项目配额检查函数
-- ──────────────────────────────────────────────────────────
create or replace function public.check_project_quota()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_quota   int;
  v_used    int;
begin
  select coalesce(project_quota, 3)
  into v_quota
  from public.user_profiles
  where user_id = auth.uid();

  -- 如果没有 profile，默认配额 3
  if not found then
    v_quota := 3;
  end if;

  select count(*)::int into v_used
  from public.projects
  where created_by = auth.uid();

  return jsonb_build_object(
    'quota', v_quota,
    'used', v_used,
    'remaining', greatest(v_quota - v_used, 0)
  );
end;
$$;

grant execute on function public.check_project_quota() to authenticated;

-- END
