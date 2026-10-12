import { supabase } from "/lib/supabase-client.js?v=registry-20260914-integrated-v1";
import { qs, toast, escapeHtml } from "/lib/utils.js?v=registry-20260914-integrated-v1";
import {
  normalizedNumber, validateVisit, createRequestId, ckdepi2021,
  studyInfo, classifyPatientError, contextErrorMessage, submissionOutcome,
  localDateString, formatLocalDateTime, formatLocalDate,
} from "/lib/patient-workflow.js?v=registry-20261012-adoption-v4";

// The participant page never needs Supabase auth session detection —
// disabling it prevents the client from misreading ?pt= as an auth token
// and redirecting to the site root.
const sb = supabase({ detectSessionInUrl: false, persistSession: false, autoRefreshToken: false });

const el = {
  studyTitle: qs("#studyTitle"),
  studyInfo: qs("#studyInfo"),
  linkStatus: qs("#linkStatus"),
  btnVerify: qs("#btnVerifyContext"),
  formSection: qs("#formSection"),
  historySection: qs("#historySection"),
  form: qs("#visitForm"),
  fields: qs("#visitFields"),
  unitReview: qs("#unitReview"),
  visitDate: qs("#visitDate"),
  sbp: qs("#sbp"),
  dbp: qs("#dbp"),
  scr: qs("#scr"),
  scrUnit: qs("#scrUnit"),
  upcr: qs("#upcr"),
  upcrUnit: qs("#upcrUnit"),
  egfr: qs("#egfr"),
  notes: qs("#notes"),
  reviewBox: qs("#reviewBox"),
  reviewList: qs("#reviewList"),
  reviewWarnings: qs("#reviewWarnings"),
  qcBox: qs("#qcBox"),
  btnSubmit: qs("#btnSubmit"),
  btnBack: qs("#btnBack"),
  submitHint: qs("#submitHint"),
  doneBox: qs("#doneBox"),
  doneList: qs("#doneList"),
  doneNote: qs("#doneNote"),
  btnNext: qs("#btnNextVisit"),
  receiptText: qs("#receiptText"),
  btnCopyReceipt: qs("#btnCopyReceipt"),
  visitsBox: qs("#visitsBox"),
  btnRefresh: qs("#btnRefresh"),
  moreRecords: qs("#moreRecords"),
  labsBox: qs("#labsBox"),
  medsBox: qs("#medsBox"),
  variantsBox: qs("#variantsBox"),
  eventsBox: qs("#eventsBox"),
};

const FIELD_NAMES = ["visitDate", "sbp", "dbp", "scr", "scrUnit", "upcr", "upcrUnit", "notes"];
const HISTORY_BOXES = ["visitsBox", "labsBox", "medsBox", "variantsBox", "eventsBox"];

let token = null;
let ctx = null;
let busy = false;
let completed = false;
let reviewing = null;          // validated values awaiting the participant's confirmation
let pendingSubmission = null;  // exact payload + request UUID kept for safe retries
let dirty = false;
let showErrors = false;
let contextEpoch = 0;
let contextFailed = false;
let verifyRetryable = false;
let linkUnusable = false;      // link could not be verified: hide form and history
let readOnlyAtLoad = false;    // project not accepting entries when the page opened
let extraLoaded = false;
let currentHash = window.location.hash;

const display = value => value === null || value === undefined || value === "" ? "未填写" : String(value);
const cell = value => escapeHtml(display(value));
const roundForDisplay = value => Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "未填写";

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

function canWrite(){
  return !!ctx && !contextFailed && ctx.can_write === true;
}

function contactSuffix(){
  const contact = ctx ? studyInfo(ctx).contact : null;
  return contact ? `（研究团队联系方式：${contact}）` : "";
}

function setHint(text){
  el.submitHint.textContent = text || "";
}

