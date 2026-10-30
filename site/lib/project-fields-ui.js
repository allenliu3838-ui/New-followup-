// 工作台：自定义入组字段的管理（项目负责人）与每位患者的“入组字段”对话框。
// 权限与项目上下文由 staff.js 注入；数据库 RPC（save_project_field、set_patient_field_values）仍是唯一的权限与校验依据。
import { escapeHtml } from '/lib/utils.js?v=registry-20261030-cn-v8';
import { openModal } from '/lib/followup-dialogs.js?v=registry-20261030-cn-v8';
import {
  FIELD_TYPES, YES_NO, MAX_FIELDS, TEXT_MAX, FIELD_PRESETS, sortFields, definitionProblem, parseChoicesText, choicesText,
  fieldRule, inputToValue, storedValue, valueDisplay,
} from '/lib/project-fields.js?v=registry-20261030-cn-v8';

const VALUE_COLUMNS = 'field_key,value_text,value_codes,value_num,value_date';
// 中文与英文之间留一个空格：“载入 REIGNITE…”“载入多囊肾…”。
const afterVerb = title => (/^[A-Za-z0-9]/.test(title) ? ' ' : '') + title;

function sameInput(field, before, after) {
  if (before == null || after == null) return before == null && after == null;
  if (field.value_type === 'multi_choice') return before.length === after.length && after.every(c => before.includes(c));
  if (field.value_type === 'number') return Number(before) === Number(after);
  return String(before) === String(after);
}
function feedback(node, text, tone = 'error') {
  if (!node) return;
  node.dataset.tone = tone; node.setAttribute('role', tone === 'error' ? 'alert' : 'status'); node.textContent = text;
}

/**
 * deps：{ sb, capture, isCurrent, assertCurrent, can(capability), canManage(), setBusy, toast, errorMessage(error, options),
 * containsPII, today(), onFieldsChanged(fields), list（显示字段清单的元素或返回它的函数）, feedback（字段区的提示元素或返回它的函数） }。
 */
