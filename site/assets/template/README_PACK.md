# 科研数据与描述性分析包 — {{PROJECT_NAME}}

导出日期：{{EXPORT_DATE}}。这是原始数据、数据字典与可复核分析脚本；下载 ZIP 本身不代表分析已运行。

## 1. 原始数据与单位

`analysis/data/` 包含六张供脚本读取的原值 CSV 长表；`excel_safe/` 是适合用 Excel 打开的安全文本版本。请保留一份原包副本，不用 Excel 直接覆盖 CSV（编号 `001`、`1`、`NA` 必须作为原样字符串保留）。分析脚本按字符串读取标识；处理前要求每条非空记录包含 `project_id`、`center_code`、`patient_code`、原始记录 `id` 和 `module`。缺标识的旧导出请升级后重新导出；不能猜测项目或患者归属。

基线 UPCR 必须带经核实的 `baseline_upcr_unit`（mg/g 或 g/g）。无单位旧数据保留原值，但不参与 UPCR 变化、比例或阈值计算；由团队回溯来源核实。随访 UPCR 的存储单位为 mg/g。化验保留原值和单位，按每条记录显式单位换算；存储标准值与原值不一致时输出 QC，不按队列大小猜单位。

## 2. 安装与运行

在解压后的**包根目录**（包含 `analysis/` 的目录）打开终端。创建 Python 3.11 或 3.12 的独立环境，再安装锁定版本依赖：

```bash
python -m venv .venv
```

Windows：`.venv\Scripts\activate`；macOS/Linux：`source .venv/bin/activate`。然后：

```bash
python -m pip install -r analysis/requirements.txt
python analysis/run_analysis.py
```

成功时输出 `DESCRIPTIVE_REVIEW_OK` 及本次 `analysis/outputs/run-时间/` 路径。每次写新目录，旧结果不混入本次运行。出现 `ANALYSIS_FAILED` 应先解决源数据问题，不能把旧报告当成本次成功结果。

上面的命令**不带研究方案**，只做描述性整理和“未确认候选”筛查（见第 5 节）。要按研究方案判定持续终点，见第 4 节，命令为：

```bash
python analysis/run_analysis.py --protocol analysis/my_protocol.json
```

## 3. 多中心合并

把各中心**完整导出的六张 CSV** 分别放在 `centers/A/`、`centers/B/` 等目录。保留各项目真实身份，不把不同项目改成同一个 project_id。运行：

```bash
python analysis/merge_centers.py --dirs centers/A centers/B --out analysis/merged-data --qc merge_qc.xlsx
python analysis/run_analysis.py --data analysis/merged-data
```

只有看到 `MERGE_OK` 才运行第二条。合并不会把 `001` 与 `1`、不同项目同号、不同日期的重复事件自动去重。完全相同记录 ID 与内容的重复传输可幂等去重；同 ID 内容冲突或同患者多个不同基线会产生冲突报告并阻止输出。空的可选表也会写出合法表头。重跑请换新的输出目录，如 `analysis/merged-data-v2`，再把同一路径传给 `--data`。

**确认运行日志的 input_dir、input_sha256 和人数是合并后的输入，不能只运行默认命令而误分析旧的单中心 data。**

## 4. 研究方案文件（终点定义）

终点和缓解的定义属于研究方案，应由课题负责人（PI）确定，脚本不替研究者选择临床阈值。分析包附带 `analysis/protocol_template.json`，其中 IgAN、LN、MN 的缓解定义和 eGFR 下降阈值都是**示例**，注明了出处（如 KDIGO 2021 肾小球疾病指南相应章节），并全部标为 `"requires_pi_confirmation": true`。直接使用模板时，脚本不会计算任何终点，只在质控文件中说明“方案未确认”。

使用步骤：

1. 复制模板，如 `analysis/my_protocol.json`，修改 `protocol_id` 和 `version`（每次改动定义都应换版本号）。
2. PI 对照原文和本研究方案逐项核对、修改：
   - `baseline`：基线 eGFR / UPCR 取基线表记录，还是取基线日期前后若干天内的随访测量（`window_days`、`nearest` 或 `mean`）；
   - `egfr_decline`：下降阈值（如 40%）以及持续确认条件 `confirmation`——至少几次测量（`min_measurements`）、首末间隔至少几天（`min_interval_days`）、是否要求到最后一次测量仍低于阈值（`require_last_below`）；
   - `remission`：按病种分别写完全 / 部分缓解的 UPCR 条件、是否要求同日 eGFR 稳定、确认条件和评估时间窗；没有写的病种不计算；脚本算不了的条件（如血清白蛋白）列在 `additional_criteria_not_computed`，结果会标为“其余条件未评估”，需人工补核；
   - `censoring`：哪些随访状态（失访、退出、死亡、肾衰竭、转出）及哪些已确认事件（如 esrd、death）的日期作为截尾，截尾日之后的测量不参与判定；
   - `units`：阈值使用的单位。随访 UPCR 在登记系统中以 mg/g 保存，`units.upcr` 必须写 mg/g；与数据单位不一致时脚本拒绝运行，不会自动换算阈值。
3. 确认后把相应章节的 `requires_pi_confirmation` 改为 `false`，并在 `confirmation` 中填写确认人和日期（YYYY-MM-DD）。有章节标为已确认但没有确认人或日期时，脚本拒绝运行。
4. 字段名拼错、出现模板中没有的字段、数值越界都会导致拒绝运行，避免规则静默失效。以下划线开头的字段（如 `_说明`）是备注，脚本忽略。

