// 项目自定义入组字段：类型与取值规则、入组字段草案（REIGNITE、多囊肾）、单个患者录入的取值换算、CSV 模板与批量导入校验、显示与导出。
// 纯函数模块：不访问网络、不操作页面，便于浏览器测试直接加载。写入仍走 save_project_field、set_patient_field_values
// 和 import_registry_rows（数据库 check_patient_field_value 为最终校验，规则与这里一致）。

export const FIELD_TYPES = Object.freeze({ choice: '单选', multi_choice: '多选', yes_no: '是/否', number: '数值', date: '日期', text: '文本' });
export const MAX_FIELDS = 100;
export const TEXT_MAX = 200;
/** 导入行与导出文件用这些列放患者和项目标识，不能用作字段代码（与数据库 reserved_field_key 一致）。 */
export const RESERVED_KEYS = Object.freeze(['id', 'project_id', 'center_code', 'module', 'patient_code']);
export const YES_NO = Object.freeze({ yes: '是', no: '否' });
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NUMBER_TEXT = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$/;
const YES_NO_INPUT = Object.freeze({ yes: 'yes', no: 'no', y: 'yes', n: 'no', true: 'yes', false: 'no', 1: 'yes', 0: 'no', '是': 'yes', '否': 'no', '有': 'yes', '无': 'no' });
const PII_NOTICE = '不得包含姓名、身份证号、手机号、病案号；研究编号只用项目内编号。';

const len = text => [...String(text ?? '')].length;
const normal = text => String(text ?? '').normalize('NFKC').trim();
const lower = text => normal(text).toLowerCase();

// ── REIGNITE 入组字段草案 ─────────────────────────────────────
export const REIGNITE_SOURCE = 'REIGNITE 入组字段草案';
const options = list => list.map(([code, label]) => ({ code, label }));
/** 选项由本系统拟定，尚未与对方的病例报告表核对：载入后由项目负责人逐项核对、修改显示名称、增加选项或停用。 */
export const REIGNITE_DRAFT = Object.freeze([
  { field_key: 'inclusion_basis', label_cn: '入选依据', value_type: 'choice', help_cn: '按研究方案的入选标准选择；以对方病例报告表为准。',
    choices: options([['biopsy_proven', '肾活检确诊'], ['clinical', '临床诊断（未活检）'], ['other', '其他']]) },
  { field_key: 'ethnicity', label_cn: '民族', value_type: 'choice',
    choices: options([['han', '汉族'], ['zhuang', '壮族'], ['hui', '回族'], ['manchu', '满族'], ['uyghur', '维吾尔族'], ['miao', '苗族'],
      ['yi', '彝族'], ['tujia', '土家族'], ['tibetan', '藏族'], ['mongol', '蒙古族'], ['other', '其他民族'], ['unknown', '不详']]) },
  { field_key: 'autoimmune_disease', label_cn: '是否伴自身免疫病', value_type: 'yes_no' },
  { field_key: 'autoimmune_disease_type', label_cn: '自身免疫病类型', value_type: 'multi_choice', help_cn: '“是否伴自身免疫病”为“是”时填写，可多选。',
    choices: options([['sle', '系统性红斑狼疮'], ['ra', '类风湿关节炎'], ['sjogren', '干燥综合征'], ['thyroid', '自身免疫性甲状腺病'],
      ['ibd', '炎症性肠病'], ['psoriasis', '银屑病'], ['as', '强直性脊柱炎'], ['other', '其他']]) },
  { field_key: 'comorbidities', label_cn: '合并症', value_type: 'multi_choice', help_cn: '可多选；没有合并症选“无”。',
    choices: options([['hypertension', '高血压'], ['diabetes', '糖尿病'], ['cad', '冠心病'], ['stroke', '脑卒中'], ['heart_failure', '心力衰竭'],
      ['chronic_liver', '慢性肝病'], ['hbv', '乙型肝炎病毒感染'], ['malignancy', '恶性肿瘤'], ['other', '其他'], ['none', '无']]) },
  { field_key: 'fundus_exam', label_cn: '眼底检查', value_type: 'choice',
    choices: options([['normal', '正常'], ['hypertensive', '高血压性视网膜病变'], ['diabetic', '糖尿病视网膜病变'], ['other_abnormal', '其他异常'], ['not_done', '未检查']]) },
  { field_key: 'fundus_exam_date', label_cn: '眼底检查日期', value_type: 'date' },
].map(f => Object.freeze({ ...f, source: REIGNITE_SOURCE })));

