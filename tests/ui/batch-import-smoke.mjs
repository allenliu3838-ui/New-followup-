// 化验 / 用药 / 终点事件 / 肾活检记录批量导入的浏览器冒烟测试（合成数据，不连接任何真实数据库）。
// 运行：node tests/ui/batch-import-smoke.mjs   成功时打印 BATCH_IMPORT_UI_OK。
// 与 staff-smoke.mjs 相同的方式：本地静态服务器提供 site/，Playwright 打开 staff.html，
// 对 Supabase 域名的请求用 page.route 返回合成数据；其他外部主机的请求一律拦截并记为失败。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const CONFIG_SOURCE = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const SUPABASE_URL = CONFIG_SOURCE.match(/SUPABASE_URL:\s*["']([^"']+)["']/)?.[1];
assert.ok(SUPABASE_URL, 'config.js 中没有 SUPABASE_URL');
const SUPABASE_HOST = new URL(SUPABASE_URL).host;
// 接口挂在站点路径下（如 /sb）时，去掉前缀后按 Supabase 原路径模拟
const SB_PREFIX = new URL(SUPABASE_URL).pathname.replace(/\/+$/, '');
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── 合成数据 ────────────────────────────────────────────────
const USER = { id: '00000000-0000-4000-8000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: 'pi.synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const PROJECT = { id: '10000000-0000-4000-8000-000000000001', name: '合成测试队列', center_code: 'TST01', module: 'IGAN', registry_type: 'igan', description: null, created_by: USER.id, created_at: '2026-02-01T00:00:00Z', followup_interval_days: 90, public_title: '合成随访研究', institution_name: '测试医院肾内科', ethics_approval_no: 'TEST-2026-001', contact_display: '研究护士 测试老师' };
const OWNER = { role: 'owner', can_read: true, can_write: true, can_export: true, can_manage_tokens: true, can_manage_members: true, can_manage_project: true, write_block_reason: null };
const VIEWER = { role: 'viewer', can_read: true, can_write: false, can_export: false, can_manage_tokens: false, can_manage_members: false, can_manage_project: false, write_block_reason: 'role_read_only' };
const ANALYST = { ...VIEWER, role: 'analyst', can_export: true };
const OVERVIEW = { project_id: PROJECT.id, followup_interval_days: 90, n_patients: 3, n_active: 2, n_visits: 0, n_visits_30d: 0, n_core_complete_visits: 0, core_completeness: null, n_overdue: 0, n_due_soon: 0, n_no_visit: 3, last_visit_date: null, n_consent_confirmed: 0, n_consent_unconfirmed: 3, n_open_issues: 0 };
const boardRow = (n, extra) => ({ project_id: PROJECT.id, patient_id: `20000000-0000-4000-8000-00000000000${n}`, center_code: 'TST01', patient_code: `P00${n}`, baseline_date: '2024-01-01', consent_status: 'consented', followup_status: 'active', visit_count: 0, first_visit_date: null, last_visit_date: null, days_since_last_visit: null, next_due_date: '2024-04-01', active_link_count: 0, last_link_created_at: null, last_link_expires_at: null, last_patient_submission_at: null, followup_state: 'no_visit', ...extra });
const BOARD = [boardRow(1), boardRow(2, { followup_status: 'deceased', followup_state: 'inactive' }), boardRow(3)];
// 以迁移 0013 的字典为准（节选）。
const CATALOG = [
  { code: 'CREAT', name_cn: '血肌酐', name_en: 'Serum Creatinine', module: 'GENERAL', is_core: true, standard_unit: 'mg/dL', display_note: null },
  { code: 'UPCR', name_cn: '尿蛋白/肌酐比', name_en: 'Urine PCR', module: 'GENERAL', is_core: true, standard_unit: 'g/g', display_note: null },
  { code: 'EGFR', name_cn: 'eGFR（实验室报告）', name_en: 'eGFR (lab report)', module: 'GENERAL', is_core: false, standard_unit: 'mL/min/1.73m²', display_note: null },
  { code: 'HGB', name_cn: '血红蛋白', name_en: 'Hemoglobin', module: 'GENERAL', is_core: false, standard_unit: 'g/dL', display_note: null },
  { code: 'ALT', name_cn: '谷丙转氨酶', name_en: 'ALT', module: 'GENERAL', is_core: false, standard_unit: 'U/L', display_note: null },
  { code: 'ALB', name_cn: '血清白蛋白', name_en: 'Albumin', module: 'GENERAL', is_core: false, standard_unit: 'g/dL', display_note: null },
  { code: 'IGA', name_cn: '血清IgA', name_en: 'Serum IgA', module: 'IGAN', is_core: false, standard_unit: 'g/L', display_note: null },
];
const u = (code, unit, standard) => ({ lab_test_code: code, unit_symbol: unit, is_standard: standard, multiplier: 1 });
const UNIT_MAP = [u('CREAT', 'mg/dL', true), u('CREAT', 'μmol/L', false), u('CREAT', 'umol/L', false), u('UPCR', 'g/g', true), u('UPCR', 'mg/g', false), u('UPCR', 'mg/mmol', false),
  u('EGFR', 'mL/min/1.73m²', true), u('HGB', 'g/dL', true), u('HGB', 'g/L', false), u('ALT', 'U/L', true), u('ALB', 'g/dL', true), u('ALB', 'g/L', false), u('IGA', 'g/L', true)];
const X = n => `<img src=x onerror=window.__xss=(window.__xss||[]).concat('${n}')>`;
const BATCHES = [
  { batch_id: '50000000-0000-4000-8000-000000000001', kind: 'labs', created_at: '2026-10-13T02:00:00Z', created_by_email: `crc${X('email')}@example.test`, inserted: 7, skipped: 1, total: 8, file_sha256: 'a'.repeat(64), file_name: `labs${X('file')}.csv`, chunk_index: 1, chunk_total: 1, undo_supported: true, undone_at: null, undo_reason: null },
  { batch_id: '50000000-0000-4000-8000-000000000002', kind: 'baseline', created_at: '2026-10-12T02:00:00Z', created_by_email: USER.email, inserted: 3, skipped: 0, total: 3, file_sha256: null, file_name: null, chunk_index: null, chunk_total: null, undo_supported: true, undone_at: null, undo_reason: null },
  { batch_id: '50000000-0000-4000-8000-000000000003', kind: 'meds', created_at: '2026-10-11T02:00:00Z', created_by_email: USER.email, inserted: 2, skipped: 0, total: 2, file_sha256: 'b'.repeat(64), file_name: 'meds.csv', chunk_index: 2, chunk_total: 3, undo_supported: false, undone_at: '2026-10-12T03:00:00Z', undo_reason: `重复导入${X('reason')}` },
  // 0040 之前导入的随访批次：没有逐条记录，不能自动撤销。
  { batch_id: '50000000-0000-4000-8000-000000000004', kind: 'visits', created_at: '2026-10-01T02:00:00Z', created_by_email: USER.email, inserted: 4, skipped: 0, total: 4, file_sha256: null, file_name: null, chunk_index: null, chunk_total: null, undo_supported: false, undone_at: null, undo_reason: null },
  { batch_id: '50000000-0000-4000-8000-000000000005', kind: 'biopsies', created_at: '2026-09-30T02:00:00Z', created_by_email: USER.email, inserted: 2, skipped: 0, total: 2, file_sha256: 'c'.repeat(64), file_name: 'biopsies.csv', chunk_index: 1, chunk_total: 1, undo_supported: true, undone_at: null, undo_reason: null },
  { batch_id: '50000000-0000-4000-8000-000000000006', kind: 'fields', created_at: '2026-09-29T02:00:00Z', created_by_email: USER.email, inserted: 3, skipped: 0, total: 3, file_sha256: 'd'.repeat(64), file_name: 'fields.csv', chunk_index: 1, chunk_total: 1, undo_supported: true, undone_at: null, undo_reason: null },
];

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

// ── Supabase 模拟 ───────────────────────────────────────────
function createMock({ access }) {
  const requests = []; const external = []; const unknown = [];
  const importReplies = []; const registerReplies = [];
  const cors = origin => ({ 'access-control-allow-origin': origin || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range,x-total-count' });
  const filters = (url, op) => Object.fromEntries([...url.searchParams].filter(([, v]) => v.startsWith(`${op}.`)).map(([k, v]) => [k, v.slice(op.length + 1)]));
  function restRows(table, url) {
    const f = filters(url, 'eq'); const gt = filters(url, 'gt');
    switch (table) {
      case 'projects': return [PROJECT];
      case 'v_project_overview': return [OVERVIEW];
      case 'v_patient_followup_status': {
        let rows = BOARD.filter(r => !f.patient_code || r.patient_code === f.patient_code);
        if (gt.patient_id) rows = rows.filter(r => r.patient_id > gt.patient_id);
        return rows;
      }
      case 'lab_test_catalog': return CATALOG;
      case 'lab_test_unit_map': return UNIT_MAP;
      case 'patient_tokens': case 'visits_long': case 'patients_baseline': case 'user_profiles': case 'project_custom_labs':
      case 'labs_long': case 'meds_long': case 'events_long': case 'variants_long': case 'data_issues': case 'project_fields': case 'patient_field_values':
        return [];
      // 已有的基准活检：P002 在系统中已有一次（导入预览据此提示）。
      case 'biopsies_long': return f.is_index === 'true' ? [{ id: '71000000-0000-4000-8000-000000000001', patient_code: 'P002', biopsy_date: '2023-05-05', biopsy_kind: 'native' }] : [];
      default: unknown.push(`GET ${table}`); return [];
    }
  }
  function rpc(name, body) {
    switch (name) {
      case 'get_project_access': return access;
      case 'check_project_quota': return { plan: 'trial', can_write: true, ends_at: new Date(Date.now() + 60 * 86400000).toISOString(), quota: 3, used: 1 };
      case 'is_platform_admin': return false;
      case 'get_my_contract': return [];
      case 'list_project_members': return [{ user_id: USER.id, email: USER.email, display_name: null, role: access.role, created_at: '2026-01-01T00:00:00Z', is_owner: access.role === 'owner' }];
      case 'list_project_snapshots': return [];
      case 'get_issue_summary': return { total_open: 0, total_in_prog: 0, total_resolved: 0, total_wontfix: 0 };
      case 'import_registry_rows': { const n = body.p_rows.length; return { inserted: n, updated: 0, skipped: 0, total: n, replayed: false, ...(importReplies.shift() || {}) }; }
      case 'register_import_file': return null;
      case 'list_import_batches': return BATCHES;
      case 'undo_import_batch': return { deleted: 5, kept_changed: 2, kept_referenced: 1, already_undone: false };
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
      const queue = rpcName === 'import_registry_rows' ? importReplies : rpcName === 'register_import_file' ? registerReplies : null;
      if (queue && queue[0]?.postgrestError) return json(400, queue.shift().postgrestError);
      if (queue && queue[0]?.abort) { queue.shift(); return settle(route.abort('failed')); }
      if (rpcName === 'register_import_file') { registerReplies.shift(); return settle(route.fulfill({ status: 204, headers })); }
      return json(200, rpc(rpcName, body || {}));
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z0-9_]+)$/)?.[1];
    if (table && request.method() === 'POST' && ['meds_long', 'events_long'].includes(table)) return settle(route.fulfill({ status: 201, headers }));
    if (table && request.method() === 'GET') {
      const rows = restRows(table, url);
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : rows.length;
      const page = rows.slice(offset, offset + limit);
      if (/vnd\.pgrst\.object/.test(request.headers().accept || '')) return page.length === 1 ? json(200, page[0]) : json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null });
      return json(200, page, { 'content-range': page.length ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}` });
    }
    unknown.push(`${request.method()} ${url.pathname}`);
    return json(200, null);
  }
  return { requests, external, unknown, importReplies, registerReplies, handle, rpcCalls: name => requests.filter(r => r.path === `/rest/v1/rpc/${name}`) };
}

async function openWorkspace(browser, origin, { access = OWNER } = {}) {
  const mock = createMock({ access });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN', acceptDownloads: true });
  await context.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* 忽略 */ } }, [STORAGE_KEY, JSON.stringify(sessionFor())]);
  await context.route('**/*', route => mock.handle(route, origin));
  const page = await context.newPage();
  const pageErrors = []; const dialogs = []; const toasts = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
  await page.goto(`${origin}/staff.html`);
  await page.locator('#patientsList tbody tr[data-patient-code]').first().waitFor({ timeout: 15000 });
  return { context, page, mock, pageErrors, dialogs, toasts };
}

const text = async locator => (await locator.textContent())?.replace(/\s+/g, ' ').trim();
const csvFile = (name, lines) => ({ name, mimeType: 'text/csv', buffer: Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8') });
const counts = async page => Object.fromEntries(await page.locator('#importCounts [data-count]').evaluateAll(nodes => nodes.map(n => [n.dataset.count, Number(n.textContent.replace(/\D/g, ''))])));
async function download(page, action) {
  const [file] = await Promise.all([page.waitForEvent('download'), action()]);
  return { name: file.suggestedFilename(), text: fs.readFileSync(await file.path(), 'utf8') };
}
const loadModule = async file => import(`data:text/javascript;base64,${fs.readFileSync(path.join(ROOT, file)).toString('base64')}`);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const toastText = page => page.locator('.toast').innerText().catch(() => '');

async function checkPureHelpers() {
  const data = await loadModule('lib/registry-data.js');
  const bi = await loadModule('lib/batch-import.js');
  const warn = console.warn; console.warn = () => {};
  for (const code of ['derived_endpoint_not_importable', 'same_key_record_conflict', 'unit_not_allowed', 'file_name_contains_pii', 'batch_kind_not_undoable', 'event_detail_required', 'invalid_evidence_source', 'end_date_before_start_date', 'undo_reason_required', 'value_or_text_required',
    'index_biopsy_exists', 'oxford_c_crescent_mismatch', 'invalid_biopsy_kind', 'biopsy_kind_required', 'invalid_event_type', 'invalid_drug_class']) {
    const message = data.registryErrorMessage({ message: `row_4_${code}` });
    assert.match(message, /^第 5 行：.*[\u4e00-\u9fa5]/, `${code} 应翻译并带行号：${message}`);
    assert.ok(!/[a-z]+_[a-z]+/.test(message), `不得显示代码：${message}`);
  }
  console.warn = warn;
  assert.equal(data.registryErrorMessage({ message: 'row_7_unit_not_allowed: unit_symbol' }, { rowLine: n => 500 + n + 1 }), '第 508 行：单位：所选单位不在该化验项目允许的单位范围内，请重新选择。', '分块时按文件行号显示');
  assert.ok(data.registryErrorMessage({ message: 'baseline_upcr_unit_required' }).includes('基线 UPCR'), '原有错误码不受新增条目影响');
  // 化验别名表只使用字典中存在的编码。
  const index = bi.buildLabIndex(CATALOG);
  for (const name of ['Scr', '肌酐', '血肌酐', 'creatinine']) assert.equal(index.byKey.get(bi.labKey(name))?.size, 1, name);
  assert.ok(!index.byKey.has(bi.labKey('糖化血红蛋白')), '字典中没有的编码不进入别名映射');
  assert.equal(bi.normalizeUnitText('\u00b5mol/L'), 'μmol/L');
  assert.equal(bi.normalizeUnitText('mL/min/1.73m2'), 'mL/min/1.73m²');
  assert.deepEqual(bi.piiHeaderColumns(['patient_code', '姓名', 'drug_name', 'Phone', 'patient_name', 'lab_item_name']), ['姓名', 'Phone', 'patient_name']);
  assert.equal(bi.beijingToday(Date.parse('2026-10-14T17:00:00Z')), '2026-10-15', '“今天”按北京时间');
  // 曾导入后又被删除：提示适用于所有记录类型，不只是随访。
  const deleted = data.registryErrorMessage({ message: 'row_2_previously_imported_record_deleted_requires_review' });
  assert.ok(deleted.includes('相同内容的记录曾导入后又被删除') && !deleted.includes('随访'), deleted);

  // CSV 解析：每条记录保留其在文件中开始的物理行号（空行跳过、引号内换行跨行）。
  const parsed = data.parseRegistryCsv('\ufeffa,b\r\n1,x\r\n\r\n2,"多\r\n行"\r\n3,y\n\n\n4,z');
  assert.deepEqual(parsed.lines, [2, 4, 6, 9], '物理行号');
  assert.deepEqual(parsed.data.map(r => r.a), ['1', '2', '3', '4']);
  assert.throws(() => data.parseRegistryCsv('a,b\n1,2\n\n3'), /第 4 行列数/, '列数错误按物理行号报告');

  // 逐行校验（与数据库 validate_clinical_input / check_clinical_row / import_clinical_row 一致）。
  const PATIENTS = new Map([['P001', { followup_status: 'active', baseline_date: '2024-01-01' }], ['13812345678', { followup_status: 'active' }]]);
  const unitMap = {}; for (const x of UNIT_MAP) (unitMap[x.lab_test_code] ||= []).push(x);
  const ctx = { catalog: CATALOG, unitMap, patients: PATIENTS, today: '2026-10-14', containsPII: data.containsPII };
  const LAB_COLS = ['patient_code', 'lab_date', 'lab_test_code', 'value_raw', 'unit_symbol', 'result_text', 'notes'];
  const lab = (over = {}) => ({ patient_code: 'P001', lab_date: '2025-01-01', lab_test_code: 'CREAT', value_raw: '', unit_symbol: '', result_text: '', notes: '', ...over });
  const labs = (rows, extra = {}) => bi.validateBatch('labs', LAB_COLS, rows, { ...ctx, ...extra });
  // 定性结果填了单位：不阻断，提交时去掉单位并提示。
  let r = labs([lab({ lab_test_code: 'IGA', result_text: '阴性', unit_symbol: 'g/L' })]);
  assert.equal(r.rows[0].status, 'ok');
  assert.deepEqual(r.rows[0].payload, { patient_code: 'P001', lab_date: '2025-01-01', lab_test_code: 'IGA', result_text: '阴性' }, '定性结果不提交单位');
  assert.ok(r.rows[0].issues.some(i => i.level === 'info' && i.reason.includes('定性结果不需要单位，已忽略单位')));
  // 数值：提交原始文本；范围、指数与数据库一致。
  const valueStatus = value => labs([lab({ value_raw: value, unit_symbol: 'mg/dL' })]).rows[0];
  assert.equal(valueStatus('1.10').payload.value_raw, '1.10', '数值按原文提交');
  for (const ok of ['999999999999', '-5', '+.5', '1e3', '1E-3', '0', '1.', '0.000001e12']) assert.equal(valueStatus(ok).status, 'ok', `value_raw ${ok}`);
  for (const bad of ['1e20', '1000000000000', '-1000000000000', '1e1000', '1e12', 'Infinity', 'NaN', '0x10', '1,000', '1 000', '5mg']) assert.equal(valueStatus(bad).status, 'block', `value_raw ${bad}`);
  assert.ok(valueStatus('1e20').issues.some(i => i.reason.includes('超出允许范围')));
  const MED_COLS = ['patient_code', 'drug_name', 'dose_value', 'dose_unit', 'start_date', 'notes'];
  const med = (over = {}) => ({ patient_code: 'P001', drug_name: '缬沙坦', dose_value: '80', dose_unit: 'mg', start_date: '2025-01-01', notes: '', ...over });
  const meds = rows => bi.validateBatch('meds', MED_COLS, rows, ctx);
  assert.equal(meds([med({ dose_value: '80.50' })]).rows[0].payload.dose_value, '80.50', '剂量按原文提交');
  for (const ok of ['999999.99', '1e5', '0.001', '+3']) assert.equal(meds([med({ dose_value: ok })]).rows[0].status, 'ok', `dose_value ${ok}`);
  for (const bad of ['1000000', '1e6', '0', '-0', '-1', '0.000', '1e1000', 'abc']) assert.equal(meds([med({ dose_value: bad })]).rows[0].status, 'block', `dose_value ${bad}`);
  assert.ok(meds([med({ dose_value: '1000000' })]).rows[0].issues.some(i => i.reason.includes('小于 1000000')));
  // 文本列中的换行与控制字符（数据库 invalid_text）：备注 / 事件细节可换行，其他列不可；任何列都不能含其他控制字符。
  assert.equal(meds([med({ drug_name: '缬\n沙坦' })]).rows[0].status, 'block', '药物名称不能换行');
  assert.equal(meds([med({ drug_name: '缬\u0001沙坦' })]).rows[0].status, 'block', '药物名称不能含控制字符');
  assert.equal(meds([med({ dose_unit: 'm\tg' })]).rows[0].status, 'block', '剂量单位不能含制表符');
  assert.equal(meds([med({ notes: '第一行\n第二行' })]).rows[0].status, 'ok', '备注可以换行');
  assert.equal(meds([med({ notes: '响铃\u0007' })]).rows[0].status, 'block', '备注不能含其他控制字符');
  assert.equal(labs([lab({ result_text: '阴\r性', lab_test_code: 'IGA' })]).rows[0].status, 'block', '结果文本不能换行');
  assert.equal(meds([med({ drug_name: 'x'.repeat(200) })]).rows[0].status, 'ok', '药物名称上限 200 字（与数据库一致）');
  assert.equal(meds([med({ drug_name: 'x'.repeat(201) })]).rows[0].status, 'block');
  const EVT_COLS = ['patient_code', 'event_type', 'event_date', 'event_detail', 'evidence_source'];
  const evts = rows => bi.validateBatch('events', EVT_COLS, rows, ctx);
  assert.equal(evts([{ patient_code: 'P001', event_type: 'relapse', event_date: '2025-01-01', event_detail: '第一行\n第二行', evidence_source: 'other' }]).rows[0].status, 'ok', '事件细节可以换行');
  // 同一文件内同一业务键：内容相同 → 警告；内容不同（含一行多出备注）→ 两行都阻断。
  r = labs([lab({ value_raw: '1.10', unit_symbol: 'mg/dL' }), lab({ value_raw: '1.1', unit_symbol: 'mg/dL' })]);
  assert.deepEqual(r.rows.map(x => x.status), ['ok', 'warn'], '数值相同的重复行只警告');
  assert.ok(r.rows[1].issues.some(i => i.reason.includes('与第 2 行内容完全相同')));
  r = labs([lab({ value_raw: '1.1', unit_symbol: 'mg/dL' }), lab({ value_raw: '1.1', unit_symbol: 'mg/dL', notes: '复查' })]);
  assert.deepEqual(r.rows.map(x => x.status), ['block', 'block'], '一行多出备注也算内容不同');
  assert.ok(r.rows.every(x => x.issues.some(i => i.level === 'block' && i.reason === bi.DUPLICATE_CONFLICT_REASON)));
  assert.ok(r.rows[0].issues.some(i => i.fix.includes('第 3 行')) && r.rows[1].issues.some(i => i.fix.includes('第 2 行')));
  r = meds([med(), med({ dose_value: '40' }), med({ drug_name: '达格列净' })]);
  assert.deepEqual(r.rows.map(x => x.status), ['block', 'block', 'ok'], '用药业务键：研究编号 + 药物名称 + 起始日期');
  r = evts([{ patient_code: 'P001', event_type: 'relapse', event_date: '2025-01-01', event_detail: '', evidence_source: 'other' }, { patient_code: 'P001', event_type: '复发', event_date: '2025-01-01', event_detail: '', evidence_source: 'medical_record' }]);
  assert.deepEqual(r.rows.map(x => x.status), ['block', 'block'], '终点事件业务键：研究编号 + 事件类型 + 事件日期');
  // 已阻断的行不会提交，不参与重复比较。
  r = labs([lab({ value_raw: '1.1', unit_symbol: 'mg/dL' }), lab({ value_raw: '1.2', unit_symbol: 'mmol/L' })]);
  assert.deepEqual(r.rows.map(x => x.status), ['ok', 'block']);
  assert.ok(!r.rows[0].issues.length);
  // 行号来自解析器（ctx.lines）。
  r = labs([lab({ value_raw: '1', unit_symbol: 'mg/dL' }), lab({ value_raw: 'x', unit_symbol: 'mg/dL', lab_date: '2025-01-02' })], { lines: [2, 7] });
  assert.deepEqual(r.rows.map(x => x.line), [2, 7]);
  assert.deepEqual(bi.buildChunks(r, () => 'id')[0].lines, [2]);
  // 错误报告：疑似个人信息的研究编号留空。
  r = labs([lab({ patient_code: '13812345678', value_raw: '1', unit_symbol: 'mg/dL' })]);
  assert.equal(r.rows[0].status, 'block');
  const piiReport = bi.errorReportCsv(r);
  assert.ok(!piiReport.includes('13812345678'), piiReport);
  assert.ok(piiReport.split('\r\n').some(l => l.startsWith('2,,patient_code,阻断,')), piiReport);
}

async function main() {
  await checkPureHelpers();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ['--no-sandbox'] });
  try {
    const { context, page, mock, pageErrors, dialogs } = await openWorkspace(browser, origin);
    assert.equal(await page.locator('#importControls').isVisible(), true, '负责人可见导入入口');
    assert.equal(await page.locator('#importPiiNotice').isVisible(), true, '上传页显示隐私提示');
    assert.ok((await text(page.locator('#importPiiNotice'))).includes('不得包含姓名、身份证号、手机号、病案号'));
    assert.deepEqual(await page.locator('#importType option').evaluateAll(o => o.map(x => x.value)), ['baseline', 'visits', 'labs', 'meds', 'events', 'biopsies', 'fields']);
    // 入组字段的模板随项目的字段定义生成；本项目没有字段时说明原因，不下载空模板（字段导入见 project-fields-smoke.mjs）。
    await page.selectOption('#importType', 'fields');
    await page.click('#btnDownloadTemplate');
    await eventually(async () => (await toastText(page)).includes('本项目还没有启用的入组字段'), '没有字段时说明原因');

    // 1. 三类模板：UTF-8 BOM、英文表头逐字一致、2–3 行虚构示例；填写说明含中文列说明与隐私提示。
    const HEADERS = {
      labs: ['template_labs_v1.csv', 'patient_code,lab_date,lab_test_code,lab_item_name,value_raw,unit_symbol,result_text,ref_range,abnormal_flag,notes'],
      meds: ['template_meds_v1.csv', 'patient_code,drug_name,drug_class,dose_value,dose_unit,route,frequency,start_date,end_date,indication,notes'],
      events: ['template_events_v1.csv', 'patient_code,event_type,event_date,event_detail,evidence_source,notes'],
      biopsies: ['template_biopsies_v1.csv', 'patient_code,biopsy_date,biopsy_kind,is_index,glomeruli_total,crescent_pct,oxford_m,oxford_e,oxford_s,oxford_t,oxford_c,notes'],
    };
    for (const [kind, [filename, header]] of Object.entries(HEADERS)) {
      await page.selectOption('#importType', kind);
      const file = await download(page, () => page.click('#btnDownloadTemplate'));
      assert.equal(file.name, filename);
      assert.ok(file.text.startsWith('\ufeff'), `${kind} 模板应带 UTF-8 BOM`);
      const lines = file.text.slice(1).split('\r\n');
      assert.equal(lines[0], header, `${kind} 模板表头逐字一致`);
      assert.ok(lines.length >= 3 && lines.length <= 4, `${kind} 模板含 2–3 行示例`);
      assert.ok(lines.slice(1).every(l => l.split(',').length === header.split(',').length && l.startsWith('DEMO-')), `${kind} 示例行列数一致且为虚构编号`);
      await page.click('#btnImportHelp');
      const help = await text(page.locator('#importHelp'));
      assert.ok(help.includes('不得包含姓名、身份证号、手机号、病案号') && help.includes('是否必填'), `${kind} 填写说明`);
      for (const col of header.split(',')) assert.ok(help.includes(col), `${kind} 填写说明应列出 ${col}`);
      await page.click('#btnImportHelp');
      assert.equal(await page.locator('#importHelp').isVisible(), false);
    }
    assert.equal(await page.locator('#importUnitsConfirmRow').isVisible(), false, '新类型不显示基线/随访单位确认');

    // 2. 化验：别名映射、单位校验、两级校验与计数、未映射清单手动映射。
    await page.selectOption('#importType', 'labs');
    const LAB_HEADER = HEADERS.labs[1];
    const labLines = [LAB_HEADER,
      'P001,2025-06-01,,Scr,88,μmol/L,,,,',                    // 2 名称别名 → CREAT
      'P001,2025-06-01,eGFR,,60,mL/min/1.73m2,,,,',            // 3 编码大小写 → EGFR，单位写法统一
      'P003,2025-06-01,,尿蛋白肌酐比,500,mg/g,,,,',             // 4 → UPCR，将自动换算
      'P001,2025-06-01,XYZ1,神秘指标Q,3,U/L,,,,SENTINEL-A',     // 5 未映射
      'P001,2025-06-02,CREAT,,1.0,mmol/L,,,,',                 // 6 单位不允许
      'P999,2025-06-01,HGB,,120,g/L,,,,',                      // 7 患者不存在
      'P001,2099-01-01,HGB,,120,g/L,,,,',                      // 8 日期晚于今天
      'P001,2025-06-03,ALB,,40,g/L,,35-55,H,',                 // 9 警告：异常标志与参考范围不一致
      'P002,2025-06-01,IGA,,2.1,g/L,,,,',                      // 10 警告：患者已死亡
      'P001,2025-06-04,CREAT,,abc,μmol/L,,,,SENTINEL-B',       // 11 数值非数值
      'P003,2025-06-05,IGA,,,,阴性,,N,',                        // 12 定性结果
      `P001,2025-06-06,,${X('labname')},1,U/L,,,,${X('labnote')}`, // 13 恶意内容，未映射
    ];
    const labBuffer = Buffer.from('\ufeff' + labLines.join('\r\n'), 'utf8');
    await page.setInputFiles('#importFile', { name: 'labs-oct.csv', mimeType: 'text/csv', buffer: labBuffer });
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    assert.deepEqual(await counts(page), { total: 12, writable: 6, warn: 2, block: 6 });
    const rowText = async line => text(page.locator(`#importTable tr[data-line="${line}"]`));
    assert.match(await page.locator('#importTable tr[data-line="6"]').getAttribute('class'), /bi-row-block/, '阻断行标红');
    assert.ok((await rowText(6)).includes('单位不在该化验项目允许的单位中') && (await rowText(6)).includes('可选单位：mg/dL、μmol/L、umol/L'), await rowText(6));
    assert.ok((await rowText(4)).includes('将自动换算为 g/g'), '允许但非标准单位给换算提示');
    assert.match(await page.locator('#importTable tr[data-line="4"]').getAttribute('class'), /bi-row-ok/, '换算提示不是警告');
    assert.ok((await rowText(7)).includes('本项目中没有该研究编号'));
    assert.ok((await rowText(8)).includes('晚于今天'));
    assert.ok((await rowText(9)).includes('异常标志与参考范围不一致'));
    assert.ok((await rowText(10)).includes('随访状态为死亡'));
    assert.ok((await rowText(11)).includes('结果数值不是数字'));
    assert.equal(await page.locator('#importUnmapped select[data-unmapped-index]').count(), 2, '两个未映射项目');
    assert.ok((await text(page.locator('#importUnmapped'))).includes('神秘指标Q'));
    // 错误报告：列固定，只含行号与研究编号，不含其他单元格内容。
    const report = await download(page, () => page.click('#btnDownloadImportErrors'));
    assert.ok(report.text.startsWith('\ufeff'), '错误报告带 BOM');
    const reportLines = report.text.slice(1).split('\r\n');
    assert.equal(reportLines[0], '行号,patient_code,出错列,级别,原因,修正建议');
    assert.ok(reportLines.some(l => l.startsWith('7,P999,patient_code,阻断,')), '报告含行号与研究编号');
    assert.ok(reportLines.some(l => l.startsWith('9,P001,abnormal_flag,警告,')), '报告含警告行');
    assert.ok(reportLines.at(-1).includes('不得包含姓名、身份证号、手机号、病案号'), '报告含隐私提示');
    for (const secret of ['神秘指标Q', 'XYZ1', 'SENTINEL', 'abc', 'mmol/L,', '2099', '<img', 'Scr', '35-55']) assert.ok(!report.text.includes(secret), `错误报告不应包含单元格内容：${secret}`);
    // 有警告时须勾选“已核对警告”。
    assert.equal(await page.locator('#importWarnConfirmRow').isVisible(), true);
    await page.click('#btnConfirmImport');
    await eventually(async () => (await toastText(page)).includes('已核对警告'), '未勾选警告时应提示');
    assert.equal(mock.rpcCalls('import_registry_rows').length, 0, '未核对警告时不提交');
    // 手动映射：XYZ1 → ALT；恶意名称 → 不导入。校验结果变化后“已核对警告”须重新勾选。
    await page.check('#importWarnConfirm');
    await page.selectOption('#importUnmapped select[data-unmapped-index="0"]', 'ALT');
    await eventually(async () => (await counts(page)).writable === 7, '映射后可写入行增加');
    assert.equal(await page.locator('#importWarnConfirm').isChecked(), false, '校验结果变化后取消“已核对警告”');
    await page.selectOption('#importUnmapped select[data-unmapped-index="1"]', '__skip__');
    await eventually(async () => (await counts(page)).block === 4, '标记不导入后不再计为阻断');
    assert.match(await page.locator('#importTable tr[data-line="13"]').getAttribute('class'), /bi-row-ignored/);
    await page.check('#importWarnConfirm');
    await page.click('#btnConfirmImport');
    await eventually(() => mock.rpcCalls('register_import_file').length === 1, '提交后应登记文件信息');
    const labCall = mock.rpcCalls('import_registry_rows')[0].body;
    assert.equal(labCall.p_kind, 'labs');
    assert.match(labCall.p_batch_id, UUID_V4);
    assert.deepEqual(labCall.p_rows, [
      { patient_code: 'P001', lab_date: '2025-06-01', lab_test_code: 'CREAT', value_raw: '88', unit_symbol: 'μmol/L' },
      { patient_code: 'P001', lab_date: '2025-06-01', lab_test_code: 'EGFR', value_raw: '60', unit_symbol: 'mL/min/1.73m²' },
      { patient_code: 'P003', lab_date: '2025-06-01', lab_test_code: 'UPCR', value_raw: '500', unit_symbol: 'mg/g' },
      { patient_code: 'P001', lab_date: '2025-06-01', lab_test_code: 'ALT', value_raw: '3', unit_symbol: 'U/L', notes: 'SENTINEL-A' },
      { patient_code: 'P001', lab_date: '2025-06-03', lab_test_code: 'ALB', value_raw: '40', unit_symbol: 'g/L', ref_range: '35-55', abnormal_flag: 'H' },
      { patient_code: 'P002', lab_date: '2025-06-01', lab_test_code: 'IGA', value_raw: '2.1', unit_symbol: 'g/L' },
      { patient_code: 'P003', lab_date: '2025-06-05', lab_test_code: 'IGA', result_text: '阴性', abnormal_flag: 'N' },
    ], '只提交可写入行，化验名称列不写入');
    assert.deepEqual(mock.rpcCalls('register_import_file')[0].body, { p_project_id: PROJECT.id, p_batch_id: labCall.p_batch_id, p_file_sha256: sha256(labBuffer), p_file_name: 'labs-oct.csv', p_chunk_index: 1, p_chunk_total: 1 });
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('导入完成'), '应显示结果页');
    assert.ok((await text(page.locator('#importResult'))).includes('新增 7'));
    assert.ok(dialogs.some(d => d.includes('阻断的 4 行不会写入')), '确认框说明阻断行不写入');

    // 2b. 物理行号（空行、引号内换行）、定性结果的单位、同一文件内重复业务键、疑似个人信息的研究编号、数值范围、文本换行。
    const lab2Lines = [LAB_HEADER,
      'P001,2025-07-01,IGA,,,g/L,阴性,,,',                      // 2 定性结果填了单位：忽略单位
      '',                                                       // 3 空行
      'P001,2025-07-02,CREAT,,1.10,μmol/L,,,,"多行\n备注"',     // 4–5 备注含换行
      'P001,2025-07-03,CREAT,,90,μmol/L,,,,',                   // 6 与第 7 行业务键相同、内容不同
      'P001,2025-07-03,CREAT,,90,μmol/L,,,,补充',               // 7
      'P003,2025-07-04,HGB,,120,g/L,,,,',                       // 8
      'P003,2025-07-04,HGB,,120.0,g/L,,,,',                     // 9 与第 8 行内容相同：警告
      '13812345678,2025-07-05,HGB,,120,g/L,,,,',                // 10 研究编号疑似手机号
      'P001,2025-07-06,HGB,,1e20,g/L,,,,',                      // 11 超出数据库范围
      'P001,2025-07-07,HGB,,120,g/L,"阴\n性",,,',               // 12–13 结果文本含换行
      'P001,2025-07-08,HGB,,121,g/L,,,,',                       // 14
    ];
    await page.setInputFiles('#importFile', csvFile('labs-lines.csv', lab2Lines));
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    assert.deepEqual(await counts(page), { total: 10, writable: 5, warn: 1, block: 5 });
    assert.deepEqual(await page.locator('#importTable tr[data-line]').evaluateAll(t => t.map(x => Number(x.dataset.line))), [2, 4, 6, 7, 8, 9, 10, 11, 12, 14], '预览行号为物理行号');
    assert.match(await page.locator('#importTable tr[data-line="2"]').getAttribute('class'), /bi-row-ok/, '定性结果填了单位不阻断');
    assert.ok((await rowText(2)).includes('定性结果不需要单位，已忽略单位'));
    for (const line of [6, 7]) {
      assert.match(await page.locator(`#importTable tr[data-line="${line}"]`).getAttribute('class'), /bi-row-block/);
      assert.ok((await rowText(line)).includes('同一文件内同一业务键有两行内容不同，请合并为一行'), await rowText(line));
    }
    assert.match(await page.locator('#importTable tr[data-line="9"]').getAttribute('class'), /bi-row-warn/);
    assert.ok((await rowText(9)).includes('与第 8 行内容完全相同'));
    assert.ok(!(await rowText(10)).includes('13812345678') && (await rowText(10)).includes('****'), '疑似个人信息的研究编号在预览中遮盖');
    assert.ok((await rowText(11)).includes('超出允许范围'));
    assert.ok((await rowText(12)).includes('换行'));
    const report2 = await download(page, () => page.click('#btnDownloadImportErrors'));
    const report2Lines = report2.text.slice(1).split('\r\n');
    assert.ok(!report2.text.includes('13812345678'), '错误报告不含疑似个人信息的研究编号');
    assert.ok(report2Lines.some(l => l.startsWith('10,,patient_code,阻断,')), '该行研究编号留空');
    for (const line of [6, 7, 11, 12]) assert.ok(report2Lines.some(l => l.startsWith(`${line},P001,`)), `错误报告第 ${line} 行`);
    assert.ok(report2Lines.some(l => l.startsWith('9,P003,patient_code,警告,')));
    await page.check('#importWarnConfirm');
    const i2b = mock.rpcCalls('import_registry_rows').length;
    mock.importReplies.push({ postgrestError: { code: 'P0001', message: 'row_2_unit_not_allowed: unit_symbol', details: null, hint: null } });
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('导入未全部完成'), '数据库拒绝时报告');
    assert.ok((await text(page.locator('#importResult'))).includes('第 4 行'), '数据库错误按物理行号显示');
    assert.deepEqual(mock.rpcCalls('import_registry_rows')[i2b].body.p_rows, [
      { patient_code: 'P001', lab_date: '2025-07-01', lab_test_code: 'IGA', result_text: '阴性' },
      { patient_code: 'P001', lab_date: '2025-07-02', lab_test_code: 'CREAT', value_raw: '1.10', unit_symbol: 'μmol/L', notes: '多行\n备注' },
      { patient_code: 'P003', lab_date: '2025-07-04', lab_test_code: 'HGB', value_raw: '120', unit_symbol: 'g/L' },
      { patient_code: 'P003', lab_date: '2025-07-04', lab_test_code: 'HGB', value_raw: '120.0', unit_symbol: 'g/L' },
      { patient_code: 'P001', lab_date: '2025-07-08', lab_test_code: 'HGB', value_raw: '121', unit_symbol: 'g/L' },
    ], '定性结果不带单位；数值按原文提交');
    await page.click('#btnCancelImport');

    // 3. 终点事件：派生终点阻断、死亡 + 在访患者给警告、“其他”须填细节。
    await page.selectOption('#importType', 'events');
    await page.setInputFiles('#importFile', csvFile('events.csv', [HEADERS.events[1],
      'P001,egfr_decline_40pct,2025-03-01,,lab_review,',
      'P001,complete_remission,2025-03-01,,medical_record,',
      'P001,death,2025-04-01,,death_certificate,',
      'P003,custom,2025-04-01,,phone_followup,',
      'P003,开始透析,2025-05-01,血液透析,病历记录,',
      'P003,lost_followup,2025-05-02,,other,',
      'P001,relapse,2023-12-01,,medical_record,',
      'P003,严重感染,2025-05-03,,medical_record,',
      'P003,住院,2025-05-04,肺炎住院 6 天,病历记录,',
      'P003,疫苗接种,2025-05-05,四价脑膜炎球菌结合疫苗,medical_record,']));
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    assert.deepEqual(await counts(page), { total: 10, writable: 4, warn: 3, block: 6 });
    assert.ok((await rowText(2)).includes('不接受导入') && (await rowText(3)).includes('不接受导入'), '派生终点阻断');
    assert.ok((await rowText(4)).includes('请到该患者的研究状态登记'), '死亡事件 + 在访患者给警告');
    assert.match(await page.locator('#importTable tr[data-line="4"]').getAttribute('class'), /bi-row-warn/);
    assert.ok((await rowText(5)).includes('须填写事件细节'));
    assert.ok((await rowText(6)).includes('请到该患者的研究状态登记'), '开始透析也提示登记研究状态');
    assert.ok((await rowText(7)).includes('改用 custom'));
    assert.ok((await rowText(8)).includes('早于该患者的基线日期'));
    assert.ok((await rowText(9)).includes('严重感染和住院须在事件细节中写明'), '严重感染须填细节');
    assert.match(await page.locator('#importTable tr[data-line="10"]').getAttribute('class'), /bi-row-ok/, '中文“住院”可导入');
    assert.ok((await rowText(11)).includes('疫苗接种改为在用药记录中登记'), '疫苗接种不再作为终点事件导入');
    await page.click('#btnCancelImport');

    // 3b. 肾活检记录：中文取值、牛津分型 C 与新月体比例一致、同一患者文件内两次基准活检、系统中已有基准活检、整数与日期规则。
    await page.selectOption('#importType', 'biopsies');
    const BX_HEADER = HEADERS.biopsies[1];
    const bxBuffer = Buffer.from('\ufeff' + [BX_HEADER,
      'P001,2024-01-10,自体肾,是,24,8.3,1,0,1,0,1,确诊活检',   // 2 可写入
      'P001,2025-02-01,native,false,18,30,1,0,1,1,1,',            // 3 C1 与 30% 不一致
      'P003,2024-03-03,移植肾,true,15,,,,,,,',                     // 4 P003 两次基准活检
      'P003,2024-04-04,native,true,,,,,,,,',                       // 5
      'P001,2099-12-01,native,,,,,,,,,',                           // 6 未来日期
      'P001,2025-06-01,other,,,,,,,,,',                            // 7 类型无效
      'P001,2025-07-01,native,,12.0,,,,,,,',                       // 8 肾小球数须为整数
      'P002,2025-08-01,native,true,,,,,,,,',                       // 9 系统中已有另一次基准活检
      'P001,2025-09-01,transplant,否,,0,,,,,0,重复活检',           // 10 可写入
    ].join('\r\n'), 'utf8');
    await page.setInputFiles('#importFile', { name: 'biopsies.csv', mimeType: 'text/csv', buffer: bxBuffer });
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    assert.deepEqual(await counts(page), { total: 9, writable: 2, warn: 0, block: 7 });
    assert.ok((await rowText(3)).includes('牛津分型 C 与新月体比例不一致'), await rowText(3));
    for (const line of [4, 5]) assert.ok((await rowText(line)).includes('同一患者在文件中有多次活检标为基准活检'), await rowText(line));
    assert.ok((await rowText(6)).includes('晚于今天'));
    assert.ok((await rowText(7)).includes('活检类型不在允许的取值中'));
    assert.ok((await rowText(8)).includes('肾小球总数须为 0–999 的整数'));
    assert.ok((await rowText(9)).includes('系统中已有另一次基准活检'));
    const bxBefore = mock.rpcCalls('import_registry_rows').length;
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('导入完成'), '活检导入应完成');
    const bxCall = mock.rpcCalls('import_registry_rows')[bxBefore].body;
    assert.equal(bxCall.p_kind, 'biopsies');
    assert.deepEqual(bxCall.p_rows, [
      { patient_code: 'P001', biopsy_date: '2024-01-10', biopsy_kind: 'native', is_index: 'true', glomeruli_total: '24', crescent_pct: '8.3', oxford_m: '1', oxford_e: '0', oxford_s: '1', oxford_t: '0', oxford_c: '1', notes: '确诊活检' },
      { patient_code: 'P001', biopsy_date: '2025-09-01', biopsy_kind: 'transplant', is_index: 'false', crescent_pct: '0', oxford_c: '0', notes: '重复活检' },
    ], '只提交可写入行，中文取值换算为代码');
    assert.ok((await text(page.locator('#importResult'))).includes('肾活检记录'));
    assert.equal(mock.requests.filter(r => r.method === 'GET' && r.path === '/rest/v1/biopsies_long' && r.params.get('is_index') === 'eq.true').length, 1, '预览前读取已有基准活检');

    // 4. 表头含个人信息列：整份文件阻断，不能提交。
    await page.selectOption('#importType', 'meds');
    await page.setInputFiles('#importFile', csvFile('meds.csv', ['patient_code,姓名,drug_name,start_date', 'P001,张三,缬沙坦,2025-01-01']));
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    assert.ok((await text(page.locator('#importTable'))).includes('疑似个人信息列'));
    assert.ok(!(await text(page.locator('#importTable'))).includes('张三'), '不显示疑似个人信息的单元格');
    assert.equal((await counts(page)).block, 1);
    assert.equal(await page.locator('#btnConfirmImport').isDisabled(), true, '表头含个人信息时不能提交');
    await page.setInputFiles('#importFile', csvFile('meds.csv', ['patient_code,drug_name,start_date,name', 'P001,缬沙坦,2025-01-01,x']));
    await eventually(async () => (await text(page.locator('#importTable')))?.includes('疑似个人信息列'), '英文 name 列同样阻断');
    // 文件名含 8 位以上连续数字（可能是病案号）：不读取文件。
    const before = mock.requests.length;
    await page.setInputFiles('#importFile', csvFile('meds_20261014.csv', ['patient_code,drug_name,start_date', 'P001,缬沙坦,2025-01-01']));
    await eventually(async () => (await toastText(page)).includes('文件名疑似包含个人信息'), '文件名疑似个人信息时提示重命名');
    assert.equal(mock.requests.length, before);

    // 5. 1203 行用药：分 3 块依次提交，每块一个新批次，均登记同一文件 SHA-256。
    const MED_HEADER = HEADERS.meds[1];
    const bigLines = prefix => [MED_HEADER, ...Array.from({ length: 1203 }, (_, i) => `P00${(i % 3) + 1},${prefix}${i + 1},其他,10,mg,PO,qd,2025-01-01,,,`)];
    const bigBuffer = Buffer.from('\ufeff' + bigLines('药A').join('\r\n'), 'utf8');
    await page.setInputFiles('#importFile', { name: 'C:\\fakepath\\meds-big.csv', mimeType: 'text/csv', buffer: bigBuffer });
    await eventually(async () => (await counts(page)).writable === 1203, '1203 行均可写入');
    const importsBefore = mock.rpcCalls('import_registry_rows').length;
    const regsBefore = mock.rpcCalls('register_import_file').length;
    await page.click('#btnConfirmImport');
    await eventually(() => mock.rpcCalls('register_import_file').length === regsBefore + 3, '3 块均应登记文件信息', 15000);
    const bigCalls = mock.rpcCalls('import_registry_rows').slice(importsBefore).map(r => r.body);
    assert.deepEqual(bigCalls.map(c => c.p_rows.length), [500, 500, 203]);
    assert.equal(new Set(bigCalls.map(c => c.p_batch_id)).size, 3, '每块一个新批次编号');
    assert.deepEqual(bigCalls[0].p_rows[0], { patient_code: 'P001', drug_name: '药A1', drug_class: '其他', dose_value: '10', dose_unit: 'mg', route: 'PO', frequency: 'qd', start_date: '2025-01-01' });
    const regs = mock.rpcCalls('register_import_file').slice(regsBefore).map(r => r.body);
    assert.deepEqual(regs.map(r => [r.p_batch_id, r.p_chunk_index, r.p_chunk_total]), bigCalls.map((c, i) => [c.p_batch_id, i + 1, 3]));
    assert.ok(regs.every(r => r.p_file_sha256 === sha256(bigBuffer) && r.p_file_name === 'meds-big.csv'), '各块文件 SHA-256 相同，文件名去掉路径');
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('共 3 块'), '结果页列出 3 块');

    // 6. 某块失败：停止后续块并报告；网络失败重试沿用同一批次编号。
    await page.setInputFiles('#importFile', csvFile('meds-big2.csv', bigLines('药B')));
    await eventually(async () => (await counts(page)).writable === 1203, '第二个文件预览');
    const i2 = mock.rpcCalls('import_registry_rows').length;
    mock.importReplies.push({}, { postgrestError: { code: 'P0001', message: 'row_7_same_key_record_conflict', details: null, hint: '同一患者同一业务键已有不同数据，请先在记录纠错中核实' } });
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('导入未全部完成'), '失败后结果页报告');
    await page.waitForTimeout(300);
    assert.equal(mock.rpcCalls('import_registry_rows').length, i2 + 2, '第 2 块失败后不再提交第 3 块');
    const resultText = await text(page.locator('#importResult'));
    assert.ok(resultText.includes('成功 1/3 块') && resultText.includes('第 508 行') && resultText.includes('已有不同数据'), resultText);
    assert.ok(resultText.includes('未提交'), '第 3 块显示未提交');
    assert.ok((await text(page.locator('#importProgress'))).includes('已停止提交后续块'));
    await page.click('#btnCancelImport');

    await page.setInputFiles('#importFile', csvFile('meds-small.csv', [MED_HEADER, 'P001,缬沙坦,RAS 阻断剂,80,mg,口服,qd,2025-01-01,2024-12-01,降蛋白尿,', 'P001,达格列净,SGLT2抑制剂,10,,PO,qd,2025-01-01,,,', 'P003,泼尼松,激素,30,mg,PO,qd,2025-01-01,,,']));
    await page.locator('#importCounts').waitFor({ state: 'visible' });
    assert.deepEqual(await counts(page), { total: 3, writable: 1, warn: 1, block: 2 });
    assert.ok((await rowText(2)).includes('结束日期早于起始日期'));
    assert.ok((await rowText(3)).includes('只填了其中一项'));
    assert.ok((await rowText(4)).includes('药物类别不在允许的枚举中'));
    await page.check('#importWarnConfirm');
    const i3 = mock.rpcCalls('import_registry_rows').length;
    mock.importReplies.push({ abort: true });
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importProgress')))?.includes('重试未完成的块'), '网络失败应提示重试');
    assert.ok((await text(page.locator('#importResult'))).includes('网络连接失败'));
    assert.equal(await text(page.locator('#btnConfirmImport')), '重试未完成的块');
    mock.importReplies.push({ replayed: true });
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importResult')))?.includes('导入完成'), '重试后完成');
    const [failed, retried] = mock.rpcCalls('import_registry_rows').slice(i3).map(r => r.body);
    assert.equal(retried.p_batch_id, failed.p_batch_id, '网络失败重试沿用同一批次编号');
    assert.deepEqual(retried.p_rows, [{ patient_code: 'P001', drug_name: '达格列净', drug_class: 'SGLT2抑制剂', dose_value: '10', route: 'PO', frequency: 'qd', start_date: '2025-01-01' }]);

    // 7. 导入记录与撤销：数据库返回值只作为文字显示；撤销须填写原因；基线批次不能撤销。
    await page.click('#importBatchesDetails summary');
    await page.locator('#importBatchesList tr[data-batch-row="0"]').waitFor();
    const listText = await text(page.locator('#importBatchesList'));
    assert.ok(listText.includes('化验记录') && listText.includes('患者基线') && listText.includes('已撤销') && listText.includes('2/3'), listText);
    assert.ok(listText.includes('<img src=x'), '恶意文件名按文字显示');
    assert.equal(await page.locator('#importBatchesList img').count(), 0);
    assert.equal(await page.locator('#importBatchesList [data-undo-index]').count(), 3, '只有未撤销、支持撤销的非基线批次可撤销');
    assert.ok((await text(page.locator('#importBatchesList tr[data-batch-row="5"]'))).includes('入组字段'));
    assert.equal(await page.locator('#importBatchesList tr[data-batch-row="5"] [data-undo-index]').count(), 1, '入组字段批次可以撤销');
    assert.ok((await text(page.locator('#importBatchesList tr[data-batch-row="4"]'))).includes('肾活检记录'));
    assert.equal(await page.locator('#importBatchesList tr[data-batch-row="4"] [data-undo-index]').count(), 1, '肾活检记录批次可以撤销');
    assert.equal(await page.locator('#importBatchesList tr[data-batch-row="3"] [data-undo-index]').count(), 0, '0040 之前的批次不显示撤销按钮');
    assert.ok((await text(page.locator('#importBatchesList tr[data-batch-row="3"]'))).includes('该批次导入于支持撤销之前，不能自动撤销'));
    await page.click('#importBatchesList [data-undo-index="0"]');
    await page.locator('#importUndoForm').waitFor({ state: 'visible' });
    await page.click('#btnConfirmUndoBatch');
    assert.ok((await text(page.locator('#importUndoResult'))).includes('2–500 字'), '原因必填');
    assert.equal(mock.rpcCalls('undo_import_batch').length, 0);
    await page.fill('#importUndoReason', '电话13812345678');
    await page.click('#btnConfirmUndoBatch');
    assert.ok((await text(page.locator('#importUndoResult'))).includes('个人身份信息'));
    await page.fill('#importUndoReason', '化验日期整列错位，撤销后重新导入');
    await page.click('#btnConfirmUndoBatch');
    await eventually(() => mock.rpcCalls('undo_import_batch').length === 1, '没有提交撤销');
    assert.deepEqual(mock.rpcCalls('undo_import_batch')[0].body, { p_project_id: PROJECT.id, p_batch_id: BATCHES[0].batch_id, p_reason: '化验日期整列错位，撤销后重新导入' });
    await eventually(async () => (await text(page.locator('#importUndoResult')))?.includes('删除 5 条'), '应显示撤销结果');
    assert.ok((await text(page.locator('#importUndoResult'))).includes('保留 2 条'));
    assert.ok((await text(page.locator('#importUndoResult'))).includes('因其他批次引用而保留 1 条'), '显示因其他批次引用而保留的记录数');

    // 8. 手工录入：终点事件新增类型与判定依据来源；用药剂量数值 + 单位、用药目的、备注。
    await page.fill('#evtPatientCode', 'P003');
    await page.selectOption('#evtType', 'dialysis_start');
    await page.click('#btnAddEvent');
    await eventually(async () => (await toastText(page)).includes('请选择判定依据来源'), '判定依据来源必填');
    assert.equal(mock.requests.filter(r => r.method === 'POST' && r.path === '/rest/v1/events_long').length, 0);
    await page.selectOption('#evtEvidence', 'medical_record');
    await page.fill('#evtDetail', '维持性血液透析');
    await page.fill('#evtDate', '2025-05-01');
    await page.click('#btnAddEvent');
    await eventually(() => mock.requests.some(r => r.method === 'POST' && r.path === '/rest/v1/events_long'), '没有提交终点事件');
    const evt = mock.requests.find(r => r.method === 'POST' && r.path === '/rest/v1/events_long').body;
    assert.deepEqual({ ...evt }, { project_id: PROJECT.id, patient_code: 'P003', event_type: 'dialysis_start', event_date: '2025-05-01', confirmed: true, source: 'manual', evidence_source: 'medical_record', event_detail: '维持性血液透析', notes: null });
    const evtOptions = await page.locator('#evtType option').evaluateAll(o => o.map(x => x.value));
    for (const v of ['dialysis_start', 'kidney_transplant', 'relapse', 'egfr_decline_40pct', 'egfr_decline_57pct']) assert.ok(evtOptions.includes(v), v);
    assert.ok(!evtOptions.some(v => v.includes('50')), '不新增 ≥50%');
    assert.ok((await page.locator('#evtType option[value="egfr_decline_40pct"]').textContent()).includes('建议由分析脚本按研究方案计算'));
    await page.fill('#medPatientCode', 'P001');
    await page.fill('#medName', '缬沙坦');
    await page.selectOption('#medClass', 'RAS阻断剂');
    await page.fill('#medDoseValue', '80');
    await page.fill('#medDoseUnit', 'mg');
    await page.fill('#medStart', '2025-01-01');
    await page.fill('#medIndication', '降蛋白尿');
    await page.fill('#medNotes', '耐受良好');
    await page.click('#btnAddMed');
    await eventually(() => mock.requests.some(r => r.method === 'POST' && r.path === '/rest/v1/meds_long'), '没有提交用药');
    const med = mock.requests.find(r => r.method === 'POST' && r.path === '/rest/v1/meds_long').body;
    assert.deepEqual({ ...med }, { project_id: PROJECT.id, patient_code: 'P001', drug_name: '缬沙坦', drug_class: 'RAS阻断剂', dose: '80 mg', dose_value: 80, dose_unit: 'mg', route: null, frequency: null, start_date: '2025-01-01', end_date: null, indication: '降蛋白尿', notes: '耐受良好' });

    // 恶意内容（CSV 单元格、未映射名称、导入记录）均未执行。
    assert.equal(await page.evaluate(() => window.__xss), undefined, '恶意内容不得执行');
    assert.deepEqual(pageErrors, [], '页面不应有未捕获异常');
    assert.deepEqual(mock.external, [], '不应请求 Supabase 以外的外部主机');
    assert.deepEqual(mock.unknown, [], '不应调用未模拟的接口');
    await context.close();

    // 9. 只读 / 分析协作人：不显示导入入口，仍可查看导入记录但不能撤销。
    for (const access of [VIEWER, ANALYST]) {
      const w = await openWorkspace(browser, origin, { access });
      assert.equal(await w.page.locator('#importControls').isVisible(), false, `${access.role} 不显示导入入口`);
      assert.equal(await w.page.locator('#importType').isVisible(), false);
      assert.equal(await w.page.locator('#btnDownloadTemplate').isVisible(), false);
      assert.equal(await w.page.locator('#importReadonlyNote').isVisible(), true);
      await w.page.click('#importBatchesDetails summary');
      await w.page.locator('#importBatchesList tr[data-batch-row="0"]').waitFor();
      assert.equal(await w.page.locator('#importBatchesList [data-undo-index]').count(), 0, `${access.role} 不能撤销`);
      assert.equal(await w.page.evaluate(() => window.__xss), undefined);
      assert.deepEqual(w.pageErrors, []);
      assert.deepEqual(w.mock.unknown, []);
      await w.context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('BATCH_IMPORT_UI_OK');
}

main().catch(error => { console.error(error); process.exit(1); });
