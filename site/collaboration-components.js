(function(){
  function escapeHtml(str=''){
    return str
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function CollaborationPathCard(item, compact){
    return `
      <article class="${compact ? 'compact-card' : 'price-card'}" id="path-${item.id}">
        <div class="price-title">${escapeHtml(item.title)}</div>
        <div class="small">${escapeHtml(item.who)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.cycle)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.scenario)}</div>
        <div class="btnbar" style="margin-top:10px">
          <a class="btn small" href="${item.ctaHref}">${escapeHtml(item.ctaLabel)}</a>
        </div>
      </article>`;
  }

  function ProjectCard(item){
    function val(s){ return s ? s.replace(/^[^：]+：/, '') : s; }
    return `
      <article class="price-card project-card">
        <div class="price-title">${escapeHtml(item.name)}</div>
        <div class="pills" style="margin:6px 0 8px">
          <span class="pill active">模块：${escapeHtml(item.module)}</span>
        </div>
        <div class="infobox" style="padding:8px 10px;font-size:12px;line-height:1.5;margin-bottom:8px">
          ${escapeHtml(val(item.question))}
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:5px 10px;font-size:12px;align-items:baseline">
          <span style="color:var(--muted);white-space:nowrap">必填字段</span><span>${escapeHtml(val(item.required))}</span>
          <span style="color:var(--muted);white-space:nowrap">样本量</span><span>${escapeHtml(val(item.sample))}</span>
          <span style="color:var(--muted);white-space:nowrap">随访周期</span><span>${escapeHtml(val(item.followup))}</span>
          <span style="color:var(--muted);white-space:nowrap">目标期刊</span><span>${escapeHtml(val(item.deliverables))}</span>
          <span style="color:var(--muted);white-space:nowrap">参与方式</span><span>${escapeHtml(val(item.participation))}</span>
        </div>
        <div class="btnbar" style="margin-top:10px">
          <a class="btn small primary" href="mailto:china@kidneysphere.com">联系加入</a>
          <a class="btn small" href="/demo">预约演示</a>
        </div>
      </article>`;
  }

  function CaseCard(item){
    return `
      <article class="compact-card">
        <div class="price-title">${escapeHtml(item.title)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(item.text)}</div>
      </article>`;
  }

  window.CollabComponents = {
    renderPaths: function(el, items, compact=false){
      if (!el) return;
      el.innerHTML = items.map(i => CollaborationPathCard(i, compact)).join('');
    },
    renderProjects: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(ProjectCard).join('');
    },
    renderCases: function(el, items){
      if (!el) return;
      el.innerHTML = items.map(CaseCard).join('');
    },
    renderFaq: function(el, items){
      if (!el) return;
      el.innerHTML = items.map((f,idx)=>`
        <details class="faq" ${idx===0?'open':''}>
          <summary>${escapeHtml(f.q)}</summary>
          <div class="small">${escapeHtml(f.a)}</div>
        </details>
      `).join('');
    }
  }
})();
