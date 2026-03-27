import { supabase } from "/lib/supabase-client.js";
import { qs, qsa, toast, fmtDate, escapeHtml } from "/lib/utils.js";
import { throttle } from "/lib/rate-limit.js";

const sb = supabase();
const B = () => window.CONFIG?.BILLING || {};

const rlOrder  = throttle("order",  { maxAttempts: 5,  windowMs: 15 * 60_000, message: "下单请求过于频繁" });
const rlUpload = throttle("upload", { maxAttempts: 10, windowMs: 15 * 60_000, message: "凭证上传过于频繁" });

// ── DOM refs ────────────────────────────────────────────────
const el = {
  loginPrompt:    qs("#loginPrompt"),
  checkoutMain:   qs("#checkoutMain"),
  // Steps
  step1: qs("#step1"), step2: qs("#step2"), step3: qs("#step3"), step4: qs("#step4"),
  dot1: qs("#dot1"), dot2: qs("#dot2"), dot3: qs("#dot3"), dot4: qs("#dot4"),
  stepLabel: qs("#stepLabel"),
  // Step 1
  planCode:     qs("#planCode"),
  billingCycle: qs("#billingCycle"),
  projectCount: qs("#projectCount"),
  totalPrice:   qs("#totalPrice"),
  priceUnit:    qs("#priceUnit"),
  priceBreakdown: qs("#priceBreakdown"),
  btnProjMinus: qs("#btnProjMinus"),
  btnProjPlus:  qs("#btnProjPlus"),
  btnToStep2:   qs("#btnToStep2"),
  // Step 2
  payerName:     qs("#payerName"),
  payerEmail:    qs("#payerEmail"),
  payerHospital: qs("#payerHospital"),
  invoiceNeeded:    qs("#invoiceNeeded"),
  invoiceFields:    qs("#invoiceFields"),
  invoiceType:      qs("#invoiceType"),
  invoiceTypeHint:  qs("#invoiceTypeHint"),
  invoiceTitleLabel: qs("#invoiceTitleLabel"),
  invoiceTaxNoCol:  qs("#invoiceTaxNoCol"),
  invoiceTitle:     qs("#invoiceTitle"),
  invoiceTaxNo:     qs("#invoiceTaxNo"),
  invoiceEmail:     qs("#invoiceEmail"),
  orderNotes:    qs("#orderNotes"),
  btnBackTo1:    qs("#btnBackTo1"),
  btnToStep3:    qs("#btnToStep3"),
  // Step 3 — elements created dynamically after order creation
  step3Content:   qs("#step3Content"),
  // Step 4
  s4OrderNo: qs("#s4OrderNo"), s4Plan: qs("#s4Plan"), s4Quota: qs("#s4Quota"),
  s4Amount: qs("#s4Amount"), s4Method: qs("#s4Method"), s4Status: qs("#s4Status"),
  s4Contact: qs("#s4Contact"),
  // My orders
  myOrdersList: qs("#myOrdersList"),
  btnRefreshOrders: qs("#btnRefreshOrders"),
};

// ── State ────────────────────────────────────────────────
let session = null;
let user = null;
let currentOrder = null;   // after order created
let currentStep = 1;
let selectedMethod = "wechat_qr";

// ── Price Calculation ────────────────────────────────────
function calcPrice() {
  const b = B();
  const cycle = el.billingCycle.value;
  const count = Math.max(3, parseInt(el.projectCount.value) || 3);
  el.projectCount.value = count;
  const extra = count - (b.PRO_BASE_PROJECTS || 3);

  let total, base, extraUnit;
  if (cycle === "monthly") {
    base = b.PRO_MONTHLY_BASE || 499;
    extraUnit = b.PRO_MONTHLY_EXTRA || 99;
    total = base + extra * extraUnit;
    el.priceUnit.textContent = "/ 月";
  } else {
    base = b.PRO_YEARLY_BASE || 4790;
    extraUnit = b.PRO_YEARLY_EXTRA || 950;
    total = base + extra * extraUnit;
    el.priceUnit.textContent = "/ 年";
  }

  el.totalPrice.textContent = `¥${total.toLocaleString()}`;
  el.priceBreakdown.textContent = extra > 0
    ? `基础 ¥${base} + 额外 ${extra} 个项目 × ¥${extraUnit} = ¥${total}`
    : `基础 ¥${base}（含 ${b.PRO_BASE_PROJECTS || 3} 个项目）`;
}

