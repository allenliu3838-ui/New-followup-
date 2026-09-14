import { supabase } from "/lib/supabase-client.js?v=registry-20260914-integrated-v1";
import { createProjectMembers } from "/lib/project-members.js?v=registry-20260914-integrated-v1";
import { qs, qsa, toast, toCsv, downloadText, downloadCsvUtf8Bom, escapeCsv, fmtDate, daysLeft, humanNumber, escapeHtml } from "/lib/utils.js?v=registry-20260914-integrated-v1";
import { throttle } from "/lib/rate-limit.js?v=registry-20260914-integrated-v1";
import { validatePassword } from "/lib/password-strength.js?v=registry-20260914-integrated-v1";
import { strictDate, finiteNumber, normalizeUpcr, parseRegistryCsv, readAllRows, exportColumns, sha256Text, BASELINE_IMPORT_FIELDS, VISIT_IMPORT_FIELDS, normalizeImportRow, registryErrorMessage } from "/lib/registry-data.js?v=registry-20260914-integrated-v1";

const sb = supabase();

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

  el.tokenPatientCode = qs("#tokenPatientCode");
  el.tokenDays = qs("#tokenDays");
  el.tokenSingleUse = qs("#tokenSingleUse");
  el.btnGenToken = qs("#btnGenToken");
  el.tokenOut = qs("#tokenOut");
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
  el.medDose = qs("#medDose");
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

  // Bind auth-gated event listeners
  projectMembersController=createProjectMembers({root:document.getElementById('projectMembers'),sb,onAccessChange:refreshTokensAfterMemberChange});
  bindAuthGatedEvents();
  applyProjectAccess();
}

async function refreshTokensAfterMemberChange(changed){
  if(!selectedProject||changed?.projectId!==selectedProject.id||changed?.userId!==user?.id)return;
  const op=captureContext();
  // A former editor's links may all have been revoked by the member transaction.
  if(el.tokenOut){el.tokenOut.textContent='';el.tokenOut.style.display='none';}
  const container=qs('#existingTokens');if(container)container.textContent='成员权限已更新，正在重新核对随访链接状态…';
  try{await loadProjectAccess(op);assertContext(op);await loadExistingTokens();}
  catch(e){if(currentContext(op)){if(container)container.textContent='随访链接状态读取失败，请刷新后核对；当前不显示旧状态。';toast(registryErrorMessage(e));}}
}

