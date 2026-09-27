/**
 * marketing.js — 首页 / 价格页 / 合作页 / 支付页的文案与卡片配置（单一数据源）
 * TODO: 项目、指标接入后端数据源后，由接口数据覆盖此处静态值。
 */
(function(){
  "use strict";

  // 咨询类型需与 /demo 表单 #f_inquiry_type 的 option value 保持一致
  var stageEntries = [
    {
      id: 'plan',
      icon: '🧭',
      title: '我有课题想法，需要把方案定下来',
      desc: '输出 PICO / endpoint / 样本量 / 变量清单 / CRF 草案。',
      ctaLabel: '查看方法学启动包 →',
      ctaHref: '/pricing#service-plan'
    },
    {
      id: 'data',
      icon: '📊',
      title: '我已经有数据，想尽快拿到首版结果',
      desc: '支持数据导入、QC、补录清单、首版 Table / Figure 输出。',
      ctaLabel: '查看数据治理路径 →',
      ctaHref: '/pricing#service-data'
    },
    {
      id: 'multi',
      icon: '🏥',
      title: '我在做多中心 / 机构合作',
      desc: '统一编码、统一 CRF、合并分析、权限与合规支持。',
      ctaLabel: '查看机构合作方案 →',
      ctaHref: '/collaboration'
    }
  ];

  var servicePackages = [
    {
      id: 'plan',
      anchor: 'service-plan',
      icon: '🧭',
      title: '方法学启动包',
      forWhom: '有课题方向、需要把方案落成可执行文档的 PI / 课题组。',
      deliverables: [
        '研究问题梳理（PICO）',
        '纳排标准与主要终点定义',
        '变量清单与 CRF 草案',
        '样本量估算说明',
        '统计分析计划（SAP）草稿'
      ],
      excludes: [
        '不代写研究方案全文或论文',
        '不替代伦理审批与研究者学术判断'
      ],
      ctaLabel: '预约方法学咨询',
      ctaHref: '/demo?type=方法学咨询'
    },
    {
      id: 'data',
      anchor: 'service-data',
      icon: '📊',
      title: '数据导入与 QC 支持',
      forWhom: '已有 Excel / 历史表，希望尽快规范化并拿到首版结果的团队。',
      deliverables: [
        'Excel / 历史表整理',
        '字段映射与导入',
        '数据质控（缺失 / 逻辑冲突 / 异常值）',
        '缺失补录清单',
        '首轮数据冻结建议'
      ],
      excludes: [
        '不处理含 PII 的原始数据（需先去标识化）',
        '不替代研究者对源数据真实性的核查责任'
      ],
      ctaLabel: '预约数据导入咨询',
      ctaHref: '/demo?type=数据导入与QC支持'
    },
    {
      id: 'stat',
      anchor: 'service-stat',
      icon: '📈',
      title: '统计与投稿支持',
      forWhom: '数据已冻结，需要 editorial & statistical support 的团队。',
      deliverables: [
        '统计分析支持',
        '图表与结果整理',
        '英文润色建议',
        '投稿策略建议',
        '返修回复辅导'
      ],
      excludes: [
        '不代写全文、不代投',
        '不承诺发表或录用',
        '不参与署名决定'
      ],
      ctaLabel: '预约统计与投稿咨询',
      ctaHref: '/demo?type=统计与投稿支持'
    }
  ];

  // 只放可核验的能力 / 覆盖范围，不放未经授权的用户数、医院名
  // TODO: 有经授权的真实运营数据后替换 value
  var metricsStrip = [
    { value: '9', label: '覆盖病种 / 场景', hint: 'IgAN · MN · LN · C3G · MGRS · DKD · 透析 · 移植 · PD' },
    { value: '10', label: '公开合作项目', hint: '招募中 / 牵头招募', source: 'projects' },
    { value: '多中心', label: '协作能力', hint: 'center_code + patient_code 全局唯一合并' },
    { value: '去标识化', label: '合规底座', hint: 'RLS 权限隔离 · 审计日志 · 支持私有化部署' }
  ];

  var scenarioChips = [
    'IgAN 队列与动态风险分层',
    '膜性肾病治疗比较',
    '狼疮性肾炎缓解评估',
    '罕见病（C3G / MGRS）登记',
    'DKD 平台队列',
    '肾移植长期随访',
    '透析 / 腹透结局研究',
    '科室数据库规范化'
  ];

  // CollabData.projectCards 为空或加载失败时展示；明确标注"方向性示例"
  var fallbackProjects = [
    { slug: 'demo-igan', name: 'IgAN 多中心队列（招募方向）', category: '肾小球疾病', stage: '筹备中', status: '方向性示例', statusClass: 'prep', targetCenters: '10–20 家', sampleSize: '800–1500 例', summary: '以活检后动态反应预测长期肾脏结局。', suitableFor: ['有 IgAN 活检随访队列的肾内科'] },
    { slug: 'demo-mn', name: '膜性肾病治疗方案比较（招募方向）', category: '肾小球疾病', stage: '筹备中', status: '方向性示例', statusClass: 'prep', targetCenters: '按意向确定', sampleSize: '按意向确定', summary: '比较不同 anti-CD20 方案的缓解与复发。', suitableFor: ['有 MN 规范随访的中心'] },
    { slug: 'demo-ln', name: '狼疮性肾炎诱导缓解评估（招募方向）', category: '肾小球疾病', stage: '筹备中', status: '方向性示例', statusClass: 'prep', targetCenters: '按意向确定', sampleSize: '按意向确定', summary: '评估不同诱导方案 12 个月缓解率。', suitableFor: ['风湿免疫 / 肾内联合随访中心'] },
    { slug: 'demo-dkd', name: 'DKD 平台队列（招募方向）', category: '糖尿病/代谢肾病', stage: '筹备中', status: '方向性示例', statusClass: 'prep', targetCenters: '按意向确定', sampleSize: '按意向确定', summary: '器官保护治疗落实度与硬结局。', suitableFor: ['内分泌 / 肾内筛查链条站点'] },
    { slug: 'demo-ktx', name: '肾移植受者长期随访（招募方向）', category: '肾移植', stage: '筹备中', status: '方向性示例', statusClass: 'prep', targetCenters: '按意向确定', sampleSize: '按意向确定', summary: '移植物功能下降与感染风险因素。', suitableFor: ['有移植受者长期随访的中心'] },
    { slug: 'demo-pd', name: '腹膜透析结局研究（招募方向）', category: '腹膜透析', stage: '筹备中', status: '方向性示例', statusClass: 'prep', targetCenters: '按意向确定', sampleSize: '按意向确定', summary: '中心实践差异与转 HD 结局。', suitableFor: ['有稳定 PD 门诊的中心'] }
  ];

  var paymentMethods = [
    { id: 'wechat_qr', icon: '💚', label: '微信扫码', hint: '个人 / 小团队推荐' },
    { id: 'alipay_qr', icon: '💙', label: '支付宝扫码', hint: '个人 / 小团队推荐' },
    { id: 'bank_transfer', icon: '🏦', label: '对公转账', hint: '医院 / 机构推荐，可开专票' }
  ];

  var checkoutSteps = [
    { n: 1, title: '选择方案', lockedHint: '' },
    { n: 2, title: '填写订单信息', lockedHint: '先完成第 1 步' },
    { n: 3, title: '选择付款方式', lockedHint: '填写订单信息后解锁' },
    { n: 4, title: '上传凭证并等待核验', lockedHint: '付款后上传凭证' }
  ];

  var complianceNote = '平台与顾问服务用于研究设计、数据治理、统计与稿件支持，不替代研究者本人对研究内容、伦理合规、学术结论与署名责任的承担。';

  window.MarketingData = {
    stageEntries: stageEntries,
    servicePackages: servicePackages,
    metricsStrip: metricsStrip,
    scenarioChips: scenarioChips,
    fallbackProjects: fallbackProjects,
    paymentMethods: paymentMethods,
    checkoutSteps: checkoutSteps,
    complianceNote: complianceNote
  };
})();
