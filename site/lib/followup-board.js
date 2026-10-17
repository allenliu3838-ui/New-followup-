// 随访看板：纯函数与 HTML 片段。不访问网络、不读写全局状态，可在 Node 中直接导入测试。
// 状态（逾期/即将到期等）一律以数据库视图 v_patient_followup_status 的计算结果为准，前端只负责排序、筛选与展示。

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const FOLLOWUP_STATES = Object.freeze({
  overdue: { label: '逾期', tone: 'bad', rank: 0 },
  due_soon: { label: '即将到期', tone: 'warn', rank: 1 },
  no_visit: { label: '尚无随访', tone: 'info', rank: 2 },
  ok: { label: '正常', tone: 'ok', rank: 3 },
  inactive: { label: '已停止随访', tone: 'muted', rank: 4 },
});

export const CONSENT_STATUSES = Object.freeze({
  unconfirmed: { label: '未确认', tone: 'warn' },
  consented: { label: '已同意', tone: 'ok' },
  waiver: { label: '伦理批准豁免', tone: 'ok' },
  declined: { label: '拒绝', tone: 'bad' },
  withdrawn: { label: '撤回', tone: 'bad' },
});

export const FOLLOWUP_STATUSES = Object.freeze({
  active: '在访',
  lost: '失访',
  withdrawn: '退出',
  deceased: '死亡',
  kidney_failure: '肾衰竭',
  transferred: '转院',
});

/** 研究状态对话框中的选项文字；判定标准以研究方案为准。 */
export const FOLLOWUP_STATUS_OPTIONS = Object.freeze({ ...FOLLOWUP_STATUSES, withdrawn: '退出研究', kidney_failure: '肾衰竭（按研究方案判定）' });

// 改为这些取值（或从这些取值改回）时必须填写原因。
export const REASON_REQUIRED_CONSENT = Object.freeze(['declined', 'withdrawn']);
export const REASON_REQUIRED_FOLLOWUP = Object.freeze(['lost', 'withdrawn', 'deceased', 'kidney_failure', 'transferred']);

/**
 * 账户只读（试用到期等）时仍可登记的“退出类”状态：拒绝或撤回同意、停止随访，及对应日期。
 * 与数据库 registry_private.study_exit_only_change 一致；数据库仍是最终校验。
 */
export const EXIT_CONSENT_STATUSES = REASON_REQUIRED_CONSENT;
export const EXIT_FOLLOWUP_STATUSES = REASON_REQUIRED_FOLLOWUP;

/** 同意日期记录“当前同意状态”对应的日期，标签随所选状态变化。 */
export function consentDateLabel(status) {
  return ({ consented: '签署日期', waiver: '伦理批准日期', declined: '拒绝日期', withdrawn: '撤回日期' })[status] || '同意状态日期';
}

/** 看板不再提醒随访的原因：随访状态优先，其次是拒绝或撤回同意。 */
export function inactiveReason(row) {
  if (row?.followup_status && row.followup_status !== 'active' && FOLLOWUP_STATUSES[row.followup_status]) return FOLLOWUP_STATUSES[row.followup_status];
  if (row?.consent_status === 'declined') return '拒绝同意';
  if (row?.consent_status === 'withdrawn') return '撤回同意';
  return '';
}

/** 状态徽章文字：尚无随访的患者到期或逾期时注明“尚无随访”，排序仍按逾期优先。 */
export function stateBadgeLabel(row) {
  const state = FOLLOWUP_STATES[row?.followup_state];
  if (!state) return '—';
  if (Number(row.visit_count) === 0 && (row.followup_state === 'overdue' || row.followup_state === 'due_soon')) return `尚无随访·${state.label}`;
  return state.label;
}

export const STATE_FILTERS = Object.freeze([
  ['all', '全部'], ['active', '在访'], ['overdue', '逾期'], ['due_soon', '即将到期'],
  ['no_visit', '尚无随访'], ['ok', '正常'], ['inactive', '已停止随访'],
]);
export const CONSENT_FILTERS = Object.freeze([
  ['all', '全部'], ['unconfirmed', '未确认'], ['confirmed', '已同意或豁免'], ['refused', '拒绝或撤回'],
]);

