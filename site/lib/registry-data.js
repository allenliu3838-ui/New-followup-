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
  if (options.min != null && n < options.min || options.max != null && n > options.max) throw new Error(`${label}超出允许范围`);
  return n;
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
export async function readAllRows(sb, table, projectId, assertCurrent = ()=>{}, pageSize=500, filters={}) {
  const rows=[]; const ids=new Set(); let expected=null;
  for(;;){
    assertCurrent();
    let query=sb.from(table).select('*',{count:'exact'}).eq('project_id',projectId);
    for(const [key,value]of Object.entries(filters))query=query.eq(key,value);
    const {data,error,count}=await query.order('id',{ascending:true}).range(rows.length,rows.length+pageSize-1);
    assertCurrent(); if(error)throw error;
    if(!Array.isArray(data)||!Number.isInteger(count))throw new Error(`${table} 返回数据/数量不完整`);
    if(expected===null)expected=count;
    if(count!==expected)throw new Error(`${table} 在读取期间发生变化，请重试`);
    if(expected>100000)throw new Error(`${table} 超过浏览器导出容量，请联系管理员使用服务器导出`);
    for(const r of data){if(!r.id||ids.has(r.id))throw new Error(`${table} 分页记录重复或缺少 ID`);ids.add(r.id);rows.push(r);}
    if(rows.length===expected)return rows;
    if(!data.length||rows.length>expected)throw new Error(`${table} 导出数量不一致，已停止`);
  }
}
export function exportColumns(rows, preferred=[]) {
  return [...new Set([...preferred,...rows.flatMap(r=>Object.keys(r))])];
}
export async function sha256Text(text) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const BASELINE_IMPORT_FIELDS=['patient_code','sex','birth_year','baseline_date','baseline_scr','baseline_upcr','baseline_upcr_unit','biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class','ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date'];
export const VISIT_IMPORT_FIELDS=['patient_code','visit_date','sbp','dbp','scr_umol_l','upcr','egfr','notes'];
export function normalizeImportRow(kind,input,defaultUpcrUnit=''){
  const allowed=kind==='baseline'?BASELINE_IMPORT_FIELDS:VISIT_IMPORT_FIELDS;
  const result={};
  for(const [key,value]of Object.entries(input)){
    if(!allowed.includes(key))throw new Error(`不支持的列：${key}`);
    if(value!==''&&value!=null)result[key]=String(value).trim();
  }
  if(!result.patient_code)throw new Error('patient_code 不能为空');
  if(kind==='baseline'){
    if(result.sex){result.sex=({'男':'M','女':'F','M':'M','F':'F'})[result.sex];if(!result.sex)throw new Error('性别须为 M/F/男/女');}
    const nums={birth_year:{integer:true,min:1900,max:new Date().getUTCFullYear()},baseline_scr:{min:0.01,max:3000},oxford_m:{integer:true,min:0,max:1},oxford_e:{integer:true,min:0,max:1},oxford_s:{integer:true,min:0,max:1},oxford_t:{integer:true,min:0,max:2},oxford_c:{integer:true,min:0,max:2},ln_activity_index:{min:0,max:24},ln_chronicity_index:{min:0,max:12}};
    for(const [key,opts]of Object.entries(nums))if(key in result)result[key]=finiteNumber(result[key],key,opts);
    for(const key of ['baseline_date','biopsy_date','ln_biopsy_date','randomization_date'])if(key in result)result[key]=strictDate(result[key],key);
    if('ln_podocytopathy'in result){const map={true:true,false:false,'是':true,'否':false};if(!(result.ln_podocytopathy in map))throw new Error('ln_podocytopathy 须为 true/false/是/否');result.ln_podocytopathy=map[result.ln_podocytopathy];}
    if('baseline_upcr'in result){const unit=result.baseline_upcr_unit||defaultUpcrUnit;if(!unit)throw new Error('基线 UPCR 缺少单位，请在 CSV 中填写 baseline_upcr_unit 或在页面明确选择');const raw=finiteNumber(result.baseline_upcr,'UPCR',{min:0});result.baseline_upcr=normalizeUpcr(raw,unit);result.baseline_upcr_unit='mg/g';result.baseline_upcr_raw=raw;result.baseline_upcr_original_unit=unit;}else delete result.baseline_upcr_unit;
  }else{
    result.visit_date=strictDate(result.visit_date,'visit_date',true);
    for(const [key,opts]of Object.entries({sbp:{min:30,max:300,required:true},dbp:{min:10,max:200,required:true},scr_umol_l:{min:0.01,max:3000,required:true},upcr:{min:0,required:true},egfr:{min:0}})){if(opts.required||key in result)result[key]=finiteNumber(result[key],key,opts);}
    if(result.sbp<=result.dbp)throw new Error('收缩压须大于舒张压');
  }
  return result;
}

export function registryErrorMessage(error){
  const raw=String(error?.message ?? error ?? '未知错误');
  const row=raw.match(/row_(\d+)_/);const prefix=row?`第 ${Number(row[1])+1} 行：`:'';
  const mapping=[
    ['baseline_upcr_unit_required','请对照原始报告明确选择基线 UPCR 单位，再保存。'],
    ['conversion_mismatch','UPCR 原始值、单位与换算结果不一致，请重新填写并核对。'],
    ['record_changed_since_import','该记录在上次导入后已被修改。请重新导出核对，再通过“核对 / 更正”处理，避免覆盖新记录。'],
    ['same_day_record_conflict','该患者当天已有不同内容的随访。请打开患者“随访记录”核对并更正，不能直接重复导入。'],
    ['duplicate_patient_code_in_batch','同一批基线 CSV 出现重复研究编号，请合并或更正重复行。'],
    ['project_access_denied','当前账户没有该项目的操作权限，请重新登录并确认项目。'],
    ['quota_exceeded','已达到当前账户项目额度，请检查现有项目或订阅方案。'],
    ['export_table_too_large','单表数据已超过浏览器导出容量，请联系管理员安排服务器导出。'],
    ['export_payload_too_large','完整数据包已超过浏览器导出容量，请联系管理员安排服务器导出。'],
    ['baseline_date_after_existing_visit','基线日期晚于已有随访日期，请先核对基线与随访的原始日期。'],
    ['project_read_only','项目当前为只读状态，可查看和导出；请核对账户权益后继续录入。'],
    ['trial_expired','试用期限已结束，请核对账户权益后继续录入。'],
    ['patient_not_found','未找到该项目中的研究编号，请先创建患者基线并核对编号。']
  ];
  for(const [code,message]of mapping)if(raw.includes(code))return prefix+message;
  return raw;
}
