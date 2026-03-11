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
    return `
      <article class="price-card project-card">
        <div class="price-title">${escapeHtml(item.name)}</div>
        <div class="small">${escapeHtml(item.question)}</div>
        <div class="pills" style="margin-top:8px"><span class="pill active">模块：${escapeHtml(item.module)}</span></div>
        <ul class="small" style="margin:10px 0 0;padding-left:18px;line-height:1.8">
          <li>${escapeHtml(item.required)}</li>
          <li>${escapeHtml(item.sample)}</li>
          <li>${escapeHtml(item.followup)}</li>
          <li>${escapeHtml(item.deliverables)}</li>
          <li>${escapeHtml(item.participation)}</li>
        </ul>
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