// ── 多囊肾（ADPKD）入组字段草案 ───────────────────────────────
export const ADPKD_SOURCE = '多囊肾（ADPKD）入组字段草案';
/**
 * 参照意大利 ADPKD 登记（RIRP）与常用的 ADPKD 研究变量拟定，尚未与牵头单位的病例报告表核对：载入后由项目负责人逐项核对。
 * 不含基因检测结果：PKD1、PKD2 等结果须在人类遗传资源合规评估后再登记，这里只记录是否做过检测。
 */
export const ADPKD_DRAFT = Object.freeze([
  { field_key: 'adpkd_dx_basis', label_cn: '诊断依据', value_type: 'multi_choice', help_cn: '可多选。影像学诊断标准以研究方案为准。',
    choices: options([['imaging_family', '影像学诊断，有家族史'], ['imaging_no_family', '影像学诊断，无明确家族史'], ['genetic', '基因检测确诊'], ['other', '其他']]) },
  { field_key: 'family_history', label_cn: '多囊肾家族史', value_type: 'choice', help_cn: '父母、兄弟姐妹或子女等亲属中有多囊肾患者。',
    choices: options([['yes', '有'], ['no', '无'], ['unknown', '不详']]) },
  { field_key: 'age_at_diagnosis', label_cn: '确诊年龄', value_type: 'number', unit: '岁', min_value: 0, max_value: 100 },
  { field_key: 'hypertension', label_cn: '高血压', value_type: 'yes_no', help_cn: '既往诊断高血压，或正在服用降压药。' },
  { field_key: 'hypertension_onset_age', label_cn: '高血压确诊年龄', value_type: 'number', unit: '岁', min_value: 0, max_value: 100,
    help_cn: '“高血压”为“是”时填写。35 岁前出现高血压是进展风险评估（如 PROPKD 评分）用到的指标。' },
  { field_key: 'kidney_history', label_cn: '肾脏相关病史', value_type: 'multi_choice', help_cn: '可多选，记录到入组时为止的情况；都没有选“无”。',
    choices: options([['gross_hematuria', '肉眼血尿'], ['flank_pain', '慢性腰腹痛'], ['cyst_infection', '囊肿感染'], ['cyst_hemorrhage', '囊肿出血'],
      ['kidney_stones', '肾结石'], ['none', '无']]) },
  { field_key: 'first_urologic_event_age', label_cn: '首次泌尿系事件年龄', value_type: 'number', unit: '岁', min_value: 0, max_value: 100,
    help_cn: '首次出现肉眼血尿、腰腹痛或囊肿感染时的年龄，进展风险评估（如 PROPKD 评分）用到的指标。' },
  { field_key: 'liver_cysts', label_cn: '肝囊肿', value_type: 'choice', choices: options([['yes', '有'], ['no', '无'], ['not_assessed', '未评估']]) },
  { field_key: 'ia_family_history', label_cn: '颅内动脉瘤或蛛网膜下腔出血家族史', value_type: 'choice',
    choices: options([['yes', '有'], ['no', '无'], ['unknown', '不详']]) },
  { field_key: 'ia_screening', label_cn: '颅内动脉瘤筛查', value_type: 'choice', help_cn: '以磁共振血管成像等检查结果为准。',
    choices: options([['not_screened', '未筛查'], ['negative', '已筛查，未发现'], ['positive', '已筛查，发现动脉瘤']]) },
  { field_key: 'other_extrarenal', label_cn: '其他肾外表现', value_type: 'multi_choice', help_cn: '可多选；都没有选“无”。',
    choices: options([['pancreatic_cysts', '胰腺囊肿'], ['seminal_vesicle_cysts', '精囊囊肿'], ['arachnoid_cysts', '蛛网膜囊肿'],
      ['mitral_valve_prolapse', '二尖瓣脱垂'], ['abdominal_hernia', '腹壁疝'], ['other', '其他'], ['none', '无']]) },
  { field_key: 'genetic_testing', label_cn: '基因检测', value_type: 'choice',
    help_cn: '只记录是否做过。PKD1、PKD2 等检测结果须在人类遗传资源合规评估后再登记，不要写进备注或其他字段。',
    choices: options([['done', '已做'], ['not_done', '未做'], ['unknown', '不详']]) },
].map(f => Object.freeze({ ...f, source: ADPKD_SOURCE })));

