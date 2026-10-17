// 随访看板批量操作与链接整理的浏览器冒烟测试（合成数据，不连接任何真实数据库）。
// 运行：node tests/ui/board-actions-smoke.mjs   成功时打印 BOARD_ACTIONS_UI_OK。
// 与 staff-smoke.mjs 相同的方式：本地静态服务器提供 site/，Playwright 打开 staff.html，
// 对 Supabase 域名的请求用 page.route 返回合成数据；其他外部主机的请求一律拦截并记为失败。
// 覆盖：勾选患者、批量设置提醒起算日、批量确认知情同意、生成新链接时作废旧链接、
// “作废除最新一个以外的全部有效链接”、有效链接过多的提示、只读角色看不到批量操作。
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
const dayOffset = days => { const d = new Date(); d.setDate(d.getDate() + days); return isoDay(d); };
const tsOffset = days => new Date(Date.now() + days * 86400000).toISOString();
const USER = { id: '00000000-0000-4000-8000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: 'pi.synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const PROJECT = { id: '10000000-0000-4000-8000-000000000001', name: '合成测试队列', center_code: 'TST01', module: 'IGAN', registry_type: 'igan', description: null, created_by: USER.id, created_at: '2026-02-01T00:00:00Z', followup_interval_days: 90, public_title: '合成随访研究', institution_name: '测试医院肾内科', ethics_approval_no: 'TEST-2026-001', contact_display: '研究护士 测试老师' };
const OWNER = { role: 'owner', can_read: true, can_write: true, can_export: true, can_manage_tokens: true, can_manage_members: true, can_manage_project: true, write_block_reason: null };
const EDITOR = { ...OWNER, role: 'editor', can_manage_members: false, can_manage_project: false, can_export: false };
const VIEWER = { role: 'viewer', can_read: true, can_write: false, can_export: false, can_manage_tokens: false, can_manage_members: false, can_manage_project: false, write_block_reason: 'role_read_only' };
const OVERVIEW = { project_id: PROJECT.id, followup_interval_days: 90, n_patients: 6, n_active: 5, n_visits: 3, n_visits_30d: 1, n_core_complete_visits: 1, core_completeness: 0.33, n_overdue: 2, n_due_soon: 0, n_no_visit: 0, last_visit_date: dayOffset(-20), n_consent_confirmed: 0, n_consent_unconfirmed: 6, n_open_issues: 0 };
const row = (id, code, extra) => ({ project_id: PROJECT.id, patient_id: `20000000-0000-4000-8000-00000000000${id}`, center_code: 'TST01', patient_code: code, baseline_date: dayOffset(-400), consent_status: 'unconfirmed', followup_status: 'active', visit_count: 1, first_visit_date: dayOffset(-300), last_visit_date: dayOffset(-300), days_since_last_visit: 300, next_due_date: dayOffset(-210), followup_state: 'overdue', active_link_count: 0, last_link_created_at: null, last_link_expires_at: null, last_patient_submission_at: null, followup_start_date: null, ...extra });
const initialBoard = () => [
  // 历史补录：基线 2014 年，按基线日期计算已逾期四千多天。
  row(1, 'H001', { baseline_date: '2014-03-01', visit_count: 0, first_visit_date: null, last_visit_date: null, days_since_last_visit: null, next_due_date: '2014-05-30' }),
  row(2, 'H002', { baseline_date: '2014-05-01', last_visit_date: '2015-06-01', days_since_last_visit: 4000, next_due_date: '2015-08-30' }),
  row(3, 'P003', { followup_start_date: dayOffset(-20), next_due_date: dayOffset(70), followup_state: 'ok', last_visit_date: '2015-01-01' }),
  row(4, 'L004', { active_link_count: 3, last_link_created_at: tsOffset(-1), last_link_expires_at: tsOffset(29) }),
  row(5, 'L005', { active_link_count: 2 }),
  row(6, 'D006', { followup_status: 'deceased', followup_state: 'inactive' }),
];
const token = (n, code, extra) => ({ id: `30000000-0000-4000-8000-0000000000${pad(n)}`, project_id: PROJECT.id, patient_code: code, active: true, single_use: false, used_at: null, revoked_at: null, revoke_reason: null, created_at: tsOffset(-n), expires_at: tsOffset(30 - n), ...extra });
const initialTokens = () => [
  token(1, 'L004'), token(2, 'L004'), token(3, 'L004'), token(4, 'L004', { active: false, revoked_at: tsOffset(-3), revoke_reason: '发错对象' }),
  token(5, 'L005'), token(6, 'L005'),
];
const NEW_TOKEN = 'b1b2c3d4e5f60718293a4b5c6d7e8f90';
const REVOKE_OLD_REASON = '已生成新链接，作废此前仍有效的链接';
const KEEP_NEWEST_REASON = '整理链接：保留最新一条，作废其余有效链接';

// ── 本地静态服务器 ──────────────────────────────────────────
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
  const board = initialBoard(); const tokens = initialTokens();
  const errors = {};   // RPC 名 → 下一次调用返回的 PostgREST 错误
  let created = 0;
  const cors = origin => ({ 'access-control-allow-origin': origin || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range,x-total-count' });
  const filters = (url, op) => Object.fromEntries([...url.searchParams].filter(([, v]) => v.startsWith(`${op}.`)).map(([k, v]) => [k, v.slice(op.length + 1)]));
  function restRows(table, url) {
    const f = filters(url, 'eq'); const gt = filters(url, 'gt');
    switch (table) {
      case 'projects': return [PROJECT];
      case 'v_project_overview': return [OVERVIEW];
      case 'v_patient_followup_status': {
        let rows = board.filter(r => !f.patient_code || r.patient_code === f.patient_code);
        if (gt.patient_id) rows = rows.filter(r => r.patient_id > gt.patient_id);
        return rows;
      }
      case 'patient_tokens': return tokens.filter(t => !f.patient_code || t.patient_code === f.patient_code);
      case 'visits_long': case 'patients_baseline': case 'user_profiles': case 'project_custom_labs': case 'lab_test_catalog': case 'lab_test_unit_map':
      case 'labs_long': case 'meds_long': case 'events_long': case 'variants_long': case 'data_issues':
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
      case 'list_project_snapshots': return [];
      case 'list_import_batches': return [];
      case 'get_issue_summary': return { total_open: 0, total_in_prog: 0, total_resolved: 0, total_wontfix: 0 };
      case 'set_followup_start_date': {
        let changed = 0;
        for (const r of board.filter(x => body.p_patient_codes.includes(x.patient_code))) {
          if (r.followup_start_date !== body.p_start_date) changed++;
          r.followup_start_date = body.p_start_date;
          if (body.p_start_date) { r.next_due_date = dayOffset(90); r.followup_state = r.visit_count ? 'ok' : 'no_visit'; }
        }
        return { requested: body.p_patient_codes.length, changed, unchanged: body.p_patient_codes.length - changed, followup_start_date: body.p_start_date };
      }
      case 'set_consent_bulk': {
        for (const r of board.filter(x => body.p_patient_codes.includes(x.patient_code))) r.consent_status = body.p_status;
        return { requested: body.p_patient_codes.length, changed: body.p_patient_codes.length, unchanged: 0, consent_status: body.p_status };
      }
      case 'create_patient_token_v2': {
        created += 1;
        tokens.unshift(token(50 + created, body.p_patient_code, { created_at: new Date().toISOString(), expires_at: tsOffset(body.p_expires_in_days), single_use: body.p_single_use }));
        return NEW_TOKEN;
      }
      case 'revoke_patient_token_by_id': {
        const t = tokens.find(x => x.id === body.p_token_id);
        if (t) Object.assign(t, { active: false, revoked_at: new Date().toISOString(), revoke_reason: body.p_reason });
        return null;
      }
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
      const value = rpc(rpcName, body || {});
      return value === null && rpcName === 'revoke_patient_token_by_id' ? settle(route.fulfill({ status: 204, headers })) : json(200, value);
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z0-9_]+)$/)?.[1];
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
  return { requests, external, unknown, board, tokens, errors, handle, rpcCalls: name => requests.filter(r => r.path === `/rest/v1/rpc/${name}`) };
}

async function openWorkspace(browser, origin, { access = OWNER, viewport = { width: 1280, height: 900 } } = {}) {
  const mock = createMock({ access });
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'zh-CN' });
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
const boardReads = mock => mock.requests.filter(r => r.path === '/rest/v1/v_patient_followup_status');
const fullBoardReads = mock => boardReads(mock).filter(r => !r.params.get('patient_code'));
const checkbox = (page, code) => page.locator(`tr[data-patient-code="${code}"] input[data-select-code]`);

