import { supabase } from "/lib/supabase-client.js";
import { qs, qsa, toast, toCsv, downloadCsvUtf8Bom, fmtDate, daysLeft, humanNumber, escapeHtml } from "/lib/utils.js";

const sb = supabase();

const el = {
  loginCard: qs("#loginCard"),
  appCard: qs("#appCard"),
  email: qs("#email"),
  btnSendLink: qs("#btnSendLink"),
  btnSignOut: qs("#btnSignOut"),
  loginHint: qs("#loginHint"),

  projName: qs("#projName"),
  projCenter: qs("#projCenter"),
  projModule: qs("#projModule"),
  projDesc: qs("#projDesc"),
  btnCreateProject: qs("#btnCreateProject"),
  projectsList: qs("#projectsList"),
  projectMeta: qs("#projectMeta"),
  trialBadge: qs("#trialBadge"),

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
  btnCreatePatient: qs("#btnCreatePatient"),
  patientsList: qs("#patientsList"),

  tokenPatientCode: qs("#tokenPatientCode"),
  tokenDays: qs("#tokenDays"),
  btnGenToken: qs("#btnGenToken"),
  tokenOut: qs("#tokenOut"),


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
  labName: qs("#labName"),
  labValue: qs("#labValue"),
  labUnit: qs("#labUnit"),
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
};

let session = null;
let user = null;

let projects = [];
let selectedProject = null;
let patients = [];

function setLoginHint(msg){ el.loginHint.textContent = msg || ""; }

function setBusy(btn, busy){
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? "处理中…" : btn.dataset.label || btn.textContent;
}

