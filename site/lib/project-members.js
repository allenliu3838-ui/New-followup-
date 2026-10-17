/** Project member controls. Database RPCs remain authoritative for all access. */
const ROLE_NAMES = Object.freeze({owner:'牵头 PI / 项目负责人', editor:'录入与更正', analyst:'分析与导出', viewer:'只读查看'});
const ASSIGNABLE = ['editor', 'analyst', 'viewer'];
const ROLE_COPY = Object.freeze({
  owner:'可管理项目与成员、录入和更正研究数据、发放随访链接及导出。',
  editor:'可查看、录入和更正研究数据，发放或撤销随访链接；不能管理成员或导出。',
  analyst:'可查看研究数据并导出；不能录入、更正或管理成员。',
  viewer:'可查看研究数据；不能录入、更正、发放随访链接或使用系统导出功能。'
});
const STYLE = `
.pm-panel{margin:16px 0;padding:20px;border:1px solid #dbe3ee;border-radius:14px;background:#fff;color:#172033}
.pm-panel h3{margin:0 0 8px}.pm-muted{color:#526176;font-size:14px;line-height:1.65}.pm-status{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}.pm-status[data-error="true"]{color:#a12727}
.pm-add{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:16px 0}.pm-add label{display:flex;flex-direction:column;gap:6px;min-width:160px;flex:1}.pm-add input,.pm-panel select,.pm-panel button{min-height:44px;font:inherit;border:1px solid #bdc9d8;border-radius:8px;background:#fff;padding:9px 12px}.pm-add input{min-width:0;width:100%;box-sizing:border-box}.pm-panel button{cursor:pointer;color:#164dab}.pm-panel button:disabled,.pm-panel select:disabled,.pm-panel input:disabled{opacity:.6;cursor:default}.pm-panel button:focus-visible,.pm-panel input:focus-visible,.pm-panel select:focus-visible{outline:3px solid #4e85ed;outline-offset:2px}
.pm-list{list-style:none;margin:0;padding:0}.pm-member{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:14px 0;border-top:1px solid #e4eaf2}.pm-identity{min-width:0;flex:1 1 200px;overflow-wrap:anywhere}.pm-name{font-weight:650}.pm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.pm-role{display:block;font-size:14px;color:#526176;margin-top:4px}.pm-panel .pm-remove{color:#9b2525}.pm-panel [hidden]{display:none!important}@media(max-width:640px){.pm-panel{padding:16px}.pm-add{display:block}.pm-add label{margin-bottom:12px}.pm-add button{width:100%}.pm-actions{width:100%}.pm-actions select{flex:1;min-width:130px}}
`;

