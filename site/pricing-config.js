/**
 * pricing-config.js — Single source of truth for all pricing display.
 * Reads from window.CONFIG.BILLING (set in config.js).
 * All pages that display prices MUST use these helpers.
 */
(function(){
  "use strict";

  function B(){ return (window.CONFIG && window.CONFIG.BILLING) || {}; }

  var PricingConfig = {
    /** Get billing config object */
    billing: B,

    /** Format monthly base price, e.g. "¥499" */
    proMonthlyBase: function(){ return "¥" + (B().PRO_MONTHLY_BASE || 499); },

    /** Format yearly base price, e.g. "¥4,790" */
    proYearlyBase: function(){ return "¥" + (B().PRO_YEARLY_BASE || 4790).toLocaleString(); },

    /** Base project count, e.g. 3 */
    proBaseProjects: function(){ return B().PRO_BASE_PROJECTS || 3; },

    /** Monthly extra per project, e.g. "¥99" */
    proMonthlyExtra: function(){ return "¥" + (B().PRO_MONTHLY_EXTRA || 99); },

    /** Yearly extra per project, e.g. "¥950" */
    proYearlyExtra: function(){ return "¥" + (B().PRO_YEARLY_EXTRA || 950); },

    /** Short Pro summary: "¥499 / 月（含 3 个项目）" */
    proMonthlyLabel: function(){
      return PricingConfig.proMonthlyBase() + " / 月（含 " + PricingConfig.proBaseProjects() + " 个项目）";
    },

    /** Short yearly summary: "年付 ¥4,790 / 年（含 3 个项目，额外 +¥950 / 个 / 年）" */
    proYearlyLabel: function(){
      return "年付 " + PricingConfig.proYearlyBase() + " / 年（含 " + PricingConfig.proBaseProjects() + " 个项目，额外 +" + PricingConfig.proYearlyExtra() + " / 个 / 年）";
    },

    /** 年付相比 12 个月月付节省的金额，例如 "¥1,198" */
    proYearlySaving: function(){
      var b = B();
      var saving = (b.PRO_MONTHLY_BASE || 499) * 12 - (b.PRO_YEARLY_BASE || 4790);
      return "¥" + Math.max(0, saving).toLocaleString();
    },

    /* ── 试用规则（已对照数据库核实：0007_trial_30days、0033_billing_registration、0035/0036）──
     * - 试用按账户计算，30 天；账户试用期在首次创建项目时写入（若此前没有账户资料，则按注册时间起算）；
     * - 试用账户项目配额为 1（_account_access 无有效权益时 quota=1），功能与付费版相同，
     *   前端和数据库都没有按套餐区分的功能开关；
     * - 注册与试用不需要任何付款信息；付费只支持微信 / 支付宝 / 对公转账，人工核验后开通；
     * - 到期即只读：assert_project_write_allowed 在 trial_expires_at 之后拒绝录入、导入、更正、
     *   发放随访链接和患者经链接提交。projects.trial_grace_until（到期 + 7 天）只被写入、
     *   没有任何代码读取，所以不存在“7 天宽限期”，对外不要这样写；
     * - 到期后数据保留，有读取权限的成员仍可查看；create_registry_export 只检查导出权限
     *   （负责人、分析协作人），不检查试用状态，所以到期后仍可生成冻结数据版本并导出；
     * - 被邀请加入项目的成员不占自己的项目配额，能否录入取决于项目负责人账户的状态。
     * 天数和项目数可由 CONFIG.BILLING.TRIAL_DAYS / TRIAL_PROJECTS 覆盖（须与数据库一致）。 */
    trialDays: function(){ return B().TRIAL_DAYS || 30; },
    trialProjects: function(){ return B().TRIAL_PROJECTS || 1; },

    /** 全站统一的试用说明一句话 */
    trialSummary: function(){
      return PricingConfig.trialDays() + " 天免费试用 · 含 " + PricingConfig.trialProjects() +
        " 个项目 · 注册无需付款信息 · 到期后转为只读，已录数据可继续查看和导出";
    },

    /** 试用卡片标题，例如 "试用（30 天）" */
    trialTitle: function(){ return "试用（" + PricingConfig.trialDays() + " 天）"; },

    /** Extra project monthly label: "+¥99 / 个 / 月" */
    proMonthlyExtraLabel: function(){
      return "额外项目：+" + PricingConfig.proMonthlyExtra() + " / 个 / 月";
    },

    /** Render all [data-pricing] elements on the page */
    renderAll: function(){
      var els = document.querySelectorAll("[data-pricing]");
      for (var i = 0; i < els.length; i++){
        var key = els[i].getAttribute("data-pricing");
        if (PricingConfig[key] && typeof PricingConfig[key] === "function"){
          els[i].textContent = PricingConfig[key]();
        }
      }
    }
  };

  window.PricingConfig = PricingConfig;

  // Auto-render on DOMContentLoaded
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", PricingConfig.renderAll);
  } else {
    PricingConfig.renderAll();
  }
})();