/**
 * 可载入的入组字段草案。modules 为空时所有项目都提供；否则只在这些病种模块的项目中提供。
 * notice 是对话框顶部的说明（静态 HTML，只含本文件中的固定文字）。
 */
export const FIELD_PRESETS = Object.freeze({
  reignite: Object.freeze({ id: 'reignite', title: 'REIGNITE 入组字段草案', fields: REIGNITE_DRAFT, modules: null,
    notice: '这是本系统按 REIGNITE 入组信息拟定的草案，选项<b>尚未与对方的病例报告表核对</b>。载入后请项目负责人逐项核对：可以修改显示名称、增加选项或停用字段；字段代码与类型载入后不能更改。' }),
  adpkd: Object.freeze({ id: 'adpkd', title: '多囊肾（ADPKD）入组字段草案', fields: ADPKD_DRAFT, modules: Object.freeze(['ADPKD']),
    notice: '这是本系统参照意大利 ADPKD 登记和常用研究变量拟定的草案，<b>尚未与牵头单位的病例报告表核对</b>。不含基因检测结果：PKD1、PKD2 等结果须在人类遗传资源合规评估后再登记。载入后请项目负责人逐项核对：可以修改显示名称、增加选项或停用字段；字段代码与类型载入后不能更改。' }),
});
/** 某个病种模块的项目可以载入的草案。 */
export const presetsForModule = module => Object.values(FIELD_PRESETS).filter(p => !p.modules || p.modules.includes(String(module || '').toUpperCase()));

// ── 字段定义 ─────────────────────────────────────────────────
/** 选项文本：每行“代码 显示名称”（代码与名称之间用空格、等号或冒号分隔）。返回 { choices } 或 { error }。 */
export function parseChoicesText(text) {
  const choices = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^([^\s=:：]+)\s*[\s=:：]\s*(.+)$/);
    if (!m) return { error: `选项第 ${i + 1} 行缺少显示名称：每行写“代码 显示名称”，例如 han 汉族。` };
    choices.push({ code: m[1].trim(), label: m[2].trim() });
  }
  return { choices };
}
export function choicesText(choices) { return (choices || []).map(c => `${c.code} ${c.label}`).join('\n'); }

