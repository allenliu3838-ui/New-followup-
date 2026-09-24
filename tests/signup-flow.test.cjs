// Offline regression tests: execute the real inline signup module against a DOM
// and an in-memory auth/database stub. No browser, HTTP, accounts or emails.
// Run: node --experimental-vm-modules --test tests/signup-flow.test.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { JSDOM, VirtualConsole } = require('jsdom');

const site = path.resolve(__dirname, '../site');
const session = { user: { id: 'offline-user', email: 'doctor@example.test' } };
const projectId = '11111111-1111-4111-8111-111111111111';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
};

async function page(t, options = {}) {
  const html = fs.readFileSync(path.join(site, 'signup.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://registry.example.test/signup?trial=1',
    runScripts: 'outside-only',
    virtualConsole,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const context = dom.getInternalVMContext();
  const timers = new Map();
  let timerId = 0, clock = 0;
  window.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++timerId;
    timers.set(id, { at: clock + Number(delay), callback: () => callback(...args) });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  window.fetch = () => { throw new Error('Network is forbidden in offline signup tests'); };
  window.addEventListener('error', event => errors.push(event.error || event.message));
  const calls = { signUp: [], rpc: [], insert: [], getSession: 0, listeners: [] };
  const sb = {
    auth: {
      getSession() {
        calls.getSession++;
        if (options.getSession) return options.getSession();
        return Promise.resolve({ data: { session: options.session || null }, error: null });
      },
      signUp(payload) {
        calls.signUp.push(payload);
        return options.signUp ? options.signUp(payload) : Promise.resolve({
          data: { user: { ...session.user, identities: [{ id: 'offline-identity' }] }, session },
          error: null,
        });
      },
      onAuthStateChange(callback) {
        calls.listeners.push(callback);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    rpc(name, payload) {
      calls.rpc.push({ name, payload });
      return options.rpc ? options.rpc(name, payload) : Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const query = {
        insert(payload) { calls.insert.push({ table, payload }); return query; },
        select() { return query; },
        single() { return query; },
        then(resolve, reject) {
          const result = options.insert ? options.insert(table) : {
            data: table === 'projects' ? { id: projectId } : null, error: null,
          };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const modules = new Map();
  async function resolveModule(specifier) {
    if (specifier === '/lib/supabase-client.js') {
      if (options.sdkError) throw options.sdkError;
      if (!modules.has(specifier)) {
        modules.set(specifier, new vm.SyntheticModule(['supabase'], function () {
          this.setExport('supabase', () => sb);
        }, { context, identifier: specifier }));
      }
    } else if (!modules.has(specifier)) {
      const allowed = ['/lib/utils.js', '/lib/password-strength.js', '/lib/rate-limit.js'];
      assert.ok(allowed.includes(specifier), `Unexpected module import: ${specifier}`);
      modules.set(specifier, new vm.SourceTextModule(
        fs.readFileSync(path.join(site, specifier), 'utf8'),
        { context, identifier: specifier },
      ));
    }
    const module = modules.get(specifier);
    if (module.status === 'unlinked') await module.link(resolveModule);
    if (module.status === 'linked') await module.evaluate();
    return module;
  }
  const inline = [...document.querySelectorAll('script[type="module"]')]
    .filter(script => !script.src).map(script => script.textContent).join('\n');
  assert.ok(inline.trim(), 'Signup page must include its application module');
  const module = new vm.SourceTextModule(inline, {
    context,
    identifier: '/signup-inline.js',
    importModuleDynamically: resolveModule,
  });
  await module.link(resolveModule);
  let moduleError;
  const evaluated = module.evaluate().catch(error => { moduleError = error; });
  await flush();
  if (moduleError) throw moduleError;
  const byId = id => {
    const element = document.getElementById(id);
    assert.ok(element, `Missing #${id}`);
    return element;
  };
  return {
    window, document, calls, errors, evaluated, byId,
    async advance(ms) {
      const target = clock + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        clock = timer.at;
        timer.callback();
        await flush();
      }
      clock = target;
      await flush();
    },
    fill(overrides = {}) {
      const values = { email: 'doctor@example.test', password: 'Correct!42', confirmPwd: 'Correct!42', ...overrides };
      for (const [id, value] of Object.entries(values)) byId(id).value = value;
      byId('agreeTerms').checked = true;
    },
    async click(id) { byId(id).click(); await flush(); },
    async submit() {
      const form = byId('btnRegister').closest('form');
      if (form) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      else byId('btnRegister').click();
      await flush();
    },
    async auth(event = 'SIGNED_IN') {
      for (const callback of calls.listeners) callback(event, session);
      await flush();
    },
    hint: () => byId('registerHint').textContent,
    active: id => byId(id).classList.contains('active'),
  };
}

test('logged-out page initializes without attaching handlers to absent template nodes', async t => {
  const p = await page(t);
  assert.equal(p.document.querySelector('#btnObStep1'), null);
  assert.equal(p.byId('btnRegister').disabled, false);
  assert.deepEqual(p.errors, []);
  await p.submit();
  assert.match(p.hint(), /邮箱/);
  assert.equal(p.calls.signUp.length, 0);
});

test('password requirements are visible and validation errors survive toast expiry', async t => {
  const p = await page(t);
  const visibleRegistration = p.byId('registerCard').textContent;
  for (const rule of ['大写', '小写', '数字', '特殊']) assert.ok(visibleRegistration.includes(rule));
  p.fill({ password: 'abcdefgh', confirmPwd: 'abcdefgh' });
  await p.submit();
  assert.match(p.hint(), /密码|大写/);
  const message = p.hint();
  await p.advance(4000);
  assert.equal(p.hint(), message);
  assert.equal(p.calls.signUp.length, 0);
});

test('invalid local attempts do not consume the five-request registration allowance', async t => {
  const p = await page(t);
  for (let i = 0; i < 7; i++) await p.submit();
  assert.equal(p.calls.signUp.length, 0);
  p.fill({ email: '  Doctor@Example.test  ' });
  await p.submit();
  assert.equal(p.calls.signUp.length, 1);
  assert.equal(p.calls.signUp[0].email, 'doctor@example.test');
});

test('pending signup gives a slow-response message and cannot create a second request', async t => {
  const pending = deferred();
  const p = await page(t, { signUp: () => pending.promise });
  p.fill();
  await p.submit();
  await p.submit();
  assert.equal(p.calls.signUp.length, 1);
  assert.equal(p.byId('btnRegister').disabled, true);
  await p.advance(35000);
  assert.match(p.hint(), /等待|较慢|处理中|未收到|网络/);
  await p.submit();
  assert.equal(p.calls.signUp.length, 1);
  assert.equal(p.byId('btnRegister').disabled, true);
  pending.resolve({ data: null, error: { message: 'offline signup rejected', status: 400 } });
  await flush();
  assert.equal(p.byId('btnRegister').disabled, false);
  assert.match(p.hint(), /注册未完成/);
});

test('session success opens onboarding and repeated auth events bind controls once', async t => {
  const p = await page(t);
  p.fill();
  await p.submit();
  assert.equal(p.byId('registerCard').style.display, 'none');
  assert.notEqual(p.byId('onboardingCard').style.display, 'none');
  await p.auth();
  await p.auth();
  await p.advance(0);
  p.byId('obName').value = 'Offline Test';
  await p.click('btnObStep1');
  const profiles = p.calls.rpc.filter(call => call.name === 'upsert_my_profile');
  assert.equal(profiles.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(profiles[0].payload)), {
    p_real_name: 'Offline Test', p_hospital: null, p_department: null,
    p_interested_plan: 'trial', p_contact: null, p_notes: null,
  });
  assert.equal(p.byId('password').value, '');
  assert.equal(p.byId('confirmPwd').value, '');
  assert.equal(p.active('obStep2'), true);
  await p.click('btnObSkip2');
  assert.equal(p.active('obDone'), true);
  assert.deepEqual(p.errors, []);
});

test('email confirmation without a session keeps registration visible with clear instructions', async t => {
  const p = await page(t, { signUp: async () => ({
    data: { user: { ...session.user, identities: [{ id: 'offline-identity' }] }, session: null }, error: null,
  }) });
  p.fill();
  await p.submit();
  assert.notEqual(p.byId('registerCard').style.display, 'none');
  assert.equal(p.byId('onboardingCard').style.display, 'none');
  assert.match(p.hint(), /邮箱|邮件/);
  assert.match(p.hint(), /确认|验证|激活/);
  assert.equal(p.calls.rpc.length, 0, 'Do not call authenticated RPCs without a session');
});

test('SDK loading errors remain visible and do not leave an apparently usable signup button', async t => {
  const p = await page(t, { sdkError: new Error('offline SDK load failed') });
  assert.match(p.hint(), /加载|初始化|连接|网络/);
  await p.advance(4000);
  assert.ok(p.hint().trim());
  await p.submit();
  assert.equal(p.calls.signUp.length, 0);
  assert.deepEqual(p.errors, []);
});

test('session restoration rejection is handled visibly without an uncaught exception', async t => {
  const p = await page(t, { getSession: async () => { throw new Error('offline session unavailable'); } });
  assert.match(p.hint(), /会话|登录|初始化|连接|网络|恢复/);
  assert.deepEqual(p.errors, []);
  await p.advance(4000);
  assert.ok(p.hint().trim());
});

test('a stalled session lookup times out visibly and cannot submit registration', async t => {
  const pending = deferred();
  const p = await page(t, { getSession: () => pending.promise });
  // An unauthenticated INITIAL_SESSION notification must not make signup ready.
  for (const callback of p.calls.listeners) callback('INITIAL_SESSION', null);
  p.fill();
  await p.submit();
  assert.equal(p.calls.signUp.length, 0);
  await p.advance(16000);
  assert.equal(p.byId('btnRegister').disabled, true);
  assert.match(p.hint(), /未能连接|重新加载/);
  await p.submit();
  assert.equal(p.calls.signUp.length, 0);
  assert.equal(p.byId('onboardingCard').style.display, 'none');
  assert.deepEqual(p.errors, []);
});

test('profile RPC errors do not silently advance onboarding', async t => {
  const p = await page(t, {
    session,
    rpc: async () => ({ data: null, error: { code: '42501', message: 'profile permission denied' } }),
  });
  p.byId('obName').value = 'Offline Test';
  await p.click('btnObStep1');
  assert.equal(p.active('obStep1'), true);
  assert.match(p.byId('onboardingHint').textContent, /未能完成.*权限/);
  await p.click('btnObSkip1');
  assert.equal(p.active('obStep2'), true);
});

test('project and first patient use existing table insert APIs with validated payloads', async t => {
  const p = await page(t, { session });
  await p.click('btnObSkip1');
  p.byId('obProjName').value = 'Offline study';
  p.byId('obProjCenter').value = 'TEST01';
  p.byId('obProjModule').value = 'IGAN';
  await p.click('btnObStep2');
  assert.equal(p.calls.insert.length, 1);
  const project = p.calls.insert[0];
  assert.equal(project.table, 'projects');
  assert.deepEqual(JSON.parse(JSON.stringify(project.payload)), {
    name: 'Offline study', center_code: 'TEST01', module: 'IGAN', registry_type: 'igan', description: null,
  });
  assert.equal(p.active('obStep3'), true);
  p.byId('obPatCode').value = '0001';
  p.byId('obPatSex').value = 'F';
  p.byId('obPatBirthYear').value = '1800';
  await p.click('btnObStep3');
  assert.equal(p.calls.insert.length, 1, 'Invalid birth year must not reach the database');
  p.byId('obPatBirthYear').value = '1985';
  await p.click('btnObStep3');
  const patient = p.calls.insert[1];
  assert.equal(patient.table, 'patients_baseline');
  assert.deepEqual(JSON.parse(JSON.stringify(patient.payload)), {
    project_id: projectId, patient_code: '0001', sex: 'F', birth_year: 1985,
    baseline_date: null, baseline_scr: null, baseline_upcr: null,
  });
  assert.equal(p.active('obDone'), true);
  assert.equal(p.calls.rpc.some(call => ['create_project', 'create_patient_baseline'].includes(call.name)), false);
});

test('project database errors preserve entered values and keep the user on the same step', async t => {
  const p = await page(t, {
    session,
    insert: () => ({ data: null, error: { code: '42501', message: 'project permission denied' } }),
  });
  await p.click('btnObSkip1');
  p.byId('obProjName').value = 'Offline study';
  p.byId('obProjCenter').value = 'TEST01';
  await p.click('btnObStep2');
  assert.equal(p.active('obStep2'), true);
  assert.equal(p.byId('obProjName').value, 'Offline study');
  assert.match(p.byId('onboardingHint').textContent, /未能完成.*权限/);
});

test('existing-email response never starts onboarding or authenticated data writes', async t => {
  const p = await page(t, { signUp: async () => ({
    data: { user: { ...session.user, identities: [] }, session: null }, error: null,
  }) });
  p.fill();
  await p.submit();
  assert.match(p.hint(), /已注册|登录/);
  assert.equal(p.byId('onboardingCard').style.display, 'none');
  assert.equal(p.calls.rpc.length, 0);
  assert.equal(p.calls.insert.length, 0);
});
