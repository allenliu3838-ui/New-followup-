import { supabase } from "/lib/supabase-client.js?v=registry-20260914-integrated-v1";
import { qs, toast, fmtDate, escapeHtml } from "/lib/utils.js?v=registry-20260914-integrated-v1";
import { normalizedNumber, validateVisit, createRequestId, ckdepi2021 } from "/lib/patient-workflow.js?v=registry-20260914-integrated-v1";

// Patient page never needs Supabase auth session detection —
// disabling it prevents Supabase from misreading ?pt= as an auth token
// and redirecting to the site root.
const sb = supabase({ detectSessionInUrl: false, persistSession: false, autoRefreshToken: false });

const el = {
  form: qs("#visitForm"),
  fields: qs("#visitFields"),
  btnNext: qs("#btnNextVisit"),
  btnVerify: qs("#btnVerifyContext"),
  unitReview: qs("#unitReview"),
  ctxSub: qs("#ctxSub"),
  ctxBox: qs("#ctxBox"),
  visitDate: qs("#visitDate"),
  sbp: qs("#sbp"),
  dbp: qs("#dbp"),
  scr: qs("#scr"),
  scrUnit: qs("#scrUnit"),
  upcr: qs("#upcr"),
  upcrUnit: qs("#upcrUnit"),
  egfr: qs("#egfr"),
  notes: qs("#notes"),
  btnSubmit: qs("#btnSubmit"),
  btnRefresh: qs("#btnRefresh"),
  submitHint: qs("#submitHint"),
  qcBox: qs("#qcBox"),
  receiptBox: qs("#receiptBox"),
  visitsBox: qs("#visitsBox"),
  labsBox: qs("#labsBox"),
  medsBox: qs("#medsBox"),
  variantsBox: qs("#variantsBox"),
  eventsBox: qs("#eventsBox"),
};

let token = null;
let ctx = null;
let busy = false;
let completed = false;
let pendingSubmission = null;
let dirty = false;
let contextEpoch = 0;
let contextFailed = false;
let currentHash = window.location.hash;
const valueText = value => value === null || value === undefined || value === "" ? "未填写" : String(value);
const showValue = value => escapeHtml(valueText(value));

function getToken(){
  try {
    const h = window.location.hash;
    if (h && h.length > 1) return decodeURIComponent(h.slice(1));
    const m = (window.location.pathname || "").match(/\/p\/([^/]+)$/);
    if (m) return decodeURIComponent(m[1]);
    const q = new URLSearchParams(window.location.search);
    return q.get("pt") || q.get("token");
  } catch (_) { return null; }
}

function toInternalScrUmol(){
  return normalizedNumber(el.scr.value, el.scrUnit.value === "mgdl" ? 88.4 : 1);
}

function toInternalUpcrMgG(){
  return normalizedNumber(el.upcr.value, el.upcrUnit.value === "gg" ? 1000 : 1);
}

function updateControls(){
  const locked = !ctx || contextFailed || ctx.can_write === false || completed;
  el.fields.disabled = locked || busy || !!pendingSubmission;
  el.btnSubmit.disabled = locked || busy;
  el.btnSubmit.textContent = busy ? "正在确认提交结果…" : pendingSubmission ? "重试确认同一条随访" : "核对并提交随访";
  el.btnNext.hidden = !completed || ctx?.single_use === true;
  el.btnNext.disabled = busy;
  el.btnVerify.hidden = completed;
  el.btnVerify.disabled = busy || !!pendingSubmission;
  el.btnRefresh.disabled = busy || !ctx || contextFailed || completed && ctx.single_use;
}

function clearVisitFields(){
  for (const name of ["visitDate", "sbp", "dbp", "scr", "upcr", "egfr", "notes"]) el[name].value = "";
  el.scrUnit.value = "umol";
  el.upcrUnit.value = "mgg";
  dirty = false;
}

