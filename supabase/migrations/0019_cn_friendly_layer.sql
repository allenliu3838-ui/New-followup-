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
