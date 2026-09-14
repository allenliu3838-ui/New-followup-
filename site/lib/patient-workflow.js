// Pure helpers shared by patient submission and synthetic regression checks.
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizedNumber(value, multiplier = 1) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const result = Number(value) * multiplier;
  return Number.isFinite(result) ? result : null;
}

export function validateVisit(values) {
  const scr = normalizedNumber(values.scr, values.scrUnit === 'mgdl' ? 88.4 : 1);
  const upcr = normalizedNumber(values.upcr, values.upcrUnit === 'gg' ? 1000 : 1);
  const sbp = normalizedNumber(values.sbp);
  const dbp = normalizedNumber(values.dbp);
  const errors = [];
  if (!isCalendarDate(values.visitDate)) errors.push({ field: 'visitDate', message: '请填写有效的随访日期。' });
  if (sbp === null || sbp <= 0) errors.push({ field: 'sbp', message: '收缩压需为大于 0 的有限数值。' });
  if (dbp === null || dbp <= 0) errors.push({ field: 'dbp', message: '舒张压需为大于 0 的有限数值。' });
  if (sbp !== null && dbp !== null && sbp <= dbp) errors.push({ field: 'sbp', message: '收缩压应高于舒张压，请核对是否填反。' });
  if (!['umol', 'mgdl'].includes(values.scrUnit) || scr === null || scr <= 0) errors.push({ field: 'scr', message: '请填写大于 0 的肌酐数值并选择单位。' });
  if (!['mgg', 'gg'].includes(values.upcrUnit) || upcr === null || upcr < 0) errors.push({ field: 'upcr', message: '请填写非负的 UPCR 数值并选择单位；缺失结果不能用 0 代替。' });
  if (String(values.notes || '').length > 500) errors.push({ field: 'notes', message: '备注最多填写 500 个字符，请精简后再提交。' });
  const warnings = [];
  if (sbp !== null && (sbp < 70 || sbp > 220)) warnings.push(`收缩压 ${sbp} mmHg 超出常见范围，请对照原始记录核对`);
  if (dbp !== null && (dbp < 40 || dbp > 130)) warnings.push(`舒张压 ${dbp} mmHg 超出常见范围，请对照原始记录核对`);
  if (scr !== null && (scr < 20 || scr > 2000)) warnings.push(`肌酐 ${scr} μmol/L 超出常见范围，请核对数值和单位`);
  if (upcr !== null && upcr > 10000) warnings.push(`UPCR ${upcr} mg/g 超出常见范围，请核对数值和单位`);
  return { visitDate: values.visitDate, sbp, dbp, scr_umol: scr, upcr_mgg: upcr, notes: values.notes || '', errors, warnings };
}

export function createRequestId(cryptoProvider) {
  if (cryptoProvider?.randomUUID) return cryptoProvider.randomUUID();
  if (!cryptoProvider?.getRandomValues) throw new Error('当前浏览器不能生成安全的提交编号，请使用更新的浏览器。');
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export function ckdepi2021(scrMgDl, age, sex) {
  if (!Number.isFinite(scrMgDl) || scrMgDl <= 0 || !Number.isFinite(age) || age < 18 || age > 120 || !['M', 'F'].includes(String(sex).toUpperCase())) return null;
  const female = String(sex).toUpperCase() === 'F';
  const ratio = scrMgDl / (female ? 0.7 : 0.9);
  const result = 142 * Math.pow(Math.min(ratio, 1), female ? -0.241 : -0.302) * Math.pow(Math.max(ratio, 1), -1.2) * Math.pow(0.9938, age) * (female ? 1.012 : 1);
  return Number.isFinite(result) ? result : null;
}