function detectPII(s){
  if (!s) return false;
  const v = String(s).trim();
  if (!v) return false;
  const rules = [
    /(?:^|\D)1[3-9][0-9]{9}(?:\D|$)/, // CN mobile
    /(?:^|\D)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9xX](?:\D|$)/, // CN ID
    /(MRN|病案号|住院号|门诊号|姓名|身份证|手机号|电话)/i,
    /\d{8,}/,
  ];
  return rules.some((r) => r.test(v));
}

function computeEgfr(){
  el.egfr.value = "";
  if (!ctx || !el.visitDate.value) return;
  const scr = toInternalScrUmol();
  const year = Number(ctx.birth_year);
  const age = year ? Number(el.visitDate.value.slice(0, 4)) - year : null;
  const value = ckdepi2021(scr === null ? NaN : scr / 88.4, age, ctx.sex);
  if (value !== null) el.egfr.value = value.toFixed(1);
}

function getQcState(){
  const values = Object.fromEntries(["visitDate", "sbp", "dbp", "scr", "scrUnit", "upcr", "upcrUnit", "notes"].map(name => [name, el[name].value]));
  const q = validateVisit(values);
  // The research code comes from the verified token context, not editable patient input.
  q.piiHit = detectPII(q.notes);
  if (q.piiHit) q.errors.push({field: "notes", message: "检测到疑似身份或联系方式，请仅保留研究记录。"});
  return q;
}

function renderQc(){
  const q = getQcState();
  let html = `<b>${completed ? "本次随访已提交，请保留回执" : q.errors.length ? "请完成并核对以下字段" : "必填信息已填写，请对照原始记录核对"}</b>`;
  if (!completed && q.errors.length) html += `<ul>${q.errors.map(error => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul>`;
  if (!completed && q.warnings.length) html += `<div class="qc-warning">需核对：${escapeHtml(q.warnings.join("；"))}</div>`;
  el.qcBox.innerHTML = html;
  el.unitReview.innerHTML = `<b>本次将保存的单位</b><div>血清肌酐：${showValue(q.scr_umol)} μmol/L</div><div>UPCR：${showValue(q.upcr_mgg)} mg/g</div><div class="small muted">原始数值与单位请逐项核对。填写完整不代表已完成研究数据审核。</div>`;
}

function renderReceipt(row, q){
  const summary = `${q.visitDate} · 血压 ${q.sbp}/${q.dbp} mmHg · 肌酐 ${q.scr_umol} μmol/L · UPCR ${q.upcr_mgg} mg/g`;
  // The receipt stays in this document. Never pass a receipt credential to a QR/image provider.
  const receiptText = `随访提交回执\n研究编号：${ctx.patient_code}\n记录编号：${row.visit_id}\n服务器时间：${row.server_time || ""}\n${summary}\n核验凭据：${row.receipt_token || "未提供"}\n核验有效期：${row.receipt_expires_at || "未提供"}`;
  el.receiptBox.style.display = "block";
  el.receiptBox.innerHTML = `<h3>本次随访已保存</h3><p>研究编号：<b>${escapeHtml(ctx.patient_code)}</b></p><p class="small">${escapeHtml(summary)}</p><p class="small">记录编号：<code>${escapeHtml(row.visit_id)}</code></p><p class="small">服务器时间：${escapeHtml(fmtDate(row.server_time))}</p><p class="small">${q.warnings.length ? `提交时需核对：${escapeHtml(q.warnings.join("；"))}` : "本页基础检查未提示异常；仍需按研究方案核查。"}</p><details><summary>查看 / 复制提交回执</summary><textarea id="receiptText" readonly aria-label="随访提交回执" rows="7"></textarea><button type="button" class="btn" id="btnCopyReceipt">复制回执</button><p class="small muted">回执包含核验凭据和本次研究记录，仅交给授权研究人员。请勿在公开群聊分享。</p></details>`;
  qs("#receiptText").value = receiptText;
  qs("#btnCopyReceipt").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(receiptText);
      toast("回执已复制，请仅交给授权研究人员。");
    } catch (_) {
      qs("#receiptText").focus(); qs("#receiptText").select();
      toast("已选中回执，请使用浏览器的复制功能。");
    }
  });
}

