import { supabase } from "/lib/supabase-client.js";
import { qs, qsa, toast, toCsv, downloadCsvUtf8Bom, fmtDate, daysLeft, humanNumber, escapeHtml } from "/lib/utils.js";

const sb = supabase();

const el = {
  loginCard: qs("#loginCard"),
  appCard: qs("#appCard"),
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

  projName: qs("#projName"),
  projCenter: qs("#projCenter"),
  projModule: qs("#projModule"),
  projDesc: qs("#projDesc"),
  btnCreateProject: qs("#btnCreateProject"),
  projectsList: qs("#projectsList"),
  projectMeta: qs("#projectMeta"),
  trialBadge:  qs("#trialBadge"),
  upgradeBtn:  qs("#upgradeBtn"),

  patCode: qs("#patCode"),
  patSex: qs("#patSex"),
  patBirthYear: qs("#patBirthYear"),
  patBaselineDate: qs("#patBaselineDate"),
  patBaselineScr: qs("#patBaselineScr"),
  patBaselineUpcr: qs("#patBaselineUpcr"),
  iganPathBox: qs("#iganPathBox"),
  biopsyDate: qs("#biopsyDate"),
  mestM: qs("#mestM"),
  mestE: qs("#mestE"),
  mestS: qs("#mestS"),
  mestT: qs("#mestT"),
  mestC: qs("#mestC"),
  rctArm: qs("#rctArm"),
  rctRandomId: qs("#rctRandomId"),
  rctDate: qs("#rctDate"),
  btnCreatePatient: qs("#btnCreatePatient"),
  patientsList: qs("#patientsList"),

  tokenPatientCode: qs("#tokenPatientCode"),
  tokenDays: qs("#tokenDays"),
  tokenSingleUse: qs("#tokenSingleUse"),
  btnGenToken: qs("#btnGenToken"),
  tokenOut: qs("#tokenOut"),
  issuePanel: qs("#issuePanel"),
  issueSummary: qs("#issueSummary"),
  issueList: qs("#issueList"),
  btnLoadIssues: qs("#btnLoadIssues"),


  // Optional extra data entry
  varPatientCode: qs("#varPatientCode"),
  varTestDate: qs("#varTestDate"),
  varTestName: qs("#varTestName"),
  varGene: qs("#varGene"),
  varVariant: qs("#varVariant"),
  varHgvsC: qs("#varHgvsC"),
  varHgvsP: qs("#varHgvsP"),
  varZygosity: qs("#varZygosity"),
  varClass: qs("#varClass"),
  varLabName: qs("#varLabName"),
  varNotes: qs("#varNotes"),
  btnAddVariant: qs("#btnAddVariant"),
  variantsPreview: qs("#variantsPreview"),

  labPatientCode: qs("#labPatientCode"),
  labDate: qs("#labDate"),
  labTestCode: qs("#labTestCode"),
  labName: qs("#labName"),
  labValue: qs("#labValue"),
  labUnit: qs("#labUnit"),
  labStdValue: qs("#labStdValue"),
  labQcReasonCol: qs("#labQcReasonCol"),
  labQcReason: qs("#labQcReason"),
  labHint: qs("#labHint"),
  btnAddLab: qs("#btnAddLab"),
  labsPreview: qs("#labsPreview"),

  medPatientCode: qs("#medPatientCode"),
  medName: qs("#medName"),
  medClass: qs("#medClass"),
  medDose: qs("#medDose"),
  medStart: qs("#medStart"),
  medEnd: qs("#medEnd"),
  btnAddMed: qs("#btnAddMed"),
  medsPreview: qs("#medsPreview"),

  // Events
  evtPatientCode: qs("#evtPatientCode"),
  evtType: qs("#evtType"),
  evtDate: qs("#evtDate"),
  evtNotes: qs("#evtNotes"),
  btnAddEvent: qs("#btnAddEvent"),
  eventsPreview: qs("#eventsPreview"),

  btnExportBaseline: qs("#btnExportBaseline"),
  btnExportVisits: qs("#btnExportVisits"),
  btnExportLabs: qs("#btnExportLabs"),
  btnExportMeds: qs("#btnExportMeds"),
  btnExportVariants: qs("#btnExportVariants"),
  btnExportEvents: qs("#btnExportEvents"),

  btnPaperPack: qs("#btnPaperPack"),
  btnCreateSnapshot: qs("#btnCreateSnapshot"),
  btnPaperPackWithSnapshot: qs("#btnPaperPackWithSnapshot"),
  btnRefreshSnapshots: qs("#btnRefreshSnapshots"),
  snapshotOut: qs("#snapshotOut"),
  snapshotsList: qs("#snapshotsList"),

  // Profile
  profileCard: qs("#profileCard"),
  profileStatus: qs("#profileStatus"),
  profName: qs("#profName"),
  profHospital: qs("#profHospital"),
  profDept: qs("#profDept"),
  profPlan: qs("#profPlan"),
  profContact: qs("#profContact"),
  profNotes: qs("#profNotes"),
  btnSaveProfile: qs("#btnSaveProfile"),

  // Contract apply (user side)
  contractStatus: qs("#contractStatus"),
  contractApplyForm: qs("#contractApplyForm"),
  contractPlan: qs("#contractPlan"),
  contractNote: qs("#contractNote"),
  btnApplyContract: qs("#btnApplyContract"),

  // Admin panel
  adminCard: qs("#adminCard"),
  adminContractsBadge: qs("#adminContractsBadge"),
  adminContracts: qs("#adminContracts"),
  btnAdminLoadContracts: qs("#btnAdminLoadContracts"),
  adminSearchEmail: qs("#adminSearchEmail"),
  btnAdminSearch: qs("#btnAdminSearch"),
  adminResults: qs("#adminResults"),
};

let session = null;
let user = null;
let isPlatformAdmin = false;

let projects = [];
let selectedProject = null;
let patients = [];
let labCatalog = [];   // [{code, name_cn, module, is_core, standard_unit, display_note}]
let unitMap = {};      // { code: [{unit_symbol, is_standard, multiplier}] }

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
      + `请删除后重新保存。系统禁止录入任何可识别个人信息（PII）。`
    );
  }
}

function setLoginHint(msg){ el.loginHint.textContent = msg || ""; }

function setBusy(btn, busy){
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = !!busy;
  btn.textContent = busy ? "处理中…" : btn.dataset.label;
}

function getInputEmail(){
  return (el.email?.value || "").trim().toLowerCase();
}

function renderTrialBadge(p){
  const hide = () => {
    el.trialBadge.style.display = "none";
    if (el.upgradeBtn) el.upgradeBtn.style.display = "none";
  };
  if (!p){ hide(); return; }

  const exp          = p.trial_expires_at;
  const grace        = p.trial_grace_until;
  const subPlan      = p.subscription_plan || "trial";
  const subUntil     = p.subscription_active_until;
  const WARN_DAYS    = 14;   // show upgrade CTA this many days before trial end

  // Build upgrade href from CONFIG
  const upgradeHref =
    (window.CONFIG?.UPGRADE_URL) ||
    (window.CONFIG?.UPGRADE_EMAIL ? `mailto:${window.CONFIG.UPGRADE_EMAIL}?subject=KidneySphere升级订阅` : null);

  const showUpgrade = (label = "立即升级") => {
    if (!el.upgradeBtn) return;
    if (upgradeHref){
      el.upgradeBtn.href = upgradeHref;
      el.upgradeBtn.textContent = label;
      el.upgradeBtn.style.display = "inline-flex";
    } else {
      // No link configured — show a subtle hint inside the badge instead
      el.upgradeBtn.style.display = "none";
    }
  };

  let cls = "badge";
  let txt = "试用未配置";
  if (el.upgradeBtn) el.upgradeBtn.style.display = "none";

  // ── 状态 1：付费订阅 / 合作伙伴有效 ──────────────────────────────────────
  if (subPlan !== "trial") {
    const paidActive = !subUntil || new Date(subUntil) > new Date();
    if (paidActive) {
      const planLabel = subPlan === "institution" ? "机构版"
                      : subPlan === "partner"      ? "合作伙伴"
                      : "Pro";
      const isPermanent = subPlan === "partner" && subUntil &&
                          new Date(subUntil).getFullYear() >= 2099;
      cls = "badge ok";
      txt = isPermanent
        ? `${planLabel}（长期免费）`
        : subUntil
          ? `${planLabel} 已订阅（到期 ${fmtDate(subUntil)}）`
          : `${planLabel} 已订阅`;
      el.trialBadge.className = cls;
      el.trialBadge.textContent = txt;
      el.trialBadge.style.display = "inline-flex";
      return;
    }
    // Paid plan expired — fall through to trial check
  }

  if (!exp){ hide(); return; }

  const left      = daysLeft(exp);
  const graceLeft = grace ? daysLeft(grace) : null;

  // ── 状态 2：试用中（剩余 > 14 天）──────────────────────────────────────
  if (left > WARN_DAYS){
    cls = "badge ok";
    txt = `试用中：剩余 ${left} 天（到期 ${fmtDate(exp)}）`;

  // ── 状态 3：试用即将到期（0–14 天）─────────────────────────────────────
  } else if (left >= 0){
    cls = "badge warn";
    txt = `试用将到期：剩余 ${left} 天`;
    showUpgrade("升级继续使用");

  // ── 状态 4：宽限期（试用到期，宽限未结束，只读）──────────────────────
  } else if (graceLeft !== null && graceLeft >= 0){
    cls = "badge warn";
    txt = `试用已到期（只读）：宽限剩余 ${graceLeft} 天`;
    showUpgrade("升级恢复写入");

  // ── 状态 5：完全到期，无订阅（只读）──────────────────────────────────
  } else {
    cls = "badge bad";
    txt = `试用已结束（只读）`;
    showUpgrade("订阅以恢复使用");
  }

  el.trialBadge.className = cls;
  el.trialBadge.textContent = txt;
  el.trialBadge.style.display = "inline-flex";
}

