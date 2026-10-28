// 化验记录 / 用药记录 / 终点事件 / 肾活检记录的 CSV 批量导入：模板、字段规则、化验项目映射、两级校验与错误报告。
// 纯函数模块：不访问网络、不操作页面，便于浏览器测试直接加载。写入仍走 import_registry_rows（数据库为最终校验）。

export const BATCH_KINDS = Object.freeze(['labs', 'meds', 'events', 'biopsies']);
export const CHUNK_SIZE = 500;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_ROWS = 10000;
export const PII_NOTICE = '不得包含姓名、身份证号、手机号、病案号；研究编号只用项目内编号。';
export const SKIP_MAPPING = '__skip__';

/** 写入数据库的列（与数据库 _registry_input_columns 一致）。 */
export const IMPORT_COLUMNS = Object.freeze({
  labs: ['patient_code', 'lab_date', 'lab_test_code', 'value_raw', 'unit_symbol', 'result_text', 'ref_range', 'abnormal_flag', 'notes'],
  meds: ['patient_code', 'drug_name', 'drug_class', 'dose_value', 'dose_unit', 'route', 'frequency', 'start_date', 'end_date', 'indication', 'notes'],
  events: ['patient_code', 'event_type', 'event_date', 'event_detail', 'evidence_source', 'notes'],
  biopsies: ['patient_code', 'biopsy_date', 'biopsy_kind', 'is_index', 'glomeruli_total', 'crescent_pct', 'oxford_m', 'oxford_e', 'oxford_s', 'oxford_t', 'oxford_c', 'notes'],
});
/** 模板列：化验额外有 lab_item_name（只用于映射化验项目，不写入数据库）。 */
export const TEMPLATE_COLUMNS = Object.freeze({
  labs: ['patient_code', 'lab_date', 'lab_test_code', 'lab_item_name', 'value_raw', 'unit_symbol', 'result_text', 'ref_range', 'abnormal_flag', 'notes'],
  meds: IMPORT_COLUMNS.meds,
  events: IMPORT_COLUMNS.events,
  biopsies: IMPORT_COLUMNS.biopsies,
});
const REQUIRED_COLUMNS = Object.freeze({ labs: ['patient_code', 'lab_date'], meds: ['patient_code', 'drug_name', 'start_date'], events: ['patient_code', 'event_type', 'event_date', 'evidence_source'], biopsies: ['patient_code', 'biopsy_date', 'biopsy_kind'] });

export const DRUG_CLASSES = Object.freeze(['RAS阻断剂', 'SGLT2抑制剂', '糖皮质激素', '免疫抑制剂', '利尿剂', '降压药（其他）', '降糖药（其他）', '降脂药', '抗凝/抗血小板',
  '内皮素受体拮抗剂', '补体抑制剂', '盐皮质激素受体拮抗剂', '预防性抗生素', '试验药物', '疫苗', '其他']);
/** 药物类别的常见英文缩写写法（导入时可直接填写）。 */
const DRUG_CLASS_INPUT = Object.freeze({ era: '内皮素受体拮抗剂', mra: '盐皮质激素受体拮抗剂', vaccine: '疫苗', '疫苗接种': '疫苗', '研究药物': '试验药物' });
export const ROUTES = Object.freeze({ PO: '口服', IV: '静脉', SC: '皮下注射', IM: '肌肉注射', topical: '外用', other: '其他' });
export const IMPORTABLE_EVENTS = Object.freeze({ esrd: '终末期肾病', dialysis_start: '开始透析', kidney_transplant: '肾移植', death: '死亡', relapse: '复发', serious_infection: '严重感染', hospitalization: '住院', custom: '其他' });
/** 须在事件细节中写明内容的事件类型（与数据库 check_clinical_row 一致）。 */
export const DETAIL_REQUIRED_EVENTS = Object.freeze(['custom', 'serious_infection', 'hospitalization']);
export const BIOPSY_KINDS = Object.freeze({ native: '自体肾', transplant: '移植肾' });
export const DERIVED_EVENTS = Object.freeze(['egfr_decline_40pct', 'egfr_decline_57pct', 'complete_remission', 'partial_remission']);
export const EVIDENCE_SOURCES = Object.freeze({ medical_record: '病历记录', lab_review: '化验数据复核', phone_followup: '电话随访', death_certificate: '死亡证明', other: '其他' });
/** 终点事件中需要同时在“研究状态”登记的类型（患者随访状态仍为“在访”时给警告）。 */
const STATUS_EVENTS = new Set(['death', 'esrd', 'dialysis_start', 'kidney_transplant']);

export const KIND_LABELS = Object.freeze({ baseline: '患者基线', visits: '随访记录', labs: '化验记录', meds: '用药记录', events: '终点事件', biopsies: '肾活检记录', fields: '入组字段' });