function friendlyError(error){
  const message = String(error?.message || error || "");
  const text = `${message} ${error?.details || ""}`;
  if (/token_invalid|token_expired|token_revoked|single_use_token_already_used|token_already_used/.test(text)) return "随访链接已使用、过期或被撤销，请联系研究人员确认记录或获取新链接。";
  if (/subscription_required|trial_expired|read_only|write_disabled/.test(text)) return "项目当前不能录入。请联系项目负责人确认授权状态，已填写内容仍保留。";
  if (/rate_limited|same_day_limit|frozen/.test(text)) return "链接当前已被限制提交，请联系研究人员核对已有记录。";
  if (/pii_detected_blocked/.test(text)) return "检测到疑似身份或联系方式，请检查研究编号与备注。";
  if (/future_visit_date/.test(text)) return "随访日期不能晚于今天，请核对后重新填写。";
  if (/visit_before_baseline/.test(text)) return "随访日期不能早于登记的基线日期，请核对后重新填写。";
  if (/missing_core_fields|missing_visit_date|invalid_visit|invalid_measurement|invalid_numeric_value|invalid_blood_pressure|notes_too_long/.test(text)) return "字段不完整或数值不符合要求，请核对日期、血压、肌酐与 UPCR。";
  if (/idempotency_conflict|receipt_not_available/.test(text)) return "本次提交的核验结果异常，请保留当前页面并联系研究人员核对，勿重新录入。";
  return "未能确认提交结果。请保留本页并重试确认同一条记录；不要另开页面重复录入。";
}

async function loadContext(){
  const epoch = contextEpoch;
  const requestToken = token;
  el.ctxSub.textContent = "正在验证随访链接…";
  contextFailed = true;
  updateControls();
  try {
    const {data, error} = await sb.rpc("patient_get_context", {p_token: requestToken});
    if (epoch !== contextEpoch) return false;
    if (error) throw error;
    const next = Array.isArray(data) ? data[0] : data;
    if (!next) throw new Error("token_invalid_or_expired");
    // can_write is authoritative; neither trial_expires_at nor client clocks decide billing access.
    if (typeof next.can_write !== "boolean") throw new Error("context_contract_unavailable");
    ctx = next;
    contextFailed = false;
    el.ctxSub.textContent = `${ctx.project_name} · 中心 ${ctx.center_code}`;
    const status = ctx.can_write ? "可填写随访，保存时由服务器再次核验" : friendlyError(ctx.write_block_reason || "write_disabled");
    el.ctxBox.innerHTML = `<div>研究项目</div><div><b>${escapeHtml(ctx.project_name)}</b></div><div>中心</div><div>${escapeHtml(ctx.center_code)}</div><div>研究编号</div><div><b>${escapeHtml(ctx.patient_code)}</b></div><div>填写状态</div><div>${escapeHtml(status)}</div><div>链接方式</div><div>${ctx.single_use ? "单次填写，提交成功后失效" : "可按研究安排多次填写"}</div>`;
    if (!completed) el.submitHint.textContent = ctx.can_write ? "请先核对研究编号，再填写本次访视。" : status;
    computeEgfr(); renderQc(); updateControls();
    return true;
  } catch (error) {
    if (epoch !== contextEpoch) return false;
    contextFailed = true;
    el.ctxSub.textContent = "暂时无法验证链接";
    el.ctxBox.innerHTML = `<p class="small">${escapeHtml(String(error?.message).includes("context_contract_unavailable") ? "系统接口尚未更新，请联系平台完成升级后使用。" : "链接可能已失效，或网络暂时不可用。请核对链接，并联系研究人员确认。")}</p>`;
    if (!completed) el.submitHint.textContent = "未通过链接验证，当前不能提交。";
    updateControls();
    return false;
  }
}