const pad = n => String(n).padStart(2, '0');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  if (!ISO_DATE.test(String(value || ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 浏览器本地日期（不是 UTC），用于“今天”的默认值。 */
export function localToday(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatLocalDate(value) {
  if (!value) return '';
  if (ISO_DATE.test(String(value))) return String(value);
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? localToday(d) : String(value);
}

export function formatLocalDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return `${localToday(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 两个 YYYY-MM-DD 之间相差的天数（to - from）。 */
export function daysBetween(fromIso, toIso) {
  if (!isIsoDate(fromIso) || !isIsoDate(toIso)) return null;
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

export function formatCount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
}

/** 0–1 的比例显示为百分比；无随访（NULL）时显示“—”。 */
export function formatPercent(fraction) {
  if (fraction === null || fraction === undefined || fraction === '') return '—';
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '—';
  return `${Number((n * 100).toFixed(1))}%`;
}

// ── 看板：筛选与排序 ──────────────────────────────────────────

export function matchesState(row, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'active') return row.followup_state !== 'inactive' && (row.followup_status ?? 'active') === 'active';
  return row.followup_state === filter;
}

export function matchesConsent(row, filter) {
  if (!filter || filter === 'all') return true;
  const status = row.consent_status || 'unconfirmed';
  if (filter === 'unconfirmed') return status === 'unconfirmed';
  if (filter === 'confirmed') return status === 'consented' || status === 'waiver';
  if (filter === 'refused') return status === 'declined' || status === 'withdrawn';
  return true;
}

/** 默认排序：逾期（最久未随访者在前）→ 即将到期 → 尚无随访 → 正常 → 已停止随访。 */
export function compareBoardRows(a, b) {
  const ra = FOLLOWUP_STATES[a.followup_state]?.rank ?? 9;
  const rb = FOLLOWUP_STATES[b.followup_state]?.rank ?? 9;
  if (ra !== rb) return ra - rb;
  const da = a.next_due_date || '9999-12-31';
  const db = b.next_due_date || '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  return String(a.patient_code ?? '').localeCompare(String(b.patient_code ?? ''), 'zh-CN', { numeric: true });
}

export function sortBoardRows(rows) {
  return [...(rows || [])].sort(compareBoardRows);
}

export function filterBoardRows(rows, { state = 'all', consent = 'all', search = '' } = {}) {
  const needle = String(search || '').trim().toLowerCase();
  return sortBoardRows(rows).filter(r => matchesState(r, state) && matchesConsent(r, consent)
    && (!needle || String(r.patient_code ?? '').toLowerCase().includes(needle)));
}

export function countStates(rows) {
  const counts = Object.fromEntries(STATE_FILTERS.map(([key]) => [key, 0]));
  for (const r of rows || []) for (const [key] of STATE_FILTERS) if (matchesState(r, key)) counts[key]++;
  return counts;
}

// ── 概览面板 ─────────────────────────────────────────────────

function tile({ metric, value, label, tone = '', filter, consent, action, hint }) {
  const cls = `fu-tile${tone ? ' tone-' + tone : ''}`;
  const body = `<span class="fu-tile-num">${escapeHtml(value)}</span><span class="fu-tile-label">${escapeHtml(label)}</span>${hint ? `<span class="fu-tile-hint">${escapeHtml(hint)}</span>` : ''}`;
  if (filter || consent || action) {
    const attrs = [filter ? `data-board-filter="${escapeHtml(filter)}"` : '', consent ? `data-consent-filter="${escapeHtml(consent)}"` : '', action ? `data-overview-action="${escapeHtml(action)}"` : ''].filter(Boolean).join(' ');
    const goal = action === 'issues' ? '查看数据质控问题' : '在随访看板中筛选';
    return `<button type="button" class="${cls}" data-metric="${metric}" ${attrs} aria-label="${escapeHtml(`${label}：${value}，${goal}`)}">${body}</button>`;
  }
  return `<div class="${cls} is-static" data-metric="${metric}">${body}</div>`;
}

export function renderOverviewHtml(o) {
  if (!o) return '<p class="muted small">暂无概览数据。</p>';
  const interval = Number(o.followup_interval_days);
  const groups = [
    ['入组与随访', [
      tile({ metric: 'n_patients', value: formatCount(o.n_patients), label: '入组患者', filter: 'all', consent: 'all' }),
      tile({ metric: 'n_active', value: formatCount(o.n_active), label: '在访', filter: 'active' }),
      tile({ metric: 'n_visits', value: formatCount(o.n_visits), label: '随访记录' }),
      tile({ metric: 'n_visits_30d', value: formatCount(o.n_visits_30d), label: '近 30 天随访（按随访日期）' }),
    ]],
    ['谁该随访', [
      tile({ metric: 'n_overdue', value: formatCount(o.n_overdue), label: '逾期', tone: Number(o.n_overdue) > 0 ? 'bad' : '', filter: 'overdue' }),
      tile({ metric: 'n_due_soon', value: formatCount(o.n_due_soon), label: '14 天内到期', tone: Number(o.n_due_soon) > 0 ? 'warn' : '', filter: 'due_soon' }),
      tile({ metric: 'n_no_visit', value: formatCount(o.n_no_visit), label: '尚无随访', hint: '未到首次随访日期', filter: 'no_visit' }),
    ]],
    ['数据质量与知情同意', [
      tile({ metric: 'core_completeness', value: formatPercent(o.core_completeness), label: '核心四项完整率', hint: o.n_visits ? `${formatCount(o.n_core_complete_visits)} / ${formatCount(o.n_visits)} 条随访` : '尚无随访' }),
      tile({ metric: 'n_consent_confirmed', value: formatCount(o.n_consent_confirmed), label: '知情同意已确认', consent: 'confirmed', filter: 'all' }),
      tile({ metric: 'n_consent_unconfirmed', value: formatCount(o.n_consent_unconfirmed), label: '知情同意未确认', tone: Number(o.n_consent_unconfirmed) > 0 ? 'warn' : '', consent: 'unconfirmed', filter: 'all' }),
      tile({ metric: 'n_open_issues', value: formatCount(o.n_open_issues), label: '待处理数据质控问题', tone: Number(o.n_open_issues) > 0 ? 'warn' : '', action: 'issues' }),
    ]],
  ];
  const notes = [
    Number.isFinite(interval) ? `随访间隔按项目设置为 ${interval} 天，“下次应随访日期”= 最近一次随访（无随访时为基线日期）+ 随访间隔；尚无随访的患者到期后同样计入“逾期”或“14 天内到期”。拒绝或撤回知情同意、或已停止随访的患者不再提醒。日期按北京时间计算。` : '',
    o.last_visit_date ? `最近一次随访：${escapeHtml(o.last_visit_date)}。` : '',
    '核心四项指收缩压、舒张压、血肌酐、尿蛋白肌酐比均已填写（且有随访日期）的随访。点击数字可在下方看板中筛选。',
  ].filter(Boolean).join('');
  return `<div class="fu-tile-groups">${groups.map(([title, tiles]) => `<div class="fu-tile-group"><h3>${escapeHtml(title)}</h3><div class="fu-tiles">${tiles.join('')}</div></div>`).join('')}</div><p class="muted small fu-overview-note">${notes}</p>`;
}

// ── 看板表格 ─────────────────────────────────────────────────

function badge(label, tone) {
  return `<span class="fu-badge tone-${escapeHtml(tone || 'muted')}">${escapeHtml(label)}</span>`;
}

function dueText(row, today) {
  if (row.followup_state === 'inactive') return '—';
  const due = row.next_due_date;
  if (!due) return '—';
  const diff = daysBetween(today, due);
  let suffix = '';
  if (diff !== null) {
    if (row.followup_state === 'overdue' || (row.followup_state === 'no_visit' && diff < 0)) suffix = `（已过 ${Math.abs(diff)} 天）`;
    else if (row.followup_state === 'due_soon') suffix = diff <= 0 ? '（今天到期）' : `（还有 ${diff} 天）`;
  }
  const tone = row.followup_state === 'overdue' ? ' is-bad' : '';
  return `${escapeHtml(due)}${suffix ? `<span class="fu-sub${tone}">${suffix}</span>` : ''}`;
}

export function renderBoardRow(row, { showLinks = false, today = localToday() } = {}) {
  const state = FOLLOWUP_STATES[row.followup_state];
  const consent = CONSENT_STATUSES[row.consent_status] || { label: '—', tone: 'muted' };
  const why = row.followup_state === 'inactive' ? inactiveReason(row) : '';
  const stopped = why ? `<span class="fu-sub">（${escapeHtml(why)}）</span>` : '';
  const code = escapeHtml(row.patient_code);
  const days = row.days_since_last_visit === null || row.days_since_last_visit === undefined ? '—' : `${escapeHtml(row.days_since_last_visit)} 天`;
  const linkTitle = row.last_link_created_at ? `最近生成：${formatLocalDate(row.last_link_created_at)}${row.last_link_expires_at ? '，到期：' + formatLocalDate(row.last_link_expires_at) : ''}` : '尚未生成随访链接';
  const linkCell = showLinks ? `<td class="fu-num" data-label="有效链接" title="${escapeHtml(linkTitle)}">${escapeHtml(formatCount(row.active_link_count ?? 0))}</td>` : '';
  return `<tr data-patient-code="${code}" data-state="${escapeHtml(row.followup_state || '')}">`
    + `<th scope="row">${code}</th>`
    + `<td data-label="中心">${escapeHtml(row.center_code || '—')}</td>`
    + `<td class="fu-date" data-label="最近随访">${escapeHtml(row.last_visit_date || '—')}</td>`
    + `<td class="fu-num" data-label="距今">${days}</td>`
    + `<td class="fu-date" data-label="下次应随访">${dueText(row, today)}</td>`
    + `<td data-label="状态">${state ? badge(stateBadgeLabel(row), state.tone) : badge('—', 'muted')}${stopped}</td>`
    + linkCell
    + `<td data-label="知情同意">${badge(consent.label, consent.tone)}</td>`
    + `<td class="fu-actions">`
    + `<button type="button" class="btn small primary" data-act="visit" data-code="${code}" data-project-capability="can_write">录入随访</button>`
    + `<button type="button" class="btn small" data-act="history" data-code="${code}">随访记录</button>`
    + (showLinks ? `<button type="button" class="btn small" data-act="links" data-code="${code}">随访链接</button>` : '')
    // 账户只读时负责人和录入协作人仍可登记拒绝/撤回同意或停止随访（对话框内只开放这些选项）。
    + `<button type="button" class="btn small" data-act="status" data-code="${code}" data-project-capability="can_record_study_exit">研究状态</button>`
    + `</td></tr>`;
}

export function renderBoardHtml(rows, { state = 'all', consent = 'all', search = '', limit = 100, showLinks = false, today = localToday() } = {}) {
  const all = rows || [];
  if (!all.length) return { html: '<p class="muted small">本项目还没有患者。请先在下方“新增患者”中建立基线，或使用批量导入。</p>', shown: 0, matched: 0 };
  const matched = filterBoardRows(all, { state, consent, search });
  const visible = matched.slice(0, limit);
  const stateLabel = STATE_FILTERS.find(([k]) => k === state)?.[1] || '全部';
  const consentLabel = consent && consent !== 'all' ? `；知情同意：${CONSENT_FILTERS.find(([k]) => k === consent)?.[1] || ''}` : '';
  const summary = `<p class="muted small fu-board-summary" role="status">共 ${all.length} 位患者，符合当前筛选（${escapeHtml(stateLabel)}${escapeHtml(consentLabel)}${search ? `；研究编号含“${escapeHtml(search)}”` : ''}）的 ${matched.length} 位${matched.length > visible.length ? `，显示前 ${visible.length} 位` : ''}。</p>`;
  if (!matched.length) return { html: `${summary}<p class="muted small">没有符合条件的患者。</p>`, shown: 0, matched: 0 };
  const head = `<thead><tr><th scope="col">研究编号</th><th scope="col">中心</th><th scope="col">最近随访</th><th scope="col">距今</th><th scope="col">下次应随访</th><th scope="col">状态</th>${showLinks ? '<th scope="col">有效链接</th>' : ''}<th scope="col">知情同意</th><th scope="col">操作</th></tr></thead>`;
  const more = matched.length > visible.length ? `<div class="btnbar"><button type="button" class="btn small" data-act="more">再显示 100 位</button></div>` : '';
  return {
    html: `${summary}<div class="fu-table-wrap"><table class="table fu-board-table">${head}<tbody>${visible.map(r => renderBoardRow(r, { showLinks, today })).join('')}</tbody></table></div>${more}`,
    shown: visible.length,
    matched: matched.length,
  };
}

export function renderFilterBar(rows, { state = 'all', consent = 'all' } = {}) {
  const counts = countStates(rows);
  const chips = STATE_FILTERS.map(([key, label]) => `<button type="button" class="fu-filter" data-board-filter="${key}" aria-pressed="${state === key}">${escapeHtml(label)} <span class="fu-filter-count">${counts[key]}</span></button>`).join('');
  const options = CONSENT_FILTERS.map(([key, label]) => `<option value="${key}"${consent === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  return `<div class="fu-filters" role="group" aria-label="按随访状态筛选">${chips}</div><label class="fu-consent-filter">知情同意<select data-consent-select>${options}</select></label>`;
}

// ── 录入随访：输入解析与换算 ───────────────────────────────────

export const SCR_MGDL_TO_UMOL = 88.4;
export const UPCR_GG_TO_MGG = 1000;
/** 随访 UPCR 上限（mg/g），与数据库约束 visits_long_upcr_range 一致。 */
export const UPCR_MAX_MGG = 50000;

/** 全角数字、全角小数点与斜杠转为半角。 */
export function normalizeDigits(text) {
  return String(text ?? '').replace(/[０-９．／]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
}

/** 空白返回 null；不是非负十进制数返回 NaN。 */
export function parseDecimal(text) {
  const t = normalizeDigits(text);
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}

/** “130/80” → {sbp:'130', dbp:'80'}；不是这种写法返回 null。 */
export function splitBloodPressure(text) {
  const m = normalizeDigits(text).match(/^(\d{2,3}(?:\.\d+)?)\s*[/\\]\s*(\d{2,3}(?:\.\d+)?)$/);
  return m ? { sbp: m[1], dbp: m[2] } : null;
}

export function roundTo(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function creatinineToUmol(value, unit) {
  if (value === null || Number.isNaN(value)) return value;
  return unit === 'mgdl' ? roundTo(value * SCR_MGDL_TO_UMOL, 2) : value;
}

export function upcrToMgG(value, unit) {
  if (value === null || Number.isNaN(value)) return value;
  return unit === 'gg' ? roundTo(value * UPCR_GG_TO_MGG, 3) : value;
}

/** 单位换算提示（不阻止保存）。 */
export function visitUnitHints(draft) {
  const scr = parseDecimal(draft.scr);
  const upcr = parseDecimal(draft.upcr);
  let scrHint = '';
  let upcrHint = '';
  if (scr !== null && !Number.isNaN(scr)) {
    if (draft.scrUnit === 'mgdl') scrHint = `按 1 mg/dL = 88.4 μmol/L 换算，将保存为 ${creatinineToUmol(scr, 'mgdl')} μmol/L。请核对化验单单位。`;
    else if (scr > 0 && scr < 20) scrHint = '数值偏低：如化验单单位是 mg/dL，请切换单位后再保存。';
  }
  if (upcr !== null && !Number.isNaN(upcr)) {
    if (draft.upcrUnit === 'gg') upcrHint = `按 1 g/g = 1000 mg/g 换算，将保存为 ${upcrToMgG(upcr, 'gg')} mg/g。`;
    else if (upcr > 0 && upcr < 10) upcrHint = '数值偏低：如化验单单位是 g/g，请切换单位后再保存。';
  }
  return { scr: scrHint, upcr: upcrHint };
}

/**
 * 把对话框内容转换为 import_registry_rows 的单行随访。
 * 数值范围与数据库 validate_visit_record 一致（仅用于提前提示，数据库仍是最终校验）。
 */
export function buildVisitRow(draft, { today = localToday(), containsPII = () => false } = {}) {
  const errors = [];
  const code = String(draft.patientCode ?? '').trim();
  const date = String(draft.visitDate ?? '').trim();
  if (!code) errors.push({ field: 'code', message: '请填写研究编号。' });
  if (!isIsoDate(date)) errors.push({ field: 'date', message: '请填写有效的随访日期。' });
  else if (date > today) errors.push({ field: 'date', message: '随访日期不能晚于今天。' });
  const sbp = parseDecimal(draft.sbp);
  const dbp = parseDecimal(draft.dbp);
  const scrRaw = parseDecimal(draft.scr);
  const upcrRaw = parseDecimal(draft.upcr);
  for (const [value, field, label] of [[sbp, 'sbp', '收缩压'], [dbp, 'dbp', '舒张压'], [scrRaw, 'scr', '血肌酐'], [upcrRaw, 'upcr', '尿蛋白肌酐比']]) {
    if (Number.isNaN(value)) errors.push({ field, message: `${label}请填写数字（可含小数点）。` });
  }
  const ok = v => v !== null && !Number.isNaN(v);
  if (ok(sbp) && (sbp < 40 || sbp > 300)) errors.push({ field: 'sbp', message: '收缩压须在 40–300 mmHg 之间，请核对。' });
  if (ok(dbp) && (dbp < 20 || dbp > 200)) errors.push({ field: 'dbp', message: '舒张压须在 20–200 mmHg 之间，请核对。' });
  if (ok(sbp) && ok(dbp) && dbp >= sbp) errors.push({ field: 'dbp', message: '舒张压须低于收缩压，请核对是否填反。' });
  const scr = creatinineToUmol(scrRaw, draft.scrUnit);
  if (ok(scr) && (scr < 10 || scr > 5000)) {
    const asUmol = creatinineToUmol(scrRaw, 'mgdl');
    const looksMgdl = draft.scrUnit !== 'mgdl' && scr < 10 && asUmol >= 10 && asUmol <= 5000;
    const looksUmol = draft.scrUnit === 'mgdl' && scr > 5000 && scrRaw >= 10 && scrRaw <= 5000;
    errors.push({ field: 'scr', message: looksMgdl
      ? `血肌酐 ${scrRaw} μmol/L 低于系统允许的 10–5000 μmol/L。这个数值看起来是 mg/dL，请把单位切换为 mg/dL 后再保存。`
      : looksUmol
        ? `血肌酐 ${scrRaw} mg/dL 换算后为 ${scr} μmol/L，超出系统允许范围。这个数值看起来是 μmol/L，请把单位切换为 μmol/L 后再保存。`
        : `血肌酐（换算后 ${scr} μmol/L）超出系统允许的 10–5000 μmol/L，请核对数值与单位。` });
  }
  const upcr = upcrToMgG(upcrRaw, draft.upcrUnit);
  if (ok(upcr) && upcr > UPCR_MAX_MGG) {
    const looksMgg = draft.upcrUnit === 'gg' && upcrRaw <= UPCR_MAX_MGG;
    errors.push({ field: 'upcr', message: looksMgg
      ? `尿蛋白肌酐比 ${upcrRaw} g/g 换算后为 ${upcr} mg/g，超出系统允许的 0–50000 mg/g。这个数值看起来是 mg/g，请把单位切换为 mg/g 后再保存。`
      : `尿蛋白肌酐比（换算后 ${upcr} mg/g）超出系统允许的 0–50000 mg/g，请核对数值与单位。` });
  }
  const notes = String(draft.notes ?? '').trim();
  if (notes.length > 500) errors.push({ field: 'notes', message: '备注最多 500 字。' });
  if (notes && containsPII(notes)) errors.push({ field: 'notes', message: '备注中检测到疑似个人身份信息（手机号、身份证号、住院号、姓名等），请删除后再保存。' });
  const missing = [[sbp, '收缩压'], [dbp, '舒张压'], [scrRaw, '血肌酐'], [upcrRaw, '尿蛋白肌酐比']].filter(([v]) => v === null).map(([, label]) => label);
  if (missing.length === 4) errors.push({ field: 'sbp', message: '请至少填写一项测量值（血压、血肌酐或尿蛋白肌酐比）。' });
  const row = { patient_code: code, visit_date: date };
  if (ok(sbp)) row.sbp = sbp;
  if (ok(dbp)) row.dbp = dbp;
  if (ok(scr)) row.scr_umol_l = scr;
  if (ok(upcr)) row.upcr = upcr;
  if (notes) row.notes = notes;
  return { row, errors, missing };
}

/** 把 import_registry_rows 的返回（inserted/updated/skipped，兼容 added/changed）翻译成中文。 */
export function visitSaveMessage(result, { patientCode = '', visitDate = '' } = {}) {
  const r = result || {};
  const inserted = Number(r.inserted ?? r.added ?? 0);
  const updated = Number(r.updated ?? r.changed ?? 0);
  const skipped = Number(r.skipped ?? 0);
  const who = `${patientCode} 在 ${visitDate}`;
  if (r.replayed === true) return { tone: 'info', saved: true, text: `这次提交此前已保存（系统识别为重复提交），没有重复保存。可在“随访记录”中核对 ${who} 的记录。` };
  if (inserted >= 1) return { tone: 'ok', saved: true, text: `已保存 ${who} 的随访记录。` };
  if (updated >= 1) return { tone: 'ok', saved: true, text: `已更新 ${who} 的随访记录。` };
  if (skipped >= 1) return { tone: 'info', saved: true, text: `${who} 已有一条内容完全相同的随访记录，系统没有重复保存。` };
  return { tone: 'error', saved: false, text: '服务器没有确认保存结果。请打开该患者的“随访记录”核对后再决定是否重新录入。' };
}

/** 数据库 visit_validation_failed 的 DETAIL 是中文错误数组（JSON 文本）。 */
export function validationDetails(error) {
  if (!String(error?.message ?? '').includes('visit_validation_failed')) return [];
  try {
    const list = JSON.parse(error.details);
    return Array.isArray(list) ? list.filter(x => typeof x === 'string' && /[一-龥]/.test(x)) : [];
  } catch {
    return [];
  }
}

export function isSameDayConflict(error) {
  return String(error?.message ?? '').includes('same_day_record_conflict');
}

// ── 随访链接 ─────────────────────────────────────────────────

export function tokenState(token, now = Date.now()) {
  if (token.revoked_at) return { key: 'revoked', label: '已撤销', tone: 'bad' };
  if (token.active === false) return { key: 'revoked', label: '已停用', tone: 'bad' };
  if (token.single_use && token.used_at) return { key: 'used', label: '已使用', tone: 'info' };
  if (token.expires_at && Date.parse(token.expires_at) <= now) return { key: 'expired', label: '已过期', tone: 'muted' };
  return { key: 'active', label: '有效', tone: 'ok' };
}

const SYSTEM_REVOKE_REASONS = Object.freeze({
  editor_permission_removed: '录入成员权限变更，系统自动撤销',
  rate_limited: '提交过于频繁，系统自动停用',
  same_day_limit_exceeded: '同日提交次数超限，系统自动停用',
  consent_declined: '知情同意改为“拒绝”，系统自动撤销',
  consent_withdrawn: '知情同意改为“撤回”，系统自动撤销',
  followup_withdrawn: '随访状态改为“退出研究”，系统自动撤销',
  followup_deceased: '随访状态改为“死亡”，系统自动撤销',
  patient_exited: '患者已拒绝或撤回同意、或已退出研究，系统自动停用',
  legacy_token_format: '旧版链接格式异常，升级时系统停用',
});

/** 这些研究状态变更会让数据库自动撤销该患者仍有效的随访链接（见迁移 0038）。 */
export function revokesLinks(changes) {
  return ['declined', 'withdrawn'].includes(changes?.consent_status) || ['withdrawn', 'deceased'].includes(changes?.followup_status);
}

/** 已拒绝/撤回同意或已退出研究/死亡的患者不再发放新的随访链接；返回界面说明，可发放时返回空串。 */
export function newLinkBlockReason(row) {
  if (!row) return '';
  if (['declined', 'withdrawn'].includes(row.consent_status)) return `该患者的知情同意状态为“${CONSENT_STATUSES[row.consent_status].label}”，不能再发放随访链接。如情况有变，请先在“研究状态”中按知情同意记录更新。`;
  if (['withdrawn', 'deceased'].includes(row.followup_status)) return `该患者的随访状态为“${FOLLOWUP_STATUS_OPTIONS[row.followup_status]}”，不能再发放随访链接。如情况有变，请先在“研究状态”中更新。`;
  return '';
}

export function revokeReasonLabel(reason) {
  if (!reason) return '';
  if (SYSTEM_REVOKE_REASONS[reason]) return SYSTEM_REVOKE_REASONS[reason];
  return /^[a-z0-9_]+$/.test(reason) ? '系统自动停用' : String(reason);
}

/**
 * 随访链接固定为站点根下的 /followup#<链接>，与工作台从哪个路径（/staff、/staff/…）打开无关。
 * 链接放在 # 之后：浏览器不会把它发送给服务器或写入访问日志。
 */
export function buildFollowupLink(origin, token) {
  return `${origin}/followup#${encodeURIComponent(token)}`;
}

export function linkMessageText({ link, expiresOn, project } = {}) {
  const title = project?.public_title ? `“${project.public_title}”` : '本研究';
  const institution = project?.institution_name || '';
  const contact = project?.contact_display ? `如有疑问，请联系${project.contact_display}。` : '';
  return `您好，这是${institution}${title}的随访填写链接，请在 ${expiresOn} 前打开填写：${link} 。此链接仅用于您本人的随访，请勿转发他人。${contact}`;
}