// ── Step Navigation ──────────────────────────────────────
const stepLabels = {
  1: "第 1 步：选择方案",
  2: "第 2 步：填写订单信息",
  3: "第 3 步：付款并上传凭证",
  4: "第 4 步：等待核验开通",
};

function goToStep(n) {
  currentStep = n;
  [el.step1, el.step2, el.step3, el.step4].forEach((s, i) => {
    s.classList.toggle("active", i + 1 === n);
  });
  [el.dot1, el.dot2, el.dot3, el.dot4].forEach((d, i) => {
    d.className = i + 1 < n ? "step-dot done" : i + 1 === n ? "step-dot active" : "step-dot";
    if (i + 1 < n) d.textContent = "✓";
  });
  el.stepLabel.textContent = stepLabels[n] || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Copy to clipboard (兼容 HTTP) ────────────────────────
function copyText(text, label) {
  if (!text) { toast("无内容可复制"); return; }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(`已复制${label || ""}`)).catch(() => fallbackCopy(text, label));
  } else {
    fallbackCopy(text, label);
  }
}
function fallbackCopy(text, label) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); toast(`已复制${label || ""}`); }
  catch { toast("复制失败，请手动复制"); }
  ta.remove();
}

// ── Build Step 3 payment DOM dynamically (only after order created) ──
function buildStep3(orderNo, amount) {
  const b = B();
  const memo = orderNo;
  const container = el.step3Content;
  if (!container) return;

  container.innerHTML = `
    <h2 style="margin:0 0 4px">付款</h2>
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
      <span>订单号：</span>
      <code id="orderNoDisplay" data-testid="order-no">${escapeHtml(orderNo)}</code>
      <span class="copy-btn" id="copyOrderNo">复制</span>
    </div>
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
      <span>应付金额：</span>
      <span class="amount-big" id="amountDisplay">&yen;${escapeHtml(String(amount))}</span>
      <span class="copy-btn" id="copyAmount">复制</span>
    </div>
    <div class="pay-tabs">
      <div class="pay-tab active" data-method="wechat_qr"><span class="tab-icon">&#128154;</span>微信支付</div>
      <div class="pay-tab" data-method="alipay_qr"><span class="tab-icon">&#128153;</span>支付宝</div>
      <div class="pay-tab" data-method="bank_transfer"><span class="tab-icon">&#127974;</span>对公转账</div>
    </div>
    <div class="pay-panel active" id="panel_wechat_qr">
      <div class="qr-box">
        <img src="${escapeHtml(b.WECHAT_QR_IMG || "")}" alt="微信收款码" style="max-width:260px;border-radius:14px;border:1px solid var(--border)"/>
        <div class="muted small" style="margin-top:6px">${escapeHtml(b.WECHAT_LABEL || "")}</div>
      </div>
      <div class="infobox small">
        <b>付款说明：</b><br/>
        1. 请打开微信扫一扫，扫描上方二维码<br/>
        2. 付款金额请与页面显示金额一致<br/>
        3. 付款备注请填写：<code id="wechatMemo">${escapeHtml(memo)}</code> <span class="copy-btn" id="copyWechatMemo">复制</span><br/>
        4. 支付完成后点击下方"上传付款凭证"
      </div>
    </div>
    <div class="pay-panel" id="panel_alipay_qr">
      <div class="qr-box">
        <img src="${escapeHtml(b.ALIPAY_QR_IMG || "")}" alt="支付宝收款码" style="max-width:260px;border-radius:14px;border:1px solid var(--border)"/>
        <div class="muted small" style="margin-top:6px">${escapeHtml(b.ALIPAY_LABEL || "")}</div>
      </div>
      <div class="infobox small">
        <b>付款说明：</b><br/>
        1. 请打开支付宝扫一扫，扫描上方二维码<br/>
        2. 付款金额请与页面显示金额一致<br/>
        3. 付款备注请填写：<code id="alipayMemo">${escapeHtml(memo)}</code> <span class="copy-btn" id="copyAlipayMemo">复制</span><br/>
        4. 支付完成后点击下方"上传付款凭证"
      </div>
    </div>
    <div class="pay-panel" id="panel_bank_transfer">
      <div class="bank-info">
        <div class="kv">
          <div class="muted small">公司名称</div><div>${escapeHtml(b.BANK_NAME || "")}</div>
          <div class="muted small">开户行</div><div>${escapeHtml(b.BANK_BRANCH || "")}</div>
          <div class="muted small">银行账号</div>
          <div><code id="bankAccount">${escapeHtml(b.BANK_ACCOUNT || "")}</code> <span class="copy-btn" id="copyBankAccount">复制</span></div>
          <div class="muted small">转账金额</div><div style="font-weight:700;color:var(--brand)">&yen;${escapeHtml(String(amount))}</div>
        </div>
      </div>
      <div class="infobox small" style="margin-top:10px">
        <b>转账说明：</b><br/>
        1. 转账备注请填写：<code id="bankMemo">KS${escapeHtml(orderNo)}</code> <span class="copy-btn" id="copyBankMemo">复制</span><br/>
        2. 转账完成后请上传转账回单或凭证截图
      </div>
    </div>
    <div class="hr"></div>
    <h3 style="margin:0 0 8px;font-size:15px">上传付款凭证</h3>
    <div class="upload-zone" id="uploadZone">
      <div class="muted">点击选择文件，或拖拽文件到此处</div>
      <div class="muted small">支持 PNG / JPG / PDF，最大 10MB</div>
      <input type="file" id="proofFile" accept="image/*,.pdf" style="display:none"/>
    </div>
    <div id="uploadPreview" style="display:none;margin-top:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span id="uploadFileName" class="small"></span>
        <button class="btn small" id="btnRemoveFile" style="color:#c0392b">移除</button>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="col">
        <label>实付金额（选填）</label>
        <input id="proofAmount" type="number" step="0.01" placeholder="和应付一致则可不填"/>
      </div>
      <div class="col">
        <label>付款人姓名 / 账号后四位（选填）</label>
        <input id="proofPayerInfo" placeholder="方便核验"/>
      </div>
    </div>
    <div class="btnbar">
      <button class="btn" id="btnBackTo2">上一步</button>
      <button class="btn primary" id="btnSubmitProof" disabled>提交付款凭证</button>
    </div>`;

  // Re-bind dynamic element refs
  el.orderNoDisplay = qs("#orderNoDisplay");
  el.amountDisplay = qs("#amountDisplay");
  el.proofFile = qs("#proofFile");
  el.uploadZone = qs("#uploadZone");
  el.uploadPreview = qs("#uploadPreview");
  el.uploadFileName = qs("#uploadFileName");
  el.btnRemoveFile = qs("#btnRemoveFile");
  el.proofAmount = qs("#proofAmount");
  el.proofPayerInfo = qs("#proofPayerInfo");
  el.btnBackTo2 = qs("#btnBackTo2");
  el.btnSubmitProof = qs("#btnSubmitProof");

  // Copy buttons
  qs("#copyOrderNo").onclick = () => copyText(orderNo, "订单号");
  qs("#copyAmount").onclick = () => copyText(String(amount), "金额");
  qs("#copyWechatMemo")?.addEventListener("click", () => copyText(memo, "备注"));
  qs("#copyAlipayMemo")?.addEventListener("click", () => copyText(memo, "备注"));
  qs("#copyBankMemo")?.addEventListener("click", () => copyText(`KS${orderNo}`, "转账备注"));
  qs("#copyBankAccount")?.addEventListener("click", () => copyText(b.BANK_ACCOUNT || "", "银行账号"));

  // Payment method tabs
  container.querySelectorAll(".pay-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const method = tab.dataset.method;
      selectedMethod = method;
      container.querySelectorAll(".pay-tab").forEach(t => t.classList.toggle("active", t === tab));
      container.querySelectorAll(".pay-panel").forEach(p => p.classList.toggle("active", p.id === `panel_${method}`));
    });
  });

  // Upload handlers
  setupUploadHandlers();

  // Back button
  el.btnBackTo2.addEventListener("click", () => goToStep(2));
  el.btnSubmitProof.addEventListener("click", submitProof);
}