function showIganPathBox(){
  const mod = (selectedProject?.module || "").toUpperCase();
  el.iganPathBox.style.display = (mod === "IGAN") ? "block" : "none";
}

async function init(){
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
    session = s2;
    user = s2?.user || null;
    stateHandled = true;
    if (_event === "PASSWORD_RECOVERY"){
      showNewPasswordMode();
      return;
    }
    renderAuthState();
  });

  // getSession triggers PKCE code exchange; the listener above handles the result
  const { data: { session: s } } = await sb.auth.getSession();
  if (!stateHandled){
    // onAuthStateChange hasn't fired yet — render with whatever getSession returned
    session = s;
    user = s?.user || null;
    renderAuthState();
  }

  el.btnSendLink.addEventListener("click", sendMagicLink);
  el.btnRegister.addEventListener("click", registerAccount);
  el.btnResetPwd.addEventListener("click", resetPassword);
  el.btnSetNewPwd?.addEventListener("click", setNewPassword);
  el.btnSignOut.addEventListener("click", async ()=>{
    await sb.auth.signOut();
    toast("已退出登录");
  });

  el.btnCreateProject.addEventListener("click", createProject);
  el.btnCreatePatient.addEventListener("click", createPatientBaseline);
  el.btnGenToken.addEventListener("click", genToken);

  // optional extra data entry
  el.btnAddVariant?.addEventListener("click", addVariant);
  el.btnAddLab?.addEventListener("click", addLab);
  el.btnAddMed?.addEventListener("click", addMed);
  el.btnAddEvent?.addEventListener("click", addEvent);

  el.btnExportBaseline.addEventListener("click", ()=>exportTable("baseline"));
  el.btnExportVisits.addEventListener("click", ()=>exportTable("visits"));
  el.btnExportLabs.addEventListener("click", ()=>exportTable("labs"));
  el.btnExportMeds.addEventListener("click", ()=>exportTable("meds"));
  el.btnExportVariants.addEventListener("click", ()=>exportTable("variants"));
  el.btnExportEvents?.addEventListener("click", ()=>exportTable("events"));

  el.btnPaperPack.addEventListener("click", ()=>generatePaperPack({withSnapshot:false}));
  el.btnCreateSnapshot?.addEventListener("click", createSnapshotOnly);
  el.btnPaperPackWithSnapshot?.addEventListener("click", ()=>generatePaperPack({withSnapshot:true}));
  el.btnRefreshSnapshots?.addEventListener("click", loadSnapshots);

  el.btnSaveProfile?.addEventListener("click", saveProfile);
  el.btnApplyContract?.addEventListener("click", applyContract);

  el.btnAdminLoadContracts?.addEventListener("click", adminLoadContracts);
  el.btnAdminSearch?.addEventListener("click", adminSearch);
  el.adminSearchEmail?.addEventListener("keydown", e=>{ if(e.key==="Enter") adminSearch(); });

  // Lab catalog wiring
  el.labTestCode?.addEventListener("change", updateLabUnits);
  el.labValue?.addEventListener("input", updateLabStdValue);
  el.labUnit?.addEventListener("change", updateLabStdValue);

  // Issue panel
  el.btnLoadIssues?.addEventListener("click", loadIssues);

  // PII real-time detection on notes fields
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

  renderAuthState();
}

function renderAuthState(){
  if (!user){
    el.loginCard.style.display = "block";
    el.appCard.style.display = "none";
    if (el.profileCard) el.profileCard.style.display = "none";
    if (el.adminCard) el.adminCard.style.display = "none";
    el.btnSignOut.style.display = "none";
    isPlatformAdmin = false;
    setLoginHint("提示：首次使用请先点击「注册账号」创建账号，之后再登录。");
    return;
  }
  el.loginCard.style.display = "block";
  el.appCard.style.display = "block";
  if (el.profileCard) el.profileCard.style.display = "block";
  if (el.issuePanel) el.issuePanel.style.display = "block";
  el.btnSignOut.style.display = "inline-flex";
  setLoginHint(`已登录：${user.email}`);
  loadLabCatalog();
  loadAll();
  loadProfile();
  loadMyContract();
  checkPlatformAdmin();
}

async function checkPlatformAdmin(){
  const { data, error } = await sb.rpc("is_platform_admin");
  isPlatformAdmin = !error && data === true;
  if (el.adminCard) el.adminCard.style.display = isPlatformAdmin ? "block" : "none";
  if (isPlatformAdmin) adminLoadContracts();
}