function updateControls(){
  const locked = !canWrite();
  el.formSection.hidden = !completed && (linkUnusable || readOnlyAtLoad);
  el.historySection.hidden = linkUnusable;
  el.form.hidden = completed;
  el.doneBox.hidden = !completed;
  el.fields.disabled = locked || busy || !!pendingSubmission || !!reviewing;
  el.btnSubmit.disabled = locked || busy;
  el.btnSubmit.textContent = busy ? "正在提交…" : pendingSubmission ? "重试提交" : reviewing ? "确认提交" : "核对并提交";
  el.btnSubmit.setAttribute("aria-busy", busy ? "true" : "false");
  el.btnBack.hidden = !reviewing || !!pendingSubmission;
  el.btnBack.disabled = busy;
  el.reviewBox.hidden = !reviewing || completed;
  el.btnNext.hidden = !completed || ctx?.single_use === true;
  el.btnNext.disabled = busy;
  el.btnVerify.hidden = !(contextFailed && verifyRetryable);
  el.btnVerify.disabled = busy;
  el.btnRefresh.disabled = busy || !ctx || contextFailed || (completed && ctx.single_use === true);
}

function clearVisitFields(){
  for (const name of ["visitDate", "sbp", "dbp", "scr", "upcr", "egfr", "notes"]) el[name].value = "";
  el.scrUnit.value = "umol";
  el.upcrUnit.value = "mgg";
  dirty = false;
  showErrors = false;
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
  const scr = normalizedNumber(el.scr.value, el.scrUnit.value === "mgdl" ? 88.4 : 1);
  const year = Number(ctx.birth_year);
  const age = year ? Number(el.visitDate.value.slice(0, 4)) - year : null;
  const value = ckdepi2021(scr === null ? NaN : scr / 88.4, age, ctx.sex);
  if (value !== null) el.egfr.value = value.toFixed(1);
}

function getQcState(){
  const values = Object.fromEntries(FIELD_NAMES.map(name => [name, el[name].value]));
  const q = validateVisit(values);
  if (q.visitDate && q.visitDate > localDateString()) q.errors.push({field: "visitDate", message: "随访日期不能晚于今天。"});
  // The research code comes from the verified link, never from editable input.
  if (detectPII(q.notes)) q.errors.push({field: "notes", message: "备注中似乎有姓名、电话、病案号或身份证号等信息，请删除。"});
  return q;
}

function renderQc(){
  if (completed) { el.qcBox.innerHTML = ""; el.unitReview.innerHTML = ""; return; }
  const q = getQcState();
  const visible = showErrors ? q.errors : q.errors.filter(error => error.field === "notes");
  let html = "";
  if (visible.length) html += `<b>请补充或核对：</b><ul>${visible.map(error => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul>`;
  if (q.warnings.length) html += `<div class="qc-warning">请核对：${escapeHtml(q.warnings.join("；"))}</div>`;
  el.qcBox.innerHTML = html;
  el.unitReview.innerHTML = el.scr.value || el.upcr.value
    ? `<b>换算后将保存为</b><div>血清肌酐：${escapeHtml(roundForDisplay(q.scr_umol))} μmol/L</div><div>UPCR：${escapeHtml(roundForDisplay(q.upcr_mgg))} mg/g</div>`
    : "";
}

function renderReview(q){
  const scrUnit = el.scrUnit.value === "mgdl" ? "mg/dL" : "μmol/L";
  const upcrUnit = el.upcrUnit.value === "gg" ? "g/g" : "mg/g";
  const scrText = scrUnit === "μmol/L" ? `${el.scr.value} μmol/L` : `${el.scr.value} ${scrUnit}（换算为 ${roundForDisplay(q.scr_umol)} μmol/L）`;
  const upcrText = upcrUnit === "mg/g" ? `${el.upcr.value} mg/g` : `${el.upcr.value} ${upcrUnit}（换算为 ${roundForDisplay(q.upcr_mgg)} mg/g）`;
  const rows = [
    ["研究编号", ctx.patient_code],
    ["随访日期", q.visitDate],
    ["血压", `${q.sbp}/${q.dbp} mmHg`],
    ["血清肌酐", scrText],
    ["UPCR", upcrText],
    ["备注", q.notes || "无"],
  ];
  el.reviewList.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  el.reviewWarnings.textContent = q.warnings.length ? `请特别核对：${q.warnings.join("；")}` : "";
}