function setupUploadHandlers() {
  el.uploadZone.addEventListener("click", () => el.proofFile.click());
  el.uploadZone.addEventListener("dragover", e => { e.preventDefault(); el.uploadZone.style.borderColor = "rgba(47,111,235,.5)"; });
  el.uploadZone.addEventListener("dragleave", () => { el.uploadZone.style.borderColor = ""; });
  el.uploadZone.addEventListener("drop", e => {
    e.preventDefault();
    el.uploadZone.style.borderColor = "";
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  el.proofFile.addEventListener("change", () => {
    if (el.proofFile.files.length) handleFile(el.proofFile.files[0]);
  });
  el.btnRemoveFile.addEventListener("click", () => {
    el.proofFile.value = "";
    el.uploadZone.classList.remove("has-file");
    el.uploadPreview.style.display = "none";
    el.btnSubmitProof.disabled = true;
  });
}

// ── Create Order ─────────────────────────────────────────
async function createOrder() {
  // If order already created (e.g. user went back from step 3), just go to step 3
  if (currentOrder) {
    goToStep(3);
    return;
  }

  if (!rlOrder.allow()) { toast(rlOrder.message); return; }

  const b = B();
  const count = Math.max(3, parseInt(el.projectCount.value) || 3);
  const extra = count - (b.PRO_BASE_PROJECTS || 3);

  // Consent check
  const agreeBox = qs("#agreeTermsCheckout");
  if (agreeBox && !agreeBox.checked) { toast("请先阅读并同意用户协议和隐私政策"); return; }

  // 发票必填校验
  if (el.invoiceNeeded.value === "yes") {
    if (!el.invoiceTitle?.value.trim()) { toast("请填写发票抬头"); return; }
    if (el.invoiceType?.value !== "personal" && !el.invoiceTaxNo?.value.trim()) {
      toast("请填写税号（单位发票必填）"); return;
    }
    if (!el.invoiceEmail?.value.trim()) { toast("请填写收票邮箱"); return; }
  }

  el.btnToStep3.disabled = true;
  el.btnToStep3.textContent = "提交中…";

  try {
    const { data, error } = await sb.rpc("create_billing_order", {
      p_plan_code:      el.planCode.value,
      p_billing_cycle:  el.billingCycle.value,
      p_extra_projects: extra,
      p_payment_method: selectedMethod,
      p_payer_name:     el.payerName.value.trim() || null,
      p_payer_email:    el.payerEmail.value.trim() || null,
      p_payer_hospital: el.payerHospital.value.trim() || null,
      p_invoice_needed: el.invoiceNeeded.value === "yes",
      p_invoice_type:   el.invoiceType?.value || "company",
      p_invoice_title:  el.invoiceTitle?.value.trim() || null,
      p_invoice_tax_no: el.invoiceTaxNo?.value.trim() || null,
      p_invoice_email:  el.invoiceEmail?.value.trim() || null,
      p_notes:          el.orderNotes.value.trim() || null,
    });

    if (error) throw error;

    currentOrder = data;
    // Log consent for checkout
    try {
      await sb.rpc("log_consent", {
        p_action: "checkout",
        p_policy_type: "both",
        p_policy_version: "v1.0",
        p_user_agent: navigator.userAgent || null,
      });
    } catch (_) { /* best-effort */ }
    buildStep3(data.order_no, data.amount_due);
    goToStep(3);
  } catch (e) {
    if (window.ErrorLogger) ErrorLogger.log("checkout.createOrder", e);
    toast("下单失败：" + (e?.message || e));
  } finally {
    el.btnToStep3.disabled = false;
    el.btnToStep3.textContent = "下一步：选择付款方式";
  }
}

// ── Upload Proof ─────────────────────────────────────────
function handleFile(file) {
  if (file.size > 10 * 1024 * 1024) { toast("文件超过 10MB"); return; }
  const validTypes = ["image/png","image/jpeg","image/jpg","image/webp","application/pdf"];
  if (!validTypes.includes(file.type)) { toast("只支持 PNG / JPG / PDF 格式"); return; }
  el.uploadZone.classList.add("has-file");
  el.uploadFileName.textContent = file.name;
  el.uploadPreview.style.display = "block";
  el.btnSubmitProof.disabled = false;

  // put file into the file input for later
  const dt = new DataTransfer();
  dt.items.add(file);
  el.proofFile.files = dt.files;
}

async function submitProof() {
  if (!rlUpload.allow()) { toast(rlUpload.message); return; }
  if (!currentOrder) { toast("请先完成下单"); return; }
  const file = el.proofFile.files[0];
  if (!file) { toast("请先选择凭证文件"); return; }

  el.btnSubmitProof.disabled = true;
  el.btnSubmitProof.textContent = "上传中…";

  try {
    // Upload to Supabase Storage — path isolated by userId/orderId
    const ext = file.name.split(".").pop();
    const path = `${user.id}/${currentOrder.order_id}/${Date.now()}.${ext}`;
    const { data: uploadData, error: uploadErr } = await sb.storage
      .from("payment-proofs")
      .upload(path, file, { contentType: file.type });

    let fileUrl;
    if (uploadErr) {
      // Storage bucket might not exist yet — use data URL as fallback
      console.warn("Storage upload failed, using placeholder:", uploadErr.message);
      fileUrl = `storage://${path}`;
    } else {
      const { data: urlData } = sb.storage.from("payment-proofs").getPublicUrl(path);
      fileUrl = urlData?.publicUrl || `storage://${path}`;
    }

    // Submit proof
    const { error } = await sb.rpc("submit_payment_proof", {
      p_order_id:       currentOrder.order_id,
      p_file_url:       fileUrl,
      p_file_name:      file.name,
      p_file_type:      file.type,
      p_amount_paid:    parseFloat(el.proofAmount.value) || null,
      p_payment_method: selectedMethod,
      p_payer_name:     el.proofPayerInfo.value.trim() || null,
    });

    if (error) throw error;

    // Go to step 4
    fillStep4();
    goToStep(4);
    toast("凭证已提交，等待平台核验");
    loadMyOrders();
  } catch (e) {
    if (window.ErrorLogger) ErrorLogger.log("checkout.submitProof", e);
    toast("提交失败：" + (e?.message || e));
  } finally {
    el.btnSubmitProof.disabled = false;
    el.btnSubmitProof.textContent = "提交付款凭证";
  }
}

function fillStep4() {
  if (!currentOrder) return;
  const b = B();
  const methodMap = { wechat_qr: "微信支付", alipay_qr: "支付宝", bank_transfer: "对公转账" };
  el.s4OrderNo.textContent = currentOrder.order_no;
  el.s4Plan.textContent = el.planCode.value === "pro" ? "Pro" : "机构版";
  el.s4Quota.textContent = `${currentOrder.project_quota} 个项目`;
  el.s4Amount.textContent = `¥${currentOrder.amount_due}`;
  el.s4Method.textContent = methodMap[selectedMethod] || selectedMethod;
  el.s4Status.innerHTML = `<span class="badge warn">待核验</span>`;
  el.s4Contact.innerHTML = `${b.CONTACT_EMAIL || ""} · 微信 ${b.CONTACT_WECHAT || ""}`;
}

// ── My Orders ────────────────────────────────────────────
const ORDER_STATUS_MAP = {
  unpaid:                { text: "待付款",   cls: "badge" },
  pending_verification:  { text: "待核验",   cls: "badge warn" },
  paid:                  { text: "已到账",   cls: "badge ok" },
  activated:             { text: "已开通",   cls: "badge ok" },
  rejected:              { text: "已驳回",   cls: "badge bad" },
  cancelled:             { text: "已取消",   cls: "badge" },
  expired:               { text: "已过期",   cls: "badge" },
  refund_pending:        { text: "退款中",   cls: "badge warn" },
  refunded:              { text: "已退款",   cls: "badge" },
};

async function loadMyOrders() {
  try {
    const { data, error } = await sb.rpc("get_my_orders");
    if (error) throw error;

    if (!data || !data.length) {
      el.myOrdersList.innerHTML = `<div class="muted small">暂无订单记录。</div>`;
      return;
    }

    const planMap = { pro: "Pro", institutional: "机构版" };
    const cycleMap = { monthly: "月付", yearly: "年付" };
    const methodMap = { wechat_qr: "微信", alipay_qr: "支付宝", bank_transfer: "转账" };

    el.myOrdersList.innerHTML = data.map(o => {
      const s = ORDER_STATUS_MAP[o.status] || { text: o.status, cls: "badge" };

      // Status-specific details
      let statusDetail = "";
      if (o.status === "activated" && o.end_at) {
        statusDetail = `<div class="small" style="margin-top:4px;color:var(--ok)">权益有效至 ${fmtDate(o.end_at)}</div>`;
      } else if (o.status === "rejected") {
        statusDetail = `<div class="small" style="margin-top:4px;color:var(--bad)">驳回原因：${escapeHtml(o.reject_reason || "—")}</div>
          <div class="small muted" style="margin-top:2px">您可以重新上传凭证或联系客服。</div>`;
      } else if (o.status === "pending_verification") {
        statusDetail = `<div class="small muted" style="margin-top:4px">凭证已提交，平台将在 1–2 个工作日内核验。${o.submitted_at ? "提交时间：" + fmtDate(o.submitted_at) : ""}</div>`;
      } else if (o.status === "expired") {
        statusDetail = `<div class="small muted" style="margin-top:4px">订单已过期。如需继续购买，请重新下单。</div>`;
      } else if (o.status === "cancelled") {
        statusDetail = `<div class="small muted" style="margin-top:4px">订单已取消。</div>`;
      } else if (o.status === "unpaid") {
        statusDetail = `<div class="small muted" style="margin-top:4px">订单待付款。请尽快完成支付。</div>`;
      } else if (o.status === "refund_pending") {
        statusDetail = `<div class="small muted" style="margin-top:4px">退款处理中，请耐心等待。</div>`;
      } else if (o.status === "refunded") {
        statusDetail = `<div class="small muted" style="margin-top:4px">已完成退款。</div>`;
      }

      return `<div class="order-status-card">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <span class="${s.cls}" style="font-size:11px">${s.text}</span>
          <code style="font-size:12px">${escapeHtml(o.order_no)}</code>
          <span class="muted small" style="margin-left:auto">${fmtDate(o.created_at)}</span>
        </div>
        <div class="small">
          ${planMap[o.plan_code] || o.plan_code} · ${cycleMap[o.billing_cycle] || o.billing_cycle}
          · ${o.project_quota} 个项目
          · &yen;${o.amount_due}
          ${o.payment_method ? ` · ${methodMap[o.payment_method] || o.payment_method}` : ""}
        </div>
        ${statusDetail}
      </div>`;
    }).join("");
  } catch (e) {
    el.myOrdersList.innerHTML = `<div class="muted small" style="color:var(--bad)">加载失败：${escapeHtml(e?.message || String(e))}</div>`;
  }
}

// ── Init ─────────────────────────────────────────────────
async function init() {
  // Auth check
  const { data: { session: s } } = await sb.auth.getSession();
  session = s;
  user = s?.user || null;

  if (!user) {
    el.loginPrompt.style.display = "block";
    el.checkoutMain.style.display = "none";
    return;
  }

  el.loginPrompt.style.display = "none";
  el.checkoutMain.style.display = "block";

  // Show loading state for orders now that we know user is logged in
  el.myOrdersList.textContent = "加载中…";

  // Pre-fill email
  el.payerEmail.value = user.email || "";

  // Price calc
  calcPrice();
  el.billingCycle.addEventListener("change", calcPrice);
  el.projectCount.addEventListener("input", calcPrice);
  el.btnProjMinus.addEventListener("click", () => {
    el.projectCount.value = Math.max(3, (parseInt(el.projectCount.value) || 3) - 1);
    calcPrice();
  });
  el.btnProjPlus.addEventListener("click", () => {
    el.projectCount.value = Math.min(30, (parseInt(el.projectCount.value) || 3) + 1);
    calcPrice();
  });

  // Invoice toggle
  el.invoiceNeeded.addEventListener("change", () => {
    el.invoiceFields.style.display = el.invoiceNeeded.value === "yes" ? "block" : "none";
  });

  // Invoice type toggle: personal hides tax ID field
  el.invoiceType.addEventListener("change", () => {
    const isPersonal = el.invoiceType.value === "personal";
    el.invoiceTaxNoCol.style.display = isPersonal ? "none" : "";
    el.invoiceTitleLabel.textContent = isPersonal ? "发票抬头（姓名）" : "发票抬头";
    el.invoiceTitle.placeholder = isPersonal ? "您的真实姓名" : "公司/单位全称";
    el.invoiceTypeHint.textContent = isPersonal ? "个人发票无需税号" : "增值税普通发票";
    if (isPersonal && !el.invoiceTitle.value.trim()) {
      el.invoiceTitle.value = el.payerName.value.trim();
    }
  });

  // Step navigation (step 1 & 2 only; step 3 buttons bound dynamically in buildStep3)
  el.btnToStep2.addEventListener("click", () => goToStep(2));
  el.btnBackTo1.addEventListener("click", () => goToStep(1));
  el.btnToStep3.addEventListener("click", createOrder);

  // My orders
  el.btnRefreshOrders.addEventListener("click", loadMyOrders);
  loadMyOrders();
}

init();
