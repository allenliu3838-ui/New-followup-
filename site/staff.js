import { supabase } from "/lib/supabase-client.js?v=registry-20261018-cn-v6";
import { createProjectMembers } from "/lib/project-members.js?v=registry-20261018-cn-v6";
import { qs, qsa, toast, toCsv, downloadText, downloadCsvUtf8Bom, fmtDate, daysLeft, escapeHtml } from "/lib/utils.js?v=registry-20261018-cn-v6";
import { throttle } from "/lib/rate-limit.js?v=registry-20261018-cn-v6";
import { validatePassword } from "/lib/password-strength.js?v=registry-20261018-cn-v6";
import { strictDate, finiteNumber, normalizeUpcr, parseRegistryCsv, readAllRows, readKeysetRows, exportColumns, sha256Text, BASELINE_IMPORT_FIELDS, VISIT_IMPORT_FIELDS, normalizeImportRow, registryErrorMessage, containsPII, assertNoPII, fieldLabel, creatinineUmol, correctionReasonError, CLINICAL_LIMITS, SCR_MGDL_TO_UMOL } from "/lib/registry-data.js?v=registry-20261018-cn-v6";
import { renderOverviewHtml, renderBoardHtml, renderFilterBar, sortBoardRows } from "/lib/followup-board.js?v=registry-20261018-cn-v6";
import { createFollowupDialogs } from "/lib/followup-dialogs.js?v=registry-20261018-cn-v6";
import { BATCH_KINDS, TEMPLATES as BATCH_TEMPLATES, KIND_LABELS, PII_NOTICE, SKIP_MAPPING, CHUNK_SIZE, MAX_FILE_BYTES, MAX_FILE_ROWS, EVIDENCE_SOURCES, IMPORTABLE_EVENTS, templateCsv, validateBatch, buildChunks, errorReportCsv, piiHeaderColumns, baseFileName, beijingToday, MASKED_CODE } from "/lib/batch-import.js?v=registry-20261018-cn-v6";

const sb = supabase();
// 基因数据涉及人类遗传资源管理：默认关闭，仅当服务器配置 CONFIG.FEATURES.GENETICS === true 时显示。
const GENETICS_ENABLED = window.CONFIG?.FEATURES?.GENETICS === true;

const rlLogin    = throttle("login",    { maxAttempts: 10, windowMs: 15 * 60_000, message: "登录尝试过于频繁" });
const rlRegister = throttle("register", { maxAttempts: 5,  windowMs: 15 * 60_000, message: "注册请求过于频繁" });
const rlReset    = throttle("reset",    { maxAttempts: 5,  windowMs: 15 * 60_000, message: "密码重置请求过于频繁" });

// ── Element references ────────────────────────────────────
// Login elements (always in DOM)
const el = {
  loginCard: qs("#loginCard"),
  email: qs("#email"),
  password: qs("#password"),
  confirmPwdLabel: qs("#confirmPwdLabel"),
  confirmPwd: qs("#confirmPwd"),
  btnSendLink: qs("#btnSendLink"),
  btnRegister: qs("#btnRegister"),
  emailLabel: qs("#emailLabel"),
  btnResetPwd: qs("#btnResetPwd"),
  btnSetNewPwd: qs("#btnSetNewPwd"),
  btnSignOut: qs("#btnSignOut"),
  loginHint: qs("#loginHint"),
  // Header auth controls (always in DOM)
  headerUserEmail: qs("#headerUserEmail"),
  btnHeaderSignOut: qs("#btnHeaderSignOut"),
  trialBadge:  qs("#trialBadge"),
  upgradeBtn:  qs("#upgradeBtn"),
};

// Auth-gated element refs — populated AFTER template injection
let _authGatedBound = false;

function injectAuthGatedContent() {
  if (_authGatedBound) return;
  const tpl = document.getElementById("authGatedTpl");
  const container = document.getElementById("authGatedContainer");
  if (!tpl || !container) return;
  container.appendChild(tpl.content.cloneNode(true));
  _authGatedBound = true;

  // Now capture all auth-gated element references
  el.appCard = qs("#appCard");
  el.projName = qs("#projName");
  el.projCenter = qs("#projCenter");
  el.projModule = qs("#projModule");
  el.projDesc = qs("#projDesc");
  el.btnCreateProject = qs("#btnCreateProject");
  el.projectsList = qs("#projectsList");
  el.projectMeta = qs("#projectMeta");

  el.patCode = qs("#patCode");
  el.patSex = qs("#patSex");
  el.patBirthYear = qs("#patBirthYear");
  el.patBaselineDate = qs("#patBaselineDate");
  el.patBaselineScr = qs("#patBaselineScr");
  el.patBaselineScrUnit = qs("#patBaselineScrUnit");
  el.patBaselineUpcr = qs("#patBaselineUpcr");
  el.patBaselineUpcrUnit = qs("#patBaselineUpcrUnit");
  el.patientSearch = qs("#patientSearch");
  el.iganPathBox = qs("#iganPathBox");
  el.biopsyDate = qs("#biopsyDate");
  el.mestM = qs("#mestM");
  el.mestE = qs("#mestE");
  el.mestS = qs("#mestS");
  el.mestT = qs("#mestT");
  el.mestC = qs("#mestC");
  el.lnPathBox = qs("#lnPathBox");
  el.lnBiopsyDate = qs("#lnBiopsyDate");
  el.lnClass = qs("#lnClass");
  el.lnAI = qs("#lnAI");
  el.lnCI = qs("#lnCI");
  el.lnPodocytopathy = qs("#lnPodocytopathy");
  el.rctArm = qs("#rctArm");
  el.rctRandomId = qs("#rctRandomId");
  el.rctDate = qs("#rctDate");
  el.btnCreatePatient = qs("#btnCreatePatient");
  el.patientsList = qs("#patientsList");
  el.boardFilters = qs("#boardFilters");
  el.projectOverview = qs("#projectOverview");
  el.btnOpenVisitEntry = qs("#btnOpenVisitEntry");
  el.patientCodeOptions = qs("#patientCodeOptions");
  el.newProjectDetails = qs("#newProjectDetails");
  el.newPatientDetails = qs("#newPatientDetails");
  el.projectSettingsDetails = qs("#projectSettingsDetails");
  el.setInterval = qs("#setInterval");
  el.setPublicTitle = qs("#setPublicTitle");
  el.setInstitution = qs("#setInstitution");
  el.setEthicsNo = qs("#setEthicsNo");
  el.setContact = qs("#setContact");
  el.btnSaveSettings = qs("#btnSaveSettings");
  el.settingsFeedback = qs("#settingsFeedback");
  el.accountDetails = qs("#accountDetails");
  el.issuePanel = qs("#issuePanel");
  el.issueSummary = qs("#issueSummary");
  el.issueList = qs("#issueList");
  el.btnLoadIssues = qs("#btnLoadIssues");

  el.varPatientCode = qs("#varPatientCode");
  el.varTestDate = qs("#varTestDate");
  el.varTestName = qs("#varTestName");
  el.varGene = qs("#varGene");
  el.varVariant = qs("#varVariant");
  el.varHgvsC = qs("#varHgvsC");
  el.varHgvsP = qs("#varHgvsP");
  el.varZygosity = qs("#varZygosity");
  el.varClass = qs("#varClass");
  el.varLabName = qs("#varLabName");
  el.varNotes = qs("#varNotes");
  el.btnAddVariant = qs("#btnAddVariant");
  el.variantsPreview = qs("#variantsPreview");

  el.labPatientCode = qs("#labPatientCode");
  el.labDate = qs("#labDate");
  el.labTestCode = qs("#labTestCode");
  el.labName = qs("#labName");
  el.labCustomName = qs("#labCustomName");
  el.labCustomUnit = qs("#labCustomUnit");
  el.labValue = qs("#labValue");
  el.labUnit = qs("#labUnit");
  el.labStdValue = qs("#labStdValue");
  el.labQcReasonCol = qs("#labQcReasonCol");
  el.labQcReason = qs("#labQcReason");
  el.labHint = qs("#labHint");
  el.btnAddLab = qs("#btnAddLab");
  el.labsPreview = qs("#labsPreview");
  el.projCustomLabsPanel = qs("#projCustomLabsPanel");
  el.projCustomLabsList = qs("#projCustomLabsList");

  el.medPatientCode = qs("#medPatientCode");
  el.medName = qs("#medName");
  el.medClass = qs("#medClass");
  el.medDoseValue = qs("#medDoseValue");
  el.medDoseUnit = qs("#medDoseUnit");
  el.medIndication = qs("#medIndication");
  el.medNotes = qs("#medNotes");
  el.medRoute = qs("#medRoute");
  el.medFrequency = qs("#medFrequency");
  el.medStart = qs("#medStart");
  el.medEnd = qs("#medEnd");
  el.btnAddMed = qs("#btnAddMed");
  el.medsPreview = qs("#medsPreview");

  el.evtPatientCode = qs("#evtPatientCode");
  el.evtType = qs("#evtType");
  el.evtDate = qs("#evtDate");
  el.evtNotes = qs("#evtNotes");
  el.evtEvidence = qs("#evtEvidence");
  el.evtDetail = qs("#evtDetail");
  el.btnAddEvent = qs("#btnAddEvent");
  el.eventsPreview = qs("#eventsPreview");

  el.btnExportBaseline = qs("#btnExportBaseline");
  el.btnExportVisits = qs("#btnExportVisits");
  el.btnExportLabs = qs("#btnExportLabs");
  el.btnExportMeds = qs("#btnExportMeds");
  el.btnExportVariants = qs("#btnExportVariants");
  el.btnExportEvents = qs("#btnExportEvents");

  el.btnPaperPack = qs("#btnPaperPack");
  el.btnCreateSnapshot = qs("#btnCreateSnapshot");
  el.btnPaperPackWithSnapshot = qs("#btnPaperPackWithSnapshot");
  el.btnRefreshSnapshots = qs("#btnRefreshSnapshots");
  el.snapshotOut = qs("#snapshotOut");
  el.snapshotsList = qs("#snapshotsList");

  el.importType = qs("#importType");
  el.btnDownloadTemplate = qs("#btnDownloadTemplate");
  el.importFile = qs("#importFile");
  el.importPreview = qs("#importPreview");
  el.importSummary = qs("#importSummary");
  el.importTable = qs("#importTable");
  el.btnConfirmImport = qs("#btnConfirmImport");
  el.btnCancelImport = qs("#btnCancelImport");
  el.importProgress = qs("#importProgress");

  el.profileCard = qs("#profileCard");
  el.profileStatus = qs("#profileStatus");
  el.profName = qs("#profName");
  el.profHospital = qs("#profHospital");
  el.profDept = qs("#profDept");
  el.profPlan = qs("#profPlan");
  el.profContact = qs("#profContact");
  el.profNotes = qs("#profNotes");
  el.btnSaveProfile = qs("#btnSaveProfile");

  el.contractStatus = qs("#contractStatus");
  el.contractApplyForm = qs("#contractApplyForm");
  el.contractPlan = qs("#contractPlan");
  el.contractWechat = qs("#contractWechat");
  el.contractNote = qs("#contractNote");
  el.btnApplyContract = qs("#btnApplyContract");

  el.adminCard = qs("#adminCard");
  el.adminContractsBadge = qs("#adminContractsBadge");
  el.adminContracts = qs("#adminContracts");
  el.btnAdminLoadContracts = qs("#btnAdminLoadContracts");
  el.adminOrdersBadge = qs("#adminOrdersBadge");
  el.adminOrders = qs("#adminOrders");
  el.btnAdminLoadOrders = qs("#btnAdminLoadOrders");
  el.adminSearchEmail = qs("#adminSearchEmail");
  el.btnAdminSearch = qs("#btnAdminSearch");
  el.adminResults = qs("#adminResults");

  applyGeneticsFeature();

  // Bind auth-gated event listeners
  projectMembersController=createProjectMembers({root:document.getElementById('projectMembers'),sb,onAccessChange:refreshAfterMemberChange});
  bindAuthGatedEvents();
  applyProjectAccess();
}

function applyGeneticsFeature(){
  const section=qs('#geneticsSection'),note=qs('#geneticsDisabledNote'),heading=qs('#extrasHeading');
  if(section)section.hidden=!GENETICS_ENABLED;
  if(el.btnExportVariants)el.btnExportVariants.hidden=!GENETICS_ENABLED;
  if(note)note.hidden=GENETICS_ENABLED;
  if(heading)heading.textContent=GENETICS_ENABLED?'附加数据（可选）：基因、化验、用药与终点事件':'附加数据（可选）：化验、用药与终点事件';
}

async function refreshAfterMemberChange(changed){
  if(!selectedProject||changed?.projectId!==selectedProject.id||changed?.userId!==user?.id)return;
  const op=captureContext();
  // 移除录入成员或降级时，数据库会撤销本项目全部有效随访链接；重新读取权限与看板中的链接数。
  try{await loadProjectAccess(op);assertContext(op);await refreshFollowup(op);}
  catch(e){if(currentContext(op))toast('随访链接状态读取失败，请刷新后核对：'+registryErrorMessage(e));}
}

function bindAuthGatedEvents() {
  el.btnCreateProject?.addEventListener("click", createProject);
  el.btnCreatePatient?.addEventListener("click", createPatientBaseline);
  el.patientSearch?.addEventListener("input", ()=>{boardView.search=el.patientSearch.value;boardView.limit=100;renderBoard();});
  el.patBaselineUpcr?.addEventListener("input", renderBaselineConversion);
  el.patBaselineUpcrUnit?.addEventListener("change", renderBaselineConversion);
  el.patBaselineScr?.addEventListener("input", renderBaselineScrHint);
  el.patBaselineScrUnit?.addEventListener("change", renderBaselineScrHint);
  qs("#btnResetBaseline")?.addEventListener("click", ()=>{if(confirm("放弃本次未保存的基线？"))resetBaseline();});
  qs("#workspaceNav")?.addEventListener("click", e=>{ const a=e.target.closest("a");if(!a)return;const href=a.getAttribute("href");if(!href?.startsWith("#"))return;const t=qs(href);const d=t?.tagName==="DETAILS"?t:t?.querySelector(":scope > details");if(d)d.open=true; });
  el.btnOpenVisitEntry?.addEventListener("click", ()=>followupDialogs.openVisitEntry(''));
  el.patientsList?.addEventListener("click", onBoardClick);
  el.patientsList?.addEventListener("change", onBoardSelect);
  qs("#btnBulkStartDate")?.addEventListener("click", ()=>{if(boardSelected.size)followupDialogs.openBulkStartDate(selectedBoardCodes());});
  qs("#btnBulkConsent")?.addEventListener("click", ()=>{if(boardSelected.size)followupDialogs.openBulkConsent(selectedBoardCodes());});
  qs("#btnClearSelection")?.addEventListener("click", ()=>{clearBoardSelection();renderBoard();});
  el.boardFilters?.addEventListener("click", e=>{const b=e.target.closest('[data-board-filter]');if(!b)return;boardView.state=b.dataset.boardFilter;boardView.limit=100;renderBoard();});
  el.boardFilters?.addEventListener("change", e=>{if(!e.target.matches('[data-consent-select]'))return;boardView.consent=e.target.value;boardView.limit=100;renderBoard();});
  el.projectOverview?.addEventListener("click", onOverviewClick);
  el.btnSaveSettings?.addEventListener("click", saveProjectSettings);

  el.btnAddVariant?.addEventListener("click", addVariant);
  el.btnAddLab?.addEventListener("click", addLab);
  el.btnAddMed?.addEventListener("click", addMed);
  el.btnAddEvent?.addEventListener("click", addEvent);

  el.btnExportBaseline?.addEventListener("click", ()=>exportTable("baseline"));
  el.btnExportVisits?.addEventListener("click", ()=>exportTable("visits"));
  el.btnExportLabs?.addEventListener("click", ()=>exportTable("labs"));
  el.btnExportMeds?.addEventListener("click", ()=>exportTable("meds"));
  el.btnExportVariants?.addEventListener("click", ()=>exportTable("variants"));
  el.btnExportEvents?.addEventListener("click", ()=>exportTable("events"));

  el.btnPaperPack?.addEventListener("click", ()=>generatePaperPack({withSnapshot:false}));
  el.btnCreateSnapshot?.addEventListener("click", createSnapshotOnly);
  el.btnPaperPackWithSnapshot?.addEventListener("click", ()=>generatePaperPack({withSnapshot:true}));
  el.btnRefreshSnapshots?.addEventListener("click", loadSnapshots);

  el.btnDownloadTemplate?.addEventListener("click", downloadImportTemplate);
  el.importFile?.addEventListener("change", handleImportFile);
  el.btnConfirmImport?.addEventListener("click", confirmImport);
  el.btnCancelImport?.addEventListener("click", ()=>{
    const partial=_importParsed?.chunks?.some(c=>c.imported);
    if(partial&&!confirm("已有部分块写入。取消后将不能用同一预览重试未完成的块（可重新上传同一文件补录，已写入的行会自动跳过）。是否取消？"))return;
    clearImportPreview();
    el.importProgress.style.display = "none";
  });
  el.importType?.addEventListener("change", syncImportType);
  qs("#btnImportHelp")?.addEventListener("click", toggleImportHelp);
  qs("#importUnmapped")?.addEventListener("change", onUnmappedChange);
  qs("#btnDownloadImportErrors")?.addEventListener("click", downloadImportErrors);
  qs("#importResult")?.addEventListener("click", e=>{if(e.target.closest("[data-import-errors]"))downloadImportErrors();});
  qs("#importBatchesDetails")?.addEventListener("toggle", e=>{if(e.target.open)loadImportBatches();});
  qs("#btnRefreshImportBatches")?.addEventListener("click", loadImportBatches);
  qs("#importBatchesList")?.addEventListener("click", e=>{const b=e.target.closest("[data-undo-index]");if(b&&!b.disabled)openUndoForm(Number(b.dataset.undoIndex));});
  qs("#btnConfirmUndoBatch")?.addEventListener("click", confirmUndoBatch);
  qs("#btnCancelUndoBatch")?.addEventListener("click", closeUndoForm);
  syncImportType();

  el.btnSaveProfile?.addEventListener("click", saveProfile);
  el.btnApplyContract?.addEventListener("click", applyContract);

  qs("#btnExportAccount")?.addEventListener("click", ()=>generatePaperPack());
  qs("#btnDeleteAccount")?.addEventListener("click", () => {
    const hint=qs("#accountSettingsHint");
    if(hint) hint.innerHTML='注销需要人工核对研究留存及授权范围。<a href="mailto:china@kidneysphere.com?subject=账户注销申请">点击打开邮件申请</a>，请在邮件中写明账号邮箱；不要附带患者数据。只有收到受理确认才表示申请已提交。';
    toast("请通过邮件申请注销，当前尚未提交请求。");
  });

  el.labTestCode?.addEventListener("change", updateLabUnits);
  el.labValue?.addEventListener("input", updateLabStdValue);
  el.labUnit?.addEventListener("change", updateLabStdValue);

  el.btnLoadIssues?.addEventListener("click", loadIssues);

  // 附加数据列表中的删除 / 更正按钮：用 data 属性与事件委托，不在 HTML 中拼接脚本。
  [el.variantsPreview, el.labsPreview, el.medsPreview, el.eventsPreview, el.projCustomLabsList].forEach(box => box?.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || !box.contains(b) || b.disabled) return;
    if (b.dataset.deleteCustomLab) deleteProjectCustomLab(b.dataset.deleteCustomLab);
    else if (b.dataset.deleteTable) deleteRecord(b.dataset.deleteTable, b.dataset.recordId);
    else if (b.dataset.editTable) openRecordEditor(b.dataset.editTable, b.dataset.recordId);
  }));

  [
    { el: el.evtNotes,  label: "事件备注" },
    { el: el.evtDetail, label: "事件细节" },
    { el: el.medNotes,  label: "用药备注" },
    { el: el.medIndication, label: "用药目的" },
    { el: el.varNotes,  label: "基因备注" },
    { el: el.labQcReason, label: "留痕原因" },
  ].forEach(({ el: inp, label }) => {
    inp?.addEventListener("input", () => {
      if (containsPII(inp.value)) {
        inp.style.borderColor = "#dc2626";
        inp.title = `${label}中检测到疑似个人身份信息，请删除手机号、身份证号、住院号、姓名等内容`;
      } else {
        inp.style.borderColor = "";
        inp.title = "";
      }
    });
  });
}

let session = null;
let user = null;
let isPlatformAdmin = false;
let passwordRecoveryMode = false;
let renderedForUser = null;   // 已为哪个用户加载过工作台数据（避免同一会话重复加载）

