// 公开页面冒烟测试（公开页面单元 A）。
// 运行：PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/ui/public-a-smoke.mjs
//
// 页面全部从本地 site/ 目录提供：浏览器发出的每个请求都被拦截，本站请求从磁盘读取，
// kidneysphere.com 共享顶栏返回空内容，其余任何主机都记为违规并中止。
// 本站使用非 localhost 主机名（registry.test），与线上一样会执行统计开关判断。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
const { chromium } = await import('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = path.join(ROOT, 'site');
const HOST = 'registry.test';
const ORIGIN = `http://${HOST}`;
const ALLOWED_EXTERNAL = new Set(['kidneysphere.com']);
const DEMO_COLUMNS = new Set(['name', 'institution', 'department', 'email', 'contact', 'use_case', 'message']);
const BANNED = ['NEJM', '顶刊', '科研小白', '零风险', '无隐私风险', 'Part 11', '宽限', 'Token', '令牌', 'PII'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.woff2': 'font/woff2',
};

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

function resolveSiteFile(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const candidates = [rel, `${rel}.html`];
  for (const c of candidates) {
    const abs = path.normalize(path.join(SITE, c));
    if (!abs.startsWith(SITE + path.sep)) return null;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

// overrides: { '/config.js': (text) => text, '/__fake/...': {body, contentType} }
async function openPage(browser, urlPath, { overrides = {}, onRequest } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const external = [];
  const requested = [];
  const errors = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    // 404 页面本身以 404 状态返回，浏览器会为主文档记一条资源错误，这是预期行为。
    if (/Failed to load resource/.test(msg.text()) && msg.location().url === `${ORIGIN}${urlPath}`) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    requested.push(req.url());
    if (url.hostname === HOST) {
      if (onRequest) {
        const handled = await onRequest(route, req, url);
        if (handled) return;
      }
      const ov = overrides[url.pathname];
      if (ov && typeof ov === 'object') {
        return route.fulfill({ status: 200, contentType: ov.contentType, body: ov.body });
      }
      const file = resolveSiteFile(url.pathname);
      if (!file) {
        return route.fulfill({ status: 404, contentType: TYPES['.html'], body: fs.readFileSync(path.join(SITE, '404.html')) });
      }
      let body = fs.readFileSync(file);
      if (typeof ov === 'function') body = ov(body.toString('utf8'));
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body });
    }
    if (ALLOWED_EXTERNAL.has(url.hostname)) {
      const type = url.pathname.endsWith('.css') ? TYPES['.css'] : TYPES['.js'];
      return route.fulfill({ status: 200, contentType: type, body: '' });
    }
    external.push(req.url());
    return route.abort('blockedbyclient');
  });
  const response = await page.goto(`${ORIGIN}${urlPath}`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  return { context, page, response, external, requested, errors };
}

function commonChecks(name, r) {
  check(r.errors.length === 0, `${name}: 页面错误 ${JSON.stringify(r.errors)}`);
  check(r.external.length === 0, `${name}: 请求了外部主机 ${JSON.stringify(r.external)}`);
  check(!r.requested.some(u => /plausible/i.test(u)), `${name}: 默认加载了 plausible`);
}

async function noPlausible(name, page) {
  const state = await page.evaluate(() => {
    let threw = null;
    let ret;
    try { ret = window.KSTrack ? window.KSTrack.track('smoke_event', { a: 1 }) : 'no-kstrack'; } catch (e) { threw = String(e); }
    return {
      threw, ret: ret === undefined ? 'undefined' : String(ret),
      enabled: window.KSTrack && typeof window.KSTrack.enabled === 'function' ? window.KSTrack.enabled() : 'missing',
      plausibleType: typeof window.plausible,
      scripts: Array.from(document.scripts).map(s => s.src).filter(s => /plausible|analytics/i.test(s) && !/\/analytics\.js/.test(s)),
    };
  });
  check(state.threw === null, `${name}: KSTrack.track 抛出异常 ${state.threw}`);
  if (state.ret !== 'no-kstrack') {
    check(state.ret === 'undefined', `${name}: KSTrack.track 返回值异常 ${state.ret}`);
    check(state.enabled === false, `${name}: 统计默认应关闭`);
  }
  check(state.plausibleType === 'undefined', `${name}: window.plausible 不应存在`);
  check(state.scripts.length === 0, `${name}: 出现了统计脚本 ${state.scripts}`);
}

