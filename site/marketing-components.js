/**
 * marketing-components.js — 营销页通用渲染组件（无框架）
 * 约定：所有 render* 在数据为空时渲染 FallbackCard，保证不会出现"有标题、正文空白"。
 */
(function(){
  "use strict";

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isEmpty(items){ return !items || !items.length; }

  function FallbackCard(opts){
    opts = opts || {};
    var cta = opts.ctaHref
      ? '<div class="btnbar" style="margin-top:8px"><a class="btn small" href="' + esc(opts.ctaHref) + '">' + esc(opts.ctaLabel || '联系我们') + '</a></div>'
      : '';
    return '<div class="fallback-card">'
      + '<div class="fallback-title">' + esc(opts.title || '内容整理中') + '</div>'
      + '<div class="small muted">' + esc(opts.text || '如需了解详情，请邮件联系 china@kidneysphere.com 或添加微信 GlomConChina1。') + '</div>'
      + cta
      + '</div>';
  }

  function StageEntryCard(s){
    return '<a class="stage-card" href="' + esc(s.ctaHref) + '"'
      + ' data-track="click_stage_card" data-track-stage="' + esc(s.id) + '">'
      + '<div class="stage-icon" aria-hidden="true">' + esc(s.icon) + '</div>'
      + '<div class="stage-title">' + esc(s.title) + '</div>'
      + '<div class="stage-desc">' + esc(s.desc) + '</div>'
      + '<div class="stage-cta">' + esc(s.ctaLabel) + '</div>'
      + '</a>';
  }

  function ServicePackageCard(p, opts){
    opts = opts || {};
    var list = function(arr){ return (arr || []).map(function(x){ return '<li>' + esc(x) + '</li>'; }).join(''); };
    var excludes = opts.compact
      ? '<div class="svc-excl"><b>不包含：</b>' + esc((p.excludes || []).join('；')) + '</div>'
      : '<div class="svc-label">不包含</div><ul class="svc-list svc-list-excl">' + list(p.excludes) + '</ul>';
    return '<article class="svc-card" id="' + esc(p.anchor || '') + '">'
      + '<div class="svc-head"><span class="svc-icon" aria-hidden="true">' + esc(p.icon) + '</span><span class="svc-title">' + esc(p.title) + '</span></div>'
      + '<div class="svc-for"><b>适合谁：</b>' + esc(p.forWhom) + '</div>'
      + '<div class="svc-label">交付物</div>'
      + '<ul class="svc-list">' + list(p.deliverables) + '</ul>'
      + excludes
      + '<div class="btnbar" style="margin-top:auto;padding-top:10px">'
      +   '<a class="btn small primary" href="' + esc(p.ctaHref) + '" data-track="click_service_consult" data-track-service="' + esc(p.id) + '">' + esc(p.ctaLabel || '预约咨询') + '</a>'
      + '</div>'
      + '</article>';
  }

  function MetricItem(m){
    return '<div class="metric">'
      + '<div class="metric-val">' + esc(m.value) + '</div>'
      + '<div class="metric-label">' + esc(m.label) + '</div>'
      + '<div class="metric-hint">' + esc(m.hint) + '</div>'
      + '</div>';
  }

  window.MarketingUI = {
    esc: esc,
    FallbackCard: FallbackCard,

    renderFallback: function(el, opts){
      if (el) el.innerHTML = FallbackCard(opts);
    },

    renderStageEntries: function(el, items){
      if (!el) return;
      el.innerHTML = isEmpty(items)
        ? FallbackCard({ title: '研究路径整理中', ctaLabel: '预约方法学咨询', ctaHref: '/demo' })
        : items.map(StageEntryCard).join('');
    },

    renderServicePackages: function(el, items, opts){
      if (!el) return;
      el.innerHTML = isEmpty(items)
        ? FallbackCard({ title: '服务包说明整理中', ctaLabel: '预约咨询', ctaHref: '/demo' })
        : items.map(function(p){ return ServicePackageCard(p, opts); }).join('');
    },

    renderMetricStrip: function(el, items){
      if (!el) return;
      if (isEmpty(items)) { el.style.display = 'none'; return; }
      el.innerHTML = items.map(MetricItem).join('');
    },

    renderChips: function(el, items){
      if (!el) return;
      if (isEmpty(items)) { el.parentNode && (el.parentNode.style.display = 'none'); return; }
      el.innerHTML = items.map(function(c){ return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    },

    renderComplianceNotes: function(text){
      if (!text) return;
      var nodes = document.querySelectorAll('[data-compliance-note]');
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
    }
  };
})();
