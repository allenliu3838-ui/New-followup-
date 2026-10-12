// 项目卡状态由 collaboration-components.js 根据 leadInstitution、principalInvestigator、ethicsApprovalNo
// 三个字段推导；三者都有可核实来源时才显示“招募中”，否则显示“拟议方向（征集牵头单位）”。
// 请勿在没有书面依据时填写这三个字段。
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
      slug: 'igan-cohort',
      name: 'IgAN 动态风险重分层多中心双向队列',
      shortTitle: 'IgAN 双向队列',
      category: '肾小球疾病',
      summary: '活检后 6/12 个月的动态反应——蛋白尿达标、血尿缓解、eGFR 轨迹——能否比活检时基线资料更准确地预测 3–5 年肾脏结局？',
      suitableFor: ['单中心 IgAN 专科门诊或活检随访队列', '有 6 / 12 月复诊记录的肾脏专科中心'],
      keyFields: ['基线 + 6/12 月时间窗：日期 / BP / Scr / UPCR / eGFR / 用药', 'Oxford MEST-C 病理（增强分析用，非必须）'],
      support: ['标准化 eCRF 与数据字典', '核心字段完整率检查与补录建议', '数据质控报告与冻结数据版本导出'],
      detailHighlights: ['双层设计：核心数据集即可入组；病理 / 血尿 / 治疗序贯完整者进增强分析', '初步设想：10–20 家中心、800–1500 例，需由牵头团队按统计计划确定'],
      emailSubject: '咨询合作方向：IgAN 动态风险重分层多中心双向队列'
    },
    {
      slug: 'speed-igan',
      name: 'SPEED-IgAN · 靶向布地奈德 vs 口服甲泼尼龙 RCT',
      shortTitle: 'SPEED-IgAN RCT',
      category: '肾小球疾病',
      summary: '在有进展风险的原发性 IgAN 中，靶向释放布地奈德与口服甲泼尼龙相比，12 个月蛋白尿缓解率和安全性的差异。',
      suitableFor: ['具备 RCT 执行能力的肾内科中心', '有完整入排筛选与随机分配流程的中心'],
      keyFields: ['随机分组信息 + 基线资料', '随访核心四项：日期 / BP / Scr / UPCR', '不良事件记录'],
      support: ['入排标准核查清单', '随访到期与逾期名单、字段完整率追踪', '安全性与蛋白尿数据的冻结版本导出'],
      detailHighlights: ['需先确定牵头单位、正式方案与伦理批准；参与中心按方案提供随访数据', '拟议主要终点时间点 12 个月，可延伸至 24 个月（以正式方案为准）'],
      emailSubject: '咨询合作方向：SPEED-IgAN RCT'
    },
    {
      slug: 'c3g-cohort',
      name: 'C3G 多中心前瞻性队列',
      shortTitle: 'C3G 队列',
      category: '罕见病/高壁垒',
      summary: 'C3 肾小球病（C3GN / DDD）的临床病理特征、补体谱、治疗实践与长期肾脏结局——真实世界多中心描述与预后分析。',
      suitableFor: ['有 C3G / DDD 诊断能力的病理科或肾内科中心', 'DDD 等罕见表型中心尤为欢迎'],
      keyFields: ['基线：年龄 / Scr / UPCR / C3/C4 / 病理分型', '随访核心四项（随访 12–36 个月）'],
      support: ['数据字典与补体亚组分析模板', '罕见表型中心专项支持与子分析设计'],
      detailHighlights: ['C3G 相对罕见，需多中心汇聚；初步设想 ≥150 例', '欢迎申请牵头；补体亚组可作为子课题方向，署名规则另行约定'],
      emailSubject: '咨询合作方向：C3G 多中心前瞻性队列'
    },
    {
      slug: 'mgrs-registry',
      name: 'MGRS 单克隆免疫球蛋白相关肾损害多中心前瞻性登记',
      shortTitle: 'MGRS 登记',
      category: '罕见病/高壁垒',
      summary: 'MGRS 的临床谱、病理类型、治疗选择（克隆靶向 vs 肾脏保护）与肾脏结局——建立多中心真实世界数据库。',
      suitableFor: ['有血液科-肾内科联合诊治能力的医疗中心', '已开展克隆靶向治疗的参与中心优先'],
      keyFields: ['单克隆免疫球蛋白类型 / 浓度 + 病理分型', '基线 Scr / UPCR + 治疗方案'],
      support: ['前瞻性登记 eCRF 与数据字典', '克隆治疗反应随访模板', '亚组分析方法学支持'],
      detailHighlights: ['初步设想 ≥200 例，按病理亚型分层分析', '有血液科合作资源的中心优先；克隆治疗反应可作为子课题方向'],
      emailSubject: '咨询合作方向：MGRS 多中心前瞻性登记'
    },
    {
      slug: 'mn-rtx-obi',
      name: '高危膜性肾病 RTX vs OBI 多中心观察性比较研究',
      shortTitle: 'MN RTX vs OBI',
      category: '肾小球疾病',
      summary: '在高危原发性膜性肾病中，首次 anti-CD20 治疗选择利妥昔单抗（RTX）还是奥比妥珠单抗（OBI），谁的缓解率更高、复发更少、安全性更好？',
      suitableFor: ['有膜性肾病规范随访能力的肾内科中心', '0 / 3 / 6 / 12 月有时间点数据的中心'],
      keyFields: ['核心四项：0/3/6/12 月时间点的日期 / BP / Scr / UPCR', 'anti-PLA2R / 白蛋白 / CD19 可选（增强分析）'],
      support: ['核心四项（日期 / 血压 / 血肌酐 / 尿蛋白）完整即可参与主分析（拟议设计）', 'PLA2R 动态 / 免疫学 / 安全性子分析支持'],
      detailHighlights: ['分层设计：核心四项完整即可参与主分析，其余字段用于增强分析', '免疫学（PLA2R 动态）/ 安全性 / 再治疗可作为子课题方向'],
      emailSubject: '咨询合作方向：高危膜性肾病 RTX vs OBI 多中心观察性比较研究'
    },
    {
      slug: 'hd-registry',
      name: 'HD 透析起始频次真实世界登记',
      shortTitle: 'HD 起始频次',
      category: '透析/康复',
      summary: '血液透析起始阶段透析频次的选择（每周 2 次 vs 3 次）对患者短中期临床结局、生活质量与院内资源利用的影响。',
      suitableFor: ['有透析中心的肾内科或血液净化科', '覆盖不同透析频次实践模式的中心'],
      keyFields: ['HD 起始日期 / 起始频次 / 基线 Scr', '主要临床结局（随访 12–24 个月）'],
      support: ['登记式 eCRF 与数据字典', '资源利用与生活质量子分析模板'],
      detailHighlights: ['初步设想 ≥300 例；多中心以覆盖不同实践模式', '可延伸至生活质量与院内经济性子分析'],
      emailSubject: '咨询合作方向：HD 透析起始频次真实世界登记'
    },
    {
      slug: 'regain-pa',
      name: 'REGAIN-PA · CKD / 透析患者体力活动干预实施研究',
      shortTitle: 'REGAIN-PA',
      category: '透析/康复',
      summary: '在 CKD 及透析患者中实施结构化体力活动干预的真实世界可行性、依从性及对临床指标（eGFR / 生活质量 / 肌力）的影响。',
      suitableFor: ['具备运动康复或肾脏康复专病门诊资源的中心', '有透析患者规律随访体系的中心'],
      keyFields: ['CKD 分期 / 透析方式 + 体力活动基线评估', '干预方案 + 随访核心四项（6–12 个月）'],
      support: ['实施型研究 eCRF 与干预方案模板', '依从性追踪与长期透析结局子分析'],
      detailHighlights: ['以实施型研究设计为主，初步设想 ≥150 例', '可延伸至长期透析结局子分析'],
      emailSubject: '咨询合作方向：REGAIN-PA CKD/透析患者体力活动干预实施研究'
    },
    {
      slug: 'dkd-access',
      name: 'DKD-ACCESS 糖尿病合并 CKD 平台队列',
      shortTitle: 'DKD-ACCESS',
      category: '糖尿病/代谢肾病',
      summary: '面向成人糖尿病合并 CKD 的多中心、分层准入、前瞻-回顾结合平台队列，聚焦器官保护治疗落实度、竞争风险与硬结局，支持不同数据能力层级的中心共同参与。',
      suitableFor: [
        'A 类站点：可提供 eGFR、UACR 或 dipstick protein、基础用药和转诊信息的筛查链条站点',
        'B 类站点：可提供重复 Scr/eGFR，最好有重复 UACR 的标准随访站点',
        'C 类站点：可提供眼底/视网膜病变、PROMs、样本库、超声或 cystatin C 等增强模块的站点'
      ],
      keyFields: [
        '年龄、性别、糖尿病类型与病程',
        'SBP / DBP、HbA1c',
        'Scr / eGFR、UACR（无 UACR 时可先记录 dipstick protein）',
        '血钾、白蛋白、血红蛋白',
        '视网膜病变有/无、ASCVD / HF 有/无',
        '现用药：ACEi/ARB、SGLT2i、GLP-1RA、finerenone/ns-MRA、statin、diuretics'
      ],
      support: [
        '分层准入的 eCRF 与数据字典',
        '关键字段完整率检查与补录建议',
        'KDIGO G/A 风险分层与基础分析模板',
        '诊疗链条（筛查—监测—转诊）描述与冻结数据版本导出',
        '支持后续嵌套子研究与增强模块扩展'
      ],
      detailHighlights: [
        '主队列定义：成人糖尿病合并 CKD 平台队列，支持从回顾性数据快速起步并承接后续前瞻随访',
        '适合开展筛查-监测-转诊 care cascade、治疗落实度与硬结局研究',
        '支持后续 target trial emulation、表型分层与风险模型嵌套子研究'
      ],
      emailSubject: '咨询合作方向：DKD-ACCESS 糖尿病合并 CKD 平台队列'
    },
    {
      slug: 'ktr-care-china',
      name: 'KTR-CARE China · 肾移植受者多中心真实世界长期随访队列',
      shortTitle: 'KTR-CARE China',
      category: '肾移植',
      summary: '拟建立标准化、可扩展的肾移植受者长期随访数据库，研究移植物功能下降、严重感染与住院的可干预因素，并探索门诊可用的风险分层方法。同一母队列拟设多个子课题方向。',
      suitableFor: [
        '有肾移植患者长期随访基础的肾移植内科 / 肾内科',
        '协作随访中心（不要求本中心开展移植手术）',
        '无需具备 DSA、dd-cfDNA、protocol biopsy 等高端检测能力'
      ],
      keyFields: [
        'Scr / eGFR、蛋白尿（每次随访）',
        '免疫抑制方案：Tac/CsA/belatacept/mTORi；MPA/AZA；激素',
        'Tac / CsA trough 水平',
        '病史：排斥、BK、CMV、糖尿病、高血压、CVD',
        '门诊血压、感染、住院、是否 biopsy-proven 排斥'
      ],
      support: [
        '统一 CRF 与数据字典，最低变量集对应常规门诊记录',
        '拟设子课题方向（移植物功能下降、蛋白尿、Tac 变异性、感染、代谢等）',
        '方法学与统计支持（Cox / 竞争风险 / 时间依赖分析）',
        '子课题申请机制（concept sheet），青年医生可申请牵头',
        '建议每 3–6 个月门诊节奏更新，回顾+前瞻结合'
      ],
      detailHighlights: [
        '不统一免疫方案，不要求 protocol biopsy，协作随访中心均可加入',
        '拟设子课题：移植物功能下降风险模型、蛋白尿与结局、Tac trough 变异性、感染负担、代谢并发症、中心管理差异、低资源场景风险分层'
      ],
      emailSubject: '咨询合作方向：KTR-CARE China 肾移植受者多中心长期随访队列'
    },
    {
      slug: 'pd-open-china',
      name: 'PD-OPEN China · 中国腹膜透析开放协作平台研究',
      shortTitle: 'PD-OPEN China',
      category: '腹膜透析',
      summary: '拟构建多中心、可扩展的腹膜透析平台队列，研究中心实践差异与患者结局（如 12 个月永久转 HD）的关系，并在此基础上开展感染对标、增量腹透、急诊起始等嵌套子研究。',
      suitableFor: [
        'A 类（核心队列）：有稳定 PD 门诊或住院管理团队，能判断主要结局',
        'B 类（中心年度调查）：每年完成 1 次 10–15 分钟的中心实践调查',
        'C 类（增强模块）：可提供 PROM、PET/RKF、容量管理、远程管理数据的中心'
      ],
      keyFields: [
        'PD 起始日期、planned vs urgent 起始、既往 HD 暴露',
        '处方类型：CAPD / APD；增量 vs 标准 PD',
        'Hb、白蛋白、钾、磷、Scr；24 小时尿量或无尿状态',
        '腹膜炎事件（日期、病原、是否拔管）、出口/隧道感染',
        '转 HD 日期与原因、住院、死亡、移植'
      ],
      support: [
        '分层准入 eCRF 与统一数据字典（支持 Excel / REDCap / 本地系统导出映射）',
        '每季度反馈各中心缺失率、逻辑冲突与事件定义核查清单',
        '拟议论文方向清单（需牵头团队确认，不承诺发表）',
        '子课题申请机制（concept sheet），青年医生可申请牵头',
        '数据质量目标（如核心变量完整率、主要终点缺失率）由牵头团队在方案中约定'
      ],
      detailHighlights: [
        '拟议主终点：12 个月永久转 HD（定义以正式方案为准），记录原因',
        '腹膜炎与出口感染率可对照 ISPD 指南建议进行中心间比较',
        '可开展增量起始 vs 标准起始、急诊起始、低钾、残余肾功能等嵌套子研究'
      ],
      emailSubject: '咨询合作方向：PD-OPEN China 腹膜透析开放协作平台研究'
    }
  ],

  filterTabs: [
    { id: 'all', label: '全部' },
    { id: '肾小球疾病', label: '肾小球疾病' },
    { id: '糖尿病/代谢肾病', label: '糖尿病 / 代谢肾病' },
    { id: '罕见病/高壁垒', label: '罕见病 / 高壁垒' },
    { id: '透析/康复', label: '透析 / 康复' },
    { id: '肾移植', label: '肾移植' },
    { id: '腹膜透析', label: '腹膜透析' }
  ],

  caseCards: [
    {
      title: '单中心起步（示意流程，非真实案例）',
      text: '先用模拟病例熟悉录入，再录入获准范围内的真实病例；完成第一轮数据质控后，按问题清单补录关键字段。'
    },
    {
      title: '多中心联合（示意流程，非真实案例）',
      text: '各中心在同一项目中按中心代码录入；按约定节奏生成冻结数据版本，跟踪核心字段完整率。'
    },
    {
      title: '牵头单位组织（示意流程，非真实案例）',
      text: '牵头单位先完成方案、CRF 与数据字典，再组织参与中心用模拟数据试运行，逐步进入真实数据阶段。'
    }
  ],

  faqList: [
    {
      q: '我们只有部分字段，能不能先加入？',
      a: '多数拟议项目采用分层设计：核心四项（日期 / 血压 / 血肌酐 / 尿蛋白）完整即可参与主分析，其余字段用于增强分析。具体以各项目正式方案为准。'
    },
    {
      q: '加入后多久能拿到首版结果？',
      a: '取决于方案审批、字段准备和数据录入进度，我们不作统一承诺。数据质控报告与冻结数据版本可以随时在工作台生成，描述性分析的时间按项目节点协商。'
    },
    {
      q: '如果想牵头新项目，最少需要准备什么？',
      a: '明确的研究问题、初步的病例来源和招募预期、愿意承担的牵头职责。CRF、数据字典和统计分析计划需要与方法学团队共同制定，系统不会自动生成统计方案。'
    },
    {
      q: '我们只有筛查数据，没有完整随访，能参加哪个层级？',
      a: '对于 DKD-ACCESS 等拟议平台队列，设想中 A 类站点（筛查链条）提供 eGFR / UACR / 基础用药信息即可参与；具体纳入条件以牵头团队确认的方案为准。'
    },
    {
      q: '项目是否支持后续嵌套子研究？',
      a: '多个拟议项目设想了增强模块与嵌套子研究，是否开展及署名规则，由牵头团队与参与中心另行约定。'
    },
    {
      q: '参与项目需要先买系统吗？',
      a: '不需要。被项目负责人邀请加入项目的成员不需要另行付费；只有自己创建项目时才按自己的账户计算试用或订阅。可先通过合作咨询确认路径。'
    },
    {
      q: '一个中心能否同时加入多个项目？',
      a: '可以。建议按项目分别管理字段与导出节奏，避免分析口径混淆。'
    },
    {
      q: '如何确认自己符合某个项目的纳入标准？',
      a: '卡片中的字段和中心描述只是初步设想，正式纳入标准以牵头团队确定的方案为准；如有疑问，请发邮件至 china@kidneysphere.com。'
    }
  ]
};