export const TEMPLATES = Object.freeze({
  labs: {
    filename: 'template_labs_v1.csv', label: '化验记录', version: 'v1',
    examples: [
      { patient_code: 'DEMO-001', lab_date: '2025-08-02', lab_test_code: 'CREAT', lab_item_name: '血肌酐', value_raw: '171', unit_symbol: 'μmol/L', ref_range: '57-111', abnormal_flag: 'H' },
      { patient_code: 'DEMO-001', lab_date: '2025-08-02', lab_test_code: '', lab_item_name: '尿蛋白肌酐比', value_raw: '1739', unit_symbol: 'mg/g', ref_range: '0-150', abnormal_flag: 'H', notes: '编码留空时按名称映射' },
      { patient_code: 'DEMO-002', lab_date: '2025-09-10', lab_test_code: 'DSDNA', lab_item_name: '抗dsDNA抗体', result_text: '阴性', abnormal_flag: 'N', notes: '定性结果示例' },
    ],
    fields: [
      ['patient_code', '研究编号', '必填', '项目内已存在的研究编号；不存在的行阻断，不会自动建档。'],
      ['lab_date', '化验日期', '必填', 'YYYY-MM-DD，不能晚于今天，不早于 1900-01-01。'],
      ['lab_test_code', '化验项目编码', '编码或名称至少一项', '系统化验字典编码，例如 CREAT（血肌酐）、UPCR、EGFR、ALB、HGB、IGA、CYSC（胱抑素 C）。留空或不在字典时按名称映射。'],
      ['lab_item_name', '化验项目名称', '选填', '仅用于映射到字典（如 血肌酐、Scr、尿蛋白肌酐比），不写入数据库；匹配不上的进入“未映射项目”清单。'],
      ['value_raw', '结果数值', '数值与结果文本至少一项', '纯数字；“<5”“阳性”等请填结果文本。'],
      ['unit_symbol', '单位', '填数值时必填', '须为该项目允许的单位（如肌酐 μmol/L 或 mg/dL）；与标准单位不同时系统自动换算。尿红细胞按报告单位分为两个项目：URBC_UL（个/μL）与 URBC_HPF（个/HPF），两者不换算；只写名称“尿红细胞”时按单位确定项目。'],
      ['result_text', '结果文本', '选填', '定性结果，如 阴性、+、++，最多 50 字。'],
      ['ref_range', '参考范围', '选填', '原样保留，如 57-111，最多 50 字。'],
      ['abnormal_flag', '异常标志', '选填', 'H（高）、L（低）、N（正常）；与参考范围不一致时给警告。'],
      ['notes', '备注', '选填', '最多 500 字，勿填身份信息。'],
    ],
  },
  meds: {
    filename: 'template_meds_v1.csv', label: '用药记录', version: 'v1',
    examples: [
      { patient_code: 'DEMO-001', drug_name: '缬沙坦', drug_class: 'RAS阻断剂', dose_value: '80', dose_unit: 'mg', route: 'PO', frequency: 'qd', start_date: '2024-07-27', indication: '降蛋白尿' },
      { patient_code: 'DEMO-001', drug_name: '达格列净', drug_class: 'SGLT2抑制剂', dose_value: '10', dose_unit: 'mg', route: 'PO', frequency: 'qd', start_date: '2024-07-27', indication: '肾脏保护' },
      { patient_code: 'DEMO-002', drug_name: '泼尼松', drug_class: '糖皮质激素', dose_value: '30', dose_unit: 'mg', route: 'PO', frequency: 'qd', start_date: '2024-05-21', end_date: '2024-11-20', indication: '免疫抑制', notes: '后逐步减量停药' },
    ],
    fields: [
      ['patient_code', '研究编号', '必填', '项目内已存在的研究编号。'],
      ['drug_name', '药物名称', '必填', '通用名优先，如 缬沙坦、达格列净。'],
      ['drug_class', '药物类别', '选填', `只能为：${DRUG_CLASSES.join('、')}。疫苗接种也在用药记录中登记：药物名称写疫苗名称，类别填“疫苗”，起始日期为接种日期。`],
      ['dose_value', '单次剂量数值', '选填', '大于 0 的数字，与剂量单位成对填写；只填其一给警告。'],
      ['dose_unit', '剂量单位', '选填', '如 mg、g、IU、mL，最多 20 字。'],
      ['route', '给药途径', '选填', 'PO（口服）、IV（静脉）、SC（皮下）、IM（肌注）、topical（外用）、other（其他）。'],
      ['frequency', '频次', '选填', '如 qd、bid、tid、qod、qw，最多 20 字。'],
      ['start_date', '起始日期', '必填', 'YYYY-MM-DD；只知年月时填当月 1 日并在备注注明“日期为估计”。剂量调整请新起一行。'],
      ['end_date', '结束日期', '选填', '留空表示持续用药；不能早于起始日期。'],
      ['indication', '用药目的', '选填', '如 降蛋白尿、控制血压，最多 100 字。'],
      ['notes', '备注', '选填', '停药原因、不良反应等，最多 500 字，勿填身份信息。'],
    ],
  },
  events: {
    filename: 'template_events_v1.csv', label: '终点事件', version: 'v1',
    examples: [
      { patient_code: 'DEMO-001', event_type: 'esrd', event_date: '2025-01-24', event_detail: 'eGFR 进行性下降至终末期肾病', evidence_source: 'lab_review' },
      { patient_code: 'DEMO-002', event_type: 'dialysis_start', event_date: '2025-03-02', event_detail: '维持性血液透析', evidence_source: 'medical_record' },
      { patient_code: 'DEMO-003', event_type: 'custom', event_date: '2025-05-20', event_detail: '急性肾损伤住院', evidence_source: 'phone_followup', notes: '演示数据' },
    ],
    fields: [
      ['patient_code', '研究编号', '必填', '项目内已存在的研究编号。'],
      ['event_type', '事件类型', '必填', 'esrd（终末期肾病）、dialysis_start（开始透析）、kidney_transplant（肾移植）、death（死亡）、relapse（复发）、serious_infection（严重感染）、hospitalization（住院）、custom（其他）；后三种须填事件细节。疫苗接种请用用药记录模板导入（药物类别“疫苗”）。eGFR 下降与缓解由分析脚本按研究方案计算，不接受导入。'],
      ['event_date', '事件日期', '必填', 'YYYY-MM-DD，事件实际发生日；死亡以死亡日期为准。'],
      ['event_detail', '事件细节', 'custom、serious_infection、hospitalization 时必填', '如透析方式、移植类型、感染部位或诊断、住院原因，最多 500 字。'],
      ['evidence_source', '判定依据来源', '必填', 'medical_record（病历记录）、lab_review（化验数据复核）、phone_followup（电话随访）、death_certificate（死亡证明）、other（其他）。'],
      ['notes', '备注', '选填', '最多 500 字，勿填身份信息。'],
    ],
  },
  biopsies: {
    filename: 'template_biopsies_v1.csv', label: '肾活检记录', version: 'v1',
    examples: [
      { patient_code: 'DEMO-001', biopsy_date: '2023-03-15', biopsy_kind: 'native', is_index: 'true', glomeruli_total: '24', crescent_pct: '8.3', oxford_m: '1', oxford_e: '0', oxford_s: '1', oxford_t: '0', oxford_c: '1', notes: '确诊活检' },
      { patient_code: 'DEMO-001', biopsy_date: '2025-06-02', biopsy_kind: 'native', is_index: 'false', glomeruli_total: '18', crescent_pct: '0', oxford_m: '1', oxford_e: '0', oxford_s: '1', oxford_t: '1', oxford_c: '0', notes: '重复活检' },
      { patient_code: 'DEMO-002', biopsy_date: '2024-11-20', biopsy_kind: 'transplant', is_index: 'false', glomeruli_total: '15', notes: '移植肾活检示例' },
    ],
    fields: [
      ['patient_code', '研究编号', '必填', '项目内已存在的研究编号。'],
      ['biopsy_date', '活检日期', '必填', 'YYYY-MM-DD，不能晚于今天，不早于 1900-01-01。'],
      ['biopsy_kind', '活检类型', '必填', 'native（自体肾）或 transplant（移植肾），也可填“自体肾”“移植肾”。同一患者同一日期同一类型只能一行。'],
      ['is_index', '基准活检', '选填', 'true（是）或 false（否），也可填“是”“否”；留空为否。按活检日对齐导出时以基准活检的日期为第 0 天，通常是确诊活检；每位患者最多一次。'],
      ['glomeruli_total', '肾小球总数', '选填', '0–999 的整数。'],
      ['crescent_pct', '新月体比例', '选填', '含新月体的肾小球占全部肾小球的百分比，0–100，不带 % 符号，例如 8.3。'],
      ['oxford_m', '牛津分型 M', '选填', '0 或 1（IgA 肾病）。'],
      ['oxford_e', '牛津分型 E', '选填', '0 或 1。'],
      ['oxford_s', '牛津分型 S', '选填', '0 或 1。'],
      ['oxford_t', '牛津分型 T', '选填', '0、1 或 2。'],
      ['oxford_c', '牛津分型 C', '选填', '0、1 或 2；与新月体比例同时填写时须一致：C0 为 0，C1 小于 25，C2 为 25 及以上。'],
      ['notes', '备注', '选填', '最多 500 字，勿填身份信息；不要粘贴病理报告原文。'],
    ],
  },
});