async function checkPureHelpers() {
  const board = await loadModule('lib/followup-board.js');
  const data = await loadModule('lib/registry-data.js');
  assert.equal(board.linkCountWarning(3), '有效链接较多，建议作废不用的链接');
  assert.equal(board.linkCountWarning(2), '');
  assert.equal(board.linkCountWarning(null), '');
  assert.equal(board.dueBasisText({ followup_start_date: '2026-10-01', last_visit_date: '2015-01-01' }), '按提醒起算日 2026-10-01 计算');
  assert.equal(board.dueBasisText({ followup_start_date: '2026-10-01', last_visit_date: null, baseline_date: '2014-01-01' }), '按提醒起算日 2026-10-01 计算');
  assert.equal(board.dueBasisText({ followup_start_date: '2026-01-01', last_visit_date: '2026-05-01' }), '按最近随访 2026-05-01 计算（提醒起算日 2026-01-01 早于最近随访）');
  assert.equal(board.dueBasisText({ baseline_date: '2014-01-01' }), '按基线日期 2014-01-01 计算');
  const html = board.renderBoardRow(initialBoard()[3], { showLinks: true, selectable: true, selected: new Set(['L004']) });
  assert.ok(html.includes('data-link-warn') && html.includes('fu-link-warn') && html.includes('有效链接较多，建议作废不用的链接'));
  assert.ok(html.includes('data-select-code="L004"') && html.includes(' checked'));
  assert.ok(!board.renderBoardRow(initialBoard()[3], { showLinks: true }).includes('data-select-code'), '不可批量修改时不显示勾选框');
  const hostile = board.renderBoardRow({ ...initialBoard()[2], patient_code: '<img src=x onerror=alert(1)>', followup_start_date: '<b>x</b>' }, { selectable: true });
  assert.ok(!hostile.includes('<img') && !hostile.includes('<b>'), '编号与日期须转义');
  const warn = console.warn; console.warn = () => {};
  for (const message of ['bulk_reason_required', 'invalid_patient_code_list', 'patient_codes_required', 'too_many_patients', 'followup_start_before_baseline',
    'followup_start_date_requires_dedicated_action', 'invalid_or_future_date: followup_start_date', 'date_before_1900: followup_start_date']) {
    const translated = data.registryErrorMessage({ message });
    assert.match(translated, /[一-龥]/, message);
    assert.ok(!/[a-z]+_[a-z]+/.test(translated), `不得显示代码：${translated}`);
  }
  console.warn = warn;
  assert.ok(data.registryErrorMessage({ message: 'invalid_or_future_date: followup_start_date' }).startsWith('提醒起算日：'));
  assert.equal(data.registryErrorMessage({ message: 'bulk_reason_required' }), '请填写 2–500 字的原因或依据（不含身份信息）。', '较长的代码优先于 reason_required');
  assert.equal(data.registryErrorMessage({ message: 'invalid_patient_code_list' }), '所选患者有重复或为空，请刷新看板后重新勾选。', '较长的代码优先于 invalid_patient_code');
}