async function bannedWords(name, page) {
  const text = await page.evaluate(() => document.body.innerText + '\n' + document.title + '\n' +
    Array.from(document.querySelectorAll('meta[name=description],meta[property^="og:"]')).map(m => m.content).join('\n'));
  for (const w of BANNED) check(!text.includes(w), `${name}: 可见文字含禁用措辞「${w}」`);
}

async function trialSummaryConsistent(name, page, minCount) {
  const st = await page.evaluate(() => ({
    expected: window.PricingConfig && window.PricingConfig.trialSummary(),
    actual: Array.from(document.querySelectorAll('[data-pricing="trialSummary"]')).map(e => e.textContent.trim()),
  }));
  check(!!st.expected, `${name}: PricingConfig.trialSummary 不可用`);
  check(st.actual.length >= minCount, `${name}: 试用说明数量 ${st.actual.length} < ${minCount}`);
  check(st.actual.every(t => t === st.expected), `${name}: 试用说明不一致 ${JSON.stringify(st.actual)}`);
  check(/30 天免费试用/.test(st.expected) && /含 1 个项目/.test(st.expected) && /只读/.test(st.expected) && /导出/.test(st.expected),
    `${name}: 试用说明内容不符 ${st.expected}`);
}

async function projectStatuses(name, page, gridSelector) {
  const st = await page.evaluate(sel => {
    const cards = Array.from(document.querySelectorAll(`${sel} .project-card`));
    return {
      n: cards.length,
      labels: cards.map(c => (c.querySelector('.proj-status') || {}).textContent || ''),
      dataN: (window.CollabData && window.CollabData.projectCards.length) || 0,
      confirmed: (window.CollabData ? window.CollabData.projectCards : []).filter(p => p.leadInstitution && p.principalInvestigator && p.ethicsApprovalNo).length,
    };
  }, gridSelector);
  check(st.n > 0 && st.n === st.dataN, `${name}: 项目卡数量 ${st.n} 与数据 ${st.dataN} 不一致`);
  const proposed = st.labels.filter(l => l === '拟议方向（征集牵头单位）').length;
  check(proposed === st.n - st.confirmed, `${name}: 状态标签不符 ${JSON.stringify(st.labels)}`);
  check(st.confirmed > 0 || !st.labels.includes('招募中'), `${name}: 没有牵头单位/PI/伦理信息的项目不应显示“招募中”`);
}

// 首页与合作页预渲染的项目卡必须与 collaboration-data.js + collaboration-components.js 的输出逐字一致；
// 浏览器端在卡片 slug 一致时会直接复用预渲染内容，数据改了而 HTML 没重新生成会悄悄显示旧文案。
{
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['collaboration-data.js', 'collaboration-components.js']) {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), sandbox, { filename: f });
  }
  const expected = sandbox.window.CollabComponents.projectsHtml(sandbox.window.CollabData.projectCards);
  const BEGIN = '<!-- BEGIN GENERATED PROJECT CARDS: node scripts/build_collaboration_pages.mjs -->';
  const END = '<!-- END GENERATED PROJECT CARDS -->';
  for (const f of ['index.html', 'collaboration.html']) {
    const src = fs.readFileSync(path.join(SITE, f), 'utf8');
    const a = src.indexOf(BEGIN), b = src.indexOf(END);
    if (a < 0 || b < 0) { check(false, `${f}: 缺少预渲染项目卡标记`); continue; }
    const inner = src.slice(a + BEGIN.length, b);
    check(inner.slice(0, inner.lastIndexOf('\n')) === expected, `${f}: 预渲染项目卡与 collaboration-data.js 不一致，需要重新生成`);
  }
}