/** 常见化验名称 / 缩写 → 字典编码（以迁移 0013、0020 中 lab_test_catalog 的实际编码为准；运行时只保留字典中存在的编码）。 */
export const LAB_ALIASES = Object.freeze({
  CREAT: ['scr', 'cr', 'crea', 'creat', 'creatinine', 'serumcreatinine', '肌酐', '血肌酐', '血清肌酐'],
  UPCR: ['upcr', 'pcr', 'uprot/cr', '尿蛋白肌酐比', '尿蛋白/肌酐比', '尿蛋白肌酐比值', '尿蛋白/肌酐比值', '尿总蛋白/肌酐比', '尿蛋白/尿肌酐'],
  EGFR: ['egfr', 'egfr(ckd-epi)', '估算肾小球滤过率', '估算的肾小球滤过率'],
  HGB: ['hb', 'hgb', 'hemoglobin', '血红蛋白'],
  ALB: ['alb', 'albumin', '白蛋白', '血清白蛋白', '血白蛋白'],
  IGA: ['iga', '血清iga', '免疫球蛋白a'],
  IGAG: ['iga/igg', 'iga/igg比值'],
  UACR: ['uacr', 'acr', '尿白蛋白肌酐比', '尿白蛋白/肌酐比', '尿微量白蛋白/肌酐比', '尿微量白蛋白肌酐比'],
  UA: ['uricacid', '尿酸', '血尿酸'],
  K: ['k', 'potassium', '钾', '血钾'],
  NA: ['na', 'sodium', '钠', '血钠'],
  CA: ['calcium', '钙', '血钙'],
  PHOS: ['p', 'phos', 'phosphorus', '磷', '血磷'],
  CO2: ['hco3', 'hco3-', '碳酸氢根', '碳酸氢盐'],
  TCHOL: ['tc', 'chol', 'tcho', '总胆固醇'],
  TG: ['tg', 'triglycerides', '甘油三酯'],
  LDL: ['ldl', 'ldl-c', 'ldlc', '低密度脂蛋白', '低密度脂蛋白胆固醇'],
  HDL: ['hdl', 'hdl-c', 'hdlc', '高密度脂蛋白', '高密度脂蛋白胆固醇'],
  WBC: ['wbc', '白细胞', '白细胞计数'],
  PLT: ['plt', '血小板', '血小板计数'],
  ALT: ['alt', 'gpt', '谷丙转氨酶', '丙氨酸氨基转移酶'],
  AST: ['ast', 'got', '谷草转氨酶', '天门冬氨酸氨基转移酶'],
  CRP: ['crp', 'c反应蛋白'],
  C3: ['c3', '补体c3'],
  C4: ['c4', '补体c4'],
  DSDNA: ['dsdna', 'anti-dsdna', '抗dsdna', '抗dsdna抗体', '抗双链dna抗体'],
  TACRO: ['tac', 'fk506', 'tacrolimus', '他克莫司', '他克莫司浓度', '他克莫司谷浓度'],
  CSA: ['csa', 'cya', 'cyclosporine', '环孢素', '环孢素浓度'],
  HBA1C: ['hba1c', 'a1c', '糖化血红蛋白'],
  CYSC: ['cysc', 'cys-c', 'cystatinc', '胱抑素c', '胱抑素', '血胱抑素c', '血清胱抑素', '胱抑素c(cysc)'],
  // 尿红细胞的通用名称同时指向两个项目，由单位确定（matchLabByUnit）；带方法的名称直接对应一个项目。
  URBC_UL: ['尿红细胞', '尿红细胞计数', '尿液红细胞', '尿沉渣红细胞', '红细胞(尿)', '尿rbc', 'urbc', '尿红细胞(仪器)', '尿红细胞定量', '尿红细胞/μl'],
  URBC_HPF: ['尿红细胞', '尿红细胞计数', '尿液红细胞', '尿沉渣红细胞', '红细胞(尿)', '尿rbc', 'urbc', '尿红细胞(镜检)', '镜检红细胞', '尿沉渣镜检红细胞', '尿红细胞/hpf'],
  PLA2R: ['pla2r', 'pla2r-ab', '抗pla2r抗体'],
});

