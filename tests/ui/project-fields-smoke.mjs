// 自定义入组字段的浏览器冒烟测试（合成数据，不连接任何真实数据库）。
// 运行：node tests/ui/project-fields-smoke.mjs   成功时打印 PROJECT_FIELDS_UI_OK。
// 与其他工作台冒烟测试相同：本地静态服务器提供 site/，Playwright 打开 staff.html，
// 对 Supabase 域名的请求用 page.route 返回合成数据；其他外部主机的请求一律拦截并记为失败。
// 覆盖：载入 REIGNITE 入组字段草案、新增与修改字段（前端规则与数据库一致）、看板“入组字段”录入、
// 数据库提示原样显示、批量导入（显示名称作列名、已有不同值阻断）、导出 CSV、只读角色只能查看。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const CONFIG_SOURCE = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const SUPABASE_URL = CONFIG_SOURCE.match(/SUPABASE_URL:\s*["']([^"']+)["']/)?.[1];
assert.ok(SUPABASE_URL, 'config.js 中没有 SUPABASE_URL');
const SUPABASE_HOST = new URL(SUPABASE_URL).host;
const SB_PREFIX = new URL(SUPABASE_URL).pathname.replace(/\/+$/, '');
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

// ── 合成数据 ────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = days => { const d = new Date(Date.now() + 8 * 3600 * 1000); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const tsOffset = days => new Date(Date.now() + days * 86400000).toISOString();
const USER = { id: '00000000-0000-4000-8000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: 'pi.synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const PROJECT = { id: '10000000-0000-4000-8000-000000000001', name: '合成测试队列', center_code: 'TST01', module: 'C3G', registry_type: 'general', description: null, created_by: USER.id, created_at: '2026-02-01T00:00:00Z', followup_interval_days: 90, public_title: '合成随访研究', institution_name: '测试医院肾内科', ethics_approval_no: 'TEST-2026-001', contact_display: '研究护士 测试老师' };
const OWNER = { role: 'owner', can_read: true, can_write: true, can_export: true, can_manage_tokens: true, can_manage_members: true, can_manage_project: true, write_block_reason: null };
const VIEWER = { role: 'viewer', can_read: true, can_write: false, can_export: false, can_manage_tokens: false, can_manage_members: false, can_manage_project: false, write_block_reason: 'role_read_only' };
const OVERVIEW = { project_id: PROJECT.id, followup_interval_days: 90, n_patients: 3, n_active: 3, n_visits: 0, n_visits_30d: 0, n_core_complete_visits: 0, core_completeness: null, n_overdue: 0, n_due_soon: 0, n_no_visit: 3, last_visit_date: null, n_consent_confirmed: 3, n_consent_unconfirmed: 0, n_open_issues: 0 };
const row = (id, code) => ({ project_id: PROJECT.id, patient_id: `20000000-0000-4000-8000-00000000000${id}`, center_code: 'TST01', patient_code: code, baseline_date: dayOffset(-100), consent_status: 'consented', followup_status: 'active', visit_count: 0, first_visit_date: null, last_visit_date: null, days_since_last_visit: null, next_due_date: dayOffset(-10), followup_state: 'no_visit', active_link_count: 0, last_link_created_at: null, last_link_expires_at: null, last_patient_submission_at: null, followup_start_date: null });
const BOARD = [row(1, 'P001'), row(2, 'P002'), row(3, 'P003')];

// ── 本地静态服务器与浏览器 ───────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/staff' || rel.startsWith('/staff/')) rel = '/staff.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function chromiumExecutable() {
  if (process.env.STAFF_UI_CHROMIUM) return process.env.STAFF_UI_CHROMIUM;
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch { /* 使用本机已安装的版本 */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const found = (fs.existsSync(root) ? fs.readdirSync(root) : [])
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(name => path.join(root, name, 'chrome-linux', 'chrome'))
    .find(file => fs.existsSync(file));
  if (!found) throw new Error('未找到已安装的 Chromium。请设置 PLAYWRIGHT_BROWSERS_PATH 或 STAFF_UI_CHROMIUM；本测试不会下载浏览器。');
  return found;
}
async function eventually(check, message, timeout = 8000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message}${last ? '：' + last.message : ''}`);
}
function sessionFor() {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER.id, role: 'authenticated', aud: 'authenticated', email: USER.email, exp: now + 86400, iat: now })}.synthetic-signature`;
  return { access_token: accessToken, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'synthetic-refresh-token', user: USER };
}

