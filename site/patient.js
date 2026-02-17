import { supabase } from "/lib/supabase-client.js";
import { qs, toast, fmtDate, daysLeft } from "/lib/utils.js";

const sb = supabase();

const el = {
  ctxSub: qs("#ctxSub"),
  ctxBox: qs("#ctxBox"),
  visitDate: qs("#visitDate"),
  sbp: qs("#sbp"),
  dbp: qs("#dbp"),
  scr: qs("#scr"),
  upcr: qs("#upcr"),
  egfr: qs("#egfr"),
  notes: qs("#notes"),
  btnSubmit: qs("#btnSubmit"),
  btnRefresh: qs("#btnRefresh"),
  submitHint: qs("#submitHint"),
  visitsBox: qs("#visitsBox"),
};

let token = null;
let ctx = null;

function getToken(){
  // supports /p/<token> or ?token=
  const path = window.location.pathname || "";
  const m = path.match(/\/p\/([^\/]+)$/);
  if (m && m[1]) return m[1];
  const q = new URLSearchParams(window.location.search);
  return q.get("token");
}

function ckdepi2021(scr_mg_dl, age, sex){
  // CKD-EPI 2021 creatinine equation (race-free)
  // ref: Inker et al. 2021
  if (!scr_mg_dl || !age || !sex) return null;
  const isF = String(sex).toUpperCase() === "F";
  const k = isF ? 0.7 : 0.9;
  const alpha = isF ? -0.241 : -0.302;
  const min = Math.min(scr_mg_dl / k, 1);
  const max = Math.max(scr_mg_dl / k, 1);
  let egfr = 142 * Math.pow(min, alpha) * Math.pow(max, -1.200) * Math.pow(0.9938, age);
  if (isF) egfr *= 1.012;
  return egfr;
}

function computeEgfr(){
  if (!ctx) return;
  const scr_umol = Number(el.scr.value);
  if (!scr_umol || Number.isNaN(scr_umol)) { el.egfr.value = ""; return; }
  const scr_mg = scr_umol / 88.4;
  const year = Number(ctx.birth_year);
  const vdate = el.visitDate.value ? new Date(el.visitDate.value) : null;
  const age = (vdate && year) ? (vdate.getFullYear() - year) : null;
  const egfr = ckdepi2021(scr_mg, age, ctx.sex);
  if (!egfr || Number.isNaN(egfr)) { el.egfr.value = ""; return; }
  el.egfr.value = egfr.toFixed(1);
}

async function loadContext(){
  el.ctxSub.textContent = "加载中…";
  const { data, error } = await sb.rpc("patient_get_context", { p_token: token });
  if (error){
    console.error(error);
    el.ctxSub.textContent = "链接无效或已过期";
    el.ctxBox.innerHTML = "<div class='muted small'>请联系中心研究人员获取新的随访链接。</div>";
    el.btnSubmit.disabled = true;
    return;
  }
  ctx = data?.[0] || null;
  if (!ctx){
    el.ctxSub.textContent = "链接无效或已过期";
    el.btnSubmit.disabled = true;
    return;
  }

  const left = ctx.trial_expires_at ? daysLeft(ctx.trial_expires_at) : null;
  let trialTxt = "未配置";
  let trialBadge = "";
  if (left !== null){
    if (left >= 0){
      trialTxt = `试用中：剩余 ${left} 天（到期 ${fmtDate(ctx.trial_expires_at)}）`;
      trialBadge = "<span class='badge ok'>可录入</span>";
    } else {
      trialTxt = `已到期：项目只读（${fmtDate(ctx.trial_expires_at)}）`;
      trialBadge = "<span class='badge bad'>只读</span>";
      el.btnSubmit.disabled = true;
      el.submitHint.textContent = "提示：项目试用已到期，当前为只读。";
    }
  }

  el.ctxSub.textContent = `${ctx.project_name} · center_code=${ctx.center_code} · module=${ctx.module}`;
  el.ctxBox.innerHTML = `
    <div>项目</div><div><b>${escapeHtml(ctx.project_name)}</b></div>
    <div>中心</div><div><code>${escapeHtml(ctx.center_code)}</code></div>
    <div>模块</div><div><code>${escapeHtml(ctx.module)}</code></div>
    <div>patient_code</div><div><b>${escapeHtml(ctx.patient_code)}</b></div>
    <div>试用状态</div><div>${trialBadge} <span class="muted small">${escapeHtml(trialTxt)}</span></div>
  `;

  // default date = today
  if (!el.visitDate.value){
    el.visitDate.value = new Date().toISOString().slice(0,10);
  }
  computeEgfr();
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

async function submitVisit(){
  if (!ctx) return;
  const visit_date = el.visitDate.value;
  if (!visit_date){ toast("请填写随访日期"); return; }

  const payload = {
    p_token: token,
    p_visit_date: visit_date,
    p_sbp: el.sbp.value ? Number(el.sbp.value) : null,
    p_dbp: el.dbp.value ? Number(el.dbp.value) : null,
    p_scr_umol_l: el.scr.value ? Number(el.scr.value) : null,
    p_upcr: el.upcr.value ? Number(el.upcr.value) : null,
    p_egfr: el.egfr.value ? Number(el.egfr.value) : null,
    p_notes: el.notes.value ? el.notes.value.slice(0, 500) : null,
  };

  el.btnSubmit.disabled = true;
  try{
    const { data, error } = await sb.rpc("patient_submit_visit", payload);
    if (error) throw error;
    toast("已提交随访");
    el.notes.value = "";
    await loadVisits();
  }catch(e){
    console.error(e);
    toast("提交失败：" + (e?.message || e));
    el.btnSubmit.disabled = false;
  }
}

async function loadVisits(){
  el.visitsBox.innerHTML = "<div class='muted small'>加载中…</div>";
  const { data, error } = await sb.rpc("patient_list_visits", { p_token: token, p_limit: 30 });
  if (error){
    console.error(error);
    el.visitsBox.innerHTML = "<div class='muted small'>读取失败</div>";
    return;
  }
  const rows = data || [];
  if (!rows.length){
    el.visitsBox.innerHTML = "<div class='muted small'>暂无随访记录</div>";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.visit_date||"")}</td>
      <td>${escapeHtml(r.sbp||"")}/${escapeHtml(r.dbp||"")}</td>
      <td>${escapeHtml(r.scr_umol_l||"")}</td>
      <td>${escapeHtml(r.upcr||"")}</td>
      <td>${escapeHtml(r.egfr||"")}</td>
      <td class="muted small">${escapeHtml((r.notes||"").slice(0,60))}</td>
    </tr>
  `).join("");
  el.visitsBox.innerHTML = `
    <table class="table">
      <thead><tr><th>日期</th><th>BP</th><th>Scr(μmol/L)</th><th>UPCR</th><th>eGFR</th><th>备注</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function bind(){
  el.btnSubmit.addEventListener("click", submitVisit);
  el.btnRefresh.addEventListener("click", loadVisits);
  el.scr.addEventListener("input", computeEgfr);
  el.visitDate.addEventListener("change", computeEgfr);
}

async function main(){
  token = getToken();
  if (!token){
    el.ctxSub.textContent = "缺少 token";
    el.ctxBox.innerHTML = "<div class='muted small'>请使用中心提供的随访链接打开本页。</div>";
    el.btnSubmit.disabled = true;
    return;
  }
  bind();
  await loadContext();
  await loadVisits();
}

main();
