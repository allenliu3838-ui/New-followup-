window.CollabData = {
  collaborationPaths: [
    {
      id: 'pilot',
      title: '试点课题',
      who: '适合谁：单中心 PI / 科研小组，准备先跑通一轮完整流程。',
      cycle: '典型周期：4–8 周',
      scenario: '推荐场景：新队列启动、科室数据库规范化、课题预实验。',
      ctaLabel: '加入试点路径',
      ctaHref: '/demo'
    },
    {
      id: 'joint',
      title: '联合项目',
      who: '适合谁：2–5 中心协作团队，已有明确研究问题。',
      cycle: '典型周期：2–4 个月',
      scenario: '推荐场景：统一字段、统一导出、按月合并复盘。',
      ctaLabel: '加入联合项目',
      ctaHref: '/demo'
    },
    {
      id: 'lead',
      title: '牵头联盟项目',
      who: '适合谁：牵头中心 / 区域联盟，需共建 CRF 与分析框架。',
      cycle: '典型周期：3–6 个月（按阶段推进）',
      scenario: '推荐场景：多中心项目合作、阶段汇报、联盟数据治理。',
      ctaLabel: '发起牵头项目',
      ctaHref: '/demo'
    }
  ],
  projectCards: [
    {
      name: 'IgAN 多中心随访项目（示例）',
      question: '研究问题：基线指标与 12 个月 eGFR 变化的关联。',
      module: 'IgAN',
      required: '最低必填字段：日期 / BP / Scr / UPCR',
      sample: '建议样本量：≥120 例（2–3 中心可起步）',
      followup: '预计随访周期：12 个月',
      deliverables: '首版可交付物：Table 1 / QC / eGFR-UPCR 趋势图 / 可复现数据包',
      participation: '参与方式：可加入 / 可申请牵头'
    },
    {
      name: 'LN 12 个月结局项目（示例）',
      question: '研究问题：不同治疗路径下 12 个月关键结局分布。',
      module: 'LN',
      required: '最低必填字段：日期 / BP / Scr / UPCR',
      sample: '建议样本量：≥80 例（单中心可试点）',
      followup: '预计随访周期：12 个月',
      deliverables: '首版可交付物：Table 1 / QC / 12m 结局表 / 可复现数据包',
      participation: '参与方式：优先加入现有项目'
    },
    {
      name: 'GENERAL / CKD 科室数据库项目（示例）',
      question: '研究问题：建立长期可复用的科室随访数据库与质控基线。',
      module: 'GENERAL',
      required: '最低必填字段：日期 / BP / Scr / UPCR',
      sample: '建议样本量：≥150 例（可持续滚动入组）',
      followup: '预计随访周期：6–24 个月',
      deliverables: '首版可交付物：Table 1 / QC / 趋势图 / 数据质量简报 / 可复现数据包',
      participation: '参与方式：加入或牵头均可'
    }
  ],
  caseCards: [
    {
      title: '某中心试点路径（脱敏示例）',
      text: '某中心在 1 个月内完成首轮 QC，并拿到首版 Table 1 用于内部汇报；随后按缺口清单补齐关键字段。'
    },
    {
      title: '某多中心联合路径（脱敏示例）',
      text: '某多中心项目完成第一次合并导出后，开始按月跟踪核心字段完整率，并在固定节奏复跑导出包。'
    },
    {
      title: '某牵头联盟路径（脱敏示例）',
      text: '某牵头单位先完成 CRF 与数据字典对齐，再组织多中心试运行，逐步建立阶段性统计简报。'
    }
  ],
  faqList: [
    {
      q: '参与项目需要先买系统吗？',
      a: '不一定。可先通过“加入现有项目/机构合作咨询”确认路径与字段准备度，再决定试用或合作方案。'
    },
    {
      q: '可以只参与，不牵头吗？',
      a: '可以。多数中心先以参与单位身份加入，待流程稳定后再评估是否牵头。'
    },
    {
      q: '一个中心能否同时加入多个项目？',
      a: '可以。建议按项目分别管理字段与导出节奏，避免分析口径混淆。'
    },
    {
      q: '机构合作和普通试用有什么不同？',
      a: '机构合作更强调多中心治理、字段对齐、QC 规则与阶段汇报；试用更适合单团队快速验证流程。'
    },
    {
      q: '能否支持院内私有化部署？',
      a: '支持。可根据信息科要求评估私有化边界、备份恢复与权限策略。'
    }
  ]
};