/** 字段定义的检查（与数据库 save_project_field 一致）：返回第一条问题，没有问题时返回空字符串。 */
export function definitionProblem(field, { others = [], previous = null } = {}) {
  const key = field.field_key;
  if (!previous) {
    if (!KEY_PATTERN.test(key || '')) return '字段代码以小写英文字母开头，只含小写字母、数字和下划线，2–40 个字符，例如 ethnicity。';
    if (RESERVED_KEYS.includes(key)) return `${key} 是系统列名，不能用作字段代码。`;
    if (!FIELD_TYPES[field.value_type]) return '请选择字段类型。';
    if (others.some(f => f.field_key === key)) return '本项目已有这个字段代码。';
  }
  const label = String(field.label_cn ?? '').trim();
  if (!label || len(label) > 60 || CONTROL.test(label)) return '显示名称 1–60 字，不能含换行等控制字符。';
  if (others.some(f => f.field_key !== key && f.label_cn === label)) return '本项目已有同名字段；显示名称须唯一（导入时可用显示名称作列名）。';
  if (field.help_cn && (len(field.help_cn) > 300 || CONTROL.test(field.help_cn))) return '填写说明最多 300 字，不能含换行等控制字符。';
  const type = previous?.value_type || field.value_type;
  if (type === 'choice' || type === 'multi_choice') {
    const list = field.choices || [];
    if (list.length < 2 || list.length > 60) return '单选和多选字段须有 2–60 个选项。';
    for (const c of list) {
      if (!CODE_PATTERN.test(c.code)) return `选项代码“${c.code}”须为小写字母、数字或下划线（最多 40 个字符）。`;
      if (!c.label || len(c.label) > 60 || CONTROL.test(c.label)) return `选项“${c.code}”的显示名称须为 1–60 字。`;
    }
    if (new Set(list.map(c => c.code)).size !== list.length) return '选项代码不能重复。';
    if (new Set(list.map(c => c.label)).size !== list.length) return '选项显示名称不能重复。';
    const clash = list.find(c => list.some(o => o !== c && o.code === lower(c.label)));
    if (clash) return `选项“${clash.label}”的显示名称与另一个选项的代码相同，导入时会产生歧义，请修改显示名称。`;
    const removed = (previous?.choices || []).filter(c => !list.some(n => n.code === c.code)).map(c => c.code);
    if (removed.length) return `已有选项不能删除（${removed.join('、')}）；可以修改显示名称，不再使用的选项可在名称中注明“停用”。`;
  }
  if (type === 'number') {
    const min = field.min_value, max = field.max_value;
    for (const [v, name] of [[min, '最小值'], [max, '最大值']]) if (v !== null && v !== undefined && v !== '' && !NUMBER_TEXT.test(String(v).trim())) return `${name}须为数字。`;
    if (min !== null && min !== '' && max !== null && max !== '' && min !== undefined && max !== undefined && Number(min) > Number(max)) return '最小值不能大于最大值。';
    if (field.unit && (len(field.unit) > 20 || CONTROL.test(field.unit))) return '单位最多 20 个字符。';
  }
  return '';
}

/** 字段的取值规则说明（模板说明、对话框提示）。 */
export function fieldRule(field) {
  const list = (field.choices || []).map(c => `${c.code}（${c.label}）`).join('、');
  switch (field.value_type) {
    case 'choice': return `单选：${list}；填代码或显示名称。`;
    case 'multi_choice': return `可多选：${list}；多个选项用分号分隔，填代码或显示名称。`;
    case 'yes_no': return '是/否：yes（是）或 no（否），也可填“是”“否”。';
    case 'number': {
      const range = field.min_value == null && field.max_value == null ? '' : `，范围 ${field.min_value ?? '不限'}–${field.max_value ?? '不限'}`;
      return `数字${range}${field.unit ? `，单位 ${field.unit}` : ''}；只填数字，不带单位。`;
    }
    case 'date': return '日期：YYYY-MM-DD，不能晚于今天（北京时间），不早于 1900-01-01。';
    default: return `文本：最多 ${TEXT_MAX} 字的单行文字，不得含身份信息。`;
  }
}