function bindAuthGatedEvents() {
  el.btnCreateProject?.addEventListener("click", createProject);
  el.btnCreatePatient?.addEventListener("click", createPatientBaseline);
  el.patientSearch?.addEventListener("input", renderPatients);
  el.patBaselineUpcr?.addEventListener("input", renderBaselineConversion);
  el.patBaselineUpcrUnit?.addEventListener("change", renderBaselineConversion);
  qs("#btnResetBaseline")?.addEventListener("click", ()=>{if(confirm("放弃本次未保存的基线？"))resetBaseline();});
  qs("#workspaceNav")?.addEventListener("click", e=>{ const a=e.target.closest("a");if(!a)return;const href=a.getAttribute("href");if(!href?.startsWith("#"))return;const t=qs(href);if(t?.tagName==="DETAILS")t.open=true; });
  el.btnGenToken?.addEventListener("click", genToken);

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
    el.importPreview.style.display = "none";
    el.importFile.value = "";
    el.importProgress.style.display = "none";
    _importParsed = null;
  });

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

  [
    { el: el.evtNotes,  label: "事件备注" },
    { el: el.varNotes,  label: "基因备注" },
    { el: el.labQcReason, label: "留痕原因" },
  ].forEach(({ el: inp, label }) => {
    inp?.addEventListener("input", () => {
      if (containsPII(inp.value)) {
        inp.style.borderColor = "#dc2626";
        inp.title = `⚠ 检测到疑似PII，请删除个人信息（手机号/身份证/住院号/姓名等）`;
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

let projects = [];
let selectedProject = null;
let patients = [];
let labCatalog = [];         // [{code, name_cn, module, is_core, standard_unit, display_note}]
let unitMap = {};            // { code: [{unit_symbol, is_standard, multiplier}] }
let projectCustomLabs = [];  // [{id, name, unit}] — per-project custom lab catalog
let sessionEpoch=0, projectEpoch=0;
let projectAccess=null;
let projectMembersController=null;
function canProject(capability){return !!selectedProject && projectAccess?.[capability]===true;}
function canRevokeTokens(){return !!selectedProject&&['owner','editor'].includes(projectAccess?.role);}
function requireProjectCapability(capability){
  if(canProject(capability))return true;
  const reason=projectAccess?.write_block_reason;
  toast(!selectedProject?'请先选择项目':!projectAccess?'项目权限尚未加载，请重试':reason&&['can_write','can_manage_tokens'].includes(capability)?registryErrorMessage(reason):'当前项目角色没有此操作权限，请联系项目负责人');return false;
}
function applyProjectAccess(){
  const groups={can_write:['btnCreatePatient','btnAddVariant','btnAddLab','btnAddMed','btnAddEvent','importFile','btnConfirmImport'],can_manage_tokens:['btnGenToken'],can_export:['btnExportBaseline','btnExportVisits','btnExportLabs','btnExportMeds','btnExportVariants','btnExportEvents','btnPaperPack','btnCreateSnapshot','btnPaperPackWithSnapshot','btnRefreshSnapshots']};
  for(const [capability,keys]of Object.entries(groups))for(const key of keys){const node=el[key];if(node){node.dataset.projectCapability=capability;node.disabled=busyButtons.has(node)||!canProject(capability);}}
  qsa('[data-project-capability]').forEach(node=>{node.disabled=busyButtons.has(node)||!canProject(node.dataset.projectCapability);});
  const label=qs('#projectAccessStatus');if(label)label.textContent=!selectedProject?'请先选择项目':!projectAccess?'正在核对项目权限…':`项目角色：${({owner:'负责人',editor:'录入协作人',analyst:'分析协作人',viewer:'只读协作人'})[projectAccess.role]||'无权限'} · ${projectAccess.can_write?'可录入':'不可录入'} · ${projectAccess.can_export?'可导出':'不可导出'}${projectAccess.write_block_reason?' · '+registryErrorMessage(projectAccess.write_block_reason):''}`;
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
  if(el.patBaselineUpcrUnit)el.patBaselineUpcrUnit.value='mg/g';renderBaselineConversion();
}
function renderBaselineConversion(){
  const hint=qs('#baselineUnitHint');if(!hint)return;
  try{const n=normalizeUpcr(el.patBaselineUpcr?.value,el.patBaselineUpcrUnit?.value||'mg/g');hint.textContent=n==null?'按所选单位输入，保存前显示换算结果。':`将保存：${n} mg/g；原始输入与单位同时留存。`;}catch(e){hint.textContent=e.message;}
}
function clearProjectWorkspace(){
  resetBaseline();_importParsed=null;projectCustomLabs=[];patients=[];
  ['tokenPatientCode','varPatientCode','labPatientCode','medPatientCode','evtPatientCode','varTestDate','varTestName','varGene','varVariant','varHgvsC','varHgvsP','varZygosity','varClass','varLabName','varNotes','labDate','labValue','labQcReason','labCustomName','labCustomUnit','medName','medClass','medDose','medRoute','medFrequency','medStart','medEnd','evtType','evtDate','evtNotes','importFile'].forEach(k=>{if(el[k])el[k].value='';});
  if(el.labTestCode)el.labTestCode.value='';
  if(el.labUnit){el.labUnit.innerHTML='<option value="">-- 先选化验项目 --</option>';el.labUnit.value='';}
  if(el.labStdValue)el.labStdValue.value='';
  if(el.patientSearch)el.patientSearch.value='';
  if(qs('#importUnitsConfirm'))qs('#importUnitsConfirm').checked=false;
  if(qs('#importBaselineUnit'))qs('#importBaselineUnit').value='';
  ['tokenOut','importPreview','importProgress','snapshotOut'].forEach(k=>{if(el[k]){el[k].style.display='none';if(k!=='importPreview')el[k].textContent='';}});
  ['issueList','issueSummary','existingTokens','snapshotsList','patientsList','variantsPreview','labsPreview','medsPreview','eventsPreview'].forEach(k=>{if(el[k])el[k].textContent='请选择任务或等待当前项目加载。';});
  const tokens=qs('#existingTokens');if(tokens)tokens.textContent='请等待当前项目链接加载。';
  document.querySelectorAll('[data-registry-modal]').forEach(n=>n.remove());
}
function clearSessionWorkspace(){
  sessionEpoch++;projectEpoch++;projects=[];selectedProject=null;patients=[];_importParsed=null;projectCustomLabs=[];labCatalog=[];unitMap={};projectAccess=null;busyButtons.clear();frozenRequests.clear();isPlatformAdmin=false;
  projectMembersController?.clear();projectMembersController=null;
  document.getElementById('authGatedContainer')?.replaceChildren();
  document.querySelectorAll('[data-registry-modal]').forEach(n=>n.remove());
  _authGatedBound=false;
  if(el.password)el.password.value='';if(el.confirmPwd)el.confirmPwd.value='';
  if(el.trialBadge)el.trialBadge.style.display='none';if(el.upgradeBtn)el.upgradeBtn.style.display='none';
}
window.addEventListener('beforeunload',e=>{if(busyButtons.size){e.preventDefault();e.returnValue='';}});


// ── PII 检测（前端层，与后端 _contains_pii 逻辑保持同步） ────────────────────
function containsPII(text) {
  if (!text) return false;
  return (
    /1[3-9][0-9]{9}/.test(text)                             // 手机号
    || /[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]/.test(text) // 身份证
    || /(住院号|病案号|门诊号|病历号|床号|mrn|admiss)[^a-z0-9]{0,3}[0-9]{3,}/i.test(text)
    || /(姓名|患者姓名|病人|name\s*[:：])\s*[\u4e00-\u9fa5]{2,4}/.test(text)
    || /[0-9]{8,}/.test(text)
    || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)
  );
}

function assertNoPII(text, fieldLabel) {
  if (containsPII(text)) {
    throw new Error(
      `「${fieldLabel}」中检测到疑似个人身份信息（手机号/身份证/住院号等）。\n`
      + `请删除姓名、联系方式及院内身份编号后重新保存；仅使用研究编号。`
    );
  }
}

function setLoginHint(msg){ el.loginHint.textContent = msg || ""; }

function setBusy(btn, busy){
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  if(busy)busyButtons.add(btn);else busyButtons.delete(btn);
  btn.disabled = !!busy || !!(btn.dataset.projectCapability&&!canProject(btn.dataset.projectCapability));
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
    // Clear selection state on sign out
    if (_event === "SIGNED_OUT"){ clearSessionWorkspace(); passwordRecoveryMode = false; }
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
    setLoginHint("提示：首次使用请先点击「注册账号」创建账号，之后再登录。");
    return;
  }
  // Logged in: inject auth-gated content from template (only once)
  injectAuthGatedContent();
  el.loginCard.style.display = "none";
  el.appCard.style.display = "block";
  if (el.profileCard) el.profileCard.style.display = "block";
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
    .select("code,name_cn,module,is_core,standard_unit,display_note")
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
        data-project-capability="can_write" onclick="window._deleteProjectCustomLab('${cl.id}')">删除</button>
    </div>`).join("");
  applyProjectAccess();
}

async function deleteProjectCustomLab(id){
  if(!requireProjectCapability('can_write'))return;
  if (!confirm("确认从本项目目录中删除此自定义化验？已录入的历史记录不受影响。")) return;
  const { error } = await sb.from("project_custom_labs").delete().eq("id", id);
  if (error){ toast("删除失败：" + error.message); return; }
  toast("已删除");
  await loadProjectCustomLabs();
}
window._deleteProjectCustomLab = deleteProjectCustomLab;

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
  el.labUnit.innerHTML = units.map(u =>
    `<option value="${u.unit_symbol}" ${u.is_standard ? "selected" : ""}>${u.unit_symbol}${u.is_standard ? "（标准单位）" : ""}</option>`
  ).join("");

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
    const op=captureContext();try{await loadProjectAccess(op);projectMembersController?.setContext({projectId:op.project.id,projectName:op.project.name,userId:op.userId,access:projectAccess});await loadPatients();}catch(e){if(currentContext(op)){projectAccess=null;clearProjectWorkspace();applyProjectAccess();toast(registryErrorMessage(e));}}
  }
}

async function loadProjects(){
  const identity=captureIdentity();
  const { data, error } = await sb.from("projects").select("*").order("created_at", {ascending:false});
  if(!sameIdentity(identity))return;
  if (error){ toast("读取项目失败：" + error.message); return; }
  projects = data || [];
  if(selectedProject){const current=projects.find(p=>p.id===selectedProject.id);if(!current){projectEpoch++;projectAccess=null;selectedProject=null;projectMembersController?.clear();clearProjectWorkspace();applyProjectAccess();}else selectedProject=current;}
  renderProjects();
}

function renderProjects(){
  el.projectsList.innerHTML = "";

  if (projects.length === 0){
    // Empty state — invite user to seed demo data
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:10px;padding:14px;border:1.5px dashed rgba(37,99,235,.3);border-radius:14px;background:rgba(37,99,235,.04);";
    hint.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;">还没有项目</div>
      <div class="muted small" style="margin-bottom:10px;">
        可以先创建空项目（填写上方表单），也可以一键加载演示数据，立刻看到完整系统效果。
      </div>
      <button class="btn primary small" id="btnSeedDemo">⚡ 一键加载 IgAN 演示数据（8 患者）</button>`;
    el.projectsList.appendChild(hint);
    hint.querySelector("#btnSeedDemo").addEventListener("click", seedDemoData);
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
    return;
  }
  const p = selectedProject;
  el.projectMeta.innerHTML = `
    <div>项目</div><div><b>${escapeHtml(p.name)}</b></div>
    <div>中心代码</div><div><code>${escapeHtml(p.center_code)}</code></div>
    <div>模块</div><div><code>${escapeHtml(p.module)}</code></div>
    <div>账户权益</div><div>请查看页面顶部的实时账户状态。</div>
  `;
  renderTrialBadge(p);
  showIganPathBox();
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
  await Promise.all([loadPatients(),loadProjectCustomLabs(),loadExtras(),loadSnapshots(),loadIssueSummary(),loadExistingTokens()]);
  if(currentContext(c)){const label=qs('#currentProjectLabel');if(label)label.textContent=`当前项目：${c.project.name} · ${c.project.center_code}`;}
}

async function createProject(){
  const identity=captureIdentity();
  const name = el.projName.value.trim();
  const center_code = el.projCenter.value.trim();
  const module = el.projModule.value;
  const description = el.projDesc.value.trim() || null;

  if (!name) return toast("请输入项目名称");
  if (!center_code) return toast("请输入 center_code");

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

    toast("✅ 演示数据加载完成！已创建 8 名模拟患者 + 31 次随访（不用于研究结论）");
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
    if (btn){ btn.disabled = false; btn.textContent = "⚡ 一键加载 IgAN 演示数据（8 患者）"; }
  }finally{setBusy(btn,false);}
}
// ──────────────────────────────────────────────────────────────────────────────

async function loadPatients(){
  if(!selectedProject){patients=[];renderPatients();return;}const op=captureContext();
  try{patients=await readAllRows(sb,'patients_baseline',op.project.id,()=>assertContext(op));renderPatients();}
  catch(e){if(currentContext(op)){patients=[];el.patientsList.textContent='患者列表读取失败：'+registryErrorMessage(e);}}
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
      sb.from("variants_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10),
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
    if(evtsRes.error)el.eventsPreview.textContent="事件记录读取失败，请重试："+evtsRes.error.message;else renderEventsPreview(evtsRes.data||[]);
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

window._deleteRecord = deleteRecord;

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
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" onclick="window._deleteRecord('variants_long','${escapeHtml(r.id??"")}')">删除</button></td>
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
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" onclick="window._editRegistryRecord('labs_long','${escapeHtml(r.id??"")}')">核对 / 更正</button></td>
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
      <td class="muted small">${escapeHtml([r.dose,r.frequency,r.route].filter(Boolean).join(" "))}</td>
      <td>${escapeHtml(r.start_date??"")}</td>
      <td>${escapeHtml(r.end_date??"")}</td>
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" onclick="window._deleteRecord('meds_long','${escapeHtml(r.id??"")}')">删除</button></td>
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


function renderEventsPreview(rows){
  if (!el.eventsPreview) return;
  if (!rows.length){
    el.eventsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code??"")}</b></td>
      <td>${escapeHtml(r.event_type??"")}</td>
      <td>${escapeHtml(r.event_date??"")}</td>
      <td>${escapeHtml(r.source||"manual")}</td>
      <td class="muted small">${escapeHtml((r.notes??"").slice(0,30))}</td>
      <td><button class="btn small" style="color:#b91c1c" data-project-capability="can_write" onclick="window._deleteRecord('events_long','${escapeHtml(r.id??"")}')">删除</button></td>
    </tr>
  `).join("");
  el.eventsPreview.innerHTML = `
    <div class="muted small">最近 20 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>事件类型</th><th>日期</th><th>来源</th><th>备注</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
  applyProjectAccess();
}

function renderPatients(){
  if (!selectedProject){
    el.patientsList.innerHTML = "<div class='muted small'>请先选择/创建项目</div>";
    return;
  }
  if (!patients.length){
    el.patientsList.innerHTML = "<div class='muted small'>暂无患者</div>";
    return;
  }
  const search=(el.patientSearch?.value||"").trim().toLowerCase();
  const matched=patients.filter(p=>String(p.patient_code).toLowerCase().includes(search));
  const rows = matched.slice(0,100).map(p=>{
    const mest = (selectedProject.module==="IGAN" && (p.oxford_m!==null || p.oxford_e!==null || p.oxford_s!==null || p.oxford_t!==null || p.oxford_c!==null))
      ? `M${v(p.oxford_m)} E${v(p.oxford_e)} S${v(p.oxford_s)} T${v(p.oxford_t)} C${v(p.oxford_c)}`
      : "";
    const lnSummary = (selectedProject.module==="LN" && p.ln_class)
      ? `${p.ln_class}${p.ln_activity_index!=null ? ` AI:${p.ln_activity_index}` : ""}${p.ln_chronicity_index!=null ? ` CI:${p.ln_chronicity_index}` : ""}`
      : "";
    const pathSummary = mest || lnSummary;
    return `
      <tr data-pcode="${escapeHtml(p.patient_code)}">
        <td><b>${escapeHtml(p.patient_code)}</b></td>
        <td>${escapeHtml(p.sex||"")}</td>
        <td>${escapeHtml(p.birth_year||"")}</td>
        <td>${escapeHtml(p.baseline_date||"")}</td>
        <td>${escapeHtml(p.baseline_scr??"")}</td>
        <td>${escapeHtml(p.baseline_upcr??"")} ${p.baseline_upcr==null?"":escapeHtml(p.baseline_upcr_unit||"单位待核实")}</td>
        <td class="muted small">${escapeHtml(pathSummary)}</td>
        <td><button class="btn small" data-act="token">选择此患者</button> <button class="btn small" data-project-capability="can_write" data-act="edit" data-id="${escapeHtml(p.id)}">基线更正</button> <button class="btn small" data-act="history" data-code="${escapeHtml(p.patient_code)}">随访记录</button></td>
      </tr>
    `;
  }).join("");

  el.patientsList.innerHTML = `
    <p class="muted small">匹配 ${matched.length} 位患者，显示前 ${Math.min(matched.length,100)} 位。可按研究编号搜索定位。</p>
    <table class="table">
      <thead><tr>
        <th>研究编号</th><th>性别</th><th>出生年</th><th>基线日期</th><th>Scr（μmol/L）</th><th>UPCR</th><th>病理分型</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  qsa("button[data-act=history]",el.patientsList).forEach(b=>b.addEventListener("click",()=>openVisitHistory(b.dataset.code)));
  qsa("button[data-act=edit]",el.patientsList).forEach(b=>b.addEventListener("click",()=>openRecordEditor("patients_baseline",b.dataset.id)));
  // bind row actions
  qsa("button[data-act='token']", el.patientsList).forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      const tr = e.target.closest("tr");
      const pcode = tr?.getAttribute("data-pcode");
      if (pcode){
        if(busyButtons.size)return toast("正在保存，请完成后再切换患者。");
        if(!confirm(`选择患者 ${pcode}，并清空各录入区未保存内容？`))return;
        const savedPatients=patients;clearProjectWorkspace();patients=savedPatients;renderPatients();
        el.tokenPatientCode.value = pcode;
        if (el.varPatientCode) el.varPatientCode.value = pcode;
        if (el.labPatientCode) el.labPatientCode.value = pcode;
        if (el.medPatientCode) el.medPatientCode.value = pcode;
        if (el.evtPatientCode) el.evtPatientCode.value = pcode;
        toast("已填入研究编号（链接/基因/化验/用药/事件各栏）");
        el.tokenOut.style.display = "none";
        loadExtras();loadIssueSummary();loadExistingTokens();
      }
    });
  });
  applyProjectAccess();
}

function v(x){
  if (x === null || x === undefined || x === "") return "";
  return String(x);
}

async function createPatientBaseline(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.patCode.value.trim();
  if (!patient_code) return toast("请输入 patient_code");

  const birth_year = el.patBirthYear.value ? Number(el.patBirthYear.value) : null;
  if (birth_year !== null){
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(birth_year) || birth_year < 1900 || birth_year > thisYear){
      return toast(`出生年份无效（应为 1900–${thisYear}）`);
    }
  }

  let scr,upcr,baselineDate;
  try{scr=finiteNumber(el.patBaselineScr.value,'基线 Scr',{min:0.01,max:3000});upcr=normalizeUpcr(el.patBaselineUpcr.value,el.patBaselineUpcrUnit.value);baselineDate=strictDate(el.patBaselineDate.value,'基线日期');assertNoPII(patient_code,'研究编号');}catch(e){return toast(e.message);}
  if(!confirm(`确认保存患者 ${patient_code} 到 ${op.project.name}？\nScr：${scr??'未填'} μmol/L；UPCR：${upcr??'未填'} mg/g`))return;
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
    toast("已保存患者基线，下一例表单已清空");
    resetBaseline();
    await loadPatients();
  }catch(e){
    console.error(e);
    toast("保存失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn,false);
  }
}

// Token 状态标签渲染
// 四种状态：有效（绿）/ 已使用（蓝）/ 已撤销（红）/ 已过期（灰）
function tokenStatusBadge(t){
  const now = new Date();
  if (t.revoked_at) return `<span class="issue-badge issue-critical">已撤销</span>`;
  if (t.expires_at && new Date(t.expires_at) < now) return `<span class="issue-badge" style="background:#e2e8f0;color:#475569">已过期</span>`;
  if (t.single_use && t.used_at) return `<span class="issue-badge issue-info">已使用</span>`;
  return `<span class="issue-badge issue-resolved">有效</span>`;
}

function resolveAppBasePath(){
  const p = window.location.pathname || "/";
  // keep links stable when mounted under sub-paths like /c/, /app/, etc.
  const knownEntry = ["/staff", "/staff.html", "/patient.html", "/guide", "/guide.html"];
  for (const entry of knownEntry){
    if (p === entry || p.endsWith(entry)){
      const base = p.slice(0, -entry.length);
      return base || "";
    }
  }
  // default: directory of current page
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "";
}

function buildFollowupLinks(token){
  const origin = window.location.origin;
  const base = resolveAppBasePath();
  const encoded = encodeURIComponent(token);
  return {
    // rewrite-friendly short path (requires host rewrites to be configured)
    shortLink: `${origin}${base}/p/${encoded}`,
    // hash-based link: token is in the URL fragment (#), never sent to server,
    // invisible to Netlify routing and Supabase auth detection
    directLink: `${origin}${base}/followup#${encoded}`,
  };
}

async function loadExistingTokens(){
  const container=qs('#existingTokens');if(!container||!selectedProject)return;
  if(!canRevokeTokens()){container.textContent='仅负责人和录入协作人可以管理随访链接。';return;}
  const op=captureContext();container.textContent='正在读取随访链接…';
  try{
    const rows=await readAllRows(sb,'patient_tokens',op.project.id,()=>assertContext(op));const active=rows.filter(r=>!r.revoked_at).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    if(!active.length){container.textContent='暂无可撤销的随访链接。';return;}
    let page=0;const render=()=>{if(!currentContext(op))return;const pages=Math.ceil(active.length/30);
      container.innerHTML=`<h3>现有随访链接</h3><p>共 ${active.length} 条未撤销链接，第 ${page+1}/${pages} 页。仅显示研究编号与状态；如发错对象请立即撤销。</p><table class="table"><thead><tr><th>研究编号</th><th>到期日期</th><th>状态</th><th></th></tr></thead><tbody>${active.slice(page*30,(page+1)*30).map(r=>`<tr><td>${escapeHtml(r.patient_code)}</td><td>${escapeHtml(fmtDate(r.expires_at))}</td><td>${escapeHtml(r.active===false?'已停用':r.used_at&&r.single_use?'已使用':Date.parse(r.expires_at)<Date.now()?'已过期':r.single_use?'单次有效':'可多次使用')}</td><td><button class="btn small" data-revoke-id="${escapeHtml(r.id)}">撤销</button></td></tr>`).join('')}</tbody></table><div class="btnbar"><button class="btn small" data-tokens-prev ${page===0?'disabled':''}>上一页</button><button class="btn small" data-tokens-next ${page===pages-1?'disabled':''}>下一页</button></div>`;
      container.querySelector('[data-tokens-prev]').addEventListener('click',()=>{page--;render();});container.querySelector('[data-tokens-next]').addEventListener('click',()=>{page++;render();});
      container.querySelectorAll('[data-revoke-id]').forEach(b=>b.addEventListener('click',async()=>{
        const reason=prompt('请填写撤销原因，不含姓名或联系方式：');if(!reason?.trim())return;
        try{assertContext(op);if(!canRevokeTokens())throw new Error('没有撤销权限');assertNoPII(reason,'撤销原因');setBusy(b,true);const r=active.find(r=>r.id===b.dataset.revokeId);const {error}=await sb.rpc('revoke_patient_token',{p_token:r.token,p_revoke_reason:reason.trim()});if(error)throw error;assertContext(op);toast('链接已撤销');await loadExistingTokens();}catch(e){toast('撤销失败：'+registryErrorMessage(e));}finally{setBusy(b,false);}
      }));
    };render();
  }catch(e){if(currentContext(op))container.textContent='随访链接读取失败：'+registryErrorMessage(e);}
}

async function genToken(){
  if(!requireProjectCapability('can_manage_tokens'))return;
  if (!selectedProject) return toast("请先选择项目");
  const pcode = el.tokenPatientCode.value.trim();
  if (!pcode) return toast("请输入患者研究编号");
  const days = el.tokenDays.value ? Number(el.tokenDays.value) : 30;
  if(!Number.isInteger(days)||days<1||days>365)return toast("有效期须为1–365天");
  const op=captureContext();
  const singleUse = el.tokenSingleUse?.checked || false;

  const btn = el.btnGenToken;
  btn.dataset.label = "生成随访链接";
  setBusy(btn, true);
  try{
    // Step 1: create token (existing RPC)
    const { data, error } = await sb.rpc("create_patient_token_v2", {
      p_project_id: op.project.id,
      p_patient_code: pcode,
      p_expires_in_days: days,
      p_single_use: singleUse
    });
    if (error) throw error;
    assertContext(op);
    const token = data;
    loadExistingTokens();

    const { shortLink, directLink } = buildFollowupLinks(token);
    const expiryStr = days >= 3650 ? "长期有效" : `${days}天后过期`;
    const suStr = singleUse ? "（单次使用）" : "（可多次使用）";

    el.tokenOut.style.display = "block";
    el.tokenOut.innerHTML = `
      <div><b>随访链接已生成</b> ${tokenStatusBadge({revoked_at:null,expires_at:null,single_use:singleUse,used_at:null})}</div>
      <div class="small muted" style="margin-top:4px">
        有效期：${expiryStr} · ${suStr}<br>
        <b>Token</b>（令牌）是这串随机码的简称，患者或护士用下面的链接填随访，<b>无需登录账号</b>。
      </div>
      <div style="margin-top:8px;background:#f1f5f9;padding:8px;border-radius:6px;word-break:break-all;font-size:13px">
        <code>${escapeHtml(directLink)}</code>
      </div>
      <div class="small muted" style="margin-top:6px;word-break:break-all">
        短链接（需服务器支持重写）：<code>${escapeHtml(shortLink)}</code>
      </div>
      <div class="btnbar" style="margin-top:8px">
        <button class="btn small primary" id="btnCopyLink">复制链接</button>
        <button class="btn small" id="btnOpenPreview">打开随访页预览</button>
        <button class="btn small" style="border-color:#dc2626;color:#dc2626" id="btnRevokeToken">立即撤销此 token</button>
      </div>
      <div class="muted small" style="margin-top:6px">
        提示：链接泄露或发错患者时可点「立即撤销」，已提交的数据不受影响。
      </div>
    `;
    qs("#btnCopyLink", el.tokenOut).addEventListener("click", async ()=>{
      await navigator.clipboard.writeText(directLink);
      toast("已复制随访链接");
    });
    qs("#btnOpenPreview", el.tokenOut).addEventListener("click", ()=>{
      const win = window.open(directLink, "_blank", "noopener,noreferrer");
      if (!win) window.location.href = directLink;
    });
    qs("#btnRevokeToken", el.tokenOut).addEventListener("click", async ()=>{
      if(!currentContext(op)||!canRevokeTokens())return toast("项目上下文或撤销权限已变化");
      const reason = window.prompt("请填写撤销原因（必填，如：发错患者，重新生成）：");
      if (reason === null) return;  // 取消
      if (!reason.trim()) return toast("撤销原因不能为空");
      const { error: re } = await sb.rpc("revoke_patient_token", {
        p_token: token,
        p_revoke_reason: reason.trim()
      });
      if (re){ toast("撤销失败：" + re.message); return; }
      if(!currentContext(op))return;
      toast("已撤销此 token，链接立即失效");
      loadExistingTokens();
      el.tokenOut.querySelector("div > b").nextSibling?.replaceWith?.("");
      el.tokenOut.querySelector(".issue-resolved, .issue-info")?.outerHTML;
      // re-render badge
      const badge = el.tokenOut.querySelector("[class*='issue-badge']");
      if (badge) badge.outerHTML = `<span class="issue-badge issue-critical">已撤销</span>`;
    });
  }catch(e){
    console.error(e);
    toast("生成失败：" + registryErrorMessage(e));
  }finally{
    setBusy(btn, false);
  }
}


async function addVariant(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.varPatientCode?.value.trim();
  if (!patient_code) return toast("请填写基因记录的 patient_code");
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
    toast("添加失败：" + hint);
  }finally{
    setBusy(btn, false);
  }
}

