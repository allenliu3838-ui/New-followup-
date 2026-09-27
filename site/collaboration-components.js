(function(){
  var CONTACT_EMAIL = 'china@kidneysphere.com';

  // 不用 String.prototype.replaceAll：部分微信内置浏览器不支持，会导致整块项目区空白
  function escapeHtml(str){
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;right:16px;bottom:20px;background:#0b1220;color:#fff;padding:9px 16px;border-radius:12px;font-size:13px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.35);transition:opacity .3s';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 350); }, 2000);
  }

  function copyEmail(email) {
    function done(){ showToast('已复制：' + email); }
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = email;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { document.execCommand('copy'); done(); }
      catch(e){ prompt('请复制邮箱地址：', email); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(email).then(done).catch(fallback);
    } else {
      fallback();
    }
  }
  window._copyEmail = copyEmail;

  function CollaborationPathCard(item, compact){
    return '<article class="' + (compact ? 'compact-card' : 'price-card') + '" id="path-' + escapeHtml(item.id) + '">'
      + '<div class="price-title">' + escapeHtml(item.title) + '</div>'
      + '<div class="small">' + escapeHtml(item.who) + '</div>'
      + '<div class="small" style="margin-top:6px">' + escapeHtml(item.cycle) + '</div>'
      + '<div class="small" style="margin-top:6px">' + escapeHtml(item.scenario) + '</div>'
      + '<div class="btnbar" style="margin-top:10px">'
      +   '<a class="btn small" href="' + escapeHtml(item.ctaHref) + '">' + escapeHtml(item.ctaLabel) + '</a>'
      + '</div>'
      + '</article>';
  }

  function listItems(arr){
    if (!arr || !arr.length) return '';
    return arr.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('');
  }

  function listBlock(label, arr){
    if (!arr || !arr.length) return '';
    return '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;letter-spacing:.5px">' + label + '</div>'
      + '<ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(arr) + '</ul></div>';
  }

  function metaBlock(item){
    return '<div class="proj-meta">'
      + '<div><b>目标中心数</b><span>' + escapeHtml(item.targetCenters || '详询') + '</span></div>'
      + '<div><b>预计样本量</b><span>' + escapeHtml(item.sampleSize || '详询') + '</span></div>'
      + '<div><b>可参与角色</b><span>' + escapeHtml(item.roles || '参与') + '</span></div>'
      + '</div>';
  }

  function ctaBlock(item){
    var subject = encodeURIComponent(item.emailSubject || ('加入项目：' + item.name));
    var mailto = 'mailto:' + CONTACT_EMAIL + '?subject=' + subject;
    var consult = '/demo?type=' + encodeURIComponent('加入现有项目') + '&project=' + encodeURIComponent(item.shortTitle || item.name);
    var slug = escapeHtml(item.slug || '');
    return '<div class="btnbar" style="margin-top:10px">'
      + '<a class="btn small primary" href="' + mailto + '" data-track="click_join_project" data-track-project="' + slug + '">我要加入</a>'
      + '<a class="btn small" href="' + consult + '" data-track="click_project_consult" data-track-project="' + slug + '">我要咨询</a>'
      + '</div>';
  }

  function statusHtml(item){
    var s = item.status
      ? '<span class="proj-status ' + escapeHtml(item.statusClass || 'ok') + '">' + escapeHtml(item.status) + '</span>'
      : '';
    var c = item.category
      ? '<span class="pill active" style="margin-left:6px">' + escapeHtml(item.category) + '</span>'
      : '';
    return '<div style="margin-bottom:4px">' + s + c + '</div>';
  }

  function ProjectCard(item, opts){
    opts = opts || {};
    if (opts.compact) {
      return '<article class="price-card project-card" data-category="' + escapeHtml(item.category || '') + '">'
        + statusHtml(item)
        + '<div class="price-title">' + escapeHtml(item.name) + '</div>'
        + '<div class="small muted" style="line-height:1.6">' + escapeHtml(item.summary) + '</div>'
        + metaBlock(item)
        + ctaBlock(item)
        + '</article>';
    }
    var detailsHtml = item.detailHighlights && item.detailHighlights.length
      ? '<details class="faq" style="margin-top:8px"><summary style="font-size:12px;font-weight:600">展开详细说明</summary><ul class="small" style="margin:8px 0 0;padding-left:16px;line-height:1.7">' + listItems(item.detailHighlights) + '</ul></details>'
      : '';
    return '<article class="price-card project-card" data-category="' + escapeHtml(item.category || '') + '">'
      + statusHtml(item)
      + '<div class="price-title">' + escapeHtml(item.name) + '</div>'
      + '<div class="infobox" style="padding:8px 10px;font-size:12px;line-height:1.55;margin:8px 0"><b>研究目的：</b>' + escapeHtml(item.summary) + '</div>'
      + metaBlock(item)
      + listBlock('适合加入的中心', item.suitableFor)
      + listBlock('建议优先准备的关键字段', item.keyFields)
      + listBlock('加入后可获得的支持', item.support)
      + detailsHtml
      + ctaBlock(item)
      + '<button class="copy-email" onclick="window._copyEmail(\'' + CONTACT_EMAIL + '\')" title="复制邮箱">📋 ' + CONTACT_EMAIL + '</button>'
      + '</article>';
  }

  function emptyState(){
    return '<div class="fallback-card">'
      + '<div class="fallback-title">项目信息更新中</div>'
      + '<div class="small muted">可直接说明你的病种与数据情况，我们会推荐合适的现有项目或协助发起新项目。</div>'
      + '<div class="btnbar" style="margin-top:8px"><a class="btn small primary" href="/demo?type=' + encodeURIComponent('加入现有项目') + '">提交合作意向</a>'
      + '<a class="btn small" href="mailto:' + CONTACT_EMAIL + '">邮件咨询</a></div>'
      + '</div>';
  }

  function CaseCard(item){
    return '<article class="compact-card">'
      + '<div class="price-title">' + escapeHtml(item.title) + '</div>'
      + '<div class="small" style="margin-top:6px">' + escapeHtml(item.text) + '</div>'
      + '</article>';
  }

  window.CollabComponents = {
    escapeHtml: escapeHtml,

    renderPaths: function(el, items, compact){
      if (!el) return;
      el.innerHTML = (items || []).map(function(i){ return CollaborationPathCard(i, compact); }).join('');
    },

    renderProjects: function(el, items, opts){
      if (!el) return;
      el.innerHTML = items && items.length
        ? items.map(function(p){ return ProjectCard(p, opts); }).join('')
        : emptyState();
    },

    renderProjectsWithFilter: function(gridEl, tabsEl, items, tabs){
      if (!gridEl) return;
      items = items || [];
      var active = 'all';

      // 只保留有项目的分类，避免点开空分类
      var visibleTabs = (tabs || []).filter(function(t){
        return t.id === 'all' || items.some(function(p){ return p.category === t.id; });
      });

      function renderTabs(){
        if (!tabsEl) return;
        if (visibleTabs.length <= 2) { tabsEl.innerHTML = ''; return; }
        tabsEl.innerHTML = visibleTabs.map(function(t){
          return '<button class="filter-tab' + (t.id === active ? ' active' : '') + '" data-id="' + escapeHtml(t.id) + '">' + escapeHtml(t.label) + '</button>';
        }).join('');
        tabsEl.querySelectorAll('.filter-tab').forEach(function(btn){
          btn.addEventListener('click', function(){
            active = btn.dataset.id;
            renderTabs();
            renderGrid();
          });
        });
      }

      function renderGrid(){
        var visible = active === 'all'
          ? items
          : items.filter(function(p){ return p.category === active; });
        gridEl.innerHTML = visible.length
          ? visible.map(function(p){ return ProjectCard(p); }).join('')
          : emptyState();
      }

      renderTabs();
      renderGrid();
    },

    renderCases: function(el, items){
      if (!el) return;
      el.innerHTML = (items || []).map(CaseCard).join('');
    },

    renderFaq: function(el, items){
      if (!el) return;
      el.innerHTML = (items || []).map(function(f, idx){
        return '<details class="faq" ' + (idx === 0 ? 'open' : '') + '><summary>' + escapeHtml(f.q) + '</summary><div class="small">' + escapeHtml(f.a) + '</div></details>';
      }).join('');
    }
  };
})();