async function main() {
  await checkPureHelpers();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const today = dayOffset(0);
  try {
    // 1. 看板：勾选框、有效链接过多的提示、提醒起算日。
    const { context, page, mock, pageErrors, dialogs } = await openWorkspace(browser, origin);
    assert.equal(await page.locator('#patientsList thead input[data-select-all]').count(), 1, '有全选框');
    assert.equal(await page.locator('#patientsList tbody input[data-select-code]').count(), 6);
    assert.equal(await page.locator('#boardBulkBar').isHidden(), true, '未勾选时不显示批量操作');
    const warnCell = page.locator('tr[data-patient-code="L004"] td[data-label="有效链接"]');
    assert.equal(await warnCell.getAttribute('data-link-warn'), '');
    assert.ok((await warnCell.getAttribute('title')).startsWith('有效链接较多，建议作废不用的链接'), '提示文字');
    assert.ok((await warnCell.getAttribute('class')).includes('fu-link-warn'), '警示样式');
    assert.equal(await page.locator('tr[data-patient-code="L005"] td[data-label="有效链接"]').getAttribute('data-link-warn'), null, '2 条不提示');
    const due = page.locator('tr[data-patient-code="P003"] td[data-label="下次应随访"]');
    assert.ok((await text(due)).includes(`提醒起算日 ${dayOffset(-20)}`), '显示提醒起算日');
    assert.equal(await due.getAttribute('title'), `按提醒起算日 ${dayOffset(-20)} 计算`);
    assert.equal(await page.locator('tr[data-patient-code="H001"] td[data-label="下次应随访"]').getAttribute('title'), '按基线日期 2014-03-01 计算');

    // 2. 勾选与全选。
    await checkbox(page, 'H001').check();
    await checkbox(page, 'H002').check();
    await eventually(() => page.locator('#boardBulkBar').isVisible(), '勾选后应显示批量操作');
    assert.equal(await text(page.locator('#boardSelectionStatus')), '已选择 2 位患者');
    assert.equal(await page.locator('tr[data-patient-code="H001"]').getAttribute('data-selected'), '1');
    await page.check('#patientsList thead input[data-select-all]');
    assert.equal(await text(page.locator('#boardSelectionStatus')), '已选择 6 位患者');
    assert.equal(await page.locator('#patientsList tbody input[data-select-code]:checked').count(), 6);
    await page.uncheck('#patientsList thead input[data-select-all]');
    assert.equal(await page.locator('#boardBulkBar').isHidden(), true);
    await checkbox(page, 'H001').check();
    await checkbox(page, 'H002').check();
    // 筛选后，不在当前列表中的已选患者仍计入并注明。
    await page.fill('#patientSearch', 'H001');
    await eventually(async () => (await text(page.locator('#boardSelectionStatus'))) === '已选择 2 位患者（其中 1 位不在当前显示的列表中）', '应注明不在当前列表中的已选患者');
    assert.equal(await checkbox(page, 'H001').isChecked(), true, '重绘后保留勾选');
    await page.fill('#patientSearch', '');
    await eventually(async () => (await page.locator('#patientsList tbody tr[data-patient-code]').count()) === 6, '清除查找后显示全部');

    // 3. 设置提醒起算日：说明文字、默认今天、不早于基线日期、原因必填。
    await page.click('#btnBulkStartDate');
    const startModal = page.locator('[data-registry-modal="bulkStartDate"]');
    await startModal.waitFor();
    assert.ok((await text(startModal)).includes('历史补录的患者，从这一天开始计算下次随访，不再按多年前的基线日期显示逾期'));
    assert.equal(await page.inputValue('#bsDate'), today, '默认今天');
    assert.equal(await page.getAttribute('#bsDate', 'max'), today);
    assert.equal(await text(page.locator('#bsCodes')), '已选择 2 位患者：H001、H002');
    await page.fill('#bsDate', '2014-04-01');
    await page.click('#bsSave');
    assert.ok((await text(page.locator('#bsFeedback'))).includes('H002 的基线日期晚于所选日期'), '前端提前提示早于基线日期');
    await page.fill('#bsDate', today);
    await page.fill('#bsReason', '补');
    await page.click('#bsSave');
    assert.ok((await text(page.locator('#bsFeedback'))).includes('2–500 字'));
    await page.fill('#bsReason', '患者电话13812345678');
    await page.click('#bsSave');
    assert.ok((await text(page.locator('#bsFeedback'))).includes('个人身份信息'));
    assert.equal(mock.rpcCalls('set_followup_start_date').length, 0, '前端校验未通过时不提交');
    // 服务器拒绝时显示中文说明。
    mock.errors.set_followup_start_date = { code: 'P0001', message: 'followup_start_before_baseline', details: null, hint: null };
    await page.fill('#bsReason', '历史补录患者，从今天开始提醒');
    await page.click('#bsSave');
    await eventually(async () => (await text(page.locator('#bsFeedback')))?.includes('提醒起算日不能早于所选患者的基线日期'), '应显示服务器错误的中文说明');
    const readsBefore = fullBoardReads(mock).length;
    await page.click('#bsSave');
    await startModal.waitFor({ state: 'detached' });
    const startCall = mock.rpcCalls('set_followup_start_date').at(-1).body;
    assert.deepEqual(startCall, { p_project_id: PROJECT.id, p_patient_codes: ['H001', 'H002'], p_start_date: today, p_reason: '历史补录患者，从今天开始提醒' });
    await eventually(() => fullBoardReads(mock).length > readsBefore, '批量修改后应重新读取看板');
    await eventually(async () => (await text(page.locator('tr[data-patient-code="H001"] td[data-label="下次应随访"]')))?.includes(`提醒起算日 ${today}`), '看板显示新的提醒起算日');
    assert.equal(await page.locator('#boardBulkBar').isHidden(), true, '保存后清除勾选');
    assert.equal(await page.locator('#patientsList tbody input[data-select-code]:checked').count(), 0);
    assert.ok((await page.locator('.toast').allTextContents()).some(t => t.includes('已设置 2 位患者的提醒起算日')));
    // 清除提醒起算日。
    await checkbox(page, 'P003').check();
    await page.click('#btnBulkStartDate');
    await startModal.waitFor();
    await page.check('input[name="bsMode"][value="clear"]');
    assert.equal(await page.isDisabled('#bsDate'), true);
    await page.click('#bsSave');
    await startModal.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('set_followup_start_date').at(-1).body, { p_project_id: PROJECT.id, p_patient_codes: ['P003'], p_start_date: null, p_reason: '历史补录患者，从此日开始提醒随访' });

    // 4. 批量确认知情同意。
    await checkbox(page, 'H001').check();
    await checkbox(page, 'H002').check();
    await page.click('#btnBulkConsent');
    const consentModal = page.locator('[data-registry-modal="bulkConsent"]');
    await consentModal.waitFor();
    assert.deepEqual(await page.locator('#bcStatus option').evaluateAll(o => o.map(x => x.value)), ['unconfirmed', 'consented', 'waiver', 'declined', 'withdrawn'], '与单个患者相同的五种状态');
    assert.equal(await page.inputValue('#bcStatus'), 'consented');
    assert.equal(await text(page.locator('#bcDateLabel')), '签署日期（可选）');
    assert.equal(await page.locator('#bcLinkNote').isHidden(), true);
    await page.click('#bcSave');
    assert.ok((await text(page.locator('#bcFeedback'))).includes('请填写依据'), '依据必填');
    await page.selectOption('#bcStatus', 'declined');
    assert.equal(await page.locator('#bcLinkNote').isVisible(), true, '拒绝时提示链接将被撤销');
    assert.equal(await text(page.locator('#bcDateLabel')), '拒绝日期（可选）');
    await page.selectOption('#bcStatus', 'consented');
    await page.fill('#bcVersion', 'V2.0（2026-03-01）');
    await page.fill('#bcDate', dayOffset(-10));
    await page.fill('#bcReason', '纸质同意书存档于研究办公室 A 柜');
    // 服务器拒绝某位患者：显示中文说明与该患者的研究编号，整批未保存。
    mock.errors.set_consent_bulk = { code: 'P0001', message: 'subscription_required', details: '研究编号 H002；本次没有修改任何患者。', hint: null };
    await page.click('#bcSave');
    await eventually(async () => (await text(page.locator('#bcFeedback')))?.includes('（研究编号 H002；本次没有修改任何患者。）'), '应显示出错患者的研究编号');
    assert.ok((await text(page.locator('#bcFeedback'))).includes('只读'), '错误为中文说明');
    assert.ok(dialogs.some(d => d.includes('将把 2 位患者的知情同意状态登记为“已同意”')), '保存前确认');
    await page.click('#bcSave');
    await consentModal.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('set_consent_bulk').at(-1).body, { p_project_id: PROJECT.id, p_patient_codes: ['H001', 'H002'], p_status: 'consented', p_version: 'V2.0（2026-03-01）', p_date: dayOffset(-10), p_reason: '纸质同意书存档于研究办公室 A 柜' });
    await eventually(async () => (await text(page.locator('tr[data-patient-code="H001"] td[data-label="知情同意"]'))) === '已同意', '看板更新同意状态');
    // 版本与日期留空时传空值（数据库保留原版本；日期按状态是否改变保留或清空）。
    await checkbox(page, 'P003').check();
    await page.click('#btnBulkConsent');
    await consentModal.waitFor();
    await page.selectOption('#bcStatus', 'waiver');
    await page.fill('#bcReason', '伦理委员会批准免除知情同意');
    await page.click('#bcSave');
    await consentModal.waitFor({ state: 'detached' });
    assert.deepEqual(mock.rpcCalls('set_consent_bulk').at(-1).body, { p_project_id: PROJECT.id, p_patient_codes: ['P003'], p_status: 'waiver', p_version: null, p_date: null, p_reason: '伦理委员会批准免除知情同意' });

    // 5. 生成新链接时默认作废此前仍有效的链接（只作废生成前已有的有效链接）。
    await page.click('tr[data-patient-code="L004"] [data-act="links"]');
    await eventually(async () => (await page.locator('#lkList tbody tr').count()) === 4, '链接列表应有 4 行');
    assert.equal(await page.isChecked('#lkRevokeOld'), true, '默认勾选“同时作废该患者此前仍有效的链接”');
    assert.equal(await page.locator('#lkKeepNewestBar').isVisible(), true, '多条有效链接时显示整理按钮');
    await page.click('#lkCreate');
    await eventually(() => mock.rpcCalls('revoke_patient_token_by_id').length === 3, '应作废此前的 3 条有效链接');
    const revoked = mock.rpcCalls('revoke_patient_token_by_id').map(r => r.body);
    assert.deepEqual(revoked.map(b => b.p_token_id).sort(), [token(1).id, token(2).id, token(3).id].sort(), '只作废生成前已有的有效链接');
    assert.ok(revoked.every(b => b.p_reason === REVOKE_OLD_REASON && b.p_project_id === PROJECT.id));
    const createdAt = mock.requests.findIndex(r => r.path === '/rest/v1/rpc/create_patient_token_v2');
    assert.ok(mock.requests.findIndex(r => r.path === '/rest/v1/rpc/revoke_patient_token_by_id') > createdAt, '新链接生成成功后才作废旧链接');
    await eventually(async () => (await text(page.locator('#lkFeedback')))?.includes('此前仍有效的 3 条链接已作废'), '提示已作废旧链接');
    assert.ok((await page.inputValue('#lkOnceLink')).endsWith(`#${NEW_TOKEN}`), '新链接仍可复制');
    assert.equal(mock.tokens.filter(t => t.patient_code === 'L004' && !t.revoked_at).length, 1, '只剩新链接有效');
    await eventually(() => page.locator('#lkKeepNewestBar').isHidden(), '只剩一条有效链接时隐藏整理按钮');
    await page.keyboard.press('Escape');
    await page.locator('[data-registry-modal="links"]').waitFor({ state: 'detached' });

    // 6. “作废除最新一个以外的全部有效链接”：确认后保留最新一条。
    await page.click('tr[data-patient-code="L005"] [data-act="links"]');
    await eventually(async () => (await page.locator('#lkList tbody tr').count()) === 2, 'L005 有 2 条链接');
    const before = mock.rpcCalls('revoke_patient_token_by_id').length;
    await page.click('#lkKeepNewest');
    await eventually(() => mock.rpcCalls('revoke_patient_token_by_id').length === before + 1, '应作废较早的一条');
    assert.ok(dialogs.some(d => d.includes('将作废该患者除最新一条以外的 1 条有效链接')), '作废前确认');
    assert.deepEqual(mock.rpcCalls('revoke_patient_token_by_id').at(-1).body, { p_project_id: PROJECT.id, p_token_id: token(6).id, p_reason: KEEP_NEWEST_REASON }, '保留最新的一条（L005 第 5 号）');
    await eventually(async () => (await text(page.locator('#lkFeedback')))?.includes('保留最新的一条'), '提示结果');
    await page.keyboard.press('Escape');

    assert.deepEqual(pageErrors, [], '页面不应有未捕获异常');
    assert.deepEqual(mock.external, [], '不得访问其他外部主机');
    assert.deepEqual(mock.unknown, [], `未模拟的请求：${mock.unknown.join(', ')}`);
    await context.close();

    // 7. 只读协作人：没有勾选框和批量操作，也看不到链接数。
    const viewer = await openWorkspace(browser, origin, { access: VIEWER });
    assert.equal(await viewer.page.locator('#patientsList input[data-select-code], #patientsList input[data-select-all]').count(), 0);
    assert.equal(await viewer.page.locator('#boardBulkBar').isHidden(), true);
    assert.equal(await viewer.page.locator('td[data-label="有效链接"]').count(), 0);
    assert.deepEqual(viewer.pageErrors, []);
    await viewer.context.close();

    // 8. 录入协作人：可以批量操作；手机宽度下没有横向滚动。
    const editor = await openWorkspace(browser, origin, { access: EDITOR, viewport: { width: 390, height: 844 } });
    await checkbox(editor.page, 'H001').check();
    await eventually(() => editor.page.locator('#boardBulkBar').isVisible(), '录入协作人可以批量操作');
    const overflow = await editor.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `手机宽度下页面不应横向滚动（溢出 ${overflow}px）`);
    assert.deepEqual(editor.pageErrors, []);
    await editor.context.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log('BOARD_ACTIONS_UI_OK');
}

main().catch(error => { console.error(error); process.exit(1); });
