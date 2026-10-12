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

// Hard limits mirrored from the visits_long CHECK constraints (0002_clinical_constraints.sql,
// 0014_pr3_validators.sql). A value outside them is refused by the database, so it is
// stopped here with a clear message instead of being sent. Keep in sync with migrations.
export const DB_LIMITS = Object.freeze({
  sbp: [40, 300],          // visits_sbp_range, mmHg
  dbp: [20, 200],          // visits_dbp_range, mmHg
  scr_umol: [10, 5000],    // visits_scr_range, μmol/L (after unit conversion)
  upcr_mgg: [0, 50000],    // visits_upcr_range + visits_long_upcr_range, mg/g
  egfr: [0, 200],          // visits_egfr_range; the server computes eGFR from creatinine
});
export const SCR_MGDL_TO_UMOL = 88.4;
const inRange = (value, [min, max]) => value >= min && value <= max;

export function validateVisit(values) {
  const scrRaw = normalizedNumber(values.scr);
  const upcrRaw = normalizedNumber(values.upcr);
  const scr = normalizedNumber(values.scr, values.scrUnit === 'mgdl' ? SCR_MGDL_TO_UMOL : 1);
  const upcr = normalizedNumber(values.upcr, values.upcrUnit === 'gg' ? 1000 : 1);
  const sbp = normalizedNumber(values.sbp);
  const dbp = normalizedNumber(values.dbp);
  const errors = [];
  const [sbpMin, sbpMax] = DB_LIMITS.sbp;
  const [dbpMin, dbpMax] = DB_LIMITS.dbp;
  const [scrMin, scrMax] = DB_LIMITS.scr_umol;
  const upcrMax = DB_LIMITS.upcr_mgg[1];
  if (!isCalendarDate(values.visitDate)) errors.push({ field: 'visitDate', message: '请填写有效的随访日期。' });
  if (sbp === null || sbp <= 0) errors.push({ field: 'sbp', message: '收缩压需为大于 0 的有限数值。' });
  else if (!inRange(sbp, DB_LIMITS.sbp)) errors.push({ field: 'sbp', message: `收缩压 ${sbp} mmHg 不在可接受范围（${sbpMin}–${sbpMax} mmHg）内，请对照原始记录核对。` });
  if (dbp === null || dbp <= 0) errors.push({ field: 'dbp', message: '舒张压需为大于 0 的有限数值。' });
  else if (!inRange(dbp, DB_LIMITS.dbp)) errors.push({ field: 'dbp', message: `舒张压 ${dbp} mmHg 不在可接受范围（${dbpMin}–${dbpMax} mmHg）内，请对照原始记录核对。` });
  if (sbp !== null && dbp !== null && sbp <= dbp) errors.push({ field: 'sbp', message: '收缩压应高于舒张压，请核对是否填反。' });
  if (!['umol', 'mgdl'].includes(values.scrUnit) || scr === null || scr <= 0) {
    errors.push({ field: 'scr', message: '请填写大于 0 的肌酐数值并选择单位。' });
  } else if (!inRange(scr, DB_LIMITS.scr_umol)) {
    // The commonest slip: a mg/dL result (e.g. 1.1) typed while the unit is still μmol/L, or the reverse.
    const looksMgdl = values.scrUnit === 'umol' && scr < scrMin && inRange(scrRaw * SCR_MGDL_TO_UMOL, DB_LIMITS.scr_umol);
    const looksUmol = values.scrUnit === 'mgdl' && scr > scrMax && inRange(scrRaw, DB_LIMITS.scr_umol);
    errors.push({ field: 'scr', message: looksMgdl
      ? `肌酐 ${scrRaw} μmol/L 低于可接受范围，数值看起来是 mg/dL，请切换单位（选择 mg/dL）后再核对。`
      : looksUmol
        ? `肌酐 ${scrRaw} mg/dL 换算后超出可接受范围，数值看起来是 μmol/L，请切换单位（选择 μmol/L）后再核对。`
        : `肌酐换算后为 ${scr} μmol/L，不在可接受范围（${scrMin}–${scrMax} μmol/L）内，请核对数值和单位。` });
  }
  if (!['mgg', 'gg'].includes(values.upcrUnit) || upcr === null || upcr < 0) {
    errors.push({ field: 'upcr', message: '请填写非负的 UPCR 数值并选择单位；缺失结果不能用 0 代替。' });
  } else if (upcr > upcrMax) {
    const looksMgg = values.upcrUnit === 'gg' && upcrRaw <= upcrMax;
    errors.push({ field: 'upcr', message: looksMgg
      ? `UPCR ${upcrRaw} g/g 换算后超出可接受范围，数值看起来是 mg/g，请切换单位（选择 mg/g）后再核对。`
      : `UPCR 不能超过 ${upcrMax} mg/g（即 ${upcrMax / 1000} g/g），请核对数值和单位。` });
  }
  if (String(values.notes || '').length > 500) errors.push({ field: 'notes', message: '备注最多填写 500 个字符，请精简后再提交。' });
  const failed = field => errors.some(error => error.field === field);
  const warnings = [];
  if (!failed('sbp') && sbp !== null && (sbp < 70 || sbp > 220)) warnings.push(`收缩压 ${sbp} mmHg 超出常见范围，请对照原始记录核对`);
  if (!failed('dbp') && dbp !== null && (dbp < 40 || dbp > 130)) warnings.push(`舒张压 ${dbp} mmHg 超出常见范围，请对照原始记录核对`);
  if (!failed('scr') && scr !== null && (scr < 20 || scr > 2000)) warnings.push(`肌酐 ${scr} μmol/L 超出常见范围，请核对数值和单位`);
  if (!failed('upcr') && upcr !== null && upcr > 10000) warnings.push(`UPCR ${upcr} mg/g 超出常见范围，请核对数值和单位`);
  if (!failed('upcr') && values.upcrUnit === 'mgg' && upcr !== null && upcr > 0 && upcr < 10) warnings.push(`UPCR ${upcr} mg/g 很低，如果化验单上的单位是 g/g，请切换单位`);
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

// ---- The link in the address bar ----

// The link arrives as /followup#<link> (current), /p/<link> (older messages) or ?pt=<link>.
export function linkFromAddress({ hash = '', pathname = '', search = '' } = {}) {
  try {
    if (hash && hash.length > 1) return decodeURIComponent(hash.slice(1)) || null;
    const m = String(pathname).match(/\/p\/([^/]+)$/);
    if (m) return decodeURIComponent(m[1]) || null;
    const q = new URLSearchParams(search);
    return q.get('pt') || q.get('token') || null;
  } catch (_) { return null; }
}

// The same address without the link: no fragment, no pt/token parameter, and /p/<link>
// rewritten to /followup. Used with history.replaceState so the link is not kept in the
// browser history, the address bar or a bookmark; the page keeps it in memory only.
export function addressWithoutLink(href) {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.delete('pt');
  url.searchParams.delete('token');
  url.pathname = url.pathname.replace(/\/p\/[^/]*$/, '/followup');
  return url.pathname + url.search;
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

// Default wording for where the data is stored. The storage location will change when the
// database moves to mainland China, so deployments override it with CONFIG.DATA_LOCATION_NOTE
// instead of the page text hard-coding it.
export const DEFAULT_DATA_LOCATION_NOTE = "数据当前存储于境外服务器，计划迁至中国境内，详见隐私政策";

export function dataLocationNote(config) {
  return cleanText(config?.DATA_LOCATION_NOTE) || DEFAULT_DATA_LOCATION_NOTE;
}

// Text placed before the page's own "隐私政策" link, so the note reads as one sentence
// whichever wording the deployment configures. Plain text only (rendered with textContent).
export function dataLocationLead(config) {
  const note = dataLocationNote(config).replace(/[。．.\s]+$/u, "");
  return note.endsWith("隐私政策") ? note.slice(0, -"隐私政策".length) : `${note}。详见`;
}

export const EXITED_MESSAGE = "您已退出本研究，无需再填写。如有疑问请联系研究团队。";

// Server error codes and structured statuses -> plain Chinese with a next step.
// `kind` drives page behaviour; `message` is the only text a participant sees.
// Raw English error text is never returned.
const RULES = [
  [/patient_exited|patient_not_eligible|consent_withdrawn|consent_refused|patient_withdrawn/, "exited", EXITED_MESSAGE],
  [/token_expired/, "token", "这个随访链接已过期。请联系研究团队获取新的随访链接。"],
  [/token_revoked/, "token", "这个随访链接已被研究团队停用。如仍需填写，请联系研究团队。"],
  [/single_use_token_already_used|token_already_used|token_used/, "token", "这个随访链接只能提交一次，且已经提交过。如需补充或更正，请联系研究团队。"],
  [/token_invalid_or_expired/, "token", "这个随访链接已过期、已停用或已经使用过，现在不能再打开。请联系研究团队确认您的记录，需要时获取新的随访链接。"],
  [/token_invalid|token_not_found|invalid_token|missing_token/, "token", "无法识别这个随访链接。请确认打开的是研究团队发来的完整链接；仍不行请联系研究团队重新发送。"],
  [/patient_not_found/, "token", "没有找到与这个随访链接对应的研究记录。请联系研究团队。"],
  [/subscription_required|trial_expired|read_only|write_disabled|write_blocked|project_not_found|project_frozen|frozen/, "blocked", "本研究暂时不接受在线填报，请联系研究团队。"],
  [/rate_limited/, "limit", "短时间内提交次数过多，这个随访链接已暂停使用。请联系研究团队核对已有记录，需要时获取新的链接。"],
  [/same_day_limit/, "limit", "同一随访日期的提交次数已达上限，这个随访链接已暂停使用。请联系研究团队核对已有记录。"],
  [/idempotency_conflict|receipt_not_available|submission_receipt_unavailable/, "conflict", "系统未能确认这次提交的结果。请不要重新填写，保留本页并联系研究团队核对。"],
  [/pii_detected_blocked/, "input", "备注中似乎有姓名、电话、病案号或身份证号等信息，请删除后再提交。"],
  [/future_visit_date/, "input", "随访日期不能晚于今天，请核对后重新填写。"],
  [/visit_before_baseline/, "input", "随访日期早于您入组研究的日期，请核对；如确认无误，请联系研究团队。"],
  [/invalid_blood_pressure/, "input", "舒张压应低于收缩压，请核对是否填反。"],
  [/missing_core_fields|missing_visit_date/, "input", "请填写随访日期、血压、血清肌酐和 UPCR 后再提交。"],
  [/notes_too_long/, "input", "备注最多填写 500 个字，请精简后再提交。"],
  [/invalid_visit|invalid_measurement|invalid_numeric_value|invalid_input|request_payload_mismatch/, "input", "有数值格式不正确，请对照化验单核对后重新填写。"],
  [/context_contract_unavailable/, "unavailable", "系统正在更新，暂时不能填写。请稍后再试，或联系研究团队。"],
  [/Failed to fetch|NetworkError|Load failed|network|timeout|fetch|AbortError|abort/i, "network", "网络连接不稳定，暂时没有收到服务器的确认。请检查网络后重试。"],
];

// Values the database refused (CHECK constraint 23514, numeric overflow 22003, or the
// structured status 'invalid_values'). Nothing was saved and a single-use link is not used up,
// so the participant goes back to the form instead of retrying the same payload.
const VALUE_ERROR = /invalid_values|violates check constraint|check_violation|out of range/i;
const FIELD_ORDER = ["visitDate", "sbp", "dbp", "scr", "upcr", "notes"];
const FIELD_LABELS = { visitDate: "随访日期", sbp: "收缩压", dbp: "舒张压", scr: "血清肌酐", upcr: "UPCR", notes: "备注" };
// Column, parameter or constraint names -> form field. eGFR is computed from creatinine.
const FIELD_PATTERNS = [
  ["visitDate", /(?:^|[^a-z0-9])(?:p_)?visit_?date(?:[^a-z0-9]|$)/i],
  ["sbp", /(?:^|[^a-z0-9])(?:p_)?sbp(?:[^a-z0-9]|$)/i],
  ["dbp", /(?:^|[^a-z0-9])(?:p_)?dbp(?:[^a-z0-9]|$)/i],
  ["scr", /(?:^|[^a-z0-9])(?:p_)?(?:scr|scr_umol_l|creatinine|egfr)(?:[^a-z0-9]|$)/i],
  ["upcr", /(?:^|[^a-z0-9])(?:p_)?upcr(?:[^a-z0-9]|$)/i],
  ["notes", /(?:^|[^a-z0-9])(?:p_)?notes(?:[^a-z0-9]|$)/i],
];
const FIELD_KEYS = ["invalid_fields", "invalid_field", "invalid_columns", "invalid_column", "fields", "field", "columns", "column", "message", "details", "detail", "hint", "constraint"];

const flatText = value => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(flatText).join(",");
  if (typeof value === "object") { try { return JSON.stringify(value); } catch (_) { return ""; } }
  return String(value);
};

// Accepts arrays, comma/semicolon separated strings, JSON text or constraint names.
export function invalidFieldsOf(source) {
  const text = typeof source === "string" ? source
    : FIELD_KEYS.map(key => flatText(source?.[key])).filter(Boolean).join(" ; ");
  return FIELD_ORDER.filter(field => FIELD_PATTERNS.some(([name, pattern]) => name === field && pattern.test(text)));
}

function valueError(source) {
  const fields = invalidFieldsOf(source);
  const labels = fields.map(field => FIELD_LABELS[field]);
  const message = labels.length
    ? `输入有误：${labels.join("、")}超出系统可接受的范围，本次没有保存。请对照化验单核对数值和单位后修改。`
    : "输入有误：有数值超出系统可接受的范围，本次没有保存。请对照化验单核对各项数值和单位后修改。";
  return { kind: "input", message, fields };
}

export function classifyPatientError(error) {
  const code = typeof error === "object" && error ? String(error.code || "") : "";
  // A CHECK violation's details echo the whole failing row (including the notes the
  // participant typed), so only the message (which names the constraint) is inspected.
  if (code === "23514" || code === "22003") return valueError({ message: error.message, hint: error.hint, constraint: error.constraint });
  const lead = typeof error === "string" ? error : String(error?.message || "");
  if (VALUE_ERROR.test(lead)) return valueError(error);
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
  if (row && /^invalid_values?$/.test(String(row.status || ""))) return valueError(row);
  if (row && row.status) return classifyPatientError(String(row.status));
  return classifyPatientError("submission_receipt_unavailable");
}

// The server decides "today" in Beijing time (UTC+8, no daylight saving), so the
// latest selectable visit date follows the same calendar on every device.
export function beijingDateString(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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