const EVENT_INPUT = Object.freeze({
  esrd: 'esrd', '终末期肾病': 'esrd', '终末期肾病(esrd)': 'esrd',
  dialysis_start: 'dialysis_start', dialysis: 'dialysis_start', '开始透析': 'dialysis_start', '透析': 'dialysis_start',
  kidney_transplant: 'kidney_transplant', transplant: 'kidney_transplant', '肾移植': 'kidney_transplant',
  death: 'death', '死亡': 'death', relapse: 'relapse', '复发': 'relapse',
  serious_infection: 'serious_infection', '严重感染': 'serious_infection', hospitalization: 'hospitalization', '住院': 'hospitalization',
  custom: 'custom', other: 'custom', '其他': 'custom',
});
/** 疫苗接种不再是终点事件类型（迁移 0043），改在用药记录中登记。 */
const VACCINE_EVENT_INPUT = new Set(['vaccination', 'vaccine', '疫苗接种', '疫苗']);
const BIOPSY_KIND_INPUT = Object.freeze({ native: 'native', '自体肾': 'native', '自体': 'native', '原肾': 'native', transplant: 'transplant', '移植肾': 'transplant', '移植': 'transplant' });
const BOOLEAN_INPUT = Object.freeze({ true: true, false: false, '是': true, '否': false, yes: true, no: false, y: true, n: false, 1: true, 0: false });
const DERIVED_INPUT = /^(egfr_decline(_\d+pct)?|egfr下降.*|.*_remission|remission_.*|完全缓解|部分缓解|缓解)$/;
const EVIDENCE_INPUT = Object.freeze(Object.fromEntries(Object.entries(EVIDENCE_SOURCES).flatMap(([code, label]) => [[code, code], [label, code]])));
const ROUTE_INPUT = Object.freeze({ po: 'PO', iv: 'IV', sc: 'SC', im: 'IM', topical: 'topical', other: 'other', '口服': 'PO', '静脉': 'IV', '静脉注射': 'IV', '静脉滴注': 'IV', '皮下': 'SC', '皮下注射': 'SC', '肌注': 'IM', '肌肉注射': 'IM', '外用': 'topical', '其他': 'other' });
const FLAG_INPUT = Object.freeze({ h: 'H', l: 'L', n: 'N', '高': 'H', '低': 'L', '正常': 'N', '↑': 'H', '↓': 'L' });

/** 名称比较用：全角转半角、小写、去空白与常见分隔符。 */
export function labKey(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s_·]/g, '').replace(/（/g, '(').replace(/）/g, ')');
}
const enumKey = text => String(text ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');

/** 单位写法统一：微符号 µ → μ，m2 → m²；不在允许列表中的单位仍由调用方阻断。 */
export function normalizeUnitText(unit) {
  return String(unit ?? '').trim().replace(/µ/g, 'μ').replace(/1\.73\s*m\^?2$/i, '1.73m²').replace(/\s+/g, '');
}

/** 表头中的疑似个人信息列（模板列除外）。 */
export function piiHeaderColumns(headers, kind) {
  const known = new Set([...Object.values(TEMPLATE_COLUMNS).flat(), 'lab_item_name']);
  return headers.filter(h => {
    if (known.has(h) || kind && TEMPLATE_COLUMNS[kind]?.includes(h)) return false;
    const n = String(h).normalize('NFKC').toLowerCase();
    return /姓名|名字|身份证|证件号|手机|电话|联系方式|病案号|住院号|门诊号|病历号|就诊卡|医保号|住址|家庭地址|邮箱/.test(n)
      || /(^|_)(name|patient_name|full_name|realname|phone|mobile|tel|telephone|cellphone|id_card|idcard|id_no|id_number|ssn|mrn|address|email)($|_)/.test(n);
  });
}

/** 化验字典索引：编码（含大小写不同的写法）、中文名、英文名、内置别名。 */
export function buildLabIndex(catalog = []) {
  const byCode = new Map(); const byKey = new Map();
  const add = (key, code) => { if (!key) return; const set = byKey.get(key) || new Set(); set.add(code); byKey.set(key, set); };
  for (const c of catalog) {
    if (!c?.code) continue;
    byCode.set(c.code, c);
    add(labKey(c.code), c.code); add(labKey(c.name_cn), c.code); add(labKey(c.name_en), c.code);
  }
  for (const [code, aliases] of Object.entries(LAB_ALIASES)) if (byCode.has(code)) aliases.forEach(a => add(labKey(a), code));
  return { byCode, byKey };
}
function matchLab(index, text) {
  const key = labKey(text); if (!key) return null;
  const set = index.byKey.get(key);
  return set && set.size === 1 ? [...set][0] : null;
}
/** 名称对应多个字典项目时（如尿红细胞的 /μL 与 /HPF），只有一个项目允许所填单位才映射，否则留给人工映射。 */
function matchLabByUnit(index, text, unitRaw, unitMap) {
  const set = index.byKey.get(labKey(text));
  if (!set || set.size < 2 || !String(unitRaw ?? '').trim()) return null;
  const hits = [...set].filter(code => pickUnit(unitRaw, allowedUnits(unitMap, code)));
  return hits.length === 1 ? hits[0] : null;
}
/** 未映射项目的分组键（同一编码 + 名称的行一起处理）。 */
export function unmappedKey(code, name) { return `${labKey(code)}|${labKey(name)}`; }

function isDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(text + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text;
}
const len = text => [...String(text ?? '')].length;

/** 与数据库 validate_clinical_input 相同的数字写法：可带正负号与小数点，指数最多 3 位。 */
const NUMBER_PATTERN = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$/;
/**
 * 按十进制精确解析数字文本（不经过浮点数）：返回 { zero, negative, digits, point, canonical } 或 null。
 * 数值 = 0.digits × 10^point（digits 无首尾 0），因此 |n| ≥ 10^k 当且仅当 point > k。
 * canonical 用于比较两行内容是否相同（1.10 与 1.1 视为相同，与数据库按数值比较一致）。
 */
export function decimalParts(text) {
  const t = String(text ?? '');
  if (!NUMBER_PATTERN.test(t)) return null;
  const negative = t[0] === '-';
  const [mantissa, exp = '0'] = t.replace(/^[+-]/, '').split(/[eE]/);
  const [intPart, fracPart = ''] = mantissa.split('.');
  let digits = intPart + fracPart; let point = intPart.length + Number(exp);
  const lead = digits.match(/^0*/)[0].length;
  digits = digits.slice(lead).replace(/0+$/, ''); point -= lead;
  if (!digits) return { zero: true, negative: false, digits: '', point: 0, canonical: '0' };
  return { zero: false, negative, digits, point, canonical: `${negative ? '-' : ''}0.${digits}e${point}` };
}
/** 数据库上限：value_raw 绝对值 < 10^12；dose_value 须 > 0 且 < 10^6。 */
const VALUE_MAX_EXP = 12;
const DOSE_MAX_EXP = 6;
/** 数据库 invalid_text：除 notes / event_detail 可含换行与制表符外，文本列不得含任何控制字符。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_BREAKS = /[\n\r\t]/;
const MULTILINE_COLUMNS = new Set(['notes', 'event_detail']);
const NUMERIC_COLUMNS = new Set(['value_raw', 'dose_value', 'crescent_pct']);
/** 同一文件内比较两行内容：列集合与取值都相同才算相同；数字按数值比较。 */
function payloadSignature(payload) {
  return JSON.stringify(Object.keys(payload).sort().map(k => [k, NUMERIC_COLUMNS.has(k) ? decimalParts(payload[k])?.canonical ?? payload[k] : payload[k]]));
}
/** 业务键（与数据库 import_clinical_row 一致）。 */
export const BUSINESS_KEYS = Object.freeze({ labs: ['patient_code', 'lab_date', 'lab_test_code'], meds: ['patient_code', 'drug_name', 'start_date'], events: ['patient_code', 'event_type', 'event_date'], biopsies: ['patient_code', 'biopsy_date', 'biopsy_kind'] });
const BUSINESS_KEY_LABELS = Object.freeze({ labs: '研究编号 + 化验日期 + 化验项目', meds: '研究编号 + 药物名称 + 起始日期', events: '研究编号 + 事件类型 + 事件日期', biopsies: '研究编号 + 活检日期 + 活检类型' });
/** 牛津分型 C 与新月体比例（Trimarchi 2017）：C0 无新月体，C1 少于 25%，C2 为 25% 及以上。 */
export function oxfordCMatchesCrescents(c, pct) { return (c === 0 && pct === 0) || (c === 1 && pct > 0 && pct < 25) || (c === 2 && pct >= 25); }
export const DUPLICATE_CONFLICT_REASON = '同一文件内同一业务键有两行内容不同，请合并为一行。';
/** 预览中疑似个人信息的研究编号只显示为遮盖文字。 */
export const MASKED_CODE = '****（疑似个人信息，已隐藏）';

function parseRange(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/\s+/g, '');
  const num = '(-?\\d+(?:\\.\\d+)?)';
  let m = t.match(new RegExp(`^${num}[-~–—至]${num}$`)); if (m) return [Number(m[1]), Number(m[2])];
  m = t.match(new RegExp(`^(?:<|≤|<=)${num}$`)); if (m) return [null, Number(m[1])];
  m = t.match(new RegExp(`^(?:>|≥|>=)${num}$`)); if (m) return [Number(m[1]), null];
  return null;
}