async function submitVisit(event){
  event?.preventDefault();
  if (busy || completed || !ctx || contextFailed || ctx.can_write === false) return;
  const epoch = contextEpoch;
  if (!pendingSubmission) {
    const q = getQcState();
    if (q.errors.length) {
      renderQc(); el[q.errors[0].field]?.focus(); toast(q.errors[0].message); return;
    }
    const summary = `项目：${ctx.project_name}\n研究编号：${ctx.patient_code}\n访视日期：${q.visitDate}\n血压：${q.sbp}/${q.dbp} mmHg\n肌酐：${el.scr.value} ${el.scrUnit.value === "mgdl" ? "mg/dL" : "μmol/L"} → ${q.scr_umol} μmol/L\nUPCR：${el.upcr.value} ${el.upcrUnit.value === "gg" ? "g/g" : "mg/g"} → ${q.upcr_mgg} mg/g`;
    if (!window.confirm(`${summary}${q.warnings.length ? `\n\n需核对：${q.warnings.join("；")}` : ""}\n\n确认以上研究编号、数值和单位后提交？`)) return;
    try {
      pendingSubmission = {q, payload: {p_token: token, p_visit_date: q.visitDate, p_sbp: q.sbp, p_dbp: q.dbp, p_scr_umol_l: q.scr_umol, p_upcr: q.upcr_mgg, p_egfr: normalizedNumber(el.egfr.value), p_notes: q.notes || null, p_request_id: createRequestId(window.crypto)}};
    } catch (error) { el.submitHint.textContent = error.message; return; }
  }
  busy = true; updateControls();
  try {
    const {data, error} = await sb.rpc("patient_submit_visit_v2", pendingSubmission.payload);
    if (epoch !== contextEpoch) return;
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.status !== "submitted" || !row.visit_id) {
      if (row?.status && row.status !== "submitted") {
        el.submitHint.textContent = friendlyError(row.status);
        pendingSubmission = null;
        ctx.can_write = false;
        toast(el.submitHint.textContent);
        return;
      }
      throw new Error("submission_receipt_unavailable");
    }
    renderReceipt(row, pendingSubmission.q);
    pendingSubmission = null;
    completed = true;
    clearVisitFields();
    el.submitHint.textContent = ctx.single_use ? "单次随访已完成，本链接不能再次填写。请保留回执；如需补充，请联系研究人员。" : "本次随访已保存。填写另一次访视时，请点击“录入下一次随访”，使用全新空白表单。";
    renderQc();
    toast("本次随访已保存，请保留回执。");
    // A consumed single-use token must not request protected history again.
    if (ctx.single_use) clearHistory("单次链接已完成。本次保存结果请查看上方回执；历史记录请向研究人员核对。");
    else await loadVisits();
  } catch (error) {
    if (epoch !== contextEpoch) return;
    const message = String(error?.message || "");
    el.submitHint.textContent = friendlyError(error);
    if (/token_invalid|token_expired|token_revoked|token_already_used|single_use_token_already_used|subscription_required|trial_expired|rate_limited|same_day_limit|frozen/.test(message)) {
      pendingSubmission = null; ctx.can_write = false;
    } else if (/idempotency_conflict|receipt_not_available/.test(message)) {
      ctx.can_write = false;
    } else if (/pii_detected_blocked|missing_core_fields|missing_visit_date|future_visit_date|visit_before_baseline|invalid_visit|invalid_measurement|invalid_numeric_value|invalid_blood_pressure|notes_too_long|invalid_input|request_payload_mismatch/.test(message)) {
      pendingSubmission = null;
    }
    // Unknown/network errors retain the exact payload + UUID. Retrying cannot create a second row.
    toast(el.submitHint.textContent);
  } finally {
    if (epoch === contextEpoch) {busy = false; updateControls();}
  }
}