// ── 取值换算 ─────────────────────────────────────────────────
function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text;
}
function numberProblem(field, text) {
  if (!NUMBER_TEXT.test(text) || len(text) > 30) return `“${field.label_cn}”须为数字，不带单位。`;
  const n = Number(text);
  if ((field.min_value != null && n < Number(field.min_value)) || (field.max_value != null && n > Number(field.max_value))) {
    return `“${field.label_cn}”须在 ${field.min_value ?? '不限'}–${field.max_value ?? '不限'}${field.unit ? ` ${field.unit}` : ''} 之间。`;
  }
  return '';
}
function dateProblem(field, text, today) {
  if (!isDate(text)) return `“${field.label_cn}”不是有效日期，请按 YYYY-MM-DD 填写。`;
  if (today && text > today) return `“${field.label_cn}”不能晚于今天（北京时间 ${today}）。`;
  if (text < '1900-01-01') return `“${field.label_cn}”不能早于 1900-01-01。`;
  return '';
}
function textProblem(field, text, containsPII) {
  if (len(text) > TEXT_MAX) return `“${field.label_cn}”最多 ${TEXT_MAX} 字。`;
  if (CONTROL.test(text)) return `“${field.label_cn}”须为单行文字，不能含换行、制表符等控制字符。`;
  if (typeof containsPII === 'function' && containsPII(text)) return `“${field.label_cn}”中检测到疑似个人身份信息，请删除后再保存。${PII_NOTICE}`;
  return '';
}

/** 对话框中的输入 → 保存用的值（null 表示清除）。不合规时抛出中文说明。 */
export function inputToValue(field, raw, { today, containsPII } = {}) {
  const fail = message => { throw new Error(message); };
  switch (field.value_type) {
    case 'choice': {
      const code = String(raw ?? '');
      if (!code) return null;
      if (!(field.choices || []).some(c => c.code === code)) fail(`“${field.label_cn}”的选项无效，请刷新页面后重试。`);
      return code;
    }
    case 'multi_choice': {
      const picked = new Set(Array.isArray(raw) ? raw : []);
      if (!picked.size) return null;
      const codes = (field.choices || []).map(c => c.code).filter(c => picked.has(c));
      if (codes.length !== picked.size) fail(`“${field.label_cn}”的选项无效，请刷新页面后重试。`);
      return codes;
    }
    case 'yes_no': {
      const v = String(raw ?? '');
      if (!v) return null;
      if (!YES_NO[v]) fail(`“${field.label_cn}”只能选“是”或“否”。`);
      return v;
    }
    case 'number': {
      const t = String(raw ?? '').trim();
      if (!t) return null;
      const problem = numberProblem(field, t);
      if (problem) fail(problem);
      return t;
    }
    case 'date': {
      const t = String(raw ?? '').trim();
      if (!t) return null;
      const problem = dateProblem(field, t, today);
      if (problem) fail(problem);
      return t;
    }
    default: {
      const t = String(raw ?? '').trim();
      if (!t) return null;
      const problem = textProblem(field, t, containsPII);
      if (problem) fail(problem);
      return t;
    }
  }
}

/** CSV 单元格 → 导入值（文本）。选项可填代码或显示名称；返回 { value } 或 { reason, fix }。 */
export function cellToValue(field, cell, { today, containsPII } = {}) {
  const t = String(cell ?? '').trim();
  // 先按代码匹配，再按显示名称：某选项的名称恰好等于另一选项的代码时，以代码为准（导出文件写的是代码）。
  const choiceOf = text => (field.choices || []).find(c => c.code === lower(text)) || (field.choices || []).find(c => normal(c.label) === normal(text));
  switch (field.value_type) {
    case 'choice': {
      const c = choiceOf(t);
      return c ? { value: c.code } : { reason: `“${field.label_cn}”不在允许的选项中。`, fix: fieldRule(field) };
    }
    case 'multi_choice': {
      const parts = t.split(/[;；、]/).map(x => x.trim());
      if (parts.some(x => !x)) return { reason: `“${field.label_cn}”的选项之间有多余的分号或空项。`, fix: '多个选项用分号分隔，例如 hypertension;diabetes。' };
      const picked = parts.map(choiceOf);
      if (picked.some(c => !c)) return { reason: `“${field.label_cn}”含有不在允许选项中的值。`, fix: fieldRule(field) };
      if (new Set(picked.map(c => c.code)).size !== picked.length) return { reason: `“${field.label_cn}”的选项重复。`, fix: '每个选项只写一次。' };
      const codes = new Set(picked.map(c => c.code));
      return { value: field.choices.map(c => c.code).filter(c => codes.has(c)).join(';') };
    }
    case 'yes_no': {
      const v = YES_NO_INPUT[lower(t)];
      return v ? { value: v } : { reason: `“${field.label_cn}”只能填 yes / no（或 是 / 否）。`, fix: fieldRule(field) };
    }
    case 'number': {
      const problem = numberProblem(field, t);
      return problem ? { reason: problem, fix: fieldRule(field) } : { value: t };
    }
    case 'date': {
      const problem = dateProblem(field, t, today);
      return problem ? { reason: problem, fix: '按 YYYY-MM-DD 填写实际存在的日期。' } : { value: t };
    }
    default: {
      const problem = textProblem(field, t, containsPII);
      return problem ? { reason: problem, fix: PII_NOTICE } : { value: t };
    }
  }
}

