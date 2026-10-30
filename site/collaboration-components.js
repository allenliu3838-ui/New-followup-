(function(){
  var CONTACT_EMAIL = 'china@kidneysphere.com';

  function escapeHtml(str=''){
    return String(str == null ? '' : str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
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
    return `
      <article class="${compact ? 'compact-card' : 'price-card'}" id="path-${escapeHtml(item.id)}">
        <div class="price-title">${escapeHtml(item.title)}</div>
        <div class="small">${escapeHtml(item.who)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.cycle)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.scenario)}</div>
        <div class="btnbar" style="margin-top:10px">
          <a class="btn small" href="${escapeHtml(item.ctaHref)}">${escapeHtml(item.ctaLabel)}</a>
        </div>
      </article>`;
  }

  function listItems(arr){
    if (!arr || !arr.length) return '';
    return arr.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('');
  }

  // 项目状态由已核实的字段推导，不由卡片文案自行声明：
  // 只有牵头单位、项目负责人和伦理批件号都已登记时，才显示“招募中”。
  var STATUS_PROPOSED = '拟议方向（征集牵头单位）';
  var STATUS_PROPOSED_NOTE = '尚未确定牵头单位、项目负责人和伦理批件。下方的研究问题、目标规模和支持内容均为初步设想，需由牵头团队按正式方案确认。';
  var STATUS_RECRUITING = '招募中';

  function projectStatus(item){
    var confirmed = !!(item && item.leadInstitution && item.principalInvestigator && item.ethicsApprovalNo);
    if (confirmed) {
      return {
        label: STATUS_RECRUITING,
        cls: 'ok',
        note: '牵头单位：' + item.leadInstitution + ' · 项目负责人：' + item.principalInvestigator + ' · 伦理批件号：' + item.ethicsApprovalNo
      };
    }
    return { label: STATUS_PROPOSED, cls: 'proposed', note: STATUS_PROPOSED_NOTE };
  }

  // 卡片按钮打开合作咨询表单，并带上研究代码；表单按代码在 CollabData 中查出研究名称写入留言，
  // 每条申请都记入咨询记录，便于逐条跟进。
  var JOIN_TYPE = '参与研究合作方向';
  function applyHref(item){
    return '/demo?type=' + encodeURIComponent(JOIN_TYPE) + '&study=' + encodeURIComponent(item.slug);
  }

  function ProjectCard(item){
    var st = projectStatus(item);
    var statusStyle = st.cls === 'proposed' ? ' style="background:rgba(217,119,6,.10);color:#92400e;border:1px solid rgba(217,119,6,.28)"' : '';
    var statusHtml = '<span class="proj-status ' + escapeHtml(st.cls) + '"' + statusStyle + '>' + escapeHtml(st.label) + '</span>';
    var statusNoteHtml = '<div class="small muted" style="font-size:11px;line-height:1.55;margin:0 0 6px">' + escapeHtml(st.note) + '</div>';
    var categoryHtml = item.category
      ? '<span class="pill active" style="margin-left:6px">' + escapeHtml(item.category) + '</span>'
      : '';
    var suitableHtml = item.suitableFor && item.suitableFor.length
      ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">可能适合的中心</div><ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(item.suitableFor) + '</ul></div>'
      : '';
    var fieldsHtml = item.keyFields && item.keyFields.length
      ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">建议优先准备的关键字段</div><ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(item.keyFields) + '</ul></div>'
      : '';
    var supportHtml = item.support && item.support.length
      ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px">拟提供的支持（需协商确认）</div><ul class="small" style="margin:0;padding-left:16px;line-height:1.7">' + listItems(item.support) + '</ul></div>'
      : '';
    var detailsHtml = item.detailHighlights && item.detailHighlights.length
      ? '<details class="faq" style="margin-top:8px"><summary style="font-size:12px;font-weight:600">展开详细说明</summary><ul class="small" style="margin:8px 0 0;padding-left:16px;line-height:1.7">' + listItems(item.detailHighlights) + '</ul></details>'
      : '';

    return `
      <article class="price-card project-card" id="project-${escapeHtml(item.slug)}" data-project-slug="${escapeHtml(item.slug)}" data-category="${escapeHtml(item.category || '')}" aria-labelledby="project-${escapeHtml(item.slug)}-title">
        <div style="margin-bottom:4px">${statusHtml}${categoryHtml}</div>
        ${statusNoteHtml}
        <h3 class="price-title" id="project-${escapeHtml(item.slug)}-title" style="font-size:inherit;margin:0 0 6px">${escapeHtml(item.name)}</h3>
        <div class="infobox" style="padding:8px 10px;font-size:12px;line-height:1.55;margin:8px 0">${escapeHtml(item.summary)}</div>
        ${suitableHtml}
        ${fieldsHtml}
        ${supportHtml}
        ${detailsHtml}
        <div class="btnbar" style="margin-top:10px">
          <a class="btn small primary" href="${escapeHtml(applyHref(item))}" data-apply-study="${escapeHtml(item.slug)}">${escapeHtml(item.ctaLabel || (st.cls === 'proposed' ? '咨询牵头或参与' : '联系加入'))}</a>
        </div>
        <button type="button" class="copy-email" style="display:none" data-copy-email="${CONTACT_EMAIL}" title="复制邮箱">
          📋 ${CONTACT_EMAIL}
        </button>
      </article>`;
  }

  function CaseCard(item){
    return `
      <article class="compact-card">
        <div class="price-title">${escapeHtml(item.title)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.text)}</div>
      </article>`;
  }

  function projectsHtml(items){
    return items.map(ProjectCard).join('');
  }

  function enhanceProjects(el, items){
    if (!el) return;
    var cards = Array.from(el.querySelectorAll('.project-card'));
    // Reuse authored, pre-rendered cards. A filter never rebuilds their content.
    if (cards.length !== items.length || cards.some(function(card, index){
      return card.dataset.projectSlug !== items[index].slug;
    })) {
      el.innerHTML = projectsHtml(items);
    }
    el.querySelectorAll('[data-copy-email]').forEach(function(btn){
      if (!btn.dataset.copyBound) {
        btn.addEventListener('click', function(){ copyEmail(btn.dataset.copyEmail); });
        btn.dataset.copyBound = 'true';
      }
      btn.style.removeProperty('display');
    });
  }

  window.CollabComponents = {
    // Same pure renderer is used by the deterministic build and browser fallback.
    projectsHtml: projectsHtml,
    projectStatus: projectStatus,

    renderPaths: function(el, items, compact){
      if (!el) return;
      el.innerHTML = items.map(function(i){ return CollaborationPathCard(i, compact); }).join('');
    },

    renderProjects: enhanceProjects,

    renderProjectsWithFilter: function(gridEl, tabsEl, items, tabs){
      if (!gridEl) return;
      enhanceProjects(gridEl, items);
      if (!tabsEl || tabsEl.dataset.filtersBound) return;
      tabsEl.innerHTML = tabs.map(function(t){
        return '<button type="button" class="filter-tab' + (t.id === 'all' ? ' active' : '') + '" data-id="' + escapeHtml(t.id) + '" aria-controls="' + escapeHtml(gridEl.id) + '" aria-pressed="' + (t.id === 'all' ? 'true' : 'false') + '">' + escapeHtml(t.label) + '</button>';
      }).join('');
      tabsEl.setAttribute('role', 'group');
      tabsEl.setAttribute('aria-label', '按研究方向筛选项目');
      tabsEl.querySelectorAll('.filter-tab').forEach(function(btn){
        btn.addEventListener('click', function(){
          var active = btn.dataset.id;
          tabsEl.querySelectorAll('.filter-tab').forEach(function(tab){
            var selected = tab.dataset.id === active;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-pressed', String(selected));
          });
          gridEl.querySelectorAll('.project-card').forEach(function(card){
            var visible = active === 'all' || card.dataset.category === active;
            card.hidden = !visible;
            // Inline display also works if a theme overrides the hidden selector.
            if (visible) card.style.removeProperty('display');
            else card.style.display = 'none';
          });
        });
      });
      tabsEl.dataset.filtersBound = 'true';
      tabsEl.style.removeProperty('display');
    },

    renderCases: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(CaseCard).join('');
    },

    renderFaq: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(function(f, idx){
        return '<details class="faq" ' + (idx === 0 ? 'open' : '') + '><summary>' + escapeHtml(f.q) + '</summary><div class="small">' + escapeHtml(f.a) + '</div></details>';
      }).join('');
    }
  };
})();
