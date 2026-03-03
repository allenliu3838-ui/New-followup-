# KidneySphere AI 中文友好化升级规范（面向中国医生）

## 目标
默认用户是中国医生、研究助理、护士、随访人员、PI。系统应满足：

- 不会英文也能独立使用。
- 不懂数据库也能完成录入、质控、导出。
- 首次使用 3 分钟内知道如何开始。
- 内部英文编码保留，但普通界面默认隐藏。

## 已落地的数据层能力

本仓库通过 `supabase/migrations/0019_cn_friendly_layer.sql` 建立中文优先基础层：

1. `concept_dictionary`
   - 保留 `code`（英文稳定编码）
   - 新增中文展示元数据：`display_name_cn`、`short_name_cn`、`help_text_cn`、`when_to_fill_cn`、`example_value_cn`、`unit_cn`、`common_mistakes_cn` 等。

2. `abbreviation_dictionary`
   - 维护缩写首次出现中文解释（KDPI、KDRI、DSA、dnDSA、dd-cfDNA、BK、CMV、EBV、Banff、CNI、mTORi、UPCR、UACR、eGFR、MCD、MN、MGRS、C3G）。

3. `concept_alias_dictionary`
   - 支持中文别名检索（如“肌酐”“尿蛋白”“谷浓度”“供者抗体”“排斥”“BK 病毒”）。

4. `search_concepts_cn(...)`
   - 支持按英文 code、中文显示名、中文别名统一搜索。

5. `v_concept_export_mapping`
   - 用于“中文列名导出（默认）/英文编码导出（高级）”映射。

## 前端实现要求（下一步）

- 默认“新手模式”：仅显示最少必填项、中文解释、进度卡片。
- 可切换“专业模式”：显示英文 code、导出别名、QC 规则、版本信息。
- 所有导航、按钮、标题使用中文说人话文案。
- 所有关键字段提供中文帮助（说明、何时填写、单位、示例、是否必填、是否影响导出/QC）。
- 日期采用 `YYYY-MM-DD`，提供快捷项（今天、昨天、移植日、肾穿日等）。
- 单位展示采用“符号 + 中文释义”，例如 `ng/mL（纳克/毫升）`。

## KTX 中文字段建议（已写入种子）

- `donor_type` → 供体类型
- `kdri` → 肾供体风险指数（KDRI）
- `kdpi` → 肾供体概况指数（KDPI）
- `tacrolimus_c0` → 他克莫司谷浓度（C0）
- `dd_cfdna_fraction_pct` → 供体来源细胞游离 DNA（dd-cfDNA，百分比）
- `bk_plasma_pcr` → BK 病毒血浆核酸定量
- `cmv_pcr` → 巨细胞病毒核酸定量
- `banff_diagnosis` → Banff 病理诊断
- `abmr_event` → 抗体介导排斥事件
- `tcmr_event` → T 细胞介导排斥事件

## 验收建议

1. 默认界面中文占比 ≥ 90%，普通页面不显示英文 raw code。
2. 核心缩写首次出现有中文解释。
3. 中文列名导出可用，英文编码导出可选。
4. 搜索支持中文全称、中文别名、英文缩写。