/** 已保存的一行（value_text / value_codes / value_num / value_date）→ 对话框与导入比较用的值。 */
export function storedValue(field, row) {
  if (!row) return null;
  if (field.value_type === 'multi_choice') return Array.isArray(row.value_codes) ? row.value_codes : null;
  if (field.value_type === 'number') return row.value_num == null ? null : String(row.value_num);
  if (field.value_type === 'date') return row.value_date ?? null;
  return row.value_text ?? null;
}
/** 导入值（文本）与已保存的值是否相同：多选比较选项集合，数值按数值比较。 */
export function sameValue(field, row, text) {
  const current = storedValue(field, row);
  if (current == null) return false;
  if (field.value_type === 'multi_choice') {
    const a = new Set(current), b = String(text).split(';');
    return a.size === b.length && b.every(c => a.has(c));
  }
  if (field.value_type === 'number') return Number(current) === Number(text);
  return String(current) === String(text);
}
/** 显示用的中文文字。 */
export function valueDisplay(field, row) {
  const v = storedValue(field, row);
  if (v == null) return '';
  const label = code => (field.choices || []).find(c => c.code === code)?.label ?? code;
  if (field.value_type === 'multi_choice') return v.map(label).join('、');
  if (field.value_type === 'choice') return label(v);
  if (field.value_type === 'yes_no') return YES_NO[v] ?? v;
  if (field.value_type === 'number') return field.unit ? `${v} ${field.unit}` : v;
  return v;
}

// ── 模板、导入校验与导出 ──────────────────────────────────────
export const sortFields = fields => [...(fields || [])].sort((a, b) => a.sort_order - b.sort_order || a.field_key.localeCompare(b.field_key));
export const activeFields = fields => sortFields(fields).filter(f => f.active);