let projects = [];
let selectedProject = null;
let patients = [];           // 随访看板行（v_patient_followup_status），id = 基线记录 id
let patientsLoaded = false;
let projectOverview = null;
const boardView = { state: 'all', consent: 'all', search: '', limit: 100 };
const boardSelected = new Set(); // 看板中勾选的研究编号（批量设置提醒起算日、批量确认知情同意）
let boardVisibleCodes = [];      // 当前显示的研究编号（“全选”只选这些）
let labCatalog = [];         // [{code, name_cn, module, is_core, standard_unit, display_note}]
let unitMap = {};            // { code: [{unit_symbol, is_standard, multiplier}] }
let projectCustomLabs = [];  // [{id, name, unit}] — per-project custom lab catalog
let sessionEpoch=0, projectEpoch=0;
let projectAccess=null;
let projectMembersController=null;
// can_record_study_exit：负责人和录入协作人登记拒绝/撤回同意或停止随访，不受账户只读影响（与撤销链接相同，数据库同样放行）。
function canProject(capability){if(capability==='can_record_study_exit')return canRevokeTokens();return !!selectedProject && projectAccess?.[capability]===true;}
function canRevokeTokens(){return !!selectedProject&&['owner','editor'].includes(projectAccess?.role);}
function canManageProject(){return !!selectedProject&&projectAccess?.can_manage_project===true;}
function requireProjectCapability(capability){
  if(canProject(capability))return true;
  const reason=projectAccess?.write_block_reason;
  toast(!selectedProject?'请先选择项目':!projectAccess?'项目权限尚未加载，请重试':reason&&['can_write','can_manage_tokens'].includes(capability)?registryErrorMessage(reason):'当前项目角色没有此操作权限，请联系项目负责人');return false;
}
function applyProjectAccess(){
  const groups={can_write:['btnCreatePatient','btnAddVariant','btnAddLab','btnAddMed','btnAddEvent','importFile','btnConfirmImport','btnOpenVisitEntry'],can_manage_project:['btnSaveSettings'],can_export:['btnExportBaseline','btnExportVisits','btnExportLabs','btnExportMeds','btnExportVariants','btnExportEvents','btnPaperPack','btnCreateSnapshot','btnPaperPackWithSnapshot','btnRefreshSnapshots']};
  // data-blocked：按钮因本身状态不可用（如导入预览仍有错误），权限刷新时不重新启用。
  for(const [capability,keys]of Object.entries(groups))for(const key of keys){const node=el[key];if(node){node.dataset.projectCapability=capability;node.disabled=busyButtons.has(node)||!canProject(capability)||node.dataset.blocked==='1';}}
  qsa('[data-project-capability]').forEach(node=>{node.disabled=busyButtons.has(node)||!canProject(node.dataset.projectCapability)||node.dataset.blocked==='1';});
  const label=qs('#projectAccessStatus');if(label)label.textContent=!selectedProject?'请先选择项目':!projectAccess?'正在核对项目权限…':`我的项目角色：${({owner:'项目负责人',editor:'录入协作人',analyst:'分析协作人',viewer:'只读协作人'})[projectAccess.role]||'无权限'} · ${projectAccess.can_write?'可录入':'不可录入'} · ${projectAccess.can_export?'可导出':'不可导出'}${projectAccess.write_block_reason&&projectAccess.write_block_reason!=='role_read_only'?' · '+registryErrorMessage(projectAccess.write_block_reason):''}`;
  if(el.projectSettingsDetails)el.projectSettingsDetails.hidden=!canManageProject();
  // 只读 / 分析角色（及账户只读）不显示批量导入入口；导入记录仍可查看。
  const canImport=canProject('can_write');const controls=qs('#importControls');if(controls)controls.hidden=!canImport;
  const note=qs('#importReadonlyNote');if(note)note.hidden=canImport||!projectAccess;
}
async function loadProjectAccess(op=captureContext()){
  const {data,error}=await sb.rpc('get_project_access',{p_project_id:op.project.id});if(error)throw error;assertContext(op);
  if(!data?.can_read)throw new Error('project_access_denied');projectAccess=data;applyProjectAccess();return data;
}
function captureIdentity(){return {epoch:sessionEpoch,id:user?.id};}
function sameIdentity(c){return c.epoch===sessionEpoch&&c.id===user?.id;}
const busyButtons=new Set();
const frozenRequests=new Map();
function captureContext(){
  if(!user || !selectedProject)throw new Error("请先登录并选择项目");
  return {userId:user.id, sessionEpoch, projectEpoch, project:{...selectedProject}};
}
function assertContext(c){
  if(!c||c.userId!==user?.id||c.sessionEpoch!==sessionEpoch||c.projectEpoch!==projectEpoch||c.project.id!==selectedProject?.id)throw new Error("账号或项目已改变，本次操作已停止，请重新打开当前任务");
}
function currentContext(c){try{assertContext(c);return true;}catch{return false;}}
function resetBaseline(){
  ['patCode','patBirthYear','patBaselineDate','patBaselineScr','patBaselineUpcr','biopsyDate','lnBiopsyDate','lnAI','lnCI','rctRandomId','rctDate'].forEach(k=>{if(el[k])el[k].value='';});
  ['patSex','mestM','mestE','mestS','mestT','mestC','lnClass','lnPodocytopathy','rctArm'].forEach(k=>{if(el[k])el[k].value='';});
  if(el.patBaselineUpcrUnit)el.patBaselineUpcrUnit.value='mg/g';
  if(el.patBaselineScrUnit)el.patBaselineScrUnit.value='umol';
  renderBaselineConversion();renderBaselineScrHint();
}
function renderBaselineConversion(){
  const hint=qs('#baselineUnitHint');if(!hint)return;
  try{const n=normalizeUpcr(el.patBaselineUpcr?.value,el.patBaselineUpcrUnit?.value||'mg/g');hint.textContent=n==null?'按所选单位输入，保存前显示换算结果。':`将保存：${n} mg/g；原始输入与单位同时留存。`;}catch(e){hint.textContent=e.message;}
}
function renderBaselineScrHint(){
  const hint=qs('#baselineScrHint');if(!hint)return;
  const raw=el.patBaselineScr?.value?.trim(),unit=el.patBaselineScrUnit?.value||'umol';
  if(!raw){hint.textContent='按化验单单位填写；系统统一按 μmol/L 保存（10–5000 μmol/L）。';return;}
  try{const umol=creatinineUmol(raw,unit,'基线血肌酐');hint.textContent=unit==='mgdl'?`按 1 mg/dL = ${SCR_MGDL_TO_UMOL} μmol/L 换算，将保存为 ${umol} μmol/L。`:`将保存为 ${umol} μmol/L。`;}catch(e){hint.textContent=e.message;}
}
function clearProjectWorkspace(){
  resetBaseline();_importParsed=null;projectCustomLabs=[];patients=[];patientsLoaded=false;projectOverview=null;
  Object.assign(boardView,{state:'all',consent:'all',search:'',limit:100});clearBoardSelection();
  ['varPatientCode','labPatientCode','medPatientCode','evtPatientCode','varTestDate','varTestName','varGene','varVariant','varHgvsC','varHgvsP','varZygosity','varClass','varLabName','varNotes','labDate','labValue','labQcReason','labCustomName','labCustomUnit','medName','medClass','medDoseValue','medDoseUnit','medIndication','medNotes','medRoute','medFrequency','medStart','medEnd','evtType','evtDate','evtNotes','evtEvidence','evtDetail','importFile','setInterval','setPublicTitle','setInstitution','setEthicsNo','setContact'].forEach(k=>{if(el[k])el[k].value='';});
  if(el.settingsFeedback)el.settingsFeedback.replaceChildren();
  if(el.patientCodeOptions)el.patientCodeOptions.replaceChildren();
  if(el.boardFilters)el.boardFilters.replaceChildren();
  if(el.projectOverview)el.projectOverview.innerHTML='<p class="muted small">正在读取项目概览…</p>';
  if(el.labTestCode)el.labTestCode.value='';
  if(el.labUnit){el.labUnit.innerHTML='<option value="">-- 先选化验项目 --</option>';el.labUnit.value='';}
  if(el.labStdValue)el.labStdValue.value='';
  if(el.patientSearch)el.patientSearch.value='';
  if(qs('#importUnitsConfirm'))qs('#importUnitsConfirm').checked=false;
  if(qs('#importBaselineUnit'))qs('#importBaselineUnit').value='';
  resetImportUi();closeImportHelp();closeUndoForm();_importBatches=[];
  {const box=qs('#importBatchesList');if(box)box.textContent='';const d=qs('#importBatchesDetails');if(d)d.open=false;const u=qs('#importUndoResult');if(u)u.textContent='';}
  ['importPreview','importProgress','snapshotOut'].forEach(k=>{if(el[k]){el[k].style.display='none';if(k!=='importPreview')el[k].textContent='';}});
  ['issueSummary','snapshotsList','patientsList','variantsPreview','labsPreview','medsPreview','eventsPreview'].forEach(k=>{if(el[k])el[k].textContent='请等待当前项目加载。';});
  if(el.issueList)el.issueList.textContent='';
  boardLoad=null;rowRefreshSeq.clear();
  followupDialogs.closeAll();
  document.querySelectorAll('[data-registry-modal]').forEach(n=>n.remove());
}
function clearSessionWorkspace(){
  sessionEpoch++;projectEpoch++;renderedForUser=null;projects=[];selectedProject=null;patients=[];patientsLoaded=false;clearBoardSelection();projectOverview=null;_importParsed=null;_importBatches=[];_undoTarget=null;_lastImportReport=null;projectCustomLabs=[];labCatalog=[];unitMap={};projectAccess=null;busyButtons.clear();frozenRequests.clear();isPlatformAdmin=false;
  projectMembersController?.clear();projectMembersController=null;
  boardLoad=null;rowRefreshSeq.clear();
  followupDialogs.closeAll();
  document.getElementById('authGatedContainer')?.replaceChildren();
  document.querySelectorAll('[data-registry-modal]').forEach(n=>n.remove());
  _authGatedBound=false;
  if(el.password)el.password.value='';if(el.confirmPwd)el.confirmPwd.value='';
  clearAccountDisplay();
}
/** 退出登录后清除页面上显示过的账号信息：邮箱、账户权益徽章及可能含研究编号的提示。 */
function clearAccountDisplay(){
  if(el.headerUserEmail){el.headerUserEmail.textContent='';el.headerUserEmail.style.display='none';}
  if(el.trialBadge){el.trialBadge.textContent='';el.trialBadge.className='badge';el.trialBadge.style.display='none';}
  if(el.upgradeBtn){el.upgradeBtn.style.display='none';el.upgradeBtn.setAttribute('href','#');}
  if(el.email)el.email.value='';
  if(el.loginHint)el.loginHint.textContent='';
  document.querySelectorAll('.toast .t').forEach(n=>n.remove());
  hideIdleWarning();
}

// ── 闲置自动退出 ─────────────────────────────────────────────
// 30 分钟没有操作（鼠标、键盘、触摸、滚动）自动退出登录，28 分钟时提示可“继续使用”。
// 多个标签页通过 localStorage 只共享“最近一次操作的时间戳”（不含任何账号或研究数据），任一标签页有操作即视为在用。
const IDLE_LIMIT_MS=30*60_000, IDLE_WARN_MS=28*60_000, IDLE_WRITE_EVERY_MS=10_000, IDLE_STORE_KEY='ks_staff_last_activity';
// ready：首次判断完登录状态后才写入时间戳，避免打开页面时的鼠标移动掩盖“已闲置很久”的旧会话。
// expired：本页因闲置退出（或发现其他标签页因闲置退出），登录页说明原因，直到重新登录。
const idle={last:Date.now(),written:0,signingOut:false,ready:false,expired:false};
const IDLE_MESSAGE='由于 30 分钟没有操作，已自动退出登录。为保护研究数据，请重新登录。';
function storedActivity(){try{const v=Number(localStorage.getItem(IDLE_STORE_KEY));return Number.isFinite(v)&&v>0?v:0;}catch{return 0;}}
// 提示显示期间，只有点击、按键、触摸（或“继续使用”）才算继续使用；单纯移动鼠标或滚动不关闭提示。
// 提示框内的操作交给“继续使用”按钮处理：按下按钮时不先收起提示，以免点击落到下面的页面元素上。
const PASSIVE_ACTIVITY=new Set(['pointermove','mousemove','wheel','scroll']);
function noteActivity(event){
  const warningShown=!!el.idleWarning&&!el.idleWarning.hidden;
  if(event&&warningShown&&(PASSIVE_ACTIVITY.has(event.type)||el.idleWarning.contains(event.target)))return;
  const now=Date.now();
  if(now>idle.last)idle.last=now;
  if(idle.ready&&now-idle.written>=IDLE_WRITE_EVERY_MS){idle.written=now;try{localStorage.setItem(IDLE_STORE_KEY,String(now));}catch{/* 隐私模式时只在本标签页计时 */}}
  if(!el.idleWarning?.hidden)hideIdleWarning();
}
function hideIdleWarning(){if(el.idleWarning&&!el.idleWarning.hidden){el.idleWarning.hidden=true;}}
function showIdleWarning(remainingMs){
  const box=el.idleWarning;if(!box)return;
  const seconds=Math.max(0,Math.ceil(remainingMs/1000));
  const countdown=qs('#idleCountdown');if(countdown)countdown.textContent=`${Math.floor(seconds/60)} 分 ${String(seconds%60).padStart(2,'0')} 秒`;
  if(box.hidden){box.hidden=false;qs('#btnIdleContinue')?.focus();}
}
/** 重新打开页面时：上次操作已超过 30 分钟、且之后没有重新登录，则不沿用保存的登录状态。 */
function sessionIdleExpired(){
  const last=storedActivity();if(!last||Date.now()-last<IDLE_LIMIT_MS)return false;
  const signedIn=Date.parse(user?.last_sign_in_at||'')||0;
  return !(signedIn>last);
}
function checkIdle(){
  if(!user||passwordRecoveryMode||idle.signingOut){hideIdleWarning();return;}
  const shared=storedActivity();if(shared>idle.last)idle.last=shared;
  const idleFor=Date.now()-idle.last;
  if(idleFor>=IDLE_LIMIT_MS){idleSignOut();return;}
  if(idleFor>=IDLE_WARN_MS)showIdleWarning(IDLE_LIMIT_MS-idleFor);else hideIdleWarning();
}
async function idleSignOut(){
  if(idle.signingOut)return;idle.signingOut=true;idle.expired=true;
  // 先清空页面上的研究数据与账号信息，再通知服务器退出；网络缓慢时也不会继续显示数据。
  session=null;user=null;passwordRecoveryMode=false;clearSessionWorkspace();renderAuthState();
  try{await sb.auth.signOut({scope:'local'});}catch{/* 本机登录状态已清除 */}
  idle.signingOut=false;
  if(!user){setLoginHint(IDLE_MESSAGE);toast('已自动退出登录');}
}
function startIdleWatch(){
  el.idleWarning=qs('#idleWarning');
  qs('#btnIdleContinue')?.addEventListener('click',()=>{idle.written=0;noteActivity();hideIdleWarning();});
  for(const type of ['pointerdown','pointermove','mousemove','keydown','touchstart','wheel','scroll'])window.addEventListener(type,noteActivity,{capture:true,passive:true});
  window.addEventListener('storage',e=>{if(e.key===IDLE_STORE_KEY){const v=Number(e.newValue);if(Number.isFinite(v)&&v>idle.last){idle.last=v;hideIdleWarning();}}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkIdle();});
  setInterval(checkIdle,1000);
}
window.addEventListener('beforeunload',e=>{if(busyButtons.size){e.preventDefault();e.returnValue='';}});

// 录入随访、随访链接、研究状态对话框。上下文与权限检查沿用本文件的 captureContext/assertContext。
const followupDialogs=createFollowupDialogs({
  sb,
  capture:()=>captureContext(),
  isCurrent:op=>currentContext(op),
  assertCurrent:op=>assertContext(op),
  can:capability=>canProject(capability),
  canManageLinks:()=>canRevokeTokens(),
  setBusy:(btn,flag)=>setBusy(btn,flag),
  toast,
  errorMessage:(error,options)=>registryErrorMessage(error,options),
  containsPII,
  getRow:code=>patients.find(p=>p.patient_code===code),
  rowsLoaded:()=>patientsLoaded,
  getProject:()=>selectedProject,
  onSaved:onFollowupSaved,
  clearSelection:()=>{clearBoardSelection();renderBoard();},
  openHistory:code=>openVisitHistory(code),
  // 随访链接固定指向站点根下的 /followup，不随工作台的打开路径（/staff、/staff/…）变化。
  linkOrigin:()=>location.origin,
});


// PII 检测见 /lib/registry-data.js（containsPII / assertNoPII），与数据库 _contains_pii 规则保持一致。

function setLoginHint(msg){ el.loginHint.textContent = msg || ""; }

function setBusy(btn, busy){
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  if(busy)busyButtons.add(btn);else busyButtons.delete(btn);
  btn.disabled = !!busy || !!(btn.dataset.projectCapability&&!canProject(btn.dataset.projectCapability)) || btn.dataset?.blocked==='1';
  btn.textContent = busy ? "处理中…" : btn.dataset.label;
}

function getInputEmail(){
  return (el.email?.value || "").trim().toLowerCase();
}

// ── User-level status badge (subscription + projects, independent of project selection) ──
async function loadUserSubscriptionBadge(){
  const identity=captureIdentity();if(!user||!el.trialBadge)return;
  if(isPlatformAdmin){el.trialBadge.className='badge ok';el.trialBadge.textContent='平台管理员';el.trialBadge.style.display='inline-flex';if(el.upgradeBtn)el.upgradeBtn.style.display='none';return;}
  try{
    const {data,error}=await sb.rpc('check_project_quota');if(!sameIdentity(identity))return;if(error)throw error;
    const q=Array.isArray(data)?data[0]:data;if(!q)throw new Error('服务器未返回账户权益');
    const label=({trial:'试用',pro:'Pro',institution:'机构版',institutional:'机构版',partner:'合作伙伴'})[q.plan]||q.plan||'账户';
    const end=q.ends_at||q.trial_expires_at,left=end?daysLeft(end):null;
    el.trialBadge.className=q.can_write?'badge ok':'badge warn';
    el.trialBadge.textContent=`${label} · ${q.can_write?'可录入':'只读'}${end?' · 到期 '+fmtDate(end):''} · 项目 ${q.used ?? 0}/${q.quota ?? '—'}`;
    el.trialBadge.style.display='inline-flex';
    if(el.upgradeBtn){el.upgradeBtn.href='/checkout';el.upgradeBtn.textContent=q.plan==='trial'?'查看订阅':'续费';el.upgradeBtn.style.display=(!q.can_write||(left!==null&&left<=30))?'inline-flex':'none';}
  }catch(e){if(!sameIdentity(identity))return;el.trialBadge.className='badge warn';el.trialBadge.textContent='账户权益读取失败，请刷新重试';el.trialBadge.style.display='inline-flex';if(el.upgradeBtn)el.upgradeBtn.style.display='none';}
}
function renderTrialBadge(){loadUserSubscriptionBadge();}

function showIganPathBox(){
  const mod = (selectedProject?.module || "").toUpperCase();
  el.iganPathBox.style.display = (mod === "IGAN") ? "block" : "none";
  el.lnPathBox.style.display   = (mod === "LN")   ? "block" : "none";
}

async function init(){
  startIdleWatch();
  // Show loading indicator during auth check
  const authLoading = document.getElementById("authLoading");
  if (authLoading) authLoading.style.display = "block";

  // Show friendly message for Supabase auth errors forwarded from index.html
  const hashParams = new URLSearchParams(location.hash.slice(1));
  if (hashParams.get("error")) {
    const code = hashParams.get("error_code") || hashParams.get("error");
    const msg = code === "otp_expired"
      ? "重置链接已过期，请重新点击「忘记密码」发送新的链接。"
      : (hashParams.get("error_description") || "认证失败，请重试。").replace(/\+/g, " ");
    setLoginHint(msg);
    history.replaceState(null, "", location.pathname);
  }

  // Register BEFORE getSession so PASSWORD_RECOVERY event is never missed
  let stateHandled = false;
  sb.auth.onAuthStateChange((_event, s2)=>{
    if(user?.id !== s2?.user?.id)clearSessionWorkspace();
    session = s2;
    user = s2?.user || null;
    stateHandled = true;
    if (_event === "PASSWORD_RECOVERY"){
      passwordRecoveryMode = true;
      showNewPasswordMode();
      return;
    }
    // Token refresh just updates the session in memory — no need to reload all data
    if (_event === "TOKEN_REFRESHED") return;
    // 初始化时会先后收到 SIGNED_IN 与 INITIAL_SESSION，切回标签页时也可能再收到 SIGNED_IN；
    // 同一用户的工作台已加载时不重复读取，避免覆盖正在进行的操作。
    if (["INITIAL_SESSION", "SIGNED_IN", "USER_UPDATED"].includes(_event) && user && renderedForUser === user.id) return;
    // Clear selection state on sign out
    // 其他标签页因闲置退出时，本页同样说明原因。
    if (_event === "SIGNED_OUT"){ if (Date.now() - Math.max(idle.last, storedActivity()) >= IDLE_WARN_MS) idle.expired = true; clearSessionWorkspace(); passwordRecoveryMode = false; }
    renderAuthState();
    // After normal login/auth, check if there's a pending password reset
    if (user && !passwordRecoveryMode) checkPendingPasswordReset();
  });

  // getSession triggers PKCE code exchange; the listener above handles the result
  const { data: { session: s } } = await sb.auth.getSession();
  if (!stateHandled){
    // onAuthStateChange hasn't fired yet — render with whatever getSession returned
    session = s;
    user = s?.user || null;
    renderAuthState();
    if (user) checkPendingPasswordReset();
  }

  // Login-related event listeners (always in DOM)
  el.btnSendLink.addEventListener("click", sendMagicLink);
  el.btnRegister.addEventListener("click", registerAccount);
  el.btnResetPwd.addEventListener("click", resetPassword);
  el.btnSetNewPwd?.addEventListener("click", setNewPassword);
  el.btnSignOut.addEventListener("click", async ()=>{
    await sb.auth.signOut();
    toast("已退出登录");
  });
  el.btnHeaderSignOut?.addEventListener("click", async ()=>{
    await sb.auth.signOut();
    toast("已退出登录");
  });

  // Auth-gated event listeners are bound in bindAuthGatedEvents() via injectAuthGatedContent()
}

function renderAuthState(){
  const authLoading = document.getElementById("authLoading");
  if (authLoading) authLoading.style.display = "none";

  if (!user){
    renderedForUser = null;
    idle.ready = true;
    clearAccountDisplay();
    // Anonymous: only show login card, no auth-gated content in DOM at all
    el.loginCard.style.display = "block";
    if (el.appCard) el.appCard.style.display = "none";
    if (el.profileCard) el.profileCard.style.display = "none";
    if (el.adminCard) el.adminCard.style.display = "none";
    if (el.issuePanel) el.issuePanel.style.display = "none";
    el.btnSignOut.style.display = "none";
    if (el.btnHeaderSignOut) el.btnHeaderSignOut.style.display = "none";
    if (el.headerUserEmail) el.headerUserEmail.style.display = "none";
    el.btnSendLink.style.display = "";
    el.btnRegister.style.display = "";
    el.btnResetPwd.style.display = "";
    isPlatformAdmin = false;
    setLoginHint(idle.expired ? IDLE_MESSAGE : "提示：首次使用请先点击「注册账号」创建账号，之后再登录。");
    return;
  }
  // 设置新密码完成前不显示工作台
  if (passwordRecoveryMode){ showNewPasswordMode(); return; }
  // 关闭页面超过 30 分钟后重新打开：不沿用保存的登录状态，需要重新登录。
  if (sessionIdleExpired()){ idleSignOut(); return; }
  if (!idle.ready){ idle.ready = true; idle.last = Date.now(); idle.written = 0; noteActivity(); }
  idle.expired = false;
  renderedForUser = user.id;
  // Logged in: inject auth-gated content from template (only once)
  injectAuthGatedContent();
  el.loginCard.style.display = "none";
  el.appCard.style.display = "block";
  if (el.profileCard) el.profileCard.style.display = "block";
  if (el.accountDetails) el.accountDetails.style.display = "";
  if (el.issuePanel) el.issuePanel.style.display = "block";
  // Admin card stays hidden until checkPlatformAdmin confirms via server RPC
  if (el.adminCard) el.adminCard.style.display = "none";
  el.btnSignOut.style.display = "inline-flex";
  if (el.btnHeaderSignOut) el.btnHeaderSignOut.style.display = "inline-flex";
  if (el.headerUserEmail) {
    el.headerUserEmail.textContent = user.email;
    el.headerUserEmail.style.display = "inline";
  }
  setLoginHint(`已登录：${user.email}`);
  loadLabCatalog();
  loadAll();
  loadProfile();
  loadMyContract();
  loadUserSubscriptionBadge();
  checkPlatformAdmin();
}

async function checkPlatformAdmin(){
  const identity=captureIdentity();
  const { data, error } = await sb.rpc("is_platform_admin");
  if(!sameIdentity(identity))return;
  isPlatformAdmin = !error && data === true;
  if (!isPlatformAdmin) {
    // Ensure admin panel is empty and hidden for non-admins
    if (el.adminCard) { el.adminCard.innerHTML = ""; el.adminCard.style.display = "none"; }
    return;
  }
  // Dynamically inject admin panel HTML only after server confirms admin role
  if (el.adminCard) {
    el.adminCard.className = "card";
    el.adminCard.innerHTML = buildAdminPanelHtml();
    el.adminCard.style.display = "block";
    // Re-bind admin element references after injection
    el.adminContractsBadge = qs("#adminContractsBadge");
    el.adminContracts = qs("#adminContracts");
    el.btnAdminLoadContracts = qs("#btnAdminLoadContracts");
    el.adminOrdersBadge = qs("#adminOrdersBadge");
    el.adminOrders = qs("#adminOrders");
    el.btnAdminLoadOrders = qs("#btnAdminLoadOrders");
    el.adminSearchEmail = qs("#adminSearchEmail");
    el.btnAdminSearch = qs("#btnAdminSearch");
    el.adminResults = qs("#adminResults");
    // Bind admin event listeners
    el.btnAdminLoadContracts?.addEventListener("click", adminLoadContracts);
    el.btnAdminLoadOrders?.addEventListener("click", adminLoadOrders);
    el.btnAdminSearch?.addEventListener("click", adminSearch);
    el.adminSearchEmail?.addEventListener("keydown", e=>{ if(e.key==="Enter") adminSearch(); });
  }
  adminLoadContracts();
  adminLoadOrders();
  // Re-render trial badge now that admin status is confirmed
  renderTrialBadge(selectedProject);
}

function buildAdminPanelHtml(){
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <h2 style="margin:0">平台管理员</h2>
      <span class="badge ok" style="font-size:11px">仅你可见</span>
    </div>
    <div class="muted small">通过邮箱搜索用户及其项目，管理试用期与权益。</div>
    <div class="hr"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0;font-size:15px">合作申请</h3>
      <span id="adminContractsBadge" class="badge warn" style="display:none;font-size:11px"></span>
      <button class="btn small" id="btnAdminLoadContracts" style="margin-left:auto">刷新</button>
    </div>
    <div id="adminContracts" class="muted small">加载中…</div>
    <div class="hr"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0;font-size:15px">支付订单</h3>
      <span id="adminOrdersBadge" class="badge warn" style="display:none;font-size:11px"></span>
      <button class="btn small" id="btnAdminLoadOrders" style="margin-left:auto">刷新</button>
    </div>
    <div id="adminOrders" class="muted small">加载中…</div>
    <div class="hr"></div>
    <h3 style="margin:0 0 8px 0;font-size:15px">用户 & 项目搜索</h3>
    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <label>用户邮箱（支持模糊搜索）</label>
        <input id="adminSearchEmail" type="text" placeholder="例如：researcher@hospital.com"/>
      </div>
      <button class="btn primary" id="btnAdminSearch" style="margin-top:4px">搜索</button>
    </div>
    <div id="adminResults" style="margin-top:14px"></div>`;
}

async function sendMagicLink(){
  if (!rlLogin.allow()) { toast(rlLogin.message); return; }
  const email = getInputEmail();
  const password = el.password?.value || "";
  if (!email){ toast("请输入邮箱"); return; }
  if (!password){ toast("请输入密码"); return; }
  const btn = el.btnSendLink;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // Clear any pending password reset flag on successful login
    try { localStorage.removeItem("ks_pending_pwd_reset"); } catch(_){}
    toast("登录成功");
  }catch(e){
    console.error(e);
    if (window.ErrorLogger) ErrorLogger.log("staff.login", e);
    toast("登录失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn, false);
  }
}

function registerAccount(){
  location.assign('/signup');
}

async function resetPassword(){
  if (!rlReset.allow()) { toast(rlReset.message); return; }
  const email = getInputEmail();
  if (!email){ toast("请先输入您的注册邮箱"); return; }
  const btn = el.btnResetPwd;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth-callback?returnTo=/staff`
    });
    if (error) throw error;
    // Mark pending reset in localStorage so we can detect it after redirect
    try { localStorage.setItem("ks_pending_pwd_reset", email); } catch(_){}
    toast("重置邮件已发送，请查收邮件");
    setLoginHint("已发送密码重置邮件，请点击邮件中的链接完成重置。");
  }catch(e){
    console.error(e);
    toast("发送失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn, false);
  }
}