async function nextVisit(){
  if (!completed || busy || ctx?.single_use) return;
  busy = true; updateControls();
  const valid = await loadContext();
  busy = false;
  if (valid && ctx.can_write) {
    completed = false; clearVisitFields();
    el.receiptBox.style.display = "none"; el.receiptBox.innerHTML = "";
    el.submitHint.textContent = "这是下一次访视的空白表单，请重新填写日期、数值和单位。";
    renderQc(); el.visitDate.focus();
  } else el.submitHint.textContent = "暂时不能开始下一次填写。请保留上次回执并联系研究人员。";
  updateControls();
}

function clearHistory(message){
  for (const name of ["visitsBox", "labsBox", "medsBox", "variantsBox", "eventsBox"]) if (el[name]) el[name].textContent = message;
}

async function historyRows(name, rpc, limit){
  const epoch = contextEpoch;
  el[name].textContent = "正在读取…";
  try {
    const {data, error} = await sb.rpc(rpc, {p_token: token, p_limit: limit});
    if (epoch !== contextEpoch) return null;
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("invalid_history_response");
    return data;
  } catch (_) {
    if (epoch === contextEpoch) el[name].textContent = "读取失败，不能据此判断没有记录。请刷新历史；若链接已使用、过期或被撤销，请联系研究人员。";
    return null;
  }
}

async function loadVisits(){
  const rows = await historyRows("visitsBox", "patient_list_visits", 30);
  if (rows === null) return;
  if (!rows.length){
    el.visitsBox.innerHTML = "<div class='muted small'>暂无随访记录</div>";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.visit_date||"")}</td>
      <td>${showValue(r.sbp)}/${showValue(r.dbp)}</td>
      <td>${showValue(r.scr_umol_l)}</td>
      <td>${showValue(r.upcr)}</td>
      <td>${showValue(r.egfr)}</td>
      <td class="muted small">${escapeHtml((r.notes||"").slice(0,60))}</td>
    </tr>
  `).join("");
  el.visitsBox.innerHTML = `
    <div class="patient-table-wrap"><table class="table">
      <thead><tr><th>日期</th><th>血压（mmHg）</th><th>肌酐（μmol/L）</th><th>UPCR（mg/g）</th><th>eGFR（mL/min/1.73m²）</th><th>备注</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;
}

async function loadLabs(){
  if (!el.labsBox) return;
  const rows = await historyRows("labsBox", "patient_list_labs", 20);
  if (rows === null) return;
  if (!rows.length){
    el.labsBox.innerHTML = "<div class='muted small'>暂无化验记录</div>";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.lab_date||"")}</td>
      <td>${escapeHtml(r.lab_name||"")}</td>
      <td>${escapeHtml(r.lab_value!=null?String(r.lab_value):"")}</td>
      <td>${escapeHtml(r.lab_unit||"")}</td>
    </tr>
  `).join("");
  el.labsBox.innerHTML = `
    <div class="patient-table-wrap"><table class="table">
      <thead><tr><th>日期</th><th>项目</th><th>记录数值</th><th>记录单位</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;
}

async function loadMeds(){
  if (!el.medsBox) return;
  const rows = await historyRows("medsBox", "patient_list_meds", 20);
  if (rows === null) return;
  if (!rows.length){
    el.medsBox.innerHTML = "<div class='muted small'>暂无用药记录</div>";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.drug_name||"")}</td>
      <td>${escapeHtml(r.drug_class||"")}</td>
      <td>${escapeHtml(r.dose||"")}</td>
      <td>${escapeHtml(r.start_date||"")}</td>
      <td>${escapeHtml(r.end_date||"")}</td>
    </tr>
  `).join("");
  el.medsBox.innerHTML = `
    <div class="patient-table-wrap"><table class="table">
      <thead><tr><th>药品</th><th>类别</th><th>剂量</th><th>开始</th><th>结束</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;
}

