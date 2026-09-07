const department=location.pathname.split('/').filter(Boolean)[1]||'education';
let rows=[],identity={};
const roleRank={viewer:1,officer:2,administrator:3};
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const fmt=value=>{if(!value)return '';try{return new Date(value).toLocaleString()}catch{return value}};

function showDeveloperPreviewBanner(admin){
  let banner=document.getElementById('developerPreviewBanner');
  if(!admin?.developerPreview){if(banner)banner.remove();return;}
  if(!banner){banner=document.createElement('div');banner.id='developerPreviewBanner';banner.className='developer-preview-banner';document.querySelector('header.topbar')?.insertAdjacentElement('afterend',banner);}
  const label=admin.developerPreviewLabel||admin.name||admin.username||'user',expiry=admin.previewExpiresAt?` · expires ${fmt(admin.previewExpiresAt)}`:'';
  banner.innerHTML=`<div><strong>Developer Preview Mode</strong><span>Viewing as ${esc(label)}${esc(expiry)}. Payroll actions are live and recorded.</span></div><div class="developer-preview-actions"><a href="/developer#operations">Return to Developer Portal</a><button type="button" id="exitDeveloperPreview">Exit Preview</button></div>`;
  banner.querySelector('#exitDeveloperPreview').onclick=async()=>{await fetch('/api/admin-logout',{method:'POST'}).catch(()=>{});location.href='/developer#operations';};
}
async function get(url,options){
  const response=await fetch(url,options),data=await response.json().catch(()=>({}));
  if(response.status===401){location.href=`/admin-login.html?department=${encodeURIComponent(department)}&next=${encodeURIComponent(location.pathname)}`;throw new Error('Authentication required.');}
  if(!response.ok)throw new Error(data.error||'Request failed.');
  return data;
}
function activityMatches(row,value){if(value==='all')return true;if(value==='field-experience')return row.activityGroup==='field-experience';return row.activityKey===value;}
function matches(row){
  const activity=document.getElementById('activityFilter').value,status=document.getElementById('statusFilter').value,query=document.getElementById('search').value.trim().toLowerCase();
  if(!activityMatches(row,activity)||status!=='all'&&row.payrollStatus!==status)return false;
  return !query||[row.reference,row.workType,row.category,row.supervisorName,row.email,row.studyCentres,row.contextLabel,row.payrollStatusLabel,row.payrollNote].join(' ').toLowerCase().includes(query);
}
function quantitySummary(row){return `<div class="quantity-stack"><span><b>${esc(row.claimedQuantity??row.claimedGroupsRaw)}</b> claimed</span><span><b>${esc(row.scoreSheetQuantity)}</b> approved scores</span>${row.supportingWorkCount==null?'':`<span><b>${esc(row.supportingWorkCount)}</b> supporting files</span>`}</div>`;}
function checkSummary(row){return `<div class="check-stack"><span class="${row.validation?.valid?'check-ok':'check-bad'}">${row.validation?.valid?'MATCH':'REQUIRES RECONCILIATION'}</span>${row.claimFormPresent?`<button class="btn compact-btn" onclick="openClaim('${esc(row.id)}','${esc(row.reference)}')">Preview claim${Number(row.claimFormCount)>1?` (${esc(row.claimFormCount)})`:''}</button>`:'<span class="check-bad">Claim form missing</span>'}</div>`;}
function actionButtons(row){if((roleRank[identity.role]||0)<2)return '<span class="read-only">Read only</span>';return `<div class="payroll-row-actions"><button class="btn good" onclick="setStatus('${esc(row.id)}','verified')">Verify</button><button class="btn primary" onclick="setStatus('${esc(row.id)}','approved-for-payment')">Approve Payment</button><button class="btn good" onclick="setStatus('${esc(row.id)}','paid')">Mark Paid</button><button class="btn warn" onclick="setStatus('${esc(row.id)}','queried')">Query / Hold</button><button class="btn reset-action" onclick="setStatus('${esc(row.id)}','pending')">Reset</button></div>`;}
function render(){
  const list=rows.filter(matches);document.getElementById('count').textContent=list.length;document.getElementById('empty').hidden=Boolean(list.length);
  document.getElementById('rows').innerHTML=list.map((row,index)=>`<tr><td>${index+1}</td><td><strong class="claim-reference">${esc(row.reference)}</strong><span class="workflow-label">${esc(row.workType)}</span><small>${esc(row.category)}</small>${row.contextLabel?`<small>${esc(row.contextLabel)}</small>`:''}</td><td><strong>${esc(row.supervisorName)}</strong><small>${esc(row.email)}</small><small>${esc(row.phone)}</small></td><td>${esc(fmt(row.approvedAt))}<small>${esc(row.approvedBy)}</small></td><td>${quantitySummary(row)}</td><td>${checkSummary(row)}</td><td><span class="status ${esc(row.payrollStatus)}">${esc(row.payrollStatusLabel)}</span>${row.payrollNote?`<small class="payroll-note">${esc(row.payrollNote)}</small>`:''}</td><td>${actionButtons(row)}</td></tr>`).join('');
}
window.openClaim=(id,reference)=>{document.getElementById('claimTitle').textContent=`Claim Form · ${reference}`;document.getElementById('claimFrame').src=`/api/admin/${encodeURIComponent(department)}/submissions/${encodeURIComponent(id)}/claim-preview`;document.getElementById('claimDialog').showModal();};
window.setStatus=async(id,status)=>{let note='';if(['queried','paid','approved-for-payment'].includes(status)){const entered=prompt(status==='queried'?'Enter query or hold reason:':status==='paid'?'Enter payment reference or note:':'Enter approval note:','');if(entered===null)return;note=entered.trim();}try{await get(`/api/payroll/${encodeURIComponent(department)}/claims/${encodeURIComponent(id)}/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,note})});await load();}catch(error){alert(error.message);}};
function populateDepartments(info){const select=document.getElementById('departmentFilter'),list=info.availableDepartments||[{slug:info.department,name:info.departmentName}];select.innerHTML=list.map(item=>`<option value="${esc(item.slug)}" ${item.slug===department?'selected':''}>${esc(item.name)}</option>`).join('');select.disabled=list.length<2;}
async function load(){
  const [info,data]=await Promise.all([get(`/api/admin/${encodeURIComponent(department)}/info`),get(`/api/payroll/${encodeURIComponent(department)}/claims`)]);
  identity=info.admin||{};rows=data;showDeveloperPreviewBanner(identity);populateDepartments(info);document.getElementById('departmentName').textContent=info.departmentName;
  document.getElementById('approvedRegister').href=`/api/payroll/${encodeURIComponent(department)}/approved-register.xlsx`;document.getElementById('payrollRegister').href=`/api/payroll/${encodeURIComponent(department)}/register.xlsx`;render();
}
document.getElementById('departmentFilter').onchange=event=>{location.href=`/payroll/${encodeURIComponent(event.target.value)}`;};
document.getElementById('activityFilter').onchange=render;document.getElementById('statusFilter').onchange=render;document.getElementById('search').oninput=render;
document.getElementById('closeClaim').onclick=()=>{document.getElementById('claimFrame').src='about:blank';document.getElementById('claimDialog').close();};
document.getElementById('logoutBtn').onclick=async()=>{await fetch('/api/admin-logout',{method:'POST'}).catch(()=>{});location.href='/';};
load().catch(error=>{console.error(error);alert(error.message);});