// Check localStorage for pending password reset — works after normal login completes
function checkPendingPasswordReset(){
  try {
    const pending = localStorage.getItem("ks_pending_pwd_reset");
    if (!pending) return;
    // Verify the logged-in email matches the one that requested reset
    if (user && user.email && user.email.toLowerCase() === pending.toLowerCase()) {
      passwordRecoveryMode = true;
      showNewPasswordMode();
    } else {
      // Different user logged in, or email doesn't match — clear stale flag
      localStorage.removeItem("ks_pending_pwd_reset");
    }
  } catch(_){}
}

function showNewPasswordMode(){
  // Ensure login card is visible and app content is hidden during password reset
  el.loginCard.style.display = "block";
  if (el.appCard) el.appCard.style.display = "none";
  if (el.profileCard) el.profileCard.style.display = "none";
  if (el.adminCard) el.adminCard.style.display = "none";
  if (el.issuePanel) el.issuePanel.style.display = "none";
  if (el.accountDetails) el.accountDetails.style.display = "none";

  el.emailLabel.style.display = "none";
  el.email.style.display = "none";
  el.password.placeholder = "输入新密码（至少8位）";
  el.password.value = "";
  el.confirmPwdLabel.style.display = "";
  el.confirmPwd.style.display = "";
  el.confirmPwd.value = "";
  el.btnSendLink.style.display = "none";
  el.btnRegister.style.display = "none";
  el.btnResetPwd.style.display = "none";
  if (el.btnSetNewPwd) el.btnSetNewPwd.style.display = "inline-flex";
  // Hide header sign-out during password reset to prevent skipping
  if (el.btnHeaderSignOut) el.btnHeaderSignOut.style.display = "none";
  setLoginHint("请输入新密码并确认，然后点击「确认修改密码」。");
}

async function setNewPassword(){
  const newPwd = el.password?.value || "";
  const confirmPwd = el.confirmPwd?.value || "";
  const pwCheck = validatePassword(newPwd);
  if (!pwCheck.valid){ toast(pwCheck.message); return; }
  if (newPwd !== confirmPwd){ toast("两次输入的密码不一致，请重新输入"); el.confirmPwd.value = ""; el.confirmPwd.focus(); return; }
  const btn = el.btnSetNewPwd;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.updateUser({ password: newPwd });
    if (error) throw error;
    toast("密码修改成功，已自动登录");
    passwordRecoveryMode = false;
    try { localStorage.removeItem("ks_pending_pwd_reset"); } catch(_){}
    // Restore normal login UI
    el.emailLabel.style.display = "";
    el.email.style.display = "";
    el.password.placeholder = "请输入密码";
    el.password.value = "";
    el.confirmPwdLabel.style.display = "none";
    el.confirmPwd.style.display = "none";
    el.confirmPwd.value = "";
    el.btnSendLink.style.display = "";
    el.btnRegister.style.display = "";
    el.btnResetPwd.style.display = "";
    if (el.btnSetNewPwd) el.btnSetNewPwd.style.display = "none";
    renderAuthState();
  }catch(e){
    console.error(e);
    toast("修改失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn, false);
  }
}

async function loadLabCatalog(){
  const identity=captureIdentity();
  const { data, error } = await sb.from("lab_test_catalog")
    .select("code,name_cn,name_en,module,is_core,standard_unit,display_note")
    .order("module").order("name_cn");
  if(!sameIdentity(identity))return;
  if (error || !data) return;
  labCatalog = data;

  // Build unit map: { code: [{unit_symbol, is_standard, multiplier}] }
  const { data: mapRows } = await sb.from("lab_test_unit_map")
    .select("lab_test_code,unit_symbol,is_standard,multiplier");
  if(!sameIdentity(identity))return;
  unitMap = {};
  (mapRows || []).forEach(r => {
    if (!unitMap[r.lab_test_code]) unitMap[r.lab_test_code] = [];
    unitMap[r.lab_test_code].push(r);
  });

  rebuildLabDropdown();
}

function rebuildLabDropdown(){
  if (!el.labTestCode) return;
  const grouped = {};
  labCatalog.forEach(c => {
    if (!grouped[c.module]) grouped[c.module] = [];
    grouped[c.module].push(c);
  });
  el.labTestCode.innerHTML = '<option value="">-- 选择化验项目 --</option>';
  Object.entries(grouped).forEach(([mod, items]) => {
    const grp = document.createElement("optgroup");
    grp.label = mod;
    items.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.code;
      opt.textContent = `${c.name_cn}（${c.code}）`;
      grp.appendChild(opt);
    });
    el.labTestCode.appendChild(grp);
  });
  // Project-level custom labs
  if (projectCustomLabs.length) {
    const grp = document.createElement("optgroup");
    grp.label = "本项目自定义";
    projectCustomLabs.forEach(cl => {
      const opt = document.createElement("option");
      opt.value = "PROJ:" + cl.id;
      opt.textContent = `${cl.name}（${cl.unit || "无单位"}）`;
      grp.appendChild(opt);
    });
    el.labTestCode.appendChild(grp);
  }
  // Free custom entry option — always last
  const customOpt = document.createElement("option");
  customOpt.value = "CUSTOM";
  customOpt.textContent = "＋ 新增自定义化验（保存到本项目目录）";
  el.labTestCode.appendChild(customOpt);
}

async function loadProjectCustomLabs(){
  projectCustomLabs = [];
  if (!selectedProject) {
    rebuildLabDropdown();
    renderProjectCustomLabsPanel();
    return;
  }
  const requestContext=captureContext();
  const { data, error } = await sb.from("project_custom_labs")
    .select("id,name,unit,sort_order")
    .eq("project_id", selectedProject.id)
    .order("sort_order").order("name");
  if(!currentContext(requestContext))return;
  if(error){projectCustomLabs=[];if(el.labHint)el.labHint.textContent="项目化验目录读取失败，请重试。";return;}
  projectCustomLabs = data || [];
  rebuildLabDropdown();
  renderProjectCustomLabsPanel();
}

function renderProjectCustomLabsPanel(){
  if (!el.projCustomLabsPanel) return;
  if (!selectedProject || projectCustomLabs.length === 0){
    el.projCustomLabsPanel.style.display = "none";
    return;
  }
  el.projCustomLabsPanel.style.display = "";
  if (!el.projCustomLabsList) return;
  el.projCustomLabsList.innerHTML = projectCustomLabs.map(cl => `
    <div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(0,0,0,.06)">
      <span style="flex:1">${escapeHtml(cl.name)}${cl.unit ? " <span style='color:var(--muted)'>" + escapeHtml(cl.unit) + "</span>" : ""}</span>
      <button class="btn small" style="font-size:11px;padding:2px 7px;background:#fee2e2;color:#b91c1c;border:none"
        data-project-capability="can_write" data-delete-custom-lab="${escapeHtml(cl.id)}">删除</button>
    </div>`).join("");
  applyProjectAccess();
}

async function deleteProjectCustomLab(id){
  if(!requireProjectCapability('can_write'))return;
  if (!confirm("确认从本项目目录中删除此自定义化验？已录入的历史记录不受影响。")) return;
  const { error } = await sb.from("project_custom_labs").delete().eq("id", id);
  if (error){ toast("删除失败：" + registryErrorMessage(error)); return; }
  toast("已删除");
  await loadProjectCustomLabs();
}

function updateLabUnits(){
  const code = el.labTestCode?.value;
  if (!el.labUnit) return;

  const isCustom = code === "CUSTOM";
  const isProjCustom = code?.startsWith("PROJ:");

  // Toggle custom inputs
  const showCustomInputs = isCustom;
  if (el.labCustomName) el.labCustomName.style.display = showCustomInputs ? "" : "none";
  if (el.labCustomUnit) el.labCustomUnit.style.display = showCustomInputs ? "" : "none";
  if (el.labUnit) el.labUnit.style.display = (showCustomInputs || isProjCustom) ? "none" : "";
  if (el.labStdValue) el.labStdValue.closest(".col").style.display = (showCustomInputs || isProjCustom) ? "none" : "";

  if (!code){
    el.labUnit.innerHTML = '<option value="">-- 先选化验项目 --</option>';
    if (el.labStdValue) el.labStdValue.value = "";
    if (el.labHint) el.labHint.textContent = "";
    return;
  }
  if (isCustom){
    if (el.labHint) el.labHint.textContent = "新自定义化验：录入后自动保存到本项目目录，同项目后续患者可直接选用。";
    return;
  }
  if (isProjCustom){
    const clId = code.slice(5);
    const cl = projectCustomLabs.find(c => c.id === clId);
    if (el.labHint) el.labHint.textContent = cl ? `项目自定义化验：${cl.name}，单位：${cl.unit || "无"}` : "";
    if (el.labName) el.labName.value = cl?.name || "";
    return;
  }
  const units = unitMap[code] || [];
  // 单位来自数据库目录：用 DOM 属性与 textContent 生成选项，不拼接 HTML。
  el.labUnit.replaceChildren(...units.map(u => {
    const option = document.createElement("option");
    option.value = String(u.unit_symbol ?? "");
    option.textContent = `${u.unit_symbol ?? ""}${u.is_standard ? "（标准单位）" : ""}`;
    option.selected = !!u.is_standard;
    return option;
  }));

  // Show catalog display note as hint
  const cat = labCatalog.find(c => c.code === code);
  if (el.labHint && cat?.display_note) el.labHint.textContent = cat.display_note;
  if (el.labName) el.labName.value = code;
  updateLabStdValue();
}

function updateLabStdValue(){
  const code = el.labTestCode?.value;
  const rawVal = parseFloat(el.labValue?.value);
  const unit = el.labUnit?.value;
  if (!el.labStdValue) return;
  if (!code || isNaN(rawVal) || !unit){
    el.labStdValue.value = "";
    return;
  }
  const unitRow = (unitMap[code] || []).find(u => u.unit_symbol === unit);
  if (!unitRow){ el.labStdValue.value = "单位不支持"; return; }
  const cat = labCatalog.find(c => c.code === code);
  const std = (rawVal * unitRow.multiplier).toFixed(4);
  el.labStdValue.value = `${std} ${cat?.standard_unit || ""}`;
}

async function loadAll(){
  const identity=captureIdentity();await loadProjects();if(!sameIdentity(identity))return;
  // auto select first project
  if (!selectedProject && projects.length){
    selectProject(projects[0].id);
  } else if (selectedProject){
    const op=captureContext();try{await loadProjectAccess(op);projectMembersController?.setContext({projectId:op.project.id,projectName:op.project.name,userId:op.userId,access:projectAccess});await refreshFollowup(op);}catch(e){if(currentContext(op)){projectAccess=null;clearProjectWorkspace();applyProjectAccess();toast(registryErrorMessage(e));}}
  }
}

async function loadProjects(){
  const identity=captureIdentity();
  const { data, error } = await sb.from("projects").select("*").order("created_at", {ascending:false});
  if(!sameIdentity(identity))return;
  if (error){ toast("读取项目失败：" + registryErrorMessage(error)); return; }
  projects = data || [];
  if(selectedProject){const current=projects.find(p=>p.id===selectedProject.id);if(!current){projectEpoch++;projectAccess=null;selectedProject=null;projectMembersController?.clear();clearProjectWorkspace();applyProjectAccess();}else selectedProject=current;}
  renderProjects();
}

