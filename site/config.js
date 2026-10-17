// 登记系统接口：阿里云上海自托管（经本站 /sb/ 反向代理）。公开密钥可公开，服务密钥只在服务器上。
window.CONFIG = {
  SUPABASE_URL: "https://kidneysphereregistry.cn/sb",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkxOTUwMDAyLCJleHAiOjE5NDk2MzAwMDJ9.yE878lkqqIGyEaaTQXpVw0y31LdUgFQ_BPO0lTy5SZc",

  // 基因模块与页面访问统计：人遗合规评估和境内统计服务就绪前保持关闭
  FEATURES: {
    GENETICS: false,
    ANALYTICS: false,
  },

  // 付费升级入口
  UPGRADE_URL:   "/checkout",
  UPGRADE_EMAIL: "china@kidneysphere.com",

  // ── 收款配置（后台可改，不要写死在 UI 代码里）──────────
  BILLING: {
    // 微信企业收款码
    WECHAT_QR_IMG: "https://kidneysphereregistry.cn/sb/storage/v1/object/public/billing/wechat-qr.png.jpg",
    WECHAT_LABEL:  "上海胤域医学科技有限公司的店铺",

    // 支付宝企业收款码
    ALIPAY_QR_IMG: "https://kidneysphereregistry.cn/sb/storage/v1/object/public/billing/alipay-qr.png.jpg",
    ALIPAY_LABEL:  "上海胤域医学科技有限公司",

    // 对公转账
    BANK_NAME:     "上海胤域医学科技有限公司",
    BANK_ACCOUNT:  "09-410901040031935",
    BANK_BRANCH:   "中国农业银行",

    // 客服
    CONTACT_EMAIL: "china@kidneysphere.com",
    CONTACT_WECHAT: "GlomConChina1",

    // 价格（前后端统一）
    PRO_MONTHLY_BASE:  499,    // 月付基础价（含 3 个项目）
    PRO_MONTHLY_EXTRA: 99,     // 月付额外项目单价
    PRO_YEARLY_BASE:   4790,   // 年付基础价（含 3 个项目）
    PRO_YEARLY_EXTRA:  950,    // 年付额外项目单价
    PRO_BASE_PROJECTS: 3,      // 基础包含项目数
  },
};
