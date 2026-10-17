/**
 * 肾域·科研 — 页面事件统计（默认关闭）
 *
 * 用法：KSTrack.track('event_name', { key: 'value' })
 *
 * 默认不加载任何外部脚本、不发送任何统计请求；KSTrack.track 为安全的空操作。
 * 仅当服务器的 config.js 明确设置 window.CONFIG.FEATURES.ANALYTICS === true 时才启用：
 *   FEATURES: {
 *     ANALYTICS: true,
 *     ANALYTICS_SRC: 'https://<境内自托管统计服务>/js/script.tagged-events.js', // 建议自托管
 *     ANALYTICS_DOMAIN: 'kidneysphereregistry.cn'
 *   }
 * 必须同时提供 ANALYTICS_SRC 才会加载；不再有缺省地址，避免一开开关就默认请求境外服务。
 * 启用前须在隐私政策中写明统计服务的提供方与所在地。
 * 启用状态在 DOM 就绪时读取，因此本脚本与 config.js 的加载顺序无关。
 */
(function () {
  var loaded = false;

  function features() {
    var c = window.CONFIG;
    return (c && c.FEATURES) || {};
  }

  function isLocal() {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function enabled() {
    try {
      var f = features();
      return f.ANALYTICS === true && typeof f.ANALYTICS_SRC === 'string' && /^https:\/\//.test(f.ANALYTICS_SRC);
    } catch (e) { return false; }
  }

  function loadProvider() {
    if (loaded || !enabled() || isLocal()) return;
    loaded = true;
    var f = features();
    // 外部脚本加载完成前触发的事件先排队，脚本加载后接管（Plausible 官方队列写法）。
    window.plausible = window.plausible || function () {
      (window.plausible.q = window.plausible.q || []).push(arguments);
    };
    var s = document.createElement('script');
    s.defer = true;
    s.setAttribute('data-domain', String(f.ANALYTICS_DOMAIN || location.hostname));
    s.src = f.ANALYTICS_SRC;
    document.head.appendChild(s);
  }

  function track(eventName, props) {
    try {
      if (!enabled()) return;
      var data = Object.assign({ path: location.pathname, ts: Date.now() }, props || {});
      if (typeof window.plausible === 'function') {
        window.plausible(eventName, { props: data });
      }
      if (isLocal() && window.console) console.log('[KSTrack]', eventName, data);
    } catch (e) { /* 统计失败不影响页面 */ }
  }

  /**
   * 自动为带 data-track 属性的元素绑定点击事件。
   * 用法：<a data-track="click_book_demo" data-track-source="hero">
   * 未启用统计时不绑定任何监听。
   */
  function attachAutoTracking() {
    document.querySelectorAll('[data-track]').forEach(function (el) {
      el.addEventListener('click', function () {
        var props = {};
        Array.prototype.forEach.call(el.attributes, function (attr) {
          if (attr.name.indexOf('data-track-') === 0) {
            var key = attr.name.replace('data-track-', '').replace(/-/g, '_');
            props[key] = attr.value;
          }
        });
        props.label = (el.textContent || '').trim().slice(0, 60);
        props.href = el.getAttribute('href') || '';
        track(el.getAttribute('data-track'), props);
      });
    });
  }

  function init() {
    if (!enabled()) return;
    loadProvider();
    attachAutoTracking();
    track('page_view', { title: document.title, referrer: document.referrer });
  }

  window.KSTrack = { track: track, enabled: enabled };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