function renderProjects(){
  el.projectsList.innerHTML = "";

  if (projects.length === 0){
    // Empty state — invite user to create a project or load a practice project
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:10px;padding:14px;border:1.5px dashed rgba(37,99,235,.3);border-radius:14px;background:rgba(37,99,235,.04);";
    hint.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;">还没有项目</div>
      <div class="muted small" style="margin-bottom:10px;">
        请在下方“新建项目”中创建研究项目；也可以先加载一个只含模拟数据的演示项目练习录入与导出。
      </div>
      <button class="btn small" id="btnSeedDemo">加载 IgAN 演示项目（8 位模拟患者）</button>`;
    el.projectsList.appendChild(hint);
    hint.querySelector("#btnSeedDemo").addEventListener("click", seedDemoData);
    if (el.newProjectDetails) el.newProjectDetails.open = true;
  } else {
    projects.forEach(p=>{
      const b = document.createElement("button");
      b.className = "pill" + (selectedProject?.id === p.id ? " active" : "");
      b.textContent = `${p.center_code} · ${p.name}`;
      b.addEventListener("click", ()=>selectProject(p.id));
      el.projectsList.appendChild(b);
    });
  }

  renderProjectMeta();
}

function renderProjectMeta(){
  if (!selectedProject){
    el.projectMeta.innerHTML = "<div class='muted small'>尚未选择项目</div>";
    renderTrialBadge(null);
    showIganPathBox();
    renderOverview();
    renderBoard();
    return;
  }
  const p = selectedProject;
  const shown = v => v ? escapeHtml(v) : '<span class="muted">未设置</span>';
  el.projectMeta.innerHTML = `
    <div>项目</div><div><b>${escapeHtml(p.name)}</b></div>
    <div>中心代码</div><div><code>${escapeHtml(p.center_code)}</code></div>
    <div>病种模块</div><div><code>${escapeHtml(p.module)}</code></div>
    <div>随访间隔</div><div>${p.followup_interval_days ? escapeHtml(p.followup_interval_days) + ' 天' : '<span class="muted">按数据库默认值</span>'}</div>
    <div>对患者显示的研究名称</div><div>${shown(p.public_title)}</div>
    <div>机构名称</div><div>${shown(p.institution_name)}</div>
    <div>伦理批件号</div><div>${shown(p.ethics_approval_no)}</div>
    <div>研究团队联系方式</div><div>${shown(p.contact_display)}</div>
    <div>账户权益</div><div>请查看页面顶部的实时账户状态。</div>
  `;
  renderTrialBadge(p);
  showIganPathBox();
  renderProjectSettings();
}

function renderProjectSettings(){
  if(!el.setInterval)return;
  const p=selectedProject;
  el.setInterval.value=p?.followup_interval_days??'';
  el.setPublicTitle.value=p?.public_title??'';
  el.setInstitution.value=p?.institution_name??'';
  el.setEthicsNo.value=p?.ethics_approval_no??'';
  el.setContact.value=p?.contact_display??'';
  if(el.settingsFeedback)el.settingsFeedback.replaceChildren();
}

function showSettingsFeedback(text,tone='error'){
  const fb=el.settingsFeedback;if(!fb)return;
  fb.dataset.tone=tone;fb.setAttribute('role',tone==='error'?'alert':'status');fb.textContent=text;
}

async function saveProjectSettings(){
  if(!requireProjectCapability('can_manage_project'))return;
  const op=captureContext();
  const interval=Number(String(el.setInterval.value).trim());
  if(!Number.isInteger(interval)||interval<7||interval>730){showSettingsFeedback('随访间隔须为 7–730 天的整数。');el.setInterval.focus();return;}
  const values={followup_interval_days:interval,public_title:el.setPublicTitle.value.trim()||null,institution_name:el.setInstitution.value.trim()||null,ethics_approval_no:el.setEthicsNo.value.trim()||null,contact_display:el.setContact.value.trim()||null};
  const limits={public_title:['对患者显示的研究名称',120],institution_name:['机构名称',120],ethics_approval_no:['伦理批件号',80],contact_display:['研究团队联系方式',120]};
  for(const [key,[label,max]]of Object.entries(limits))if(values[key]&&values[key].length>max){showSettingsFeedback(`${label}最多 ${max} 字。`);return;}
  const changes={};
  for(const [key,value]of Object.entries(values)){const old=op.project[key]??null;if(value!==(key==='followup_interval_days'&&old!=null?Number(old):old))changes[key]=value;}
  if(!Object.keys(changes).length){showSettingsFeedback('没有修改。','info');return;}
  if('followup_interval_days'in changes&&!confirm(`将随访间隔改为 ${interval} 天？所有患者的“下次应随访日期”和逾期状态会按新间隔重新计算。`))return;
  setBusy(el.btnSaveSettings,true);
  try{
    const {data,error}=await sb.rpc('set_project_settings',{p_project_id:op.project.id,p_settings:changes});
    if(error)throw error;assertContext(op);
    const saved={};for(const key of Object.keys(values))if(data&&key in data)saved[key]=data[key];
    selectedProject={...selectedProject,...saved};projects=projects.map(p=>p.id===selectedProject.id?selectedProject:p);
    renderProjectMeta();showSettingsFeedback('项目设置已保存。','ok');toast('项目设置已保存');
    await refreshFollowup(op);
  }catch(e){if(currentContext(op))showSettingsFeedback('未保存：'+registryErrorMessage(e));}
  finally{setBusy(el.btnSaveSettings,false);}
}

async function selectProject(projectId){
  if(projectId===selectedProject?.id)return;
  if(busyButtons.size)return toast("正在保存或导出，请完成后再切换项目。");
  if(selectedProject && (_importParsed || ['patCode','varPatientCode','labPatientCode','medPatientCode','evtPatientCode'].some(k=>el[k]?.value)) && !confirm("切换项目将清空未保存录入及导入预览，是否继续？"))return;
  projectEpoch++;projectAccess=null;projectMembersController?.clear();clearProjectWorkspace();selectedProject=projects.find(p=>p.id===projectId)||null;
  renderProjects();if(!selectedProject)return;
  const c=captureContext();applyProjectAccess();
  try{await loadProjectAccess(c);}catch(e){if(currentContext(c)){projectAccess=null;applyProjectAccess();qs('#projectAccessStatus').textContent='项目权限读取失败：'+registryErrorMessage(e);}return;}
  projectMembersController?.setContext({projectId:c.project.id,projectName:c.project.name,userId:c.userId,access:projectAccess});
  await Promise.all([refreshFollowup(c),loadProjectCustomLabs(),loadExtras(),loadSnapshots(),loadIssueSummary()]);
  if(currentContext(c)){const label=qs('#currentProjectLabel');if(label)label.textContent=`当前项目：${c.project.name} · ${c.project.center_code}`;}
}

async function createProject(){
  const identity=captureIdentity();
  const name = el.projName.value.trim();
  const center_code = el.projCenter.value.trim();
  const module = el.projModule.value;
  const description = el.projDesc.value.trim() || null;

  if (!name) return toast("请输入项目名称");
  if (!center_code) return toast("请输入中心代码");

  const btn = el.btnCreateProject;
  btn.dataset.label = "创建项目";
  setBusy(btn, true);
  try{
    const { error } = await sb.rpc("create_project", {p_name:name,p_center_code:center_code,p_module:module,p_description:description});
    if (error) throw error;
    if(!sameIdentity(identity))return;
    toast("项目已创建");
    el.projName.value = "";
    el.projDesc.value = "";
    await loadProjects();
    if(!sameIdentity(identity))return;
    // select newest
    if (projects.length) {setBusy(btn,false);await selectProject(projects[0].id);}
  }catch(e){
    console.error(e);
    toast("创建失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn,false);
  }
}

// ─── Demo data seeder ─────────────────────────────────────────────────────────
async function seedDemoData(){
  const btn = document.getElementById("btnSeedDemo");
  if(!confirm("将在当前账号下创建一个只含模拟数据的独立演示项目，并占用一个项目名额。继续？"))return;
  const identity=captureIdentity();
  let createdDemo=null;
  const demoFeedback=qs('#demoSeedFeedback');if(demoFeedback){demoFeedback.textContent='';demoFeedback.style.display='none';}
  setBusy(btn,true);

  try{
    // 1. Create demo project
    const { data: proj, error: pe } = await sb.from("projects")
      .insert({
        name: "IgAN 多中心演示项目（DEMO）",
        center_code: "DEMO01",
        module: "IGAN",
        registry_type: "igan",
        description: "演示数据集，含8位完全模拟患者与随访记录，仅用于练习录入、核对和导出，不用于研究结论。"
      })
      .select()
      .single();
    if (pe) throw pe;
    createdDemo={id:proj.id,name:proj.name||"IgAN 多中心演示项目（DEMO）"};
    if(!sameIdentity(identity))return;
    const pid = proj.id;

    // 2. Patient baselines (realistic IgAN cohort, mix of stable/progressive)
    const patients = [
      { patient_code:"P001", sex:"M", birth_year:1978, baseline_date:"2023-01-15", baseline_scr:105, baseline_upcr:2.1,
        biopsy_date:"2022-12-10", oxford_m:1, oxford_e:0, oxford_s:1, oxford_t:0, oxford_c:0 },
      { patient_code:"P002", sex:"F", birth_year:1985, baseline_date:"2023-01-20", baseline_scr:82,  baseline_upcr:1.2,
        biopsy_date:"2023-01-05", oxford_m:0, oxford_e:0, oxford_s:0, oxford_t:0, oxford_c:0 },
      { patient_code:"P003", sex:"M", birth_year:1972, baseline_date:"2023-02-01", baseline_scr:145, baseline_upcr:3.5,
        biopsy_date:"2023-01-18", oxford_m:1, oxford_e:1, oxford_s:1, oxford_t:1, oxford_c:0 },
      { patient_code:"P004", sex:"F", birth_year:1990, baseline_date:"2023-02-08", baseline_scr:95,  baseline_upcr:2.8,
        biopsy_date:"2023-01-25", oxford_m:1, oxford_e:0, oxford_s:1, oxford_t:0, oxford_c:0 },
      { patient_code:"P005", sex:"M", birth_year:1968, baseline_date:"2023-02-15", baseline_scr:178, baseline_upcr:5.2,
        biopsy_date:"2023-02-01", oxford_m:1, oxford_e:1, oxford_s:1, oxford_t:2, oxford_c:1 },
      { patient_code:"P006", sex:"F", birth_year:1982, baseline_date:"2023-03-01", baseline_scr:88,  baseline_upcr:1.8,
        biopsy_date:"2023-02-15", oxford_m:0, oxford_e:0, oxford_s:1, oxford_t:0, oxford_c:0 },
      { patient_code:"P007", sex:"M", birth_year:1975, baseline_date:"2023-03-10", baseline_scr:132, baseline_upcr:2.5,
        biopsy_date:"2023-02-28", oxford_m:1, oxford_e:0, oxford_s:0, oxford_t:1, oxford_c:0 },
      { patient_code:"P008", sex:"F", birth_year:1993, baseline_date:"2023-03-15", baseline_scr:75,  baseline_upcr:1.5,
        biopsy_date:"2023-03-01", oxford_m:1, oxford_e:1, oxford_s:0, oxford_t:0, oxford_c:0 },
    ].map(p => ({ ...p, project_id: pid, baseline_upcr:p.baseline_upcr*1000, baseline_upcr_unit:"mg/g",baseline_upcr_raw:p.baseline_upcr,baseline_upcr_original_unit:"g/g" }));

    const { error: bpe } = await sb.from("patients_baseline").insert(patients);
    if (bpe) throw bpe;
    if(!sameIdentity(identity))return;

    // 3. Fully synthetic visits satisfy all core field requirements. P007 lacks the last planned time point for follow-up review practice; this does not guarantee a QC issue.
    const visits = [
      // P001 – stable, responds to treatment
      { patient_code:"P001", visit_date:"2023-01-15", sbp:138, dbp:88, scr_umol_l:105, upcr:2.1 },
      { patient_code:"P001", visit_date:"2023-04-15", sbp:135, dbp:85, scr_umol_l:103, upcr:1.8 },
      { patient_code:"P001", visit_date:"2023-07-15", sbp:128, dbp:82, scr_umol_l:98,  upcr:0.9 },
      { patient_code:"P001", visit_date:"2024-01-15", sbp:125, dbp:80, scr_umol_l:96,  upcr:0.5 },
      // P002 – mild, full remission
      { patient_code:"P002", visit_date:"2023-01-20", sbp:120, dbp:76, scr_umol_l:82,  upcr:1.2 },
      { patient_code:"P002", visit_date:"2023-04-20", sbp:118, dbp:74, scr_umol_l:80,  upcr:0.8 },
      { patient_code:"P002", visit_date:"2023-07-20", sbp:116, dbp:73, scr_umol_l:78,  upcr:0.5 },
      { patient_code:"P002", visit_date:"2024-01-20", sbp:115, dbp:72, scr_umol_l:79,  upcr:0.4 },
      // P003 – synthetic increasing creatinine pattern
      { patient_code:"P003", visit_date:"2023-02-01", sbp:155, dbp:98, scr_umol_l:145, upcr:3.5 },
      { patient_code:"P003", visit_date:"2023-05-01", sbp:158, dbp:100, scr_umol_l:162, upcr:4.2 },
      { patient_code:"P003", visit_date:"2023-08-01", sbp:162, dbp:102, scr_umol_l:198, upcr:5.8 },
      { patient_code:"P003", visit_date:"2024-02-01", sbp:165, dbp:104, scr_umol_l:234, upcr:7.6 },
      // P004 – partial response
      { patient_code:"P004", visit_date:"2023-02-08", sbp:132, dbp:84, scr_umol_l:95,  upcr:2.8 },
      { patient_code:"P004", visit_date:"2023-05-08", sbp:128, dbp:82, scr_umol_l:92,  upcr:2.0 },
      { patient_code:"P004", visit_date:"2023-08-08", sbp:124, dbp:80, scr_umol_l:90,  upcr:1.5 },
      { patient_code:"P004", visit_date:"2024-02-08", sbp:122, dbp:78, scr_umol_l:88,  upcr:1.2 },
      // P005 – rapid progressive (high risk: M1E1S1T2C1)
      { patient_code:"P005", visit_date:"2023-02-15", sbp:162, dbp:104, scr_umol_l:178, upcr:5.2 },
      { patient_code:"P005", visit_date:"2023-05-15", sbp:165, dbp:106, scr_umol_l:210, upcr:6.8 },
      { patient_code:"P005", visit_date:"2023-08-15", sbp:168, dbp:108, scr_umol_l:265, upcr:9.2 },
      { patient_code:"P005", visit_date:"2024-02-15", sbp:170, dbp:110, scr_umol_l:342, upcr:12.5 },
      // P006 – good response, near complete remission
      { patient_code:"P006", visit_date:"2023-03-01", sbp:125, dbp:80, scr_umol_l:88,  upcr:1.8 },
      { patient_code:"P006", visit_date:"2023-06-01", sbp:120, dbp:78, scr_umol_l:86,  upcr:0.9 },
      { patient_code:"P006", visit_date:"2023-09-01", sbp:118, dbp:76, scr_umol_l:84,  upcr:0.5 },
      { patient_code:"P006", visit_date:"2024-03-01", sbp:116, dbp:74, scr_umol_l:83,  upcr:0.4 },
      // P007 – one planned follow-up time point absent; review against the study schedule
      { patient_code:"P007", visit_date:"2023-03-10", sbp:142, dbp:90, scr_umol_l:132, upcr:2.5 },
      { patient_code:"P007", visit_date:"2023-06-10", sbp:140, dbp:88, scr_umol_l:130, upcr:2.2 },
      { patient_code:"P007", visit_date:"2023-09-10", sbp:138, dbp:86, scr_umol_l:128, upcr:2.0 },
      // P008 – all core measurements supplied
      { patient_code:"P008", visit_date:"2023-03-15", sbp:118, dbp:74, scr_umol_l:75,  upcr:1.5 },
      { patient_code:"P008", visit_date:"2023-06-15", sbp:116, dbp:72, scr_umol_l:76, upcr:1.2 },
      { patient_code:"P008", visit_date:"2023-09-15", sbp:115, dbp:71, scr_umol_l:74,  upcr:0.8 },
      { patient_code:"P008", visit_date:"2024-03-15", sbp:114, dbp:70, scr_umol_l:73,  upcr:0.6 },
    ].map(v => ({ ...v, project_id: pid,upcr:v.upcr*1000 }));

    const { error: ve } = await sb.from("visits_long").insert(visits);
    if (ve) throw ve;
    if(!sameIdentity(identity))return;

    toast("演示项目已创建：8 位模拟患者、31 次随访（仅用于练习，不用于研究结论）");
    await loadProjects();
    if(!sameIdentity(identity))return;
    setBusy(btn,false);await selectProject(pid);

  }catch(e){
    console.error(e);
    if(!sameIdentity(identity))return;
    if(createdDemo){
      await loadProjects();if(!sameIdentity(identity))return;
      const detail=`演示项目“${createdDemo.name}”（ID：${createdDemo.id}）已创建，但加载未完成，可能已有部分模拟数据。请从项目列表打开核对，避免再次点击而新建重复项目。原因：${registryErrorMessage(e)}`;
      toast(detail);
      const hint=qs('#demoSeedFeedback');if(hint){hint.textContent=detail;hint.style.display='block';}
    }else toast("演示项目创建失败，未确认创建成功：" + registryErrorMessage(e));
    if (btn){ btn.disabled = false; btn.textContent = "加载 IgAN 演示项目（8 位模拟患者）"; }
  }finally{setBusy(btn,false);}
}
// ──────────────────────────────────────────────────────────────────────────────

// ── 项目概览与随访看板（v_project_overview / v_patient_followup_status，按调用者权限读取） ──
// 看板按 patient_id 键集分页读取（每页 500 行，不逐页计数）；保存随访、修改研究状态、生成或撤销链接后
// 只重新读取该患者一行和项目概览，不再全量重读看板。
const BOARD_PAGE_SIZE=500;
let boardLoad=null;              // 正在进行的全量读取：{touched:Set<研究编号>}
const rowRefreshSeq=new Map();   // 研究编号 → 最近一次单行读取的序号（丢弃较早发出、较晚返回的结果）
async function loadBoard(op=captureContext()){
  const load={touched:new Set()};boardLoad=load;
  try{
    const rows=await readKeysetRows(sb,'v_patient_followup_status',op.project.id,{key:'patient_id',pageSize:BOARD_PAGE_SIZE,assertCurrent:()=>assertContext(op)});
    assertContext(op);if(boardLoad!==load)return;boardLoad=null;
    patients=sortBoardRows(rows).map(r=>({...r,id:r.patient_id}));patientsLoaded=true;
    renderBoard();renderPatientCodeOptions();
    if(el.newPatientDetails&&!patients.length)el.newPatientDetails.open=true;
    // 全量读取期间单独刷新过的患者：全量结果可能早于那次保存，再读一次这些行。
    for(const code of load.touched)refreshPatientRow(op,code);
  }catch(e){
    if(boardLoad===load)boardLoad=null;
    if(!currentContext(op))return;
    patients=[];patientsLoaded=false;
    if(el.boardFilters)el.boardFilters.replaceChildren();
    if(el.patientsList)el.patientsList.textContent='随访看板读取失败：'+registryErrorMessage(e);
  }
}

/** 只重新读取一位患者的看板行（按项目 + 研究编号），替换、加入或移除该行。 */
async function refreshPatientRow(op,code){
  if(!code)return;
  if(boardLoad)boardLoad.touched.add(code);
  const seq=(rowRefreshSeq.get(code)||0)+1;rowRefreshSeq.set(code,seq);
  try{
    const {data,error}=await sb.from('v_patient_followup_status').select('*').eq('project_id',op.project.id).eq('patient_code',code).maybeSingle();
    if(!currentContext(op)||rowRefreshSeq.get(code)!==seq)return;
    if(error)throw error;
    if(!patientsLoaded)return; // 全量读取尚未完成，结果会包含该患者
    const index=patients.findIndex(p=>p.patient_code===code);
    if(data){const row={...data,id:data.patient_id};if(index>=0)patients[index]=row;else patients.push(row);}
    else if(index>=0)patients.splice(index,1);
    patients=sortBoardRows(patients);
    renderBoard();if(index<0||!data)renderPatientCodeOptions();
  }catch(e){if(currentContext(op))toast('该患者的看板状态刷新失败，请稍后刷新页面核对：'+registryErrorMessage(e));}
}

// 概览是全项目汇总：连续保存时只保留一次在途读取，结束后如有新的保存再读一次。
let overviewLoad=null;
async function loadOverview(op=captureContext()){
  if(overviewLoad&&overviewLoad.projectEpoch===op.projectEpoch&&overviewLoad.sessionEpoch===op.sessionEpoch){overviewLoad.again=true;return overviewLoad.promise;}
  const load={projectEpoch:op.projectEpoch,sessionEpoch:op.sessionEpoch,again:false};overviewLoad=load;
  load.promise=(async()=>{
    try{
      do{
        load.again=false;
        const {data,error}=await sb.from('v_project_overview').select('*').eq('project_id',op.project.id).maybeSingle();
        if(!currentContext(op))return;if(error)throw error;
        projectOverview=data||null;renderOverview();
      }while(load.again);
    }catch(e){if(currentContext(op)&&el.projectOverview)el.projectOverview.textContent='项目概览读取失败：'+registryErrorMessage(e);}
    finally{if(overviewLoad===load)overviewLoad=null;}
  })();
  return load.promise;
}

async function refreshFollowup(op=captureContext()){await Promise.all([loadBoard(op),loadOverview(op)]);}

function onFollowupSaved(kind,{patientCode}={}){
  if(!selectedProject)return;
  const op=captureContext(),jobs=[loadOverview(op),patientCode?refreshPatientRow(op,patientCode):loadBoard(op)];
  if(kind==='visit')jobs.push(loadIssueSummary());
  Promise.all(jobs).catch(()=>{});
}

function renderOverview(){
  if(!el.projectOverview)return;
  if(!selectedProject){el.projectOverview.innerHTML='<p class="muted small">请先选择或创建项目。</p>';return;}
  el.projectOverview.innerHTML=projectOverview?renderOverviewHtml(projectOverview):'<p class="muted small">暂无概览数据。</p>';
}

function renderBoard(){
  if(!el.patientsList)return;
  if(!selectedProject){el.patientsList.innerHTML="<p class='muted small'>请先选择或创建项目。</p>";el.boardFilters?.replaceChildren();return;}
  if(!patientsLoaded){el.patientsList.innerHTML="<p class='muted small'>正在读取随访看板…</p>";return;}
  if(el.boardFilters){
    const hadFocus=el.boardFilters.contains(document.activeElement)?document.activeElement.dataset.boardFilter??'select':null;
    el.boardFilters.innerHTML=patients.length?renderFilterBar(patients,boardView):'';
    if(hadFocus)(hadFocus==='select'?qs('[data-consent-select]',el.boardFilters):qs(`[data-board-filter="${hadFocus}"]`,el.boardFilters))?.focus();
  }
  // 勾选只用于批量修改，需要录入权限；看板重读后不在本项目中的编号自动取消勾选。
  const selectable=canProject('can_write');
  if(!selectable)boardSelected.clear();
  else{const known=new Set(patients.map(p=>p.patient_code));for(const code of [...boardSelected])if(!known.has(code))boardSelected.delete(code);}
  const result=renderBoardHtml(patients,{...boardView,showLinks:canRevokeTokens(),selectable,selected:boardSelected});
  el.patientsList.innerHTML=result.html;boardVisibleCodes=result.visibleCodes||[];
  renderBulkBar();
  applyProjectAccess();
}

function selectedBoardCodes(){return [...boardSelected];}
function clearBoardSelection(){boardSelected.clear();boardVisibleCodes=[];renderBulkBar();}
function renderBulkBar(){
  const bar=qs('#boardBulkBar');if(!bar)return;
  const n=boardSelected.size;bar.hidden=n===0||!selectedProject;
  const visible=new Set(boardVisibleCodes),hidden=[...boardSelected].filter(c=>!visible.has(c)).length;
  const status=qs('#boardSelectionStatus');
  if(status)status.textContent=`已选择 ${n} 位患者${hidden?`（其中 ${hidden} 位不在当前显示的列表中）`:''}${n>500?'；每次最多处理 500 位，请减少勾选':''}`;
}
/** 勾选或取消一位患者、全选或取消本页显示的患者；只更新勾选状态，不重绘表格。 */
function onBoardSelect(e){
  const box=e.target;if(!(box instanceof HTMLInputElement)||box.type!=='checkbox'||!el.patientsList.contains(box))return;
  if(box.matches('[data-select-all]')){for(const code of boardVisibleCodes){if(box.checked)boardSelected.add(code);else boardSelected.delete(code);}}
  else if(box.dataset.selectCode!=null){if(box.checked)boardSelected.add(box.dataset.selectCode);else boardSelected.delete(box.dataset.selectCode);}
  else return;
  el.patientsList.querySelectorAll('input[data-select-code]').forEach(input=>{const on=boardSelected.has(input.dataset.selectCode);input.checked=on;const tr=input.closest('tr');if(tr){if(on)tr.dataset.selected='1';else delete tr.dataset.selected;}});
  const all=el.patientsList.querySelector('input[data-select-all]');if(all)all.checked=boardVisibleCodes.length>0&&boardVisibleCodes.every(c=>boardSelected.has(c));
  renderBulkBar();
}

function renderPatientCodeOptions(){
  if(!el.patientCodeOptions)return;
  el.patientCodeOptions.replaceChildren(...patients.map(p=>{const o=document.createElement('option');o.value=p.patient_code;return o;}));
}

function onBoardClick(e){
  const b=e.target.closest('button[data-act]');if(!b||!el.patientsList.contains(b)||b.disabled)return;
  const code=b.dataset.code;
  if(b.dataset.act==='visit')followupDialogs.openVisitEntry(code);
  else if(b.dataset.act==='history')openVisitHistory(code);
  else if(b.dataset.act==='links')followupDialogs.openLinks(code);
  else if(b.dataset.act==='status')followupDialogs.openStudyStatus(code);
  else if(b.dataset.act==='edit')openRecordEditor('patients_baseline',b.dataset.id);
  else if(b.dataset.act==='more'){boardView.limit+=100;renderBoard();}
}

function onOverviewClick(e){
  const t=e.target.closest('button.fu-tile');if(!t)return;
  if(t.dataset.overviewAction==='issues'){qs('#issuePanel')?.scrollIntoView({block:'start'});loadIssues();return;}
  Object.assign(boardView,{state:t.dataset.boardFilter||'all',consent:t.dataset.consentFilter||'all',search:'',limit:100});
  if(el.patientSearch)el.patientSearch.value='';
  renderBoard();
  qs('#boardSection')?.scrollIntoView({block:'start'});
}

async function loadExtras(){
  if (!selectedProject){
    if (el.variantsPreview) el.variantsPreview.textContent = "";
    if (el.labsPreview) el.labsPreview.textContent = "";
    if (el.medsPreview) el.medsPreview.textContent = "";
    if (el.eventsPreview) el.eventsPreview.textContent = "暂无记录";
    return;
  }
  const op=captureContext();
  const pid = op.project.id;
  try{
    const [varsRes, labsRes, medsRes, evtsRes] = await Promise.all([
      GENETICS_ENABLED ? sb.from("variants_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10) : Promise.resolve({data:[],error:null}),
      sb.from("labs_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10),
      sb.from("meds_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10),
      sb.from("events_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(20),
    ]);
    if (varsRes.error) throw varsRes.error;
    if (labsRes.error) throw labsRes.error;
    if (medsRes.error) throw medsRes.error;
    // Discard if user switched project while loading
    if (!currentContext(op)) return;
    // events_long may not exist yet — ignore error gracefully
    renderVariantsPreview(varsRes.data || []);
    renderLabsPreview(labsRes.data || []);
    renderMedsPreview(medsRes.data || []);
    if(evtsRes.error)el.eventsPreview.textContent="终点事件读取失败，请重试："+registryErrorMessage(evtsRes.error);else renderEventsPreview(evtsRes.data||[]);
  }catch(e){
    console.error(e);
    if(selectedProject?.id===pid)[el.variantsPreview,el.labsPreview,el.medsPreview,el.eventsPreview].forEach(n=>{if(n)n.textContent="读取失败，请重新选择项目或刷新。";});
  }
}

// ── 通用删除函数（化验 / 用药 / 基因 / 事件）────────────────────────────────
async function deleteRecord(table, id){
  if(!requireProjectCapability('can_write'))return;
  if(!selectedProject||!['variants_long','meds_long','events_long'].includes(table))return;
  const op=captureContext();if(busyButtons.size)return toast('正在保存，请稍候');
  if (!confirm(`确认删除项目 ${op.project.name} 的这条记录？请先核对原始记录。操作不可撤销。`)) return;
  const marker={dataset:{},textContent:'删除记录'};setBusy(marker,true);
  try{const {error}=await sb.from(table).delete().eq('id',id).eq('project_id',op.project.id);if(error)throw error;assertContext(op);toast('已删除');await loadExtras();}
  catch(e){toast('删除失败：'+registryErrorMessage(e));}finally{setBusy(marker,false);}
}


function renderVariantsPreview(rows){
  if (!el.variantsPreview) return;
  if (!rows.length){
    el.variantsPreview.innerHTML = "暂无记录（仅影响科研分析时的基因分层/描述）";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code??"")}</b></td>
      <td>${escapeHtml(r.test_date??"")}</td>
      <td>${escapeHtml(r.gene??"")}</td>
      <td class="muted small">${escapeHtml((r.variant||r.hgvs_c||"").slice(0,28))}</td>
      <td>${escapeHtml(r.classification??"")}</td>
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" data-delete-table="variants_long" data-record-id="${escapeHtml(r.id??"")}">删除</button></td>
    </tr>
  `).join("");
  el.variantsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>日期</th><th>基因</th><th>变异</th><th>ACMG分级</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
  applyProjectAccess();
}

function renderLabsPreview(rows){
  if (!el.labsPreview) return;
  if (!rows.length){
    el.labsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code??"")}</b></td>
      <td>${escapeHtml(r.lab_date??"")}</td>
      <td>${escapeHtml(r.lab_name||r.lab_test_code||"")}</td>
      <td>${escapeHtml(r.lab_value!=null ? String(r.lab_value) : (r.value_raw!=null ? String(r.value_raw) : ""))}</td>
      <td>${escapeHtml(r.lab_unit||r.unit_symbol||"")}</td>
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" data-edit-table="labs_long" data-record-id="${escapeHtml(r.id??"")}">核对 / 更正</button></td>
    </tr>
  `).join("");
  el.labsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>日期</th><th>项目</th><th>数值</th><th>单位</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
  applyProjectAccess();
}

function renderMedsPreview(rows){
  if (!el.medsPreview) return;
  if (!rows.length){
    el.medsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code??"")}</b></td>
      <td>${escapeHtml(r.drug_name??"")}</td>
      <td class="muted small">${escapeHtml([r.dose_value!=null?`${r.dose_value} ${r.dose_unit||""}`.trim():r.dose,r.frequency,r.route].filter(Boolean).join(" "))}</td>
      <td>${escapeHtml(r.start_date??"")}</td>
      <td>${escapeHtml(r.end_date??"")}</td>
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" data-delete-table="meds_long" data-record-id="${escapeHtml(r.id??"")}">删除</button></td>
    </tr>
  `).join("");
  el.medsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>药品</th><th>剂量</th><th>开始</th><th>结束</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
  applyProjectAccess();
}


const EVENT_TYPE_LABELS={egfr_decline_40pct:'eGFR 下降 ≥40%',egfr_decline_57pct:'eGFR 下降 ≥57%',complete_remission:'完全缓解',partial_remission:'部分缓解',...IMPORTABLE_EVENTS};
const EVENT_SOURCE_LABELS={manual:'手动录入',derived:'脚本推导',import:'批量导入'};
function renderEventsPreview(rows){
  if (!el.eventsPreview) return;
  if (!rows.length){
    el.eventsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code??"")}</b></td>
      <td>${escapeHtml(EVENT_TYPE_LABELS[r.event_type]||r.event_type||"")}</td>
      <td>${escapeHtml(r.event_date??"")}</td>
      <td>${escapeHtml(EVENT_SOURCE_LABELS[r.source||"manual"]||"其他来源")}${r.evidence_source?` · ${escapeHtml(EVIDENCE_SOURCES[r.evidence_source]||"其他")}`:""}</td>
      <td class="muted small">${escapeHtml(String(r.event_detail||r.notes||"").slice(0,30))}</td>
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" data-delete-table="events_long" data-record-id="${escapeHtml(r.id??"")}">删除</button></td>
    </tr>
  `).join("");
  el.eventsPreview.innerHTML = `
    <div class="muted small">最近 20 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>事件类型</th><th>日期</th><th>来源 · 判定依据</th><th>细节 / 备注</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
  applyProjectAccess();
}

async function createPatientBaseline(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.patCode.value.trim();
  if (!patient_code) return toast("请输入研究编号");

  const birth_year = el.patBirthYear.value ? Number(el.patBirthYear.value) : null;
  if (birth_year !== null){
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(birth_year) || birth_year < 1900 || birth_year > thisYear){
      return toast(`出生年份无效（应为 1900–${thisYear}）`);
    }
  }

  let scr,upcr,baselineDate;
  // 与数据库约束一致：基线血肌酐 10–5000 μmol/L；按 mg/dL 填写时先换算。
  try{scr=creatinineUmol(el.patBaselineScr.value,el.patBaselineScrUnit?.value||'umol','基线血肌酐');upcr=normalizeUpcr(el.patBaselineUpcr.value,el.patBaselineUpcrUnit.value);baselineDate=strictDate(el.patBaselineDate.value,'基线日期');assertNoPII(patient_code,'研究编号');}catch(e){if(/血肌酐/.test(e.message))el.patBaselineScr?.focus();return toast(e.message);}
  if(!baselineDate)return toast("请填写基线日期");
  const scrNote=scr!=null&&el.patBaselineScrUnit?.value==='mgdl'?`（由 ${el.patBaselineScr.value} mg/dL 换算）`:'';
  if(!confirm(`确认保存患者 ${patient_code} 到 ${op.project.name}？\n基线日期：${baselineDate}；血肌酐：${scr??'未填'} μmol/L${scrNote}；UPCR：${upcr??'未填'} mg/g`))return;
  const payload = {
    project_id: op.project.id,
    patient_code,
    sex: el.patSex.value || null,
    birth_year,
    baseline_date: baselineDate,
    baseline_scr: scr,
    baseline_upcr: upcr,
    baseline_upcr_unit: upcr==null?null:'mg/g',
    baseline_upcr_raw: upcr==null?null:Number(el.patBaselineUpcr.value),
    baseline_upcr_original_unit: upcr==null?null:el.patBaselineUpcrUnit.value,
    treatment_arm: el.rctArm?.value || null,
    randomization_id: el.rctRandomId?.value.trim() || null,
    randomization_date: el.rctDate?.value || null,
  };

  // IgAN MEST-C
  if ((selectedProject.module || "").toUpperCase() === "IGAN"){
    payload.biopsy_date = el.biopsyDate.value || null;
    payload.oxford_m = el.mestM.value !== "" ? Number(el.mestM.value) : null;
    payload.oxford_e = el.mestE.value !== "" ? Number(el.mestE.value) : null;
    payload.oxford_s = el.mestS.value !== "" ? Number(el.mestS.value) : null;
    payload.oxford_t = el.mestT.value !== "" ? Number(el.mestT.value) : null;
    payload.oxford_c = el.mestC.value !== "" ? Number(el.mestC.value) : null;
  }

  // LN ISN/RPS 分型
  if ((selectedProject.module || "").toUpperCase() === "LN"){
    payload.ln_biopsy_date      = el.lnBiopsyDate.value || null;
    payload.ln_class            = el.lnClass.value || null;
    payload.ln_activity_index   = el.lnAI.value !== "" ? Number(el.lnAI.value) : null;
    payload.ln_chronicity_index = el.lnCI.value !== "" ? Number(el.lnCI.value) : null;
    payload.ln_podocytopathy    = el.lnPodocytopathy.value === "true" ? true
                                : el.lnPodocytopathy.value === "false" ? false : null;
  }

  const btn = el.btnCreatePatient;
  btn.dataset.label = "保存基线";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("patients_baseline").insert(payload);
    if (error) throw error;
    if(!currentContext(op))return;
    toast(`已建立 ${patient_code} 的基线；可在随访看板中为其录入随访。表单已清空，可继续录入下一位。`);
    resetBaseline();
    await Promise.all([refreshPatientRow(op,patient_code),loadOverview(op)]);
  }catch(e){
    console.error(e);
    toast("保存失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn,false);
  }
}

async function addVariant(){
  if(!GENETICS_ENABLED)return toast('基因数据录入尚未开启。');
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.varPatientCode?.value.trim();
  if (!patient_code) return toast("请填写研究编号");
  const payload = {
    project_id: op.project.id,
    patient_code,
    test_date: el.varTestDate?.value || null,
    test_name: el.varTestName?.value.trim() || null,
    gene: el.varGene?.value.trim() || null,
    variant: el.varVariant?.value.trim() || null,
    hgvs_c: el.varHgvsC?.value.trim() || null,
    hgvs_p: el.varHgvsP?.value.trim() || null,
    transcript: null,
    zygosity: el.varZygosity?.value.trim() || null,
    classification: el.varClass?.value.trim() || null,
    lab_name: el.varLabName?.value.trim() || null,
    notes: el.varNotes?.value ? el.varNotes.value.slice(0,500) : null
  };
  const btn = el.btnAddVariant;
  btn.dataset.label = "添加基因记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("variants_long").insert(payload);
    if (error) throw error;
    assertContext(op);
    toast("已添加基因记录");
    if (el.varGene) el.varGene.value = "";
    if (el.varVariant) el.varVariant.value = "";
    if (el.varHgvsC) el.varHgvsC.value = "";
    if (el.varHgvsP) el.varHgvsP.value = "";
    if (el.varNotes) el.varNotes.value = "";
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("添加失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn,false);
  }
}