export function createProjectFieldsUi(deps) {
  const node = item => typeof item === 'function' ? item() : item;
  let fields = [];
  let loadedFor = null;
  const fieldLabels = () => Object.fromEntries(fields.map(f => [f.field_key, f.label_cn]));
  const message = error => deps.errorMessage(error, { fieldLabels: fieldLabels() });

  function summary(f) {
    if (f.value_type === 'choice' || f.value_type === 'multi_choice') return (f.choices || []).map(c => c.label).join('、');
    if (f.value_type === 'number') {
      const range = f.min_value == null && f.max_value == null ? '' : `${f.min_value ?? '不限'}–${f.max_value ?? '不限'}`;
      return [f.unit, range].filter(Boolean).join('，');
    }
    if (f.value_type === 'text') return `最多 ${TEXT_MAX} 字`;
    return '';
  }

  function render() {
    const box = node(deps.list); if (!box) return;
    const manage = deps.canManage();
    if (!fields.length) {
      box.innerHTML = `<p class="muted small" data-fields-empty>本项目还没有自定义入组字段。${manage ? '可以新增字段，或载入入组字段草案后逐项核对。' : '如研究方案需要，请项目负责人添加。'}</p>`;
      return;
    }
    box.innerHTML = `<div class="fu-table-wrap"><table class="table"><thead><tr><th>显示名称</th><th>代码</th><th>类型</th><th>选项 / 单位与范围</th><th>状态</th><th>来源</th>${manage ? '<th></th>' : ''}</tr></thead><tbody>${sortFields(fields).map(f => `<tr data-field-key="${escapeHtml(f.field_key)}">
      <td>${escapeHtml(f.label_cn)}${f.help_cn ? `<div class="muted small">${escapeHtml(f.help_cn)}</div>` : ''}</td>
      <td><code>${escapeHtml(f.field_key)}</code></td><td>${escapeHtml(FIELD_TYPES[f.value_type] || f.value_type)}</td>
      <td class="small">${escapeHtml(summary(f))}</td>
      <td>${f.active ? '<span class="badge ok">启用</span>' : '<span class="badge">停用</span>'}</td>
      <td class="small">${escapeHtml(f.source || '—')}</td>
      ${manage ? `<td><button type="button" class="btn small" data-edit-field="${escapeHtml(f.field_key)}">修改</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  }

  async function load(op = deps.capture()) {
    const { data, error } = await deps.sb.from('project_fields').select('*').eq('project_id', op.project.id).order('sort_order').order('field_key');
    if (error) throw error;
    deps.assertCurrent(op);
    fields = sortFields(data || []); loadedFor = op.project.id;
    render(); deps.onFieldsChanged(fields);
    return fields;
  }
  function clear() { fields = []; loadedFor = null; render(); node(deps.feedback)?.replaceChildren(); }

  // ── 字段定义（项目负责人）────────────────────────────────────
  function openEditor(key = null) {
    if (!deps.canManage()) { deps.toast('只有项目负责人可以新增或修改入组字段。'); return null; }
    const previous = key ? fields.find(f => f.field_key === key) : null;
    if (key && !previous) return null;
    if (!previous && fields.length >= MAX_FIELDS) { deps.toast(`每个项目最多 ${MAX_FIELDS} 个自定义字段；不再使用的字段请停用。`); return null; }
    const op = deps.capture();
    const type = previous?.value_type || 'choice';
    const typeOptions = Object.entries(FIELD_TYPES).map(([v, label]) => `<option value="${v}"${v === type ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    const modal = openModal({ id: 'fieldEditor', title: previous ? `修改入组字段 · ${previous.label_cn}` : '新增入组字段', wide: true, html: `
<p class="muted small">字段代码和类型创建后不能更改；已有选项不能删除，可以修改显示名称或增加选项。不再使用的字段请停用，已录入的值会保留。字段定义的每次修改都会留痕。</p>
<div class="fu-grid">
  <div><label for="feKey">字段代码</label>${previous ? `<div><code id="feKey">${escapeHtml(previous.field_key)}</code></div>` : '<input id="feKey" maxlength="40" placeholder="例如 ethnicity（小写字母、数字、下划线）" autocomplete="off"/>'}</div>
  <div><label for="feLabel">显示名称（1–60 字）</label><input id="feLabel" maxlength="60" value="${escapeHtml(previous?.label_cn ?? '')}"/></div>
  <div><label for="feType">字段类型</label>${previous ? `<div id="feType">${escapeHtml(FIELD_TYPES[type])}</div>` : `<select id="feType">${typeOptions}</select>`}</div>
  <div><label for="feOrder">显示顺序（数字小的在前，可留空）</label><input id="feOrder" inputmode="numeric" value="${escapeHtml(previous?.sort_order ?? '')}"/></div>
</div>
<label for="feHelp">填写说明（可选，最多 300 字）</label><textarea id="feHelp" maxlength="300">${escapeHtml(previous?.help_cn ?? '')}</textarea>
<div id="feChoicesRow"><label for="feChoices">选项（每行一个：代码 显示名称，例如 han 汉族）</label><textarea id="feChoices" rows="6">${escapeHtml(choicesText(previous?.choices))}</textarea></div>
<div id="feNumberRow" class="fu-grid">
  <div><label for="feUnit">单位（可选）</label><input id="feUnit" maxlength="20" value="${escapeHtml(previous?.unit ?? '')}"/></div>
  <div><label for="feMin">最小值（可选）</label><input id="feMin" inputmode="decimal" value="${escapeHtml(previous?.min_value ?? '')}"/></div>
  <div><label for="feMax">最大值（可选）</label><input id="feMax" inputmode="decimal" value="${escapeHtml(previous?.max_value ?? '')}"/></div>
</div>
${previous ? `<label class="fu-check"><input type="checkbox" id="feActive"${previous.active ? ' checked' : ''}/> 启用（停用后不能再录入或导入，已录入的值保留）</label>` : ''}
<div id="feFeedback" class="fu-feedback"></div>
<div class="btnbar"><button type="button" class="btn primary" id="feSave">保存字段</button><button type="button" class="btn" data-modal-close>取消</button></div>` });
    const q = sel => modal.q(sel);
    const currentType = () => previous ? previous.value_type : q('#feType').value;
    const sync = () => {
      const t = currentType();
      q('#feChoicesRow').hidden = !(t === 'choice' || t === 'multi_choice');
      q('#feNumberRow').hidden = t !== 'number';
    };
    q('#feType')?.addEventListener('change', sync); sync();
    q('#feSave').addEventListener('click', async event => {
      const btn = event.currentTarget; const out = q('#feFeedback');
      const t = currentType();
      const field = { field_key: previous ? previous.field_key : q('#feKey').value.trim(), label_cn: q('#feLabel').value.trim(), help_cn: q('#feHelp').value.trim() };
      if (!previous) field.value_type = t;
      if (t === 'choice' || t === 'multi_choice') {
        const parsed = parseChoicesText(q('#feChoices').value);
        if (parsed.error) { feedback(out, parsed.error); return; }
        field.choices = parsed.choices;
      }
      if (t === 'number') { field.unit = q('#feUnit').value.trim(); field.min_value = q('#feMin').value.trim(); field.max_value = q('#feMax').value.trim(); }
      const order = q('#feOrder').value.trim();
      if (order) {
        if (!/^\d{1,5}$/.test(order)) { feedback(out, '显示顺序须为 0–99999 的整数。'); return; }
        field.sort_order = Number(order);
      }
      if (previous) field.active = q('#feActive').checked;
      const problem = definitionProblem(field, { others: fields, previous });
      if (problem) { feedback(out, problem); return; }
      if (previous && previous.active && !field.active && !confirm(`停用“${previous.label_cn}”？停用后不能再录入或导入，已录入的值保留，可随时重新启用。`)) return;
      deps.setBusy(btn, true); modal.overlay.dataset.busy = '1';
      try {
        const { error } = await deps.sb.rpc('save_project_field', { p_project_id: op.project.id, p_field: field });
        if (error) throw error;
        deps.assertCurrent(op);
        delete modal.overlay.dataset.busy; modal.close();
        await load(op);
        feedback(node(deps.feedback), previous ? `已保存“${field.label_cn}”，修改已留痕。` : `已新增字段“${field.label_cn}”。`, 'ok');
      } catch (e) { if (deps.isCurrent(op)) feedback(out, '未保存：' + message(e)); }
      finally { delete modal.overlay.dataset.busy; deps.setBusy(btn, false); }
    });
    return modal;
  }

  /** 载入入组字段草案（FIELD_PRESETS）：只新增本项目还没有的字段代码，已有的跳过；载入后由项目负责人逐项核对。 */
  function openPreset(presetId = 'reignite') {
    if (!deps.canManage()) { deps.toast('只有项目负责人可以载入字段草案。'); return null; }
    const preset = FIELD_PRESETS[presetId];
    if (!preset) return null;
    const op = deps.capture();
    if (preset.modules && !preset.modules.includes(String(op.project.module || '').toUpperCase())) {
      deps.toast(`${preset.title}只用于病种模块为 ${preset.modules.join('、')} 的项目。`); return null;
    }
    const plan = preset.fields.map(f => {
      const sameKey = fields.find(x => x.field_key === f.field_key);
      const sameLabel = fields.find(x => x.field_key !== f.field_key && x.label_cn === f.label_cn);
      return { f, skip: sameKey ? '已有同代码字段，跳过' : sameLabel ? `显示名称与“${sameLabel.field_key}”重复，跳过` : '' };
    });
    const adding = plan.filter(p => !p.skip);
    const room = MAX_FIELDS - fields.length;
    const modal = openModal({ id: 'fieldPreset', title: `载入${afterVerb(preset.title)}`, wide: true, html: `
<p class="warnbox small" data-preset-id="${escapeHtml(preset.id)}">${preset.notice}</p>
<div class="fu-table-wrap"><table class="table"><thead><tr><th>显示名称</th><th>代码</th><th>类型</th><th>选项</th><th>处理</th></tr></thead><tbody>${plan.map(({ f, skip }) => `<tr data-preset-key="${escapeHtml(f.field_key)}"><td>${escapeHtml(f.label_cn)}</td><td><code>${escapeHtml(f.field_key)}</code></td><td>${escapeHtml(FIELD_TYPES[f.value_type])}</td><td class="small">${escapeHtml((f.choices || []).map(c => c.label).join('、'))}</td><td>${escapeHtml(skip || '新增')}</td></tr>`).join('')}</tbody></table></div>
${adding.length > room ? `<p class="fu-warn-line small">本项目最多还能新增 ${room} 个字段，草案中的 ${adding.length} 个不能全部载入。</p>` : ''}
<div id="fpFeedback" class="fu-feedback"></div>
<div class="btnbar"><button type="button" class="btn primary" id="fpConfirm"${!adding.length || adding.length > room ? ' disabled' : ''}>新增 ${adding.length} 个字段</button><button type="button" class="btn" data-modal-close>取消</button></div>` });
    modal.q('#fpConfirm').addEventListener('click', async event => {
      const btn = event.currentTarget; const out = modal.q('#fpFeedback');
      deps.setBusy(btn, true); modal.overlay.dataset.busy = '1';
      let done = 0;
      try {
        for (const { f } of adding) {
          const { error } = await deps.sb.rpc('save_project_field', { p_project_id: op.project.id, p_field: f });
          if (error) throw error;
          deps.assertCurrent(op); done++;
          feedback(out, `已新增 ${done}/${adding.length} 个字段…`, 'info');
        }
        delete modal.overlay.dataset.busy; modal.close();
        await load(op);
        feedback(node(deps.feedback), `已载入${afterVerb(preset.title)}：新增 ${done} 个字段${plan.length > adding.length ? `，跳过 ${plan.length - adding.length} 个` : ''}。请逐项核对选项。`, 'ok');
      } catch (e) {
        if (deps.isCurrent(op)) {
          feedback(out, `载入未完成：已新增 ${done} 个字段，${message(e)}。可以关闭后重新载入，已有的字段会跳过。`);
          try { await load(op); } catch { /* 列表稍后可刷新 */ }
        }
      } finally { delete modal.overlay.dataset.busy; deps.setBusy(btn, false); }
    });
    return modal;
  }

  // ── 每位患者的录入 ──────────────────────────────────────────
  function inputHtml(f, value, disabled) {
    const id = `pf_${f.field_key}`; const off = disabled ? ' disabled' : '';
    const describedBy = ` aria-describedby="${id}_rule"`;
    switch (f.value_type) {
      case 'choice':
        return `<select id="${id}"${off}${describedBy}><option value="">未填</option>${f.choices.map(c => `<option value="${escapeHtml(c.code)}"${c.code === value ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}</select>`;
      case 'multi_choice':
        return `<div id="${id}" class="pf-checks" role="group"${describedBy}>${f.choices.map(c => `<label class="fu-check"><input type="checkbox" name="${id}" value="${escapeHtml(c.code)}"${(value || []).includes(c.code) ? ' checked' : ''}${off}/> ${escapeHtml(c.label)}</label>`).join('')}</div>`;
      case 'yes_no':
        return `<select id="${id}"${off}${describedBy}><option value="">未填</option>${Object.entries(YES_NO).map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
      case 'number':
        return `<input id="${id}" inputmode="decimal" value="${escapeHtml(value ?? '')}"${off}${describedBy}/>`;
      case 'date':
        return `<input id="${id}" type="date" min="1900-01-01" max="${escapeHtml(deps.today())}" value="${escapeHtml(value ?? '')}"${off}${describedBy}/>`;
      default:
        return `<input id="${id}" maxlength="${TEXT_MAX}" value="${escapeHtml(value ?? '')}"${off}${describedBy}/>`;
    }
  }
  function readInput(scope, f) {
    const id = `pf_${f.field_key}`;
    if (f.value_type === 'multi_choice') return [...scope.querySelectorAll(`input[name="${id}"]:checked`)].map(n => n.value);
    return scope.querySelector(`#${id}`)?.value ?? '';
  }

  async function openPatient(code) {
    const op = deps.capture();
    if (loadedFor !== op.project.id) { try { await load(op); } catch (e) { deps.toast('入组字段读取失败：' + message(e)); return null; } }
    const canWrite = deps.can('can_write');
    const modal = openModal({ id: 'patientFields', title: `入组字段 · ${code}`, wide: true, html: '<p class="muted small" id="pfLoading">正在读取…</p>' });
    const body = modal.q('.fu-modal-body');
    let stored;
    try {
      const { data, error } = await deps.sb.from('patient_field_values').select(VALUE_COLUMNS).eq('project_id', op.project.id).eq('patient_code', code);
      if (error) throw error;
      deps.assertCurrent(op);
      stored = new Map((data || []).map(r => [r.field_key, r]));
    } catch (e) {
      if (deps.isCurrent(op)) body.innerHTML = `<p class="fu-feedback" data-tone="error" role="alert">读取失败：${escapeHtml(message(e))}</p>`;
      return modal;
    }
    const editable = sortFields(fields).filter(f => f.active);
    const retired = sortFields(fields).filter(f => !f.active && stored.has(f.field_key));
    body.innerHTML = `
<p class="muted small">${canWrite ? '按原始资料填写；留空表示未填，清空已有的值即删除该项。每次修改都会留痕。' : '当前项目角色只能查看。'}</p>
<div class="pf-form">${editable.map(f => `<div class="pf-field" data-field-key="${escapeHtml(f.field_key)}">
  <label for="pf_${escapeHtml(f.field_key)}">${escapeHtml(f.label_cn)}${f.unit ? `（${escapeHtml(f.unit)}）` : ''}</label>
  ${inputHtml(f, storedValue(f, stored.get(f.field_key)), !canWrite)}
  <div class="muted small" id="pf_${escapeHtml(f.field_key)}_rule">${escapeHtml(f.help_cn || fieldRule(f))}</div></div>`).join('')}</div>
${retired.length ? `<h3 class="fu-h3">已停用的字段</h3><ul class="small">${retired.map(f => `<li data-retired-key="${escapeHtml(f.field_key)}">${escapeHtml(f.label_cn)}：${escapeHtml(valueDisplay(f, stored.get(f.field_key)))}（字段已停用，取值保留）</li>`).join('')}</ul>` : ''}
${editable.length ? '' : '<p class="muted small">本项目没有启用的入组字段。</p>'}
<div id="pfFeedback" class="fu-feedback"></div>
<div class="btnbar">${canWrite && editable.length ? '<button type="button" class="btn primary" id="pfSave">保存入组字段</button>' : ''}<button type="button" class="btn" data-modal-close>${canWrite ? '取消' : '关闭'}</button></div>`;
    modal.q('#pfSave')?.addEventListener('click', async event => {
      const btn = event.currentTarget; const out = modal.q('#pfFeedback');
      const changes = {};
      body.querySelectorAll('.fu-invalid').forEach(n => n.classList.remove('fu-invalid'));
      for (const f of editable) {
        let value;
        try { value = inputToValue(f, readInput(body, f), { today: deps.today(), containsPII: deps.containsPII }); }
        catch (e) { modal.q(`#pf_${f.field_key}`)?.classList.add('fu-invalid'); feedback(out, e.message); modal.q(`#pf_${f.field_key}`)?.focus(); return; }
        if (!sameInput(f, storedValue(f, stored.get(f.field_key)), value)) changes[f.field_key] = value;
      }
      if (!Object.keys(changes).length) { feedback(out, '没有修改。', 'info'); return; }
      deps.setBusy(btn, true); modal.overlay.dataset.busy = '1';
      try {
        const { data, error } = await deps.sb.rpc('set_patient_field_values', { p_project_id: op.project.id, p_patient_code: code, p_values: changes });
        if (error) throw error;
        deps.assertCurrent(op);
        delete modal.overlay.dataset.busy; modal.close();
        deps.toast(`已保存 ${code} 的入组字段（${Number(data?.changed) || 0} 项），修改已留痕。`);
      } catch (e) { if (deps.isCurrent(op)) feedback(out, '未保存：' + message(e)); }
      finally { delete modal.overlay.dataset.busy; deps.setBusy(btn, false); }
    });
    return modal;
  }

  return { load, clear, render, openEditor, openPreset, openPatient, get fields() { return fields; }, fieldLabels };
}