function renderStudy(){
  const info = studyInfo(ctx);
  document.title = `${info.title}｜随访填报`;
  el.studyTitle.textContent = info.title;
  const rows = [];
  if (info.institution) rows.push(["研究机构", info.institution]);
  if (info.ethics) rows.push(["伦理批件号", info.ethics]);
  rows.push(["研究团队联系方式", info.contact || "请联系邀请您参加本研究的医生或研究护士"]);
  rows.push(["研究编号", ctx.patient_code]);
  if (ctx.center_code) rows.push(["中心编号", ctx.center_code]);
  const expires = formatLocalDate(ctx.token_expires_at);
  rows.push(["随访链接", `${ctx.single_use ? "只能提交一次" : "可按研究安排多次填写"}${expires ? `，有效期至 ${expires}` : ""}`]);
  el.studyInfo.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  readOnlyAtLoad = ctx.can_write !== true;
  el.linkStatus.className = ctx.can_write ? "link-status" : "link-status warnbox";
  // Never show billing/trial/read-only reasons to participants.
  el.linkStatus.textContent = ctx.can_write ? "" : `本研究暂时不接受在线填报，请联系研究团队。${contactSuffix()}`;
}

function showContextError(error){
  const problem = contextErrorMessage(error);
  linkUnusable = true;
  verifyRetryable = problem.kind === "network" || problem.kind === "unknown" || problem.kind === "unavailable";
  document.title = "随访链接无法使用";
  el.studyTitle.textContent = "无法打开这个随访链接";
  el.studyInfo.innerHTML = "";
  el.linkStatus.className = "link-status warnbox";
  el.linkStatus.textContent = problem.message;
}

async function loadContext(){
  const epoch = contextEpoch;
  const requestToken = token;
  contextFailed = true;
  verifyRetryable = false;
  updateControls();
  try {
    const {data, error} = await sb.rpc("patient_get_context", {p_token: requestToken});
    if (epoch !== contextEpoch) return false;
    if (error) throw error;
    const next = Array.isArray(data) ? data[0] : data;
    if (!next) throw new Error("token_invalid_or_expired");
    // can_write is authoritative; client clocks and billing fields never decide access.
    if (typeof next.can_write !== "boolean") throw new Error("context_contract_unavailable");
    ctx = next;
    contextFailed = false;
    linkUnusable = false;
    renderStudy();
    computeEgfr(); renderQc(); updateControls();
    return true;
  } catch (error) {
    if (epoch !== contextEpoch) return false;
    contextFailed = true;
    ctx = null;
    showContextError(error);
    setHint("");
    updateControls();
    return false;
  }
}

function buildReceipt(row, q){
  const lines = [
    "随访提交回执",
    `研究：${studyInfo(ctx).title}`,
    `研究编号：${ctx.patient_code}`,
    `随访日期：${q.visitDate}`,
    `血压：${q.sbp}/${q.dbp} mmHg`,
    `血清肌酐：${roundForDisplay(q.scr_umol)} μmol/L`,
    `UPCR：${roundForDisplay(q.upcr_mgg)} mg/g`,
    `提交时间：${formatLocalDateTime(row.server_time) || formatLocalDateTime(new Date())}`,
    `记录编号：${row.visit_id}`,
  ];
  if (row.receipt_token) lines.push(`核对码：${row.receipt_token}`);
  if (row.receipt_expires_at) lines.push(`核对码有效期至：${formatLocalDateTime(row.receipt_expires_at)}`);
  return lines.join("\n");
}

function renderDone(row, q, outcome){
  const submittedAt = formatLocalDateTime(row.server_time) || formatLocalDateTime(new Date());
  const rows = [
    ["研究编号", ctx.patient_code],
    ["随访日期", q.visitDate],
    ["提交时间", submittedAt],
    ["本次数值", `血压 ${q.sbp}/${q.dbp} mmHg；肌酐 ${roundForDisplay(q.scr_umol)} μmol/L；UPCR ${roundForDisplay(q.upcr_mgg)} mg/g`],
  ];
  el.doneList.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  const lead = outcome.replay ? "这次填写此前已经保存成功，没有重复保存。" : "研究团队已收到本次随访。";
  el.doneNote.textContent = ctx.single_use
    ? `${lead}这个随访链接只能提交一次，现已完成；下次随访时研究团队会发给您新的链接。发现填错请联系研究团队更正。${contactSuffix()}`
    : `${lead}如还有另一次随访（例如另一天的化验结果）需要填写，请点击“再填一次”。发现填错请联系研究团队更正。${contactSuffix()}`;
  el.receiptText.value = buildReceipt(row, q);
}