async function addLab(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.labPatientCode?.value.trim();
  if (!patient_code) return toast("请填写患者研究编号");
  const lab_test_code = el.labTestCode?.value;
  if (!lab_test_code) return toast("请从下拉列表选择化验项目");
  const rawVal = el.labValue?.value !== "" ? Number(el.labValue?.value) : null;
  if (rawVal === null || isNaN(rawVal)) return toast("请填写化验数值");

  const isCustom = lab_test_code === "CUSTOM";
  const isProjCustom = lab_test_code?.startsWith("PROJ:");

  const customName = el.labCustomName?.value.trim();
  const customUnit = el.labCustomUnit?.value.trim();
  if (isCustom && !customName) return toast("请填写化验名称");
  if (isCustom && !customUnit) return toast("请填写化验单位");

  const unit = isCustom ? customUnit : el.labUnit?.value;
  if (!isCustom && !isProjCustom && !unit) return toast("请选择单位");

  // 前端 PII 检测
  try { assertNoPII(el.labQcReason?.value || "", "留痕原因"); } catch(e){ return toast(e.message); }

  const btn = el.btnAddLab;
  btn.dataset.label = "添加化验记录";
  setBusy(btn, true);
  try{
    if (isCustom){
      // Save to project_custom_labs catalog first (upsert by name)
      const { error: clErr } = await sb.from("project_custom_labs").upsert({
        project_id: op.project.id,
        name:       customName,
        unit:       customUnit
      }, { onConflict: "project_id,name", ignoreDuplicates: false });
      // Non-fatal if catalog save fails (RLS or duplicate)
      if (clErr) throw clErr;
      assertContext(op);

      // Direct insert to labs_long bypassing catalog
      const { error } = await sb.from("labs_long").insert({
        project_id:   op.project.id,
        patient_code: patient_code,
        lab_date:     el.labDate?.value || null,
        lab_name:     customName,
        lab_value:    String(rawVal),
        lab_unit:     customUnit
      });
      if (error) throw error;
      assertContext(op);
    assertContext(op);
      toast(`已添加自定义化验：${customName} ${rawVal} ${customUnit}`);
      if (el.labCustomName) el.labCustomName.value = "";
      if (el.labCustomUnit) el.labCustomUnit.value = "";
      await loadProjectCustomLabs();
    } else if (isProjCustom){
      // Project custom lab from dropdown
      const clId = lab_test_code.slice(5);
      const cl = projectCustomLabs.find(c => c.id === clId);
      if (!cl) throw new Error("找不到所选自定义化验，请刷新页面重试");
      const { error } = await sb.from("labs_long").insert({
        project_id:   op.project.id,
        patient_code: patient_code,
        lab_date:     el.labDate?.value || null,
        lab_name:     cl.name,
        lab_value:    String(rawVal),
        lab_unit:     cl.unit
      });
      if (error) throw error;
      assertContext(op);
    assertContext(op);
      toast(`已添加化验：${cl.name} ${rawVal} ${cl.unit}`);
    } else {
      const { data, error } = await sb.rpc("upsert_lab_record", {
        p_project_id:    op.project.id,
        p_patient_code:  patient_code,
        p_lab_date:      el.labDate?.value || null,
        p_lab_test_code: lab_test_code,
        p_value_raw:     rawVal,
        p_unit_symbol:   unit,
        p_measured_at:   null,
        p_lab_id:        null
      });
      if (error) throw error;
      assertContext(op);
    assertContext(op);

      // If qc_reason was filled, update it on the record
      const reason = el.labQcReason?.value.trim();
      if (reason && data) {
        const result=await sb.from("labs_long").update({ qc_reason: reason }).eq("id", data);
        if(result.error)throw result.error;assertContext(op);
      }

      const cat = labCatalog.find(c => c.code === lab_test_code);
      toast(`已添加化验记录：${cat?.name_cn || lab_test_code} ${rawVal} ${unit}`);
    }

    el.labTestCode.value = "";
    el.labValue.value = "";
    el.labUnit.innerHTML = '<option value="">-- 先选化验项目 --</option>';
    if (el.labStdValue) el.labStdValue.value = "";
    if (el.labQcReason) el.labQcReason.value = "";
    if (el.labQcReasonCol) el.labQcReasonCol.style.display = "none";
    if (el.labHint) el.labHint.textContent = "";
    updateLabUnits(); // reset custom field visibility
    await loadExtras();
    await loadSnapshots();
    loadIssueSummary();
  }catch(e){
    console.error(e);
    const hint = e?.message || String(e);
    // If duplicate warning from DB, show qc_reason field
    if (!isCustom && (hint.includes("duplicate") || hint.includes("重复") || hint.includes("unit_not_allowed") || hint.includes("单位"))) {
      if (el.labQcReasonCol) el.labQcReasonCol.style.display = "";
    }
    toast("添加失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn, false);
  }
}

async function addMed(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.medPatientCode?.value.trim();
  if (!patient_code) return toast("请填写研究编号");
  const drug_name = el.medName?.value.trim();
  if (!drug_name) return toast("请填写药品名称");
  if ([...drug_name].length > 100) return toast("药品名称最多 100 字");
  // 剂量拆为数值 + 单位（与批量导入一致）；旧的剂量文本列同步写入“数值 单位”，兼容旧导出。
  const doseRaw = el.medDoseValue?.value.trim() || "";
  const doseUnit = el.medDoseUnit?.value.trim() || "";
  let dose_value = null;
  if (doseRaw) { dose_value = Number(doseRaw); if (!Number.isFinite(dose_value) || dose_value <= 0) return toast("剂量数值须为大于 0 的数字"); }
  if ([...doseUnit].length > 20) return toast("剂量单位最多 20 个字符");
  if (!!doseRaw !== !!doseUnit && !confirm("剂量数值与剂量单位只填了其中一项，建议成对填写。仍要保存吗？")) return;
  const start_date = el.medStart?.value || null, end_date = el.medEnd?.value || null;
  const today = beijingToday();
  if ((start_date && start_date > today) || (end_date && end_date > today)) return toast("用药日期不能晚于今天");
  if (start_date && end_date && end_date < start_date) return toast("结束日期不能早于开始日期");
  const indication = el.medIndication?.value.trim() || null;
  const notes = el.medNotes?.value.trim() || null;
  if (indication && [...indication].length > 100) return toast("用药目的最多 100 字");
  if (notes && [...notes].length > 500) return toast("备注最多 500 字");
  try{ if (indication) assertNoPII(indication, "用药目的"); if (notes) assertNoPII(notes, "用药备注"); }catch(e){ return toast(e.message); }
  const payload = {
    project_id: op.project.id,
    patient_code,
    drug_name,
    drug_class: el.medClass?.value || null,
    dose: dose_value != null && doseUnit ? `${dose_value} ${doseUnit}` : null,
    dose_value,
    dose_unit: doseUnit || null,
    route: el.medRoute?.value || null,
    frequency: el.medFrequency?.value || null,
    start_date,
    end_date,
    indication,
    notes
  };
  const btn = el.btnAddMed;
  btn.dataset.label = "添加用药记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("meds_long").insert(payload);
    if (error) throw error;
    assertContext(op);
    toast("已添加用药记录");
    ['medName','medDoseValue','medDoseUnit','medRoute','medFrequency','medIndication','medNotes'].forEach(k=>{ if (el[k]) el[k].value = ""; });
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("添加失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn,false);
  }
}


async function addEvent(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.evtPatientCode?.value.trim();
  if (!patient_code) return toast("请填写研究编号");
  const event_type = el.evtType?.value;
  if (!event_type) return toast("请选择事件类型");
  const evidence_source = el.evtEvidence?.value || "";
  if (!EVIDENCE_SOURCES[evidence_source]) return toast("请选择判定依据来源");
  const event_detail = el.evtDetail?.value.trim() || null;
  if (event_type === "custom" && !event_detail) return toast("事件类型为“其他”时请填写事件细节");
  if (event_detail && [...event_detail].length > 500) return toast("事件细节最多 500 字");
  const event_date = el.evtDate?.value || null;
  if (event_date && event_date > beijingToday()) return toast("事件日期不能晚于今天");
  const payload = {
    project_id: op.project.id,
    patient_code,
    event_type,
    event_date,
    confirmed: true,
    source: "manual",
    evidence_source,
    event_detail,
    notes: el.evtNotes?.value.trim().slice(0, 500) || null,
  };
  try{assertNoPII(payload.notes||'','事件备注');assertNoPII(event_detail||'','事件细节');}catch(e){return toast(e.message);}
  const btn = el.btnAddEvent;
  btn.dataset.label = "录入终点事件";
  setBusy(btn, true);
  try{
    const { error } = await sb.from("events_long").insert(payload);
    if (error) throw error;
    assertContext(op);
    toast(["death","esrd","dialysis_start","kidney_transplant"].includes(event_type) ? "已录入终点事件。如患者研究状态有变化（死亡、肾衰竭等），请到该患者的“研究状态”中登记。" : "已录入终点事件");
    ['evtDate','evtNotes','evtDetail'].forEach(k=>{ if (el[k]) el[k].value = ""; });
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("录入失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn, false);
  }
}


const EXPORT_TABLES={baseline:'patients_baseline',visits:'visits_long',labs:'labs_long',meds:'meds_long',variants:'variants_long',events:'events_long'};
const COMMON_EXPORT_COLUMNS=['id','project_id','center_code','module','patient_code'];
const EXPORT_FIELDS={
patients_baseline:['sex','birth_year','baseline_date','baseline_scr','baseline_upcr','baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit','biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class','ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date','consent_status','consent_date','consent_version','followup_status','followup_status_date','created_at','updated_at'],
visits_long:['visit_date','sbp','dbp','scr_umol_l','upcr','egfr','egfr_formula_version','notes','qc_reason','created_at','updated_at'],
labs_long:['lab_date','lab_test_code','lab_name','value_raw','unit_symbol','value_standard','standard_unit','lab_value','lab_unit','measured_at','qc_reason','created_at','updated_at'],
meds_long:['drug_name','drug_class','dose','route','frequency','start_date','end_date','created_at','updated_at'],
variants_long:['test_date','test_name','gene','variant','hgvs_c','hgvs_p','transcript','zygosity','classification','lab_name','notes','created_at','updated_at'],
events_long:['event_type','event_date','confirmed','source','notes','created_at','updated_at'],
ktx_baseline_ext:['transplant_date','donor_type','induction_therapy','maintenance_immuno','hla_mismatch_count','pra_status','dsa_status','dsa_titer','baseline_creatinine','baseline_egfr','created_at','updated_at'],
ktx_visits_ext:['visit_date','tac_trough','csa_trough','weight_kg','infection_event','rejection_event','biopsy_banff','graft_failure_date','death_date','return_to_dialysis','return_to_dialysis_date','created_at','updated_at']
};

async function exportTable(kind){
  if(kind==='variants'&&!GENETICS_ENABLED)return toast('基因数据导出尚未开启。');
  if(!requireProjectCapability('can_export'))return;
  if(!selectedProject)return toast('请先选择项目');
  const op=captureContext(), table=EXPORT_TABLES[kind];if(!table)return;
  const btn=el['btnExport'+({baseline:'Baseline',visits:'Visits',labs:'Labs',meds:'Meds',variants:'Variants',events:'Events'}[kind])];
  setBusy(btn,true);
  try{
    const data=await readAllRows(sb,table,op.project.id,()=>assertContext(op));
    const rows=data.map(r=>({...r,center_code:op.project.center_code,module:op.project.module}));
    const csv=toCsv(rows,exportColumns(rows,[...COMMON_EXPORT_COLUMNS,...(EXPORT_FIELDS[table]||[])]));
    const filename=`${table}_${op.project.center_code}_${fmtDate(new Date())}.csv`;
    const log=await sb.rpc('log_project_audit',{p_project_id:op.project.id,p_action:'export_csv',p_snapshot_id:null,p_details:{kind,filename,rows:rows.length,complete_count_checked:true}});
    if(log.error)throw new Error('导出留痕记录失败，未下载文件：'+registryErrorMessage(log.error));
    assertContext(op);downloadCsvUtf8Bom(filename,csv);toast(`已导出 ${rows.length} 条记录：${filename}`);
  }catch(e){toast('导出失败：'+registryErrorMessage(e));}finally{setBusy(btn,false);}
}
async function fetchProjectRows(pid,center_code,module,op=captureContext()){
  const tables=Object.values(EXPORT_TABLES);
  if(module==='KTX')tables.push('ktx_baseline_ext','ktx_visits_ext');
  const entries=await Promise.all(tables.map(async t=>[t,(await readAllRows(sb,t,pid,()=>assertContext(op))).map(r=>({...r,center_code,module}))]));
  return Object.fromEntries(entries);
}
function calcQcSummary(rows){
  const missing=Object.fromEntries(['sbp','dbp','scr_umol_l','upcr'].map(k=>[k,rows.filter(r=>r[k]==null||r[k]==='').length]));
  return {n_visits:rows.length,missing,missing_rate_pct:rows.length?Number((rows.filter(r=>Object.keys(missing).some(k=>r[k]==null||r[k]==='')).length/rows.length*100).toFixed(2)):null};
}
async function freezeRegistryExport(op=captureContext()){
  assertContext(op);if(!canProject('can_export'))throw new Error('当前项目角色没有导出权限');const key=op.userId+':'+op.project.id;
  if(!frozenRequests.has(key))frozenRequests.set(key,crypto.randomUUID());
  const {data,error}=await sb.rpc('create_registry_export',{p_project_id:op.project.id,p_request_id:frozenRequests.get(key)});
  if(error)throw error;assertContext(op);
  if(!data?.content_text || !data.content_sha256 || await sha256Text(data.content_text)!==data.content_sha256)throw new Error('冻结版本内容校验失败');
  const content=JSON.parse(data.content_text);if(content.project?.id!==op.project.id)throw new Error('冻结版本项目不匹配');
  return {...data,content,requestKey:key};
}
async function createSnapshotOnly(){
  if(!requireProjectCapability('can_export'))return;
  if(!selectedProject)return toast('请先选择项目');const op=captureContext(),btn=el.btnCreateSnapshot;setBusy(btn,true);
  try{const frozen=await freezeRegistryExport(op);assertContext(op);frozenRequests.delete(frozen.requestKey);
    el.snapshotOut.style.display='block';el.snapshotOut.textContent=`数据快照 ${frozen.snapshot_id} 已冻结，SHA-256 校验值：${frozen.content_sha256}。可从下方列表重新下载相同内容。`;await loadSnapshots();
  }catch(e){toast('冻结失败，可用同一请求重试：'+registryErrorMessage(e));}finally{setBusy(btn,false);}
}
function citationText(id,date){return `Frozen dataset ${id}, created ${String(date||'').slice(0,10)}; verify content with its SHA-256 manifest.`;}
async function downloadFrozenVersion(id){
  if(!requireProjectCapability('can_export'))return;
  const op=captureContext();try{const {data,error}=await sb.rpc('get_registry_export',{p_snapshot_id:id});if(error)throw error;assertContext(op);
    if(!data?.content_text)throw new Error('这是旧的元数据记录，没有可恢复的数据内容');
    if(await sha256Text(data.content_text)!==data.content_sha256)throw new Error('内容校验失败，已停止下载');assertContext(op);
    downloadText(`registry_frozen_${data.snapshot_id}.json`,data.content_text,'application/json;charset=utf-8');
    downloadText(`registry_frozen_${data.snapshot_id}_sha256.txt`,data.content_sha256+`  registry_frozen_${data.snapshot_id}.json\n`);
  }catch(e){toast('下载失败：'+registryErrorMessage(e));}
}
async function lockSnapshot(id){
  toast('旧批次说明不能转换为历史冻结数据。请点击“冻结当前数据版本”生成真实不可变版本。');
}
async function loadSnapshots(){
  if(!selectedProject||!el.snapshotsList)return;if(!canProject('can_export')){el.snapshotsList.textContent='当前角色无导出权限；请联系项目负责人。';return;}const op=captureContext();
  const {data,error}=await sb.rpc('list_project_snapshots',{p_project_id:op.project.id});if(!currentContext(op))return;
  if(error){el.snapshotsList.textContent='数据快照列表读取失败：'+registryErrorMessage(error);return;}
  if(!data?.length){el.snapshotsList.textContent='暂无数据快照。';return;}
  el.snapshotsList.innerHTML=`<p class="muted small">冻结数据版本可重新下载与冻结时完全相同的 JSON 文件；早期元数据记录只有说明与数量。</p><table class="table"><thead><tr><th>快照编号</th><th>日期</th><th>类型</th><th>操作</th></tr></thead><tbody>${data.map(r=>{const frozen=String(r.notes||'').includes('frozen_export_v2');return `<tr><td>${escapeHtml(r.snapshot_id)}</td><td>${escapeHtml(fmtDate(r.created_at))}</td><td>${frozen?'冻结数据版本':'早期元数据记录'}</td><td>${frozen?`<button class="btn small" data-frozen-id="${escapeHtml(r.id)}">下载冻结数据（JSON）</button>`:'没有保存数据内容'}</td></tr>`;}).join('')}</tbody></table>`;
  qsa('[data-frozen-id]',el.snapshotsList).forEach(b=>b.addEventListener('click',()=>downloadFrozenVersion(b.dataset.frozenId)));
}

const SEVERITY_LABEL={critical:'严重',warning:'警告',info:'提示'};
const ISSUE_RECORD_LABELS={visit:'随访',lab:'化验',baseline:'基线',event:'终点事件',medication:'用药'};
let issuePage=0;
async function loadIssueSummary(){
  if(!selectedProject||!el.issueSummary)return;const op=captureContext();
  const {data,error}=await sb.rpc('get_issue_summary',{p_project_id:op.project.id});if(!currentContext(op))return;
  if(error||!data){el.issueSummary.textContent='质控状态读取失败，请刷新重试；当前不能判断是否存在问题。';return;}
  el.issueSummary.textContent=`待处理的数据质控问题 ${Number(data.total_open||0)+Number(data.total_in_prog||0)} 条；已修正 ${data.total_resolved||0} 条；接受不修复 ${data.total_wontfix||0} 条（接受不修复不代表原始数据已更正）。`;
}
async function loadIssues(page=0){
  if(!selectedProject||!el.issueList)return;const op=captureContext();issuePage=Number.isInteger(page)?page:0;const requestedPage=issuePage;
  el.issueList.textContent='正在读取全部质控记录…';
  try{
    const all=await readAllRows(sb,'data_issues',op.project.id,()=>assertContext(op));
    const rows=all.filter(r=>!['RESOLVED','WONT_FIX'].includes(r.status)).sort((a,b)=>({critical:0,warning:1,info:2}[a.severity]-{critical:0,warning:1,info:2}[b.severity])||String(b.created_at).localeCompare(a.created_at));
    if(requestedPage!==issuePage)return;
    if(!rows.length){el.issueList.textContent='当前没有未解决的数据质控问题。仍需按研究方案核对数据来源与单位。';return;}
    const pages=Math.ceil(rows.length/50);issuePage=Math.min(issuePage,pages-1);const visible=rows.slice(issuePage*50,issuePage*50+50);
    el.issueList.innerHTML=`<p>未解决共 ${rows.length} 条，第 ${issuePage+1}/${pages} 页</p><table class="table"><thead><tr><th>等级</th><th>研究编号</th><th>问题与说明</th><th>操作</th></tr></thead><tbody>${visible.map(r=>`<tr><td>${escapeHtml(SEVERITY_LABEL[r.severity]||r.severity)}</td><td>${escapeHtml(r.patient_code)}</td><td title="规则编号：${escapeHtml(r.rule_code)}">${escapeHtml(ISSUE_RECORD_LABELS[r.record_type]||'')}${ISSUE_RECORD_LABELS[r.record_type]?'：':''}${escapeHtml(r.message??'')}</td><td><button class="btn small" data-project-capability="can_write" data-correct-id="${escapeHtml(r.id)}">核对原记录</button><button class="btn small" data-project-capability="can_write" data-wontfix-id="${escapeHtml(r.id)}">接受不修复</button></td></tr>`).join('')}</tbody></table><div class="btnbar"><button class="btn" id="issuePrev" ${issuePage===0?'disabled':''}>上一页</button><button class="btn" id="issueNext" ${issuePage===pages-1?'disabled':''}>下一页</button></div>`;
    applyProjectAccess();
    qs('#issuePrev',el.issueList)?.addEventListener('click',()=>loadIssues(issuePage-1));qs('#issueNext',el.issueList)?.addEventListener('click',()=>loadIssues(issuePage+1));
    qsa('[data-correct-id]',el.issueList).forEach(b=>b.addEventListener('click',async()=>{if(!currentContext(op))return;const r=visible.find(x=>x.id===b.dataset.correctId),table=({visit:'visits_long',lab:'labs_long',baseline:'patients_baseline'})[r.record_type];if(!table)return toast('该记录类型需由负责人按原始资料核对；当前不支持自动更正。');
      let id=r.record_id;if(!id&&table==='patients_baseline'){const p=patients.find(p=>p.patient_code===r.patient_code);id=p?.id;}if(!id)return toast('尚无可更正的原始记录，请先按研究编号补录并重新校验。');await openRecordEditor(table,id);
    }));
    qsa('[data-wontfix-id]',el.issueList).forEach(b=>b.addEventListener('click',async()=>{if(!requireProjectCapability('can_write'))return;const reason=prompt('请说明经核对接受此问题的理由。原始数据不会被自动更正：');if(!reason?.trim())return;
      setBusy(b,true);try{assertContext(op);const {error}=await sb.rpc('close_issue_wont_fix',{p_issue_id:b.dataset.wontfixId,p_resolution:reason.trim()});if(error)throw error;assertContext(op);await Promise.all([loadIssues(issuePage),loadIssueSummary()]);}catch(e){toast('处理失败：'+registryErrorMessage(e));}finally{setBusy(b,false);}
    }));
  }catch(e){if(currentContext(op))el.issueList.textContent='数据质控问题读取失败：'+registryErrorMessage(e);}
}
const EDIT_FIELDS={
  patients_baseline:['sex','birth_year','baseline_date','baseline_scr','baseline_upcr','biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class','ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date'],
  visits_long:['visit_date','sbp','dbp','scr_umol_l','upcr','notes'],
  labs_long:['lab_date','lab_test_code','value_raw','unit_symbol']
};
const EDIT_LABELS={sex:'性别 M/F',birth_year:'出生年份',baseline_date:'基线日期',baseline_scr:'基线肌酐 μmol/L',baseline_upcr:'基线UPCR原始化验值',visit_date:'随访日期',sbp:'收缩压 mmHg',dbp:'舒张压 mmHg',scr_umol_l:'肌酐 μmol/L',upcr:'UPCR mg/g',notes:'备注（不含身份信息）',lab_date:'化验日期',lab_test_code:'化验目录代码',value_raw:'原始化验值',unit_symbol:'原始化验单位',biopsy_date:'肾穿日期',ln_biopsy_date:'LN肾穿日期',ln_class:'LN病理分型',ln_activity_index:'LN活动指数',ln_chronicity_index:'LN慢性指数',ln_podocytopathy:'足细胞病 true/false',treatment_arm:'研究分组',randomization_id:'分组记录编号',randomization_date:'分组日期'};
const EDIT_NUMBERS=new Set(['birth_year','baseline_scr','baseline_upcr','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_activity_index','ln_chronicity_index','sbp','dbp','scr_umol_l','upcr','value_raw']);
// 更正时的数值范围，与数据库约束一致（数据库仍是最终校验）。血肌酐另按 creatinineUmol 检查并提示单位。
const EDIT_LIMITS={birth_year:{integer:true,min:1900,max:new Date().getFullYear()},oxford_m:{integer:true,min:0,max:1},oxford_e:{integer:true,min:0,max:1},oxford_s:{integer:true,min:0,max:1},oxford_t:{integer:true,min:0,max:2},oxford_c:{integer:true,min:0,max:2},ln_activity_index:{min:0,max:24},ln_chronicity_index:{min:0,max:12},sbp:CLINICAL_LIMITS.sbp,dbp:CLINICAL_LIMITS.dbp,upcr:CLINICAL_LIMITS.upcr,baseline_upcr:{min:0}};
async function openVisitHistory(patientCode){
  const op=captureContext();
  try{
    const rows=await readAllRows(sb,'visits_long',op.project.id,()=>assertContext(op),500,{patient_code:patientCode});
    rows.sort((a,b)=>String(b.visit_date).localeCompare(String(a.visit_date)));assertContext(op);
    const overlay=document.createElement('div');overlay.dataset.registryModal='history';overlay.style.cssText='position:fixed;inset:0;background:#102d46aa;z-index:8900;display:grid;place-items:center;padding:16px';
    let page=0;const render=()=>{
      const pages=Math.max(1,Math.ceil(rows.length/30));
      overlay.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="historyTitle" style="background:white;color:#102d46;padding:24px;border-radius:16px;max-width:900px;width:100%;max-height:90vh;overflow:auto"><h2 id="historyTitle">随访记录 · ${escapeHtml(patientCode)}</h2><p>${escapeHtml(op.project.name)} · 共 ${rows.length} 条，第 ${page+1}/${pages} 页。请对照原始资料更正，所有更正均需说明原因。</p><div style="overflow:auto"><table class="table"><thead><tr><th>随访日期</th><th>血压 mmHg</th><th>血肌酐 μmol/L</th><th>UPCR mg/g</th><th>eGFR</th><th title="仅标注系统能确认的经随访链接提交的记录">来源</th><th></th></tr></thead><tbody>${rows.slice(page*30,(page+1)*30).map(r=>`<tr><td>${escapeHtml(r.visit_date)}</td><td>${escapeHtml(r.sbp??'—')}/${escapeHtml(r.dbp??'—')}</td><td>${escapeHtml(r.scr_umol_l??'—')}</td><td>${escapeHtml(r.upcr??'—')}</td><td>${escapeHtml(r.egfr??'—')}</td><td>${r.submitted_via_token_id?'随访链接':'—'}</td><td><button class="btn small" data-project-capability="can_write" data-visit-id="${escapeHtml(r.id)}">核对 / 更正</button></td></tr>`).join('')}</tbody></table></div>${!rows.length?'<p>尚无随访记录。</p>':''}<div class="btnbar"><button class="btn primary" data-project-capability="can_write" data-history-entry>为该患者录入随访</button><button class="btn" data-project-capability="can_write" data-history-baseline>核对 / 更正基线</button><button class="btn" data-history-prev ${page===0?'disabled':''}>上一页</button><button class="btn" data-history-next ${page===pages-1?'disabled':''}>下一页</button><button class="btn" data-history-close>关闭</button></div></section>`;
      overlay.querySelector('[data-history-close]').addEventListener('click',()=>overlay.remove());
      overlay.querySelector('[data-history-entry]').addEventListener('click',()=>{overlay.remove();followupDialogs.openVisitEntry(patientCode);});
      overlay.querySelector('[data-history-baseline]').addEventListener('click',()=>{const id=patients.find(p=>p.patient_code===patientCode)?.patient_id;if(!id)return toast('未找到该患者的基线记录，请刷新看板后重试。');overlay.remove();openRecordEditor('patients_baseline',id);});
      overlay.querySelector('[data-history-prev]').addEventListener('click',()=>{page--;render();applyProjectAccess();});overlay.querySelector('[data-history-next]').addEventListener('click',()=>{page++;render();applyProjectAccess();});
      overlay.querySelectorAll('[data-visit-id]').forEach(b=>b.addEventListener('click',()=>{overlay.remove();openRecordEditor('visits_long',b.dataset.visitId);}));
    };render();document.body.appendChild(overlay);applyProjectAccess();
  }catch(e){toast('随访记录读取失败：'+registryErrorMessage(e));}
}

async function openRecordEditor(table,id){
  if(!requireProjectCapability('can_write'))return;
  if(!EDIT_FIELDS[table]||!selectedProject)return;const op=captureContext();
  if(busyButtons.size)return toast('请先完成当前保存或导出');
  try{
    const {data:record,error}=await sb.from(table).select('*').eq('project_id',op.project.id).eq('id',id).single();if(error)throw error;assertContext(op);
    if(table==='labs_long'&&!record.lab_test_code)return toast('此记录使用旧自定义化验格式。请先联系负责人确认目录映射，不能按标准化化验直接覆盖。');
    const overlay=document.createElement('div');overlay.dataset.registryModal='editor';overlay.style.cssText='position:fixed;inset:0;background:#102d46bb;z-index:9000;display:grid;place-items:center;padding:16px';
    const original={...record};if(table==='patients_baseline'&&record.baseline_upcr_raw!=null)original.baseline_upcr=record.baseline_upcr_raw;
    overlay.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="editTitle" style="background:white;color:#102d46;padding:24px;border-radius:16px;max-width:760px;width:100%;max-height:90vh;overflow:auto"><h2 id="editTitle">核对并更正 · ${escapeHtml(record.patient_code)}</h2><p>${escapeHtml(op.project.name)} · ${escapeHtml(({patients_baseline:'基线记录',visits_long:'随访记录',labs_long:'化验记录'})[table]||'记录')}。研究编号不能修改；更正原因与修改前后的值都会留痕。${table==='patients_baseline'?'知情同意与随访状态不在此处更正，请在看板中该患者的“研究状态”里修改。':''}</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${EDIT_FIELDS[table].map(k=>`<div><label for="edit_${k}">${escapeHtml(EDIT_LABELS[k]||k)}</label><input id="edit_${k}" data-field="${k}" type="${k.endsWith('_date')?'date':EDIT_NUMBERS.has(k)?'number':'text'}" ${EDIT_NUMBERS.has(k)?'step="any"':''} value="${escapeHtml(original[k]??'')}"/></div>`).join('')}</div>${table==='patients_baseline'?`<label for="edit_upcr_unit">基线UPCR原始单位（历史未确认的记录请按原始报告核对）</label><select id="edit_upcr_unit"><option value="">未确认</option><option value="mg/g" ${record.baseline_upcr_original_unit==='mg/g'?'selected':''}>mg/g</option><option value="g/g" ${record.baseline_upcr_original_unit==='g/g'?'selected':''}>g/g</option></select>`:''}<label for="editReason">更正原因（必填，3–500 字，不含身份信息）</label><textarea id="editReason" maxlength="500" placeholder="说明原始资料依据及更正原因"></textarea><div id="editFeedback" role="status"></div><div class="btnbar"><button class="btn primary" id="editSave">核对变更并保存</button><button class="btn" id="editCancel">取消</button></div></section>`;
    document.body.appendChild(overlay);qs('#editCancel',overlay).addEventListener('click',()=>overlay.remove());
    qs('#editSave',overlay).addEventListener('click',async()=>{
      const btn=qs('#editSave',overlay),feedback=qs('#editFeedback',overlay);try{
        assertContext(op);const reason=qs('#editReason',overlay).value.trim();
        const reasonProblem=correctionReasonError(reason);if(reasonProblem){qs('#editReason',overlay).focus();throw new Error(reasonProblem);}
        const changes={};
        qsa('[data-field]',overlay).forEach(input=>{const key=input.dataset.field,value=input.value.trim();if(value===String(original[key]??''))return;
          const label=(EDIT_LABELS[key]||key).replace(/\s.*$/,'');
          changes[key]=key.endsWith('_date')?strictDate(value,EDIT_LABELS[key]||key)
            :['scr_umol_l','baseline_scr'].includes(key)?creatinineUmol(value,'umol',label)
            :EDIT_NUMBERS.has(key)?finiteNumber(value,label,EDIT_LIMITS[key]||{}):value||null;
          if(key==='ln_podocytopathy'&&value){if(!['true','false'].includes(value))throw new Error('足细胞病须为true或false');changes[key]=value==='true';}
        });
        if(changes.notes){assertNoPII(changes.notes,'备注');if([...changes.notes].length>500)throw new Error('备注最多 500 字');}
        if(table==='visits_long'){const sbpValue='sbp'in changes?changes.sbp:record.sbp,dbpValue='dbp'in changes?changes.dbp:record.dbp;if(sbpValue!=null&&dbpValue!=null&&Number(dbpValue)>=Number(sbpValue))throw new Error('舒张压须低于收缩压，请核对是否填反');}
        if(table==='patients_baseline'){
          const unit=qs('#edit_upcr_unit',overlay).value||'';
          if('baseline_upcr'in changes || unit!==(record.baseline_upcr_original_unit||'')){
            const raw=finiteNumber(qs('#edit_baseline_upcr',overlay).value,'UPCR',{min:0});
            changes.baseline_upcr=raw==null?null:normalizeUpcr(raw,unit);changes.baseline_upcr_unit=raw==null?null:'mg/g';changes.baseline_upcr_raw=raw;changes.baseline_upcr_original_unit=raw==null?null:unit;
          }
        }
        if(!Object.keys(changes).length)throw new Error('没有字段发生变化');
        const summary=Object.entries(changes).filter(([k])=>!['baseline_upcr_raw','baseline_upcr_original_unit'].includes(k)).map(([k,v])=>`${EDIT_LABELS[k]||k}：${record[k]??'空'} → ${v??'空'}`).join('\n');
        if(!confirm('请核对本次变更：\n'+summary+'\n\n确认保存？'))return;
        setBusy(btn,true);feedback.textContent='正在保存并重新校验…';const {data,error}=await sb.rpc('correct_registry_record',{p_project_id:op.project.id,p_table:table,p_record_id:id,p_changes:changes,p_reason:reason});
        if(error)throw error;assertContext(op);if(!data?.record)throw new Error('服务器未返回更正记录');overlay.remove();toast('更正已保存并留痕，请查看重新校验后的数据质控状态');
        // 更正只影响这位患者：只重新读取该患者的看板行和项目概览。
        await Promise.all([refreshPatientRow(op,record.patient_code),loadOverview(op),loadExtras(),loadIssueSummary(),loadIssues()]);
      }catch(e){feedback.textContent='未保存：'+registryErrorMessage(e);}finally{setBusy(btn,false);}
    });
  }catch(e){toast('无法打开记录：'+registryErrorMessage(e));}
}

async function generatePaperPack({withSnapshot=false}={}){
  if(!requireProjectCapability('can_export'))return;
  if(!selectedProject)return toast('请先选择项目');if(typeof JSZip==='undefined')return toast('打包组件未加载，请刷新后重试');
  const op=captureContext(),btn=withSnapshot?el.btnPaperPackWithSnapshot:el.btnPaperPack;setBusy(btn,true);
  try{
    const frozen=await freezeRegistryExport(op);
    const tables=Object.fromEntries(Object.entries(frozen.content.tables).filter(([t])=>t!=='data_issues').map(([t,rows])=>[t,rows.map(r=>({...r,center_code:frozen.content.project.center_code,module:frozen.content.project.module}))]));
    const issues=frozen.content.tables.data_issues||[];
    const readAsset=async name=>{const r=await fetch('/assets/template/'+name,{cache:'no-cache'});if(!r.ok)throw new Error(`分析模板 ${name} 加载失败 (${r.status})`);const text=await r.text();if(/^\s*<!doctype html/i.test(text))throw new Error(`分析模板 ${name} 返回了网页`);return text;};
    const assetNames=['run_analysis.py','merge_centers.py','requirements.txt','METHODS_TEMPLATE_EN.md','README_PACK.md','protocol_template.json'];
    const assets=await Promise.all(assetNames.map(readAsset));assertContext(op);
    const metaRecord=frozen;
    const zip=new JSZip(),files={},counts={};
    for(const [table,rows] of Object.entries(tables)){
      files[`analysis/data/${table}.csv`]='\ufeff'+toCsv(rows,exportColumns(rows,[...COMMON_EXPORT_COLUMNS,...(EXPORT_FIELDS[table]||[])]),{spreadsheetSafe:false});
      files[`excel_safe/${table}.csv`]='\ufeff'+toCsv(rows,exportColumns(rows,[...COMMON_EXPORT_COLUMNS,...(EXPORT_FIELDS[table]||[])]));counts[table]=rows.length;
    }
    files['analysis/run_analysis.py']=assets[0];files['analysis/merge_centers.py']=assets[1];files['analysis/requirements.txt']=assets[2];
    files['analysis/METHODS_TEMPLATE_EN.md']=assets[3];files['analysis/README.md']=assets[4].replaceAll('{{PROJECT_NAME}}',op.project.name).replaceAll('{{EXPORT_DATE}}',fmtDate(new Date()));
    // 研究方案参数模板：示例数值全部标为需 PI 确认，未确认前分析脚本不计算终点。
    files['analysis/protocol_template.json']=assets[5];
    // JSON preserves exact raw strings/types independently of spreadsheet-safe CSV escaping.
    files['research_data.json']=frozen.content_text;
    files['qc_issues.csv']='\ufeff'+toCsv(issues,exportColumns(issues,['id','project_id','patient_code','record_type','record_id','rule_code','severity','status','message','resolution_note']));
    files['qc_summary.json']=JSON.stringify({...calcQcSummary(tables.visits_long),open_issues:issues.filter(r=>!['RESOLVED','WONT_FIX'].includes(r.status)).length,resolved:issues.filter(r=>r.status==='RESOLVED').length,accepted_without_fix:issues.filter(r=>r.status==='WONT_FIX').length},null,2);
    files['data_dictionary.json']=JSON.stringify({schema_version:frozen.schema_version,identity_key:['project_id','center_code','patient_code'],record_key:'id',baseline_upcr:'Canonical mg/g only if baseline_upcr_unit is mg/g. Historical missing units require review; do not infer scale.',baseline_scr:'umol/L',visits:{scr_umol_l:'umol/L',upcr:'mg/g',egfr:'Derived per egfr_formula_version; verify provenance'},labs:'Raw value/unit and standard value/unit are separate columns.',missing:'null/empty = unknown or not collected; zero is a value.',csv:'analysis/data CSV preserves exact text for scripts. Use excel_safe CSV when opening in spreadsheets. research_data.json is the exact frozen server content.',patients_baseline_study_status:{consent_status:'知情同意状态：unconfirmed 未确认；consented 已签署知情同意；waiver 伦理委员会批准免除知情同意；declined 拒绝；withdrawn 撤回同意。',consent_date:'签署或确认知情同意的日期，可为空。',consent_version:'知情同意书版本，可为空。',followup_status:'随访状态：active 在访；lost 失访；withdrawn 退出研究；deceased 死亡；kidney_failure 肾衰竭（判定标准以研究方案为准）；transferred 转院。随访状态用于随访管理，不等同于经核实的临床终点事件。',followup_status_date:'随访状态变更日期，可为空。',consent_research:'由 consent_status 自动生成：consented 或 waiver 为 true，declined 或 withdrawn 为 false，unconfirmed 为空值（空值表示尚未确认，不表示“否”）。'},field_notes:frozen.content.field_notes||null},null,2);
    files['README.md']=['# 科研数据与分析脚本包',`项目：${op.project.name}`,`中心：${op.project.center_code}`,'','这是导出的数据与可运行脚本，不是已完成的统计结果或论文。请先核对字段、单位与缺失，再按 analysis/README.md 运行分析。','数据来自同一次数据库一致性读取，服务器保存不可变版本；research_data.json保留原始冻结字节，可按SHA-256核对。','本ZIP每个文件的SHA-256记录于export_manifest.json。版本列表可重新下载冻结JSON；旧元数据批次不具有此能力。','analysis/data里的CSV供分析脚本使用并保留原始文字，不应直接双击用Excel打开。请用excel_safe目录下做过公式文本防护的CSV供Excel查看。请仅在已批准的协作范围内分享。'].join('\n');
    const manifest={format:'registry-export-v3',project_id:op.project.id,center_code:op.project.center_code,exported_at:new Date().toISOString(),metadata_register_id:metaRecord?.snapshot_id||null,consistency:frozen.consistency,source_content_sha256:frozen.content_sha256,counts,files:{}};
    for(const [name,content]of Object.entries(files)){manifest.files[name]={sha256:await sha256Text(content),utf8_bytes:new TextEncoder().encode(content).length};zip.file(name,content);}
    zip.file('export_manifest.json',JSON.stringify(manifest,null,2));
    const filename=`registry_analysis_${op.project.name.replace(/[^\w\u4e00-\u9fa5-]+/g,'_').slice(0,40)}_${fmtDate(new Date())}.zip`;
    const audit=await sb.rpc('log_project_audit',{p_project_id:op.project.id,p_action:'paper_package',p_snapshot_id:metaRecord?.snapshot_id||null,p_details:{zip_name:filename,counts,manifest_sha256:await sha256Text(JSON.stringify(manifest))}});
    if(audit.error)throw new Error('导出留痕记录失败，未生成文件：'+registryErrorMessage(audit.error));
    const blob=await zip.generateAsync({type:'blob'});assertContext(op);
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},400);
    frozenRequests.delete(frozen.requestKey);
    toast(`分析包已导出：${counts.patients_baseline} 位患者、${counts.visits_long} 条随访。请按包内说明运行分析。`);
    if(metaRecord)await loadSnapshots();
  }catch(e){toast('打包失败，未提供不完整文件：'+registryErrorMessage(e));}finally{setBusy(btn,false);}
}

// ═══════════════════════════════════════════════════════════
// 研究者资料
// ═══════════════════════════════════════════════════════════

async function loadProfile(){
  const identity=captureIdentity();
  const { data, error } = await sb.from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if(!sameIdentity(identity))return;
  if(error){if(el.profileStatus){el.profileStatus.textContent="资料读取失败，请重试";el.profileStatus.style.display="inline-flex";}return;}
  if (!data) {
    // 新用户，提示引导
    if (el.profileStatus){
      el.profileStatus.textContent = "资料未填写（可选）";
      el.profileStatus.className = "badge warn";
      el.profileStatus.style.display = "inline-flex";
    }
    return;
  }

  // 回填表单
  if (el.profName)     el.profName.value     = data.real_name       || "";
  if (el.profHospital) el.profHospital.value  = data.hospital        || "";
  if (el.profDept)     el.profDept.value      = data.department      || "";
  if (el.profPlan)     el.profPlan.value      = data.interested_plan || "";
  if (el.profContact)  el.profContact.value   = data.contact         || "";
  if (el.profNotes)    el.profNotes.value     = data.notes           || "";

  const hasCore = data.real_name && data.hospital;
  if (el.profileStatus){
    el.profileStatus.textContent = hasCore ? "资料已填写" : "资料未填完（可选）";
    el.profileStatus.className   = `badge ${hasCore ? "ok" : "warn"}`;
    el.profileStatus.style.display = "inline-flex";
  }
}

async function saveProfile(){
  const btn = el.btnSaveProfile;
  btn.dataset.label = "保存资料";
  setBusy(btn, true);
  try {
    const { error } = await sb.rpc("upsert_my_profile", {
      p_real_name:       el.profName?.value.trim()    || null,
      p_hospital:        el.profHospital?.value.trim()|| null,
      p_department:      el.profDept?.value.trim()    || null,
      p_interested_plan: el.profPlan?.value           || null,
      p_contact:         el.profContact?.value.trim() || null,
      p_notes:           el.profNotes?.value.trim()   || null,
    });
    if (error) throw error;
    toast("资料已保存");
    await loadProfile();
  } catch(e) {
    toast("保存失败：" + registryErrorMessage(e));
  } finally {
    setBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════════
// 平台管理员功能
// ═══════════════════════════════════════════════════════════

async function adminSearch(){
  const identity=captureIdentity();
  if (!isPlatformAdmin){ toast("无管理员权限"); return; }
  const email = el.adminSearchEmail.value.trim();
  if (!email){ toast("请输入邮箱关键词"); return; }
  const btn = el.btnAdminSearch;
  setBusy(btn, true);
  try {
    const { data, error } = await sb.rpc("admin_list_projects", { p_email: email });
    if(!sameIdentity(identity))return;
  if (error) throw error;
    renderAdminResults(data || []);
  } catch(e) {
    toast("搜索失败：" + registryErrorMessage(e));
  } finally {
    setBusy(btn, false);
  }
}

function planBadgeHtml(plan){
  const map = { partner:"合作伙伴", pro:"Pro", institution:"机构版" };
  const label = map[plan] || "试用";
  const cls   = plan && plan !== "trial" ? "badge ok" : "badge";
  return `<span class="${cls}" style="font-size:11px">${label}</span>`;
}

function renderAdminResults(rows){
  const c = el.adminResults;
  if (!rows.length){
    c.innerHTML = `<div class="muted small">未找到项目。请检查邮箱是否正确。</div>`;
    return;
  }

  // 所有行属于同一用户，资料取第一行
  const first = rows[0];
  const na = v => escapeHtml(v || "—");

  // ── 用户资料区块 ────────────────────────────────────────────
  const profileFilled = first.real_name || first.hospital;
  const profileHtml = `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <b style="font-size:14px">用户资料</b>
        <span class="badge ${profileFilled?"ok":"warn"}" style="font-size:11px">
          ${profileFilled?"已填写":"未填写"}
        </span>
        <span class="muted small" style="margin-left:auto">${na(first.owner_email)}</span>
      </div>
      <div class="kv" style="grid-template-columns:max-content 1fr max-content 1fr;gap:4px 16px">
        <div class="muted small">姓名</div>      <div>${na(first.real_name)}</div>
        <div class="muted small">医院/单位</div>  <div>${na(first.hospital)}</div>
        <div class="muted small">科室</div>       <div>${na(first.department)}</div>
        <div class="muted small">意向套餐</div>   <div>${na(first.interested_plan)}</div>
        <div class="muted small">联系方式</div>   <div>${na(first.contact)}</div>
        <div class="muted small">备注</div>       <div>${na(first.profile_notes)}</div>
      </div>
      ${first.profile_updated_at
        ? `<div class="muted small" style="margin-top:8px">资料更新：${fmtDate(first.profile_updated_at)}</div>`
        : ""}
    </div>`;

  // ── 项目列表表格 ─────────────────────────────────────────────
  const thead = `<thead><tr>
    <th>项目名称</th><th>中心</th><th>模块</th>
    <th>当前计划</th><th>到期时间</th><th>设定到期</th><th>操作</th>
  </tr></thead>`;

  const rows_html = rows.map(r => {
    const pid = escapeHtml(r.project_id);
    const plan = r.subscription_plan || "trial";
    // 显示当前到期时间（付费用 subscription_active_until，试用用 trial_expires_at）
    const currentExpiry = plan !== "trial" && r.subscription_active_until
      ? fmtDate(r.subscription_active_until)
      : r.trial_expires_at ? fmtDate(r.trial_expires_at) : "—";
    // 日期选择器默认值
    const expiryDefault = plan !== "trial" && r.subscription_active_until
      ? r.subscription_active_until.slice(0,10)
      : r.trial_expires_at ? r.trial_expires_at.slice(0,10) : "";

    return `<tr>
      <td>${escapeHtml(r.project_name)}</td>
      <td>${escapeHtml(r.center_code||"—")}</td>
      <td>${escapeHtml(r.module||"—")}</td>
      <td>${planBadgeHtml(plan)}</td>
      <td style="font-size:12px">${currentExpiry}</td>
      <td>
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          <select id="pplan_${pid}" style="width:90px;font-size:12px">
            <option value="trial"${plan==="trial"?" selected":""}>试用</option>
            <option value="pro"${plan==="pro"?" selected":""}>Pro</option>
            <option value="institution"${plan==="institution"?" selected":""}>机构版</option>
            <option value="partner"${plan==="partner"?" selected":""}>合作伙伴</option>
          </select>
          <input id="pexp_${pid}" type="date" value="${expiryDefault}" style="width:130px;font-size:12px"/>
          <button class="btn small" onclick="adminSetExpiry('${pid}')">设定</button>
        </div>
      </td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn small" onclick="adminExtend('${pid}',30)">+30天</button>
          <button class="btn small" onclick="adminExtend('${pid}',90)">+90天</button>
          <button class="btn small primary" onclick="adminPartner('${pid}')">合作伙伴</button>
          <button class="btn small" style="color:#c0392b" onclick="adminReset('${pid}')">撤回</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  c.innerHTML = profileHtml +
    `<b style="font-size:13px">项目列表（${rows.length} 个）</b>
     <table class="table" style="font-size:13px;margin-top:6px">${thead}<tbody>${rows_html}</tbody></table>`;
}

async function adminExtend(projectId, days){
  if (!confirm(`延长试用 ${days} 天？`)) return;
  const { error } = await sb.rpc("admin_adjust_trial", {
    p_project_id: projectId, p_extra_days: days
  });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast(`已延长 ${days} 天`);
  adminSearch();
}

async function adminPartner(projectId){
  if (!confirm("设为合作伙伴（长期免费）？")) return;
  const { error } = await sb.rpc("admin_set_partner", { p_project_id: projectId });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("已设为合作伙伴");
  adminSearch();
}

async function adminReset(projectId){
  if (!confirm("撤回人工授权并重新计算账户权益？原试用期限和独立付费订单保持有效规则。")) return;
  const { error } = await sb.rpc("admin_reset_to_trial", { p_project_id: projectId });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("已撤回人工授权并重新计算账户权益");
  adminSearch();
}

// ═══════════════════════════════════════════════════════════
// 合作申请（用户侧）
// ═══════════════════════════════════════════════════════════

const CONTRACT_STATUS_LABEL = {
  pending:  { text:"审批中",   cls:"badge warn" },
  approved: { text:"已批准",   cls:"badge ok"   },
  rejected: { text:"未通过",   cls:"badge bad"  },
  cancelled:{ text:"已取消",   cls:"badge"      },
};

async function loadMyContract(){
  const identity=captureIdentity();
  const { data: rows, error } = await sb.rpc("get_my_contract");
  if(!sameIdentity(identity))return;
  if(error){if(el.contractStatus)el.contractStatus.textContent="合作申请状态读取失败，请重试。";return;}
  const c = el.contractStatus;
  const form = el.contractApplyForm;
  if (!c || !form) return;

  // get_my_contract returns a table → rows is an array
  const data = Array.isArray(rows) ? rows[0] : rows;

  if (!data) {
    // 没有申请记录 → 显示申请表单
    c.innerHTML = `<div class="muted small">暂无申请记录。如贵中心符合条件，请填写后提交。</div>`;
    form.style.display = "block";
    // 预填微信号（如果用户资料里已有联系方式）
    if (el.contractWechat && el.profContact?.value) {
      el.contractWechat.value = el.profContact.value;
    }
    return;
  }

  const s = CONTRACT_STATUS_LABEL[data.status] || { text: data.status, cls:"badge" };
  form.style.display = "none";

  let extra = "";
  if (data.status === "approved" && data.payment_status === "unpaid"){
    extra = `<div class="infobox" style="margin-top:8px">
      <b>审批已通过！</b> 平台将与您联系确认付款方式。付款后由平台核验到账并开通权益。<br/>
      套餐：<b>${escapeHtml(data.plan || data.apply_plan)}</b>
      ${data.annual_price_cny ? `· 协议价：<b>¥${escapeHtml(data.annual_price_cny)}/年</b>` : ""}
      ${data.admin_note ? `<br/>备注：${escapeHtml(data.admin_note)}` : ""}
    </div>`;
  } else if (data.status === "approved" && data.payment_status === "paid"){
    extra = `<div class="infobox" style="margin-top:8px">
      权益已激活，到期：<b>${data.expires_at ? escapeHtml(fmtDate(data.expires_at)) : "—"}</b>
    </div>`;
  } else if (data.status === "rejected"){
    extra = `<div class="warnbox" style="margin-top:8px">
      申请未通过。${data.admin_note ? `原因：${escapeHtml(data.admin_note)}` : ""}
      <br/><a href="#" onclick="resetContractForm(event)" style="color:inherit">重新申请</a>
    </div>`;
  }

  c.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
    <span class="${escapeHtml(s.cls)}">${escapeHtml(s.text)}</span>
    <span class="muted small">申请套餐：${escapeHtml(data.apply_plan)}
      · 提交于 ${escapeHtml(fmtDate(data.applied_at))}</span>
  </div>${extra}`;
}

function resetContractForm(e){
  e.preventDefault();
  if (el.contractStatus) el.contractStatus.innerHTML = "";
  if (el.contractApplyForm) el.contractApplyForm.style.display = "block";
}

async function applyContract(){
  const identity=captureIdentity();
  const plan   = el.contractPlan?.value;
  const wechat = el.contractWechat?.value.trim() || "";
  const note   = el.contractNote?.value.trim() || null;

  if (!wechat) {
    toast("请填写微信号，方便平台联系您");
    el.contractWechat?.focus();
    return;
  }

  const btn  = el.btnApplyContract;
  btn.dataset.label = "提交申请";
  setBusy(btn, true);
  try {
    // 将微信号保存到用户资料的联系方式字段
    const profileResult=await sb.rpc("upsert_my_profile", {
      p_real_name:       el.profName?.value.trim()    || null,
      p_hospital:        el.profHospital?.value.trim()|| null,
      p_department:      el.profDept?.value.trim()    || null,
      p_interested_plan: el.profPlan?.value            || null,
      p_contact:         wechat,
      p_notes:           el.profNotes?.value.trim()   || null,
    });

    if(profileResult.error)throw profileResult.error;
    if(!sameIdentity(identity))throw new Error("登录状态已变化，请重新提交");
    const { error } = await sb.rpc("apply_partner_contract", {
      p_plan: plan, p_note: note
    });
    if (error) throw error;
    if(!sameIdentity(identity))return;
    toast("申请已提交，平台将在 1–2 个工作日内联系您");
    await loadMyContract();
  } catch(e) {
    toast("提交失败：" + registryErrorMessage(e));
  } finally {
    setBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════════
// 合同管理（管理员侧）
// ═══════════════════════════════════════════════════════════

async function adminLoadContracts(){
  const identity=captureIdentity();
  if (!isPlatformAdmin) return;
  const { data, error } = await sb.rpc("admin_list_contracts");
  if(!sameIdentity(identity))return;
  if (error){
    if(el.adminContracts) el.adminContracts.innerHTML =
      `<span class="muted small" style="color:#c0392b">加载失败：${escapeHtml(registryErrorMessage(error))}</span>`;
    return;
  }
  renderAdminContracts(data || []);
}

function renderAdminContracts(rows){
  const c = el.adminContracts;
  if (!c) return;

  const pending = rows.filter(r => r.status === "pending");
  const approved = rows.filter(r => r.status === "approved");

  if (el.adminContractsBadge){
    if (pending.length){
      el.adminContractsBadge.textContent = `${pending.length} 待审批`;
      el.adminContractsBadge.style.display = "inline-flex";
    } else {
      el.adminContractsBadge.style.display = "none";
    }
  }

  if (!rows.length){
    c.innerHTML = `<div class="muted small">暂无申请记录。</div>`;
    return;
  }

  const cardHtml = rows.map(r => {
    const na = v => escapeHtml(v || "—");
    const s  = CONTRACT_STATUS_LABEL[r.status] || { text: r.status, cls:"badge" };
    const cid = escapeHtml(r.contract_id);

    // 待审批：显示审批表单
    const reviewForm = r.status === "pending" ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0">
        <div>
          <label style="font-size:12px">折扣（%优惠）</label>
          <input id="disc_${cid}" type="number" min="1" max="99" placeholder="如 40 = 6折"
                 style="width:90px" value="${r.discount_pct || ""}"/>
        </div>
        <div>
          <label style="font-size:12px">授予套餐</label>
          <select id="plan_${cid}" style="width:110px">
            <option value="institution" ${r.apply_plan==="institution"?"selected":""}>机构版</option>
            <option value="pro"         ${r.apply_plan==="pro"?"selected":""}>Pro</option>
            <option value="partner">合作伙伴</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px">协议年费（元）</label>
          <input id="price_${cid}" type="number" step="100" placeholder="如 6000"
                 style="width:100px" value="${r.annual_price_cny || ""}"/>
        </div>
        <div style="flex:1;min-width:120px">
          <label style="font-size:12px">备注</label>
          <input id="note_${cid}" placeholder="可选" value="${escapeHtml(r.admin_note??"")}"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn small primary" onclick="adminApproveContract('${cid}')">✅ 批准</button>
          <button class="btn small" style="color:#c0392b" onclick="adminRejectContractPrompt('${cid}')">❌ 拒绝</button>
          <button class="btn small" style="color:#888" onclick="adminCancelContract('${cid}')">取消</button>
        </div>
      </div>` : "";

    // 已批准：显示管理操作（付款状态、到期时间、取消）
    const approvedForm = r.status === "approved" ? `
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;flex-wrap:wrap">
        <div>
          <label style="font-size:12px">付款状态</label>
          <select id="pay_${cid}" style="width:100px;font-size:12px">
            <option value="unpaid"${r.payment_status==="unpaid"?" selected":""}>未付款</option>
            <option value="paid"${r.payment_status==="paid"?" selected":""}>已付款</option>
            <option value="overdue"${r.payment_status==="overdue"?" selected":""}>逾期</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px">授予套餐</label>
          <select id="cplan_${cid}" style="width:100px;font-size:12px">
            <option value="pro"${(r.plan||r.apply_plan)==="pro"?" selected":""}>Pro</option>
            <option value="institution"${(r.plan||r.apply_plan)==="institution"?" selected":""}>机构版</option>
            <option value="partner"${(r.plan||r.apply_plan)==="partner"?" selected":""}>合作伙伴</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px">到期日</label>
          <input id="cexp_${cid}" type="date" value="${
            r.expires_at ? r.expires_at.slice(0,10) :
            new Date(Date.now()+365*864e5).toISOString().slice(0,10)
          }" style="width:130px;font-size:12px"/>
        </div>
        <div style="flex:1;min-width:100px">
          <label style="font-size:12px">备注</label>
          <input id="cnote_${cid}" placeholder="可选" value="${escapeHtml(r.admin_note??"")}" style="font-size:12px"/>
        </div>
        <div style="display:flex;gap:6px">
          ${r.payment_status !== "paid" ?
            `<button class="btn small primary" onclick="adminActivateContract('${cid}')">💳 确认收款</button>` : ""}
          <button class="btn small" onclick="adminUpdateContract('${cid}')">保存修改</button>
          <button class="btn small" style="color:#c0392b" onclick="adminCancelContract('${cid}')">取消合同</button>
        </div>
      </div>
      ${r.payment_status === "paid" ? `<div class="muted small" style="margin-top:6px">
        已激活 · 到期：${r.expires_at ? fmtDate(r.expires_at) : "—"}
        · 付款：${r.paid_at ? fmtDate(r.paid_at) : "—"}
      </div>` : ""}
    ` : "";

    const activateForm = "";
    const activeInfo = "";

    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="${s.cls}" style="font-size:11px">${s.text}</span>
        <b style="font-size:13px">${na(r.real_name)}</b>
        <span class="muted small">${na(r.owner_email)}</span>
        <span class="muted small">·</span>
        <span class="muted small">${na(r.hospital)} ${na(r.department)}</span>
        ${r.contact ? `<span class="muted small">· 微信: ${escapeHtml(r.contact)}</span>` : ""}
        <span class="muted small" style="margin-left:auto">${fmtDate(r.applied_at)}</span>
      </div>
      <div class="muted small">
        申请套餐：<b>${r.apply_plan}</b>
        ${r.discount_pct ? ` · 折扣：${100-r.discount_pct}折（优惠${r.discount_pct}%）` : ""}
        ${r.annual_price_cny ? ` · 协议价：¥${r.annual_price_cny}/年` : ""}
        ${r.apply_note ? `<br/>申请说明：${escapeHtml(r.apply_note)}` : ""}
      </div>
      ${activeInfo}${reviewForm}${activateForm}${approvedForm}
    </div>`;
  }).join("");

  c.innerHTML = cardHtml;
}

async function adminApproveContract(cid){
  const disc  = parseInt(qs(`#disc_${cid}`)?.value)  || null;
  const plan  = qs(`#plan_${cid}`)?.value             || null;
  const price = parseFloat(qs(`#price_${cid}`)?.value)|| null;
  const note  = qs(`#note_${cid}`)?.value.trim()      || null;
  const { error } = await sb.rpc("admin_review_contract", {
    p_contract_id: cid, p_discount_pct: disc,
    p_plan: plan, p_annual_price: price, p_admin_note: note
  });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("已批准，等待用户付款");
  adminLoadContracts();
}

async function adminRejectContractPrompt(cid){
  const note = prompt("拒绝原因（可选，用户可见）：") ?? null;
  if (note === null) return; // cancelled
  const { error } = await sb.rpc("admin_reject_contract", {
    p_contract_id: cid, p_admin_note: note || null
  });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("已拒绝申请");
  adminLoadContracts();
}

async function adminActivateContract(cid){
  const expInput = qs(`#cexp_${cid}`)?.value;
  const expires  = expInput ? new Date(expInput).toISOString() : null;
  if (!confirm(`确认收款并激活？权益将开通至 ${expInput || "服务器自动计算的日期"}，该用户所有项目自动升级。`)) return;
  const { error } = await sb.rpc("admin_activate_contract", {
    p_contract_id: cid, p_expires_at: expires
  });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("✅ 已激活，权益已开通");
  adminLoadContracts();
}

// ── 管理员：取消合同 ──────────────────────────────────────────
async function adminCancelContract(cid){
  const note = prompt("取消原因（可选，用户可见）：") ?? null;
  if (note === null) return;
  if (!confirm("确认取消该合同？服务器会重新计算该账号仍有效的全部权益来源。")) return;
  const { error } = await sb.rpc("admin_cancel_contract", {
    p_contract_id: cid, p_admin_note: note || null
  });
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("已取消合同");
  adminLoadContracts();
}

// ── 管理员：修改合同（付款状态、到期时间、套餐等）──────────
async function adminUpdateContract(cid){
  const paymentEl = qs(`#pay_${cid}`);
  const expEl     = qs(`#cexp_${cid}`);
  const planEl    = qs(`#cplan_${cid}`);
  const noteEl    = qs(`#cnote_${cid}`);

  const params = { p_contract_id: cid };
  if (paymentEl) params.p_payment_status = paymentEl.value;
  if (expEl && expEl.value) params.p_expires_at = new Date(expEl.value).toISOString();
  if (planEl) params.p_plan = planEl.value;
  if (noteEl && noteEl.value.trim()) params.p_admin_note = noteEl.value.trim();

  const { error } = await sb.rpc("admin_update_contract", params);
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("合同已更新");
  adminLoadContracts();
}

// ── 管理员：直接设定项目到期日期 ──────────────────────────────
async function adminSetExpiry(projectId){
  const expEl  = qs(`#pexp_${projectId}`);
  const planEl = qs(`#pplan_${projectId}`);
  if (!expEl || !expEl.value){ toast("请选择到期日期"); return; }
  if (!confirm(`确认设定到期日期为 ${expEl.value}？`)) return;

  const params = {
    p_project_id: projectId,
    p_expires_at: new Date(expEl.value).toISOString()
  };
  if (planEl) params.p_plan = planEl.value;

  const { error } = await sb.rpc("admin_set_expiry", params);
  if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
  toast("到期时间已更新");
  adminSearch();
}

// ═══════════════════════════════════════════════════════════
// 订单管理（管理员侧）
// ═══════════════════════════════════════════════════════════

const ORDER_STATUS_LABEL = {
  unpaid:               { text:"待付款",   cls:"badge" },
  pending_verification: { text:"待核验",   cls:"badge warn" },
  paid:                 { text:"已到账",   cls:"badge ok" },
  activated:            { text:"已开通",   cls:"badge ok" },
  rejected:             { text:"已驳回",   cls:"badge bad" },
  cancelled:            { text:"已取消",   cls:"badge" },
  expired:              { text:"已过期",   cls:"badge" },
  refund_pending:       { text:"退款中",   cls:"badge warn" },
  refunded:             { text:"已退款",   cls:"badge" },
};

async function adminLoadOrders(){
  const identity=captureIdentity();
  if (!isPlatformAdmin) return;
  const { data, error } = await sb.rpc("admin_list_orders");
  if(!sameIdentity(identity))return;
  if (error){
    if(el.adminOrders) el.adminOrders.innerHTML =
      `<span class="muted small" style="color:#c0392b">加载失败：${escapeHtml(registryErrorMessage(error))}</span>`;
    return;
  }
  renderAdminOrders(data || []);
}

function renderAdminOrders(rows){
  const c = el.adminOrders;
  if (!c) return;

  const pending = rows.filter(r => r.status === "pending_verification");
  if (el.adminOrdersBadge){
    if (pending.length){
      el.adminOrdersBadge.textContent = `${pending.length} 待核验`;
      el.adminOrdersBadge.style.display = "inline-flex";
    } else {
      el.adminOrdersBadge.style.display = "none";
    }
  }

  if (!rows.length){
    c.innerHTML = `<div class="muted small">暂无订单。</div>`;
    return;
  }

  const planMap = { pro:"Pro", institutional:"机构版" };
  const cycleMap = { monthly:"月付", yearly:"年付" };
  const methodMap = { wechat_qr:"微信", alipay_qr:"支付宝", bank_transfer:"转账" };

  const html = rows.map(r => {
    const na = v => escapeHtml(v || "—");
    const s = ORDER_STATUS_LABEL[r.status] || { text: r.status, cls:"badge" };
    const oid = escapeHtml(r.id);

    const actionHtml = r.status === "pending_verification" ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0">
        <div>
          <label style="font-size:12px">生效日</label>
          <input id="ostart_${oid}" type="date" value="" title="留空按当前权益自动顺延" style="width:130px;font-size:12px"/>
        </div>
        <div>
          <label style="font-size:12px">到期日（留空自动顺延）</label>
          <input id="oend_${oid}" type="date" value="" title="留空按当前权益自动顺延" style="width:130px;font-size:12px"/>
        </div>
        <div style="flex:1;min-width:100px">
          <label style="font-size:12px">管理员备注</label>
          <input id="onote_${oid}" placeholder="可选" style="font-size:12px"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn small primary" onclick="adminVerifyOrder('${oid}')">确认到账并开通</button>
          <button class="btn small" style="color:#c0392b" onclick="adminRejectOrder('${oid}')">驳回</button>
          ${r.proof_count > 0 ? `<button class="btn small" onclick="adminViewProofs('${oid}')">查看凭证(${r.proof_count})</button>` : ""}
        </div>
      </div>` : "";

    const activatedInfo = r.status === "activated" ? `
      <div class="muted small" style="margin-top:6px">
        已开通 · ${r.start_at ? fmtDate(r.start_at) : "—"} 至 ${r.end_at ? fmtDate(r.end_at) : "—"}
        · 配额 ${r.project_quota} 个项目
      </div>` : "";

    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span class="${s.cls}" style="font-size:11px">${s.text}</span>
        <code style="font-size:12px">${na(r.order_no)}</code>
        <span class="muted small">${na(r.owner_email)}</span>
        ${r.real_name ? `<b style="font-size:13px">${na(r.real_name)}</b>` : ""}
        ${r.hospital ? `<span class="muted small">${na(r.hospital)}</span>` : ""}
        <span class="muted small" style="margin-left:auto">${fmtDate(r.created_at)}</span>
      </div>
      <div class="small">
        ${planMap[r.plan_code]||r.plan_code} · ${cycleMap[r.billing_cycle]||r.billing_cycle}
        · ${r.project_quota} 个项目
        · 应付 ¥${r.amount_due}
        ${r.amount_paid ? ` · 实付 ¥${r.amount_paid}` : ""}
        · ${methodMap[r.payment_method]||r.payment_method||"未选"}
        ${r.invoice_needed ? `<br/>发票抬头：${na(r.invoice_title)} · 税号：${na(r.invoice_tax_no)}<br/>收票邮箱：${na(r.invoice_email)} · 发票类型：${na(r.invoice_type)}` : ""}
        ${r.payer_name ? ` · 付款人：${na(r.payer_name)}` : ""}
        ${r.notes ? `<br/>备注：${na(r.notes)}` : ""}
      </div>
      ${activatedInfo}${actionHtml}${r.invoice_needed&&r.status==="activated"?`<p>发票：${r.invoice_status==="issued"?"已开具":"待开具"} <button class="btn small" onclick="adminSetInvoice('${oid}','${r.invoice_status==="issued"?"requested":"issued"}')">${r.invoice_status==="issued"?"标记待开具":"确认已开具"}</button></p>`:""}
    </div>`;
  }).join("");

  c.innerHTML = html;
}

let _adminOrderBusy = false;

async function adminVerifyOrder(orderId){
  if (_adminOrderBusy) return;
  const startEl = qs(`#ostart_${orderId}`);
  const endEl   = qs(`#oend_${orderId}`);
  const noteEl  = qs(`#onote_${orderId}`);

  // 日期校验
  if (startEl?.value && isNaN(new Date(startEl.value).getTime())) { toast("生效日期无效"); return; }
  if (endEl?.value && isNaN(new Date(endEl.value).getTime())) { toast("到期日期无效"); return; }

  if (!confirm(`确认到账并开通？该付款账户创建的项目将按权益使用，到期日 ${endEl?.value || "（服务器按已有期限顺延）"}`)) return;

  _adminOrderBusy = true;
  try {
    const params = { p_order_id: orderId };
    if (startEl?.value) params.p_start_at = new Date(startEl.value).toISOString();
    if (endEl?.value)   params.p_end_at   = new Date(endEl.value).toISOString();
    if (noteEl?.value?.trim()) params.p_admin_notes = noteEl.value.trim();

    const { error } = await sb.rpc("admin_verify_order", params);
    if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
    toast("已确认到账并开通权益");
    adminLoadOrders();
  } finally {
    _adminOrderBusy = false;
  }
}

async function adminRejectOrder(orderId){
  if (_adminOrderBusy) return;
  const reason = prompt("驳回原因（用户可见，必填）：");
  if (reason === null) return;
  if (!reason.trim()) { toast("驳回原因不能为空"); return; }

  _adminOrderBusy = true;
  try {
    const { error } = await sb.rpc("admin_reject_order", {
      p_order_id: orderId, p_reject_reason: reason.trim()
    });
    if (error){ toast("操作失败：" + registryErrorMessage(error)); return; }
    toast("已驳回");
    adminLoadOrders();
  } finally {
    _adminOrderBusy = false;
  }
}

async function adminViewProofs(orderId){
  const identity=captureIdentity();
  try{
    const {data,error}=await sb.rpc('admin_get_order_proofs',{p_order_id:orderId});if(error)throw error;if(!sameIdentity(identity))return;if(!data?.length)return toast('暂无凭证');
    const entries=await Promise.all(data.map(async p=>{
      if(!/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[^/]+$/i.test(p.file_url||''))return `<p>${escapeHtml(p.file_name||'历史凭证')}：旧格式未通过存储校验。请先驳回待核验订单并注明需重传凭证，再联系付款人重新上传。</p>`;
      const {data:link,error}=await sb.storage.from('payment-proofs').createSignedUrl(p.file_url,120);if(error)throw error;
      const url=new URL(link.signedUrl);if(url.protocol!=='https:'||url.origin!==new URL(window.CONFIG.SUPABASE_URL).origin)throw new Error('凭证签名链接来源异常');
      return `<p><a href="${escapeHtml(link.signedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.file_name||'付款凭证')}</a> · 2分钟内有效</p>`;
    }));if(!sameIdentity(identity))return;
    const overlay=document.createElement('div');overlay.dataset.registryModal='proof';overlay.style.cssText='position:fixed;inset:0;background:#102d46aa;z-index:9000;display:grid;place-items:center;padding:16px';
    overlay.innerHTML=`<section role="dialog" aria-modal="true" style="padding:24px;background:white;max-width:640px;max-height:80vh;overflow:auto;border-radius:12px"><h2>付款凭证</h2>${entries.join('')}<button class="btn">关闭</button></section>`;
    overlay.querySelector('button').addEventListener('click',()=>overlay.remove());document.body.appendChild(overlay);
  }catch(e){toast('凭证读取失败：'+registryErrorMessage(e));}
}
async function adminSetInvoice(orderId,status){
  if(!isPlatformAdmin)return;if(!confirm(`确认将发票状态设为${status==='issued'?'已开具':'待开具'}？`))return;
  const {error}=await sb.rpc('admin_set_invoice_status',{p_order_id:orderId,p_status:status});if(error)return toast('发票状态更新失败：'+registryErrorMessage(error));toast('发票状态已更新');await adminLoadOrders();
}
window.adminSetInvoice=adminSetInvoice;

// 挂载到 window，供 table inline onclick 调用
window.adminExtend  = adminExtend;
window.adminPartner = adminPartner;
window.adminReset   = adminReset;
window.adminApproveContract        = adminApproveContract;
window.adminRejectContractPrompt   = adminRejectContractPrompt;
window.adminActivateContract       = adminActivateContract;
window.adminCancelContract         = adminCancelContract;
window.adminUpdateContract         = adminUpdateContract;
window.adminSetExpiry              = adminSetExpiry;
window.resetContractForm           = resetContractForm;
window.adminVerifyOrder            = adminVerifyOrder;
window.adminRejectOrder            = adminRejectOrder;
window.adminViewProofs             = adminViewProofs;

// ============================================================
// 批量导入（CSV）
// ============================================================

// Transactional, context-bound imports. Empty cells preserve existing values.
// 基线 / 随访：单批 ≤500 行，沿用原流程。化验 / 用药 / 终点事件：见 /lib/batch-import.js，两级校验后按 500 行分块，
// 每块一个批次编号，成功后登记文件信息（register_import_file）；某块失败即停止，重试沿用同一批次编号。
let _importParsed=null;
let _importBatches=[];let _undoTarget=null;let _lastImportReport=null;
const IMPORT_TEMPLATES={
  baseline:{filename:'template_patients_baseline.csv',columns:BASELINE_IMPORT_FIELDS,example:{patient_code:'0001',sex:'F',birth_year:'1985',baseline_date:'2026-09-01',baseline_scr:'88.4',baseline_upcr:'500',baseline_upcr_unit:'mg/g'}},
  visits:{filename:'template_visits_long.csv',columns:VISIT_IMPORT_FIELDS,example:{patient_code:'0001',visit_date:'2026-09-14',sbp:'128',dbp:'78',scr_umol_l:'92',upcr:'450'}}
};
const isBatchKind=type=>BATCH_KINDS.includes(type);
const UNDOABLE_KINDS=['visits','labs','meds','events'];
const ROW_STATUS_LABELS={ok:'可写入',warn:'警告',block:'阻断',ignored:'不导入'};
function downloadImportTemplate(){
  const type=el.importType.value;
  if(isBatchKind(type))return downloadCsvUtf8Bom(BATCH_TEMPLATES[type].filename,templateCsv(type));
  const t=IMPORT_TEMPLATES[type];if(t)downloadCsvUtf8Bom(t.filename,toCsv([t.example],t.columns));
}
function closeImportHelp(){const box=qs('#importHelp');if(box){box.hidden=true;box.replaceChildren();}qs('#btnImportHelp')?.setAttribute('aria-expanded','false');}
function toggleImportHelp(){
  const box=qs('#importHelp');if(!box)return;
  if(!box.hidden)return closeImportHelp();
  const type=el.importType.value;const batch=isBatchKind(type);
  const fields=batch?BATCH_TEMPLATES[type].fields:IMPORT_TEMPLATES[type].columns.map(c=>[c,fieldLabel(c),c==='patient_code'?'必填':'选填','']);
  const example=c=>batch?(BATCH_TEMPLATES[type].examples.map(e=>e[c]).find(v=>v)||''):(IMPORT_TEMPLATES[type].example[c]||'');
  box.innerHTML=`<div><b>${escapeHtml(KIND_LABELS[type])}模板填写说明</b>${batch?`（${escapeHtml(BATCH_TEMPLATES[type].filename)}）`:''}</div>
    <div class="infobox" style="margin:6px 0" data-pii-notice="help"><b>隐私提示：</b>${escapeHtml(PII_NOTICE)}</div>
    <div class="muted small">CSV 编码 UTF-8（可带 BOM）；首行为英文列名，列顺序可调，列名须与模板逐字一致；日期格式 YYYY-MM-DD；选填列可留空或整列删除。</div>
    <table class="table"><thead><tr><th>列名</th><th>中文名</th><th>是否必填</th><th>规则与取值</th><th>示例</th></tr></thead>
    <tbody>${fields.map(([c,cn,req,rule])=>`<tr><td><code>${escapeHtml(c)}</code></td><td>${escapeHtml(cn)}</td><td>${escapeHtml(req)}</td><td>${escapeHtml(rule)}</td><td>${escapeHtml(example(c))}</td></tr>`).join('')}</tbody></table>`;
  box.hidden=false;qs('#btnImportHelp')?.setAttribute('aria-expanded','true');
}
/** 清除预览（保留结果页）。 */
function clearImportPreview(){
  if(el.importPreview)el.importPreview.style.display='none';
  if(el.importFile)el.importFile.value='';
  _importParsed=null;
  ['#importCounts','#importUnmapped'].forEach(s=>{const n=qs(s);if(n){n.hidden=true;n.replaceChildren();}});
  const w=qs('#importWarnConfirmRow');if(w)w.style.display='none';
  const c=qs('#importWarnConfirm');if(c){c.checked=false;c.disabled=false;}
  const d=qs('#btnDownloadImportErrors');if(d)d.style.display='none';
  if(el.btnConfirmImport){el.btnConfirmImport.dataset.label='确认导入';if(!busyButtons.has(el.btnConfirmImport))el.btnConfirmImport.textContent='确认导入';}
}
function resetImportUi(){
  clearImportPreview();
  if(el.importProgress){el.importProgress.style.display='none';el.importProgress.textContent='';}
  const r=qs('#importResult');if(r){r.hidden=true;r.replaceChildren();}
  _lastImportReport=null;
}
function syncImportType(){
  const type=el.importType?.value;const batch=isBatchKind(type);
  qsa('[data-import-rules="legacy"]').forEach(n=>{n.hidden=batch;});
  qsa('[data-import-rules="batch"]').forEach(n=>{n.hidden=!batch;});
  const legacy=qs('#importLegacyOptions');if(legacy)legacy.hidden=batch;
  const units=qs('#importUnitsConfirmRow');if(units)units.style.display=batch?'none':'flex';
  closeImportHelp();resetImportUi();
}
async function handleImportFile(evt){
  if(!requireProjectCapability('can_write'))return;
  if(isBatchKind(el.importType.value))return handleBatchFile(evt.target.files?.[0]);
  _importParsed=null;el.importPreview.style.display='none';
  const file=evt.target.files?.[0];if(!file)return;if(!selectedProject)return toast('请先选择项目');
  const op=captureContext(),type=el.importType.value;
  if(file.size>2*1024*1024)return toast('单次 CSV 不超过2MB、500行，请分为明确的导入批次。');
  try{
    const {headers,data,lines}=parseRegistryCsv(await file.text());assertContext(op);
    const piiColumns=piiHeaderColumns(headers);
    if(piiColumns.length)throw new Error(`表头含疑似个人信息列（${piiColumns.join('、')}），整份文件已拒绝。${PII_NOTICE}`);
    if(data.length>500)throw new Error('单次最多500行，防止浏览器中断；请分批准备文件');
    const unit=qs('#importBaselineUnit')?.value||'';
    const results=data.map((row,i)=>{try{assertNoPII(row.patient_code,'研究编号');if(row.notes)assertNoPII(row.notes,'备注');return {row:lines[i],ok:true,data:normalizeImportRow(type,row,unit)};}catch(e){return {row:lines[i],ok:false,error:e.message,data:row};}});
    const errors=results.filter(r=>!r.ok);
    _importParsed={op,type,results,batchId:crypto.randomUUID(),filename:file.name};
    el.importSummary.textContent=`目标：${op.project.name} / ${op.project.center_code}。${results.length} 行，${errors.length} 行需修正。整批成功或整批拒绝；基线未提供/空白字段保持原值。以下显示前20行及所有错误。`;
    const preview=[...results.slice(0,20),...errors.filter(r=>r.row>results[19]?.row)];const cols=[...new Set(preview.flatMap(r=>Object.keys(r.data)))];
    el.importTable.innerHTML=`${errors.length?`<div class="warnbox">${errors.map(r=>`第${r.row}行：${escapeHtml(r.error)}`).join('<br>')}</div>`:''}<div style="overflow:auto"><table class="table"><thead><tr><th>行号</th>${cols.map(c=>`<th title="${escapeHtml(c)}">${escapeHtml(fieldLabel(c))}</th>`).join('')}</tr></thead><tbody>${preview.map(r=>`<tr><td>${r.row}${r.ok?'':' ✗'}</td>${cols.map(c=>`<td>${escapeHtml(r.data[c]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    el.btnConfirmImport.dataset.blocked=errors.length?'1':'';el.btnConfirmImport.disabled=!!errors.length||!canProject('can_write');el.importPreview.style.display='block';el.importProgress.style.display='none';
  }catch(e){_importParsed=null;toast('无法预览：'+registryErrorMessage(e));}
}
async function sha256Bytes(buffer){
  const bytes=await crypto.subtle.digest('SHA-256',buffer);
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function loadImportPatients(op){
  const rows=patientsLoaded?patients:await readKeysetRows(sb,'v_patient_followup_status',op.project.id,{key:'patient_id',select:'patient_id,patient_code,followup_status,baseline_date',pageSize:BOARD_PAGE_SIZE,assertCurrent:()=>assertContext(op)});
  assertContext(op);
  return new Map(rows.map(r=>[r.patient_code,{followup_status:r.followup_status,baseline_date:r.baseline_date}]));
}
async function handleBatchFile(file){
  resetImportUi();
  if(!file)return;if(!selectedProject)return toast('请先选择项目');
  const op=captureContext(),type=el.importType.value;
  if(file.size>MAX_FILE_BYTES)return toast('单个 CSV 不超过 20 MB，请拆分为多个文件。');
  const fileName=baseFileName(file.name);
  if(containsPII(fileName)){if(el.importFile)el.importFile.value='';return toast('文件名疑似包含个人信息（姓名、手机号、身份证号、病案号或 8 位以上连续数字，例如不带分隔符的日期），请重命名后重新选择；日期可写成 2026-10-14。');}
  try{
    const buffer=await file.arrayBuffer();
    const sha256=await sha256Bytes(buffer);
    const {headers,data,lines}=parseRegistryCsv(new TextDecoder('utf-8').decode(buffer));assertContext(op);
    if(data.length>MAX_FILE_ROWS)throw new Error(`单个文件最多 ${MAX_FILE_ROWS} 行，请拆分为多个文件`);
    if(type==='labs'&&!labCatalog.length){await loadLabCatalog();assertContext(op);}
    if(type==='labs'&&!labCatalog.length)throw new Error('化验项目字典读取失败，请刷新页面后重试');
    const patientMap=await loadImportPatients(op);
    _importParsed={op,type,batch:true,headers,data,lines,fileName,sha256,mapping:{},patients:patientMap,today:beijingToday(),result:null,chunks:null};
    revalidateBatch();
  }catch(e){if(currentContext(op)){_importParsed=null;toast('无法预览：'+registryErrorMessage(e));}}
}
function revalidateBatch(){
  const b=_importParsed;if(!b?.batch)return;
  b.result=validateBatch(b.type,b.headers,b.data,{catalog:labCatalog,unitMap,patients:b.patients,today:b.today,mapping:b.mapping,containsPII,lines:b.lines});
  _lastImportReport={type:b.type,result:b.result};
  // 校验结果变化（新文件、处理未映射项目等）后须重新核对警告。
  const warnBox=qs('#importWarnConfirm');if(warnBox)warnBox.checked=false;
  renderBatchPreview();
}
function renderBatchPreview(){
  const b=_importParsed,r=b.result,c=r.counts;const locked=!!b.chunks;
  el.importSummary.textContent=`目标：${b.op.project.name} / ${b.op.project.center_code}。文件：${b.fileName}。${KIND_LABELS[b.type]}共 ${c.total} 行${c.ignored?`，其中 ${c.ignored} 行已标记为不导入`:''}。阻断行不会写入；可写入行按每 500 行一块依次提交。`;
  const counts=qs('#importCounts');
  counts.innerHTML=`<span data-count="total">总行数 ${Number(c.total)}</span><span class="bi-count-ok" data-count="writable">可写入 ${Number(c.writable)}</span><span class="bi-count-warn" data-count="warn">警告 ${Number(c.warn)}</span><span class="bi-count-block" data-count="block">阻断 ${Number(c.block)}</span>`;
  counts.hidden=false;
  const unmappedBox=qs('#importUnmapped');
  if(b.type==='labs'&&r.unmapped.length){
    const options=labCatalog.map(x=>`<option value="${escapeHtml(x.code)}">${escapeHtml(x.name_cn)}（${escapeHtml(x.code)}）</option>`).join('');
    unmappedBox.innerHTML=`<div class="bi-unmapped"><b>未映射项目（${r.unmapped.length} 项）</b><div class="muted small">以下化验项目不在系统字典中，也没有匹配到常见名称或缩写。请逐项选择对应的字典项目，或标记为“不导入”；未处理的行不会写入。</div>
      <table class="table"><thead><tr><th>文件中的编码</th><th>文件中的名称</th><th>行数</th><th>映射到</th></tr></thead><tbody>${r.unmapped.map((u,i)=>`<tr><td>${escapeHtml(u.code)}</td><td>${escapeHtml(u.name)}</td><td>${Number(u.count)}</td><td><select data-unmapped-index="${i}" aria-label="未映射项目 ${i+1} 映射到"><option value="">-- 请选择 --</option><option value="${SKIP_MAPPING}">不导入</option>${options}</select></td></tr>`).join('')}</tbody></table></div>`;
    qsa('select[data-unmapped-index]',unmappedBox).forEach(s=>{s.value=b.mapping[r.unmapped[Number(s.dataset.unmappedIndex)].key]||'';s.disabled=locked;});
    unmappedBox.hidden=false;
  }else{unmappedBox.hidden=true;unmappedBox.replaceChildren();}
  if(r.fileIssues.length){
    el.importTable.innerHTML=`<div class="warnbox">${r.fileIssues.map(f=>`表头问题（${escapeHtml(f.col)}）：${escapeHtml(f.reason)} ${escapeHtml(f.fix)}`).join('<br>')}</div>`;
  }else{
    const problems=r.rows.filter(x=>x.status!=='ok'),fine=r.rows.filter(x=>x.status==='ok');
    const shown=[...problems.slice(0,300),...fine.slice(0,20)].sort((a,b2)=>a.line-b2.line);
    const cols=b.headers;
    el.importTable.innerHTML=`<table class="table"><thead><tr><th>行号</th><th>状态</th>${cols.map(h=>`<th title="${escapeHtml(h)}">${escapeHtml(fieldLabel(h))}</th>`).join('')}<th>问题与提示</th></tr></thead><tbody>${shown.map(x=>`<tr class="bi-row-${x.status}" data-line="${Number(x.line)}"><td>${Number(x.line)}</td><td>${ROW_STATUS_LABELS[x.status]}</td>${cols.map(h=>`<td>${escapeHtml(h==='patient_code'&&x.codePii?MASKED_CODE:(x.cells[h]??''))}</td>`).join('')}<td>${x.issues.map(i=>`<div class="bi-issue-${i.level}">${escapeHtml(fieldLabel(i.col))}：${escapeHtml(i.reason)}${i.fix?' '+escapeHtml(i.fix):''}</div>`).join('')}</td></tr>`).join('')}</tbody></table>${problems.length>300||fine.length>20?`<div class="muted small" style="padding:6px">仅显示前 300 个问题行与前 20 个正常行；完整清单请下载错误报告。</div>`:''}`;
  }
  const warnRow=qs('#importWarnConfirmRow');warnRow.style.display=c.warn?'flex':'none';
  const warnBox=qs('#importWarnConfirm');warnBox.disabled=locked;if(!c.warn)warnBox.checked=false;
  qs('#btnDownloadImportErrors').style.display=r.fileIssues.length||r.rows.some(x=>x.issues.some(i=>i.level!=='info'))?'':'none';
  el.btnConfirmImport.dataset.blocked=r.fileIssues.length||!c.writable?'1':'';
  el.btnConfirmImport.disabled=busyButtons.has(el.btnConfirmImport)||el.btnConfirmImport.dataset.blocked==='1'||!canProject('can_write');
  el.importPreview.style.display='block';
}
function onUnmappedChange(e){
  const s=e.target.closest('select[data-unmapped-index]');const b=_importParsed;if(!s||!b?.batch||b.chunks)return;
  const entry=b.result.unmapped[Number(s.dataset.unmappedIndex)];if(!entry)return;
  if(s.value)b.mapping[entry.key]=s.value;else delete b.mapping[entry.key];
  revalidateBatch();
}
function downloadImportErrors(){
  const report=_importParsed?.batch?{type:_importParsed.type,result:_importParsed.result}:_lastImportReport;if(!report?.result)return;
  downloadCsvUtf8Bom(`import_errors_${report.type}_${fmtDate(new Date())}.csv`,errorReportCsv(report.result));
}
async function confirmImport(){
  if(_importParsed?.batch)return confirmBatchImport();
  if(!requireProjectCapability('can_write'))return;
  const batch=_importParsed;if(!batch)return;
  const btn=el.btnConfirmImport;
  try{
    assertContext(batch.op);if(batch.results.some(r=>!r.ok))throw new Error('请先修正全部错误');
    if(!qs('#importUnitsConfirm')?.checked)throw new Error('请先确认肌酐与随访UPCR单位');
    if(!confirm(`将 ${batch.results.length} 行提交到「${batch.op.project.name}」？基线只更新本次非空字段，服务器将整批校验并去重。`))return;
    setBusy(btn,true);el.importProgress.style.display='block';el.importProgress.textContent='正在事务提交，请保留页面；若断线可用同一预览重试。';
    const {data,error}=await sb.rpc('import_registry_rows',{p_project_id:batch.op.project.id,p_kind:batch.type,p_rows:batch.results.map(r=>r.data),p_batch_id:batch.batchId});
    if(error)throw error;assertContext(batch.op);if(!data||data.total!==batch.results.length)throw new Error('服务器返回数量不一致，请保留批次并联系管理员核对');
    el.importProgress.textContent=`导入成功：新增 ${data.inserted}，更新 ${data.updated}，去重跳过 ${data.skipped}；批次 ${batch.batchId}`;
    toast('整批导入已完成');_importParsed=null;el.importFile.value='';el.importPreview.style.display='none';
    await Promise.all([refreshFollowup(batch.op),loadExtras(),loadIssueSummary()]);
    if(qs('#importBatchesDetails')?.open)loadImportBatches();
  }catch(e){const rowLine=n=>batch?.results?.[n-1]?.row??null;if(batch&&currentContext(batch.op)){el.importProgress.style.display='block';el.importProgress.textContent=`未确认完成：${registryErrorMessage(e,{rowLine})} 批次 ${batch.batchId} 已保留，可修复后用同一预览重试；不要改用新批次重复提交。`;}toast('导入未完成：'+registryErrorMessage(e,{rowLine}));}
  finally{setBusy(btn,false);}
}
async function confirmBatchImport(){
  if(!requireProjectCapability('can_write'))return;
  const b=_importParsed;if(!b?.result)return;const btn=el.btnConfirmImport;
  try{
    assertContext(b.op);
    const c=b.result.counts;
    if(b.result.fileIssues.length||!c.writable)throw new Error('没有可写入的行，请先按预览修正文件');
    if(c.warn&&!qs('#importWarnConfirm')?.checked)throw new Error('有警告行：请逐行核对后勾选“已核对警告”，再确认导入');
    if(!b.chunks){
      const n=Math.ceil(c.writable/CHUNK_SIZE);
      if(!confirm(`将 ${c.writable} 行${KIND_LABELS[b.type]}分 ${n} 块提交到「${b.op.project.name}」？${c.block?`阻断的 ${c.block} 行不会写入。`:''}${c.warn?`其中 ${c.warn} 行警告已核对。`:''}`))return;
      b.chunks=buildChunks(b.result,()=>crypto.randomUUID());
      renderBatchPreview();
    }
    setBusy(btn,true);
    await runBatchChunks(b);
  }catch(e){if(currentContext(b.op))toast('导入未完成：'+registryErrorMessage(e));}
  finally{setBusy(btn,false);}
}
async function runBatchChunks(b){
  el.importProgress.style.display='block';
  for(const chunk of b.chunks){
    if(chunk.registered)continue;
    assertContext(b.op);
    el.importProgress.textContent=`正在提交第 ${chunk.index}/${chunk.total} 块（${chunk.rows.length} 行），请保留页面…`;
    try{
      if(!chunk.imported){
        const {data,error}=await sb.rpc('import_registry_rows',{p_project_id:b.op.project.id,p_kind:b.type,p_rows:chunk.rows,p_batch_id:chunk.batchId});
        if(error)throw error;assertContext(b.op);
        if(!data||Number(data.total)!==chunk.rows.length)throw new Error('服务器返回数量不一致，请保留本页并联系管理员核对');
        chunk.imported=true;chunk.reply=data;
      }
      const {error:regError}=await sb.rpc('register_import_file',{p_project_id:b.op.project.id,p_batch_id:chunk.batchId,p_file_sha256:b.sha256,p_file_name:b.fileName,p_chunk_index:chunk.index,p_chunk_total:chunk.total});
      if(regError)throw regError;assertContext(b.op);
      chunk.registered=true;chunk.error=null;
    }catch(e){
      if(!currentContext(b.op))throw e;
      chunk.error=registryErrorMessage(e,{rowLine:n=>chunk.lines[n-1]??null});
      renderBatchResult(b,false);
      el.importProgress.textContent=`第 ${chunk.index}/${chunk.total} 块未完成，已停止提交后续块。${chunk.imported?'该块数据已写入，但文件信息登记未完成。':''}已成功的块不会重复写入。若是网络或登录问题，可点击“重试未完成的块”（沿用同一批次编号）；若需修改数据，请修正文件后重新上传，与已有记录相同的行会自动跳过。`;
      el.btnConfirmImport.dataset.label='重试未完成的块';
      return;
    }
  }
  renderBatchResult(b,true);
  el.importProgress.textContent='导入完成，结果见下方；可在“导入记录”中按批次查看与撤销。';
  toast(`${KIND_LABELS[b.type]}导入已完成`);
  _lastImportReport={type:b.type,result:b.result};
  clearImportPreview();
  const details=qs('#importBatchesDetails');
  await Promise.allSettled([loadExtras(),loadIssueSummary(),details?.open?loadImportBatches():Promise.resolve()]);
}
function renderBatchResult(b,done){
  const box=qs('#importResult');if(!box)return;
  const num=v=>Number(v)||0;
  const ok=b.chunks.filter(c=>c.registered);
  const inserted=ok.reduce((s,c)=>s+num(c.reply?.inserted),0),skipped=ok.reduce((s,c)=>s+num(c.reply?.skipped),0);
  const blocked=b.result.counts.block;
  const rows=b.chunks.map(c=>{
    const state=c.registered?`成功：新增 ${num(c.reply?.inserted)}，跳过 ${num(c.reply?.skipped)}${c.reply?.replayed?'（重试时确认已写入）':''}`:c.error?`失败：${c.error}`:'未提交';
    return `<tr class="${c.registered?'':c.error?'bi-row-block':''}" data-chunk="${c.index}"><td>${c.index}/${c.total}</td><td>第 ${c.lines[0]}–${c.lines[c.lines.length-1]} 行</td><td>${escapeHtml(state)}</td><td><code title="${escapeHtml(c.batchId)}">${escapeHtml(c.batchId.slice(0,8))}</code></td></tr>`;
  }).join('');
  box.innerHTML=`<div class="${done?'okbox':'warnbox'}" data-import-outcome="${done?'done':'partial'}">${done?`导入完成（${escapeHtml(KIND_LABELS[b.type])}）：新增 ${inserted}，跳过 ${skipped}（与已有记录相同），共 ${b.chunks.length} 块。`:`导入未全部完成：成功 ${ok.length}/${b.chunks.length} 块，已成功的块已写入。`}${blocked?` 预览中阻断的 ${blocked} 行未写入，可下载错误报告修正后重传同一文件。`:''}</div>
    <table class="table"><thead><tr><th>块</th><th>行范围</th><th>结果</th><th>批次</th></tr></thead><tbody>${rows}</tbody></table>
    ${blocked||done===false?'<div class="btnbar"><button class="btn small" data-import-errors>下载错误报告 CSV</button></div>':''}`;
  box.hidden=false;
}
function fmtDateTime(value){
  const d=new Date(value);if(!value||!Number.isFinite(d.getTime()))return String(value??'');
  const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function loadImportBatches(){
  const box=qs('#importBatchesList');if(!box||!selectedProject)return;
  const op=captureContext();box.textContent='正在读取导入记录…';
  try{
    const {data,error}=await sb.rpc('list_import_batches',{p_project_id:op.project.id,p_limit:100});if(error)throw error;assertContext(op);
    _importBatches=Array.isArray(data)?data:[];renderImportBatches();
  }catch(e){if(currentContext(op))box.textContent='导入记录读取失败：'+registryErrorMessage(e);}
}
function renderImportBatches(){
  const box=qs('#importBatchesList');if(!box)return;
  if(!_importBatches.length){box.textContent='暂无导入记录。';return;}
  const canWrite=canProject('can_write');const num=v=>Number(v)||0;
  box.innerHTML=`<table class="table"><thead><tr><th>类型</th><th>时间</th><th>操作者</th><th>文件名</th><th>块序</th><th>新增 / 跳过</th><th>状态</th><th></th></tr></thead><tbody>${_importBatches.map((r,i)=>`<tr data-batch-row="${i}">
    <td>${escapeHtml(KIND_LABELS[r.kind]||'其他')}</td><td>${escapeHtml(fmtDateTime(r.created_at))}</td><td>${escapeHtml(r.created_by_email||'—')}</td><td>${escapeHtml(r.file_name||'—')}</td>
    <td>${r.chunk_index&&r.chunk_total?`${num(r.chunk_index)}/${num(r.chunk_total)}`:'—'}</td><td>${num(r.inserted)} / ${num(r.skipped)}</td>
    <td>${r.undone_at?`<span class="badge bad">已撤销</span> ${escapeHtml(fmtDateTime(r.undone_at))}${r.undo_reason?`：${escapeHtml(r.undo_reason)}`:''}`:'<span class="badge ok">有效</span>'}</td>
    <td>${!r.undone_at&&UNDOABLE_KINDS.includes(r.kind)?(r.undo_supported===true?(canWrite?`<button class="btn small danger" data-project-capability="can_write" data-undo-index="${i}">撤销本批次</button>`:''):'<span class="muted small" data-undo-unsupported>该批次导入于支持撤销之前，不能自动撤销</span>'):''}</td></tr>`).join('')}</tbody></table>`;
}
function openUndoForm(index){
  const target=_importBatches[index];if(!target||target.undo_supported!==true||!requireProjectCapability('can_write'))return;
  _undoTarget=target;
  const form=qs('#importUndoForm');const label=qs('#importUndoTarget');
  if(label)label.textContent=`撤销批次：${KIND_LABELS[target.kind]||'其他'}，${fmtDateTime(target.created_at)}，${target.file_name||'未记录文件名'}${target.chunk_index&&target.chunk_total?`（第 ${Number(target.chunk_index)}/${Number(target.chunk_total)} 块）`:''}，新增 ${Number(target.inserted)||0} 条。`;
  qs('#importUndoReason').value='';qs('#importUndoResult').textContent='';
  form.hidden=false;qs('#importUndoReason').focus();
}
function closeUndoForm(){_undoTarget=null;const form=qs('#importUndoForm');if(form)form.hidden=true;const r=qs('#importUndoReason');if(r)r.value='';}
async function confirmUndoBatch(){
  if(!requireProjectCapability('can_write'))return;
  const target=_undoTarget;if(!target)return;
  const out=qs('#importUndoResult');const reason=qs('#importUndoReason').value.trim();const n=[...reason].length;
  if(n<2||n>500){out.textContent='请填写 2–500 字的撤销原因（不含身份信息）。';return;}
  if(containsPII(reason)){out.textContent='撤销原因中检测到疑似个人身份信息（手机号、身份证号、住院号、姓名等），请删除后再提交。';return;}
  const op=captureContext();const btn=qs('#btnConfirmUndoBatch');setBusy(btn,true);
  try{
    const {data,error}=await sb.rpc('undo_import_batch',{p_project_id:op.project.id,p_batch_id:target.batch_id,p_reason:reason});if(error)throw error;assertContext(op);
    closeUndoForm();
    out.textContent=data?.already_undone?'该批次此前已撤销，本次未重复操作。':`已撤销本批次：删除 ${Number(data?.deleted)||0} 条记录；因导入后已被更正而保留 ${Number(data?.kept_changed)||0} 条${data?.kept_referenced!=null?`；因其他批次引用而保留 ${Number(data.kept_referenced)||0} 条`:''}。`;
    await Promise.allSettled([loadImportBatches(),loadExtras(),target.kind==='visits'?refreshFollowup(op):Promise.resolve()]);
  }catch(e){if(currentContext(op))out.textContent='撤销未完成：'+registryErrorMessage(e);}
  finally{setBusy(btn,false);}
}

init();