// 已安装的浏览器版本可能与 playwright 包期望的版本号不同；不下载，改用目录中已有的 Chromium。
// 关闭浏览器自身的后台联网（组件更新等），页面请求全部由上面的拦截器处理。
const LAUNCH_ARGS = ['--disable-background-networking', '--disable-component-update', '--no-pings'];
async function launchBrowser() {
  try {
    return await chromium.launch({ args: LAUNCH_ARGS });
  } catch (err) {
    if (!/Executable doesn't exist/.test(String(err && err.message))) throw err;
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const candidates = [process.env.CHROMIUM_PATH, path.join(base, 'chromium')];
    for (const d of fs.existsSync(base) ? fs.readdirSync(base).sort().reverse() : []) {
      if (/^chromium-\d+$/.test(d)) candidates.push(path.join(base, d, 'chrome-linux', 'chrome'));
    }
    const exe = candidates.find(c => c && fs.existsSync(c));
    if (!exe) throw err;
    return chromium.launch({ executablePath: exe, args: LAUNCH_ARGS });
  }
}

const browser = await launchBrowser();
try {
  // 首页
  {
    const r = await openPage(browser, '/');
    commonChecks('index', r);
    await noPlausible('index', r.page);
    await bannedWords('index', r.page);
    await trialSummaryConsistent('index', r.page, 2);
    await projectStatuses('index', r.page, '#indexProjects');
    const st = await r.page.evaluate(() => ({
      faq: document.querySelectorAll('.registry-faq dt').length,
      faqText: (document.querySelector('.registry-faq') || {}).innerText || '',
      clinician: (document.querySelector('.registry-clinician a') || {}).getAttribute?.('href'),
      secNav: document.querySelectorAll('.registry-hero .sec-nav a').length,
      heroButtons: document.querySelectorAll('.registry-hero .hero-ctas a').length,
    }));
    check(st.faq === 4, `index: 注册前关心的问题应为 4 行，实际 ${st.faq}`);
    for (const k of ['数据存在哪里', '谁能看到', '导出', '伦理']) check(st.faqText.includes(k), `index: 摘要缺少「${k}」`);
    check(st.faqText.includes('境外') && st.faqText.includes('境内'), 'index: 数据存储地需如实说明境外现状与迁移');
    check(st.clinician === '/guide#quickstart', `index: 临床医生入口链接 ${st.clinician}`);
    check(st.secNav + st.heroButtons <= 6 && st.secNav <= 4, `index: 首屏次级按钮过多 ${st.secNav}`);
    await r.context.close();
  }

  // 定价页
  {
    const r = await openPage(browser, '/pricing');
    commonChecks('pricing', r);
    await noPlausible('pricing', r.page);
    await bannedWords('pricing', r.page);
    await trialSummaryConsistent('pricing', r.page, 3);
    const text = await r.page.evaluate(() => document.body.innerText);
    check(text.includes('什么是“项目”'), 'pricing: 缺少“项目”定义');
    for (const k of ['科研经费', '发票', '课题', '分中心']) check(text.includes(k), `pricing: FAQ 缺少「${k}」`);
    const pro = await r.page.locator('[data-testid=pricing-pro-price]').innerText();
    check(pro.includes('¥499'), `pricing: Pro 价格 ${pro}`);
    await r.context.close();
  }

  // 隐私、安全
  for (const [name, p] of [['privacy', '/privacy'], ['security', '/security']]) {
    const r = await openPage(browser, p);
    commonChecks(name, r);
    await noPlausible(name, r.page);
    await bannedWords(name, r.page);
    const text = await r.page.evaluate(() => document.body.innerText);
    check(text.includes('境外') && text.includes('迁移'), `${name}: 未如实说明数据存储地与迁移`);
    check(text.includes('以实际部署配置为准'), `${name}: 静态加密/备份应写“以实际部署配置为准”`);
    if (name === 'security') check(await r.page.locator('#support').count() === 1, 'security: 缺少“支持与服务”小节');
    await r.context.close();
  }

  // 合作项目
  {
    const r = await openPage(browser, '/collaboration');
    commonChecks('collaboration', r);
    await noPlausible('collaboration', r.page);
    await bannedWords('collaboration', r.page);
    await projectStatuses('collaboration', r.page, '#projectsGrid');
    await r.context.close();
  }

  // 合作咨询：字段、类型预选、提交载荷与 demo_requests 授权列一致
  for (const kind of ['email', 'wechat']) {
    const posted = [];
    const r = await openPage(browser, '/demo?type=' + encodeURIComponent('机构合作咨询'), {
      overrides: {
        '/config.js': t => `${t}\n;window.CONFIG.SUPABASE_URL=${JSON.stringify(ORIGIN + '/__sb')};window.CONFIG.SUPABASE_ANON_KEY='smoke-anon-key';`,
      },
      onRequest: async (route, req, url) => {
        if (!url.pathname.startsWith('/__sb/')) return false;
        if (url.pathname === '/__sb/rest/v1/demo_requests' && req.method() === 'POST') {
          posted.push(JSON.parse(req.postData() || 'null'));
          await route.fulfill({ status: 201, contentType: 'application/json', body: '' });
        } else {
          await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        }
        return true;
      },
    });
    const name = `demo(${kind})`;
    commonChecks(name, r);
    await noPlausible(name, r.page);
    await bannedWords(name, r.page);
    const st = await r.page.evaluate(() => ({
      title: document.title,
      h1: (document.querySelector('h1') || {}).textContent,
      fields: Array.from(document.querySelectorAll('#demoForm input, #demoForm select, #demoForm textarea')).map(e => e.id),
      options: Array.from(document.querySelectorAll('#f_inquiry_type option')).map(o => o.value),
      selected: document.getElementById('f_inquiry_type').value,
    }));
    check(st.title.includes('合作咨询') && st.h1 === '合作咨询', `${name}: 页面名称应为“合作咨询”`);
    check(JSON.stringify(st.fields) === JSON.stringify(['f_name', 'f_institution', 'f_contact_kind', 'f_contact', 'f_inquiry_type', 'f_message']),
      `${name}: 表单字段 ${JSON.stringify(st.fields)}`);
    check(st.options.includes('药企医学 / 真实世界研究 / CRO'), `${name}: 缺少药企医学/RWS/CRO 选项`);
    check(st.selected === '机构合作咨询', `${name}: 链接参数未预选咨询类型 ${st.selected}`);

    // 必填校验：空表单提交不发请求
    await r.page.click('#btnSubmit');
    check(await r.page.locator('#formErr').isVisible(), `${name}: 空表单未提示错误`);
    check(posted.length === 0, `${name}: 空表单不应提交`);

    await r.page.fill('#f_name', '测试医生');
    await r.page.fill('#f_institution', '测试医院肾内科');
    await r.page.selectOption('#f_contact_kind', kind);
    await r.page.fill('#f_contact', kind === 'email' ? 'doctor@example.com' : 'wx_doctor01');
    await r.page.selectOption('#f_inquiry_type', '药企医学 / 真实世界研究 / CRO');
    await r.page.fill('#f_message', '想了解真实世界研究合作');
    await r.page.click('#btnSubmit');
    await r.page.locator('[data-testid=demo-success]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    check(await r.page.locator('[data-testid=demo-success]').isVisible(), `${name}: 提交后未显示成功`);
    check(posted.length === 1, `${name}: 提交次数 ${posted.length}`);
    const row = Array.isArray(posted[0]) ? posted[0][0] : posted[0];
    if (row) {
      const extra = Object.keys(row).filter(k => !DEMO_COLUMNS.has(k));
      check(extra.length === 0, `${name}: 载荷含未授权列 ${extra}`);
      check(row.name === '测试医生' && row.institution === '测试医院肾内科', `${name}: 姓名/机构 ${JSON.stringify(row)}`);
      check(typeof row.email === 'string', `${name}: email 列不能为 null`);
      if (kind === 'email') check(row.email === 'doctor@example.com' && row.contact === null, `${name}: 邮箱写入 ${JSON.stringify(row)}`);
      else check(row.email === '' && row.contact === '微信：wx_doctor01', `${name}: 微信写入 ${JSON.stringify(row)}`);
      check(row.use_case === 'INDUSTRY_RWS_CRO', `${name}: use_case ${row.use_case}`);
      check(String(row.message).includes('咨询类型：药企医学 / 真实世界研究 / CRO') && String(row.message).includes('真实世界研究合作'),
        `${name}: message ${row.message}`);
    }
    await r.context.close();
  }

  // 404
  {
    const r = await openPage(browser, '/no-such-page-for-smoke');
    commonChecks('404', r);
    await noPlausible('404', r.page);
    await bannedWords('404', r.page);
    check(r.response && r.response.status() === 404, `404: 状态码 ${r.response && r.response.status()}`);
    const text = await r.page.evaluate(() => document.body.innerText);
    check(text.includes('页面未找到') && text.includes('随访链接'), '404: 文案缺失');
    check(await r.page.locator('a[href="/login"]').count() > 0, '404: 缺少登录工作台入口');
    await r.context.close();
  }

  // 显式开启统计时才加载统计脚本（用本地假脚本，不访问外部）
  {
    const fakeSrc = `${ORIGIN}/__fake_analytics.js`;
    const r = await openPage(browser, '/pricing', {
      overrides: {
        '/config.js': t => `${t}\n;window.CONFIG.FEATURES={ANALYTICS:true,ANALYTICS_SRC:${JSON.stringify(fakeSrc)},ANALYTICS_DOMAIN:'kidneysphereregistry.cn'};`,
        '/__fake_analytics.js': {
          contentType: TYPES['.js'],
          body: 'window.__events=[].slice.call((window.plausible&&window.plausible.q)||[]).map(function(a){return a[0]});' +
            'window.plausible=function(n){window.__events.push(n)};',
        },
      },
    });
    commonChecks('analytics-opt-in', { ...r, requested: [] });
    await r.page.waitForFunction(() => Array.isArray(window.__events), null, { timeout: 5000 }).catch(() => {});
    const st = await r.page.evaluate(() => {
      window.KSTrack.track('smoke_opt_in');
      return {
        enabled: typeof window.KSTrack.enabled === 'function' ? window.KSTrack.enabled() : 'missing',
        events: window.__events || null,
        domain: (document.querySelector('script[src$="/__fake_analytics.js"]') || {}).getAttribute?.('data-domain'),
      };
    });
    check(st.enabled === true, 'analytics-opt-in: 开关未生效');
    check(Array.isArray(st.events) && st.events.includes('page_view') && st.events.includes('smoke_opt_in'),
      `analytics-opt-in: 事件未送达 ${JSON.stringify(st.events)}`);
    check(st.domain === 'kidneysphereregistry.cn', `analytics-opt-in: data-domain ${st.domain}`);
    check(r.requested.some(u => u === fakeSrc), 'analytics-opt-in: 未加载配置的统计脚本');
    check(!r.requested.some(u => /plausible\.io/.test(u)), 'analytics-opt-in: 不应访问 plausible.io');
    await r.context.close();
  }
} catch (err) {
  failures.push(`测试执行异常：${err && err.message}`);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('PUBLIC_A_FAILED');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('PUBLIC_A_OK');