async function sendMagicLink(){
  const email = getInputEmail();
  const password = el.password?.value || "";
  if (!email){ toast("请输入邮箱"); return; }
  if (!password){ toast("请输入密码"); return; }
  const btn = el.btnSendLink;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    toast("登录成功");
  }catch(e){
    console.error(e);
    toast("登录失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

async function registerAccount(){
  const email = getInputEmail();
  const password = el.password?.value || "";
  if (!email){ toast("请输入邮箱"); return; }
  if (!password || password.length < 8){ toast("密码至少需要8位"); return; }
  const btn = el.btnRegister;
  setBusy(btn, true);
  try{
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${location.origin}/staff` }
    });
    if (error) throw error;
    if (data?.session) {
      toast("注册成功，已自动登录");
    } else {
      toast("注册成功，请先查收验证邮件并完成激活");
      setLoginHint("我们已发送验证邮件，激活账号后再回来登录。");
    }
  }catch(e){
    console.error(e);
    toast("注册失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

async function resetPassword(){
  const email = getInputEmail();
  if (!email){ toast("请先输入您的注册邮箱"); return; }
  const btn = el.btnResetPwd;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/staff`
    });
    if (error) throw error;
    toast("重置邮件已发送，请查收邮件");
    setLoginHint("已发送密码重置邮件，请点击邮件中的链接完成重置。");
  }catch(e){
    console.error(e);
    toast("发送失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

function showNewPasswordMode(){
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
  setLoginHint("请输入新密码并确认，然后点击「确认修改密码」。");
}

async function setNewPassword(){
  const newPwd = el.password?.value || "";
  const confirmPwd = el.confirmPwd?.value || "";
  if (!newPwd || newPwd.length < 8){ toast("密码至少需要8位"); return; }
  if (newPwd !== confirmPwd){ toast("两次输入的密码不一致，请重新输入"); el.confirmPwd.value = ""; el.confirmPwd.focus(); return; }
  const btn = el.btnSetNewPwd;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.updateUser({ password: newPwd });
    if (error) throw error;
    toast("密码修改成功，已自动登录");
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
    toast("修改失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

async function loadLabCatalog(){
  const { data, error } = await sb.from("lab_test_catalog")
    .select("code,name_cn,module,is_core,standard_unit,display_note")
    .order("module").order("name_cn");
  if (error || !data) return;
  labCatalog = data;

  // Build unit map: { code: [{unit_symbol, is_standard, multiplier}] }
  const { data: mapRows } = await sb.from("lab_test_unit_map")
    .select("lab_test_code,unit_symbol,is_standard,multiplier");
  unitMap = {};
  (mapRows || []).forEach(r => {
    if (!unitMap[r.lab_test_code]) unitMap[r.lab_test_code] = [];
    unitMap[r.lab_test_code].push(r);
  });

  // Populate lab test dropdown
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
}

function updateLabUnits(){
  const code = el.labTestCode?.value;
  if (!el.labUnit) return;
  if (!code){
    el.labUnit.innerHTML = '<option value="">-- 先选化验项目 --</option>';
    if (el.labStdValue) el.labStdValue.value = "";
    if (el.labHint) el.labHint.textContent = "";
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
  await loadProjects();
  // auto select first project
  if (!selectedProject && projects.length){
    selectProject(projects[0].id);
  } else if (selectedProject){
    await loadPatients();
  }
}

async function loadProjects(){
  const { data, error } = await sb.from("projects").select("*").order("created_at", {ascending:false});
  if (error){ toast("读取项目失败：" + error.message); return; }
  projects = data || [];
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
  const left = p.trial_expires_at ? daysLeft(p.trial_expires_at) : null;

  el.projectMeta.innerHTML = `
    <div>项目</div><div><b>${escapeHtml(p.name)}</b></div>
    <div>中心代码</div><div><code>${escapeHtml(p.center_code)}</code></div>
    <div>模块</div><div><code>${escapeHtml(p.module)}</code></div>
    <div>试用到期</div><div>${p.trial_expires_at ? fmtDate(p.trial_expires_at) : "未设置"} ${left!==null?`（剩余 ${left} 天）`:""}</div>
    <div>订阅方案</div><div>${
      p.subscription_plan && p.subscription_plan !== "trial"
        ? `<b>${p.subscription_plan === "institution" ? "机构版" : "Pro"}</b>，有效至 ${p.subscription_active_until ? fmtDate(p.subscription_active_until) : "永久"}`
        : "免费试用"
    }</div>
  `;
  renderTrialBadge(p);
  showIganPathBox();
}

async function selectProject(projectId){
  selectedProject = projects.find(p=>p.id===projectId) || null;
  renderProjects();
  await loadPatients();
  await loadExtras();
  await loadSnapshots();
  loadIssueSummary();
}

async function createProject(){
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
    const registry_type = module.toLowerCase();
    const { error } = await sb.from("projects").insert({ name, center_code, module, registry_type, description });
    if (error) throw error;
    toast("项目已创建");
    el.projName.value = "";
    el.projDesc.value = "";
    await loadProjects();
    // select newest
    if (projects.length) selectProject(projects[0].id);
  }catch(e){
    console.error(e);
    toast("创建失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

// ─── Demo data seeder ─────────────────────────────────────────────────────────
async function seedDemoData(){
  const btn = document.getElementById("btnSeedDemo");
  if (btn) { btn.disabled = true; btn.textContent = "加载中…"; }

  try{
    // 1. Create demo project
    const { data: proj, error: pe } = await sb.from("projects")
      .insert({
        name: "IgAN 多中心演示项目（DEMO）",
        center_code: "DEMO01",
        module: "IGAN",
        registry_type: "igan",
        description: "自动生成的演示数据集，含8位去标识化患者与随访记录，展示MEST-C、趋势图、QC报告等功能。"
      })
      .select()
      .single();
    if (pe) throw pe;
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
    ].map(p => ({ ...p, project_id: pid }));

    const { error: bpe } = await sb.from("patients_baseline").insert(patients);
    if (bpe) throw bpe;

    // 3. Visits (4 per patient; P007 missing last visit, P008 missing Scr at visit2 — to demo QC report)
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
      // P003 – progressive, eGFR declining (QC注意：此类患者需密切随访)
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
      // P007 – moderate, missing last visit (QC will flag incomplete follow-up)
      { patient_code:"P007", visit_date:"2023-03-10", sbp:142, dbp:90, scr_umol_l:132, upcr:2.5 },
      { patient_code:"P007", visit_date:"2023-06-10", sbp:140, dbp:88, scr_umol_l:130, upcr:2.2 },
      { patient_code:"P007", visit_date:"2023-09-10", sbp:138, dbp:86, scr_umol_l:128, upcr:2.0 },
      // P008 – missing Scr at visit 2 (QC will flag missing core field)
      { patient_code:"P008", visit_date:"2023-03-15", sbp:118, dbp:74, scr_umol_l:75,  upcr:1.5 },
      { patient_code:"P008", visit_date:"2023-06-15", sbp:116, dbp:72, scr_umol_l:null, upcr:1.2 },  // missing Scr
      { patient_code:"P008", visit_date:"2023-09-15", sbp:115, dbp:71, scr_umol_l:74,  upcr:0.8 },
      { patient_code:"P008", visit_date:"2024-03-15", sbp:114, dbp:70, scr_umol_l:73,  upcr:0.6 },
    ].map(v => ({ ...v, project_id: pid }));

    const { error: ve } = await sb.from("visits_long").insert(visits);
    if (ve) throw ve;

    toast("✅ 演示数据加载完成！已创建 8 名患者 + 31 次随访（含QC测试项）");
    await loadProjects();
    if (projects.length) selectProject(projects[0].id);

  }catch(e){
    console.error(e);
    toast("演示数据加载失败：" + (e?.message || e));
    if (btn){ btn.disabled = false; btn.textContent = "⚡ 一键加载 IgAN 演示数据（8 患者）"; }
  }
}
// ──────────────────────────────────────────────────────────────────────────────

async function loadPatients(){
  if (!selectedProject){ patients = []; renderPatients(); return; }
  const { data, error } = await sb.from("patients_baseline")
    .select("*")
    .eq("project_id", selectedProject.id)
    .order("created_at", {ascending:false});
  if (error){ toast("读取患者失败：" + error.message); return; }
  patients = data || [];
  renderPatients();
}


async function loadExtras(){
  if (!selectedProject){
    if (el.variantsPreview) el.variantsPreview.textContent = "";
    if (el.labsPreview) el.labsPreview.textContent = "";
    if (el.medsPreview) el.medsPreview.textContent = "";
    if (el.eventsPreview) el.eventsPreview.textContent = "暂无记录";
    return;
  }
  const pid = selectedProject.id;
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
    // events_long may not exist yet — ignore error gracefully
    renderVariantsPreview(varsRes.data || []);
    renderLabsPreview(labsRes.data || []);
    renderMedsPreview(medsRes.data || []);
    renderEventsPreview(evtsRes.error ? [] : (evtsRes.data || []));
  }catch(e){
    console.error(e);
    // do not spam toasts here
  }
}

function renderVariantsPreview(rows){
  if (!el.variantsPreview) return;
  if (!rows.length){
    el.variantsPreview.innerHTML = "暂无记录（仅影响科研分析时的基因分层/描述）";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.test_date||"")}</td>
      <td>${escapeHtml(r.gene||"")}</td>
      <td class="muted small">${escapeHtml((r.variant||r.hgvs_c||"").slice(0,28))}</td>
      <td>${escapeHtml(r.classification||"")}</td>
    </tr>
  `).join("");
  el.variantsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>日期</th><th>基因</th><th>变异</th><th>ACMG分级</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function renderLabsPreview(rows){
  if (!el.labsPreview) return;
  if (!rows.length){
    el.labsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.lab_date||"")}</td>
      <td>${escapeHtml(r.lab_name||"")}</td>
      <td>${escapeHtml(r.lab_value||"")}</td>
      <td>${escapeHtml(r.lab_unit||"")}</td>
    </tr>
  `).join("");
  el.labsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>日期</th><th>项目</th><th>数值</th><th>单位</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function renderMedsPreview(rows){
  if (!el.medsPreview) return;
  if (!rows.length){
    el.medsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.drug_name||"")}</td>
      <td class="muted small">${escapeHtml((r.dose||"").slice(0,18))}</td>
      <td>${escapeHtml(r.start_date||"")}</td>
      <td>${escapeHtml(r.end_date||"")}</td>
    </tr>
  `).join("");
  el.medsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>药品</th><th>剂量</th><th>开始</th><th>结束</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}


function renderEventsPreview(rows){
  if (!el.eventsPreview) return;
  if (!rows.length){
    el.eventsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.event_type||"")}</td>
      <td>${escapeHtml(r.event_date||"")}</td>
      <td>${escapeHtml(r.source||"manual")}</td>
      <td class="muted small">${escapeHtml((r.notes||"").slice(0,30))}</td>
    </tr>
  `).join("");
  el.eventsPreview.innerHTML = `
    <div class="muted small">最近 20 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>事件类型</th><th>日期</th><th>来源</th><th>备注</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
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
  const rows = patients.map(p=>{
    const mest = (selectedProject.module==="IGAN" && (p.oxford_m!==null || p.oxford_e!==null || p.oxford_s!==null || p.oxford_t!==null || p.oxford_c!==null))
      ? `M${v(p.oxford_m)} E${v(p.oxford_e)} S${v(p.oxford_s)} T${v(p.oxford_t)} C${v(p.oxford_c)}`
      : "";
    return `
      <tr data-pcode="${escapeHtml(p.patient_code)}">
        <td><b>${escapeHtml(p.patient_code)}</b></td>
        <td>${escapeHtml(p.sex||"")}</td>
        <td>${escapeHtml(p.birth_year||"")}</td>
        <td>${escapeHtml(p.baseline_date||"")}</td>
        <td>${escapeHtml(p.baseline_scr||"")}</td>
        <td>${escapeHtml(p.baseline_upcr||"")}</td>
        <td class="muted small">${escapeHtml(mest)}</td>
        <td><button class="btn small" data-act="token">生成随访链接</button></td>
      </tr>
    `;
  }).join("");

  el.patientsList.innerHTML = `
    <table class="table">
      <thead><tr>
        <th>研究编号</th><th>性别</th><th>出生年</th><th>基线日期</th><th>Scr</th><th>UPCR</th><th>IgAN MEST‑C</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // bind row actions
  qsa("button[data-act='token']", el.patientsList).forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      const tr = e.target.closest("tr");
      const pcode = tr?.getAttribute("data-pcode");
      if (pcode){
        el.tokenPatientCode.value = pcode;
        if (el.varPatientCode) el.varPatientCode.value = pcode;
        if (el.labPatientCode) el.labPatientCode.value = pcode;
        if (el.medPatientCode) el.medPatientCode.value = pcode;
        if (el.evtPatientCode) el.evtPatientCode.value = pcode;
        toast("已填入研究编号（链接/基因/化验/用药/事件各栏）");
        el.tokenOut.style.display = "none";
      }
    });
  });
}