// ── Supabase 模拟：字段定义与取值按数据库规则的最小子集保存 ──────────────
function createMock({ access, fields = [], values = [] }) {
  const requests = []; const external = []; const unknown = [];
  const errors = {};   // RPC 名 → 下一次调用返回的 PostgREST 错误
  let n = 0;
  const cors = origin => ({ 'access-control-allow-origin': origin || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range,x-total-count' });
  const filters = (url, op) => Object.fromEntries([...url.searchParams].filter(([, v]) => v.startsWith(`${op}.`)).map(([k, v]) => [k, v.slice(op.length + 1)]));
  const column = (f, v) => f.value_type === 'multi_choice' ? { value_codes: v } : f.value_type === 'number' ? { value_num: Number(v) } : f.value_type === 'date' ? { value_date: v } : { value_text: v };
  function restRows(table, url) {
    const f = filters(url, 'eq');
    switch (table) {
      case 'projects': return [PROJECT];
      case 'v_project_overview': return [OVERVIEW];
      case 'v_patient_followup_status': return BOARD.filter(r => !f.patient_code || r.patient_code === f.patient_code).filter(r => !filters(url, 'gt').patient_id || r.patient_id > filters(url, 'gt').patient_id);
      case 'project_fields': return fields.filter(x => x.project_id === f.project_id);
      case 'patient_field_values': return values.filter(v => v.project_id === f.project_id && (!f.patient_code || v.patient_code === f.patient_code));
      case 'patient_tokens': case 'visits_long': case 'patients_baseline': case 'user_profiles': case 'project_custom_labs': case 'lab_test_catalog': case 'lab_test_unit_map':
      case 'labs_long': case 'meds_long': case 'events_long': case 'variants_long': case 'data_issues': case 'biopsies_long':
        return [];
      default: unknown.push(`GET ${table}`); return [];
    }
  }
  function rpc(name, body) {
    switch (name) {
      case 'get_project_access': return access;
      case 'check_project_quota': return { plan: 'trial', can_write: true, ends_at: tsOffset(60), quota: 3, used: 1 };
      case 'is_platform_admin': return false;
      case 'get_my_contract': return [];
      case 'list_project_members': return [{ user_id: USER.id, email: USER.email, display_name: null, role: access.role, created_at: '2026-01-01T00:00:00Z', is_owner: access.role === 'owner' }];
      case 'list_project_snapshots': case 'list_import_batches': return [];
      case 'get_issue_summary': return { total_open: 0, total_in_prog: 0, total_resolved: 0, total_wontfix: 0 };
      case 'log_project_audit': case 'register_import_file': return null;
      case 'save_project_field': {
        const p = body.p_field; let f = fields.find(x => x.field_key === p.field_key);
        if (!f) {
          f = { id: `40000000-0000-4000-8000-0000000000${pad(++n)}`, project_id: body.p_project_id, help_cn: null, choices: null, unit: null, min_value: null, max_value: null, active: true, source: null,
            sort_order: Math.max(0, ...fields.map(x => x.sort_order)) + 10 };
          fields.push(f);
        }
        for (const [k, v] of Object.entries(p)) f[k] = v === '' ? null : ['min_value', 'max_value'].includes(k) && v != null ? Number(v) : v;
        return f;
      }
      case 'set_patient_field_values': {
        let changed = 0;
        for (const [key, v] of Object.entries(body.p_values)) {
          const def = fields.find(x => x.field_key === key);
          const i = values.findIndex(x => x.patient_code === body.p_patient_code && x.field_key === key);
          if (i >= 0) { values.splice(i, 1); changed++; }
          if (v !== null) { values.push({ id: `50000000-0000-4000-8000-0000000000${pad(++n)}`, project_id: body.p_project_id, patient_code: body.p_patient_code, field_key: key, value_text: null, value_codes: null, value_num: null, value_date: null, ...column(def, v) }); if (i < 0) changed++; }
        }
        return { values: {}, changed };
      }
      case 'import_registry_rows': return { inserted: body.p_rows.length, updated: 0, skipped: 0, total: body.p_rows.length, replayed: false };
      default: unknown.push(`RPC ${name}`); return null;
    }
  }
  async function handle(route, localOrigin) {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === localOrigin) return route.continue();
    if (url.host !== SUPABASE_HOST) { external.push(request.url()); return route.abort('blockedbyclient'); }
    if (SB_PREFIX && url.pathname.startsWith(SB_PREFIX + '/')) url.pathname = url.pathname.slice(SB_PREFIX.length);
    const headers = cors(request.headers().origin);
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = request.postData(); }
    requests.push({ method: request.method(), path: url.pathname, params: url.searchParams, body });
    const settle = promise => promise.catch(() => {});
    const json = (status, value, extra = {}) => settle(route.fulfill({ status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(value) }));
    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname.endsWith('/user')) return json(200, USER);
      if (url.pathname.endsWith('/token')) return json(200, sessionFor());
      if (url.pathname.endsWith('/logout')) return settle(route.fulfill({ status: 204, headers }));
      unknown.push(`AUTH ${url.pathname}`); return json(200, {});
    }
    const rpcName = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/)?.[1];
    if (rpcName) {
      if (errors[rpcName]) { const e = errors[rpcName]; delete errors[rpcName]; return json(400, e); }
      return json(200, rpc(rpcName, body || {}));
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z0-9_]+)$/)?.[1];
    if (table && request.method() === 'GET') {
      const rows = restRows(table, url);
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : rows.length;
      const page = rows.slice(offset, offset + limit);
      return json(200, page, { 'content-range': page.length ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}` });
    }
    unknown.push(`${request.method()} ${url.pathname}`);
    return json(200, null);
  }
  return { requests, external, unknown, fields, values, errors, handle, rpcCalls: name => requests.filter(r => r.path === `/rest/v1/rpc/${name}`) };
}

async function openWorkspace(browser, origin, options) {
  const mock = createMock(options);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN', acceptDownloads: true });
  await context.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* 忽略 */ } }, [STORAGE_KEY, JSON.stringify(sessionFor())]);
  await context.route('**/*', route => mock.handle(route, origin));
  const page = await context.newPage();
  const pageErrors = []; const dialogs = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
  await page.goto(`${origin}/staff.html`);
  await page.locator('#patientsList tbody tr[data-patient-code]').first().waitFor({ timeout: 15000 });
  return { context, page, mock, pageErrors, dialogs };
}

const text = async locator => (await locator.textContent())?.replace(/\s+/g, ' ').trim();
const loadModule = async file => import(`data:text/javascript;base64,${fs.readFileSync(path.join(ROOT, file)).toString('base64')}`);
const csvFile = (name, lines) => ({ name, mimeType: 'text/csv', buffer: Buffer.from('﻿' + lines.join('\r\n'), 'utf8') });

async function checkPureHelpers() {
  const data = await loadModule('lib/registry-data.js');
  const labels = { fundus_exam_date: '眼底检查日期', fundus_note: '眼底检查所见' };
  assert.equal(data.registryErrorMessage({ message: 'row_3_invalid_iso_date: fundus_exam_date' }, { fieldLabels: labels }).slice(0, 13), '第 4 行：眼底检查日期：', '自定义字段的名称写在提示前');
  assert.ok(data.registryErrorMessage({ message: 'pii_detected_blocked: fundus_note' }, { fieldLabels: labels }).startsWith('眼底检查所见：'));
  assert.equal(data.registryErrorMessage({ message: 'invalid_field_value: ethnicity', hint: '“民族”只能填：汉族（han）、回族（hui）。' }, { fieldLabels: { ethnicity: '民族' } }), '“民族”只能填：汉族（han）、回族（hui）。', '数据库提示已写明字段，不重复');
  assert.equal(data.registryErrorMessage({ message: 'invalid_iso_date: consent_date' }, { fieldLabels: { consent_date: '自定义同名' } }).slice(0, 7), '知情同意日期：', '系统字段名称优先');
  for (const message of ['field_key_is_immutable', 'field_values_required', 'invalid_field_sort_order', 'unsupported_field_property: x']) assert.match(data.registryErrorMessage({ message }), /^[^a-z]*$/, message);
  // 导出可再导入：数值（如 -5）不加防公式前缀，只有文本字段加。
  const fieldsLib = await loadModule('lib/project-fields.js');
  const csv = fieldsLib.fieldsExportCsv([{ field_key: 'delta', label_cn: '变化', value_type: 'number', sort_order: 10, active: true }, { field_key: 'note', label_cn: '备注', value_type: 'text', sort_order: 20, active: true }],
    [{ patient_code: 'P1', field_key: 'delta', value_num: -5 }, { patient_code: 'P1', field_key: 'note', value_text: '=SUM(A1)' }]);
  assert.equal(csv.split('\r\n')[1], "P1,-5,'=SUM(A1)");
}

async function main() {
  await checkPureHelpers();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const fieldsModule = await loadModule('lib/project-fields.js');
  try {
    // 1. 项目负责人：还没有字段时，看板不显示“入组字段”，导出按钮隐藏；载入 REIGNITE 草案。
    const { context, page, mock, pageErrors, dialogs } = await openWorkspace(browser, origin, { access: OWNER });
    await page.click('#projectFieldsDetails summary');
    await eventually(async () => (await text(page.locator('#projectFieldsList')))?.includes('本项目还没有自定义入组字段'), '空字段清单');
    assert.equal(await page.locator('#patientsList [data-act="fields"]').count(), 0, '没有字段时看板不显示入组字段');
    assert.equal(await page.locator('#btnExportFields').isHidden(), true);
    await page.click('#btnLoadFieldPreset');
    const preset = page.locator('[data-registry-modal="fieldPreset"]');
    await preset.waitFor();
    assert.ok((await text(preset)).includes('尚未与对方的病例报告表核对'), '草案须说明尚未核对');
    assert.equal(await preset.locator('tr[data-preset-key]').count(), 7);
    await page.click('#fpConfirm');
    await preset.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('save_project_field').map(r => r.body.p_field), fieldsModule.REIGNITE_DRAFT.map(f => ({ ...f })), '按草案逐个新增');
    assert.ok(mock.rpcCalls('save_project_field').every(r => r.body.p_project_id === PROJECT.id));
    await eventually(async () => (await page.locator('#projectFieldsList tr[data-field-key]').count()) === 7, '字段清单显示 7 个字段');
    assert.ok((await text(page.locator('#projectFieldsFeedback'))).includes('新增 7 个字段'));
    await eventually(async () => (await page.locator('#patientsList [data-act="fields"]').count()) === 3, '有字段后看板显示“入组字段”');
    assert.equal(await page.locator('#btnExportFields').isVisible(), true);
    await page.click('#btnLoadFieldPreset');
    await preset.waitFor();
    assert.equal(await page.locator('#fpConfirm').isDisabled(), true, '再次载入时全部跳过');
    assert.ok((await text(preset)).includes('已有同代码字段，跳过'));
    await page.keyboard.press('Escape');

    // 2. 新增数值字段：最小值大于最大值时前端拦截；修改单选字段：已有选项不能删除，可以增加。
    await page.click('#btnNewField');
    const editor = page.locator('[data-registry-modal="fieldEditor"]');
    await editor.waitFor();
    await page.fill('#feKey', 'onset_age'); await page.fill('#feLabel', '起病年龄'); await page.selectOption('#feType', 'number');
    assert.equal(await page.locator('#feChoicesRow').isHidden(), true, '数值字段不显示选项');
    await page.fill('#feUnit', '岁'); await page.fill('#feMin', '50'); await page.fill('#feMax', '10');
    await page.click('#feSave');
    await eventually(async () => (await text(page.locator('#feFeedback')))?.includes('最小值不能大于最大值'), '范围前端校验');
    assert.equal(mock.rpcCalls('save_project_field').length, 7);
    await page.fill('#feMin', '0'); await page.fill('#feMax', '120');
    await page.click('#feSave');
    await editor.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('save_project_field').at(-1).body.p_field, { field_key: 'onset_age', label_cn: '起病年龄', help_cn: '', value_type: 'number', unit: '岁', min_value: '0', max_value: '120' });
    await eventually(async () => (await page.locator('#projectFieldsList tr[data-field-key]').count()) === 8, '新增后 8 个字段');
    await page.click('#projectFieldsList [data-edit-field="ethnicity"]');
    await editor.waitFor();
    assert.equal(await page.locator('#feKey').evaluate(n => n.tagName), 'CODE', '已有字段的代码不能修改');
    const original = await page.inputValue('#feChoices');
    await page.fill('#feChoices', original.split('\n').filter(l => !l.startsWith('han ')).join('\n'));
    await page.click('#feSave');
    await eventually(async () => (await text(page.locator('#feFeedback')))?.includes('已有选项不能删除（han）'), '删除已有选项被拦截');
    await page.fill('#feChoices', `${original}\nkazakh 哈萨克族`);
    await page.click('#feSave');
    await editor.waitFor({ state: 'detached' });
    const edited = mock.rpcCalls('save_project_field').at(-1).body.p_field;
    assert.equal(edited.choices.length, 13); assert.deepEqual(edited.choices.at(-1), { code: 'kazakh', label: '哈萨克族' });
    assert.equal(edited.active, true); assert.ok(!('value_type' in edited), '修改时不发送字段类型');

    // 3. 看板“入组字段”：前端校验（未来日期）不发请求；保存只发送有变化的字段；清空即删除。
    await page.click('#patientsList tr[data-patient-code="P001"] [data-act="fields"]');
    const dialog = page.locator('[data-registry-modal="patientFields"]');
    await dialog.waitFor();
    await eventually(async () => (await dialog.locator('.pf-field').count()) === 8, '显示 8 个启用的字段');
    await page.selectOption('#pf_inclusion_basis', 'biopsy_proven');
    await page.selectOption('#pf_ethnicity', 'hui');
    await page.selectOption('#pf_autoimmune_disease', 'yes');
    await page.check('input[name="pf_comorbidities"][value="diabetes"]'); await page.check('input[name="pf_comorbidities"][value="hypertension"]');
    await page.fill('#pf_fundus_exam_date', dayOffset(1));
    await page.fill('#pf_onset_age', '38.5');
    await page.click('#pfSave');
    await eventually(async () => (await text(page.locator('#pfFeedback')))?.includes('不能晚于今天'), '未来日期在前端拦截');
    assert.equal(mock.rpcCalls('set_patient_field_values').length, 0);
    await page.fill('#pf_fundus_exam_date', dayOffset(-10));
    await page.click('#pfSave');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('set_patient_field_values')[0].body, { p_project_id: PROJECT.id, p_patient_code: 'P001', p_values: {
      inclusion_basis: 'biopsy_proven', ethnicity: 'hui', autoimmune_disease: 'yes', comorbidities: ['hypertension', 'diabetes'], fundus_exam_date: dayOffset(-10), onset_age: '38.5' } }, '多选按定义顺序保存');
    await page.click('#patientsList tr[data-patient-code="P001"] [data-act="fields"]');
    await dialog.waitFor();
    await eventually(async () => (await page.inputValue('#pf_onset_age')) === '38.5', '再次打开显示已保存的值');
    assert.equal(await page.inputValue('#pf_ethnicity'), 'hui');
    await page.selectOption('#pf_ethnicity', '');
    await page.uncheck('input[name="pf_comorbidities"][value="diabetes"]');
    await page.click('#pfSave');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('set_patient_field_values')[1].body.p_values, { ethnicity: null, comorbidities: ['hypertension'] }, '只发送有变化的字段；清空为 null');
    mock.errors.set_patient_field_values = { code: 'P0001', message: 'invalid_field_value: onset_age', details: null, hint: '“起病年龄”须为数字，范围 0–120（岁）。' };
    await page.click('#patientsList tr[data-patient-code="P001"] [data-act="fields"]');
    await dialog.waitFor();
    await eventually(async () => (await page.inputValue('#pf_onset_age')) === '38.5', '读取完成');
    await page.fill('#pf_onset_age', '40');
    await page.click('#pfSave');
    await eventually(async () => (await text(page.locator('#pfFeedback'))) === '未保存：“起病年龄”须为数字，范围 0–120（岁）。', '数据库提示原样显示');
    await page.keyboard.press('Escape');

    // 4. 导出：每位患者一行、每个字段一列，可直接作为导入文件；导出留痕。
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportFields')]);
    assert.match(download.suggestedFilename(), /^patient_field_values_TST01_.*\.csv$/);
    const exported = fs.readFileSync(await download.path(), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    assert.equal(exported[0], 'patient_code,inclusion_basis,ethnicity,autoimmune_disease,autoimmune_disease_type,comorbidities,fundus_exam,fundus_exam_date,onset_age');
    assert.equal(exported[1], `P001,biopsy_proven,,yes,,hypertension,,${dayOffset(-10)},38.5`);
    assert.deepEqual(mock.rpcCalls('log_project_audit').at(-1).body.p_details, { kind: 'fields', filename: download.suggestedFilename(), rows: 5, patients: 1, complete_count_checked: true });

    // 5. 批量导入：显示名称作列名；已有不同的值、未建档编号、无效数值阻断；空行不导入。
    await page.selectOption('#importType', 'fields');
    const [template] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownloadTemplate')]);
    assert.equal(template.suggestedFilename(), 'template_fields_TST01.csv');
    assert.ok(fs.readFileSync(await template.path(), 'utf8').replace(/^﻿/, '').startsWith('patient_code,inclusion_basis,ethnicity,'));
    await page.click('#btnImportHelp');
    assert.ok((await text(page.locator('#importHelp'))).includes('可多选') && (await text(page.locator('#importHelp'))).includes('也可用字段的显示名称作列名'));
    await page.click('#btnImportHelp');
    await page.setInputFiles('#importFile', csvFile('fields.csv', ['patient_code,民族,comorbidities,onset_age,autoimmune_disease',
      'P002,汉族,糖尿病;高血压,45,否',
      'P001,回族,,,',
      'P001,,,39,',
      'P009,汉族,,,',
      'P003,满族,,abc,',
      'P003,,,,']));
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    const count = async name => Number((await text(page.locator(`#importCounts [data-count="${name}"]`))).match(/\d+/)[0]);
    assert.deepEqual([await count('total'), await count('writable'), await count('warn'), await count('block')], [6, 2, 0, 3]);
    const rowText = async line => text(page.locator(`#importTable tr[data-line="${line}"]`));
    assert.ok((await rowText(4)).includes('已有不同的值，导入不会覆盖'), await rowText(4));
    assert.ok((await rowText(5)).includes('本项目中没有该研究编号的患者'));
    assert.ok((await rowText(6)).includes('须为数字'));
    assert.ok((await text(page.locator('#importTable thead'))).includes('起病年龄'), '表头显示字段名称');
    await page.click('#btnConfirmImport');
    await eventually(() => mock.rpcCalls('import_registry_rows').length === 1, '提交可写入的行');
    const imported = mock.rpcCalls('import_registry_rows')[0].body;
    assert.equal(imported.p_kind, 'fields');
    assert.deepEqual(imported.p_rows, [{ patient_code: 'P002', ethnicity: 'han', comorbidities: 'hypertension;diabetes', onset_age: '45', autoimmune_disease: 'no' }, { patient_code: 'P001', ethnicity: 'hui' }]);
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('导入完成（入组字段）'), '导入结果');

    assert.deepEqual(pageErrors, [], '页面不应有未捕获异常');
    assert.deepEqual(mock.external, [], '不得访问其他外部主机');
    assert.deepEqual(mock.unknown, [], `未模拟的请求：${mock.unknown.join(', ')}`);
    assert.ok(dialogs.every(d => !/undefined|null/.test(d)), dialogs.join(' | '));
    await context.close();

    // 6. 只读协作人：可以查看字段与取值，不能修改；没有新增、载入草案和导出入口。
    const fields = mock.fields.map(f => ({ ...f })); const values = mock.values.map(v => ({ ...v }));
    const viewer = await openWorkspace(browser, origin, { access: VIEWER, fields, values });
    await viewer.page.click('#projectFieldsDetails summary');
    await eventually(async () => (await viewer.page.locator('#projectFieldsList tr[data-field-key]').count()) === 8, '只读角色可以查看字段清单');
    assert.equal(await viewer.page.locator('#projectFieldsActions').isHidden(), true);
    assert.equal(await viewer.page.locator('#projectFieldsList [data-edit-field]').count(), 0);
    await viewer.page.click('#patientsList tr[data-patient-code="P001"] [data-act="fields"]');
    await viewer.page.locator('[data-registry-modal="patientFields"] .pf-field').first().waitFor();
    assert.equal(await viewer.page.locator('#pfSave').count(), 0, '只读角色没有保存按钮');
    assert.equal(await viewer.page.locator('#pf_onset_age').isDisabled(), true);
    assert.equal(await viewer.page.inputValue('#pf_onset_age'), '38.5');
    assert.equal(await viewer.page.locator('#btnExportFields').isDisabled(), true, '没有导出权限');
    assert.deepEqual(viewer.pageErrors, []);
    assert.deepEqual(viewer.mock.unknown, []);
    await viewer.context.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log('PROJECT_FIELDS_UI_OK');
}

main().catch(error => { console.error(error); process.exit(1); });