async function addMed(){
  if(!requireProjectCapability('can_write'))return;
  if (!selectedProject) return toast("请先选择项目");
  const op=captureContext();
  const patient_code = el.medPatientCode?.value.trim();
  if (!patient_code) return toast("请填写用药记录的 patient_code");
  const drug_name = el.medName?.value.trim();
  if (!drug_name) return toast("请填写 drug_name");
  // Compose structured dose string: "2 mg bid PO"
  const doseVal = el.medDose?.value.trim() || "";
  const routeVal = el.medRoute?.value || "";
  const freqVal = el.medFrequency?.value || "";


  const payload = {
    project_id: op.project.id,
    patient_code,
    drug_name,
    drug_class: el.medClass?.value.trim() || null,
    dose: doseVal || null,
    route: routeVal || null,
    frequency: freqVal || null,
    start_date: el.medStart?.value || null,
    end_date: el.medEnd?.value || null
  };
  const btn = el.btnAddMed;
  btn.dataset.label = "添加用药记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("meds_long").insert(payload);
    if (error) throw error;
    assertContext(op);
    toast("已添加用药记录");
    if (el.medName) el.medName.value = "";
    if (el.medDose) el.medDose.value = "";
    if (el.medRoute) el.medRoute.value = "";
    if (el.medFrequency) el.medFrequency.value = "";
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
  if (!patient_code) return toast("请填写 patient_code");
  const event_type = el.evtType?.value;
  if (!event_type) return toast("请选择事件类型");
  const payload = {
    project_id: op.project.id,
    patient_code,
    event_type,
    event_date: el.evtDate?.value || null,
    confirmed: true,
    source: "manual",
    notes: el.evtNotes?.value.trim().slice(0, 500) || null,
  };
  const btn = el.btnAddEvent;
  btn.dataset.label = "录入终点事件";
  setBusy(btn, true);
  try{
    const { error } = await sb.from("events_long").insert(payload);
    if (error) throw error;
    assertContext(op);
    toast("已录入终点事件");
    if (el.evtDate) el.evtDate.value = "";
    if (el.evtNotes) el.evtNotes.value = "";
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
patients_baseline:['sex','birth_year','baseline_date','baseline_scr','baseline_upcr','baseline_upcr_unit','baseline_upcr_raw','baseline_upcr_original_unit','biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class','ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date','created_at','updated_at'],
visits_long:['visit_date','sbp','dbp','scr_umol_l','upcr','egfr','egfr_formula_version','notes','qc_reason','created_at','updated_at'],
labs_long:['lab_date','lab_test_code','lab_name','value_raw','unit_symbol','value_standard','standard_unit','lab_value','lab_unit','measured_at','qc_reason','created_at','updated_at'],
meds_long:['drug_name','drug_class','dose','route','frequency','start_date','end_date','created_at','updated_at'],
variants_long:['test_date','test_name','gene','variant','hgvs_c','hgvs_p','transcript','zygosity','classification','lab_name','notes','created_at','updated_at'],
events_long:['event_type','event_date','confirmed','source','notes','created_at','updated_at'],
ktx_baseline_ext:['transplant_date','donor_type','induction_therapy','maintenance_immuno','hla_mismatch_count','pra_status','dsa_status','dsa_titer','baseline_creatinine','baseline_egfr','created_at','updated_at'],
ktx_visits_ext:['visit_date','tac_trough','csa_trough','weight_kg','infection_event','rejection_event','biopsy_banff','graft_failure_date','death_date','return_to_dialysis','return_to_dialysis_date','created_at','updated_at']
};

async function exportTable(kind){
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
    if(log.error)throw new Error('导出审计写入失败：'+log.error.message);
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
    el.snapshotOut.style.display='block';el.snapshotOut.textContent=`数据版本 ${frozen.snapshot_id} 已冻结，SHA-256：${frozen.content_sha256}。可从版本列表重新下载相同内容。`;await loadSnapshots();
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
  if(error){el.snapshotsList.textContent='读取批次记录失败：'+error.message;return;}
  if(!data?.length){el.snapshotsList.textContent='暂无导出批次记录。';return;}
  el.snapshotsList.innerHTML=`<p class="muted small">真实冻结版本可重新下载相同JSON；旧批次记录仅有说明与数量。</p><table class="table"><thead><tr><th>版本编号</th><th>日期</th><th>类型</th><th>操作</th></tr></thead><tbody>${data.map(r=>{const frozen=String(r.notes||'').includes('frozen_export_v2');return `<tr><td>${escapeHtml(r.snapshot_id)}</td><td>${escapeHtml(fmtDate(r.created_at))}</td><td>${frozen?'已冻结数据':'旧元数据记录'}</td><td>${frozen?`<button class="btn small" data-frozen-id="${escapeHtml(r.id)}">下载已冻结JSON</button>`:'不能恢复原始内容'}</td></tr>`;}).join('')}</tbody></table>`;
  qsa('[data-frozen-id]',el.snapshotsList).forEach(b=>b.addEventListener('click',()=>downloadFrozenVersion(b.dataset.frozenId)));
}

const SEVERITY_LABEL={critical:'严重',warning:'警告',info:'提示'};
let issuePage=0;
async function loadIssueSummary(){
  if(!selectedProject||!el.issueSummary)return;const op=captureContext();
  const {data,error}=await sb.rpc('get_issue_summary',{p_project_id:op.project.id});if(!currentContext(op))return;
  if(error||!data){el.issueSummary.textContent='质控状态读取失败，请刷新重试；当前不能判断是否存在问题。';return;}
  el.issueSummary.textContent=`待处理 ${Number(data.total_open||0)+Number(data.total_in_prog||0)} 条；已修正 ${data.total_resolved||0} 条；接受不修复 ${data.total_wontfix||0} 条。接受不修复不代表原始数据已更正。`;
}
async function loadIssues(page=0){
  if(!selectedProject||!el.issueList)return;const op=captureContext();issuePage=Number.isInteger(page)?page:0;const requestedPage=issuePage;
  el.issueList.textContent='正在读取全部质控记录…';
  try{
    const all=await readAllRows(sb,'data_issues',op.project.id,()=>assertContext(op));
    const rows=all.filter(r=>!['RESOLVED','WONT_FIX'].includes(r.status)).sort((a,b)=>({critical:0,warning:1,info:2}[a.severity]-{critical:0,warning:1,info:2}[b.severity])||String(b.created_at).localeCompare(a.created_at));
    if(requestedPage!==issuePage)return;
    if(!rows.length){el.issueList.textContent='当前没有未解决的质控问题。仍需核对数据来源、单位和研究方案。';return;}
    const pages=Math.ceil(rows.length/50);issuePage=Math.min(issuePage,pages-1);const visible=rows.slice(issuePage*50,issuePage*50+50);
    el.issueList.innerHTML=`<p>未解决共 ${rows.length} 条，第 ${issuePage+1}/${pages} 页</p><table class="table"><thead><tr><th>等级</th><th>研究编号</th><th>问题与说明</th><th>操作</th></tr></thead><tbody>${visible.map(r=>`<tr><td>${escapeHtml(SEVERITY_LABEL[r.severity]||r.severity)}</td><td>${escapeHtml(r.patient_code)}</td><td><b>${escapeHtml(r.rule_code)}</b><br>${escapeHtml(r.message??'')}</td><td><button class="btn small" data-project-capability="can_write" data-correct-id="${escapeHtml(r.id)}">核对原记录</button><button class="btn small" data-project-capability="can_write" data-wontfix-id="${escapeHtml(r.id)}">接受不修复</button></td></tr>`).join('')}</tbody></table><div class="btnbar"><button class="btn" id="issuePrev" ${issuePage===0?'disabled':''}>上一页</button><button class="btn" id="issueNext" ${issuePage===pages-1?'disabled':''}>下一页</button></div>`;
    applyProjectAccess();
    qs('#issuePrev',el.issueList)?.addEventListener('click',()=>loadIssues(issuePage-1));qs('#issueNext',el.issueList)?.addEventListener('click',()=>loadIssues(issuePage+1));
    qsa('[data-correct-id]',el.issueList).forEach(b=>b.addEventListener('click',async()=>{if(!currentContext(op))return;const r=visible.find(x=>x.id===b.dataset.correctId),table=({visit:'visits_long',lab:'labs_long',baseline:'patients_baseline'})[r.record_type];if(!table)return toast('该记录类型需由负责人按原始资料核对；当前不支持自动更正。');
      let id=r.record_id;if(!id&&table==='patients_baseline'){const p=patients.find(p=>p.patient_code===r.patient_code);id=p?.id;}if(!id)return toast('尚无可更正的原始记录，请先按研究编号补录并重新校验。');await openRecordEditor(table,id);
    }));
    qsa('[data-wontfix-id]',el.issueList).forEach(b=>b.addEventListener('click',async()=>{if(!requireProjectCapability('can_write'))return;const reason=prompt('请说明经核对接受此问题的理由。原始数据不会被自动更正：');if(!reason?.trim())return;
      setBusy(b,true);try{assertContext(op);const {error}=await sb.rpc('close_issue_wont_fix',{p_issue_id:b.dataset.wontfixId,p_resolution:reason.trim()});if(error)throw error;assertContext(op);await Promise.all([loadIssues(issuePage),loadIssueSummary()]);}catch(e){toast('处理失败：'+registryErrorMessage(e));}finally{setBusy(b,false);}
    }));
  }catch(e){if(currentContext(op))el.issueList.textContent='质控读取失败：'+registryErrorMessage(e);}
}
window._editRegistryRecord=(table,id)=>openRecordEditor(table,id);
const EDIT_FIELDS={
  patients_baseline:['sex','birth_year','baseline_date','baseline_scr','baseline_upcr','biopsy_date','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_biopsy_date','ln_class','ln_activity_index','ln_chronicity_index','ln_podocytopathy','treatment_arm','randomization_id','randomization_date'],
  visits_long:['visit_date','sbp','dbp','scr_umol_l','upcr','notes'],
  labs_long:['lab_date','lab_test_code','value_raw','unit_symbol']
};
const EDIT_LABELS={sex:'性别 M/F',birth_year:'出生年份',baseline_date:'基线日期',baseline_scr:'基线肌酐 μmol/L',baseline_upcr:'基线UPCR原始化验值',visit_date:'随访日期',sbp:'收缩压 mmHg',dbp:'舒张压 mmHg',scr_umol_l:'肌酐 μmol/L',upcr:'UPCR mg/g',notes:'备注（不含身份信息）',lab_date:'化验日期',lab_test_code:'化验目录代码',value_raw:'原始化验值',unit_symbol:'原始化验单位',biopsy_date:'肾穿日期',ln_biopsy_date:'LN肾穿日期',ln_class:'LN病理分型',ln_activity_index:'LN活动指数',ln_chronicity_index:'LN慢性指数',ln_podocytopathy:'足细胞病 true/false',treatment_arm:'研究分组',randomization_id:'分组记录编号',randomization_date:'分组日期'};
const EDIT_NUMBERS=new Set(['birth_year','baseline_scr','baseline_upcr','oxford_m','oxford_e','oxford_s','oxford_t','oxford_c','ln_activity_index','ln_chronicity_index','sbp','dbp','scr_umol_l','upcr','value_raw']);
async function openVisitHistory(patientCode){
  const op=captureContext();
  try{
    const rows=await readAllRows(sb,'visits_long',op.project.id,()=>assertContext(op),500,{patient_code:patientCode});
    rows.sort((a,b)=>String(b.visit_date).localeCompare(String(a.visit_date)));assertContext(op);
    const overlay=document.createElement('div');overlay.dataset.registryModal='history';overlay.style.cssText='position:fixed;inset:0;background:#102d46aa;z-index:8900;display:grid;place-items:center;padding:16px';
    let page=0;const render=()=>{
      const pages=Math.max(1,Math.ceil(rows.length/30));
      overlay.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="historyTitle" style="background:white;color:#102d46;padding:24px;border-radius:16px;max-width:900px;width:100%;max-height:90vh;overflow:auto"><h2 id="historyTitle">随访记录 · ${escapeHtml(patientCode)}</h2><p>${escapeHtml(op.project.name)} · 共 ${rows.length} 条，第 ${page+1}/${pages} 页。请对照原始资料更正，所有更正均需说明原因。</p><div style="overflow:auto"><table class="table"><thead><tr><th>日期</th><th>血压</th><th>Scr μmol/L</th><th>UPCR mg/g</th><th>eGFR</th><th></th></tr></thead><tbody>${rows.slice(page*30,(page+1)*30).map(r=>`<tr><td>${escapeHtml(r.visit_date)}</td><td>${escapeHtml(r.sbp??'—')}/${escapeHtml(r.dbp??'—')}</td><td>${escapeHtml(r.scr_umol_l??'—')}</td><td>${escapeHtml(r.upcr??'—')}</td><td>${escapeHtml(r.egfr??'—')}</td><td><button class="btn small" data-project-capability="can_write" data-visit-id="${escapeHtml(r.id)}">核对 / 更正</button></td></tr>`).join('')}</tbody></table></div>${!rows.length?'<p>尚无随访记录。</p>':''}<div class="btnbar"><button class="btn" data-history-prev ${page===0?'disabled':''}>上一页</button><button class="btn" data-history-next ${page===pages-1?'disabled':''}>下一页</button><button class="btn" data-history-close>关闭</button></div></section>`;
      overlay.querySelector('[data-history-close]').addEventListener('click',()=>overlay.remove());
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
    overlay.innerHTML=`<section role="dialog" aria-modal="true" aria-labelledby="editTitle" style="background:white;color:#102d46;padding:24px;border-radius:16px;max-width:760px;width:100%;max-height:90vh;overflow:auto"><h2 id="editTitle">核对并更正 · ${escapeHtml(record.patient_code)}</h2><p>${escapeHtml(op.project.name)} · ${escapeHtml(table)}。研究编号不能修改；更正原因与前后值会留痕。</p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">${EDIT_FIELDS[table].map(k=>`<div><label for="edit_${k}">${escapeHtml(EDIT_LABELS[k]||k)}</label><input id="edit_${k}" data-field="${k}" type="${k.endsWith('_date')?'date':EDIT_NUMBERS.has(k)?'number':'text'}" ${EDIT_NUMBERS.has(k)?'step="any"':''} value="${escapeHtml(original[k]??'')}"/></div>`).join('')}</div>${table==='patients_baseline'?`<label for="edit_upcr_unit">基线UPCR原始单位（历史未确认的记录请按原始报告核对）</label><select id="edit_upcr_unit"><option value="">未确认</option><option value="mg/g" ${record.baseline_upcr_original_unit==='mg/g'?'selected':''}>mg/g</option><option value="g/g" ${record.baseline_upcr_original_unit==='g/g'?'selected':''}>g/g</option></select>`:''}<label for="editReason">更正原因（必填，不含身份信息）</label><textarea id="editReason" placeholder="说明原始资料依据及更正原因"></textarea><div id="editFeedback" role="status"></div><div class="btnbar"><button class="btn primary" id="editSave">核对变更并保存</button><button class="btn" id="editCancel">取消</button></div></section>`;
    document.body.appendChild(overlay);qs('#editCancel',overlay).addEventListener('click',()=>overlay.remove());
    qs('#editSave',overlay).addEventListener('click',async()=>{
      const btn=qs('#editSave',overlay),feedback=qs('#editFeedback',overlay);try{
        assertContext(op);const reason=qs('#editReason',overlay).value.trim();if(!reason)throw new Error('请填写更正原因');assertNoPII(reason,'更正原因');const changes={};
        qsa('[data-field]',overlay).forEach(input=>{const key=input.dataset.field,value=input.value.trim();if(value===String(original[key]??''))return;
          changes[key]=key.endsWith('_date')?strictDate(value,EDIT_LABELS[key]||key):EDIT_NUMBERS.has(key)?finiteNumber(value,EDIT_LABELS[key]||key):value||null;
          if(key==='ln_podocytopathy'&&value){if(!['true','false'].includes(value))throw new Error('足细胞病须为true或false');changes[key]=value==='true';}
        });
        if(changes.notes)assertNoPII(changes.notes,'备注');
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
        if(error)throw error;assertContext(op);if(!data?.record)throw new Error('服务器未返回更正记录');overlay.remove();toast('更正已保存并留痕，请查看重新校验后的质控状态');await Promise.all([loadPatients(),loadExtras(),loadIssueSummary(),loadIssues()]);
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
    const assetNames=['run_analysis.py','merge_centers.py','requirements.txt','METHODS_TEMPLATE_EN.md','README_PACK.md'];
    const assets=await Promise.all(assetNames.map(readAsset));assertContext(op);
    const metaRecord=frozen;
    const zip=new JSZip(),files={},counts={};
    for(const [table,rows] of Object.entries(tables)){
      files[`analysis/data/${table}.csv`]='\ufeff'+toCsv(rows,exportColumns(rows,[...COMMON_EXPORT_COLUMNS,...(EXPORT_FIELDS[table]||[])]),{spreadsheetSafe:false});
      files[`excel_safe/${table}.csv`]='\ufeff'+toCsv(rows,exportColumns(rows,[...COMMON_EXPORT_COLUMNS,...(EXPORT_FIELDS[table]||[])]));counts[table]=rows.length;
    }
    files['analysis/run_analysis.py']=assets[0];files['analysis/merge_centers.py']=assets[1];files['analysis/requirements.txt']=assets[2];
    files['analysis/METHODS_TEMPLATE_EN.md']=assets[3];files['analysis/README.md']=assets[4].replaceAll('{{PROJECT_NAME}}',op.project.name).replaceAll('{{EXPORT_DATE}}',fmtDate(new Date()));
    // JSON preserves exact raw strings/types independently of spreadsheet-safe CSV escaping.
    files['research_data.json']=frozen.content_text;
    files['qc_issues.csv']='\ufeff'+toCsv(issues,exportColumns(issues,['id','project_id','patient_code','record_type','record_id','rule_code','severity','status','message','resolution_note']));
    files['qc_summary.json']=JSON.stringify({...calcQcSummary(tables.visits_long),open_issues:issues.filter(r=>!['RESOLVED','WONT_FIX'].includes(r.status)).length,resolved:issues.filter(r=>r.status==='RESOLVED').length,accepted_without_fix:issues.filter(r=>r.status==='WONT_FIX').length},null,2);
    files['data_dictionary.json']=JSON.stringify({schema_version:frozen.schema_version,identity_key:['project_id','center_code','patient_code'],record_key:'id',baseline_upcr:'Canonical mg/g only if baseline_upcr_unit is mg/g. Historical missing units require review; do not infer scale.',baseline_scr:'umol/L',visits:{scr_umol_l:'umol/L',upcr:'mg/g',egfr:'Derived per egfr_formula_version; verify provenance'},labs:'Raw value/unit and standard value/unit are separate columns.',missing:'null/empty = unknown or not collected; zero is a value.',csv:'analysis/data CSV preserves exact text for scripts. Use excel_safe CSV when opening in spreadsheets. research_data.json is the exact frozen server content.'},null,2);
    files['README.md']=['# 科研数据与分析脚本包',`项目：${op.project.name}`,`中心：${op.project.center_code}`,'','这是导出的数据与可运行脚本，不是已完成的统计结果或论文。请先核对字段、单位与缺失，再按 analysis/README.md 运行分析。','数据来自同一次数据库一致性读取，服务器保存不可变版本；research_data.json保留原始冻结字节，可按SHA-256核对。','本ZIP每个文件的SHA-256记录于export_manifest.json。版本列表可重新下载冻结JSON；旧元数据批次不具有此能力。','analysis/data里的CSV供分析脚本使用并保留原始文字，不应直接双击用Excel打开。请用excel_safe目录下做过公式文本防护的CSV供Excel查看。请仅在已批准的协作范围内分享。'].join('\n');
    const manifest={format:'registry-export-v3',project_id:op.project.id,center_code:op.project.center_code,exported_at:new Date().toISOString(),metadata_register_id:metaRecord?.snapshot_id||null,consistency:frozen.consistency,source_content_sha256:frozen.content_sha256,counts,files:{}};
    for(const [name,content]of Object.entries(files)){manifest.files[name]={sha256:await sha256Text(content),utf8_bytes:new TextEncoder().encode(content).length};zip.file(name,content);}
    zip.file('export_manifest.json',JSON.stringify(manifest,null,2));
    const filename=`registry_analysis_${op.project.name.replace(/[^\w\u4e00-\u9fa5-]+/g,'_').slice(0,40)}_${fmtDate(new Date())}.zip`;
    const audit=await sb.rpc('log_project_audit',{p_project_id:op.project.id,p_action:'paper_package',p_snapshot_id:metaRecord?.snapshot_id||null,p_details:{zip_name:filename,counts,manifest_sha256:await sha256Text(JSON.stringify(manifest))}});
    if(audit.error)throw new Error('导出审计记录失败：'+audit.error.message);
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
      el.profileStatus.textContent = "请完善资料";
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
    el.profileStatus.textContent = hasCore ? "已填写" : "资料不完整";
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
  if (error){ toast("操作失败：" + error.message); return; }
  toast(`已延长 ${days} 天`);
  adminSearch();
}

async function adminPartner(projectId){
  if (!confirm("设为合作伙伴（长期免费）？")) return;
  const { error } = await sb.rpc("admin_set_partner", { p_project_id: projectId });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已设为合作伙伴");
  adminSearch();
}

async function adminReset(projectId){
  if (!confirm("撤回人工授权并重新计算账户权益？原试用期限和独立付费订单保持有效规则。")) return;
  const { error } = await sb.rpc("admin_reset_to_trial", { p_project_id: projectId });
  if (error){ toast("操作失败：" + error.message); return; }
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
      套餐：<b>${data.plan || data.apply_plan}</b>
      ${data.annual_price_cny ? `· 协议价：<b>¥${data.annual_price_cny}/年</b>` : ""}
      ${data.admin_note ? `<br/>备注：${escapeHtml(data.admin_note)}` : ""}
    </div>`;
  } else if (data.status === "approved" && data.payment_status === "paid"){
    extra = `<div class="infobox" style="margin-top:8px">
      权益已激活，到期：<b>${data.expires_at ? fmtDate(data.expires_at) : "—"}</b>
    </div>`;
  } else if (data.status === "rejected"){
    extra = `<div class="warnbox" style="margin-top:8px">
      申请未通过。${data.admin_note ? `原因：${escapeHtml(data.admin_note)}` : ""}
      <br/><a href="#" onclick="resetContractForm(event)" style="color:inherit">重新申请</a>
    </div>`;
  }

  c.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
    <span class="${s.cls}">${s.text}</span>
    <span class="muted small">申请套餐：${data.apply_plan}
      · 提交于 ${fmtDate(data.applied_at)}</span>
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
      `<span class="muted small" style="color:#c0392b">加载失败：${escapeHtml(error.message)}</span>`;
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
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已批准，等待用户付款");
  adminLoadContracts();
}

async function adminRejectContractPrompt(cid){
  const note = prompt("拒绝原因（可选，用户可见）：") ?? null;
  if (note === null) return; // cancelled
  const { error } = await sb.rpc("admin_reject_contract", {
    p_contract_id: cid, p_admin_note: note || null
  });
  if (error){ toast("操作失败：" + error.message); return; }
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
  if (error){ toast("操作失败：" + error.message); return; }
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
  if (error){ toast("操作失败：" + error.message); return; }
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
  if (error){ toast("操作失败：" + error.message); return; }
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
  if (error){ toast("操作失败：" + error.message); return; }
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
      `<span class="muted small" style="color:#c0392b">加载失败：${escapeHtml(error.message)}</span>`;
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
    if (error){ toast("操作失败：" + error.message); return; }
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
    if (error){ toast("操作失败：" + error.message); return; }
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
  const {error}=await sb.rpc('admin_set_invoice_status',{p_order_id:orderId,p_status:status});if(error)return toast('发票状态更新失败：'+error.message);toast('发票状态已更新');await adminLoadOrders();
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
let _importParsed=null;
const IMPORT_TEMPLATES={
  baseline:{filename:'template_patients_baseline.csv',columns:BASELINE_IMPORT_FIELDS,example:{patient_code:'0001',sex:'F',birth_year:'1985',baseline_date:'2026-09-01',baseline_scr:'88.4',baseline_upcr:'500',baseline_upcr_unit:'mg/g'}},
  visits:{filename:'template_visits_long.csv',columns:VISIT_IMPORT_FIELDS,example:{patient_code:'0001',visit_date:'2026-09-14',sbp:'128',dbp:'78',scr_umol_l:'92',upcr:'450'}}
};
function downloadImportTemplate(){const t=IMPORT_TEMPLATES[el.importType.value];if(t)downloadCsvUtf8Bom(t.filename,toCsv([t.example],t.columns));}
async function handleImportFile(evt){
  if(!requireProjectCapability('can_write'))return;
  _importParsed=null;el.importPreview.style.display='none';
  const file=evt.target.files?.[0];if(!file)return;if(!selectedProject)return toast('请先选择项目');
  const op=captureContext(),type=el.importType.value;
  if(file.size>2*1024*1024)return toast('单次 CSV 不超过2MB、500行，请分为明确的导入批次。');
  try{
    const {headers,data}=parseRegistryCsv(await file.text());assertContext(op);
    if(data.length>500)throw new Error('单次最多500行，防止浏览器中断；请分批准备文件');
    const unit=qs('#importBaselineUnit')?.value||'';
    const results=data.map((row,i)=>{try{assertNoPII(row.patient_code,'研究编号');if(row.notes)assertNoPII(row.notes,'备注');return {row:i+2,ok:true,data:normalizeImportRow(type,row,unit)};}catch(e){return {row:i+2,ok:false,error:e.message,data:row};}});
    const errors=results.filter(r=>!r.ok);
    _importParsed={op,type,results,batchId:crypto.randomUUID(),filename:file.name};
    el.importSummary.textContent=`目标：${op.project.name} / ${op.project.center_code}。${results.length} 行，${errors.length} 行需修正。整批成功或整批拒绝；基线未提供/空白字段保持原值。以下显示前20行及所有错误。`;
    const preview=results.slice(0,20), cols=[...new Set(preview.flatMap(r=>Object.keys(r.data)))];
    el.importTable.innerHTML=`${errors.length?`<div class="warnbox">${errors.map(r=>`第${r.row}行：${escapeHtml(r.error)}`).join('<br>')}</div>`:''}<div style="overflow:auto"><table class="table"><thead><tr><th>行号</th>${cols.map(c=>`<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${preview.map(r=>`<tr><td>${r.row}${r.ok?'':' ✗'}</td>${cols.map(c=>`<td>${escapeHtml(r.data[c]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    el.btnConfirmImport.disabled=!!errors.length;el.importPreview.style.display='block';el.importProgress.style.display='none';
  }catch(e){_importParsed=null;toast('无法预览：'+registryErrorMessage(e));}
}
async function confirmImport(){
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
    await Promise.all([loadPatients(),loadExtras(),loadIssueSummary()]);
  }catch(e){if(batch&&currentContext(batch.op)){el.importProgress.style.display='block';el.importProgress.textContent=`未确认完成：${e.message}。批次 ${batch.batchId} 已保留，可修复连接后重试；不要改用新批次重复提交。`;}toast('导入未完成：'+registryErrorMessage(e));}
  finally{setBusy(btn,false);}
}

init();