function v(x){
  if (x === null || x === undefined || x === "") return "";
  return String(x);
}

async function createPatientBaseline(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.patCode.value.trim();
  if (!patient_code) return toast("请输入 patient_code");

  const birth_year = el.patBirthYear.value ? Number(el.patBirthYear.value) : null;
  if (birth_year !== null){
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(birth_year) || birth_year < 1900 || birth_year > thisYear){
      return toast(`出生年份无效（应为 1900–${thisYear}）`);
    }
  }

  const payload = {
    project_id: selectedProject.id,
    patient_code,
    sex: el.patSex.value || null,
    birth_year,
    baseline_date: el.patBaselineDate.value || null,
    baseline_scr: el.patBaselineScr.value ? Number(el.patBaselineScr.value) : null,
    baseline_upcr: el.patBaselineUpcr.value ? Number(el.patBaselineUpcr.value) : null,
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

  const btn = el.btnCreatePatient;
  btn.dataset.label = "保存基线";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("patients_baseline").insert(payload);
    if (error) throw error;
    toast("已保存患者基线");
    el.patCode.value = "";
    await loadPatients();
  }catch(e){
    console.error(e);
    toast("保存失败：" + (e?.message || e));
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

async function genToken(){
  if (!selectedProject) return toast("请先选择项目");
  const pcode = el.tokenPatientCode.value.trim();
  if (!pcode) return toast("请输入患者研究编号");
  const days = el.tokenDays.value ? Number(el.tokenDays.value) : 365;
  const singleUse = el.tokenSingleUse?.checked || false;

  const btn = el.btnGenToken;
  btn.dataset.label = "生成随访链接";
  setBusy(btn, true);
  try{
    // Step 1: create token (existing RPC)
    const { data, error } = await sb.rpc("create_patient_token", {
      p_project_id: selectedProject.id,
      p_patient_code: pcode,
      p_expires_in_days: days
    });
    if (error) throw error;
    const token = data;

    // Step 2: if single_use, set the flag on the record
    if (singleUse){
      await sb.from("patient_tokens")
        .update({ single_use: true })
        .eq("token", token);
    }

    const link = `${location.origin}/patient.html?token=${token}`;
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
        <code>${escapeHtml(link)}</code>
      </div>
      <div class="btnbar" style="margin-top:8px">
        <button class="btn small primary" id="btnCopyLink">复制链接</button>
        <a class="btn small" href="${escapeHtml(link)}" target="_blank">打开随访页预览</a>
        <button class="btn small" style="border-color:#dc2626;color:#dc2626" id="btnRevokeToken">立即撤销此 token</button>
      </div>
      <div class="muted small" style="margin-top:6px">
        提示：链接泄露或发错患者时可点「立即撤销」，已提交的数据不受影响。
      </div>
    `;
    qs("#btnCopyLink", el.tokenOut).addEventListener("click", async ()=>{
      await navigator.clipboard.writeText(link);
      toast("已复制随访链接");
    });
    qs("#btnRevokeToken", el.tokenOut).addEventListener("click", async ()=>{
      const reason = window.prompt("请填写撤销原因（必填，如：发错患者，重新生成）：");
      if (reason === null) return;  // 取消
      if (!reason.trim()) return toast("撤销原因不能为空");
      const { error: re } = await sb.rpc("revoke_patient_token", {
        p_token: token,
        p_revoke_reason: reason.trim()
      });
      if (re){ toast("撤销失败：" + re.message); return; }
      toast("已撤销此 token，链接立即失效");
      el.tokenOut.querySelector("div > b").nextSibling?.replaceWith?.("");
      el.tokenOut.querySelector(".issue-resolved, .issue-info")?.outerHTML;
      // re-render badge
      const badge = el.tokenOut.querySelector("[class*='issue-badge']");
      if (badge) badge.outerHTML = `<span class="issue-badge issue-critical">已撤销</span>`;
    });
  }catch(e){
    console.error(e);
    toast("生成失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}


async function addVariant(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.varPatientCode?.value.trim();
  if (!patient_code) return toast("请填写基因记录的 patient_code");
  const payload = {
    project_id: selectedProject.id,
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
    toast("添加失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

async function addLab(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.labPatientCode?.value.trim();
  if (!patient_code) return toast("请填写患者研究编号");
  const lab_test_code = el.labTestCode?.value;
  if (!lab_test_code) return toast("请从下拉列表选择化验项目");
  const rawVal = el.labValue?.value !== "" ? Number(el.labValue?.value) : null;
  if (rawVal === null || isNaN(rawVal)) return toast("请填写化验数值");
  const unit = el.labUnit?.value;
  if (!unit) return toast("请选择单位");

  // 前端 PII 检测
  try { assertNoPII(el.labQcReason?.value || "", "留痕原因"); } catch(e){ return toast(e.message); }

  const btn = el.btnAddLab;
  btn.dataset.label = "添加化验记录";
  setBusy(btn, true);
  try{
    const { data, error } = await sb.rpc("upsert_lab_record", {
      p_project_id:    selectedProject.id,
      p_patient_code:  patient_code,
      p_lab_date:      el.labDate?.value || null,
      p_lab_test_code: lab_test_code,
      p_value_raw:     rawVal,
      p_unit_symbol:   unit,
      p_measured_at:   null,
      p_lab_id:        null
    });
    if (error) throw error;

    // If qc_reason was filled, update it on the record
    const reason = el.labQcReason?.value.trim();
    if (reason && data) {
      await sb.from("labs_long").update({ qc_reason: reason }).eq("id", data);
    }

    const cat = labCatalog.find(c => c.code === lab_test_code);
    toast(`已添加化验记录：${cat?.name_cn || lab_test_code} ${rawVal} ${unit}`);
    el.labTestCode.value = "";
    el.labValue.value = "";
    el.labUnit.innerHTML = '<option value="">-- 先选化验项目 --</option>';
    if (el.labStdValue) el.labStdValue.value = "";
    if (el.labQcReason) el.labQcReason.value = "";
    if (el.labQcReasonCol) el.labQcReasonCol.style.display = "none";
    if (el.labHint) el.labHint.textContent = "";
    await loadExtras();
    await loadSnapshots();
    loadIssueSummary();
  }catch(e){
    console.error(e);
    const hint = e?.message || String(e);
    // If duplicate warning from DB, show qc_reason field
    if (hint.includes("duplicate") || hint.includes("重复") || hint.includes("unit_not_allowed") || hint.includes("单位")) {
      if (el.labQcReasonCol) el.labQcReasonCol.style.display = "";
    }
    toast("添加失败：" + hint);
  }finally{
    setBusy(btn, false);
  }
}

async function addMed(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.medPatientCode?.value.trim();
  if (!patient_code) return toast("请填写用药记录的 patient_code");
  const drug_name = el.medName?.value.trim();
  if (!drug_name) return toast("请填写 drug_name");
  const payload = {
    project_id: selectedProject.id,
    patient_code,
    drug_name,
    drug_class: el.medClass?.value.trim() || null,
    dose: el.medDose?.value.trim() || null,
    start_date: el.medStart?.value || null,
    end_date: el.medEnd?.value || null
  };
  const btn = el.btnAddMed;
  btn.dataset.label = "添加用药记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("meds_long").insert(payload);
    if (error) throw error;
    toast("已添加用药记录");
    if (el.medName) el.medName.value = "";
    if (el.medDose) el.medDose.value = "";
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("添加失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}


async function addEvent(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.evtPatientCode?.value.trim();
  if (!patient_code) return toast("请填写 patient_code");
  const event_type = el.evtType?.value;
  if (!event_type) return toast("请选择事件类型");
  const payload = {
    project_id: selectedProject.id,
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
    toast("已录入终点事件");
    if (el.evtDate) el.evtDate.value = "";
    if (el.evtNotes) el.evtNotes.value = "";
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("录入失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}


async function exportTable(kind){
  if (!selectedProject) return toast("请先选择项目");
  const pid = selectedProject.id;
  const center_code = selectedProject.center_code;
  const module = selectedProject.module;

  let table = "";
  let columns = [];
  let filename = "";

  if (kind === "baseline"){
    table = "patients_baseline";
    columns = [
      "center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr",
      "biopsy_date","oxford_m","oxford_e","oxford_s","oxford_t","oxford_c",
      "treatment_arm","randomization_id","randomization_date",
      "created_at"
    ];
    filename = `patients_baseline_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "visits"){
    table = "visits_long";
    columns = ["center_code","module","patient_code","visit_date","sbp","dbp","scr_umol_l","upcr","egfr","notes","created_at"];
    filename = `visits_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "labs"){
    table = "labs_long";
    columns = ["center_code","module","patient_code","lab_date","lab_name","lab_value","lab_unit","created_at"];
    filename = `labs_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "meds"){
    table = "meds_long";
    columns = ["center_code","module","patient_code","drug_name","drug_class","dose","start_date","end_date","created_at"];
    filename = `meds_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "variants"){
    table = "variants_long";
    columns = ["center_code","module","patient_code","test_date","test_name","gene","variant","hgvs_c","hgvs_p","transcript","zygosity","classification","lab_name","notes","created_at"];
    filename = `variants_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "events"){
    table = "events_long";
    columns = ["center_code","module","patient_code","event_type","event_date","confirmed","source","notes","created_at"];
    filename = `events_long_${center_code}_${fmtDate(new Date())}.csv`;
  }

  try{
    const { data, error } = await sb.from(table).select("*").eq("project_id", pid).order("created_at", {ascending:true});
    if (error) throw error;
    const rows = (data||[]).map(r=>({
      center_code,
      module,
      ...r
    }));
    const csv = toCsv(rows, columns);
    downloadCsvUtf8Bom(filename, csv);
    await sb.rpc("log_project_audit", {
      p_project_id: pid,
      p_action: "export_csv",
      p_snapshot_id: null,
      p_details: { kind, filename, rows: rows.length }
    });
    toast("已导出：" + filename);
  }catch(e){
    console.error(e);
    toast("导出失败：" + (e?.message || e));
  }
}


async function fetchProjectRows(pid, center_code, module){
  const [baseline, visits, labs, meds, vars, evts] = await Promise.all([
    sb.from("patients_baseline").select("*").eq("project_id", pid),
    sb.from("visits_long").select("*").eq("project_id", pid),
    sb.from("labs_long").select("*").eq("project_id", pid),
    sb.from("meds_long").select("*").eq("project_id", pid),
    sb.from("variants_long").select("*").eq("project_id", pid),
    sb.from("events_long").select("*").eq("project_id", pid),
  ]);
  const check = [baseline, visits, labs, meds, vars].find(x=>x.error);
  if (check) throw check.error;
  return {
    bRows: (baseline.data||[]).map(r=>({center_code, module, ...r})),
    vRows: (visits.data||[]).map(r=>({center_code, module, ...r})),
    lRows: (labs.data||[]).map(r=>({center_code, module, ...r})),
    mRows: (meds.data||[]).map(r=>({center_code, module, ...r})),
    gRows: (vars.data||[]).map(r=>({center_code, module, ...r})),
    eRows: (evts.error ? [] : (evts.data||[])).map(r=>({center_code, module, ...r})),
  };
}

function calcQcSummary(vRows){
  const n = vRows.length || 0;
  const miss = (k)=>vRows.filter(r=>r[k]===null || r[k]===undefined || r[k]==="").length;
  return {
    n_visits: n,
    missing: {
      sbp: miss("sbp"), dbp: miss("dbp"), scr_umol_l: miss("scr_umol_l"), upcr: miss("upcr")
    },
    missing_rate_pct: n ? Number(((vRows.filter(r=>r.sbp==null||r.dbp==null||r.scr_umol_l==null||r.upcr==null).length / n) * 100).toFixed(2)) : 0
  };
}

async function createSnapshot(kind = "snapshot"){
  if (!selectedProject) return null;
  const { data, error } = await sb.rpc("create_project_snapshot", {
    p_project_id: selectedProject.id,
    p_kind: kind,
    p_filter_summary: { module: selectedProject.module, center_code: selectedProject.center_code },
    p_schema_version: "core_v2"
  });
  if (error) throw error;
  return data?.[0] || null;
}

async function createSnapshotOnly(){
  if (!selectedProject) return toast("请先选择项目");
  const btn = el.btnCreateSnapshot;
  btn.dataset.label = "生成数据快照（Snapshot）";
  setBusy(btn, true);
  try{
    const snap = await createSnapshot("snapshot");
    if (snap){
      el.snapshotOut.style.display = "block";
      el.snapshotOut.innerHTML = `<div><b>已创建 Snapshot：</b><code>${escapeHtml(snap.snapshot_id)}</code></div>`;
      await loadSnapshots();
      toast("Snapshot 已创建");
    }
  }catch(e){
    console.error(e);
    toast("创建 Snapshot 失败：" + (e?.message || e));
  }finally{ setBusy(btn,false); }
}

function citationText(snapshotId, createdAt){
  const d = createdAt ? String(createdAt).slice(0,10) : fmtDate(new Date());
  return `Data snapshot v3.0 (Snapshot ID: ${snapshotId}) exported on ${d}.`;
}

async function lockSnapshot(rowId){
  const ok = window.confirm("锁定后不可覆盖；如需更新请新建快照。确认锁定？");
  if (!ok) return;
  const { error } = await sb.rpc("lock_project_snapshot", { p_snapshot_id: rowId });
  if (error){ toast("锁定失败：" + error.message); return; }
  toast("已锁定快照");
  await loadSnapshots();
}

async function loadSnapshots(){
  if (!selectedProject || !el.snapshotsList) return;
  const { data, error } = await sb.rpc("list_project_snapshots", { p_project_id: selectedProject.id });
  if (error){
    el.snapshotsList.innerHTML = `<div class='muted small'>读取 snapshots 失败：${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data || [];
  if (!rows.length){
    el.snapshotsList.innerHTML = "<div class='muted small'>暂无 Snapshot。</div>";
    return;
  }
  const trs = rows.map(r=>`<tr>
    <td><code>${escapeHtml(r.snapshot_id)}</code></td>
    <td>${escapeHtml(fmtDate(r.created_at))}</td>
    <td>${escapeHtml(r.status)}</td>
    <td>${escapeHtml(r.n_patients ?? "")}</td>
    <td>${escapeHtml(r.n_visits ?? "")}</td>
    <td>${escapeHtml(r.missing_rate ?? "")}%</td>
    <td>
      <button class='btn small' data-act='copy' data-id='${escapeHtml(r.snapshot_id)}' data-at='${escapeHtml(r.created_at)}'>复制引用</button>
      ${r.status !== 'locked' ? `<button class='btn small danger' data-act='lock' data-row='${escapeHtml(r.id)}'>锁定</button>` : ""}
    </td>
  </tr>`).join("");
  el.snapshotsList.innerHTML = `<table class='table'><thead><tr><th>快照编号</th><th>创建时间</th><th>状态</th><th>患者数</th><th>随访次数</th><th>缺失率</th><th>操作</th></tr></thead><tbody>${trs}</tbody></table>`;
  qsa("button[data-act='copy']", el.snapshotsList).forEach(b=>b.addEventListener("click", async ()=>{
    const txt = citationText(b.dataset.id, b.dataset.at);
    await navigator.clipboard.writeText(txt);
    toast("已复制论文引用语句");
  }));
  qsa("button[data-act='lock']", el.snapshotsList).forEach(b=>b.addEventListener("click", ()=>lockSnapshot(b.dataset.row)));
}

// Issue 严重度中文标签
const SEVERITY_LABEL = { critical:"严重", warning:"警告", info:"提示" };
const SEVERITY_CSS   = { critical:"issue-critical", warning:"issue-warning", info:"issue-info" };

async function loadIssueSummary(){
  if (!selectedProject || !el.issueSummary) return;
  const { data, error } = await sb.rpc("get_issue_summary", { p_project_id: selectedProject.id });
  if (error || !data){ el.issueSummary.textContent = "暂无质控数据"; return; }
  const total = (data.total_open || 0) + (data.total_in_prog || 0);
  const by = data.by_severity || {};
  el.issueSummary.innerHTML =
    total === 0
      ? `<span class="issue-badge issue-resolved">✓ 无未解决 Issue</span>　关闭率 ${data.close_rate_pct ?? 0}%`
      : `未解决：
         ${by.critical ? `<span class='issue-badge issue-critical'>${by.critical} 严重</span> ` : ""}
         ${by.warning  ? `<span class='issue-badge issue-warning'>${by.warning} 警告</span> ` : ""}
         ${by.info     ? `<span class='issue-badge issue-info'>${by.info} 提示</span>` : ""}
         　已关闭 ${data.total_resolved + data.total_wontfix || 0} 条，关闭率 ${data.close_rate_pct ?? 0}%`;
}

async function loadIssues(){
  if (!selectedProject || !el.issueList) return;
  const { data, error } = await sb.from("data_issues")
    .select("id,patient_code,record_type,rule_code,severity,status,message,created_at")
    .eq("project_id", selectedProject.id)
    .not("status", "in", '("RESOLVED","WONT_FIX")')
    .order("severity")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error){ el.issueList.innerHTML = `<div class='muted small'>加载失败：${escapeHtml(error.message)}</div>`; return; }
  const rows = data || [];
  if (!rows.length){ el.issueList.innerHTML = "<div class='muted small'>太好了！暂无未解决的质控 Issue。</div>"; return; }
  el.issueList.innerHTML = `
    <table class='table' style='font-size:13px'>
      <thead><tr><th>严重度</th><th>患者编号</th><th>记录类型</th><th>规则</th><th>说明</th><th>操作</th></tr></thead>
      <tbody>
      ${rows.map(r => `<tr>
        <td><span class='issue-badge ${SEVERITY_CSS[r.severity]}'>${SEVERITY_LABEL[r.severity]}</span></td>
        <td>${escapeHtml(r.patient_code)}</td>
        <td>${escapeHtml(r.record_type)}</td>
        <td><code>${escapeHtml(r.rule_code)}</code></td>
        <td>${escapeHtml(r.message.slice(0,60))}${r.message.length > 60 ? "…" : ""}</td>
        <td>
          <button class='btn small' data-issue-id='${r.id}' data-act='wontfix'>标记不修复</button>
        </td>
      </tr>`).join("")}
      </tbody>
    </table>`;
  qsa("button[data-act='wontfix']", el.issueList).forEach(btn => {
    btn.addEventListener("click", async () => {
      const reason = window.prompt("请说明为何不修复此 Issue（必填）：");
      if (!reason?.trim()) return toast("原因不能为空");
      const { error: e2 } = await sb.rpc("close_issue_wont_fix", {
        p_issue_id: btn.dataset.issueId, p_resolution: reason.trim()
      });
      if (e2){ toast("操作失败：" + e2.message); return; }
      toast("已标记为不修复");
      loadIssues();
      loadIssueSummary();
    });
  });
}

async function generatePaperPack({ withSnapshot = false } = {}){
  if (!selectedProject) return toast("请先选择项目");
  if (typeof JSZip === "undefined") return toast("JSZip 未加载，无法打包");

  const btn = el.btnPaperPack;
  btn.dataset.label = "一键生成论文包（zip）";
  setBusy(btn,true);

  try{
    const pid = selectedProject.id;
    const center_code = selectedProject.center_code;
    const module = selectedProject.module;
    const project_name = selectedProject.name;

    const { bRows, vRows, lRows, mRows, gRows, eRows } = await fetchProjectRows(pid, center_code, module);
    const qcSummary = calcQcSummary(vRows);
    const snapshot = withSnapshot ? await createSnapshot("paper_package") : null;
    const snapshotId = snapshot?.snapshot_id || `TEMP-${Date.now()}`;

    const today = new Date().toISOString().slice(0,10);
    const meta = {
      export_version: "core_v2",
      exported_at: new Date().toISOString(),
      project_id: pid,
      project_name,
      center_code,
      module,
      counts: {
        patients: bRows.length,
        visits: vRows.length,
        labs: lRows.length,
        meds: mRows.length,
        variants: gRows.length,
        events: eRows.length
      },
      merge_key: "center_code + patient_code",
      pii_policy: "No PII allowed in this system."
    };

    // columns fixed
    const csvBaseline = toCsv(bRows, ["center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr","biopsy_date","oxford_m","oxford_e","oxford_s","oxford_t","oxford_c","treatment_arm","randomization_id","randomization_date","created_at"]);
    const csvVisits = toCsv(vRows, ["center_code","module","patient_code","visit_date","sbp","dbp","scr_umol_l","upcr","egfr","egfr_formula_version","notes","created_at"]);
    const csvLabs = toCsv(lRows, ["center_code","module","patient_code","lab_date","lab_test_code","lab_name","value_raw","unit_symbol","value_standard","standard_unit","lab_value","lab_unit","created_at"]);
    const csvMeds = toCsv(mRows, ["center_code","module","patient_code","drug_name","drug_class","dose","start_date","end_date","created_at"]);
    const csvVars = toCsv(gRows, ["center_code","module","patient_code","test_date","test_name","gene","variant","hgvs_c","hgvs_p","transcript","zygosity","classification","lab_name","notes","created_at"]);
    const csvEvents = toCsv(eRows, ["center_code","module","patient_code","event_type","event_date","confirmed","source","notes","created_at"]);

    // fetch template files (served as static assets)
    const [runPy, reqTxt, methodsTpl, readmeTpl] = await Promise.all([
      fetch("/assets/template/run_analysis.py").then(r=>r.text()),
      fetch("/assets/template/requirements.txt").then(r=>r.text()),
      fetch("/assets/template/METHODS_TEMPLATE_EN.md").then(r=>r.text()),
      fetch("/assets/template/README_PACK.md").then(r=>r.text())
    ]);

    const methods = methodsTpl
      .replaceAll("{{PROJECT_NAME}}", project_name)
      .replaceAll("{{CENTER_CODE}}", center_code)
      .replaceAll("{{MODULE}}", module)
      .replaceAll("{{EXPORT_DATE}}", today)
      .replaceAll("{{N_PATIENTS}}", String(bRows.length))
      .replaceAll("{{N_VISITS}}", String(vRows.length));

    const readme = readmeTpl
      .replaceAll("{{PROJECT_NAME}}", project_name)
      .replaceAll("{{EXPORT_DATE}}", today);

    const zip = new JSZip();
    zip.file("EXPORT_METADATA.json", JSON.stringify(meta, null, 2));

    const analysisFolder = zip.folder("analysis");
    analysisFolder.file("run_analysis.py", runPy);
    analysisFolder.file("requirements.txt", reqTxt);

    const dataFolder = analysisFolder.folder("data");
    // add BOM to CSV inside zip as well for Excel friendliness
    const BOM = "\ufeff";
    dataFolder.file("patients_baseline.csv", BOM + csvBaseline);
    dataFolder.file("visits_long.csv", BOM + csvVisits);
    dataFolder.file("labs_long.csv", BOM + csvLabs);
    dataFolder.file("meds_long.csv", BOM + csvMeds);
    dataFolder.file("variants_long.csv", BOM + csvVars);
    dataFolder.file("events_long.csv", BOM + csvEvents);
    analysisFolder.folder("outputs").file(".keep","");

    const ms = zip.folder("manuscript");
    ms.file("METHODS_AUTO_EN.md", methods);
    ms.file("README.md", readme);

    // ── PR-9 顶刊必备三件套 ─────────────────────────────────────────────────

    // 1. data_dictionary.json — 字段定义、单位、换算规则、eGFR 公式版本
    const dataDictionary = {
      schema_version: "core_v2",
      generated_at: new Date().toISOString(),
      egfr_formula: "CKD-EPI-2021-Cr",
      egfr_reference: "Inker et al., NEJM 2021;385:1737-1749",
      missing_value_convention: "empty cell = not measured (not zero)",
      merge_key: "center_code + patient_code",
      pii_policy: "No PII stored. All records use center-assigned research codes only.",
      tables: {
        patients_baseline: {
          patient_code: "Center-assigned research ID (NOT name/MRN). Format: centerId-year-seq, e.g. BJ01-2024-001",
          sex: "M=Male, F=Female",
          birth_year: "Year of birth (integer)",
          baseline_scr: "Serum creatinine at baseline, unit: μmol/L",
          baseline_upcr: "Urine PCR at baseline, unit: mg/g",
          oxford_m: "Oxford-MEST M score: 0 or 1",
          oxford_e: "Oxford-MEST E score: 0 or 1",
          oxford_s: "Oxford-MEST S score: 0 or 1",
          oxford_t: "Oxford-MEST T score: 0, 1 or 2",
          oxford_c: "Oxford-MEST C score: 0, 1 or 2"
        },
        visits_long: {
          visit_date: "Date of this follow-up visit (YYYY-MM-DD)",
          sbp: "Systolic BP (mmHg)",
          dbp: "Diastolic BP (mmHg)",
          scr_umol_l: "Serum creatinine (μmol/L). Multiply by 0.01131 to convert to mg/dL",
          upcr: "Urine PCR (mg/g). Divide by 1000 to convert to g/g",
          egfr: "eGFR (mL/min/1.73m²), see egfr_formula_version for calculation method",
          egfr_formula_version: "CKD-EPI-2021-Cr = computed by system; manual = user-entered; missing_inputs = sex/age missing"
        },
        labs_long: {
          lab_test_code: "Standardized test code from lab_test_catalog (e.g. CREAT, UPCR, HGB)",
          value_raw: "Original value as entered by the user",
          unit_symbol: "Unit as entered",
          value_standard: "Value converted to standard unit (see standard_unit column)",
          standard_unit: "Standard unit for this test; all centers use this for merged analysis"
        }
      },
      lab_catalog_summary: labCatalog.map(c => ({
        code: c.code, name_cn: c.name_cn, standard_unit: c.standard_unit,
        is_core: c.is_core, module: c.module
      })),
      unit_conversion_examples: [
        { from: "CREAT 88.4 μmol/L", to: "1.00 mg/dL", formula: "÷88.4" },
        { from: "UPCR 2000 mg/g",    to: "2.00 g/g",   formula: "÷1000" },
        { from: "HGB 120 g/L",       to: "12.0 g/dL",  formula: "÷10"   }
      ]
    };
    zip.file("data_dictionary.json", JSON.stringify(dataDictionary, null, 2));

    // 2. qc_report.csv — 核心字段缺失率 + Issue 统计（按中心）
    const { data: issueRows } = await sb
      .from("data_issues")
      .select("severity,status")
      .eq("project_id", pid);
    const openIssues = (issueRows || []).filter(i => !["RESOLVED","WONT_FIX"].includes(i.status));
    const closedIssues = (issueRows || []).filter(i => ["RESOLVED","WONT_FIX"].includes(i.status));
    const qcReportRows = [{
      center_code,
      n_patients: bRows.length,
      n_visits: vRows.length,
      missing_sbp_pct: qcSummary.missing?.sbp > 0 ? ((qcSummary.missing.sbp / vRows.length * 100).toFixed(1) + "%") : "0%",
      missing_scr_pct: qcSummary.missing?.scr_umol_l > 0 ? ((qcSummary.missing.scr_umol_l / vRows.length * 100).toFixed(1) + "%") : "0%",
      missing_upcr_pct: qcSummary.missing?.upcr > 0 ? ((qcSummary.missing.upcr / vRows.length * 100).toFixed(1) + "%") : "0%",
      open_issues_critical: openIssues.filter(i=>i.severity==="critical").length,
      open_issues_warning: openIssues.filter(i=>i.severity==="warning").length,
      open_issues_info: openIssues.filter(i=>i.severity==="info").length,
      issue_close_rate: issueRows?.length > 0
        ? (closedIssues.length / issueRows.length * 100).toFixed(1) + "%" : "N/A",
      generated_at: new Date().toISOString()
    }];
    zip.file("qc_report.csv", "\ufeff" + toCsv(qcReportRows, Object.keys(qcReportRows[0])));

    // 3. snapshot_manifest.json — 快照宣言（可复现性关键文件）
    const snapshotManifest = {
      snapshot_id: snapshotId,
      generated_at: new Date().toISOString(),
      schema_version: "core_v2",
      egfr_formula: "CKD-EPI-2021-Cr",
      project_id: pid,
      project_name,
      center_code,
      module,
      row_counts: {
        patients: bRows.length,
        visits: vRows.length,
        labs: lRows.length,
        medications: mRows.length,
        genetics: gRows.length,
        events: eRows.length
      },
      qc_summary: {
        open_issues: openIssues.length,
        closed_issues: closedIssues.length,
        missing_rate_pct: qcSummary.missing_rate_pct
      },
      usage_note: "Cite this snapshot_id in your Methods section to ensure reproducibility. Share with co-authors to verify identical dataset version."
    };
    zip.file("snapshot_manifest.json", JSON.stringify(snapshotManifest, null, 2));

    zip.file("qc_summary.json", JSON.stringify(qcSummary, null, 2));

    if ((module || "").toUpperCase() === "KTX"){
      zip.file("KTX_FIELD_DICTIONARY.md", [
        "KTx Baseline: transplant_date, donor_type, induction_therapy, maintenance_immuno, HLA_mismatch_count, PRA/DSA, baseline_creatinine, baseline_eGFR",
        "KTx Follow-up: Scr/eGFR, urine protein, tac/csa trough, BP, weight, infection, rejection, Banff biopsy, graft_failure_date, death_date, return_to_dialysis"
      ].join("\n"));
      zip.file("ktx_summary.json", JSON.stringify({
        n_bk_or_cmv_events: eRows.filter(r=>/BK|CMV/i.test(String(r.event_type||""))).length,
        n_rejection_events: eRows.filter(r=>/rejection|排斥/i.test(String(r.event_type||""))).length
      }, null, 2));
    }

    const table1 = toCsv(bRows, ["center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr","treatment_arm","randomization_id"]);
    dataFolder.file("table1_baseline.csv", BOM + table1);
    analysisFolder.folder("outputs").file("trend_egfr_placeholder.txt", "Run analysis/run_analysis.py for rendered trajectory plots.");
    analysisFolder.folder("outputs").file("trend_proteinuria_placeholder.txt", "Run analysis/run_analysis.py for rendered trajectory plots.");
    analysisFolder.folder("outputs").file("endpoint_12m_summary.json", JSON.stringify({ n_patients: bRows.length, n_visits: vRows.length }, null, 2));

    const fnameSafe = project_name.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0,40);
    const zipName = `paper_pack_${fnameSafe}_${today}.zip`;

    const blob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 400);
    if (snapshot){
      el.snapshotOut.style.display = "block";
      el.snapshotOut.innerHTML = `<div><b>Snapshot ID：</b><code>${escapeHtml(snapshot.snapshot_id)}</code></div><div class="small" style="margin-top:6px">${escapeHtml(citationText(snapshot.snapshot_id, snapshot.created_at))}</div>`;
      await loadSnapshots();
    }
    await sb.rpc("log_project_audit", {
      p_project_id: pid,
      p_action: "paper_package",
      p_snapshot_id: snapshot?.snapshot_id || null,
      p_details: { zip_name: zipName, with_snapshot: !!snapshot }
    });
    toast("论文包已生成：" + zipName);
  }catch(e){
    console.error(e);
    toast("生成失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

// ═══════════════════════════════════════════════════════════
// 研究者资料
// ═══════════════════════════════════════════════════════════

async function loadProfile(){
  const { data } = await sb.from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

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
    toast("保存失败：" + (e?.message || e));
  } finally {
    setBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════════
// 平台管理员功能
// ═══════════════════════════════════════════════════════════

async function adminSearch(){
  if (!isPlatformAdmin){ toast("无管理员权限"); return; }
  const email = el.adminSearchEmail.value.trim();
  if (!email){ toast("请输入邮箱关键词"); return; }
  const btn = el.btnAdminSearch;
  setBusy(btn, true);
  try {
    const { data, error } = await sb.rpc("admin_list_projects", { p_email: email });
    if (error) throw error;
    renderAdminResults(data || []);
  } catch(e) {
    toast("搜索失败：" + (e?.message || e));
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
    <th>当前计划</th><th>试用到期</th><th>宽限到期</th><th>操作</th>
  </tr></thead>`;

  const rows_html = rows.map(r => {
    const trialExp = r.trial_expires_at  ? fmtDate(r.trial_expires_at)  : "—";
    const graceExp = r.trial_grace_until ? fmtDate(r.trial_grace_until) : "—";
    const pid = escapeHtml(r.project_id);
    return `<tr>
      <td>${escapeHtml(r.project_name)}</td>
      <td>${escapeHtml(r.center_code||"—")}</td>
      <td>${escapeHtml(r.module||"—")}</td>
      <td>${planBadgeHtml(r.subscription_plan)}</td>
      <td style="font-size:12px">${trialExp}</td>
      <td style="font-size:12px">${graceExp}</td>
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
  if (!confirm("撤回为普通试用（30天，从今天计算）？")) return;
  const { error } = await sb.rpc("admin_reset_to_trial", { p_project_id: projectId });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已重置为普通试用");
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
  const { data: rows } = await sb.rpc("get_my_contract");
  const c = el.contractStatus;
  const form = el.contractApplyForm;
  if (!c || !form) return;

  // get_my_contract returns a table → rows is an array
  const data = Array.isArray(rows) ? rows[0] : rows;

  if (!data) {
    // 没有申请记录 → 显示申请表单
    c.innerHTML = `<div class="muted small">暂无申请记录。如贵中心符合条件，请填写后提交。</div>`;
    form.style.display = "block";
    return;
  }

  const s = CONTRACT_STATUS_LABEL[data.status] || { text: data.status, cls:"badge" };
  form.style.display = "none";

  let extra = "";
  if (data.status === "approved" && data.payment_status === "unpaid"){
    extra = `<div class="infobox" style="margin-top:8px">
      <b>审批已通过！</b> 平台将与您联系确认付款方式。付款完成后权益自动开通。<br/>
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
  const plan = el.contractPlan?.value;
  const note = el.contractNote?.value.trim() || null;
  const btn  = el.btnApplyContract;
  btn.dataset.label = "提交申请";
  setBusy(btn, true);
  try {
    const { error } = await sb.rpc("apply_partner_contract", {
      p_plan: plan, p_note: note
    });
    if (error) throw error;
    toast("申请已提交，平台将在 1–2 个工作日内联系您");
    await loadMyContract();
  } catch(e) {
    toast("提交失败：" + (e?.message || e));
  } finally {
    setBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════════
// 合同管理（管理员侧）
// ═══════════════════════════════════════════════════════════

async function adminLoadContracts(){
  if (!isPlatformAdmin) return;
  const { data, error } = await sb.rpc("admin_list_contracts");
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
          <input id="note_${cid}" placeholder="可选" value="${escapeHtml(r.admin_note||"")}"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn small primary" onclick="adminApproveContract('${cid}')">✅ 批准</button>
          <button class="btn small" style="color:#c0392b" onclick="adminRejectContractPrompt('${cid}')">❌ 拒绝</button>
        </div>
      </div>` : "";

    // 已批准待付款：显示激活按钮
    const activateForm = (r.status === "approved" && r.payment_status === "unpaid") ? `
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;flex-wrap:wrap">
        <div>
          <label style="font-size:12px">权益到期日</label>
          <input id="exp_${cid}" type="date" value="${
            r.expires_at ? r.expires_at.slice(0,10) :
            new Date(Date.now()+365*864e5).toISOString().slice(0,10)
          }" style="width:140px"/>
        </div>
        <button class="btn small primary" onclick="adminActivateContract('${cid}')">💳 确认收款并激活</button>
      </div>` : "";

    // 已激活
    const activeInfo = (r.status === "approved" && r.payment_status === "paid") ? `
      <div class="muted small" style="margin-top:6px">
        已激活 · 到期：${r.expires_at ? fmtDate(r.expires_at) : "—"}
        · 付款：${r.paid_at ? fmtDate(r.paid_at) : "—"}
      </div>` : "";

    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="${s.cls}" style="font-size:11px">${s.text}</span>
        <b style="font-size:13px">${na(r.real_name)}</b>
        <span class="muted small">${na(r.owner_email)}</span>
        <span class="muted small">·</span>
        <span class="muted small">${na(r.hospital)} ${na(r.department)}</span>
        ${r.contact ? `<span class="muted small">· 📞 ${escapeHtml(r.contact)}</span>` : ""}
        <span class="muted small" style="margin-left:auto">${fmtDate(r.applied_at)}</span>
      </div>
      <div class="muted small">
        申请套餐：<b>${r.apply_plan}</b>
        ${r.discount_pct ? ` · 折扣：${100-r.discount_pct}折（优惠${r.discount_pct}%）` : ""}
        ${r.annual_price_cny ? ` · 协议价：¥${r.annual_price_cny}/年` : ""}
        ${r.apply_note ? `<br/>申请说明：${escapeHtml(r.apply_note)}` : ""}
      </div>
      ${activeInfo}${reviewForm}${activateForm}
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
  const expInput = qs(`#exp_${cid}`)?.value;
  const expires  = expInput ? new Date(expInput).toISOString() : null;
  if (!confirm(`确认收款并激活？权益将开通至 ${expInput || "一年后"}，该用户所有项目自动升级。`)) return;
  const { error } = await sb.rpc("admin_activate_contract", {
    p_contract_id: cid, p_expires_at: expires
  });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("✅ 已激活，权益已开通");
  adminLoadContracts();
}

// 挂载到 window，供 table inline onclick 调用
window.adminExtend  = adminExtend;
window.adminPartner = adminPartner;
window.adminReset   = adminReset;
window.adminApproveContract        = adminApproveContract;
window.adminRejectContractPrompt   = adminRejectContractPrompt;
window.adminActivateContract       = adminActivateContract;
window.resetContractForm           = resetContractForm;

init();