/** setContext must receive the current authenticated user's get_project_access result. */
export function createProjectMembers({root, sb, onAccessChange, confirmAction} = {}) {
  if (!root || !sb || typeof sb.rpc !== 'function') throw new Error('Project member controls require a root and database client.');
  const doc = root.ownerDocument;
  let epoch=0, readEpoch=0, ctx=null, busy=false, members=[], listReady=false;
  const refs={};
  const confirmRemove = confirmAction || (message => doc.defaultView?.confirm ? doc.defaultView.confirm(message) === true : globalThis.confirm?.(message) === true);
  function node(tag,text,className){const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
  function live(c){return ctx===c && c?.epoch===epoch;}
  function manages(c=ctx){return !!c && c.access.role==='owner' && c.access.can_manage_members===true;}
  function status(text,error=false){if(!refs.status)return;refs.status.textContent=text;refs.status.dataset.error=String(error);refs.status.setAttribute('role',error?'alert':'status');}
  function lock(value){busy=value;root.setAttribute('aria-busy',String(value));for(const input of root.querySelectorAll('button,input,select'))input.disabled=value || (input.dataset.mutation==='true' && !listReady);}
  function errorMessage(error){
    const code=String(error?.message||'');
    if(/permission_denied|not_authorized|not_project_owner|owner_required|access_denied|project_not_found/.test(code))return '当前账号已无成员管理权限。请重新选择项目以刷新权限。';
    if(/invalid_member_role|invalid_role|cannot_modify_owner|cannot_remove_owner|owner_is_immutable|owner_immutable/.test(code))return '不能更改或移除项目负责人。请选择其他成员和允许分配的角色。';
    if(/member_not_found/.test(code))return '该成员已不在项目中，请刷新成员列表。';
    return '操作结果尚未确认。请刷新成员列表核对后再操作；若持续失败，请稍后重试。';
  }
  function roleSelect(role,label){const select=node('select');select.setAttribute('aria-label',label);select.dataset.mutation='true';for(const name of ASSIGNABLE){const option=node('option',ROLE_NAMES[name]);option.value=name;if(name===role)option.selected=true;select.append(option);}return select;}
  function build(){
    const c=ctx;
    root.replaceChildren();root.classList.add('pm-panel');root.hidden=false;root.setAttribute('aria-label','项目成员与权限');
    root.append(node('style',STYLE),node('h3','项目成员'));
    root.append(node('p',`${ctx.projectName ? ctx.projectName+' · ' : ''}你的角色：${ROLE_NAMES[ctx.access.role]||'暂无项目访问权限'}`,'pm-muted'));
    root.append(node('p',ROLE_COPY[ctx.access.role]||'请联系项目负责人确认成员授权。','pm-muted'));
    if(ctx.access.can_read===true)root.append(node('p','成员可接触其权限内的研究数据。只读或关闭导出功能，不能阻止查看者自行复制已显示的内容。','pm-muted'));
    if(['owner','editor'].includes(ctx.access.role)&&ctx.access.can_write!==true)root.append(node('p','当前项目暂不可新增或更正数据。项目负责人仍可管理成员；随访链接可按权限撤销。','pm-muted'));
    refs.status=node('p','','pm-status');refs.status.setAttribute('aria-live','polite');root.append(refs.status);
    if(!manages())return;
    const form=node('form',undefined,'pm-add');form.noValidate=true;
    const emailLabel=node('label','同事的注册邮箱');const email=node('input');email.type='email';email.autocomplete='off';email.maxLength=254;email.placeholder='已注册并完成邮箱验证';email.dataset.memberEmail='true';email.dataset.mutation='true';emailLabel.append(email);
    const roleLabel=node('label','分配角色');const select=roleSelect('viewer','新成员角色');select.dataset.newRole='true';roleLabel.append(select);
    const add=node('button','添加成员');add.type='submit';add.dataset.action='add';add.dataset.mutation='true';
    form.append(emailLabel,roleLabel,add);root.append(form,node('p','请先请同事完成账号注册与邮箱验证，再添加成员。项目负责人身份不会通过此处转让。','pm-muted'));
    const refresh=node('button','刷新成员列表');refresh.type='button';refresh.dataset.action='refresh';refresh.addEventListener('click',()=>{if(live(c))void api.refresh();});root.append(refresh);
    refs.email=email;refs.newRole=select;refs.form=form;
    refs.list=node('ul',undefined,'pm-list');refs.list.setAttribute('aria-label','当前项目成员');root.append(refs.list);
    form.addEventListener('submit',event=>{event.preventDefault();if(live(c))void addMember();});
    lock(false);
  }
  function renderMembers(){
    const c=ctx;
    refs.list.replaceChildren();
    for(const member of members){
      const li=node('li',undefined,'pm-member');const identity=node('div',undefined,'pm-identity');
      identity.append(node('div',member.display_name||member.email||'项目成员','pm-name'));
      if(member.display_name&&member.email)identity.append(node('div',member.email,'pm-muted'));
      identity.append(node('span',ROLE_NAMES[member.role]||'未知角色','pm-role'));li.append(identity);
      if(member.is_owner===true||member.role==='owner'||member.user_id===ctx.userId){identity.append(node('span','负责人身份不可在此更改','pm-role'));}
      else {
        if(member.role==='editor')identity.append(node('span','移除此录入员或降为分析 / 只读角色，会使本项目现有随访链接失效，需要重新生成并发放。','pm-role'));
        const actions=node('div',undefined,'pm-actions');const select=roleSelect(member.role,`更改 ${member.email||'成员'} 的角色`);select.dataset.memberId=member.user_id;
        const save=node('button','保存角色');save.type='button';save.dataset.action='role';save.dataset.memberId=member.user_id;save.dataset.mutation='true';
        const remove=node('button','移除成员','pm-remove');remove.type='button';remove.dataset.action='remove';remove.dataset.memberId=member.user_id;remove.dataset.mutation='true';
        save.addEventListener('click',()=>{if(live(c))void changeRole(member,select.value);});remove.addEventListener('click',()=>{if(live(c))void removeMember(member);});
        actions.append(select,save,remove);li.append(actions);
      }
      refs.list.append(li);
    }
    lock(busy);
  }
  function validMembers(rows){return Array.isArray(rows)&&rows.length>0&&new Set(rows.map(m=>m?.user_id)).size===rows.length&&rows.every(m=>m&&typeof m.user_id==='string'&&!!m.user_id&&typeof m.email==='string'&&(m.display_name==null||typeof m.display_name==='string')&&Object.hasOwn(ROLE_NAMES,m.role)&&typeof m.is_owner==='boolean')&&rows.some(m=>m.user_id===ctx.userId&&m.is_owner===true&&m.role==='owner');}
  async function load(c,successText=''){
    const read=++readEpoch;listReady=false;lock(true);status('正在读取成员列表…');
    try{
      const {data,error}=await sb.rpc('list_project_members',{p_project_id:c.projectId});
      if(!live(c)||read!==readEpoch)return;
      if(error)throw error;
      if(!validMembers(data))throw new Error('invalid_member_response');
      members=data.map(m=>({...m}));listReady=true;renderMembers();status(successText||`已读取 ${members.length} 位成员（含项目负责人）。`);
    }catch(error){if(live(c)&&read===readEpoch){members=[];refs.list.replaceChildren();status(`成员列表读取失败。${errorMessage(error)}`,true);}}
    finally{if(live(c)&&read===readEpoch)lock(false);}
  }
  async function mutate(name,args,success,revokesTokens=false){
    const c=ctx;if(!manages(c)||busy||!listReady)return false;
    lock(true);status('正在保存成员设置…');
    try{
      const {data,error}=await sb.rpc(name,{p_project_id:c.projectId,...args});
      if(!live(c))return false;
      if(error)throw error;
      const result=data;
      let message;
      if(name==='add_project_member'){
        if(result?.status==='not_added'){status('未添加成员。请确认对方已使用该邮箱注册并完成验证，且可加入此项目。',true);return false;}
        if(result?.status==='rate_limited'){status('添加成员尝试较多，请稍后再试。当前成员列表未改变。',true);return false;}
        if(!['added','already_member'].includes(result?.status))throw new Error('unknown_member_result');
        message=result.status==='already_member'?'该账号已是项目成员；原有角色保留。请在列表中核对。':success;
        refs.email.value='';
      }else{
        const expected=name==='change_project_member_role'?'updated':'removed';
        if(result?.status!==expected)throw new Error('unknown_member_result');
        message=success;
        if(revokesTokens||Number(result.revoked_token_count)>0){
          message+=Number.isInteger(result.revoked_token_count)&&result.revoked_token_count>=0
            ?` 已使 ${result.revoked_token_count} 个现有随访链接失效，需要重新生成并发放。`
            :' 随访链接撤销数量尚未确认，请刷新随访链接列表核对。';
        }
      }
      await load(c,message);
      if(live(c)&&typeof onAccessChange==='function')await onAccessChange({projectId:c.projectId,userId:c.userId});
      return true;
    }catch(error){if(live(c))status(errorMessage(error),true);return false;}
    finally{if(live(c))lock(false);}
  }
  async function addMember(){
    if(!manages()||busy||!listReady)return;
    const email=refs.email.value.trim(),role=refs.newRole.value;
    if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){status('请输入同事注册时使用的完整邮箱。',true);refs.email.focus();return;}
    if(!ASSIGNABLE.includes(role)){status('请选择允许分配的成员角色。',true);return;}
    await mutate('add_project_member',{p_email:email,p_role:role},'成员已添加。');
  }
  async function changeRole(member,role){
    const c=ctx;if(!manages(c)||busy||!listReady||member.is_owner||member.user_id===c.userId)return;
    if(!ASSIGNABLE.includes(role)){status('请选择允许分配的成员角色。',true);return;}
    if(role===member.role){status('角色没有变化。');return;}
    const revokesTokens=member.role==='editor'&&role!=='editor';
    if(revokesTokens&&!confirmRemove('撤销此录入员的写权限，会使本项目现有随访链接失效，需要重新生成并发放。确认更改角色？'))return;
    if(!live(c))return;
    await mutate('change_project_member_role',{p_user_id:member.user_id,p_role:role},'成员角色已更新。',revokesTokens);
  }
  async function removeMember(member){
    const c=ctx;if(!manages(c)||busy||!listReady||member.is_owner||member.user_id===c.userId)return;
    const revokesTokens=member.role==='editor';
    if(!confirmRemove(`从当前项目移除 ${member.email}？对方将失去该项目的访问权限，已录入的研究数据会保留。${revokesTokens?'\n此操作会使本项目现有随访链接失效，需要重新生成并发放。':''}`))return;
    if(!live(c))return;
    await mutate('remove_project_member',{p_user_id:member.user_id},'成员已移除，已录入的研究数据保留。',revokesTokens);
  }
  const api={
    async setContext(value){
      epoch++;readEpoch++;ctx=null;busy=false;members=[];listReady=false;
      for(const key of Object.keys(refs))delete refs[key];
      if(!value?.projectId||!value?.userId||!value?.access){root.replaceChildren();root.hidden=true;root.setAttribute('aria-busy','false');return;}
      ctx={projectId:String(value.projectId),userId:String(value.userId),projectName:String(value.projectName||''),access:{...value.access},epoch};
      build();if(manages())await load(ctx);else root.setAttribute('aria-busy','false');
    },
    async refresh(){const c=ctx;if(!manages(c)||busy)return;await load(c);},
    clear(){epoch++;readEpoch++;ctx=null;busy=false;members=[];listReady=false;root.replaceChildren();root.hidden=true;root.setAttribute('aria-busy','false');for(const key of Object.keys(refs))delete refs[key];}
  };
  return api;
}
