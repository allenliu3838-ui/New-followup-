import { supabase } from "/lib/supabase-client.js";
import { qs, qsa, toast, fmtDate, escapeHtml } from "/lib/utils.js";

const sb = supabase();
const B = () => window.CONFIG?.BILLING || {};

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
  invoiceNeeded: qs("#invoiceNeeded"),
  invoiceFields: qs("#invoiceFields"),
  invoiceTitle:  qs("#invoiceTitle"),
  invoiceTaxNo:  qs("#invoiceTaxNo"),
  invoiceEmail:  qs("#invoiceEmail"),
  orderNotes:    qs("#orderNotes"),
  btnBackTo1:    qs("#btnBackTo1"),
  btnToStep3:    qs("#btnToStep3"),
  // Step 3
  orderNoDisplay: qs("#orderNoDisplay"),
  amountDisplay:  qs("#amountDisplay"),
  copyOrderNo:    qs("#copyOrderNo"),
  copyAmount:     qs("#copyAmount"),
  proofFile:      qs("#proofFile"),
  uploadZone:     qs("#uploadZone"),
  uploadPreview:  qs("#uploadPreview"),
  uploadFileName: qs("#uploadFileName"),
  btnRemoveFile:  qs("#btnRemoveFile"),
  proofAmount:    qs("#proofAmount"),
  proofPayerInfo: qs("#proofPayerInfo"),
  btnBackTo2:     qs("#btnBackTo2"),
  btnSubmitProof: qs("#btnSubmitProof"),
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

// ── Payment Method Tabs ──────────────────────────────────
function setupPayTabs() {
  qsa(".pay-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const method = tab.dataset.method;
      selectedMethod = method;
      qsa(".pay-tab").forEach(t => t.classList.toggle("active", t === tab));
      qsa(".pay-panel").forEach(p => p.classList.toggle("active", p.id === `panel_${method}`));
    });
  });
}

// ── Pre-fill static payment info from config (QR, bank) ──
function prefillPaymentConfig() {
  const b = B();
  // QR images
  const wImg = qs("#wechatQrImg"); if (wImg) wImg.src = b.WECHAT_QR_IMG || "";
  const aImg = qs("#alipayQrImg"); if (aImg) aImg.src = b.ALIPAY_QR_IMG || "";
  const wl = qs("#wechatLabel");   if (wl) wl.textContent = b.WECHAT_LABEL || "";
  const al = qs("#alipayLabel");   if (al) al.textContent = b.ALIPAY_LABEL || "";
  // Bank info
  const bn = qs("#bankName");      if (bn) bn.textContent = b.BANK_NAME || "";
  const bb = qs("#bankBranch");    if (bb) bb.textContent = b.BANK_BRANCH || "";
  const ba = qs("#bankAccount");   if (ba) ba.textContent = b.BANK_ACCOUNT || "";
  // Bank account copy (always available)
  const cba = qs("#copyBankAccount"); if (cba) cba.onclick = () => copyText(b.BANK_ACCOUNT || "", "银行账号");
}

// ── Fill order-specific payment info ─────────────────────
function fillPaymentInfo(orderNo, amount) {
  const b = B();
  const memo = orderNo;

  // Re-fill config (in case)
  prefillPaymentConfig();

  // Order-specific memos
  [qs("#wechatMemo"), qs("#alipayMemo")].forEach(m => { if (m) m.textContent = memo; });
  const bankMemo = qs("#bankMemo"); if (bankMemo) bankMemo.textContent = `KS${orderNo}`;

  // Amount
  const bamt = qs("#bankAmount");  if (bamt) bamt.textContent = `¥${amount}`;

  // Display
  el.orderNoDisplay.textContent = orderNo;
  el.amountDisplay.textContent = `¥${amount}`;

  // Copy buttons
  el.copyOrderNo.onclick = () => copyText(orderNo, "订单号");
  el.copyAmount.onclick = () => copyText(String(amount), "金额");
  const cwm = qs("#copyWechatMemo");  if (cwm) cwm.onclick = () => copyText(memo, "备注");
  const cam = qs("#copyAlipayMemo");  if (cam) cam.onclick = () => copyText(memo, "备注");
  const cbm = qs("#copyBankMemo");    if (cbm) cbm.onclick = () => copyText(`KS${orderNo}`, "转账备注");
}

// ── Create Order ─────────────────────────────────────────
async function createOrder() {
  const b = B();
  const count = Math.max(3, parseInt(el.projectCount.value) || 3);
  const extra = count - (b.PRO_BASE_PROJECTS || 3);

  // 发票必填校验
  if (el.invoiceNeeded.value === "yes") {
    if (!el.invoiceTitle?.value.trim()) { toast("请填写发票抬头"); return; }
    if (!el.invoiceTaxNo?.value.trim()) { toast("请填写税号"); return; }
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
      p_invoice_title:  el.invoiceTitle?.value.trim() || null,
      p_invoice_tax_no: el.invoiceTaxNo?.value.trim() || null,
      p_invoice_email:  el.invoiceEmail?.value.trim() || null,
      p_notes:          el.orderNotes.value.trim() || null,
    });

    if (error) throw error;

    currentOrder = data;
    fillPaymentInfo(data.order_no, data.amount_due);
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
function setupUpload() {
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
  if (!currentOrder) { toast("请先完成下单"); return; }
  const file = el.proofFile.files[0];
  if (!file) { toast("请先选择凭证文件"); return; }

  el.btnSubmitProof.disabled = true;
  el.btnSubmitProof.textContent = "上传中…";

  try {
    // Upload to Supabase Storage
    const ext = file.name.split(".").pop();
    const path = `proofs/${currentOrder.order_id}/${Date.now()}.${ext}`;
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
      return `<div class="order-status-card">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <span class="${s.cls}" style="font-size:11px">${s.text}</span>
          <code style="font-size:12px">${escapeHtml(o.order_no)}</code>
          <span class="muted small" style="margin-left:auto">${fmtDate(o.created_at)}</span>
        </div>
        <div class="small">
          ${planMap[o.plan_code] || o.plan_code} · ${cycleMap[o.billing_cycle] || o.billing_cycle}
          · ${o.project_quota} 个项目
          · ¥${o.amount_due}
          ${o.payment_method ? ` · ${methodMap[o.payment_method] || o.payment_method}` : ""}
        </div>
        ${o.status === "activated" && o.end_at ? `<div class="small" style="margin-top:4px;color:var(--ok)">权益有效至 ${fmtDate(o.end_at)}</div>` : ""}
        ${o.status === "rejected" ? `<div class="small" style="margin-top:4px;color:var(--bad)">驳回原因：${escapeHtml(o.reject_reason || "—")}</div>` : ""}
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

  // Step navigation
  el.btnToStep2.addEventListener("click", () => goToStep(2));
  el.btnBackTo1.addEventListener("click", () => goToStep(1));
  el.btnToStep3.addEventListener("click", createOrder);
  el.btnBackTo2.addEventListener("click", () => goToStep(2));
  el.btnSubmitProof.addEventListener("click", submitProof);

  // Payment tabs & static payment info
  setupPayTabs();
  prefillPaymentConfig();

  // Upload
  setupUpload();

  // My orders
  el.btnRefreshOrders.addEventListener("click", loadMyOrders);
  loadMyOrders();
}

init();