/** 北京时间的今天（与数据库 registry_private.local_today() 一致）。 */
export function beijingToday(now = Date.now()) { return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10); }

/**
 * 表头检查：疑似个人信息列、未知列、缺少必填列。返回阻断整份文件的问题（不含单元格内容）。
 */
export function checkHeaders(kind, headers) {
  const issues = [];
  const pii = piiHeaderColumns(headers, kind);
  if (pii.length) issues.push({ col: pii.join('、'), level: 'block', reason: '表头含疑似个人信息列（姓名、身份证、手机、电话、病案号、住院号等），整份文件已拒绝。', fix: `请删除这些列后重新上传。${PII_NOTICE}` });
  const allowed = TEMPLATE_COLUMNS[kind];
  const unknown = headers.filter(h => !allowed.includes(h) && !pii.includes(h));
  if (unknown.length) issues.push({ col: unknown.join('、'), level: 'block', reason: '包含模板以外的列；列顺序可以调整，但列名须与模板逐字一致。', fix: `允许的列：${allowed.join('、')}` });
  const missing = REQUIRED_COLUMNS[kind].filter(h => !headers.includes(h));
  if (kind === 'labs' && !headers.includes('lab_test_code') && !headers.includes('lab_item_name')) missing.push('lab_test_code');
  if (kind === 'labs' && !headers.includes('value_raw') && !headers.includes('result_text')) missing.push('value_raw');
  if (missing.length) issues.push({ col: missing.join('、'), level: 'block', reason: '缺少必需的列。', fix: '请下载最新模板，按模板表头填写。' });
  return issues;
}

/**
 * 逐行校验。ctx：{ catalog, unitMap: {code:[{unit_symbol,is_standard}]}, patients: Map(研究编号→{followup_status, baseline_date}),
 * today, mapping: {未映射键: 编码 | SKIP_MAPPING}, containsPII }。
 * 问题文字只描述规则，不包含单元格内容（错误报告会原样导出）。
 */
