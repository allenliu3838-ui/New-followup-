// 工作台对话框：录入随访、随访链接、研究状态。
// 权限与项目上下文由 staff.js 注入；数据库 RPC 仍是唯一的权限与校验依据。
import {
  escapeHtml, localToday, formatLocalDateTime, buildVisitRow, visitUnitHints, splitBloodPressure,
  visitSaveMessage, validationDetails, isSameDayConflict, tokenState, revokeReasonLabel, buildFollowupLink,
  linkMessageText, revokesLinks, newLinkBlockReason, CONSENT_STATUSES, FOLLOWUP_STATUSES, FOLLOWUP_STATUS_OPTIONS, FOLLOWUP_STATES, REASON_REQUIRED_CONSENT, REASON_REQUIRED_FOLLOWUP,
  EXIT_CONSENT_STATUSES, EXIT_FOLLOWUP_STATUSES, consentDateLabel, inactiveReason,
} from '/lib/followup-board.js?v=registry-20261012-adoption-v4';

const TOKEN_COLUMNS = 'id,patient_code,created_at,expires_at,single_use,used_at,revoked_at,revoke_reason,active';

function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function focusable(root) {
  return [...root.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(n => !n.disabled && !n.hidden && n.offsetParent !== null);
}

/** 打开模态对话框。项目切换时 staff.js 会移除所有 [data-registry-modal]。 */
export function openModal({ id, title, html, wide = false }) {
  document.querySelectorAll(`[data-registry-modal="${id}"]`).forEach(n => n.remove());
  const overlay = document.createElement('div');
  overlay.className = 'fu-modal-overlay';
  overlay.dataset.registryModal = id;
  overlay.innerHTML = `<section class="fu-modal${wide ? ' is-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}Title">`
    + `<div class="fu-modal-head"><h2 id="${id}Title">${escapeHtml(title)}</h2><button type="button" class="fu-modal-close" data-modal-close aria-label="关闭">×</button></div>`
    + `<div class="fu-modal-body">${html}</div></section>`;
  const previous = document.activeElement;
  const onKey = event => {
    if (!overlay.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    if (event.key === 'Escape' && !overlay.dataset.busy) { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const items = focusable(overlay);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  function close() {
    if (overlay.dataset.busy) return false;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (previous?.isConnected) previous.focus?.();
    return true;
  }
  overlay.addEventListener('click', event => { if (event.target.closest('[data-modal-close]')) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  const q = selector => overlay.querySelector(selector);
  return { overlay, q, close, isOpen: () => overlay.isConnected };
}

function setFeedback(node, messages, tone = 'error', action = null) {
  if (!node) return;
  const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  node.replaceChildren();
  if (!list.length) { node.removeAttribute('data-tone'); return; }
  node.dataset.tone = tone;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  if (list.length === 1) node.append(document.createTextNode(list[0]));
  else {
    node.append(document.createTextNode(list[0]));
    const ul = document.createElement('ul');
    for (const item of list.slice(1)) { const li = document.createElement('li'); li.textContent = item; ul.append(li); }
    node.append(ul);
  }
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    node.append(document.createTextNode(' '), button);
  }
}

async function copyText(text, fallbackInput) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 继续尝试选中复制 */ }
  try {
    if (fallbackInput) { fallbackInput.focus(); fallbackInput.select(); return document.execCommand('copy'); }
  } catch { /* 忽略 */ }
  return false;
}

/**
 * deps: { sb, capture, isCurrent, assertCurrent, can, canManageLinks, setBusy, toast, errorMessage,
 *         containsPII, getRow, rowsLoaded, getProject, onSaved, openHistory, linkBase }
 */
export function createFollowupDialogs(deps) {
  const { sb } = deps;

  // ── 录入随访 ──────────────────────────────────────────────
  function openVisitEntry(initialCode = '') {
    if (!deps.can('can_write')) { deps.toast('当前项目角色或账户状态不允许录入随访。'); return null; }
    const op = deps.capture();
    const today = localToday();
    const fixed = !!initialCode;
    const modal = openModal({
      id: 'visitEntry',
      title: '录入随访',
      html: `<p class="muted small">项目：${escapeHtml(op.project.name)}。同一患者同一天只保留一条随访；内容完全相同的重复提交不会重复保存。请只使用研究编号，勿录入姓名等身份信息。</p>
<div class="fu-grid">
  <div><label for="veCode">研究编号</label><input id="veCode" list="patientCodeOptions" autocomplete="off" maxlength="64" value="${escapeHtml(initialCode)}"${fixed ? ' readonly' : ''}/></div>
  <div><label for="veDate">随访日期</label><input id="veDate" type="date" value="${today}" max="${today}"/></div>
</div>
<div id="veContext" class="fu-context small" aria-live="polite"></div>
<div class="fu-grid">
  <div><label for="veSbp">收缩压（mmHg）</label><input id="veSbp" inputmode="decimal" autocomplete="off" placeholder="例如 130，或直接输入 130/80"/></div>
  <div><label for="veDbp">舒张压（mmHg）</label><input id="veDbp" inputmode="decimal" autocomplete="off" placeholder="例如 80"/></div>
</div>
<div id="veBpHint" class="fu-hint small" aria-live="polite">可在收缩压一栏直接输入“130/80”，系统会自动拆分。</div>
<div class="fu-grid">
  <div><label for="veScr">血肌酐</label><div class="inline-field"><input id="veScr" inputmode="decimal" autocomplete="off"/><select id="veScrUnit" aria-label="血肌酐单位"><option value="umol">μmol/L</option><option value="mgdl">mg/dL</option></select></div><div id="veScrHint" class="fu-hint small" aria-live="polite"></div></div>
  <div><label for="veUpcr">尿蛋白肌酐比（UPCR）</label><div class="inline-field"><input id="veUpcr" inputmode="decimal" autocomplete="off"/><select id="veUpcrUnit" aria-label="尿蛋白肌酐比单位"><option value="mgg">mg/g</option><option value="gg">g/g</option></select></div><div id="veUpcrHint" class="fu-hint small" aria-live="polite"></div></div>
</div>
<label for="veNotes">备注（可选，最多 500 字）</label>
<textarea id="veNotes" maxlength="500" placeholder="例如：外院复查结果补录。请勿填写姓名、电话、病案号等身份信息。"></textarea>
<div id="veNotesHint" class="fu-hint small" aria-live="polite"></div>
<p id="veMissing" class="small muted" aria-live="polite"></p>
<div id="veFeedback" class="fu-feedback"></div>
<div class="btnbar">
  <button type="button" class="btn primary" id="veSave">保存</button>
  <button type="button" class="btn" id="veSaveNext">保存并录下一位</button>
  <button type="button" class="btn" data-modal-close>关闭</button>
</div>
<p class="muted small">血肌酐统一按 μmol/L 保存，UPCR 统一按 mg/g 保存。eGFR 由系统根据血肌酐及基线性别、出生年份按 CKD-EPI 2021 公式自动计算。</p>`,
    });
    const q = modal.q;
    const fields = { code: q('#veCode'), date: q('#veDate'), sbp: q('#veSbp'), dbp: q('#veDbp'), scr: q('#veScr'), scrUnit: q('#veScrUnit'), upcr: q('#veUpcr'), upcrUnit: q('#veUpcrUnit'), notes: q('#veNotes') };
    const feedback = q('#veFeedback');
    let pending = null;
    let contextEpoch = 0;
    let busy = false;

    const draft = () => ({ patientCode: fields.code.value, visitDate: fields.date.value, sbp: fields.sbp.value, dbp: fields.dbp.value, scr: fields.scr.value, scrUnit: fields.scrUnit.value, upcr: fields.upcr.value, upcrUnit: fields.upcrUnit.value, notes: fields.notes.value });

    function applyBloodPressureSplit(source) {
      const parts = splitBloodPressure(source.value);
      if (!parts) return false;
      fields.sbp.value = parts.sbp;
      fields.dbp.value = parts.dbp;
      q('#veBpHint').textContent = `已拆分为收缩压 ${parts.sbp} mmHg、舒张压 ${parts.dbp} mmHg。`;
      return true;
    }

    function refreshHints() {
      const hints = visitUnitHints(draft());
      q('#veScrHint').textContent = hints.scr;
      q('#veUpcrHint').textContent = hints.upcr;
      const pii = fields.notes.value && deps.containsPII(fields.notes.value);
      fields.notes.classList.toggle('fu-invalid', !!pii);
      q('#veNotesHint').textContent = pii ? '检测到疑似个人身份信息（手机号、身份证号、住院号、姓名等），请删除后再保存。' : '';
      const { missing } = buildVisitRow(draft(), { today: localToday() });
      q('#veMissing').textContent = missing.length && missing.length < 4 ? `未填写：${missing.join('、')}。可以保存，缺失项会计入“核心四项完整率”。` : '';
    }

    async function refreshContext() {
      const box = q('#veContext');
      const code = fields.code.value.trim();
      const epoch = ++contextEpoch;
      box.replaceChildren();
      if (!code) return;
      const row = deps.getRow(code);
      if (!row) {
        if (deps.rowsLoaded()) box.textContent = '未在本项目找到该研究编号。请核对，或先在“新增患者”中建立基线。';
        return;
      }
      const state = FOLLOWUP_STATES[row.followup_state];
      const parts = [
        row.baseline_date ? `基线日期 ${row.baseline_date}` : '',
        row.last_visit_date ? `最近随访 ${row.last_visit_date}` : '尚无随访记录',
        row.next_due_date && row.followup_state !== 'inactive' ? `下次应随访 ${row.next_due_date}${state ? `（${state.label}）` : ''}` : '',
      ].filter(Boolean);
      box.textContent = parts.join(' · ');
      if (row.followup_state === 'inactive') {
        const warn = document.createElement('div');
        warn.className = 'fu-warn-line';
        warn.textContent = (row.followup_status ?? 'active') !== 'active'
          ? `该患者的随访状态为“${FOLLOWUP_STATUSES[row.followup_status] || '已停止随访'}”。如患者已恢复随访，请同时在“研究状态”中更新。`
          : `该患者已${inactiveReason(row) || '停止随访'}，看板不再提醒随访。录入前请按研究方案确认是否仍可收集数据；如情况有变，请先在“研究状态”中更新。`;
        box.append(warn);
      }
      if (!row.last_visit_date) return;
      try {
        const { data, error } = await sb.from('visits_long').select('visit_date,sbp,dbp,scr_umol_l,upcr')
          .eq('project_id', op.project.id).eq('patient_code', code).order('visit_date', { ascending: false }).limit(1);
        if (error || epoch !== contextEpoch || !deps.isCurrent(op) || !modal.isOpen() || !data?.[0]) return;
        const v = data[0];
        const last = document.createElement('div');
        last.textContent = `上次记录（${v.visit_date}）：血压 ${v.sbp ?? '—'}/${v.dbp ?? '—'} mmHg · 血肌酐 ${v.scr_umol_l ?? '—'} μmol/L · UPCR ${v.upcr ?? '—'} mg/g。请对照单位核对本次数值。`;
        box.append(last);
      } catch { /* 上次记录只是参考信息，读取失败不影响录入 */ }
    }

    function setBusy(flag) {
      busy = flag;
      if (flag) modal.overlay.dataset.busy = '1'; else delete modal.overlay.dataset.busy;
      deps.setBusy(q('#veSave'), flag);
      deps.setBusy(q('#veSaveNext'), flag);
    }

    function resetForNext(message, tone = 'ok') {
      for (const key of ['sbp', 'dbp', 'scr', 'upcr', 'notes']) fields[key].value = '';
      fields.code.readOnly = false;
      fields.code.value = '';
      q('#veBpHint').textContent = '可在收缩压一栏直接输入“130/80”，系统会自动拆分。';
      q('#veContext').replaceChildren();
      refreshHints();
      setFeedback(feedback, `${message} 请输入下一位患者的研究编号（随访日期已保留）。`, tone);
      fields.code.focus();
    }

    async function submit(next) {
      if (busy) return;
      setFeedback(feedback, []);
      applyBloodPressureSplit(fields.sbp);
      const { row, errors } = buildVisitRow(draft(), { today: localToday(), containsPII: deps.containsPII });
      const known = row.patient_code ? deps.getRow(row.patient_code) : null;
      if (row.patient_code && deps.rowsLoaded() && !known) {
        errors.unshift({ field: 'code', message: '未在本项目找到该研究编号。请核对，或先在“新增患者”中建立基线。' });
      }
      if (known?.baseline_date && row.visit_date && row.visit_date < known.baseline_date && !errors.some(e => e.field === 'date')) {
        errors.push({ field: 'date', message: `随访日期早于该患者的基线日期（${known.baseline_date}），请核对。` });
      }
      if (errors.length) {
        setFeedback(feedback, errors.length === 1 ? errors[0].message : ['请先修正以下内容：', ...errors.map(e => e.message)], 'error');
        ({ code: fields.code, date: fields.date, sbp: fields.sbp, dbp: fields.dbp, scr: fields.scr, upcr: fields.upcr, notes: fields.notes })[errors[0].field]?.focus();
        return;
      }
      try { deps.assertCurrent(op); } catch (e) { setFeedback(feedback, deps.errorMessage(e), 'error'); return; }
      const key = JSON.stringify(row);
      // 同一内容重试沿用同一提交编号：若上次已在服务器保存，会被识别为重复提交而不会新增记录。
      if (!pending || pending.key !== key) pending = { key, batchId: newUuid() };
      setBusy(true);
      try {
        const { data, error } = await sb.rpc('import_registry_rows', { p_project_id: op.project.id, p_kind: 'visits', p_rows: [row], p_batch_id: pending.batchId });
        if (!deps.isCurrent(op) || !modal.isOpen()) return;
        if (error) throw error;
        const message = visitSaveMessage(data, { patientCode: row.patient_code, visitDate: row.visit_date });
        if (!message.saved) { setFeedback(feedback, message.text, 'error'); return; }
        pending = null;
        deps.toast(message.text);
        deps.onSaved('visit', { patientCode: row.patient_code });
        setBusy(false);
        if (next) resetForNext(message.text, message.tone);
        else if (message.tone === 'ok') modal.close();
        else setFeedback(feedback, message.text, message.tone); // 与已有记录相同：保持打开，便于核对
      } catch (error) {
        if (!deps.isCurrent(op) || !modal.isOpen()) return;
        const details = validationDetails(error);
        const messages = details.length ? ['随访数据未通过系统校验：', ...details] : [deps.errorMessage(error, { rowPrefix: false })];
        const action = isSameDayConflict(error) ? { label: '查看该患者随访记录', run: () => { if (modal.close()) deps.openHistory(row.patient_code); } } : null;
        setFeedback(feedback, messages, 'error', action);
      } finally {
        if (busy) setBusy(false);
      }
    }

    fields.sbp.addEventListener('change', () => { applyBloodPressureSplit(fields.sbp); refreshHints(); });
    fields.sbp.addEventListener('input', event => { if (event.inputType === 'insertFromPaste' || event.inputType === undefined) applyBloodPressureSplit(fields.sbp); refreshHints(); });
    fields.dbp.addEventListener('change', () => { applyBloodPressureSplit(fields.dbp); refreshHints(); });
    for (const key of ['dbp', 'scr', 'upcr', 'notes']) fields[key].addEventListener('input', refreshHints);
    for (const key of ['scrUnit', 'upcrUnit']) fields[key].addEventListener('change', refreshHints);
    fields.code.addEventListener('change', refreshContext);
    q('#veSave').addEventListener('click', () => submit(false));
    q('#veSaveNext').addEventListener('click', () => submit(true));
    refreshHints();
    refreshContext();
    (fixed ? fields.sbp : fields.code).focus();
    return modal;
  }

  // ── 随访链接 ──────────────────────────────────────────────
  function openLinks(code) {
    if (!deps.canManageLinks()) { deps.toast('仅项目负责人和录入协作人可以管理随访链接。'); return null; }
    const op = deps.capture();
    const modal = openModal({
      id: 'links',
      title: `随访链接 · ${code}`,
      wide: true,
      html: `<p class="muted small">随访链接让患者或随访人员无需登录即可填写该患者的随访。为保护患者，链接全文只在生成时显示一次，系统只保存无法还原链接的校验值；如遗失，请撤销后重新生成。链接泄露或发错对象时请立即撤销，已提交的数据不受影响。</p>
<fieldset class="fu-fieldset"><legend>生成新链接</legend>
  <div class="fu-grid">
    <div><label for="lkDays">有效期（天，1–365）</label><input id="lkDays" type="number" min="1" max="365" step="1" value="30"/></div>
    <div class="fu-check"><label><input id="lkSingle" type="checkbox" checked/> 单次使用（提交一次后自动失效）</label></div>
  </div>
  <div class="btnbar"><button type="button" class="btn primary" id="lkCreate" data-project-capability="can_manage_tokens">生成新链接</button></div>
  <div id="lkOnce" class="fu-onetime" hidden></div>
</fieldset>
<h3 class="fu-h3">已发放的链接</h3>
<div id="lkList" aria-live="polite">正在读取…</div>
<div id="lkRevoke" class="fu-revoke" hidden>
  <p class="small">撤销后该链接立即失效，已提交的数据不受影响。</p>
  <label for="lkReason">撤销原因（必填，不含身份信息）</label>
  <textarea id="lkReason" maxlength="500" placeholder="例如：发错对象，已重新生成"></textarea>
  <div class="btnbar"><button type="button" class="btn danger" id="lkRevokeConfirm">确认撤销</button><button type="button" class="btn" id="lkRevokeCancel">取消</button></div>
</div>
<div id="lkFeedback" class="fu-feedback"></div>`,
    });
    const q = modal.q;
    const feedback = q('#lkFeedback');
    let tokens = [];
    let revokeId = null;
    let busy = false;
    const markBusy = flag => { busy = flag; if (flag) modal.overlay.dataset.busy = '1'; else delete modal.overlay.dataset.busy; };

    function renderList() {
      const box = q('#lkList');
      if (!tokens.length) { box.textContent = '该患者还没有随访链接。'; return; }
      const now = Date.now();
      const rows = tokens.map(t => {
        const state = tokenState(t, now);
        const extra = state.key === 'revoked' ? revokeReasonLabel(t.revoke_reason)
          : state.key === 'used' && t.used_at ? `已于 ${formatLocalDateTime(t.used_at)} 提交` : '';
        const action = state.key === 'active'
          ? `<button type="button" class="btn small" data-revoke-id="${escapeHtml(t.id)}">撤销</button>` : '';
        return `<tr data-token-id="${escapeHtml(t.id)}" data-token-state="${state.key}"><td>${escapeHtml(formatLocalDateTime(t.created_at))}</td><td>${escapeHtml(formatLocalDateTime(t.expires_at) || '—')}</td><td>${t.single_use ? '单次' : '多次'}</td><td><span class="fu-badge tone-${state.tone}">${state.label}</span>${extra ? `<span class="fu-sub">${escapeHtml(extra)}</span>` : ''}</td><td>${action}</td></tr>`;
      }).join('');
      box.innerHTML = `<div class="fu-table-wrap"><table class="table"><thead><tr><th scope="col">创建时间</th><th scope="col">到期时间</th><th scope="col">使用方式</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      box.querySelectorAll('[data-revoke-id]').forEach(button => button.addEventListener('click', () => startRevoke(button.dataset.revokeId)));
    }

    async function loadList() {
      const box = q('#lkList');
      try {
        const { data, error } = await sb.from('patient_tokens').select(TOKEN_COLUMNS)
          .eq('project_id', op.project.id).eq('patient_code', code).order('created_at', { ascending: false }).limit(200);
        if (!deps.isCurrent(op) || !modal.isOpen()) return;
        if (error) throw error;
        // 只保留需要显示的字段，任何链接文本或校验值都不会进入页面。
        tokens = (data || []).map(t => Object.fromEntries(TOKEN_COLUMNS.split(',').map(k => [k, t[k]])));
        renderList();
      } catch (error) {
        if (deps.isCurrent(op) && modal.isOpen()) box.textContent = `随访链接读取失败：${deps.errorMessage(error)}`;
      }
    }

    function startRevoke(id) {
      revokeId = id;
      const panel = q('#lkRevoke');
      panel.hidden = false;
      q('#lkReason').value = '';
      q('#lkReason').focus();
    }

    async function confirmRevoke() {
      if (busy || !revokeId) return;
      const reason = q('#lkReason').value.trim();
      if (!reason) { setFeedback(feedback, '请填写撤销原因。'); q('#lkReason').focus(); return; }
      if (deps.containsPII(reason)) { setFeedback(feedback, '撤销原因中检测到疑似个人身份信息，请删除后再提交。'); return; }
      const button = q('#lkRevokeConfirm');
      try {
        deps.assertCurrent(op);
        markBusy(true); deps.setBusy(button, true);
        const { error } = await sb.rpc('revoke_patient_token_by_id', { p_project_id: op.project.id, p_token_id: revokeId, p_reason: reason });
        markBusy(false); deps.setBusy(button, false);
        if (!deps.isCurrent(op) || !modal.isOpen()) return;
        if (error) throw error;
        revokeId = null;
        q('#lkRevoke').hidden = true;
        setFeedback(feedback, '链接已撤销，立即失效。', 'ok');
        deps.toast('随访链接已撤销');
        deps.onSaved('links', { patientCode: code });
        await loadList();
      } catch (error) {
        if (deps.isCurrent(op) && modal.isOpen()) setFeedback(feedback, `撤销失败：${deps.errorMessage(error)}`);
      } finally {
        markBusy(false); deps.setBusy(button, false);
      }
    }

    async function createLink() {
      if (busy) return;
      if (!deps.can('can_manage_tokens')) { setFeedback(feedback, '当前项目角色或账户状态不允许生成随访链接。'); return; }
      const blocked = newLinkBlockReason(deps.getRow(code));
      if (blocked) { setFeedback(feedback, blocked); return; }
      const days = Number(q('#lkDays').value);
      if (!Number.isInteger(days) || days < 1 || days > 365) { setFeedback(feedback, '有效期须为 1–365 天的整数。'); q('#lkDays').focus(); return; }
      const single = q('#lkSingle').checked;
      const button = q('#lkCreate');
      setFeedback(feedback, []);
      try {
        deps.assertCurrent(op);
        markBusy(true); deps.setBusy(button, true);
        const { data, error } = await sb.rpc('create_patient_token_v2', { p_project_id: op.project.id, p_patient_code: code, p_expires_in_days: days, p_single_use: single });
        markBusy(false); deps.setBusy(button, false);
        if (!deps.isCurrent(op) || !modal.isOpen()) return;
        if (error) throw error;
        if (typeof data !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(data)) throw new Error('服务器没有返回有效的随访链接，请刷新列表核对后再生成。');
        const { origin, basePath } = deps.linkBase();
        const link = buildFollowupLink(origin, basePath, data);
        const expiresOn = localToday(new Date(Date.now() + days * 86400000));
        const message = linkMessageText({ link, expiresOn, project: deps.getProject() });
        const once = q('#lkOnce');
        once.hidden = false;
        once.innerHTML = `<p><b>新链接已生成</b>（${days} 天内有效，${single ? '单次使用' : '可多次使用'}）。<b>请立即复制，之后无法再次查看。</b>系统只保存无法还原链接的校验值，关闭此窗口后无法再显示完整链接；如遗失，请撤销后重新生成。</p>
<label for="lkOnceLink" class="sr-only">新生成的随访链接</label><input id="lkOnceLink" readonly value="${escapeHtml(link)}"/>
<label for="lkOnceMsg">可直接发送的说明文字（粘贴到聊天工具后可再修改）</label><textarea id="lkOnceMsg" readonly rows="3">${escapeHtml(message)}</textarea>
<div class="btnbar"><button type="button" class="btn small primary" id="lkCopy">复制链接</button><button type="button" class="btn small" id="lkCopyMsg">复制发送文本</button><button type="button" class="btn small" id="lkPreview">打开随访页预览</button></div>`;
        q('#lkCopy').addEventListener('click', async () => deps.toast(await copyText(link, q('#lkOnceLink')) ? '已复制随访链接' : '复制失败，请手动选中链接复制'));
        q('#lkCopyMsg').addEventListener('click', async () => deps.toast(await copyText(message, q('#lkOnceMsg')) ? '已复制发送文本' : '复制失败，请手动选中文字复制'));
        q('#lkPreview').addEventListener('click', () => { window.open(link, '_blank', 'noopener,noreferrer'); });
        deps.toast('随访链接已生成');
        deps.onSaved('links', { patientCode: code });
        await loadList();
      } catch (error) {
        if (deps.isCurrent(op) && modal.isOpen()) setFeedback(feedback, `生成失败：${deps.errorMessage(error)}`);
      } finally {
        markBusy(false); deps.setBusy(button, false);
      }
    }

    q('#lkCreate').addEventListener('click', createLink);
    q('#lkRevokeConfirm').addEventListener('click', confirmRevoke);
    q('#lkRevokeCancel').addEventListener('click', () => { revokeId = null; q('#lkRevoke').hidden = true; });
    const blocked = newLinkBlockReason(deps.getRow(code));
    if (blocked) {
      // 不再受统一权限刷新影响：该患者不能再发放新链接，已发放的链接仍可撤销。
      delete q('#lkCreate').dataset.projectCapability;
      q('#lkCreate').disabled = true;
      setFeedback(feedback, blocked, 'info');
    } else if (!deps.can('can_manage_tokens')) {
      q('#lkCreate').disabled = true;
      setFeedback(feedback, '当前账户状态或角色不允许生成新链接；仍可查看和撤销已发放的链接。', 'info');
    }
    loadList();
    return modal;
  }

  // ── 研究状态 ──────────────────────────────────────────────
  async function openStudyStatus(code) {
    // 账户只读（如试用到期）时，负责人和录入协作人仍可登记拒绝/撤回同意或停止随访，这是合规操作。
    const exitOnly = !deps.can('can_write') && deps.can('can_record_study_exit');
    if (!deps.can('can_write') && !exitOnly) { deps.toast('当前项目角色或账户状态不允许修改研究状态。'); return null; }
    const op = deps.capture();
    const modal = openModal({ id: 'studyStatus', title: `研究状态 · ${code}`, html: '<p class="muted small" id="ssLoading">正在读取…</p>' });
    let record;
    try {
      const { data, error } = await sb.from('patients_baseline')
        .select('id,patient_code,consent_status,consent_date,consent_version,followup_status,followup_status_date')
        .eq('project_id', op.project.id).eq('patient_code', code).maybeSingle();
      if (!deps.isCurrent(op) || !modal.isOpen()) return null;
      if (error) throw error;
      if (!data) throw new Error('未在本项目找到该研究编号的基线记录。');
      record = data;
    } catch (error) {
      if (deps.isCurrent(op) && modal.isOpen()) modal.q('#ssLoading').textContent = `读取失败：${deps.errorMessage(error)}`;
      return modal;
    }
    const today = localToday();
    const currentConsent = record.consent_status || 'unconfirmed';
    const currentFollowup = record.followup_status || 'active';
    // 只读期间只列出当前取值与退出类取值；数据库同样只放行这类修改。
    const allowed = (map, current, exits) => Object.fromEntries(Object.entries(map).filter(([value]) => !exitOnly || value === current || exits.includes(value)));
    const options = (map, current) => Object.entries(map).map(([value, item]) => `<option value="${value}"${value === current ? ' selected' : ''}>${escapeHtml(typeof item === 'string' ? item : item.label)}</option>`).join('');
    const body = modal.q('.fu-modal-body');
    body.innerHTML = `<p class="muted small">知情同意与随访状态用于随访管理和数据使用范围核对，每次修改都会留痕。随访状态只决定是否继续提醒随访，不等同于临床终点事件；终点事件请按研究方案在“临床终点事件”中录入。</p>
${exitOnly ? '<p id="ssExitOnly" class="fu-warn-line small">账户当前为只读（如试用期已结束或订阅已到期）。此处仍可登记拒绝或撤回知情同意、停止随访（失访、退出研究、死亡、肾衰竭、转院）及对应日期；其他修改需恢复账户权益后进行。</p>' : ''}
<fieldset class="fu-fieldset"><legend>知情同意</legend>
  <div class="fu-grid">
    <div><label for="ssConsent">同意状态</label><select id="ssConsent">${options(allowed(CONSENT_STATUSES, currentConsent, EXIT_CONSENT_STATUSES), currentConsent)}</select></div>
    <div><label for="ssConsentDate" id="ssConsentDateLabel">${escapeHtml(consentDateLabel(currentConsent))}</label><input id="ssConsentDate" type="date" max="${today}" value="${escapeHtml(record.consent_date || '')}"/></div>
    <div><label for="ssConsentVersion">知情同意书版本</label><input id="ssConsentVersion" maxlength="100" value="${escapeHtml(record.consent_version || '')}" placeholder="例如：V2.0（2026-03-01）"${exitOnly ? ' disabled' : ''}/></div>
  </div>
  <p class="muted small">日期记录当前同意状态对应的日期：已同意填签署日期，伦理批准豁免填批准日期，拒绝或撤回填拒绝或撤回日期。更改同意状态时请填写新状态的日期，原日期保留在修改记录中。“伦理批准豁免”仅在伦理委员会书面批准免除知情同意时选择。</p>
</fieldset>
<fieldset class="fu-fieldset"><legend>随访状态</legend>
  <div class="fu-grid">
    <div><label for="ssFollowup">随访状态</label><select id="ssFollowup">${options(allowed(FOLLOWUP_STATUS_OPTIONS, currentFollowup, EXIT_FOLLOWUP_STATUSES), currentFollowup)}</select></div>
    <div><label for="ssFollowupDate">状态变更日期</label><input id="ssFollowupDate" type="date" max="${today}" value="${escapeHtml(record.followup_status_date || '')}"/></div>
  </div>
</fieldset>
<p id="ssExitHint" class="fu-warn-line small" hidden>拒绝或撤回同意后，看板不再提醒随访、也不能再发放随访链接。如患者不再随访，建议同时把随访状态改为“退出研究”，便于统计。 <button type="button" class="btn small" id="ssExitApply">同时改为“退出研究”</button></p>
<p id="ssLinkNote" class="fu-warn-line small" hidden>该患者的有效随访链接将被自动撤销；已提交的数据不受影响。</p>
<label for="ssReason">修改原因 <span class="muted">（改为或改自拒绝、撤回、失访、退出研究、死亡、肾衰竭、转院时必填）</span></label>
<textarea id="ssReason" maxlength="500" placeholder="说明依据，例如：患者书面撤回同意。不要填写姓名、电话等身份信息。"></textarea>
<div id="ssFeedback" class="fu-feedback"></div>
<div class="btnbar"><button type="button" class="btn primary" id="ssSave">保存研究状态</button><button type="button" class="btn" data-modal-close>取消</button></div>`;
    const q = modal.q;
    const feedback = q('#ssFeedback');
    const original = {
      consent_status: record.consent_status || 'unconfirmed',
      consent_date: record.consent_date || null,
      consent_version: record.consent_version || null,
      followup_status: record.followup_status || 'active',
      followup_status_date: record.followup_status_date || null,
    };
    const inputs = { consent_status: q('#ssConsent'), consent_date: q('#ssConsentDate'), consent_version: q('#ssConsentVersion'), followup_status: q('#ssFollowup'), followup_status_date: q('#ssFollowupDate') };
    // 日期属于当前状态：改选状态时清空原状态的日期（原日期保留在修改记录中），并更新标签。
    const syncDates = () => {
      for (const [status, date] of [['consent_status', 'consent_date'], ['followup_status', 'followup_status_date']]) {
        if (inputs[status].value !== original[status] && inputs[date].value === (original[date] || '')) inputs[date].value = '';
        if (inputs[status].value === original[status] && !inputs[date].value) inputs[date].value = original[date] || '';
      }
      q('#ssConsentDateLabel').textContent = consentDateLabel(inputs.consent_status.value);
      if (exitOnly) {
        inputs.consent_date.disabled = !EXIT_CONSENT_STATUSES.includes(inputs.consent_status.value);
        inputs.followup_status_date.disabled = !EXIT_FOLLOWUP_STATUSES.includes(inputs.followup_status.value);
      }
    };
    const updateLinkNote = () => {
      const pending = {};
      if (inputs.consent_status.value !== original.consent_status) pending.consent_status = inputs.consent_status.value;
      if (inputs.followup_status.value !== original.followup_status) pending.followup_status = inputs.followup_status.value;
      q('#ssLinkNote').hidden = !revokesLinks(pending);
      q('#ssExitHint').hidden = !(REASON_REQUIRED_CONSENT.includes(inputs.consent_status.value) && inputs.followup_status.value === 'active');
    };
    for (const key of ['consent_status', 'followup_status']) inputs[key].addEventListener('change', () => { syncDates(); updateLinkNote(); });
    q('#ssExitApply').addEventListener('click', () => {
      inputs.followup_status.value = 'withdrawn';
      syncDates();
      updateLinkNote();
      inputs.followup_status_date.focus();
    });
    syncDates();
    updateLinkNote();

    q('#ssSave').addEventListener('click', async () => {
      setFeedback(feedback, []);
      const changes = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.disabled) continue;
        const value = input.value.trim();
        // 日期与版本清空时按接口约定传空字符串，由数据库存为空值。
        if ((value || null) !== original[key]) changes[key] = value;
      }
      if (!Object.keys(changes).length) { setFeedback(feedback, '没有修改。', 'info'); return; }
      const reason = q('#ssReason').value.trim();
      const errors = [];
      for (const key of ['consent_date', 'followup_status_date']) {
        const value = changes[key];
        if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > localToday())) errors.push(`${key === 'consent_date' ? consentDateLabel(inputs.consent_status.value) : '状态变更日期'}须为有效日期，且不能晚于今天。`);
      }
      if (changes.consent_version && changes.consent_version.length > 100) errors.push('知情同意书版本最多 100 个字符。');
      const sensitive = ('consent_status' in changes && (REASON_REQUIRED_CONSENT.includes(changes.consent_status) || REASON_REQUIRED_CONSENT.includes(original.consent_status)))
        || ('followup_status' in changes && (REASON_REQUIRED_FOLLOWUP.includes(changes.followup_status) || REASON_REQUIRED_FOLLOWUP.includes(original.followup_status)));
      if (sensitive && reason.length < 2) errors.push('本次修改涉及拒绝、撤回或停止随访，请填写修改原因。');
      if (reason.length > 500) errors.push('修改原因最多 500 字。');
      if (deps.containsPII(reason) || deps.containsPII(changes.consent_version || '')) errors.push('内容中检测到疑似个人身份信息，请删除后再保存。');
      if (errors.length) { setFeedback(feedback, errors.length === 1 ? errors[0] : ['请先修正以下内容：', ...errors]); return; }
      if (revokesLinks(changes) && !window.confirm('保存后，该患者的有效随访链接将被自动撤销，已提交的数据不受影响。确认保存？')) return;
      const button = q('#ssSave');
      try {
        deps.assertCurrent(op);
        modal.overlay.dataset.busy = '1';
        deps.setBusy(button, true);
        const { data, error } = await sb.rpc('set_patient_study_status', { p_project_id: op.project.id, p_patient_code: code, p_changes: changes, p_reason: reason || null });
        if (!deps.isCurrent(op) || !modal.isOpen()) return;
        if (error) throw error;
        delete modal.overlay.dataset.busy;
        deps.toast(revokesLinks(changes) ? '研究状态已更新并留痕；该患者尚有效的随访链接已由系统撤销。' : '研究状态已更新并留痕。');
        deps.onSaved('status', { patientCode: code, result: data });
        modal.close();
      } catch (error) {
        if (deps.isCurrent(op) && modal.isOpen()) setFeedback(feedback, `未保存：${deps.errorMessage(error)}`);
      } finally {
        if (modal.isOpen()) { delete modal.overlay.dataset.busy; }
        deps.setBusy(button, false);
      }
    });
    inputs.consent_status.focus();
    return modal;
  }

  return { openVisitEntry, openLinks, openStudyStatus };
}