function handleFailure(outcome){
  const message = `${outcome.message}${outcome.kind === "network" || outcome.kind === "unknown" ? "" : contactSuffix()}`;
  switch (outcome.kind) {
    case "token":
    case "blocked":
    case "limit":
      pendingSubmission = null; reviewing = null;
      if (ctx) ctx.can_write = false;
      setHint(message);
      break;
    case "conflict":
      // Keep the page as evidence; never let the participant re-enter the same visit.
      if (ctx) ctx.can_write = false;
      setHint(message);
      break;
    case "duplicate":
    case "input":
      pendingSubmission = null; reviewing = null;
      setHint(message);
      break;
    default:
      // Network or unknown result: keep the exact payload and request UUID.
      // A retry is answered with the existing receipt, never a second record.
      setHint(`${message}请点击“重试提交”，系统不会重复保存同一次填写。`);
  }
  toast(outcome.message);
}

async function sendSubmission(){
  const epoch = contextEpoch;
  busy = true; updateControls();
  setHint("正在提交，请稍候，不要关闭本页…");
  try {
    const {data, error} = await sb.rpc("patient_submit_visit_v2", pendingSubmission.payload);
    if (epoch !== contextEpoch) return;
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const outcome = submissionOutcome(row);
    if (outcome.kind !== "submitted") { handleFailure(outcome); return; }
    const q = pendingSubmission.q;
    pendingSubmission = null; reviewing = null; completed = true;
    renderDone(row, q, outcome);
    clearVisitFields();
    setHint("");
    renderQc();
    toast("已提交。");
    // A consumed single-use link must not request protected history again.
    if (ctx.single_use) clearHistory("这个单次随访链接已完成。历史记录请向研究团队核对。");
    else { extraLoaded = false; loadVisits(); if (el.moreRecords.open) loadExtras(); }
  } catch (error) {
    if (epoch !== contextEpoch) return;
    handleFailure(classifyPatientError(error));
  } finally {
    if (epoch === contextEpoch) {
      busy = false; updateControls();
      if (completed) el.doneBox.scrollIntoView?.({block: "start", behavior: "smooth"});
    }
  }
}

async function onSubmit(event){
  event?.preventDefault();
  if (busy || completed || !canWrite()) return;
  if (pendingSubmission) return sendSubmission();
  if (!reviewing) {
    showErrors = true;
    const q = getQcState();
    renderQc();
    if (q.errors.length) {
      el[q.errors[0].field]?.focus();
      setHint(q.errors[0].message);
      return;
    }
    reviewing = q;
    renderReview(q);
    setHint("");
    updateControls();
    el.reviewBox.scrollIntoView?.({block: "nearest"});
    el.btnSubmit.focus();
    return;
  }
  try {
    const q = reviewing;
    pendingSubmission = {q, payload: {
      p_token: token, p_visit_date: q.visitDate, p_sbp: q.sbp, p_dbp: q.dbp,
      p_scr_umol_l: q.scr_umol, p_upcr: q.upcr_mgg, p_egfr: normalizedNumber(el.egfr.value),
      p_notes: q.notes || null, p_request_id: createRequestId(window.crypto),
    }};
  } catch (error) {
    setHint("当前浏览器版本过旧，不能安全提交。请换用手机自带浏览器或微信的最新版本后再打开链接。");
    return;
  }
  return sendSubmission();
}

function backToEdit(){
  if (busy || pendingSubmission) return;
  reviewing = null;
  setHint("");
  updateControls();
  el.sbp.focus();
}