判定方法：同一天的多次测量先取均值；从基线之后（使用基线窗口时从窗口结束之后）按日期排列，只有**连续**满足条件的测量（中间没有不满足的测量）达到规定次数、且首末间隔达到规定天数，才判定为“已按方案判定”；事件日期为这一串测量的第一次。一过性下降后恢复、两次测量间隔不足、只在最后一次测量满足，均不判定为事件，并在 `status_detail` 中写明原因。这是按方案参数的程序化判定，不等于临床终点委员会的人工裁定。

### 知情同意与随访状态

如果基线表有 `consent_status` 列，脚本默认只纳入状态为“已同意（consented）”或“伦理批准豁免（waiver）”的患者，其余患者（未确认、拒绝、撤回）的全部记录不进入任何结果，排除人数与各状态人数写在 `RUN_LOG.json` 的 `consent_filter`。没有该列时不做筛选，`RUN_LOG.json` 注明“未提供同意状态”，请研究团队自行核对伦理和同意范围。基线表有 `followup_status`、`followup_status_date` 列时，按方案 `censoring` 用作截尾；没有这两列时 `RUN_LOG.json` 会注明。

## 5. 输出与含义

- `RUN_LOG.json`：输入/输出 SHA-256、程序与依赖版本、计数、实际执行状态、运行模式（`candidates_only` 或 `protocol`）、知情同意筛选人数、研究方案全文及其 SHA-256。
- `table1_baseline.xlsx`：描述性人数、性别、基线均值/标准差及中位数/IQR、IgAN病理分类和完整身份键用药计数；各指标列出可用样本数。
- `patients_derived.csv`、`visits_derived.csv`：原始字段与派生字段分开；eGFR 原值保存在 egfr_recorded。
- `outcomes_12m.csv`：固定描述性窗口 270–450 天中选离365天最近的一整条访视；同距离按日期、记录ID排序，保留缺失与 tie_count。没有合格记录是“暂无可评估年度随访”，不会填0或用其他日期拼接。
- 不带 `--protocol` 时：`candidates_unconfirmed_egfr_decline.csv`、`candidates_unconfirmed_igan_proteinuria.csv` 是**未确认候选**——任何一次测量越过固定数值（eGFR ≤ 基线 60% 或 43%；IgAN 的 UPCR <300 mg/g，或 ≤ 基线 50% 且 <1000 mg/g）就列出，不要求持续确认，**不是终点，也不是缓解**。列名都以 `candidate_unconfirmed_` 开头；基线表（Table 1）不汇总任何“下降率”“缓解率”。
- 带 `--protocol` 时：`endpoints_per_protocol.csv` 每行是一名患者的一个终点，`determination` 列写“已按方案 <方案编号>@<版本> 判定”；`status` 为 met_per_protocol（满足）、not_met（未满足）、not_evaluable（缺基线等无法判定）或 upcr_egfr_criteria_met_other_criteria_not_evaluated（其余条件待人工补核）；同时给出事件日期、确认日期、基线值及来源、截尾日期与原因。`timepoints_per_protocol.csv` 是按方案名义时间点（±`visit_window_days`）选出的随访。`protocol_used.json` 是本次所用方案文件的原样副本；方案全文与 SHA-256 同时写入 `RUN_LOG.json` 和 `METHODS_ACTUAL_EN.md`。方案未覆盖或未确认的病种 / 章节不计算，在 `qc_issues.csv` 中说明。
- `manual_events_review.csv`：所有人工事件逐条保留；明确确认、有日期且在基线之后才标为 confirmed_in_followup，其他情况保留相应状态。
- `egfr_slope_per_patient.csv`：至少两个不同日期的描述性个人OLS斜率。同日多个eGFR先求均值；单日记录标为不可估计，不生成伪年斜率。
- `trend_*_patient_month.csv` 与 `plot_*_trend.png`：先按患者月份求均值，再按患者等权汇总；没有把重复行当独立患者计算置信区间。
- `labs_review.csv`、`qc_issues.csv`、`qc_report.xlsx`：单位与缺失/来源问题，需团队复核。
- `METHODS_ACTUAL_EN.md`：只描述本次真实执行的步骤与人数。
- `MODEL_STATUS.json`：明确列出暂停/未执行功能。

`analysis/data/` CSV 是供代码读取的原值数据，字符串不会被前缀改写。请勿把 `excel_safe/` 中已加安全文本前缀的版本替换到分析输入；否则研究编号和文字可能被改变。查看电子表格优先用 `excel_safe/` 或 XLSX；查看机器 CSV 时通过 Excel“从文本/CSV导入”把身份/文字列设为文本，不把未知文本解释成公式。

## 6. 本次明确未执行的功能

KFRE 风险计算已停用：旧实现用 UPCR 替代 UACR、猜测检验单位，未通过独立模型金标准验证；本包不输出风险数字。没有经 PI 确认的研究方案文件时，不判定完全 / 部分缓解或持续肾脏终点。LME 队列推断、置信区间、生存 / 因果分析在任何模式下都不执行；按方案判定的事件表可供研究者另行做统计分析。未确认候选和描述性结果不自动变成这些结论。

成人 CKD-EPI 2021 肌酐公式按 Inker 等原文 Table 2 实现，使用性别、血肌酐和“访视年份减出生年”的近似年龄；不是精确生日年龄。缺失/未知性别不当男性，未满18岁不使用该成人公式。原文：[NEJM 2021 作者稿与公式表](https://escholarship.org/content/qt3gj2d8m2/qt3gj2d8m2.pdf)。此实现不代替队列适用性与研究方案审查。

本分析使用六张核心表；额外CSV会在 RUN_LOG 的 additional_csv_not_analyzed 中列明，不能据此认为额外专病表也已完成统计。原始变异记录保留在输入包，本次未执行遗传变异解释。

本包不修改数据库，输入文件不被覆盖。平台导出记录号或本地运行哈希也不等于服务器已提供不可变快照及备份恢复服务。
