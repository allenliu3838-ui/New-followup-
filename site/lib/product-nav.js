/* 肾域跨产品导航条（本站同源实现）
 * 替代原先从 kidneysphere.com 加载的共享顶栏脚本：本站与工作台同源，
 * 外站脚本能读取浏览器中保存的登录会话，故改为本站自带、不依赖外站的实现。
 * 只创建链接元素，不读写存储、不发请求。产品列表变化时在此同步。
 */
(function () {
  'use strict';
  var PRODUCTS = [
    { label: '学院', icon: '💬', href: 'https://kidneysphere.com', host: 'kidneysphere.com' },
    { label: '科研', icon: '🔬', href: 'https://kidneysphereregistry.cn', host: 'kidneysphereregistry.cn' },
    { label: '随诊', icon: '👨‍⚕️', href: 'https://kidneysphereremote.cn', host: 'kidneysphereremote.cn' },
    { label: '记录', icon: '📋', href: 'https://kidneyspherefollowup.cn', host: 'kidneyspherefollowup.cn' },
    { label: '医生', icon: '📱', href: 'https://kidneyspheredoctorapp.cn', host: 'kidneyspheredoctorapp.cn' }
  ];
  if (document.getElementById('ks-product-nav')) return;
  // 此文件只随登记站发布，当前产品恒为"科研"（与访问所用域名无关，迁移换域名后仍正确）
  var current = 'kidneysphereregistry.cn';

  function link(text, href, active) {
    var a = document.createElement('a');
    a.className = 'ks-nav-link';
    a.href = href;
    a.textContent = text;
    if (active) {
      a.setAttribute('aria-current', 'page');
    } else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  }

  var nav = document.createElement('nav');
  nav.id = 'ks-product-nav';
  nav.setAttribute('aria-label', '肾域产品');
  var brand = link('肾域', 'https://kidneysphere.com', false);
  brand.className = 'ks-nav-brand';
  nav.appendChild(brand);
  PRODUCTS.forEach(function (p) {
    nav.appendChild(link(p.icon + ' ' + p.label, p.href, current === p.host));
  });

  function mount() {
    if (document.body && !document.getElementById('ks-product-nav')) {
      document.body.insertBefore(nav, document.body.firstChild);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