async function nextVisit(){
  if (!completed || busy || ctx?.single_use) return;
  busy = true; updateControls();
  const valid = await loadContext();
  busy = false;
  if (valid && ctx.can_write) {
    completed = false; reviewing = null; clearVisitFields();
    el.doneList.innerHTML = ""; el.receiptText.value = "";
    setHint("请填写另一次随访：重新填写日期和各项数值。");
    renderQc(); updateControls(); el.visitDate.focus();
    return;
  }
  if (valid) setHint(`现在不能再次填写。${el.linkStatus.textContent}`);
  updateControls();
}

function clearHistory(message){
  for (const name of HISTORY_BOXES) el[name].textContent = message;
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
    if (epoch === contextEpoch) el[name].textContent = "暂时没能读取，这不代表没有记录。请点击“刷新记录”重试；仍不行请联系研究团队。";
    return null;
  }
}

function table(headers, rows){
  return `<div class="patient-table-wrap"><table class="table"><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

async function loadVisits(){
  const rows = await historyRows("visitsBox", "patient_list_visits", 30);
  if (rows === null) return;
  if (!rows.length) { el.visitsBox.innerHTML = "<div class='muted small'>还没有随访记录</div>"; return; }
  el.visitsBox.innerHTML = table(["日期", "血压（mmHg）", "肌酐（μmol/L）", "UPCR（mg/g）", "eGFR", "备注"], rows.map(r => `<tr>
      <td>${escapeHtml(r.visit_date || "")}</td>
      <td>${cell(r.sbp)}/${cell(r.dbp)}</td>
      <td>${cell(r.scr_umol_l)}</td>
      <td>${cell(r.upcr)}</td>
      <td>${cell(r.egfr)}</td>
      <td class="muted small">${escapeHtml((r.notes || "").slice(0, 60))}</td>
    </tr>`));
}

async function loadLabs(){
  const rows = await historyRows("labsBox", "patient_list_labs", 20);
  if (rows === null) return;
  if (!rows.length) { el.labsBox.innerHTML = "<div class='muted small'>暂无化验记录</div>"; return; }
  el.labsBox.innerHTML = table(["日期", "项目", "数值", "单位"], rows.map(r => `<tr>
      <td>${escapeHtml(r.lab_date || "")}</td>
      <td>${escapeHtml(r.lab_name || "")}</td>
      <td>${escapeHtml(r.lab_value != null ? String(r.lab_value) : "")}</td>
      <td>${escapeHtml(r.lab_unit || "")}</td>
    </tr>`));
}

async function loadMeds(){
  const rows = await historyRows("medsBox", "patient_list_meds", 20);
  if (rows === null) return;
  if (!rows.length) { el.medsBox.innerHTML = "<div class='muted small'>暂无用药记录</div>"; return; }
  el.medsBox.innerHTML = table(["药品", "类别", "剂量", "开始", "结束"], rows.map(r => `<tr>
      <td>${escapeHtml(r.drug_name || "")}</td>
      <td>${escapeHtml(r.drug_class || "")}</td>
      <td>${escapeHtml(r.dose || "")}</td>
      <td>${escapeHtml(r.start_date || "")}</td>
      <td>${escapeHtml(r.end_date || "")}</td>
    </tr>`));
}

async function loadVariants(){
  const rows = await historyRows("variantsBox", "patient_list_variants", 20);
  if (rows === null) return;
  if (!rows.length) { el.variantsBox.innerHTML = "<div class='muted small'>暂无基因检测记录</div>"; return; }
  el.variantsBox.innerHTML = table(["日期", "检测", "基因", "变异", "分类", "合子性"], rows.map(r => `<tr>
      <td>${escapeHtml(r.test_date || "")}</td>
      <td>${escapeHtml(r.test_name || "")}</td>
      <td>${escapeHtml(r.gene || "")}</td>
      <td>${escapeHtml(r.variant || "")}</td>
      <td>${escapeHtml(r.classification || "")}</td>
      <td>${escapeHtml(r.zygosity || "")}</td>
    </tr>`));
}

const EVENT_LABELS = {
  egfr_decline_40pct: "eGFR 较基线下降 ≥40%",
  egfr_decline_57pct: "eGFR 较基线下降 ≥57%",
  esrd: "肾衰竭 / 透析",
  death: "死亡",
  complete_remission: "完全缓解",
  partial_remission: "部分缓解",
  custom: "其他",
};

async function loadEvents(){
  const rows = await historyRows("eventsBox", "patient_list_events", 20);
  if (rows === null) return;
  if (!rows.length) { el.eventsBox.innerHTML = "<div class='muted small'>暂无临床事件记录</div>"; return; }
  el.eventsBox.innerHTML = table(["事件", "日期", "来源", "备注"], rows.map(r => `<tr>
      <td>${escapeHtml(EVENT_LABELS[r.event_type] || "其他")}</td>
      <td>${escapeHtml(r.event_date || "")}</td>
      <td>${escapeHtml(r.source === "computed" ? "系统按研究规则计算，待研究人员复核" : "研究人员登记")}</td>
      <td class="muted small">${escapeHtml((r.notes || "").slice(0, 60))}</td>
    </tr>`));
}

function historyAllowed(){
  return !!ctx && !contextFailed && !(completed && ctx.single_use);
}

async function loadExtras(){
  if (!historyAllowed()) return;
  extraLoaded = true;
  await Promise.all([loadLabs(), loadMeds(), loadVariants(), loadEvents()]);
}

async function refreshHistory(){
  if (busy || !historyAllowed()) return;
  el.btnRefresh.disabled = true;
  extraLoaded = false;
  await Promise.all([loadVisits(), el.moreRecords.open ? loadExtras() : null]);
  updateControls();
}

async function copyReceipt(){
  const text = el.receiptText.value;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
    await navigator.clipboard.writeText(text);
    toast("回执已复制。");
  } catch (_) {
    el.receiptText.focus(); el.receiptText.select();
    toast("已选中回执，请长按或使用浏览器的复制功能。");
  }
}

function bind(){
  el.form.addEventListener("submit", onSubmit);
  el.btnBack.addEventListener("click", backToEdit);
  el.btnNext.addEventListener("click", nextVisit);
  el.btnCopyReceipt.addEventListener("click", copyReceipt);
  el.btnVerify.addEventListener("click", async () => {
    if (busy || pendingSubmission || completed || !token) return;
    busy = true; updateControls();
    const valid = await loadContext();
    busy = false; updateControls();
    if (valid) await refreshHistory();
  });
  el.btnRefresh.addEventListener("click", refreshHistory);
  el.moreRecords.addEventListener("toggle", () => {
    if (el.moreRecords.open && !extraLoaded) loadExtras();
  });
  for (const node of [el.scr, el.scrUnit, el.upcr, el.upcrUnit, el.sbp, el.dbp, el.visitDate, el.notes]) {
    const changed = () => { dirty = true; computeEgfr(); renderQc(); };
    node.addEventListener("input", changed); node.addEventListener("change", changed);
  }
  window.addEventListener("beforeunload", event => {
    if (dirty || pendingSubmission || busy) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("hashchange", () => {
    if (busy || pendingSubmission || dirty && !window.confirm("当前内容还没有提交，确定放弃并打开另一个随访链接吗？")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search + currentHash);
      return;
    }
    currentHash = window.location.hash;
    main();
  });
}

async function main(){
  ++contextEpoch;
  token = getToken(); ctx = null; completed = false; reviewing = null; pendingSubmission = null;
  busy = false; contextFailed = false; verifyRetryable = false; extraLoaded = false;
  linkUnusable = false; readOnlyAtLoad = false;
  clearVisitFields();
  el.visitDate.max = localDateString();
  el.doneList.innerHTML = ""; el.receiptText.value = "";
  setHint("");
  clearHistory("链接验证后显示。");
  renderQc(); updateControls();
  if (!token) {
    contextFailed = true; linkUnusable = true;
    document.title = "随访链接无法使用";
    el.studyTitle.textContent = "缺少随访链接";
    el.linkStatus.className = "link-status warnbox";
    el.linkStatus.textContent = "请使用研究团队发给您的完整随访链接打开本页。";
    updateControls();
    return;
  }
  if (await loadContext()) await refreshHistory();
}

bind();
main();
