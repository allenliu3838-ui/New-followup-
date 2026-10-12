// 迁移到境内后，服务器上 /var/www/kidneysphere-registry/config.js 的参考写法（见 docs/CN_MIGRATION.md 第 6.14 步）。
// 这是示例文件，不会被发布工具部署；正式 config.js 只在服务器上由运维人员替换。
//
// - SUPABASE_URL：境内新接口地址（Kong 网关经 Nginx 反向代理后的 HTTPS 域名）。
// - SUPABASE_ANON_KEY：新环境的匿名访问密钥（由新 JWT_SECRET 签发，role=anon）。它会下发到浏览器，属于公开信息；
//   service_role 密钥、数据库密码、SMTP 密码绝不能写进这个文件。
// - 收款码图片：迁到新环境公开存储桶 billing 后的地址；也可以改为本站同源路径（例如 /billing/wechat-qr.jpg）。
// - FEATURES：两个开关在代码里的缺省值都是关闭（只有严格等于 true 才开启），这里显式写 false 便于审查。
window.CONFIG = {
  SUPABASE_URL: "https://api.kidneysphereregistry.cn",
  SUPABASE_ANON_KEY: "<新环境 ANON_KEY，迁移当天填写>",

  // 付费升级入口
  UPGRADE_URL:   "/checkout",
  UPGRADE_EMAIL: "china@kidneysphere.com",

  BILLING: {
    WECHAT_QR_IMG: "https://api.kidneysphereregistry.cn/storage/v1/object/public/billing/wechat-qr.png.jpg",
    WECHAT_LABEL:  "上海胤域医学科技有限公司的店铺",

    ALIPAY_QR_IMG: "https://api.kidneysphereregistry.cn/storage/v1/object/public/billing/alipay-qr.png.jpg",
    ALIPAY_LABEL:  "上海胤域医学科技有限公司",

    BANK_NAME:     "上海胤域医学科技有限公司",
    BANK_ACCOUNT:  "09-410901040031935",
    BANK_BRANCH:   "中国农业银行",

    CONTACT_EMAIL: "china@kidneysphere.com",
    CONTACT_WECHAT: "GlomConChina1",

    PRO_MONTHLY_BASE:  499,
    PRO_MONTHLY_EXTRA: 99,
    PRO_YEARLY_BASE:   4790,
    PRO_YEARLY_EXTRA:  950,
    PRO_BASE_PROJECTS: 3,
  },

  FEATURES: {
    // 基因变异模块：涉及人类遗传资源管理。迁移完成、且研究方/机构完成人类遗传资源合规评估之前保持 false。
    GENETICS: false,
    // 页面访问统计：保持 false。如需统计，只能改用境内自托管的统计服务，填写 ANALYTICS_SRC，
    // 先更新隐私政策“自动收集的信息”一节，再开启；未填写 ANALYTICS_SRC 时代码会请求境外 plausible.io。
    ANALYTICS: false,
    // ANALYTICS_SRC: "https://stats.kidneysphereregistry.cn/js/script.tagged-events.js",
    // ANALYTICS_DOMAIN: "kidneysphereregistry.cn",
  },
};