async function loadVariants(){
  if (!el.variantsBox) return;
  const rows = await historyRows("variantsBox", "patient_list_variants", 20);
  if (rows === null) return;
  if (!rows.length){
    el.variantsBox.innerHTML = "<div class='muted small'>暂无基因变异记录</div>";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.test_date||"")}</td>
      <td>${escapeHtml(r.test_name||"")}</td>
      <td>${escapeHtml(r.gene||"")}</td>
      <td>${escapeHtml(r.variant||"")}</td>
      <td>${escapeHtml(r.classification||"")}</td>
      <td>${escapeHtml(r.zygosity||"")}</td>
    </tr>
  `).join("");
  el.variantsBox.innerHTML = `
    <div class="patient-table-wrap"><table class="table">
      <thead><tr><th>日期</th><th>检测</th><th>基因</th><th>变异</th><th>分类</th><th>合子性</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;
}

async function loadEvents(){
  if (!el.eventsBox) return;
  const rows = await historyRows("eventsBox", "patient_list_events", 20);
  if (rows === null) return;
  if (!rows.length){
    el.eventsBox.innerHTML = "<div class='muted small'>暂无终点事件</div>";
    return;
  }
  const typeMap = {
    egfr_decline_40pct: "eGFR 下降 ≥40%",
    egfr_decline_57pct: "eGFR 下降 ≥57%",
    esrd: "ESRD / 透析",
    death: "死亡",
    complete_remission: "完全缓解",
    partial_remission: "部分缓解",
    custom: "自定义"
  };
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(typeMap[r.event_type] || r.event_type || "")}</td>
      <td>${escapeHtml(r.event_date||"")}</td>
      <td>${escapeHtml(r.source==="computed"?"系统计算（需研究人员复核）":"研究人员录入")}</td>
      <td class="muted small">${escapeHtml((r.notes||"").slice(0,60))}</td>
    </tr>
  `).join("");
  el.eventsBox.innerHTML = `
    <div class="patient-table-wrap"><table class="table">
      <thead><tr><th>事件类型</th><th>日期</th><th>来源</th><th>备注</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  `;
}

async function refreshHistory(){
  if (busy || !ctx || contextFailed || completed && ctx.single_use) return;
  el.btnRefresh.disabled = true;
  await Promise.all([loadVisits(), loadLabs(), loadMeds(), loadVariants(), loadEvents()]);
  updateControls();
}

function bind(){
  el.form.addEventListener("submit", submitVisit);
  el.btnNext.addEventListener("click", nextVisit);
  el.btnVerify.addEventListener("click", async () => {
    if (busy || pendingSubmission || completed || !token) return;
    busy = true; updateControls();
    const valid = await loadContext();
    busy = false; updateControls();
    if (valid) await refreshHistory();
  });
  el.btnRefresh.addEventListener("click", refreshHistory);
  for (const node of [el.scr, el.scrUnit, el.upcr, el.upcrUnit, el.sbp, el.dbp, el.visitDate, el.notes]) {
    const changed = () => {dirty = true; computeEgfr(); renderQc();};
    node.addEventListener("input", changed); node.addEventListener("change", changed);
  }
  window.addEventListener("beforeunload", event => {
    if (dirty || pendingSubmission || busy) {event.preventDefault(); event.returnValue = "";}
  });
  window.addEventListener("hashchange", () => {
    if (busy || pendingSubmission || dirty && !window.confirm("当前资料尚未提交，确定放弃并打开另一个随访链接吗？")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + currentHash);
      return;
    }
    currentHash = window.location.hash;
    main();
  });
}

async function main(){
  ++contextEpoch;
  token = getToken(); ctx = null; completed = false; pendingSubmission = null; busy = false; contextFailed = false;
  clearVisitFields(); el.receiptBox.innerHTML = ""; el.receiptBox.style.display = "none";
  clearHistory("完成链接验证后读取记录。"); renderQc(); updateControls();
  if (!token) {
    el.ctxSub.textContent = "缺少或无法识别随访链接";
    el.ctxBox.textContent = "请使用研究人员提供的完整随访链接打开本页。";
    return;
  }
  if (await loadContext()) await refreshHistory();
}

bind();
main();
