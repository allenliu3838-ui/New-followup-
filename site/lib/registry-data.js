// Shared parsing and retrieval rules for the real registry workspace.
export function strictDate(value, label = '日期', required = false) {
  if (value === '' || value == null) { if (required) throw new Error(`${label}不能为空`); return null; }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label}须为 YYYY-MM-DD`);
  const d = new Date(text + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== text) throw new Error(`${label}不是有效日期`);
  return text;
}
export function finiteNumber(value, label = '数值', options = {}) {
  if (value === '' || value == null) { if (options.required) throw new Error(`${label}不能为空`); return null; }
  const n = Number(value);
  if (!Number.isFinite(n) || (options.integer && !Number.isInteger(n))) throw new Error(`${label}须为有限${options.integer ? '整数' : '数值'}`);
  if (options.min != null && n < options.min || options.max != null && n > options.max) {
    const unit = options.unit ? ` ${options.unit}` : '';
    const range = options.min != null && options.max != null ? `须在 ${options.min}–${options.max}${unit} 之间` : options.min != null ? `不能小于 ${options.min}${unit}` : `不能大于 ${options.max}${unit}`;
    throw new Error(`${label}${range}，请核对`);
  }
  return n;
}

// 与数据库 CHECK 约束一致（0002_clinical_constraints.sql、0014_pr3_validators.sql）；数据库仍是最终校验。
export const SCR_MGDL_TO_UMOL = 88.4;
export const CLINICAL_LIMITS = Object.freeze({
  sbp: { min: 40, max: 300, unit: 'mmHg' },
  dbp: { min: 20, max: 200, unit: 'mmHg' },
  scr_umol_l: { min: 10, max: 5000, unit: 'μmol/L' },
  baseline_scr: { min: 10, max: 5000, unit: 'μmol/L' },
  upcr: { min: 0, max: 50000, unit: 'mg/g' },
  egfr: { min: 0, max: 200 },
});

/**
 * 血肌酐换算为 μmol/L 并检查 10–5000 μmol/L。空白返回 null。
 * 按 μmol/L 填了 mg/dL 的数值（如 1.1）或反过来时，提示切换单位，而不是笼统的“超出范围”。
 */
export function creatinineUmol(value, unit = 'umol', label = '血肌酐') {
  if (value === '' || value == null || String(value).trim() === '') return null;
  const raw = Number(String(value).trim());
  if (!Number.isFinite(raw) || raw <= 0) throw new Error(`${label}须为大于 0 的数值`);
  const umol = unit === 'mgdl' ? Math.round(raw * SCR_MGDL_TO_UMOL * 100) / 100 : raw;
  const { min, max } = CLINICAL_LIMITS.scr_umol_l;
  if (umol >= min && umol <= max) return umol;
  const asUmol = Math.round(raw * SCR_MGDL_TO_UMOL * 100) / 100;
  if (unit !== 'mgdl' && raw < min && asUmol >= min && asUmol <= max) {
    throw new Error(`${label} ${raw} μmol/L 低于系统允许的 ${min}–${max} μmol/L。这个数值看起来是 mg/dL：请把单位切换为 mg/dL，或按 1 mg/dL = 88.4 μmol/L 换算（约 ${asUmol} μmol/L）后填写。`);
  }
  if (unit === 'mgdl' && umol > max && raw >= min && raw <= max) {
    throw new Error(`${label} ${raw} mg/dL 换算后为 ${umol} μmol/L，超出系统允许的 ${min}–${max} μmol/L。这个数值看起来是 μmol/L：请把单位切换为 μmol/L。`);
  }
  throw new Error(`${label}${unit === 'mgdl' ? `换算后为 ${umol} μmol/L，` : ` ${raw} μmol/L `}超出系统允许的 ${min}–${max} μmol/L，请核对数值与单位。`);
}

/** 更正原因：去掉首尾空白后 3–500 字（与 correct_registry_record 一致），不含身份信息。 */
export function correctionReasonError(reason) {
  const text = String(reason ?? '').trim();
  const length = [...text].length;
  if (length < 3) return '请填写更正原因（3–500 字），说明依据的原始资料。';
  if (length > 500) return `更正原因最多 500 字（当前 ${length} 字），请精简。`;
  if (containsPII(text)) return '更正原因中检测到疑似个人身份信息（手机号、身份证号、住院号、姓名等），请删除后再保存。';
  return '';
}
export function normalizeUpcr(value, unit) {
  const n = finiteNumber(value, 'UPCR', {min:0});
  if (!['mg/g','g/g'].includes(unit)) throw new Error('请选择 UPCR 单位');
  if (n == null) return null;
  const converted = unit === 'g/g' ? n * 1000 : n;
  if (!Number.isFinite(converted)) throw new Error('UPCR 换算结果超出范围');
  return converted;
}
export function parseRegistryCsv(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  let i=0, field='', row=[], quoted=false, closed=false; const rows=[];
  function fieldEnd(){ row.push(field); field='';closed=false; }
  function rowEnd(){ fieldEnd(); if(row.some(v=>v.trim()!=='')) rows.push(row);row=[]; }
  while(i<text.length){ const c=text[i++];
    if(quoted){ if(c==='"'){ if(text[i]==='"'){field+='"';i++;}else{quoted=false;closed=true;} } else field+=c; continue; }
    if(c==='"'){if(field!==''||closed) throw new Error('CSV 引号格式错误');quoted=true;continue;}
    if(c===','){fieldEnd();continue;}
    if(c==='\n'||c==='\r'){if(c==='\r'&&text[i]==='\n')i++;rowEnd();continue;}
    if(closed){if(c===' '||c==='\t')continue;throw new Error('CSV 引号结束后有多余字符');}
    field+=c;
  }
  if(quoted) throw new Error('CSV 引号未闭合');
  if(field!==''||row.length||closed)rowEnd();
  if(rows.length<2)throw new Error('CSV 需要表头和至少一行数据');
  const headers=rows[0].map(h=>h.trim().toLowerCase().replace(/\s+/g,'_'));
  if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw new Error('CSV 表头不能为空或重复');
  if(headers.some(h=>['__proto__','constructor','prototype'].includes(h)))throw new Error('CSV 包含保留列名');
  const data=rows.slice(1).map((cells,n)=>{
    if(cells.length!==headers.length)throw new Error(`CSV 第 ${n+2} 行列数与表头不一致`);
    return Object.fromEntries(headers.map((h,j)=>[h,cells[j].trim()]));
  });
  return {headers,data};
}
export async function readAllRows(sb, table, projectId, assertCurrent = ()=>{}, pageSize=500, filters={}, options={}) {
  // Views such as v_patient_followup_status have no "id" column; callers name a unique key instead.
  const key=options.key||'id', select=options.select||'*';
  const rows=[]; const ids=new Set(); let expected=null;
  for(;;){
    assertCurrent();
    let query=sb.from(table).select(select,{count:'exact'}).eq('project_id',projectId);
    for(const [field,value]of Object.entries(filters))query=query.eq(field,value);
    const {data,error,count}=await query.order(key,{ascending:true}).range(rows.length,rows.length+pageSize-1);
    assertCurrent(); if(error)throw error;
    if(!Array.isArray(data)||!Number.isInteger(count))throw new Error('读取的数据或数量不完整，请重试');
    if(expected===null)expected=count;
    if(count!==expected)throw new Error('数据在读取期间发生变化，请重试');
    if(expected>100000)throw new Error('数据量超过浏览器导出容量，请联系管理员使用服务器导出');
    for(const r of data){if(!r[key]||ids.has(r[key]))throw new Error('分页读取出现重复或缺少编号的记录，已停止');ids.add(r[key]);rows.push(r);}
    if(rows.length===expected)return rows;
    if(!data.length||rows.length>expected)throw new Error('读取数量不一致，已停止');
  }
}
/**
 * 键集分页读取（看板等）：按唯一键升序，每页取 pageSize 行，下一页从上一页最后一个键之后开始。
 * 不逐页计数，单页耗时不随页数增长。数据在读取期间新增或变化时不中止（看板会在保存后单独刷新该患者）；
 * 需要“整份数据一致”的导出仍使用上面带数量校验的 readAllRows。
 */
export async function readKeysetRows(sb, table, projectId, { key = 'id', select = '*', pageSize = 500, maxRows = 100000, assertCurrent = () => {} } = {}) {
  const rows = []; const seen = new Set(); let after = null;
  for (;;) {
    assertCurrent();
    let query = sb.from(table).select(select).eq('project_id', projectId);
    if (after !== null) query = query.gt(key, after);
    const { data, error } = await query.order(key, { ascending: true }).limit(pageSize);
    assertCurrent(); if (error) throw error;
    if (!Array.isArray(data) || data.length > pageSize) throw new Error('读取的数据不完整，请重试');
    for (const r of data) {
      const k = r?.[key];
      if (k === null || k === undefined || k === '' || seen.has(String(k))) throw new Error('分页读取出现重复或缺少编号的记录，已停止');
      seen.add(String(k)); rows.push(r); after = String(k);
    }
    if (rows.length > maxRows) throw new Error('数据量超过浏览器显示容量，请联系管理员');
    if (data.length < pageSize) return rows;
  }
}
export function exportColumns(rows, preferred=[]) {
  return [...new Set([...preferred,...rows.flatMap(r=>Object.keys(r))])];
}
export async function sha256Text(text) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const BASELINE_IMPORT_FIELDS=['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr','baseline_upcr_unit','biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class','ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date','consent_status','consent_date','consent_version','followup_status','followup_status_date'];
// 研究状态列接受英文代码或中文名称（迁移 0038 起数据库接受这些列）；空白单元格保持原值。
const CONSENT_INPUT=Object.freeze({unconfirmed:'unconfirmed',consented:'consented',waiver:'waiver',declined:'declined',withdrawn:'withdrawn','未确认':'unconfirmed','已同意':'consented','伦理批准豁免':'waiver','拒绝':'declined','撤回':'withdrawn'});
const FOLLOWUP_INPUT=Object.freeze({active:'active',lost:'lost',withdrawn:'withdrawn',deceased:'deceased',kidney_failure:'kidney_failure',transferred:'transferred','在访':'active','失访':'lost','退出':'withdrawn','退出研究':'withdrawn','死亡':'deceased','肾衰竭':'kidney_failure','转院':'transferred'});
export const VISIT_IMPORT_FIELDS=['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes'];
function localDateText(date=new Date()){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
export function normalizeImportRow(kind,input,defaultUpcrUnit=''){
  const allowed=kind==='baseline'?BASELINE_IMPORT_FIELDS:VISIT_IMPORT_FIELDS;
  const result={};
  for(const [key,value]of Object.entries(input)){
    if(!allowed.includes(key))throw new Error(`不支持的列：${key}`);
    if(value!==''&&value!=null)result[key]=String(value).trim();
  }
  if(!result.patient_code)throw new Error('研究编号不能为空');
  if(kind==='baseline'){
    if(result.sex){result.sex=({'男':'M','女':'F','M':'M','F':'F'})[result.sex];if(!result.sex)throw new Error('性别须为 M/F/男/女');}
    if('baseline_scr'in result)result.baseline_scr=creatinineUmol(result.baseline_scr,'umol','基线血肌酐');
    const nums={birth_year:{integer:true,min:1900,max:new Date().getUTCFullYear()},oxford_m:{integer:true,min:0,max:1},oxford_e:{integer:true,min:0,max:1},oxford_s:{integer:true,min:0,max:1},oxford_t:{integer:true,min:0,max:2},oxford_c:{integer:true,min:0,max:2},ln_activity_index:{min:0,max:24},ln_chronicity_index:{min:0,max:12}};
    for(const [key,opts]of Object.entries(nums))if(key in result)result[key]=finiteNumber(result[key],fieldLabel(key),opts);
    for(const key of ['baseline_date','biopsy_date','ln_biopsy_date','randomization_date','consent_date','followup_status_date'])if(key in result)result[key]=strictDate(result[key],fieldLabel(key));
    if('consent_status'in result){const v=CONSENT_INPUT[result.consent_status];if(!v)throw new Error('知情同意状态须为：未确认、已同意、伦理批准豁免、拒绝、撤回');result.consent_status=v;}
    if('followup_status'in result){const v=FOLLOWUP_INPUT[result.followup_status];if(!v)throw new Error('随访状态须为：在访、失访、退出、死亡、肾衰竭、转院');result.followup_status=v;}
    // 与数据库一致：退出类状态（拒绝/撤回同意、退出研究、死亡）不能通过导入登记，须先建档，再在患者的“研究状态”中填写原因登记。
    if(['declined','withdrawn'].includes(result.consent_status)||['withdrawn','deceased'].includes(result.followup_status))throw new Error('拒绝或撤回同意、退出研究、死亡不能通过导入登记：请先导入基线，再在患者的“研究状态”中登记并填写原因');
    if('consent_version'in result&&result.consent_version.length>100)throw new Error('知情同意书版本最多 100 个字符');
    if('ln_podocytopathy'in result){const map={true:true,false:false,'是':true,'否':false};if(!(result.ln_podocytopathy in map))throw new Error('足细胞病变须为 true/false/是/否');result.ln_podocytopathy=map[result.ln_podocytopathy];}
    if('baseline_upcr'in result){const unit=result.baseline_upcr_unit||defaultUpcrUnit;if(!unit)throw new Error('基线 UPCR 缺少单位：请在 CSV 的 baseline_upcr_unit 列填写，或在页面明确选择');const raw=finiteNumber(result.baseline_upcr,'UPCR',{min:0});result.baseline_upcr=normalizeUpcr(raw,unit);result.baseline_upcr_unit='mg/g';result.baseline_upcr_raw=raw;result.baseline_upcr_original_unit=unit;}else delete result.baseline_upcr_unit;
  }else{
    // 与“录入随访”对话框及数据库一致：至少一项测量值；各项按数据库范围检查，未填的项保持空白。
    result.visit_date=strictDate(result.visit_date,'随访日期',true);
    if(result.visit_date>localDateText())throw new Error('随访日期不能晚于今天');
    if('scr_umol_l'in result)result.scr_umol_l=creatinineUmol(result.scr_umol_l,'umol','血肌酐');
    for(const key of ['sbp','dbp','upcr','egfr'])if(key in result)result[key]=finiteNumber(result[key],fieldLabel(key),CLINICAL_LIMITS[key]);
    if(!['sbp','dbp','scr_umol_l','upcr','egfr'].some(key=>key in result))throw new Error('请至少填写一项测量值（收缩压、舒张压、血肌酐或 UPCR）');
    if('sbp'in result&&'dbp'in result&&result.dbp>=result.sbp)throw new Error('舒张压须低于收缩压，请核对是否填反');
    if('notes'in result&&[...result.notes].length>500)throw new Error('备注最多 500 字');
  }
  return result;
}

// Chinese labels for CSV columns and correction fields; users never see raw column keys in messages.
export const FIELD_LABELS=Object.freeze({patient_code:'研究编号',sex:'性别',birth_year:'出生年份',baseline_date:'基线日期',baseline_scr:'基线血肌酐',baseline_upcr:'基线UPCR',baseline_upcr_unit:'基线UPCR单位',baseline_upcr_raw:'基线UPCR原始值',baseline_upcr_original_unit:'基线UPCR原始单位',biopsy_date:'肾穿日期',oxford_m:'牛津分型M',oxford_e:'牛津分型E',oxford_s:'牛津分型S',oxford_t:'牛津分型T',oxford_c:'牛津分型C',ln_biopsy_date:'LN肾穿日期',ln_class:'LN病理分型',ln_activity_index:'LN活动指数',ln_chronicity_index:'LN慢性指数',ln_podocytopathy:'足细胞病变',treatment_arm:'研究分组',randomization_id:'随机号',randomization_date:'随机化日期',visit_date:'随访日期',sbp:'收缩压',dbp:'舒张压',scr_umol_l:'血肌酐（μmol/L）',upcr:'UPCR（mg/g）',egfr:'eGFR',notes:'备注',consent_status:'知情同意状态',consent_date:'知情同意日期',consent_version:'知情同意书版本',followup_status:'随访状态',followup_status_date:'随访状态日期'});
export function fieldLabel(key){return FIELD_LABELS[key]||key;}

// Front-end PII screen, kept in step with the database _contains_pii rule. The database remains authoritative.
export function containsPII(text) {
  if (!text) return false;
  return (
    /1[3-9][0-9]{9}/.test(text)
    || /[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]/.test(text)
    || /(住院号|病案号|门诊号|病历号|床号|mrn|admiss)[^a-z0-9]{0,3}[0-9]{3,}/i.test(text)
    || /(姓名|患者姓名|病人|name\s*[:：])\s*[一-龥]{2,4}/.test(text)
    || /[0-9]{8,}/.test(text)
    || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)
  );
}
export function assertNoPII(text, fieldLabel) {
  if (containsPII(text)) throw new Error(`「${fieldLabel}」中检测到疑似个人身份信息（手机号、身份证号、住院号、姓名等）。请删除后重新保存；仅使用研究编号。`);
}

const ERROR_MESSAGES=[
  ['visit_validation_failed','随访数据未通过系统校验，请核对数值与日期后重试。'],
  ['baseline_upcr_unit_required','请对照原始报告明确选择基线 UPCR 单位，再保存。'],
  ['conversion_mismatch','UPCR 原始值、单位与换算结果不一致，请重新填写并核对。'],
  ['record_changed_since_import','该记录在上次导入后已被修改。请重新导出核对，再通过“核对 / 更正”处理，避免覆盖新记录。'],
  ['previously_imported_record_deleted_requires_review','相同内容的随访记录曾录入后又被删除，系统暂停自动保存以便核对，请联系项目负责人确认。'],
  ['same_day_record_conflict','该患者在这一天已有一条数值不同的随访记录。同一天只保留一条，请打开该患者的“随访记录”核对并更正，不能重复录入。'],
  ['duplicate_patient_code_in_batch','同一批基线 CSV 出现重复研究编号，请合并或更正重复行。'],
  ['patient_not_registered','未在本项目找到该研究编号的基线记录，请先在“新增患者”中建立基线并核对编号。'],
  ['patient_not_found','未在本项目找到该研究编号，请先建立患者基线并核对编号。'],
  ['core_measurement_required','请至少填写一项测量值（血压、血肌酐或尿蛋白肌酐比）。'],
  ['patient_code_required','研究编号不能为空。'],
  ['visit_date_required','请填写随访日期。'],
  ['baseline_date_required_with_visits','该患者已有随访记录，基线日期不能清空。'],
  ['baseline_date_required','基线日期不能为空。'],
  ['baseline_date_after_existing_visit','基线日期晚于已有随访日期，请先核对基线与随访的原始日期。'],
  ['invalid_or_future_date','日期须为有效日期，且不能晚于今天。'],
  ['future_visit_date','随访日期不能晚于今天。'],
  ['future_baseline_date','基线日期不能晚于今天。'],
  ['visit_before_baseline','随访日期早于该患者的基线日期，请核对日期。'],
  ['missing_visit_date','请填写随访日期。'],
  ['invalid_iso_date','日期无效：格式须为 YYYY-MM-DD，且须是实际存在的日期（如 2 月没有 30 日）。'],
  ['invalid_patient_code','研究编号须为 1–64 个字符，不能包含首尾空格或控制字符。'],
  ['invalid_birth_year','出生年份无效。'],
  ['invalid_oxford_score','牛津分型评分超出允许范围。'],
  ['invalid_ln_score','LN 活动或慢性指数超出允许范围。'],
  ['invalid_sex','性别须为男或女。'],
  ['creatinine_must_be_positive','血肌酐须大于 0。'],
  ['non_finite_number','数值须为有限的数字。'],
  ['negative_value','该项数值不能为负数。'],
  ['notes_too_long','备注最多 500 字，请精简后重试。'],
  ['pii_detected','内容疑似包含个人身份信息，请删除后重试。'],
  ['batch_id_content_conflict','本次提交编号与内容不一致，请关闭对话框后重新录入。'],
  ['unsupported_column','提交内容包含系统不支持的字段，请刷新页面后重试。'],
  ['text_value_required','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['scalar_value_required','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['must_be_object','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['invalid_import_request','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['import_requires_1_to_500_rows','每次提交须为 1–500 行。'],
  ['project_access_denied','当前账户没有该项目的此项操作权限，请重新登录并确认项目与角色。'],
  ['subscription_required','账户试用期已结束或订阅已到期，项目当前为只读：可查看和导出，暂不能录入或发放随访链接。请核对账户权益。'],
  ['project_read_only','项目当前为只读状态，可查看和导出；请核对账户权益后继续录入。'],
  ['trial_expired','试用期限已结束，请核对账户权益后继续录入。'],
  ['role_read_only','当前项目角色为只读或分析，不能录入或更正数据。'],
  ['project_not_found','未找到该项目，可能已被删除或您没有访问权限。'],
  ['authentication_required','登录已过期，请重新登录。'],
  ['admin_only','当前账号没有执行此操作（如导出）的权限。'],
  ['quota_exceeded','已达到当前账户项目额度，请检查现有项目或订阅方案。'],
  ['export_table_too_large','单表数据已超过浏览器导出容量，请联系管理员安排服务器导出。'],
  ['export_payload_too_large','完整数据包已超过浏览器导出容量，请联系管理员安排服务器导出。'],
  ['metadata_only_snapshot','这是旧版本的元数据记录，没有保存当时的数据内容；请冻结新的数据版本。'],
  ['export_not_found','未找到该冻结数据版本。'],
  ['correction_reason_required','请填写 3–500 字的更正原因。'],
  ['correction_changes_required','没有需要保存的修改。'],
  ['identity_is_immutable','研究编号与项目归属不能修改。'],
  ['record_not_found','记录不存在或已被删除，请刷新后重试。'],
  ['resolution_required','请填写 3–500 字的处理说明。'],
  ['unit_not_allowed','所选单位不在该化验项目允许的单位范围内，请重新选择。'],
  ['invalid_lab_value','请填写有效的化验数值。'],
  ['lab_not_found','化验记录不存在或已被删除。'],
  ['invalid_token_options','随访链接有效期须为 1–365 天。'],
  ['token_invalid_or_expired','该随访链接已失效。'],
  ['token_not_found','未找到该随访链接，可能已被删除或不属于当前项目，请刷新列表。'],
  ['study_exit_reason_required','登记拒绝或撤回知情同意、退出研究或死亡，撤销退出，或修改已退出患者的研究状态时，请填写原因。'],
  ['study_status_requires_dedicated_action','研究状态（同意、退出、死亡等）请在患者的“研究状态”中修改，不能通过导入或更正修改。'],
  ['patient_not_eligible_for_links','该患者已拒绝或撤回知情同意，或已退出研究、死亡，不能再发放随访链接。如情况有变，请先在“研究状态”中按原始记录更新。'],
  ['egfr_out_of_range_check_scr','由血肌酐、出生年份和性别计算的 eGFR 超出范围，请核对这几项。'],
  ['revoke_reason_required','请填写 1–500 字的撤销原因（不含身份信息）。'],
  ['editor_permission_removed','录入成员的权限已变更，相关随访链接已由系统撤销。'],
  ['same_day_limit_exceeded','同一天提交次数已超过上限，该随访链接已被系统停用。'],
  ['rate_limited','提交过于频繁，请稍后再试。'],
  ['reason_required','请填写原因（不含身份信息）。'],
  ['reason_too_long','原因最多 500 字，请精简后重试。'],
  ['study_status_changes_required','没有需要保存的修改。'],
  ['consent_research_is_derived','研究同意请按“同意状态”记录；原“是/否”字段由系统自动生成。'],
  ['invalid_consent_version','知情同意书版本须为 1–100 个字符。'],
  ['setting_too_long','设置内容超过允许长度：研究名称、机构名称、联系方式最多 120 字，伦理批件号最多 80 字。'],
  ['invalid_setting_text','设置内容不能包含换行等控制字符。'],
  ['unsupported_setting','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['settings_must_be_object','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['setting_text_required','提交格式与系统要求不一致，请刷新页面后重试。'],
  ['followup_interval','随访间隔须为 7–730 天的整数。'],
  ['invalid_consent_status','知情同意状态取值无效，请重新选择。'],
  ['invalid_followup_status','随访状态取值无效，请重新选择。'],
  ['value_too_long','填写内容超过允许长度，请精简后重试。'],
  ['Invalid login credentials','邮箱或密码不正确。'],
  ['Email not confirmed','邮箱尚未验证，请先点击注册邮件中的验证链接。'],
  ['New password should be different','新密码不能与旧密码相同。'],
  ['Password should be','密码不符合要求，请按提示设置更安全的密码。'],
  ['For security purposes','操作过于频繁，请稍后再试。'],
];
const ERROR_PATTERNS=[
  [/does not exist|PGRST20[0-9]|42P01|42883|Could not find the (table|function)/i,'数据库尚未升级到与本页面匹配的版本，相关功能暂不可用，请联系平台管理员。'],
  [/JWT expired|invalid JWT|PGRST30[0-9]|refresh token/i,'登录已过期，请重新登录。'],
  [/permission denied|insufficient_privilege|not_authorized|42501/i,'当前账号没有此操作的权限。'],
  [/rate limit|too many requests/i,'操作过于频繁，请稍后再试。'],
  [/duplicate key|23505/i,'记录已存在（例如同一研究编号已建立基线），请核对后再保存。'],
  [/check constraint|23514/i,'提交的数据不符合系统约束，请核对后重试。'],
  [/value too long|22001/i,'填写内容超过允许长度，请精简后重试。'],
  [/statement timeout|57014/i,'服务器处理超时，请稍后重试；本次操作可能未完成，请刷新核对。'],
  [/Failed to fetch|NetworkError|Load failed|network|timed? ?out/i,'网络连接失败，请检查网络后重试；本次操作可能未完成，请刷新核对。'],
];
// Translate any error into plain Chinese. Raw English/database text and table names are never shown;
// the original is kept in the browser console for support.
const SETTING_LABELS=Object.freeze({followup_interval_days:'随访间隔',public_title:'对患者显示的研究名称',institution_name:'机构名称',ethics_approval_no:'伦理批件号',contact_display:'研究团队联系方式'});
// 数据库 CHECK 约束 → 中文字段名与允许范围。PostgREST 只返回约束名（在 message 中），不返回失败行之外的列名。
const CONSTRAINT_FIELDS=Object.freeze({
  visits_sbp_range:['收缩压','须在 40–300 mmHg 之间'],visits_dbp_range:['舒张压','须在 20–200 mmHg 之间'],
  visits_scr_range:['血肌酐','须在 10–5000 μmol/L 之间'],visits_egfr_range:['eGFR','须在 0–200 之间；eGFR 由血肌酐、出生年份和性别计算，请核对这几项'],
  visits_upcr_range:['尿蛋白肌酐比（UPCR）','不能为负数'],visits_long_upcr_range:['尿蛋白肌酐比（UPCR）','须在 0–50000 mg/g 之间'],
  baseline_scr_range:['基线血肌酐','须在 10–5000 μmol/L 之间'],baseline_upcr_range:['基线UPCR','不能为负数'],
  baseline_birth_year_range:['出生年份','须在 1900 年至今之间'],
  oxford_m_check:['牛津分型M','只能为 0 或 1'],oxford_e_check:['牛津分型E','只能为 0 或 1'],oxford_s_check:['牛津分型S','只能为 0 或 1'],
  oxford_t_check:['牛津分型T','只能为 0、1 或 2'],oxford_c_check:['牛津分型C','只能为 0、1 或 2'],
  ln_class_check:['LN病理分型','取值无效'],ln_activity_index_check:['LN活动指数','须在 0–24 之间'],ln_chronicity_index_check:['LN慢性指数','须在 0–12 之间'],
});
const COLUMN_KEYS=Object.keys(FIELD_LABELS).sort((a,b)=>b.length-a.length);
/** 约束错误对应的字段：先查已知约束，再从 column 或约束名中找已知列名。不读取 details（其中是失败行的原始内容）。 */
function constraintProblem(error,raw){
  const constraint=String(error?.constraint||raw.match(/violates check constraint "([^"]+)"/)?.[1]||'');
  if(CONSTRAINT_FIELDS[constraint]){const [label,rule]=CONSTRAINT_FIELDS[constraint];return `${label}${rule}，本次没有保存，请核对数值与单位后重试。`;}
  const column=String(error?.column||'');
  const key=FIELD_LABELS[column]?column:COLUMN_KEYS.find(k=>constraint&&new RegExp(`(^|_)${k}(_|$)`).test(constraint));
  return key?`${FIELD_LABELS[key]}的数值不符合系统约束，本次没有保存，请核对后重试。`:'';
}
export function registryErrorMessage(error, options = {}){
  const raw=String(error?.message ?? error ?? '');
  const row=raw.match(/row_(\d+)_/);
  // 例如 invalid_iso_date: consent_date —— 用中文字段名说明是哪一项。
  const field=raw.match(/:\s*([a-z_]+)\s*$/)?.[1];const fieldName=field&&(FIELD_LABELS[field]||SETTING_LABELS[field]);
  const prefix=(row&&options.rowPrefix!==false?`第 ${Number(row[1])+1} 行：`:'')+(fieldName?`${fieldName}：`:'');
  for(const [code,message]of ERROR_MESSAGES)if(raw.includes(code))return prefix+message;
  if(/check constraint|check_violation/i.test(raw)||error?.code==='23514'){const problem=constraintProblem(error,raw);if(problem)return prefix+problem;}
  const haystack=[raw,error?.code,error?.details].filter(Boolean).join(' ');
  for(const [pattern,message]of ERROR_PATTERNS)if(pattern.test(haystack))return prefix+message;
  if(/[一-龥]/.test(raw)&&!/[a-z_]{3,}\.[a-z_]{3,}|relation|function /i.test(raw))return prefix+raw;
  if(/[一-龥]/.test(error?.hint||''))return prefix+error.hint;
  if(raw&&typeof console!=='undefined')console.warn('[registry] 未翻译的错误：',raw);
  return prefix+'操作未完成，请稍后重试；如问题持续，请联系项目负责人或平台管理员。';
}