export function validateBatch(kind, headers, data, ctx = {}) {
  // ctx.lines：每条记录在文件中开始的物理行号（parseRegistryCsv 返回）；没有时按“表头 + 序号”推算。
  const lineOf = i => Number.isInteger(ctx.lines?.[i]) ? ctx.lines[i] : i + 2;
  const fileIssues = checkHeaders(kind, headers);
  const rows = [];
  const unmapped = new Map();
  const index = buildLabIndex(ctx.catalog || []);
  const catalogByCode = index.byCode;
  const patients = ctx.patients || new Map();
  const today = ctx.today || beijingToday();
  const mapping = ctx.mapping || {};
  const pii = typeof ctx.containsPII === 'function' ? ctx.containsPII : () => false;
  if (!fileIssues.length) data.forEach((cells, i) => {
    const line = lineOf(i);
    const issues = [];
    const block = (col, reason, fix = '') => issues.push({ col, level: 'block', reason, fix });
    const warn = (col, reason, fix = '') => issues.push({ col, level: 'warn', reason, fix });
    const info = (col, reason) => issues.push({ col, level: 'info', reason, fix: '' });
    const v = k => String(cells[k] ?? '').trim();
    const payload = {};
    let status = null; let mapKey = null;
    const code = v('patient_code');
    const codePii = !!code && pii(code);
    if (!code) block('patient_code', '研究编号不能为空。', '填写项目内已存在的研究编号。');
    else if (len(code) > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(code)) block('patient_code', '研究编号须为 1–64 个字符，不能包含换行、制表符等控制字符。');
    else if (codePii) block('patient_code', '研究编号疑似包含个人信息（手机号、身份证号、病案号或 8 位以上连续数字）。', PII_NOTICE);
    else if (!patients.has(code)) block('patient_code', '本项目中没有该研究编号的患者。', '先在“新增患者”或基线导入中建档，或核对编号。');
    if (code) payload.patient_code = code;
    const patient = patients.get(code);
    const date = (col, label, required) => {
      const t = v(col);
      if (!t) { if (required) block(col, `${label}不能为空。`, '按 YYYY-MM-DD 填写。'); return null; }
      if (!isDate(t)) { block(col, `${label}不是有效日期。`, '按 YYYY-MM-DD 填写实际存在的日期。'); return null; }
      if (t > today) { block(col, `${label}晚于今天。`, '核对年份与月份。'); return null; }
      if (t < '1900-01-01') { block(col, `${label}早于 1900-01-01。`, '核对年份。'); return null; }
      payload[col] = t; return t;
    };
    const text = (col, label, max, { checkPii = true } = {}) => {
      const t = v(col); if (!t) return null;
      if (CONTROL_CHARS.test(t) || (!MULTILINE_COLUMNS.has(col) && LINE_BREAKS.test(t))) {
        block(col, MULTILINE_COLUMNS.has(col) ? `${label}含有不可见的控制字符。` : `${label}含有换行、制表符或其他控制字符。`, MULTILINE_COLUMNS.has(col) ? '请删除不可见的控制字符后重新上传。' : '该列须为单行文本，请删除单元格内的换行与制表符。');
        return null;
      }
      if (len(t) > max) { block(col, `${label}超过 ${max} 字。`, '请精简。'); return null; }
      if (checkPii && pii(t)) { block(col, `${label}疑似包含个人信息。`, PII_NOTICE); return null; }
      payload[col] = t; return t;
    };
    let bizKey = null;
    if (kind === 'labs') {
      const labDate = date('lab_date', '化验日期', true);
      const rawCode = v('lab_test_code'); const rawName = v('lab_item_name');
      let labCode = null;
      if (rawCode && catalogByCode.has(rawCode)) labCode = rawCode;
      else {
        labCode = matchLab(index, rawCode) || matchLab(index, rawName);
        if (labCode) info('lab_test_code', `已按编码或名称映射到字典项目 ${labCode}。`);
        else {
          labCode = matchLabByUnit(index, rawCode, v('unit_symbol'), ctx.unitMap) || matchLabByUnit(index, rawName, v('unit_symbol'), ctx.unitMap);
          if (labCode) info('lab_test_code', `名称对应多个字典项目，已按单位映射到 ${labCode}。`);
        }
      }
      if (!labCode) {
        if (!rawCode && !rawName) block('lab_test_code', '化验项目编码与名称都为空。', '填写字典编码，或填写化验项目名称以便映射。');
        else {
          mapKey = unmappedKey(rawCode, rawName);
          const chosen = mapping[mapKey];
          const entry = unmapped.get(mapKey) || { key: mapKey, code: rawCode, name: rawName, count: 0, lines: [] };
          entry.count++; if (entry.lines.length < 5) entry.lines.push(line); unmapped.set(mapKey, entry);
          if (chosen === SKIP_MAPPING) status = 'ignored';
          else if (chosen && catalogByCode.has(chosen)) { labCode = chosen; info('lab_test_code', `已按手动映射写入字典项目 ${chosen}。`); }
          else block('lab_test_code', '化验项目不在系统字典中，尚未映射。', '在预览页“未映射项目”中选择对应的字典项目，或标记为不导入。');
        }
      }
      if (labCode) payload.lab_test_code = labCode;
      const value = v('value_raw'); const resultText = text('result_text', '结果文本', 50);
      let numeric = null;
      if (value) {
        // 提交原始文本（如 1.10），由数据库按 numeric 解析，不经过浮点数。
        const d = decimalParts(value);
        if (!d) block('value_raw', '结果数值不是数字。', '“<5”“阳性”等定性结果请填在结果文本列，数值列留空；不要使用千分位或 4 位以上的指数。');
        else if (!d.zero && d.point > VALUE_MAX_EXP) block('value_raw', '结果数值超出允许范围（绝对值须小于 10^12）。', '核对数值与单位。');
        else { numeric = Number(value); payload.value_raw = value; }
      }
      if (!value && !resultText && !issues.some(x => x.col === 'result_text')) block('value_raw', '结果数值与结果文本都为空。', '至少填写一项。');
      const unitRaw = v('unit_symbol');
      if (!value && unitRaw) info('unit_symbol', '定性结果不需要单位，已忽略单位。');
      else if (value && !unitRaw) block('unit_symbol', '填写结果数值时必须填写单位。', labCode ? `可选单位：${allowedUnits(ctx.unitMap, labCode).join('、') || '（字典未配置）'}` : '');
      else if (unitRaw && labCode) {
        const allowed = allowedUnits(ctx.unitMap, labCode);
        const unit = pickUnit(unitRaw, allowed);
        if (!unit) block('unit_symbol', '单位不在该化验项目允许的单位中。', allowed.length ? `可选单位：${allowed.join('、')}` : '该项目在字典中没有配置允许单位，请联系平台管理员。');
        else {
          payload.unit_symbol = unit;
          const standard = catalogByCode.get(labCode)?.standard_unit;
          if (standard && unit !== standard && numeric != null) info('unit_symbol', `与标准单位不同，将自动换算为 ${standard}。`);
        }
      } else if (unitRaw && !labCode && value) payload.unit_symbol = normalizeUnitText(unitRaw);
      text('ref_range', '参考范围', 50);
      const flagRaw = v('abnormal_flag');
      if (flagRaw) {
        const flag = FLAG_INPUT[enumKey(flagRaw)];
        if (!flag) block('abnormal_flag', '异常标志只能为 H、L 或 N。', 'H=高，L=低，N=正常。');
        else {
          payload.abnormal_flag = flag;
          const range = parseRange(v('ref_range'));
          if (range && numeric != null) {
            const [lo, hi] = range;
            const expected = lo != null && numeric < lo ? 'L' : hi != null && numeric > hi ? 'H' : 'N';
            if (expected !== flag) warn('abnormal_flag', '异常标志与参考范围不一致。', '核对数值、参考范围与异常标志。');
          }
        }
      }
      text('notes', '备注', 500);
      if (patient?.followup_status === 'deceased') warn('patient_code', '该患者随访状态为死亡，仍有化验记录。', '核对化验日期是否在死亡日期之前。');
      if (labDate && labCode && code) bizKey = `${code}\u0000${labDate}\u0000${labCode}`;
    } else if (kind === 'meds') {
      const drug = text('drug_name', '药物名称', 200);
      if (!v('drug_name')) block('drug_name', '药物名称不能为空。', '填写药物通用名。');
      const cls = v('drug_class');
      if (cls) {
        const match = DRUG_CLASSES.find(c => enumKey(c) === enumKey(cls)) || DRUG_CLASS_INPUT[enumKey(cls)];
        if (!match) block('drug_class', '药物类别不在允许的枚举中。', `只能为：${DRUG_CLASSES.join('、')}`); else payload.drug_class = match;
      }
      const doseValue = v('dose_value'); const doseUnit = text('dose_unit', '剂量单位', 20);
      if (doseValue) {
        const d = decimalParts(doseValue);
        if (!d || d.zero || d.negative) block('dose_value', '剂量数值须为大于 0 的数字。', '只填数字，单位填在剂量单位列。');
        else if (d.point > DOSE_MAX_EXP) block('dose_value', '剂量数值须小于 1000000。', '核对数值与剂量单位。');
        else payload.dose_value = doseValue;
      }
      if (!!doseValue !== !!v('dose_unit')) warn(doseValue ? 'dose_unit' : 'dose_value', '剂量数值与剂量单位只填了其中一项。', '两项成对填写，便于剂量统计。');
      const route = v('route');
      if (route) { const r = ROUTE_INPUT[enumKey(route)]; if (!r) block('route', '给药途径不在允许的枚举中。', 'PO、IV、SC、IM、topical、other'); else payload.route = r; }
      text('frequency', '频次', 20);
      const start = date('start_date', '起始日期', true); const end = date('end_date', '结束日期', false);
      if (start && end && end < start) { block('end_date', '结束日期早于起始日期。', '核对起止日期。'); delete payload.end_date; }
      text('indication', '用药目的', 100); text('notes', '备注', 500);
      if (drug && start && code) bizKey = `${code}\u0000${drug}\u0000${start}`;
    } else if (kind === 'biopsies') {
      const biopsyDate = date('biopsy_date', '活检日期', true);
      const rawKind = v('biopsy_kind'); let biopsyKind = null;
      if (!rawKind) block('biopsy_kind', '活检类型不能为空。', 'native（自体肾）或 transplant（移植肾）。');
      else {
        biopsyKind = BIOPSY_KIND_INPUT[enumKey(rawKind)] || null;
        if (!biopsyKind) block('biopsy_kind', '活检类型不在允许的取值中。', 'native（自体肾）或 transplant（移植肾）。'); else payload.biopsy_kind = biopsyKind;
      }
      const indexText = v('is_index'); let isIndex = false;
      if (indexText) {
        const flag = BOOLEAN_INPUT[enumKey(indexText)];
        if (flag === undefined) block('is_index', '基准活检只能填 true / false（或 是 / 否）。', '每位患者最多一次活检标为“是”，通常是确诊活检。');
        else { payload.is_index = flag ? 'true' : 'false'; isIndex = flag; }
      }
      // 整数列按数据库规则：0–999 的整数，不带符号、小数点或指数；写入时去掉前导 0。
      const integer = (col, label, max) => {
        const t = v(col); if (!t) return null;
        if (!/^[0-9]{1,3}$/.test(t) || Number(t) > max) { block(col, `${label}须为 0–${max} 的整数。`, '只填整数，不带小数点、单位或 % 符号。'); return null; }
        payload[col] = String(Number(t)); return Number(t);
      };
      integer('glomeruli_total', '肾小球总数', 999);
      const pctText = v('crescent_pct'); let pct = null;
      if (pctText) {
        const d = decimalParts(pctText); const n = Number(pctText);
        if (!d || d.negative || !(n >= 0 && n <= 100)) block('crescent_pct', '新月体比例须为 0–100 的数字。', '填百分数，不带 % 符号，例如 8.3。');
        else { payload.crescent_pct = pctText; pct = n; }
      }
      const oxford = Object.fromEntries([['oxford_m', 1], ['oxford_e', 1], ['oxford_s', 1], ['oxford_t', 2], ['oxford_c', 2]]
        .map(([col, max]) => [col, integer(col, `牛津分型 ${col.slice(-1).toUpperCase()} `, max)]));
      if (oxford.oxford_c != null && pct != null && !oxfordCMatchesCrescents(oxford.oxford_c, pct)) block('oxford_c', '牛津分型 C 与新月体比例不一致。', 'C0 为无新月体，C1 为新月体占肾小球不足 25%，C2 为 25% 及以上；请按病理报告核对。');
      text('notes', '备注', 500);
      const existing = ctx.indexBiopsies?.get(code);
      if (isIndex && existing && (existing.biopsy_date !== biopsyDate || existing.biopsy_kind !== biopsyKind)) block('is_index', '该患者在系统中已有另一次基准活检；每位患者只能有一次。', '核对哪一次是确诊活检；需要更换时先在工作台删除原记录并说明原因。');
      if (biopsyDate && biopsyKind && code) bizKey = `${code}\u0000${biopsyDate}\u0000${biopsyKind}`;
    } else {
      const raw = v('event_type'); let type = null;
      if (!raw) block('event_type', '事件类型不能为空。', 'esrd、dialysis_start、kidney_transplant、death、relapse、custom');
      else {
        const k = enumKey(raw);
        if (DERIVED_INPUT.test(k) || DERIVED_EVENTS.includes(k)) block('event_type', 'eGFR 下降与缓解属于由化验数据计算的终点，由分析脚本按研究方案判定，不接受导入。', '删除这些行；终点由分析脚本按研究方案计算。');
        else if (VACCINE_EVENT_INPUT.has(k)) block('event_type', '疫苗接种改为在用药记录中登记，不再作为终点事件导入。', '改用用药记录模板：药物名称写疫苗名称，药物类别填“疫苗”，起始日期为接种日期。');
        else if (!EVENT_INPUT[k]) block('event_type', '事件类型不在允许的枚举中。', '改用 custom 并在事件细节中说明。');
        else { type = EVENT_INPUT[k]; payload.event_type = type; }
      }
      const eventDate = date('event_date', '事件日期', true);
      const detail = text('event_detail', '事件细节', 500);
      if (DETAIL_REQUIRED_EVENTS.includes(type) && !detail && !issues.some(x => x.col === 'event_detail')) block('event_detail', type === 'custom' ? '事件类型为“其他”时须填写事件细节。' : '严重感染和住院须在事件细节中写明感染部位或诊断、住院原因。', '简要说明事件内容，勿填身份信息。');
      const src = v('evidence_source');
      if (!src) block('evidence_source', '判定依据来源不能为空。', '病历记录、化验数据复核、电话随访、死亡证明、其他');
      else { const s = EVIDENCE_INPUT[enumKey(src)] || EVIDENCE_INPUT[src]; if (!s) block('evidence_source', '判定依据来源不在允许的枚举中。', 'medical_record、lab_review、phone_followup、death_certificate、other'); else payload.evidence_source = s; }
      text('notes', '备注', 500);
      if (eventDate && patient?.baseline_date && eventDate < patient.baseline_date) warn('event_date', '事件日期早于该患者的基线日期。', '核对事件日期与基线日期。');
      if (type && STATUS_EVENTS.has(type) && patient && (patient.followup_status ?? 'active') === 'active') warn('event_type', '该患者随访状态仍为“在访”：请到该患者的研究状态登记。', '在随访看板中打开该患者的“研究状态”，按原始记录登记死亡、肾衰竭等状态。');
      if (type && eventDate && code) bizKey = `${code}\u0000${type}\u0000${eventDate}`;
    }
    rows.push({ line, patient_code: code, codePii, cells, payload, status, issues, mapKey, bizKey });
  });
  // 同一文件内同一业务键：内容完全相同 → 警告（服务器跳过重复行）；内容不同（含一行多出备注等列）→ 数据库会拒绝整块，两行都阻断。
  const groups = new Map();
  for (const r of rows) {
    if (!r.bizKey || r.status === 'ignored' || r.issues.some(x => x.level === 'block')) continue;
    if (!groups.has(r.bizKey)) groups.set(r.bizKey, []);
    groups.get(r.bizKey).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const signatures = group.map(r => payloadSignature(r.payload));
    const same = signatures.every(x => x === signatures[0]);
    group.forEach((r, i) => {
      const others = group.filter(o => o !== r).map(o => o.line).join('、');
      if (same) { if (i > 0) r.issues.push({ col: 'patient_code', level: 'warn', reason: `与第 ${group[0].line} 行内容完全相同（同一文件内重复）。`, fix: '服务器会跳过重复行；也可删除重复行后再导入。' }); }
      else r.issues.push({ col: BUSINESS_KEYS[kind].join('、'), level: 'block', reason: DUPLICATE_CONFLICT_REASON, fix: `与第 ${others} 行的业务键（${BUSINESS_KEY_LABELS[kind]}）相同但内容不同；保留一行正确内容后重新上传。` });
    });
  }
  // 同一患者在文件中有两次以上不同的活检标为基准活检：每位患者只能有一次，这些行都阻断（完全相同的重复行不算）。
  if (kind === 'biopsies') {
    const indexKeys = new Map();
    for (const r of rows) {
      if (r.payload.is_index !== 'true' || !r.bizKey || r.status === 'ignored' || r.issues.some(x => x.level === 'block')) continue;
      if (!indexKeys.has(r.patient_code)) indexKeys.set(r.patient_code, []);
      indexKeys.get(r.patient_code).push(r);
    }
    for (const group of indexKeys.values()) {
      if (new Set(group.map(r => r.bizKey)).size < 2) continue;
      const lines = group.map(r => r.line).join('、');
      group.forEach(r => r.issues.push({ col: 'is_index', level: 'block', reason: '同一患者在文件中有多次活检标为基准活检；每位患者只能有一次。', fix: `第 ${lines} 行只保留确诊那一次为 true，其余改为 false。` }));
    }
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
  return { kind, fileIssues, rows, unmapped: [...unmapped.values()], counts };
}

export function allowedUnits(unitMap, code) {
  const list = (unitMap?.[code] || []).map(u => u.unit_symbol).filter(Boolean);
  return [...new Set(list)];
}
function pickUnit(raw, allowed) {
  const unit = normalizeUnitText(raw);
  if (allowed.includes(unit)) return unit;
  const lower = allowed.filter(a => normalizeUnitText(a).toLowerCase() === unit.toLowerCase());
  return lower.length === 1 ? lower[0] : null;
}

/** 可写入行按 500 行分块；每块一个新批次编号，记录对应的 CSV 行号以便翻译数据库返回的 row_<n>。 */
export function buildChunks(result, newId, size = CHUNK_SIZE) {
  const writable = result.rows.filter(r => r.status === 'ok' || r.status === 'warn');
  const chunks = [];
  for (let i = 0; i < writable.length; i += size) {
    const part = writable.slice(i, i + size);
    chunks.push({ index: chunks.length + 1, total: 0, batchId: newId(), lines: part.map(r => r.line), rows: part.map(r => r.payload), imported: false, registered: false, reply: null, error: null });
  }
  chunks.forEach(c => { c.total = chunks.length; });
  return chunks;
}

const LEVEL_LABELS = { block: '阻断', warn: '警告' };
function csvCell(value, safe = true) {
  let s = value == null ? '' : String(value);
  if (safe && /^[\s]*[=+@\-]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const ERROR_REPORT_COLUMNS = Object.freeze(['行号', 'patient_code', '出错列', '级别', '原因', '修正建议']);
/** 错误报告 CSV（不含 BOM）：只含行号、研究编号、列名与规则说明，不含其他单元格内容；疑似个人信息的研究编号留空。 */
export function errorReportCsv(result) {
  const lines = [ERROR_REPORT_COLUMNS.map(c => csvCell(c, false)).join(',')];
  for (const f of result.fileIssues) lines.push(['1', '', f.col, LEVEL_LABELS[f.level], f.reason, f.fix].map(c => csvCell(c)).join(','));
  for (const r of result.rows) for (const x of r.issues) {
    if (!LEVEL_LABELS[x.level]) continue;
    lines.push([r.line, r.codePii ? '' : r.patient_code, x.col, LEVEL_LABELS[x.level], x.reason, x.fix].map(c => csvCell(c)).join(','));
  }
  lines.push(['说明', '', '', '', `隐私提示：${PII_NOTICE}本报告只含行号、研究编号与问题说明。`, ''].map(c => csvCell(c)).join(','));
  return lines.join('\r\n');
}

/** 模板 CSV（不含 BOM，下载时由页面加 BOM）：英文表头与 2–3 行虚构示例。 */
export function templateCsv(kind) {
  const t = TEMPLATES[kind]; const cols = TEMPLATE_COLUMNS[kind];
  return [cols.join(','), ...t.examples.map(e => cols.map(c => csvCell(e[c] ?? '', false)).join(','))].join('\r\n');
}

/** 去掉路径，只保留文件名（最多 200 字）。 */
export function baseFileName(name) {
  return [...String(name ?? '').split(/[\\/]/).pop()].slice(0, 200).join('');
}