function csvCell(value, safe = true) {
  let s = value == null ? '' : String(value);
  if (safe && /^[\s]*[=+@\-]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** 模板 CSV（不含 BOM）：patient_code 与每个启用字段的代码作表头，一行虚构示例。 */
export function fieldsTemplateCsv(fields) {
  const list = activeFields(fields);
  const example = f => f.value_type === 'choice' ? f.choices[0].code
    : f.value_type === 'multi_choice' ? f.choices.slice(0, 2).map(c => c.code).join(';')
      : '';
  return [['patient_code', ...list.map(f => f.field_key)].join(','), ['DEMO-001', ...list.map(example)].map(c => csvCell(c, false)).join(',')].join('\r\n');
}
/** 模板填写说明的行：[列名, 中文名, 是否必填, 规则]。 */
export function fieldsTemplateHelp(fields) {
  return [['patient_code', '研究编号', '必填', '项目内已存在的研究编号；不存在的行阻断，不会自动建档。'],
    ...activeFields(fields).map(f => [f.field_key, f.label_cn, '选填', `${fieldRule(f)}${f.help_cn ? ` ${f.help_cn}` : ''} 留空表示不导入该项，不会清除已有的值。`])];
}

/**
 * 入组字段 CSV 的逐行校验，结果结构与 batch-import.js 的 validateBatch 相同（预览、分块提交与错误报告共用）。
 * ctx：{ patients: Map(研究编号→…), existing: Map(研究编号→Map(字段代码→已保存的行)), today, containsPII, lines, piiHeaders(headers) }。
 */
export function validateFieldsBatch(fields, headers, data, ctx = {}) {
  const lineOf = i => Number.isInteger(ctx.lines?.[i]) ? ctx.lines[i] : i + 2;
  const pii = typeof ctx.containsPII === 'function' ? ctx.containsPII : () => false;
  const patients = ctx.patients || new Map();
  const existing = ctx.existing || new Map();
  const all = sortFields(fields);
  const fileIssues = [];
  const byHeader = new Map(); const unknown = []; const inactive = []; const seen = new Map();
  for (const h of headers) {
    if (h === 'patient_code') continue;
    const f = all.find(x => x.field_key === h) || all.find(x => normal(x.label_cn) === normal(h));
    if (!f) { unknown.push(h); continue; }
    if (!f.active) { inactive.push(h); continue; }
    if (seen.has(f.field_key)) fileIssues.push({ col: `${seen.get(f.field_key)}、${h}`, level: 'block', reason: '两列对应同一个字段。', fix: '每个字段只保留一列。' });
    seen.set(f.field_key, h); byHeader.set(h, f);
  }
  const piiHeaders = typeof ctx.piiHeaders === 'function' ? ctx.piiHeaders(unknown) : [];
  if (piiHeaders.length) fileIssues.push({ col: piiHeaders.join('、'), level: 'block', reason: '表头含疑似个人信息列（姓名、身份证、手机、电话、病案号、住院号等），整份文件已拒绝。', fix: `请删除这些列后重新上传。${PII_NOTICE}` });
  const rest = unknown.filter(h => !piiHeaders.includes(h));
  if (rest.length) fileIssues.push({ col: rest.join('、'), level: 'block', reason: '包含本项目入组字段以外的列；列名须为字段代码或显示名称。', fix: `允许的列：patient_code、${activeFields(all).map(f => f.field_key).join('、')}。请下载最新模板。` });
  if (inactive.length) fileIssues.push({ col: inactive.join('、'), level: 'block', reason: '这些字段已停用，不能再导入。', fix: '删除这些列；需要继续使用时请项目负责人在“自定义入组字段”中重新启用。' });
  if (!headers.includes('patient_code')) fileIssues.push({ col: 'patient_code', level: 'block', reason: '缺少必需的列。', fix: '请下载最新模板，按模板表头填写。' });
  if (!byHeader.size && !fileIssues.length) fileIssues.push({ col: '表头', level: 'block', reason: '文件中没有任何入组字段列。', fix: '请下载最新模板，按模板表头填写。' });
  const rows = [];
  if (!fileIssues.length) data.forEach((cells, i) => {
    const line = lineOf(i);
    const issues = [];
    const block = (col, reason, fix = '') => issues.push({ col, level: 'block', reason, fix });
    const code = String(cells.patient_code ?? '').trim();
    const codePii = !!code && pii(code);
    if (!code) block('patient_code', '研究编号不能为空。', '填写项目内已存在的研究编号。');
    else if (len(code) > 64 || CONTROL.test(code)) block('patient_code', '研究编号须为 1–64 个字符，不能包含换行、制表符等控制字符。');
    else if (codePii) block('patient_code', '研究编号疑似包含个人信息（手机号、身份证号、病案号或 8 位以上连续数字）。', PII_NOTICE);
    else if (!patients.has(code)) block('patient_code', '本项目中没有该研究编号的患者。', '先在“新增患者”或基线导入中建档，或核对编号。');
    const payload = code ? { patient_code: code } : {};
    let filled = 0;
    for (const [h, f] of byHeader) {
      if (!String(cells[h] ?? '').trim()) continue;
      filled++;
      const r = cellToValue(f, cells[h], { today: ctx.today, containsPII: pii });
      if (r.reason) { block(h, r.reason, r.fix); continue; }
      const stored = existing.get(code)?.get(f.field_key);
      if (stored && !sameValue(f, stored, r.value)) { block(h, `该患者的“${f.label_cn}”已有不同的值，导入不会覆盖。`, '核对后在随访看板中打开该患者的“入组字段”修改，或删除该单元格。'); continue; }
      payload[f.field_key] = r.value;
    }
    const status = !filled && !issues.length ? 'ignored' : null;
    if (status) issues.push({ col: 'patient_code', level: 'info', reason: '该行没有填写任何字段，不导入。', fix: '' });
    rows.push({ line, patient_code: code, codePii, cells, payload, status, issues, mapKey: null, bizKey: null });
  });
  // 同一文件内同一患者同一字段填了不同的值：数据库会拒绝整块，这些行都阻断。
  const values = new Map();
  for (const r of rows) {
    if (r.status === 'ignored' || r.issues.some(x => x.level === 'block')) continue;
    for (const [k, v] of Object.entries(r.payload)) {
      if (k === 'patient_code') continue;
      const id = `${r.patient_code}\u0000${k}`;
      if (!values.has(id)) values.set(id, []);
      values.get(id).push({ r, v });
    }
  }
  for (const [id, list] of values) {
    if (new Set(list.map(x => x.v)).size < 2) continue;
    const key = id.split('\u0000')[1]; const f = all.find(x => x.field_key === key);
    const lines = list.map(x => x.r.line).join('、');
    list.forEach(({ r }) => r.issues.push({ col: key, level: 'block', reason: `同一患者的“${f?.label_cn ?? key}”在文件中有不同的值。`, fix: `第 ${lines} 行只保留一个正确的值。` }));
  }
  for (const r of rows) if (!r.status) r.status = r.issues.some(x => x.level === 'block') ? 'block' : r.issues.some(x => x.level === 'warn') ? 'warn' : 'ok';
  const counts = { total: data.length, writable: 0, warn: 0, block: 0, ignored: 0 };
  for (const r of rows) {
    if (r.status === 'ok' || r.status === 'warn') counts.writable++;
    if (r.status === 'warn') counts.warn++;
    if (r.status === 'block') counts.block++;
    if (r.status === 'ignored') counts.ignored++;
  }
  if (fileIssues.length) counts.block = data.length;
  return { kind: 'fields', fileIssues, rows, unmapped: [], counts };
}

/**
 * 导出：每位患者一行，列为 patient_code 与全部字段代码（含停用字段）；多选为分号分隔的代码。可直接作为导入文件。
 * 防公式前缀只加在研究编号和文本字段上：代码、日期不会以公式符号开头，数值（如 -5）加了前缀就无法再导入。
 */
export function fieldsExportCsv(fields, rows) {
  const list = sortFields(fields);
  const byPatient = new Map();
  for (const r of rows || []) {
    if (!byPatient.has(r.patient_code)) byPatient.set(r.patient_code, {});
    const f = list.find(x => x.field_key === r.field_key);
    if (!f) continue;
    const v = storedValue(f, r);
    byPatient.get(r.patient_code)[r.field_key] = Array.isArray(v) ? v.join(';') : v ?? '';
  }
  const header = ['patient_code', ...list.map(f => f.field_key)];
  const body = [...byPatient.keys()].sort().map(code => [csvCell(code), ...list.map(f => csvCell(byPatient.get(code)[f.field_key] ?? '', f.value_type === 'text'))].join(','));
  return [header.join(','), ...body].join('\r\n');
}