function renderTrialBadge(p){
  if (!p){
    el.trialBadge.style.display = "none";
    return;
  }
  const exp = p.trial_expires_at;
  const grace = p.trial_grace_until;
  let cls = "badge";
  let txt = "试用未配置";
  if (exp){
    const left = daysLeft(exp);
    if (left >= 0){
      cls = "badge ok";
      txt = `试用中：剩余 ${left} 天（到期 ${fmtDate(exp)}）`;
    } else {
      const graceLeft = grace ? daysLeft(grace) : null;
      if (graceLeft !== null && graceLeft >= 0){
        cls = "badge warn";
        txt = `已到期（只读）：宽限剩余 ${graceLeft} 天（至 ${fmtDate(grace)}）`;
      } else {
        cls = "badge bad";
        txt = `试用结束（只读）：${fmtDate(exp)}`;
      }
    }
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
  // handle auth redirect URL
  const { data: { session: s } } = await sb.auth.getSession();
  session = s;
  user = s?.user || null;

  sb.auth.onAuthStateChange((_event, s2)=>{
    session = s2;
    user = s2?.user || null;
    renderAuthState();
  });

  el.btnSendLink.addEventListener("click", sendMagicLink);
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

  el.btnPaperPack.addEventListener("click", generatePaperPack);

  renderAuthState();
}

function renderAuthState(){
  if (!user){
    el.loginCard.style.display = "block";
    el.appCard.style.display = "none";
    el.btnSignOut.style.display = "none";
    setLoginHint("提示：若收不到邮件，请检查垃圾箱或企业邮箱拦截。");
    return;
  }
  el.loginCard.style.display = "block";
  el.appCard.style.display = "block";
  el.btnSignOut.style.display = "inline-flex";
  setLoginHint(`已登录：${user.email}`);
  loadAll();
}

async function sendMagicLink(){
  const email = el.email.value.trim();
  if (!email){ toast("请输入邮箱"); return; }
  const btn = el.btnSendLink;
  btn.dataset.label = "发送登录链接";
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/staff` }
    });
    if (error) throw error;
    toast("已发送登录链接，请查收邮件");
    setLoginHint("请打开邮箱点击登录链接（如在手机上打开也可）。");
  }catch(e){
    console.error(e);
    toast("发送失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
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
  projects.forEach(p=>{
    const b = document.createElement("button");
    b.className = "pill" + (selectedProject?.id === p.id ? " active" : "");
    b.textContent = `${p.center_code} · ${p.name}`;
    b.addEventListener("click", ()=>selectProject(p.id));
    el.projectsList.appendChild(b);
  });
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
  `;
  renderTrialBadge(p);
  showIganPathBox();
}

async function selectProject(projectId){
  selectedProject = projects.find(p=>p.id===projectId) || null;
  renderProjects();
  await loadPatients();
  await loadExtras();
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
      <thead><tr><th>patient</th><th>date</th><th>gene</th><th>variant</th><th>ACMG</th></tr></thead>
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
      <thead><tr><th>patient</th><th>date</th><th>name</th><th>value</th><th>unit</th></tr></thead>
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
      <thead><tr><th>patient</th><th>drug</th><th>dose</th><th>start</th><th>end</th></tr></thead>
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
      <thead><tr><th>patient</th><th>event_type</th><th>date</th><th>source</th><th>notes</th></tr></thead>
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
        <th>patient_code</th><th>性别</th><th>出生年</th><th>基线日期</th><th>Scr</th><th>UPCR</th><th>IgAN MEST‑C</th><th></th>
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
        toast("已填入 patient_code（token/基因/化验/用药/事件）");
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
    baseline_upcr: el.patBaselineUpcr.value ? Number(el.patBaselineUpcr.value) : null
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

async function genToken(){
  if (!selectedProject) return toast("请先选择项目");
  const pcode = el.tokenPatientCode.value.trim();
  if (!pcode) return toast("请输入 patient_code");
  const days = el.tokenDays.value ? Number(el.tokenDays.value) : 365;

  const btn = el.btnGenToken;
  btn.dataset.label = "生成链接";
  setBusy(btn,true);
  try{
    const { data, error } = await sb.rpc("create_patient_token", {
      p_project_id: selectedProject.id,
      p_patient_code: pcode,
      p_expires_in_days: days
    });
    if (error) throw error;
    const token = data;
    const link = `${location.origin}/p/${token}`;
    el.tokenOut.style.display = "block";
    el.tokenOut.innerHTML = `
      <div><b>随访链接已生成</b></div>
      <div class="small" style="margin-top:6px"><code>${escapeHtml(link)}</code></div>
      <div class="btnbar" style="margin-top:8px">
        <button class="btn small" id="btnCopyLink">复制链接</button>
        <a class="btn small" href="${escapeHtml(link)}" target="_blank">打开随访页</a>
      </div>
      <div class="muted small" style="margin-top:6px">提示：泄露可重新生成 token；系统不保存任何 PII。</div>
    `;
    qs("#btnCopyLink", el.tokenOut).addEventListener("click", async ()=>{
      await navigator.clipboard.writeText(link);
      toast("已复制随访链接");
    });
  }catch(e){
    console.error(e);
    toast("生成失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
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
  if (!patient_code) return toast("请填写化验记录的 patient_code");
  const lab_name = el.labName?.value.trim();
  if (!lab_name) return toast("请填写 lab_name");
  const payload = {
    project_id: selectedProject.id,
    patient_code,
    lab_date: el.labDate?.value || null,
    lab_name,
    lab_value: el.labValue?.value !== "" ? Number(el.labValue.value) : null,
    lab_unit: el.labUnit?.value.trim() || null
  };
  const btn = el.btnAddLab;
  btn.dataset.label = "添加化验记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("labs_long").insert(payload);
    if (error) throw error;
    toast("已添加化验记录");
    if (el.labName) el.labName.value = "";
    if (el.labValue) el.labValue.value = "";
    if (el.labUnit) el.labUnit.value = "";
    await loadExtras();
  }catch(e){
    console.error(e);
    toast("添加失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
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
    toast("已导出：" + filename);
  }catch(e){
    console.error(e);
    toast("导出失败：" + (e?.message || e));
  }
}

async function generatePaperPack(){
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

    // fetch data
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

    const bRows = (baseline.data||[]).map(r=>({center_code, module, ...r}));
    const vRows = (visits.data||[]).map(r=>({center_code, module, ...r}));
    const lRows = (labs.data||[]).map(r=>({center_code, module, ...r}));
    const mRows = (meds.data||[]).map(r=>({center_code, module, ...r}));
    const gRows = (vars.data||[]).map(r=>({center_code, module, ...r}));
    const eRows = (evts.error ? [] : (evts.data||[])).map(r=>({center_code, module, ...r}));

    const today = new Date().toISOString().slice(0,10);
    const meta = {
      export_version: "core_v1",
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
    const csvBaseline = toCsv(bRows, ["center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr","biopsy_date","oxford_m","oxford_e","oxford_s","oxford_t","oxford_c","created_at"]);
    const csvVisits = toCsv(vRows, ["center_code","module","patient_code","visit_date","sbp","dbp","scr_umol_l","upcr","egfr","notes","created_at"]);
    const csvLabs = toCsv(lRows, ["center_code","module","patient_code","lab_date","lab_name","lab_value","lab_unit","created_at"]);
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

    const fnameSafe = project_name.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0,40);
    const zipName = `paper_pack_${fnameSafe}_${today}.zip`;

    const blob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast("论文包已生成：" + zipName);
  }catch(e){
    console.error(e);
    toast("生成失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

init();
