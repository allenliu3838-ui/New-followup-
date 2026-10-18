// 科研工作台浏览器冒烟测试（合成数据，不连接任何真实数据库）。
// 运行：node tests/ui/staff-smoke.mjs   成功时打印 STAFF_UI_OK。
//  - 用 Node 自带 http 模块在 127.0.0.1 随机端口提供 site/ 静态文件；
//  - 用 Playwright（@playwright/test，Chromium）打开 staff.html；不下载浏览器，优先使用
//    PLAYWRIGHT_BROWSERS_PATH（默认 /opt/pw-browsers）下已安装的 Chromium；
//  - 会话：在 localStorage 写入一个合成登录会话，由 supabase-js 按正常流程恢复，生产代码无任何测试后门；
//  - 对 config.js 中 Supabase 域名的全部请求用 page.route 返回固定的合成数据；
//    任何发往其他外部主机的请求都会被拦截并记为失败。
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
// 接口挂在站点路径下（如 /sb）时，去掉前缀后按 Supabase 原路径模拟
const SB_PREFIX = new URL(SUPABASE_URL).pathname.replace(/\/+$/, '');
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── 合成数据 ────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = days => { const d = new Date(); d.setDate(d.getDate() + days); return isoDay(d); };
const tsOffset = days => new Date(Date.now() + days * 86400000).toISOString();

const USER = { id: '00000000-0000-4000-8000-0000000000a1', aud: 'authenticated', role: 'authenticated', email: 'pi.synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const PROJECT = { id: '10000000-0000-4000-8000-000000000001', name: '合成测试队列', center_code: 'TST01', module: 'IGAN', registry_type: 'igan', description: null, created_by: USER.id, created_at: '2026-02-01T00:00:00Z', followup_interval_days: 90, public_title: '合成随访研究', institution_name: '测试医院肾内科', ethics_approval_no: 'TEST-2026-001', contact_display: '研究护士 测试老师' };
const EMPTY_PROJECT = { ...PROJECT, id: '10000000-0000-4000-8000-000000000002', name: '空白合成项目', center_code: 'TST02', created_at: '2026-01-01T00:00:00Z' };
const ACCESS = { role: 'owner', can_read: true, can_write: true, can_export: true, can_manage_tokens: true, can_manage_members: true, can_manage_project: true, write_block_reason: null };
const OVERVIEWS = {
  [PROJECT.id]: { project_id: PROJECT.id, followup_interval_days: 90, n_patients: 9, n_active: 7, n_visits: 13, n_visits_30d: 3, n_core_complete_visits: 9, core_completeness: 0.6923, n_overdue: 3, n_due_soon: 2, n_no_visit: 1, last_visit_date: dayOffset(-11), n_consent_confirmed: 2, n_consent_unconfirmed: 6, n_open_issues: 3 },
  [EMPTY_PROJECT.id]: { project_id: EMPTY_PROJECT.id, followup_interval_days: 90, n_patients: 0, n_active: 0, n_visits: 0, n_visits_30d: 0, n_core_complete_visits: 0, core_completeness: null, n_overdue: 0, n_due_soon: 0, n_no_visit: 0, last_visit_date: null, n_consent_confirmed: 0, n_consent_unconfirmed: 0, n_open_issues: 0 },
};
const boardRow = (n, state, extra) => ({ project_id: PROJECT.id, patient_id: `20000000-0000-4000-8000-00000000000${n}`, center_code: 'TST01', patient_code: `P00${n}`, baseline_date: dayOffset(-400), consent_status: 'unconfirmed', followup_status: 'active', visit_count: 2, first_visit_date: dayOffset(-380), active_link_count: 0, last_link_created_at: null, last_link_expires_at: null, last_patient_submission_at: null, followup_state: state, ...extra });
// 故意乱序返回，验证前端按“逾期优先”排序。
const BOARD = [
  boardRow(3, 'ok', { last_visit_date: dayOffset(-20), days_since_last_visit: 20, next_due_date: dayOffset(70), consent_status: 'consented' }),
  boardRow(1, 'overdue', { last_visit_date: dayOffset(-160), days_since_last_visit: 160, next_due_date: dayOffset(-70), active_link_count: 1, last_link_created_at: tsOffset(-3), last_link_expires_at: tsOffset(27) }),
  boardRow(5, 'inactive', { followup_status: 'lost', last_visit_date: dayOffset(-300), days_since_last_visit: 300, next_due_date: dayOffset(-210) }),
  boardRow(2, 'due_soon', { last_visit_date: dayOffset(-80), days_since_last_visit: 80, next_due_date: dayOffset(10), consent_status: 'waiver', active_link_count: 2 }),
  boardRow(6, 'overdue', { last_visit_date: dayOffset(-100), days_since_last_visit: 100, next_due_date: dayOffset(-10) }),
  boardRow(4, 'no_visit', { visit_count: 0, first_visit_date: null, last_visit_date: null, days_since_last_visit: null, baseline_date: dayOffset(-30), next_due_date: dayOffset(60) }),
  // 从未随访、按“基线日期 + 间隔”已逾期 / 即将到期：数据库视图（0038）计为 overdue / due_soon。
  boardRow(7, 'overdue', { visit_count: 0, first_visit_date: null, last_visit_date: null, days_since_last_visit: null, baseline_date: dayOffset(-200), next_due_date: dayOffset(-110) }),
  boardRow(8, 'due_soon', { visit_count: 0, first_visit_date: null, last_visit_date: null, days_since_last_visit: null, baseline_date: dayOffset(-85), next_due_date: dayOffset(5) }),
  // 撤回知情同意（随访状态仍为“在访”）：不再提醒随访。
  boardRow(9, 'inactive', { consent_status: 'withdrawn', last_visit_date: dayOffset(-110), days_since_last_visit: 110, next_due_date: dayOffset(-20) }),
];
const EXPECTED_ORDER = ['P007', 'P001', 'P006', 'P008', 'P002', 'P004', 'P003', 'P005', 'P009'];
const EXPECTED_BADGES = ['尚无随访·逾期', '逾期', '逾期', '尚无随访·即将到期', '即将到期', '尚无随访', '正常', '已停止随访', '已停止随访'];
// 链接行里故意带上明文与摘要：页面绝不能显示它们。
const SECRET_TEXT = 'PLAINTEXT-LINK-SHOULD-NEVER-RENDER-7f3a';
const SECRET_HASH = 'c0ffee'.repeat(10) + 'beef';
const tokenRow = (n, extra) => ({ id: `30000000-0000-4000-8000-00000000000${n}`, project_id: PROJECT.id, patient_code: 'P001', token: SECRET_TEXT, token_hash: SECRET_HASH, active: true, single_use: true, used_at: null, revoked_at: null, revoke_reason: null, created_by: USER.id, created_at: tsOffset(-n), expires_at: tsOffset(30 - n), ...extra });
const TOKENS = [
  tokenRow(1, {}),
  tokenRow(2, { expires_at: tsOffset(-1) }),
  tokenRow(3, { active: false, revoked_at: tsOffset(-2), revoke_reason: '发错对象' }),
  tokenRow(4, { used_at: tsOffset(-3) }),
];
const NEW_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LAST_VISIT = { id: '40000000-0000-4000-8000-000000000001', project_id: PROJECT.id, patient_code: 'P001', visit_date: dayOffset(-160), sbp: 128, dbp: 82, scr_umol_l: 101, upcr: 520, egfr: 72, notes: null, submitted_via_token_id: null };
const STUDY_STATUS = { id: '20000000-0000-4000-8000-000000000006', patient_code: 'P006', consent_status: 'unconfirmed', consent_date: null, consent_version: null, followup_status: 'active', followup_status_date: null };
const BASELINES = {
  P006: STUDY_STATUS,
  P003: { ...STUDY_STATUS, id: BOARD[0].patient_id, patient_code: 'P003', consent_status: 'consented', consent_date: dayOffset(-390), consent_version: 'V1.0' },
  P009: { ...STUDY_STATUS, id: '20000000-0000-4000-8000-000000000009', patient_code: 'P009', consent_status: 'withdrawn', consent_date: dayOffset(-30), consent_version: 'V1.0' },
};
const DEFAULT_DATA = {
  projects: [PROJECT, EMPTY_PROJECT], overviews: OVERVIEWS, board: { [PROJECT.id]: BOARD }, tokens: TOKENS, visits: [LAST_VISIT], baselines: BASELINES,
  // 看板认为可以发放、但服务器拒绝（例如刚被其他成员登记退出）的患者。
  tokenErrors: { P002: 'patient_not_eligible_for_links' },
};

// 超过一页（每页 500 行）的大项目：按 patient_id 键集分页时不能漏行或重复。
const bigId = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BIG_BOARD = Array.from({ length: 1203 }, (_, i) => boardRow(1, 'ok', { patient_id: bigId(i + 1), patient_code: `S${String(i + 1).padStart(4, '0')}`, last_visit_date: dayOffset(-20), days_since_last_visit: 20, next_due_date: dayOffset(70) }))
  .reverse();
const BIG_DATA = { ...DEFAULT_DATA, board: { [PROJECT.id]: BIG_BOARD }, overviews: { [PROJECT.id]: { ...OVERVIEWS[PROJECT.id], n_patients: 1203 } } };

// 恶意内容：出现在项目名、中心代码、项目设置、研究编号、撤销原因、随访备注、同意书版本中时必须只显示为文字。
const X = n => `<img src=x onerror="window.__xss=(window.__xss||[]).concat('${n}')">`;
const SVG = n => `<svg onload="window.__xss=(window.__xss||[]).concat('${n}')"></svg>`;
const JS = n => `javascript:window.__xss=(window.__xss||[]).concat('${n}')`;
const HOSTILE_CODE = `H1${X('code')}`;
const HOSTILE_PROJECT = { ...PROJECT, name: `P${X('projname')}${SVG('projname2')}`, center_code: `C${X('center')}`, public_title: X('title'), institution_name: SVG('inst'), ethics_approval_no: `${X('ethics')}'"`, contact_display: `${JS('contact')} ${X('contact2')}` };
const HOSTILE_DATA = {
  projects: [HOSTILE_PROJECT],
  overviews: { [PROJECT.id]: { ...OVERVIEWS[PROJECT.id], last_visit_date: X('lastvisit') } },
  board: { [PROJECT.id]: [boardRow(1, 'overdue', { patient_code: HOSTILE_CODE, center_code: HOSTILE_PROJECT.center_code, last_visit_date: dayOffset(-160), days_since_last_visit: 160, next_due_date: dayOffset(-70), active_link_count: 1 })] },
  tokens: [tokenRow(3, { patient_code: HOSTILE_CODE, active: false, revoked_at: tsOffset(-2), revoke_reason: `${X('reason')}${JS('reason2')}` })],
  visits: [{ ...LAST_VISIT, patient_code: HOSTILE_CODE, notes: `${X('notes')}${SVG('notes2')}` }],
  baselines: { [HOSTILE_CODE]: { ...STUDY_STATUS, id: BOARD[1].patient_id, patient_code: HOSTILE_CODE, consent_status: 'consented', consent_date: dayOffset(-390), consent_version: `"><img src=x onerror="window.__xss=(window.__xss||[]).concat('version')">` } },
  tokenErrors: {},
};

// ── 本地静态服务器 ──────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/staff' || rel.startsWith('/staff/')) rel = '/staff.html'; // 与 site/_redirects 相同
    if (rel === '/followup' || rel.startsWith('/p/')) rel = '/patient.html';
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
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message}${last ? '：' + last.message : ''}`);
}

// ── Supabase 模拟 ───────────────────────────────────────────
function createMock({ access = ACCESS, data = DEFAULT_DATA } = {}) {
  const requests = [];
  const external = [];
  const unknown = [];
  const importReplies = [];
  const holds = new Map();      // 'table:研究编号' → 等待释放的 Promise，用于模拟迟到的响应
  const served = [];            // 看板视图返回过的 patient_id（检查分页不漏不重）
  const tokens = data.tokens.map(t => ({ ...t }));
  let newTokenCount = 0;
  const cors = origin => ({ 'access-control-allow-origin': origin || '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range,x-total-count' });
  const filters = (url, op) => Object.fromEntries([...url.searchParams].filter(([, v]) => v.startsWith(`${op}.`)).map(([k, v]) => [k, v.slice(op.length + 1)]));

  function restRows(table, url) {
    const f = filters(url, 'eq');
    const gt = filters(url, 'gt');
    switch (table) {
      case 'projects': return data.projects;
      case 'v_project_overview': return data.overviews[f.project_id] ? [data.overviews[f.project_id]] : [];
      case 'v_patient_followup_status': {
        let rows = [...(data.board[f.project_id] || [])].filter(r => !f.patient_code || r.patient_code === f.patient_code);
        if (gt.patient_id) rows = rows.filter(r => r.patient_id > gt.patient_id);
        if (url.searchParams.get('order') === 'patient_id.asc') rows.sort((a, b) => (a.patient_id < b.patient_id ? -1 : 1));
        return rows;
      }
      case 'patient_tokens': return tokens.filter(t => t.project_id === f.project_id && (!f.patient_code || t.patient_code === f.patient_code));
      case 'visits_long': return data.visits.filter(v => v.project_id === f.project_id && (!f.patient_code || v.patient_code === f.patient_code) && (!f.id || v.id === f.id));
      case 'patients_baseline': return Object.values(data.baselines).filter(b => (!f.patient_code || b.patient_code === f.patient_code) && (!f.id || b.id === f.id));
      case 'user_profiles': case 'lab_test_catalog': case 'lab_test_unit_map': case 'project_custom_labs':
      case 'labs_long': case 'meds_long': case 'events_long': case 'variants_long': case 'data_issues':
        return [];
      default: unknown.push(`GET ${table}`); return [];
    }
  }

  function rpc(name, body) {
    switch (name) {
      case 'get_project_access': return access;
      case 'check_project_quota': return { plan: 'trial', can_write: true, ends_at: tsOffset(60), quota: 3, used: 2 };
      case 'is_platform_admin': return false;
      case 'get_my_contract': return [];
      case 'list_project_members': return [{ user_id: USER.id, email: USER.email, display_name: null, role: 'owner', created_at: '2026-01-01T00:00:00Z', is_owner: true }];
      case 'list_project_snapshots': return [];
      case 'get_issue_summary': return { total_open: 3, total_in_prog: 0, total_resolved: 1, total_wontfix: 0 };
      case 'import_registry_rows': return importReplies.shift() ?? { inserted: 1, updated: 0, skipped: 0, total: 1, replayed: false };
      case 'create_patient_token_v2': {
        newTokenCount += 1;
        tokens.unshift({ ...tokenRow(1, {}), id: `30000000-0000-4000-8000-0000000001${String(newTokenCount).padStart(2, '0')}`, patient_code: body.p_patient_code, created_at: new Date().toISOString(), expires_at: tsOffset(body.p_expires_in_days || 30), single_use: body.p_single_use !== false });
        return NEW_TOKEN;
      }
      case 'revoke_patient_token_by_id': {
        const t = tokens.find(x => x.id === body.p_token_id);
        if (t) Object.assign(t, { active: false, revoked_at: new Date().toISOString(), revoke_reason: body.p_reason });
        return null;
      }
      case 'set_patient_study_status': return { patient_code: body.p_patient_code, consent_status: body.p_changes?.consent_status ?? 'unconfirmed', consent_date: body.p_changes?.consent_date || null, consent_version: null, followup_status: body.p_changes?.followup_status ?? 'active', followup_status_date: body.p_changes?.followup_status_date || null, changed: true };
      case 'set_project_settings': return { followup_interval_days: body.p_settings?.followup_interval_days ?? 90, public_title: PROJECT.public_title, institution_name: PROJECT.institution_name, ethics_approval_no: PROJECT.ethics_approval_no, contact_display: PROJECT.contact_display, changed: true };
      case 'correct_registry_record': return { record: { id: body.p_record_id, ...body.p_changes }, changed: Object.keys(body.p_changes || {}) };
      default: unknown.push(`RPC ${name}`); return null;
    }
  }

  async function handle(route, localOrigin, configOverride) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === localOrigin) {
      if (configOverride && url.pathname === '/config.js') {
        return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: `${CONFIG_SOURCE}\n${configOverride}\n` });
      }
      return route.continue();
    }
    if (url.host !== SUPABASE_HOST) { external.push(request.url()); return route.abort('blockedbyclient'); }
    if (SB_PREFIX && url.pathname.startsWith(SB_PREFIX + '/')) url.pathname = url.pathname.slice(SB_PREFIX.length);
    const headers = cors(request.headers().origin);
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body = null;
    try { body = request.postData() ? JSON.parse(request.postData()) : null; } catch { body = request.postData(); }
    requests.push({ method: request.method(), path: url.pathname, search: url.search, params: url.searchParams, headers: request.headers(), body });
    // 页面已放弃的请求（AbortController）无法再应答：忽略这种情况下的错误。
    const settle = promise => promise.catch(() => {});
    const json = (status, value, extra = {}) => settle(route.fulfill({ status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(value) }));
    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname.endsWith('/user')) return json(200, USER);
      if (url.pathname.endsWith('/token')) return json(200, sessionFor());
      if (url.pathname.endsWith('/logout')) return settle(route.fulfill({ status: 204, headers }));
      unknown.push(`AUTH ${url.pathname}`);
      return json(200, {});
    }
    const rpcName = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/)?.[1];
    if (rpcName) {
      // 测试可预置数据库错误（PostgREST 错误格式）或网络中断。
      if (rpcName === 'import_registry_rows' && importReplies[0]?.postgrestError) return json(400, importReplies.shift().postgrestError);
      if (rpcName === 'import_registry_rows' && importReplies[0]?.abort) { importReplies.shift(); return settle(route.abort('failed')); }
      if (rpcName === 'create_patient_token_v2' && data.tokenErrors?.[body?.p_patient_code]) return json(400, { code: 'P0001', message: data.tokenErrors[body.p_patient_code], details: null, hint: null });
      const value = rpc(rpcName, body || {});
      return value === null && rpcName === 'revoke_patient_token_by_id' ? settle(route.fulfill({ status: 204, headers })) : json(200, value);
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z0-9_]+)$/)?.[1];
    if (table && request.method() === 'GET') {
      const hold = holds.get(`${table}:${filters(url, 'eq').patient_code || ''}`);
      if (hold) await hold.promise;
      const rows = restRows(table, url);
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : rows.length;
      const page = rows.slice(offset, offset + limit);
      if (table === 'v_patient_followup_status') served.push(...page.map(r => r.patient_id));
      if (/vnd\.pgrst\.object/.test(request.headers().accept || '')) {
        return page.length === 1 ? json(200, page[0]) : json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null });
      }
      const range = page.length ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}`;
      return json(200, page, { 'content-range': range });
    }
    unknown.push(`${request.method()} ${url.pathname}`);
    return json(200, null);
  }

  /** 让某个读取（表 + 研究编号）暂停应答，返回释放函数。 */
  function hold(table, patientCode) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    holds.set(`${table}:${patientCode}`, { promise });
    return () => { holds.delete(`${table}:${patientCode}`); release(); };
  }

  return { requests, external, unknown, importReplies, served, tokens, hold, handle, rpcCalls: name => requests.filter(r => r.path === `/rest/v1/rpc/${name}`) };
}

