// Pure helpers shared by patient submission and synthetic regression checks.
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizedNumber(value, multiplier = 1) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const result = Number(value) * multiplier;
  if (!Number.isFinite(result)) return null;
  // Unit conversion must not store binary noise such as 106.08000000000001.
  return multiplier === 1 ? result : Math.round(result * 1000) / 1000;
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

// ---- Patient-facing text helpers (pure; covered by tests/ui/patient-smoke.mjs) ----

const cleanText = value => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || null;
};

// Study header shown to the participant. Falls back to the project name only for the title.
export function studyInfo(ctx) {
  return {
    title: cleanText(ctx?.public_title) || cleanText(ctx?.project_name) || "随访研究",
    institution: cleanText(ctx?.institution_name),
    ethics: cleanText(ctx?.ethics_approval_no),
    contact: cleanText(ctx?.contact_display),
  };
}

// Server error codes and structured statuses -> plain Chinese with a next step.
// `kind` drives page behaviour; `message` is the only text a participant sees.
// Raw English error text is never returned.
const RULES = [
  [/token_expired/, "token", "这个随访链接已过期。请联系研究团队获取新的随访链接。"],
  [/token_revoked/, "token", "这个随访链接已被研究团队停用。如仍需填写，请联系研究团队。"],
  [/single_use_token_already_used|token_already_used|token_used/, "token", "这个随访链接只能提交一次，且已经提交过。如需补充或更正，请联系研究团队。"],
  [/token_invalid_or_expired/, "token", "这个随访链接已过期、已停用或已经使用过，现在不能再打开。请联系研究团队确认您的记录，需要时获取新的随访链接。"],
  [/token_invalid|token_not_found|invalid_token|missing_token/, "token", "无法识别这个随访链接。请确认打开的是研究团队发来的完整链接；仍不行请联系研究团队重新发送。"],
  [/patient_not_found/, "token", "没有找到与这个随访链接对应的研究记录。请联系研究团队。"],
  [/subscription_required|trial_expired|read_only|write_disabled|write_blocked|project_not_found|project_frozen|frozen/, "blocked", "本研究暂时不接受在线填报，请联系研究团队。"],
  [/rate_limited/, "limit", "短时间内提交次数过多，这个随访链接已暂停使用。请联系研究团队核对已有记录，需要时获取新的链接。"],
  [/same_day_limit/, "limit", "同一随访日期的提交次数已达上限，这个随访链接已暂停使用。请联系研究团队核对已有记录。"],
  [/duplicate|already_submitted|same_day_exists/, "duplicate", "这一天已经有一条随访记录，本次没有重复保存。如需更正，请联系研究团队。"],
  [/idempotency_conflict|receipt_not_available|submission_receipt_unavailable/, "conflict", "系统未能确认这次提交的结果。请不要重新填写，保留本页并联系研究团队核对。"],
  [/pii_detected_blocked/, "input", "备注中似乎有姓名、电话、病案号或身份证号等信息，请删除后再提交。"],
  [/future_visit_date/, "input", "随访日期不能晚于今天，请核对后重新填写。"],
  [/visit_before_baseline/, "input", "随访日期早于您入组研究的日期，请核对；如确认无误，请联系研究团队。"],
  [/invalid_blood_pressure/, "input", "舒张压应低于收缩压，请核对是否填反。"],
  [/missing_core_fields|missing_visit_date/, "input", "请填写随访日期、血压、血清肌酐和 UPCR 后再提交。"],
  [/notes_too_long/, "input", "备注最多填写 500 个字，请精简后再提交。"],
  [/invalid_visit|invalid_measurement|invalid_numeric_value|invalid_input|request_payload_mismatch/, "input", "有数值格式不正确，请对照化验单核对后重新填写。"],
  [/context_contract_unavailable/, "unavailable", "系统正在更新，暂时不能填写。请稍后再试，或联系研究团队。"],
  [/Failed to fetch|NetworkError|Load failed|network|timeout|fetch/i, "network", "网络连接不稳定，暂时没有收到服务器的确认。请检查网络后重试。"],
];

export function classifyPatientError(error) {
  const text = typeof error === "string" ? error
    : [error?.message, error?.details, error?.hint, error?.code, error?.status].filter(Boolean).join(" ");
  for (const [pattern, kind, message] of RULES) if (pattern.test(text)) return { kind, message };
  return { kind: "unknown", message: "暂时没有收到服务器的确认。请检查网络后重试；仍不行请联系研究团队。" };
}

// Message shown when a link cannot be opened (no server context available yet).
export function contextErrorMessage(error) {
  const result = classifyPatientError(error);
  if (result.kind === "network" || result.kind === "unknown") {
    return { kind: result.kind, message: "暂时无法打开这个随访链接。请检查网络后点击“重新验证链接”；如仍无法打开，请联系研究团队。" };
  }
  return result;
}

// Translate a structured patient_submit_visit_v2 result row.
export function submissionOutcome(row) {
  if (row && row.status === "submitted" && row.visit_id) {
    const replay = /无需重复|已提交过|already/.test(String(row.message || ""));
    return { kind: "submitted", replay, message: replay ? "这次填写此前已经保存成功，没有重复保存。" : "已提交。" };
  }
  if (row && row.status) return classifyPatientError(String(row.status));
  return classifyPatientError("submission_receipt_unavailable");
}

const pad = value => String(value).padStart(2, "0");

export function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatLocalDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${localDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatLocalDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? localDateString(date) : "";
}
