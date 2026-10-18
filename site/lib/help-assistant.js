/* 使用问答（第一版）：右下角按钮，按关键词在本站问答库 /assets/help-faq.json 中检索。
 * 只在浏览器内匹配固定答案：不发送用户输入，不读取项目或患者数据，不调用任何模型。
 * 答案文字一律按纯文本插入页面。
 */
(function () {
  'use strict';
  if (document.getElementById('ksHelpBtn')) return;

  var script = document.currentScript;
  var version = '';
  try { version = new URL(script && script.src, location.href).searchParams.get('v') || ''; } catch (e) { version = ''; }
  var FAQ_URL = '/assets/help-faq.json' + (version ? '?v=' + encodeURIComponent(version) : '');
  var SUGGESTED = ['start', 'import', 'link', 'consent', 'freeze', 'contact'];
  var MAX_RESULTS = 3;

  var items = null;
  var loading = null;

  function normalize(text) {
    return String(text || '').toLowerCase().replace(/[\s　，。、？！?!,.;；:：“”"'（）()【】\[\]《》<>\/\\|·…\-—_]+/g, '');
  }

  // 只取相邻两个汉字组成的片段做模糊匹配；英文词靠关键词精确匹配，避免字母碰巧重合。
  function bigrams(text) {
    var set = {};
    for (var i = 0; i + 1 < text.length; i++) {
      var g = text.slice(i, i + 2);
      if (/^[\u4e00-\u9fff]{2}$/.test(g)) set[g] = true;
    }
    return set;
  }

  function prepare(raw) {
    return (raw || []).filter(function (it) { return it && it.id && it.q && it.a; }).map(function (it) {
      var keys = (it.k || []).map(normalize).filter(Boolean);
      return { id: it.id, q: String(it.q), a: String(it.a), link: typeof it.link === 'string' && /^\/[a-z0-9\-]+\.html$/.test(it.link) ? it.link : '', keys: keys, grams: bigrams(normalize(it.q) + keys.join('')) };
    });
  }

  function search(list, query) {
    var q = normalize(query);
    if (q.length < 2) return [];
    var qGrams = Object.keys(bigrams(q));
    var scored = list.map(function (it) {
      var score = 0;
      var hits = it.keys.filter(function (k) { return q.indexOf(k) !== -1; });
      hits.forEach(function (k) {
        var covered = hits.some(function (o) { return o !== k && o.length > k.length && o.indexOf(k) !== -1; });
        if (!covered) score += 1 + k.length;
      });
      if (!hits.length && it.keys.some(function (k) { return k.length > q.length && k.indexOf(q) !== -1; })) score += 2;
      var overlap = 0;
      qGrams.forEach(function (g) { if (it.grams[g]) overlap++; });
      score += Math.min(overlap, 6);
      return { it: it, score: score };
    }).filter(function (r) { return r.score >= 2; });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.length ? scored[0].score : 0;
    return scored.filter(function (r) { return r.score >= top / 2; }).slice(0, MAX_RESULTS).map(function (r) { return r.it; });
  }

  function load() {
    if (items) return Promise.resolve(items);
    if (!loading) {
      loading = fetch(FAQ_URL, { credentials: 'same-origin' })
        .then(function (res) { if (!res.ok) throw new Error('faq ' + res.status); return res.json(); })
        .then(function (data) { items = prepare(data && data.items); return items; })
        .catch(function (err) { loading = null; throw err; });
    }
    return loading;
  }

  var style = document.createElement('style');
  style.textContent = [
    '#ksHelpBtn{position:fixed;right:16px;bottom:16px;z-index:9000;border:0;border-radius:999px;padding:10px 14px;background:#1d4ed8;color:#fff;font-size:14px;font-weight:600;box-shadow:0 4px 14px rgba(15,23,42,.25);cursor:pointer}',
    '#ksHelpBtn:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}',
    '#ksHelpPanel{position:fixed;right:16px;bottom:68px;z-index:9001;width:360px;max-width:calc(100vw - 32px);max-height:min(70vh,560px);display:none;flex-direction:column;background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 12px 32px rgba(15,23,42,.22);overflow:hidden;font-size:14px;line-height:1.6}',
    '#ksHelpPanel.open{display:flex}',
    '#ksHelpPanel .kh-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e2e8f0;font-weight:700}',
    '#ksHelpPanel .kh-close{margin-left:auto;border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#475569}',
    '#ksHelpPanel form{display:flex;gap:6px;padding:10px 14px}',
    '#ksHelpPanel input{flex:1;min-width:0;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}',
    '#ksHelpPanel form button{border:0;border-radius:8px;padding:8px 12px;background:#1d4ed8;color:#fff;cursor:pointer}',
    '#ksHelpPanel .kh-body{overflow-y:auto;padding:0 14px 10px}',
    '#ksHelpPanel .kh-item{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-top:8px;background:#f8fafc}',
    '#ksHelpPanel .kh-q{font-weight:600;margin-bottom:4px}',
    '#ksHelpPanel .kh-a{white-space:pre-wrap;word-break:break-word}',
    '#ksHelpPanel .kh-more{display:inline-block;margin-top:4px;font-size:13px}',
    '#ksHelpPanel .kh-chip{display:inline-block;margin:6px 6px 0 0;padding:4px 10px;border:1px solid #cbd5e1;border-radius:999px;background:#fff;font-size:13px;cursor:pointer;color:#0f172a}',
    '#ksHelpPanel .kh-foot{padding:8px 14px 12px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b}',
    '@media print{#ksHelpBtn,#ksHelpPanel{display:none!important}}'
  ].join('\n');
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'ksHelpBtn';
  btn.textContent = '使用问答';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'ksHelpPanel');

  var panel = document.createElement('div');
  panel.id = 'ksHelpPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '使用问答');

  var head = document.createElement('div');
  head.className = 'kh-head';
  head.appendChild(document.createTextNode('使用问答'));
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'kh-close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  head.appendChild(close);

  var form = document.createElement('form');
  var input = document.createElement('input');
  input.type = 'search';
  input.id = 'ksHelpInput';
  input.maxLength = 100;
  input.placeholder = '例如：单位怎么换算、链接过期了';
  input.setAttribute('aria-label', '输入你的问题');
  input.autocomplete = 'off';
  var submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = '查找';
  form.appendChild(input);
  form.appendChild(submit);

  var body = document.createElement('div');
  body.className = 'kh-body';
  body.id = 'ksHelpResults';
  body.setAttribute('aria-live', 'polite');

  var foot = document.createElement('div');
  foot.className = 'kh-foot';
  foot.textContent = '只回答使用方法，答案来自使用指南，不读取你的项目数据。请不要输入患者信息。';

  panel.appendChild(head);
  panel.appendChild(form);
  panel.appendChild(body);
  panel.appendChild(foot);

  function note(text) {
    var p = document.createElement('div');
    p.className = 'kh-item';
    p.textContent = text;
    return p;
  }

  function contactNote(prefix) {
    return note(prefix + '可以发邮件到 china@kidneysphere.com 或加微信 GlomConChina1，工作日内回复。邮件里不要附带患者数据。');
  }

  function renderAnswers(list) {
    body.textContent = '';
    list.forEach(function (it) {
      var box = document.createElement('div');
      box.className = 'kh-item';
      box.setAttribute('data-help-id', it.id);
      var q = document.createElement('div');
      q.className = 'kh-q';
      q.textContent = it.q;
      var a = document.createElement('div');
      a.className = 'kh-a';
      a.textContent = it.a;
      box.appendChild(q);
      box.appendChild(a);
      if (it.link) {
        var more = document.createElement('a');
        more.className = 'kh-more';
        more.href = it.link;
        more.textContent = '查看详细说明';
        box.appendChild(more);
      }
      body.appendChild(box);
    });
  }

  function renderSuggestions() {
    body.textContent = '';
    var intro = document.createElement('div');
    intro.style.marginTop = '4px';
    intro.textContent = '常见问题：';
    body.appendChild(intro);
    SUGGESTED.forEach(function (id) {
      var it = items.filter(function (x) { return x.id === id; })[0];
      if (!it) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'kh-chip';
      chip.textContent = it.q;
      chip.addEventListener('click', function () { input.value = it.q; renderAnswers([it]); });
      body.appendChild(chip);
    });
  }

  function failed() {
    body.textContent = '';
    body.appendChild(contactNote('问答库暂时没有加载成功。'));
  }

  function ask(query) {
    load().then(function (list) {
      if (!String(query || '').trim()) { renderSuggestions(); return; }
      var found = search(list, query);
      if (found.length) renderAnswers(found);
      else { body.textContent = ''; body.appendChild(contactNote('没有找到相关答案，换个说法试试，或者')); }
    }, failed);
  }

  function setOpen(open) {
    panel.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      if (!body.childNodes.length) ask('');
      input.focus();
    } else {
      btn.focus();
    }
  }

  btn.addEventListener('click', function () { setOpen(!panel.classList.contains('open')); });
  close.addEventListener('click', function () { setOpen(false); });
  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value); });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } });

  function mount() {
    document.body.appendChild(panel);
    document.body.appendChild(btn);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