function sessionFor() {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER.id, role: 'authenticated', aud: 'authenticated', email: USER.email, exp: now + 86400, iat: now })}.synthetic-signature`;
  return { access_token: accessToken, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'synthetic-refresh-token', user: USER };
}

async function openWorkspace(browser, origin, { configOverride = '', viewport = { width: 1280, height: 900 }, access = ACCESS, data = DEFAULT_DATA, path: entry = '/staff.html', clock = false, lastActivity = null, expect = 'board' } = {}) {
  const mock = createMock({ access, data });
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'zh-CN' });
  await context.addInitScript(([key, value]) => { try { localStorage.setItem(key, value); } catch { /* 隐私模式时忽略 */ } }, [STORAGE_KEY, JSON.stringify(sessionFor())]);
  // 模拟“上次操作”的时间戳（只写入时间，不含其他信息）。
  if (lastActivity !== null) await context.addInitScript(at => { try { localStorage.setItem('ks_staff_last_activity', String(at)); } catch { /* 忽略 */ } }, lastActivity);
  if (clock) await context.clock.install();
  await context.route('**/*', route => mock.handle(route, origin, configOverride));
  const { page, pageErrors, dialogs } = await openPage(context, origin, entry, expect);
  return { context, page, mock, pageErrors, dialogs };
}

async function openPage(context, origin, entry = '/staff.html', expect = 'board') {
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && process.env.STAFF_UI_DEBUG) console.log('[console.error]', message.text()); });
  const dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
  await page.goto(`${origin}${entry}`);
  if (expect === 'board') await page.locator('#patientsList tbody tr[data-patient-code]').first().waitFor({ timeout: 15000 });
  else await page.locator('#loginCard').waitFor({ state: 'visible', timeout: 15000 });
  return { page, pageErrors, dialogs };
}

const boardReads = mock => mock.requests.filter(r => r.path === '/rest/v1/v_patient_followup_status');
// 页面中是否还有某段文字（含属性与输入框的当前值）。
const pageHas = (page, needle) => page.evaluate(n => document.documentElement.outerHTML.includes(n) || [...document.querySelectorAll('input,textarea')].some(x => String(x.value).includes(n)), needle);

const text = async locator => (await locator.textContent())?.replace(/\s+/g, ' ').trim();
// 可选：设置 STAFF_UI_SCREENSHOT_DIR 时在关键步骤保存截图，便于人工审阅界面。
const SHOT_DIR = process.env.STAFF_UI_SCREENSHOT_DIR;
const shot = async (page, name, options = {}) => { if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), ...options }); } };
const boardCodes = page => page.locator('#patientsList tbody tr[data-patient-code]').evaluateAll(rows => rows.map(r => r.dataset.patientCode));

// 纯函数检查：直接加载 site/lib 下的 ES 模块（data: URL 避免依赖 package.json 的模块类型）。
const loadModule = async file => import(`data:text/javascript;base64,${fs.readFileSync(path.join(ROOT, file)).toString('base64')}`);
async function checkPureHelpers() {
  const data = await loadModule('lib/registry-data.js');
  const board = await loadModule('lib/followup-board.js');
  const raw = ['row_1_same_day_record_conflict', 'visit_validation_failed', 'subscription_required', 'project_access_denied', 'revoke_reason_required',
    'study_exit_reason_required', 'patient_not_eligible_for_links', 'egfr_out_of_range_check_scr', 'invalid_or_future_date: followup_status_date',
    'invalid_followup_interval', 'setting_too_long: public_title', 'unsupported_column: foo', 'new row violates check constraint "x"',
    'relation "public.v_patient_followup_status" does not exist', 'Failed to fetch', 'JWT expired', 'Something unexpected happened',
    'study_status_requires_dedicated_action', 'row_3_study_status_requires_dedicated_action',
    'new row for relation "visits_long" violates check constraint "visits_sbp_range"', 'new row for relation "patients_baseline" violates check constraint "baseline_scr_range"',
    'new row for relation "visits_long" violates check constraint "visits_long_upcr_range"', 'new row for relation "visits_long" violates check constraint "visits_scr_umol_l_check"'];
  const warn = console.warn;
  console.warn = () => {}; // 未翻译的原始错误只写入浏览器控制台，这里不需要输出
  for (const message of raw) {
    const translated = data.registryErrorMessage({ message }, { rowPrefix: false });
    assert.match(translated, /[\u4e00-\u9fa5]/, `错误应翻译为中文：${message}`);
    assert.ok(!translated.includes(message) && !/[a-z]+_[a-z]+/.test(translated), `不得显示英文原文或代码：${translated}`);
  }
  console.warn = warn;
  assert.equal(data.registryErrorMessage({ message: 'row_2_same_day_record_conflict' }).startsWith('第 3 行：'), true, 'CSV 行号前缀');
  assert.ok(data.registryErrorMessage({ message: 'invalid_iso_date: consent_date' }).startsWith('知情同意日期：'), '带字段名的错误应显示中文字段名');
  assert.ok(data.registryErrorMessage({ message: 'baseline_date_required_with_visits' }).includes('不能清空'), '较长的错误代码应优先匹配');
  assert.ok(data.registryErrorMessage({ message: 'study_exit_reason_required' }).includes('退出研究'), '退出类修改缺少原因有专门提示');
  assert.ok(data.registryErrorMessage({ message: 'patient_not_eligible_for_links' }).includes('不能再发放随访链接'));
  assert.equal(data.registryErrorMessage({ message: 'egfr_out_of_range_check_scr', code: '23514' }), '由血肌酐、出生年份和性别计算的 eGFR 超出范围，请核对这几项。', 'eGFR 超限提示核对计算所用的几项');
  assert.equal(data.registryErrorMessage({ message: 'study_status_requires_dedicated_action' }), '研究状态（同意、退出、死亡等）请在患者的“研究状态”中修改，不能通过导入或更正修改。');
  assert.equal(data.registryErrorMessage({ message: 'study_exit_reason_required' }), '登记拒绝或撤回知情同意、退出研究或死亡，撤销退出，或修改已退出患者的研究状态时，请填写原因。');
  assert.equal(data.registryErrorMessage({ message: 'row_2_study_status_requires_dedicated_action: consent_status' }), '第 3 行：知情同意状态：研究状态（同意、退出、死亡等）请在患者的“研究状态”中修改，不能通过导入或更正修改。', '导入错误带行号与字段');
  assert.ok(data.registryErrorMessage({ message: 'study_status_requires_dedicated_action: followup_status' }).startsWith('随访状态：研究状态'));
  assert.throws(() => data.normalizeImportRow('baseline', { patient_code: 'P1', consent_status: '撤回' }), /研究状态/, '导入预览提前提示退出类状态');
  assert.throws(() => data.normalizeImportRow('baseline', { patient_code: 'P1', followup_status: '死亡' }), /研究状态/);
  assert.equal(data.normalizeImportRow('baseline', { patient_code: 'P1', followup_status: '失访' }).followup_status, 'lost');
  // 数据库约束错误：从约束名推断中文字段名，并说明允许范围。
  const constraint = name => data.registryErrorMessage({ code: '23514', message: `new row for relation "visits_long" violates check constraint "${name}"`, details: 'Failing row contains (secret-note-text)' }, { rowPrefix: false });
  assert.ok(constraint('visits_sbp_range').startsWith('收缩压须在 40–300 mmHg 之间'), constraint('visits_sbp_range'));
  assert.ok(constraint('visits_long_upcr_range').includes('UPCR') && constraint('visits_long_upcr_range').includes('50000'));
  assert.ok(constraint('baseline_scr_range').startsWith('基线血肌酐须在 10–5000 μmol/L 之间'));
  assert.ok(constraint('visits_scr_umol_l_check').startsWith('血肌酐（μmol/L）'), '未知约束名中含列名时显示该列的中文名');
  assert.ok(!constraint('visits_sbp_range').includes('secret-note-text'), '不得显示失败行的原始内容');
  assert.ok(data.registryErrorMessage({ code: '23514', message: 'new row violates check constraint "x"' }).includes('不符合系统约束'), '无法推断字段时给出通用中文说明');
  // 与数据库约束对齐的前端校验。
  assert.equal(data.creatinineUmol('88', 'umol'), 88);
  assert.equal(data.creatinineUmol('1.1', 'mgdl'), 97.24);
  assert.equal(data.creatinineUmol('', 'umol'), null);
  assert.throws(() => data.creatinineUmol('1.1', 'umol', '基线血肌酐'), /基线血肌酐 1\.1 μmol\/L 低于系统允许的 10–5000 μmol\/L。这个数值看起来是 mg\/dL/);
  assert.throws(() => data.creatinineUmol('98', 'mgdl'), /看起来是 μmol\/L/);
  assert.throws(() => data.creatinineUmol('5001', 'umol'), /10–5000 μmol\/L/);
  assert.throws(() => data.normalizeImportRow('baseline', { patient_code: 'P1', baseline_scr: '1.1' }), /mg\/dL/, '基线血肌酐按 mg/dL 填写时提示切换单位');
  assert.equal(data.normalizeImportRow('baseline', { patient_code: 'P1', baseline_scr: '3500.5' }).baseline_scr, 3500.5, '基线血肌酐 3000–5000 μmol/L 是数据库允许的');
  const csvVisit = row => data.normalizeImportRow('visits', { patient_code: 'P1', visit_date: '2026-01-02', ...row });
  assert.deepEqual(csvVisit({ sbp: '128', dbp: '78' }), { patient_code: 'P1', visit_date: '2026-01-02', sbp: 128, dbp: 78 }, 'CSV 随访只填部分测量值也可以');
  assert.deepEqual(csvVisit({ upcr: '50000' }), { patient_code: 'P1', visit_date: '2026-01-02', upcr: 50000 });
  for (const [row, pattern] of [[{}, /至少填写一项测量值/], [{ notes: '补录' }, /至少填写一项测量值/], [{ sbp: '35' }, /收缩压须在 40–300 mmHg 之间/], [{ sbp: '301' }, /40–300/],
    [{ dbp: '19' }, /舒张压须在 20–200 mmHg 之间/], [{ scr_umol_l: '1.1' }, /mg\/dL/], [{ scr_umol_l: '5001' }, /10–5000/], [{ upcr: '50001' }, /0–50000 mg\/g/], [{ sbp: '80', dbp: '80' }, /舒张压须低于收缩压/]]) {
    assert.throws(() => csvVisit(row), pattern, JSON.stringify(row));
  }
  assert.equal(data.correctionReasonError(' 改 '), '请填写更正原因（3–500 字），说明依据的原始资料。');
  assert.equal(data.correctionReasonError('核对原始化验单'), '');
  assert.match(data.correctionReasonError('核'.repeat(501)), /最多 500 字/);
  assert.match(data.correctionReasonError('患者电话13812345678'), /个人身份信息/);
  // 键集分页：超过一页时不漏不重，不请求数量；返回重复编号时停止。
  const fakeSb = (rows, { duplicate = false } = {}) => {
    const calls = [];
    const from = () => {
      const q = { filters: {}, select(cols, opts) { q.opts = opts; return q; }, eq(k, v) { q.filters[k] = v; return q; }, gt(k, v) { q.after = v; return q; }, order() { return q; }, limit(n) { q.limit = n; calls.push({ after: q.after, limit: n, opts: q.opts }); const page = rows.filter(r => q.after === undefined || r.patient_id > q.after).slice(0, n); if (duplicate && q.after !== undefined) page[0] = rows[0]; return Promise.resolve({ data: page, error: null }); } };
      return q;
    };
    return { calls, sb: { from } };
  };
  const sorted = [...BIG_BOARD].sort((a, b) => (a.patient_id < b.patient_id ? -1 : 1));
  const keyset = fakeSb(sorted);
  const all = await data.readKeysetRows(keyset.sb, 'v_patient_followup_status', PROJECT.id, { key: 'patient_id', pageSize: 500 });
  assert.equal(all.length, 1203);
  assert.equal(new Set(all.map(r => r.patient_id)).size, 1203);
  assert.deepEqual(keyset.calls.map(c => [c.after ?? null, c.limit, c.opts ?? null]), [[null, 500, null], [sorted[499].patient_id, 500, null], [sorted[999].patient_id, 500, null]]);
  await assert.rejects(data.readKeysetRows(fakeSb(sorted, { duplicate: true }).sb, 'v_patient_followup_status', PROJECT.id, { key: 'patient_id', pageSize: 500 }), /重复/);
  const exact = fakeSb(sorted.slice(0, 1000));
  assert.equal((await data.readKeysetRows(exact.sb, 't', PROJECT.id, { key: 'patient_id', pageSize: 500 })).length, 1000);
  assert.equal(exact.calls.length, 3, '恰好整页时再读一页确认结束');
  assert.equal(board.buildFollowupLink('https://reg.example.test', 'abc_DEF-123'), 'https://reg.example.test/followup#abc_DEF-123');
  assert.equal(board.consentDateLabel('withdrawn'), '撤回日期');
  assert.equal(board.consentDateLabel('consented'), '签署日期');
  assert.equal(board.consentDateLabel('unconfirmed'), '同意状态日期');
  assert.equal(board.stateBadgeLabel({ followup_state: 'overdue', visit_count: 0 }), '尚无随访·逾期');
  assert.equal(board.stateBadgeLabel({ followup_state: 'overdue', visit_count: 3 }), '逾期');
  assert.equal(board.inactiveReason({ followup_status: 'active', consent_status: 'declined' }), '拒绝同意');
  assert.equal(board.inactiveReason({ followup_status: 'deceased', consent_status: 'withdrawn' }), '死亡');
  assert.equal(board.revokeReasonLabel('patient_exited'), '患者已拒绝或撤回同意、或已退出研究，系统自动停用');
  assert.ok(board.newLinkBlockReason({ consent_status: 'withdrawn', followup_status: 'active' }).includes('不能再发放随访链接'), '撤回同意后不发放新链接');
  assert.ok(board.newLinkBlockReason({ consent_status: 'consented', followup_status: 'deceased' }).includes('不能再发放随访链接'));
  assert.equal(board.newLinkBlockReason({ consent_status: 'unconfirmed', followup_status: 'lost' }), '', '失访患者仍可发放链接');
  assert.deepEqual(board.splitBloodPressure('130/80'), { sbp: '130', dbp: '80' });
  assert.deepEqual(board.splitBloodPressure('１３０／８０'), { sbp: '130', dbp: '80' });
  assert.equal(board.splitBloodPressure('130/8'), null, '输入未完成时不拆分');
  assert.equal(board.creatinineToUmol(1.2, 'mgdl'), 106.08);
  assert.equal(board.upcrToMgG(1.2, 'gg'), 1200);
  assert.equal(board.formatPercent(null), '—');
  assert.equal(board.visitSaveMessage({ inserted: 0, updated: 0, skipped: 1, total: 1 }, { patientCode: 'P1', visitDate: '2026-01-01' }).tone, 'info');
  assert.equal(board.visitSaveMessage({ added: 1 }, {}).saved, true, '兼容 added/changed 命名');
  assert.equal(board.visitSaveMessage({ inserted: 1, replayed: true }, {}).tone, 'info');
  const future = board.buildVisitRow({ patientCode: 'P1', visitDate: '2099-01-01', sbp: '120', dbp: '80' }, { today: '2026-01-01' });
  assert.ok(future.errors.some(e => e.field === 'date'), '不接受未来日期');
  const pii = board.buildVisitRow({ patientCode: 'P1', visitDate: '2026-01-01', sbp: '120', dbp: '80', notes: '电话13812345678' }, { today: '2026-01-01', containsPII: data.containsPII });
  assert.ok(pii.errors.some(e => e.field === 'notes'), '备注中的手机号应被拦截');
  assert.deepEqual(board.sortBoardRows(BOARD).map(r => r.patient_code), EXPECTED_ORDER);
  const visitRow = over => board.buildVisitRow({ patientCode: 'P1', visitDate: '2026-01-01', scrUnit: 'umol', upcrUnit: 'mgg', ...over }, { today: '2026-01-01' });
  assert.ok(visitRow({ upcr: '50001' }).errors.some(e => e.field === 'upcr' && e.message.includes('50000')), '随访 UPCR 上限 50000 mg/g');
  assert.ok(visitRow({ upcr: '60', upcrUnit: 'gg' }).errors.some(e => e.message.includes('看起来是 mg/g')), 'g/g 误填 mg/g 数值时提示切换单位');
  assert.equal(visitRow({ upcr: '50000' }).errors.length, 0);
  assert.ok(visitRow({ scr: '1.1' }).errors.some(e => e.field === 'scr' && e.message.includes('看起来是 mg/dL')), '血肌酐 1.1 μmol/L 提示切换为 mg/dL');
  assert.equal(board.FOLLOWUP_STATES.overdue.label, '逾期');
  assert.ok(board.renderOverviewHtml(OVERVIEWS[PROJECT.id]).includes('近 30 天随访（按随访日期）'), '概览说明按随访日期统计');
}

async function main() {
  await checkPureHelpers();
  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  try {
    // 0. 未登录：只显示登录卡片，工作台内容不进入页面，也不访问外部主机。
    {
      const mock = createMock();
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => mock.handle(route, origin, ''));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/staff.html`);
      await page.locator('#loginCard').waitFor({ state: 'visible' });
      await eventually(async () => (await page.locator('#authLoading').isHidden()), '登录状态检查未结束');
      assert.equal(await page.evaluate(() => document.getElementById('authGatedContainer').innerHTML.trim()), '', '未登录时不注入工作台');
      assert.equal(await page.locator('#appCard').count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(mock.external, [], '未登录页面不应请求外部主机');
      await context.close();
    }

    const { context, page, mock, pageErrors, dialogs } = await openWorkspace(browser, origin);

    // 1. 首屏：项目与工作台在前，资料与账户设置折叠在页面底部。
    assert.equal(await page.locator('#loginCard').isVisible(), false, '登录后不应显示登录卡片');
    assert.equal(await page.locator('#appCard').isVisible(), true, '工作台应可见');
    const layout = await page.evaluate(() => {
      const app = document.getElementById('appCard');
      const account = document.getElementById('accountDetails');
      const top = id => document.getElementById(id).getBoundingClientRect().top;
      return {
        accountIsDetails: account?.tagName === 'DETAILS', accountOpen: account?.open,
        accountAfterApp: !!(app.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING),
        projectTop: top('projectSection'), overviewTop: top('overviewSection'), boardTop: top('boardSection'), viewport: innerHeight,
        accountTop: top('accountDetails'),
      };
    });
    assert.ok(layout.accountIsDetails && layout.accountOpen === false, '“账户与资料”应为默认折叠的 <details>');
    assert.ok(layout.accountAfterApp && layout.accountTop > layout.overviewTop, '“账户与资料”应位于工作台之后');
    assert.ok(layout.projectTop < layout.viewport && layout.overviewTop < layout.viewport && layout.boardTop < layout.viewport, '项目、概览与随访看板应出现在首屏');
    assert.equal(await page.locator('#profName').isVisible(), false, '首屏不应出现研究者资料表单');
    assert.equal(await page.locator('#btnSaveProfile').isVisible(), false, '首屏不应出现资料保存按钮');
    await shot(page, '01-first-screen');
    await shot(page, '02-full-page', { fullPage: true });

    // 2. 项目概览数字。
    const metric = name => text(page.locator(`#projectOverview [data-metric="${name}"] .fu-tile-num`));
    await eventually(async () => (await metric('n_patients')) === '9', '概览未显示入组人数');
    const expectedMetrics = { n_patients: '9', n_active: '7', n_visits: '13', n_visits_30d: '3', core_completeness: '69.2%', n_overdue: '3', n_due_soon: '2', n_no_visit: '1', n_consent_confirmed: '2', n_consent_unconfirmed: '6', n_open_issues: '3' };
    for (const [name, value] of Object.entries(expectedMetrics)) assert.equal(await metric(name), value, `概览 ${name}`);

    // 3. 随访看板：逾期优先排序、状态徽章、筛选与搜索。
    assert.deepEqual(await boardCodes(page), EXPECTED_ORDER, '看板应按逾期优先排序');
    const badges = await page.locator('#patientsList tbody tr[data-patient-code] td[data-label="状态"] .fu-badge').allTextContents();
    assert.deepEqual(badges, EXPECTED_BADGES, '状态徽章');
    assert.equal(await text(page.locator('tr[data-patient-code="P009"] td[data-label="状态"]')), '已停止随访（撤回同意）', '撤回同意的患者注明原因');
    assert.equal(await text(page.locator('tr[data-patient-code="P005"] td[data-label="状态"]')), '已停止随访（失访）');
    assert.ok((await text(page.locator('tr[data-patient-code="P007"] td[data-label="下次应随访"]'))).includes('已过 110 天'), '从未随访的逾期患者显示已过天数');
    assert.equal((await text(page.locator('tr[data-patient-code="P002"] td[data-label="知情同意"]'))), '伦理批准豁免', '同意状态列');
    assert.equal((await text(page.locator('tr[data-patient-code="P001"] td[data-label="有效链接"]'))), '1', '有效链接数');
    await page.click('#boardFilters [data-board-filter="overdue"]');
    assert.deepEqual(await boardCodes(page), ['P007', 'P001', 'P006'], '逾期筛选（含从未随访但已逾期的患者）');
    await page.click('#boardFilters [data-board-filter="all"]');
    await page.fill('#patientSearch', '4');
    assert.deepEqual(await boardCodes(page), ['P004'], '按研究编号搜索');
    await page.fill('#patientSearch', '');
    await page.click('#projectOverview [data-metric="n_due_soon"]');
    assert.deepEqual(await boardCodes(page), ['P008', 'P002'], '点击概览数字应跳到对应筛选');
    assert.equal(await page.getAttribute('#boardFilters [data-board-filter="due_soon"]', 'aria-pressed'), 'true');
    await page.click('#projectOverview [data-metric="n_patients"]');
    assert.deepEqual(await boardCodes(page), EXPECTED_ORDER);

    // 4. 录入随访：130/80 自动拆分、mg/dL 换算、单行 import_registry_rows、skipped 中文提示。
    const boardReadsBeforeEntry = boardReads(mock).length;
    const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    await page.click('tr[data-patient-code="P001"] [data-act="visit"]');
    const visitModal = page.locator('[data-registry-modal="visitEntry"]');
    await visitModal.waitFor();
    assert.equal(await page.inputValue('#veCode'), 'P001');
    assert.equal(await page.getAttribute('#veCode', 'readonly'), '', '从看板进入时研究编号只读');
    assert.equal(await page.inputValue('#veDate'), today, '随访日期默认今天');
    await eventually(async () => (await text(page.locator('#veContext')))?.includes('上次记录'), '应显示上次随访记录供核对单位');
    await page.fill('#veDate', BOARD[1].baseline_date.replace(/^(\d{4})/, y => String(Number(y) - 1)));
    await page.fill('#veSbp', '120');
    await page.click('#veSave');
    assert.ok((await text(page.locator('#veFeedback'))).includes('早于该患者的基线日期'), '随访日期早于基线时应在提交前提示');
    assert.equal(mock.rpcCalls('import_registry_rows').length, 0, '前端校验未通过时不提交');
    await page.fill('#veDate', today);
    await page.fill('#veSbp', '');
    await page.fill('#veSbp', '130/80');
    await page.press('#veSbp', 'Tab');
    assert.equal(await page.inputValue('#veSbp'), '130', '收缩压应拆分为 130');
    assert.equal(await page.inputValue('#veDbp'), '80', '舒张压应拆分为 80');
    await page.selectOption('#veScrUnit', 'mgdl');
    await page.fill('#veScr', '1.2');
    assert.ok((await text(page.locator('#veScrHint'))).includes('106.08 μmol/L'), 'mg/dL 应提示换算结果');
    await page.fill('#veUpcr', '450');
    await page.fill('#veNotes', '外院复查结果补录');
    mock.importReplies.push({ inserted: 0, updated: 0, skipped: 1, total: 1, replayed: false });
    await page.click('#veSave');
    await eventually(() => mock.rpcCalls('import_registry_rows').length === 1, '没有发出 import_registry_rows 请求');
    const first = mock.rpcCalls('import_registry_rows')[0].body;
    assert.equal(first.p_project_id, PROJECT.id);
    assert.equal(first.p_kind, 'visits');
    assert.ok(Array.isArray(first.p_rows) && first.p_rows.length === 1, '一次录入应只提交一行');
    assert.deepEqual(first.p_rows[0], { patient_code: 'P001', visit_date: today, sbp: 130, dbp: 80, scr_umol_l: 106.08, upcr: 450, notes: '外院复查结果补录' });
    assert.match(first.p_batch_id, UUID_V4, 'p_batch_id 应为 UUID');
    await eventually(async () => (await text(page.locator('#veFeedback')))?.includes('没有重复保存'), 'skipped 结果应显示中文提示');
    await shot(page, '03-visit-entry-skipped');
    assert.equal(await visitModal.isVisible(), true, '重复提交提示后对话框保持打开，便于核对');
    // 数据库校验失败：显示数据库给出的中文原因；同日冲突：提供查看随访记录的入口。
    mock.importReplies.push({ postgrestError: { code: 'P0001', message: 'visit_validation_failed', details: JSON.stringify(['随访日期早于基线日期，请核对']), hint: null } });
    await page.fill('#veNotes', '外院复查结果补录（核对后）');
    await page.click('#veSave');
    await eventually(async () => (await text(page.locator('#veFeedback')))?.includes('随访日期早于基线日期，请核对'), '应显示数据库校验的中文原因');
    assert.ok((await text(page.locator('#veFeedback'))).includes('随访数据未通过系统校验'));
    mock.importReplies.push({ postgrestError: { code: 'P0001', message: 'row_1_same_day_record_conflict', details: null, hint: '同一患者同日已有不同数据，请先在记录纠错中核实；本批次未写入。' } });
    await page.click('#veSave');
    await eventually(async () => (await text(page.locator('#veFeedback')))?.includes('同一天只保留一条'), '同日冲突应显示中文提示');
    assert.ok(!(await text(page.locator('#veFeedback'))).includes('第 2 行'), '单条录入不显示 CSV 行号');
    assert.equal(await page.locator('#veFeedback button', { hasText: '查看该患者随访记录' }).count(), 1, '同日冲突应提供查看随访记录的入口');
    assert.equal(await visitModal.isVisible(), true);
    // 保存并录下一位：新内容使用新的提交编号；网络中断后重试同一内容沿用同一提交编号（服务器据此去重）。
    await page.fill('#veUpcr', '460');
    mock.importReplies.push({ abort: true });
    await page.click('#veSaveNext');
    await eventually(async () => (await text(page.locator('#veFeedback')))?.includes('网络连接失败'), '网络中断应显示中文提示');
    assert.ok(!/fetch|Error/i.test(await text(page.locator('#veFeedback'))), '不显示英文原文');
    assert.equal(await page.inputValue('#veUpcr'), '460', '网络中断后保留已填内容，便于重试');
    await page.click('#veSaveNext');
    await eventually(() => mock.rpcCalls('import_registry_rows').length === 5, '重试没有提交');
    const [failed, second] = mock.rpcCalls('import_registry_rows').slice(3).map(r => r.body);
    assert.match(second.p_batch_id, UUID_V4);
    assert.equal(second.p_batch_id, failed.p_batch_id, '网络失败后重试应沿用同一 p_batch_id');
    assert.deepEqual(second.p_rows, failed.p_rows);
    assert.notEqual(second.p_batch_id, first.p_batch_id, '内容不同应使用新的提交编号');
    await eventually(async () => (await page.inputValue('#veCode')) === '' && (await page.inputValue('#veSbp')) === '', '保存后应清空表单');
    assert.equal(await page.getAttribute('#veCode', 'readonly'), null, '录下一位时研究编号可编辑');
    assert.equal(await page.inputValue('#veDate'), today, '录下一位时保留随访日期');
    assert.ok((await text(page.locator('#veFeedback'))).includes('已保存'), '应提示已保存');
    // 录下一位后，上一位患者迟到的“上次记录”不得显示在下一位下面。
    const releaseLastVisit = mock.hold('visits_long', 'P001');
    await page.fill('#veCode', 'P001');
    await page.press('#veCode', 'Tab');
    await eventually(async () => (await text(page.locator('#veContext')))?.includes('最近随访'), '应显示该患者的看板信息');
    await page.fill('#veSbp', '126');
    await page.fill('#veDbp', '76');
    await page.click('#veSaveNext');
    await eventually(() => mock.rpcCalls('import_registry_rows').length === 6, '第二位没有提交');
    await eventually(async () => (await page.inputValue('#veCode')) === '', '保存后应清空表单');
    releaseLastVisit();
    await page.waitForTimeout(300);
    assert.equal(await text(page.locator('#veContext')), '', '迟到的上次记录不得显示在下一位患者下面');
    await page.click('[data-registry-modal="visitEntry"] .fu-modal-close');
    await visitModal.waitFor({ state: 'detached' });
    // 保存后只重新读取该患者一行（按项目 + 研究编号），不全量重读看板。
    await eventually(() => boardReads(mock).length > boardReadsBeforeEntry, '保存后应刷新该患者的看板行');
    const entryReads = boardReads(mock).slice(boardReadsBeforeEntry);
    assert.ok(entryReads.every(r => r.params.get('patient_code') === 'eq.P001' && r.params.get('project_id') === `eq.${PROJECT.id}`), `保存后只应发出单患者查询：${entryReads.map(r => r.search).join(' | ')}`);

    // 5. 随访链接：列表不含任何链接文本；新链接只显示一次；撤销按 id 并要求原因。
    await page.click('tr[data-patient-code="P001"] [data-act="links"]');
    const linkRows = page.locator('#lkList tbody tr');
    await eventually(async () => (await linkRows.count()) === 4, '链接列表应有 4 行');
    const states = (await page.locator('#lkList tbody .fu-badge').allTextContents()).sort();
    assert.deepEqual(states, ['已使用', '已撤销', '已过期', '有效'].sort(), '链接状态');
    const tokenQuery = mock.requests.find(r => r.path === '/rest/v1/patient_tokens');
    const columns = (tokenQuery.params.get('select') || '').split(',');
    assert.ok(columns.length > 1 && !columns.includes('token') && !columns.includes('token_hash') && !columns.includes('*'), '读取链接时不得请求 token/token_hash 列');
    let html = await page.content();
    assert.ok(!html.includes(SECRET_TEXT) && !html.includes(SECRET_HASH), '页面不得显示链接文本或摘要');
    await page.fill('#lkDays', '14');
    // “同时撤销此前仍有效的链接”默认不勾选（勾选后的行为见 tests/ui/board-actions-smoke.mjs）；本段逐条检查手动撤销。
    assert.equal(await page.isChecked('#lkRevokeOld'), false, '默认不同时撤销此前仍有效的链接');
    await page.click('#lkCreate');
    await eventually(() => mock.rpcCalls('create_patient_token_v2').length === 1, '没有调用 create_patient_token_v2');
    assert.deepEqual(mock.rpcCalls('create_patient_token_v2')[0].body, { p_project_id: PROJECT.id, p_patient_code: 'P001', p_expires_in_days: 14, p_single_use: true });
    await eventually(async () => (await page.inputValue('#lkOnceLink')) === `${origin}/followup#${NEW_TOKEN}`, '新链接应为站点根下的 /followup#…，并在生成后显示一次');
    await eventually(() => mock.requests.filter(r => r.path === '/rest/v1/patient_tokens').length >= 2, '生成后应刷新链接列表');
    assert.ok(!(await text(page.locator('#lkList'))).includes(NEW_TOKEN), '链接列表不得显示新链接全文');
    assert.equal(await page.locator('#lkPreview').count(), 0, '不提供“打开随访页预览”（会把链接留在浏览器历史中）');
    const newTokenId = mock.tokens[0].id;
    await eventually(async () => (await text(page.locator(`#lkList tr[data-token-id="${newTokenId}"]`)))?.includes('刚才生成'), '列表中应标出刚生成的链接');
    assert.ok((await page.inputValue('#lkOnceMsg')).includes(`${origin}/followup#${NEW_TOKEN}`), '发送文本含链接');
    await shot(page, '04-links');
    await page.click(`#lkList [data-revoke-id="${TOKENS[0].id}"]`);
    await page.click('#lkRevokeConfirm');
    assert.ok((await text(page.locator('#lkFeedback'))).includes('请填写撤销原因'), '撤销应要求原因');
    assert.equal(mock.rpcCalls('revoke_patient_token_by_id').length, 0);
    await page.fill('#lkReason', '发错对象，已重新生成');
    await page.click('#lkRevokeConfirm');
    await eventually(() => mock.rpcCalls('revoke_patient_token_by_id').length === 1, '没有调用 revoke_patient_token_by_id');
    assert.deepEqual(mock.rpcCalls('revoke_patient_token_by_id')[0].body, { p_project_id: PROJECT.id, p_token_id: TOKENS[0].id, p_reason: '发错对象，已重新生成' });
    assert.equal(mock.rpcCalls('revoke_patient_token').length, 0, '不得再使用按明文撤销的旧接口');
    await eventually(async () => (await text(page.locator('#lkFeedback')))?.includes('链接已撤销'), '撤销后应提示已撤销');
    html = await page.content();
    assert.ok(!html.includes(SECRET_TEXT) && !html.includes(SECRET_HASH), '页面不得显示链接文本或摘要');
    assert.equal(await page.inputValue('#lkOnceLink'), `${origin}/followup#${NEW_TOKEN}`, '撤销其他链接时，刚生成的链接仍可复制');
    // 撤销刚生成的链接：一次性展示面板与明文立即移除。
    await eventually(() => page.locator(`#lkList [data-revoke-id="${newTokenId}"]`).isVisible(), '刚生成的链接应可撤销');
    await page.click(`#lkList [data-revoke-id="${newTokenId}"]`);
    await page.fill('#lkReason', '发错对象');
    await page.click('#lkRevokeConfirm');
    await eventually(() => mock.rpcCalls('revoke_patient_token_by_id').length === 2, '没有撤销刚生成的链接');
    await eventually(async () => (await page.locator('#lkOnce').isHidden()) && (await page.locator('#lkOnceLink').count()) === 0, '撤销后应移除一次性展示面板');
    assert.ok((await text(page.locator('#lkFeedback'))).includes('已从页面移除'));
    assert.equal(await pageHas(page, NEW_TOKEN), false, '撤销后页面不得再有该链接全文');
    // 再生成一条，关闭对话框后链接全文同样从页面清除。
    await page.click('#lkCreate');
    await eventually(async () => (await page.locator('#lkOnceLink').count()) === 1 && (await page.inputValue('#lkOnceLink')).includes(NEW_TOKEN), '再次生成后应显示新链接');
    await page.keyboard.press('Escape');
    await page.locator('[data-registry-modal="links"]').waitFor({ state: 'detached' });
    assert.equal(await pageHas(page, NEW_TOKEN), false, '关闭对话框后页面不得再有链接全文');
    const linkReads = boardReads(mock).slice(boardReadsBeforeEntry);
    assert.ok(linkReads.every(r => r.params.get('patient_code')), '生成或撤销链接后只刷新该患者一行');

    // 5b. 已撤回同意的患者不再发放链接；服务器拒绝时显示中文原因。
    await page.click('tr[data-patient-code="P009"] [data-act="links"]');
    await page.locator('#lkList').waitFor();
    assert.equal(await page.locator('#lkCreate').isDisabled(), true, '撤回同意的患者不能生成新链接');
    assert.ok((await text(page.locator('#lkFeedback'))).includes('不能再发放随访链接'));
    await page.keyboard.press('Escape');
    await page.locator('[data-registry-modal="links"]').waitFor({ state: 'detached' });
    await page.click('tr[data-patient-code="P002"] [data-act="links"]');
    await page.locator('#lkCreate').waitFor();
    await page.click('#lkCreate');
    await eventually(async () => (await text(page.locator('#lkFeedback')))?.startsWith('生成失败：'), '服务器拒绝时应提示');
    const refused = await text(page.locator('#lkFeedback'));
    assert.ok(refused.includes('不能再发放随访链接') && !/patient_|eligible/.test(refused), refused);
    assert.equal(await page.locator('#lkOnceLink').count(), 0, '被拒绝时不显示链接');
    await page.keyboard.press('Escape');
    await page.locator('[data-registry-modal="links"]').waitFor({ state: 'detached' });

    // 6. 研究状态：改为失访须填写原因，调用 set_patient_study_status。
    await page.click('tr[data-patient-code="P006"] [data-act="status"]');
    await page.locator('#ssFollowup').waitFor();
    await page.selectOption('#ssFollowup', 'lost');
    await page.click('#ssSave');
    assert.ok((await text(page.locator('#ssFeedback'))).includes('请填写修改原因'), '停止随访应要求原因');
    await page.fill('#ssReason', '多次电话联系未果');
    await shot(page, '05-study-status');
    await page.click('#ssSave');
    await eventually(() => mock.rpcCalls('set_patient_study_status').length === 1, '没有调用 set_patient_study_status');
    assert.deepEqual(mock.rpcCalls('set_patient_study_status')[0].body, { p_project_id: PROJECT.id, p_patient_code: 'P006', p_changes: { followup_status: 'lost' }, p_reason: '多次电话联系未果' });
    await page.locator('[data-registry-modal="studyStatus"]').waitFor({ state: 'detached' });
    // 撤回同意：提示链接将被自动撤销，并建议同时改为“退出研究”；清空的版本按接口约定传空字符串。
    await page.click('tr[data-patient-code="P003"] [data-act="status"]');
    await page.locator('#ssConsent').waitFor();
    assert.equal(await page.inputValue('#ssConsentVersion'), 'V1.0');
    assert.equal(await page.locator('#ssExitHint').isVisible(), false);
    assert.equal(await text(page.locator('#ssConsentDateLabel')), '签署日期');
    assert.equal(await page.inputValue('#ssConsentDate'), dayOffset(-390));
    await page.selectOption('#ssConsent', 'withdrawn');
    assert.equal(await text(page.locator('#ssConsentDateLabel')), '撤回日期', '日期标签随同意状态变化');
    assert.equal(await page.inputValue('#ssConsentDate'), '', '改选状态后清空原签署日期，等待填写撤回日期');
    await page.fill('#ssConsentDate', today);
    assert.equal(await page.locator('#ssLinkNote').isVisible(), true, '撤回同意应提示链接将被自动撤销');
    assert.ok((await text(page.locator('#ssLinkNote'))).includes('该患者的有效随访链接将被自动撤销'));
    assert.equal(await page.locator('#ssExitHint').isVisible(), true, '撤回同意时建议同时改为退出研究');
    await page.click('#ssExitApply');
    assert.equal(await page.inputValue('#ssFollowup'), 'withdrawn');
    await page.fill('#ssConsentVersion', '');
    await page.fill('#ssReason', '患者书面撤回同意');
    const dialogCount = dialogs.length;
    await page.click('#ssSave');
    await eventually(() => mock.rpcCalls('set_patient_study_status').length === 2, '撤回同意没有提交');
    assert.ok(dialogs.slice(dialogCount).some(m => m.includes('有效随访链接将被自动撤销')), '提交前应再次确认链接将被撤销');
    assert.deepEqual(mock.rpcCalls('set_patient_study_status')[1].body, { p_project_id: PROJECT.id, p_patient_code: 'P003', p_changes: { consent_status: 'withdrawn', consent_date: today, consent_version: '', followup_status: 'withdrawn' }, p_reason: '患者书面撤回同意' });
    await page.locator('[data-registry-modal="studyStatus"]').waitFor({ state: 'detached' });
    // 从“撤回”改回“已同意”（离开退出状态）同样必须填写原因。
    await page.click('tr[data-patient-code="P009"] [data-act="status"]');
    await page.locator('#ssConsent').waitFor();
    await page.selectOption('#ssConsent', 'consented');
    assert.ok((await text(page.locator('#ssReasonNote'))).includes('本次修改必填'), '改回时标明原因必填');
    await page.fill('#ssConsentDate', today);
    await page.click('#ssSave');
    assert.ok((await text(page.locator('#ssFeedback'))).includes('改回'), '离开退出状态未填原因应提示');
    assert.equal(mock.rpcCalls('set_patient_study_status').length, 2, '缺少原因时不提交');
    await page.fill('#ssReason', '患者重新签署知情同意书');
    await page.click('#ssSave');
    await eventually(() => mock.rpcCalls('set_patient_study_status').length === 3, '重新同意没有提交');
    assert.deepEqual(mock.rpcCalls('set_patient_study_status')[2].body, { p_project_id: PROJECT.id, p_patient_code: 'P009', p_changes: { consent_status: 'consented', consent_date: today }, p_reason: '患者重新签署知情同意书' });
    await page.locator('[data-registry-modal="studyStatus"]').waitFor({ state: 'detached' });
    const statusReads = boardReads(mock).slice(boardReadsBeforeEntry);
    assert.ok(statusReads.some(r => r.params.get('patient_code') === 'eq.P009') && statusReads.every(r => r.params.get('patient_code')), '修改研究状态后只刷新该患者一行');

    // 7. 项目设置（负责人）。
    assert.equal(await page.locator('#projectSettingsDetails').isHidden(), false, '负责人应能看到项目设置');
    await page.click('#projectSettingsDetails > summary');
    assert.equal(await page.inputValue('#setInterval'), '90');
    await page.click('#projectInfoDetails > summary');
    await page.locator('#projectSettingsDetails').scrollIntoViewIfNeeded();
    await shot(page, '08-project-folds');
    await page.fill('#setInterval', '60');
    await page.click('#btnSaveSettings');
    await eventually(() => mock.rpcCalls('set_project_settings').length === 1, '没有调用 set_project_settings');
    assert.deepEqual(mock.rpcCalls('set_project_settings')[0].body, { p_project_id: PROJECT.id, p_settings: { followup_interval_days: 60 } });

    // 7b. 记录更正：原因须为 3–500 字，数值按数据库范围先行检查，保存后只刷新该患者。
    await page.click('tr[data-patient-code="P001"] [data-act="history"]');
    await page.locator(`[data-registry-modal="history"] [data-visit-id="${LAST_VISIT.id}"]`).click();
    await page.locator('#editReason').waitFor();
    assert.equal(await page.inputValue('#edit_sbp'), '128');
    await page.fill('#edit_sbp', '125');
    await page.fill('#editReason', '改');
    await page.click('#editSave');
    assert.ok((await text(page.locator('#editFeedback'))).includes('3–500 字'), '更正原因不足 3 字应提示');
    await page.fill('#edit_sbp', '350');
    await page.fill('#editReason', '核对原始血压记录');
    await page.click('#editSave');
    assert.ok((await text(page.locator('#editFeedback'))).includes('40–300 mmHg'), '更正数值超出数据库范围应提示');
    assert.equal(mock.rpcCalls('correct_registry_record').length, 0, '前端校验未通过时不提交更正');
    await page.fill('#edit_sbp', '125');
    const readsBeforeCorrection = boardReads(mock).length;
    await page.click('#editSave');
    await eventually(() => mock.rpcCalls('correct_registry_record').length === 1, '没有提交更正');
    assert.deepEqual(mock.rpcCalls('correct_registry_record')[0].body, { p_project_id: PROJECT.id, p_table: 'visits_long', p_record_id: LAST_VISIT.id, p_changes: { sbp: 125 }, p_reason: '核对原始血压记录' });
    await page.locator('[data-registry-modal="editor"]').waitFor({ state: 'detached' });
    await eventually(() => boardReads(mock).length > readsBeforeCorrection, '更正后应刷新该患者');
    assert.ok(boardReads(mock).slice(readsBeforeCorrection).every(r => r.params.get('patient_code') === 'eq.P001'), '更正后只刷新该患者一行');

    // 7c. CSV 随访导入：预览中逐行提示错误并阻止导入；确认后整批提交，网络失败重试沿用同一批次编号。
    await page.selectOption('#importType', 'visits');
    const csv = lines => ({ name: 'visits.csv', mimeType: 'text/csv', buffer: Buffer.from(['patient_code,visit_date,sbp,dbp,scr_umol_l,upcr,egfr,notes', ...lines].join('\n')) });
    await page.setInputFiles('#importFile', csv([`P001,${today},128,78,,,,`, `P002,${today},,,1.1,,,`, `P003,${today},,,,,,只有备注`, `P004,${today},350,80,,,,`]));
    await page.locator('#importPreview').waitFor({ state: 'visible' });
    const previewErrors = await text(page.locator('#importTable .warnbox'));
    assert.ok(previewErrors.includes('第3行') && previewErrors.includes('mg/dL'), `血肌酐单位错误应在预览中提示：${previewErrors}`);
    assert.ok(previewErrors.includes('第4行') && previewErrors.includes('至少填写一项测量值'), previewErrors);
    assert.ok(previewErrors.includes('第5行') && previewErrors.includes('40–300 mmHg'), previewErrors);
    assert.ok(!previewErrors.includes('第2行'), '只填血压的行可以导入');
    assert.equal(await page.locator('#btnConfirmImport').isDisabled(), true, '有错误时不能确认导入');
    await page.setInputFiles('#importFile', csv([`P001,${today},128,78,,,,`, `P002,${today},,,92,45000,,外院复查`]));
    await eventually(async () => !(await page.locator('#btnConfirmImport').isDisabled()), '无错误时应可确认导入');
    assert.ok((await text(page.locator('#importSummary'))).includes('2 行，0 行需修正'));
    await page.click('#btnConfirmImport');
    assert.equal(mock.rpcCalls('import_registry_rows').length, 6, '未确认单位时不提交');
    await page.check('#importUnitsConfirm');
    mock.importReplies.push({ abort: true });
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importProgress')))?.includes('未确认完成'), '网络失败应提示保留批次');
    assert.ok((await text(page.locator('#importProgress'))).includes('网络连接失败'));
    mock.importReplies.push({ inserted: 2, updated: 0, skipped: 0, total: 2, replayed: false });
    await page.click('#btnConfirmImport');
    await eventually(async () => (await text(page.locator('#importProgress')))?.includes('导入成功'), '重试后应导入成功');
    const [csvFailed, csvRetry] = mock.rpcCalls('import_registry_rows').slice(6).map(r => r.body);
    assert.equal(csvRetry.p_batch_id, csvFailed.p_batch_id, 'CSV 导入重试沿用同一批次编号');
    assert.equal(csvRetry.p_kind, 'visits');
    assert.deepEqual(csvRetry.p_rows, [{ patient_code: 'P001', visit_date: today, sbp: 128, dbp: 78 }, { patient_code: 'P002', visit_date: today, scr_umol_l: 92, upcr: 45000, notes: '外院复查' }]);

    // 8. 基因数据默认隐藏，且不读取基因表。
    assert.equal(await page.locator('#geneticsSection').isVisible(), false, '基因录入默认隐藏');
    assert.equal(await page.locator('#btnExportVariants').isVisible(), false, '“导出基因变异”默认隐藏');
    assert.equal(await text(page.locator('#geneticsDisabledNote')), '基因数据涉及人类遗传资源管理，完成合规评估后由管理员开启。');
    assert.equal(mock.requests.filter(r => r.path === '/rest/v1/variants_long').length, 0, '未开启时不应读取基因数据');

    // 9. 无随访的项目：完整率显示“—”。
    await page.click(`#projectsList .pill:has-text("${EMPTY_PROJECT.name}")`);
    await eventually(async () => (await metric('core_completeness')) === '—', '无随访时完整率应显示“—”');
    assert.ok((await text(page.locator('#patientsList'))).includes('还没有患者'));

    // 10. 页面文字不出现表名或旧术语。
    const visible = await page.evaluate(() => document.body.innerText);
    for (const banned of ['patients_baseline', 'visits_long', 'patient_tokens', 'Token', '令牌', 'NEJM', '后台', '质控 Issue', 'patient_code']) assert.ok(!visible.includes(banned), `页面不应出现“${banned}”`);

    // 10b. 退出登录：页面上不再有邮箱、账户徽章、研究编号或链接（对话框中刚生成的链接也一并清除）。
    await page.click(`#projectsList .pill:has-text("${PROJECT.name}")`);
    await page.locator('tr[data-patient-code="P001"]').waitFor();
    await page.click('tr[data-patient-code="P001"] [data-act="links"]');
    await page.click('#lkCreate');
    await eventually(async () => (await page.locator('#lkOnceLink').count()) === 1, '应显示新链接');
    assert.equal(await pageHas(page, NEW_TOKEN), true);
    await page.evaluate(() => document.getElementById('btnHeaderSignOut').click());
    await page.locator('#loginCard').waitFor({ state: 'visible' });
    await eventually(async () => (await text(page.locator('#headerUserEmail'))) === '', '退出后应清除页面上的邮箱');
    assert.equal(await text(page.locator('#trialBadge')), '', '退出后应清除账户徽章');
    for (const needle of [USER.email, 'P001', 'P009', NEW_TOKEN, PROJECT.name]) assert.equal(await pageHas(page, needle), false, `退出后页面仍有“${needle}”`);
    assert.equal(await page.evaluate(() => document.getElementById('authGatedContainer').childElementCount), 0);

    assert.deepEqual(pageErrors, [], '页面不应有未捕获异常');
    assert.deepEqual(mock.external, [], '不应请求 Supabase 以外的外部主机');
    assert.deepEqual(mock.unknown, [], '不应调用未模拟的接口');
    await context.close();

    // 11. 开启 CONFIG.FEATURES.GENETICS 后显示基因数据（只修改测试中返回的 config.js）。
    const genetic = await openWorkspace(browser, origin, { configOverride: 'window.CONFIG.FEATURES = Object.assign({}, window.CONFIG.FEATURES, { GENETICS: true });' });
    await eventually(() => genetic.page.locator('#geneticsSection').isVisible(), '开启后应显示基因录入');
    assert.equal(await genetic.page.locator('#btnExportVariants').isVisible(), true, '开启后应显示“导出基因变异”');
    assert.equal(await genetic.page.locator('#geneticsDisabledNote').isVisible(), false);
    await eventually(() => genetic.mock.requests.some(r => r.path === '/rest/v1/variants_long'), '开启后应读取基因数据');
    assert.deepEqual(genetic.pageErrors, []);
    assert.deepEqual(genetic.mock.external, []);
    await genetic.context.close();

    // 12. 只读协作人：不显示随访链接，写操作不可用，项目设置隐藏，也不读取链接表。
    const viewer = await openWorkspace(browser, origin, { access: { role: 'viewer', can_read: true, can_write: false, can_export: false, can_manage_tokens: false, can_manage_members: false, can_manage_project: false, write_block_reason: 'role_read_only' } });
    const headers = await viewer.page.locator('#patientsList thead th').allTextContents();
    assert.ok(!headers.includes('有效链接'), '只读协作人不显示有效链接列');
    assert.equal(await viewer.page.locator('#patientsList [data-act="links"]').count(), 0, '只读协作人不显示随访链接操作');
    assert.ok(await viewer.page.locator('#patientsList [data-act="visit"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => n.disabled)), '只读协作人不能录入随访');
    assert.ok(await viewer.page.locator('#patientsList [data-act="status"]').evaluateAll(nodes => nodes.every(n => n.disabled)), '只读协作人不能修改研究状态');
    assert.equal(await viewer.page.locator('#patientsList [data-act="history"]').first().isEnabled(), true, '只读协作人可以查看随访记录');
    assert.equal(await viewer.page.locator('#btnOpenVisitEntry').isDisabled(), true);
    assert.equal(await viewer.page.locator('#projectSettingsDetails').isHidden(), true, '非负责人不显示项目设置');
    assert.equal(viewer.mock.requests.filter(r => r.path === '/rest/v1/patient_tokens').length, 0, '只读协作人不读取链接表');
    assert.ok((await text(viewer.page.locator('#projectAccessStatus'))).includes('只读协作人'));
    assert.deepEqual(viewer.pageErrors, []);
    await viewer.context.close();

    // 12b. 账户只读（试用到期）：负责人仍可登记撤回同意或停止随访，其他研究状态修改不开放。
    const expired = await openWorkspace(browser, origin, { access: { ...ACCESS, can_write: false, can_manage_tokens: false, write_block_reason: 'subscription_required' } });
    assert.ok(await expired.page.locator('#patientsList [data-act="visit"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => n.disabled)), '只读期间不能录入随访');
    assert.ok(await expired.page.locator('#patientsList [data-act="status"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => !n.disabled)), '只读期间负责人仍可打开研究状态');
    await expired.page.click('tr[data-patient-code="P006"] [data-act="status"]');
    await expired.page.locator('#ssExitOnly').waitFor();
    const optionValues = selector => expired.page.locator(`${selector} option`).evaluateAll(nodes => nodes.map(n => n.value));
    assert.deepEqual(await optionValues('#ssConsent'), ['unconfirmed', 'declined', 'withdrawn'], '只读期间同意状态只能改为拒绝或撤回');
    assert.deepEqual(await optionValues('#ssFollowup'), ['active', 'lost', 'withdrawn', 'deceased', 'kidney_failure', 'transferred']);
    assert.equal(await expired.page.locator('#ssConsentVersion').isDisabled(), true, '只读期间不能修改同意书版本');
    assert.equal(await expired.page.locator('#ssConsentDate').isDisabled(), true, '未改为拒绝/撤回时不能单独修改同意日期');
    assert.equal(await expired.page.locator('#ssFollowupDate').isDisabled(), true);
    await expired.page.selectOption('#ssFollowup', 'withdrawn');
    assert.equal(await expired.page.locator('#ssFollowupDate').isDisabled(), false);
    await expired.page.fill('#ssFollowupDate', today);
    await expired.page.fill('#ssReason', '患者要求退出研究');
    await expired.page.click('#ssSave');
    await eventually(() => expired.mock.rpcCalls('set_patient_study_status').length === 1, '只读期间没有提交退出登记');
    assert.deepEqual(expired.mock.rpcCalls('set_patient_study_status')[0].body, { p_project_id: PROJECT.id, p_patient_code: 'P006', p_changes: { followup_status: 'withdrawn', followup_status_date: today }, p_reason: '患者要求退出研究' });
    await expired.page.locator('[data-registry-modal="studyStatus"]').waitFor({ state: 'detached' });
    assert.deepEqual(expired.pageErrors, []);
    assert.deepEqual(expired.mock.unknown, []);
    await expired.context.close();

    // 12c. 分析协作人：可查看与导出，不显示随访链接，不能录入、更正或修改研究状态。
    const analyst = await openWorkspace(browser, origin, { access: { role: 'analyst', can_read: true, can_write: false, can_export: true, can_manage_tokens: false, can_manage_members: false, can_manage_project: false, write_block_reason: 'role_read_only' } });
    {
      const p = analyst.page;
      assert.ok(!(await p.locator('#patientsList thead th').allTextContents()).includes('有效链接'), '分析协作人不显示有效链接列');
      assert.equal(await p.locator('#patientsList [data-act="links"]').count(), 0, '分析协作人不显示随访链接操作');
      assert.ok(await p.locator('#patientsList [data-act="visit"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => n.disabled)), '分析协作人不能录入随访');
      assert.ok(await p.locator('#patientsList [data-act="status"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => n.disabled)), '分析协作人不能修改研究状态');
      assert.equal(await p.locator('#patientsList [data-act="history"]').first().isEnabled(), true);
      for (const id of ['#btnOpenVisitEntry', '#btnCreatePatient', '#importFile', '#btnConfirmImport']) assert.equal(await p.locator(id).isDisabled(), true, `分析协作人 ${id} 应不可用`);
      for (const id of ['#btnExportBaseline', '#btnExportVisits', '#btnPaperPack', '#btnCreateSnapshot']) assert.equal(await p.locator(id).isDisabled(), false, `分析协作人 ${id} 应可用`);
      assert.equal(await p.locator('#projectSettingsDetails').isHidden(), true);
      assert.ok((await text(p.locator('#projectAccessStatus'))).includes('分析协作人'));
      assert.equal(analyst.mock.requests.filter(r => r.path === '/rest/v1/patient_tokens').length, 0);
      assert.deepEqual(analyst.pageErrors, []);
      assert.deepEqual(analyst.mock.unknown, []);
    }
    await analyst.context.close();

    // 12d. 录入协作人：可录入、管理随访链接和研究状态，不能导出或修改项目设置。
    const editor = await openWorkspace(browser, origin, { access: { role: 'editor', can_read: true, can_write: true, can_export: false, can_manage_tokens: true, can_manage_members: false, can_manage_project: false, write_block_reason: null } });
    {
      const p = editor.page;
      assert.ok((await p.locator('#patientsList thead th').allTextContents()).includes('有效链接'), '录入协作人显示有效链接列');
      assert.ok(await p.locator('#patientsList [data-act="links"]').count() > 0, '录入协作人可管理随访链接');
      assert.ok(await p.locator('#patientsList [data-act="visit"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => !n.disabled)), '录入协作人可录入随访');
      assert.ok(await p.locator('#patientsList [data-act="status"]').evaluateAll(nodes => nodes.length > 0 && nodes.every(n => !n.disabled)), '录入协作人可修改研究状态');
      for (const id of ['#btnOpenVisitEntry', '#btnCreatePatient', '#importFile']) assert.equal(await p.locator(id).isDisabled(), false, `录入协作人 ${id} 应可用`);
      for (const id of ['#btnExportBaseline', '#btnExportVisits', '#btnPaperPack', '#btnCreateSnapshot']) assert.equal(await p.locator(id).isDisabled(), true, `录入协作人 ${id} 应不可用`);
      assert.equal(await p.locator('#projectSettingsDetails').isHidden(), true, '录入协作人不显示项目设置');
      assert.ok((await text(p.locator('#projectAccessStatus'))).includes('录入协作人'));
      await p.click('tr[data-patient-code="P001"] [data-act="links"]');
      assert.equal(await p.locator('#lkCreate').isDisabled(), false, '录入协作人可生成链接');
      await p.keyboard.press('Escape');
      assert.deepEqual(editor.pageErrors, []);
    }
    await editor.context.close();

    // 12e. 从 /staff 与 /staff/ 打开工作台：生成的链接都是站点根下的 /followup#…（不是 /staff/followup）。
    for (const entry of ['/staff', '/staff/']) {
      const w = await openWorkspace(browser, origin, { path: entry });
      await w.page.click('tr[data-patient-code="P001"] [data-act="links"]');
      await w.page.click('#lkCreate');
      await eventually(async () => (await w.page.locator('#lkOnceLink').count()) === 1, `${entry}：应显示新链接`);
      assert.equal(await w.page.inputValue('#lkOnceLink'), `${origin}/followup#${NEW_TOKEN}`, `从 ${entry} 打开时链接应固定为 /followup#…`);
      assert.deepEqual(w.pageErrors, []);
      await w.context.close();
    }

    // 12f. 超过一页的看板：按 patient_id 键集分页，不漏不重，不逐页计数，不使用 OFFSET。
    const big = await openWorkspace(browser, origin, { data: BIG_DATA });
    {
      const p = big.page;
      await eventually(async () => (await text(p.locator('#patientsList .fu-board-summary')))?.includes('共 1203 位患者'), '看板应读取全部 1203 位患者');
      assert.equal(await text(p.locator('#boardFilters [data-board-filter="all"] .fu-filter-count')), '1203');
      const reads = boardReads(big.mock);
      assert.equal(reads.length, 3, `1203 行应分 3 页读取：${reads.map(r => r.search).join(' | ')}`);
      const sorted = [...BIG_BOARD].sort((a, b) => (a.patient_id < b.patient_id ? -1 : 1));
      assert.deepEqual(reads.map(r => r.params.get('patient_id')), [null, `gt.${sorted[499].patient_id}`, `gt.${sorted[999].patient_id}`], '下一页从上一页最后一个 patient_id 之后开始');
      for (const r of reads) {
        assert.equal(r.params.get('limit'), '500');
        assert.equal(r.params.get('order'), 'patient_id.asc');
        assert.equal(r.params.get('offset'), null, '不使用 OFFSET 分页');
        assert.ok(!/count=/.test(r.headers.prefer || ''), '看板读取不逐页计数');
      }
      assert.equal(big.mock.served.length, 1203);
      assert.equal(new Set(big.mock.served).size, 1203, '分页不重复');
      // 保存一次随访：只发出单患者查询。
      const before = boardReads(big.mock).length;
      await p.click('#btnOpenVisitEntry');
      await p.fill('#veCode', 'S0777');
      await p.press('#veCode', 'Tab');
      await p.fill('#veSbp', '120');
      await p.fill('#veDbp', '70');
      await p.click('#veSave');
      await eventually(() => boardReads(big.mock).length > before, '保存后应刷新该患者');
      await p.waitForTimeout(200);
      const after = boardReads(big.mock).slice(before);
      assert.ok(after.length === 1 && after[0].params.get('patient_code') === 'eq.S0777', `保存后只应读取该患者：${after.map(r => r.search).join(' | ')}`);
      assert.deepEqual(big.pageErrors, []);
    }
    await big.context.close();

    // 12g. 恶意内容（项目名、中心代码、项目设置、研究编号、撤销原因、随访备注、同意书版本）只显示为文字，不执行。
    const hostile = await openWorkspace(browser, origin, { data: HOSTILE_DATA });
    {
      const p = hostile.page;
      await p.click('#projectInfoDetails > summary');
      await p.click('#projectSettingsDetails > summary');
      assert.equal(await p.inputValue('#setContact'), HOSTILE_PROJECT.contact_display, '项目设置原样显示在输入框中');
      await p.locator('#patientsList [data-act="links"]').first().click();
      await eventually(async () => (await text(p.locator('#lkList')))?.includes('<img'), '撤销原因应显示为文字');
      await p.click('#lkCreate');
      await eventually(async () => (await p.locator('#lkOnceMsg').count()) === 1, '应生成链接');
      assert.ok((await p.inputValue('#lkOnceMsg')).includes(HOSTILE_PROJECT.contact_display), '发送文本中的联系方式为原文');
      await p.keyboard.press('Escape');
      await p.locator('#patientsList [data-act="history"]').first().click();
      await p.locator('[data-registry-modal="history"] [data-visit-id]').first().click();
      await p.locator('#edit_notes').waitFor();
      assert.equal(await p.inputValue('#edit_notes'), HOSTILE_DATA.visits[0].notes, '随访备注原样显示在输入框中');
      await p.click('#editCancel');
      await p.locator('#patientsList [data-act="status"]').first().click();
      await p.locator('#ssConsentVersion').waitFor();
      assert.equal(await p.inputValue('#ssConsentVersion'), HOSTILE_DATA.baselines[HOSTILE_CODE].consent_version, '同意书版本原样显示');
      await p.keyboard.press('Escape');
      await p.locator('#patientsList [data-act="visit"]').first().click();
      await eventually(async () => (await text(p.locator('#veContext')))?.includes('上次记录'), '应显示上次记录');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
      const state = await p.evaluate(() => ({
        xss: window.__xss || null,
        handlers: document.querySelectorAll('[onerror],[onload]').length,
        jsLinks: [...document.querySelectorAll('a')].filter(a => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length,
        injected: document.querySelectorAll('img[src="x"], svg[onload]').length,
        projects: document.getElementById('projectsList').textContent,
        meta: document.getElementById('projectMeta').textContent,
        label: document.getElementById('currentProjectLabel').textContent,
        board: document.getElementById('patientsList').textContent,
      }));
      assert.equal(state.xss, null, `注入的脚本被执行：${state.xss}`);
      assert.equal(state.handlers, 0, '数据中的事件属性被解析为元素');
      assert.equal(state.jsLinks, 0, '数据生成了 javascript: 链接');
      assert.equal(state.injected, 0, '数据中的标签被解析为元素');
      assert.ok(state.projects.includes(HOSTILE_PROJECT.name) && state.meta.includes(HOSTILE_PROJECT.center_code) && state.label.includes(HOSTILE_PROJECT.name), '项目名与中心代码显示为文字');
      assert.ok(state.board.includes(HOSTILE_CODE), '研究编号显示为文字');
      assert.deepEqual(hostile.pageErrors, []);
    }
    await hostile.context.close();

    // 12h. 闲置自动退出：28 分钟提示“继续使用”，30 分钟自动退出并清除页面上的账号与研究数据；多个标签页共享最近操作时间。
    const sleepy = await openWorkspace(browser, origin, { clock: true });
    {
      const p = sleepy.page;
      const warning = p.locator('#idleWarning');
      await p.clock.fastForward('27:00');
      await p.waitForTimeout(100);
      assert.equal(await warning.isVisible(), false, '27 分钟时还不提示');
      await p.clock.fastForward('01:30');
      await eventually(() => warning.isVisible(), '28 分钟时应提示即将退出');
      assert.ok((await text(warning)).includes('自动退出登录') && (await text(p.locator('#btnIdleContinue'))) === '继续使用');
      await p.click('#btnIdleContinue');
      await eventually(async () => !(await warning.isVisible()), '点击“继续使用”后应关闭提示');
      // 另一个标签页有操作：本页不提示也不退出。
      const other = await openPage(sleepy.context, origin);
      await p.clock.fastForward('20:00');
      await other.page.mouse.move(40, 40);
      await other.page.mouse.move(80, 90);
      await other.page.keyboard.press('Shift');
      await p.clock.fastForward('09:00');
      await p.waitForTimeout(200);
      assert.equal(await warning.isVisible(), false, '其他标签页 9 分钟前有操作，本页不应提示');
      assert.equal(await p.locator('#appCard').isVisible(), true, '本页仍保持登录');
      await p.clock.fastForward('20:00');
      await eventually(() => warning.isVisible(), '所有标签页都闲置 28 分钟后应提示');
      assert.ok(/[0-9] 分 [0-9]{2} 秒/.test(await text(p.locator('#idleCountdown'))), '提示中显示剩余时间');
      await p.clock.fastForward('02:30');
      await p.locator('#loginCard').waitFor({ state: 'visible' });
      await eventually(async () => (await text(p.locator('#loginHint')))?.includes('30 分钟没有操作'), '应说明因闲置退出');
      assert.equal(await text(p.locator('#headerUserEmail')), '', '退出后清除邮箱');
      assert.equal(await text(p.locator('#trialBadge')), '', '退出后清除账户徽章');
      for (const needle of [USER.email, 'P001', 'P007', PROJECT.name]) assert.equal(await pageHas(p, needle), false, `闲置退出后页面仍有“${needle}”`);
      assert.equal(await warning.isVisible(), false);
      assert.ok(sleepy.mock.requests.some(r => r.path === '/auth/v1/logout'), '应通知服务器退出');
      await other.page.locator('#loginCard').waitFor({ state: 'visible' });
      assert.equal(await pageHas(other.page, 'P001'), false, '其他标签页同样退出');
      const stored = await p.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('ks_staff')));
      assert.ok(stored.every(([, v]) => /^\d+$/.test(v)), `闲置计时只在本地保存时间戳：${JSON.stringify(stored)}`);
      assert.deepEqual(sleepy.pageErrors, []);
      assert.deepEqual(other.pageErrors, []);
    }
    await sleepy.context.close();

    // 12i. 关闭页面超过 30 分钟后重新打开：不沿用保存的登录状态。
    const reopened = await openWorkspace(browser, origin, { lastActivity: Date.now() - 31 * 60_000, expect: 'login' });
    {
      const p = reopened.page;
      await eventually(async () => (await text(p.locator('#loginHint')))?.includes('30 分钟没有操作'), '应说明需重新登录');
      assert.equal(await p.evaluate(() => document.getElementById('authGatedContainer').childElementCount), 0, '不加载工作台');
      assert.equal(reopened.mock.requests.filter(r => r.path === '/rest/v1/v_patient_followup_status').length, 0, '不读取研究数据');
      assert.ok(reopened.mock.requests.some(r => r.path === '/auth/v1/logout'));
      assert.deepEqual(reopened.pageErrors, []);
    }
    await reopened.context.close();
    // 上次操作在 30 分钟内：正常进入工作台。
    const recent = await openWorkspace(browser, origin, { lastActivity: Date.now() - 5 * 60_000 });
    assert.equal(await recent.page.locator('#appCard').isVisible(), true);
    await recent.context.close();

    // 13. 手机宽度：页面无横向滚动。
    const phone = await openWorkspace(browser, origin, { viewport: { width: 390, height: 844 } });
    await shot(phone.page, '06-phone-top');
    await phone.page.locator('#boardSection').scrollIntoViewIfNeeded();
    await phone.page.evaluate(() => document.getElementById('boardSection').scrollIntoView());
    await shot(phone.page, '06-phone-board');
    await phone.page.click('tr[data-patient-code="P001"] [data-act="visit"]');
    await phone.page.locator('#veSbp').waitFor();
    await shot(phone.page, '07-phone-visit-entry');
    await phone.page.keyboard.press('Escape');
    const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `手机宽度下页面不应横向滚动（溢出 ${overflow}px）`);
    assert.deepEqual(phone.pageErrors, []);
    await phone.context.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log('STAFF_UI_OK');
}

main().catch(error => { console.error(error); process.exit(1); });
