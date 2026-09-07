function setStatus(el, ok, message){
  el.className='status show '+(ok?'ok':'bad');
  el.textContent=message;
}
async function submitForm(form, endpoint, statusEl, submitBtn){
  submitBtn.disabled=true;
  const old=submitBtn.textContent;
  submitBtn.textContent='Submitting…';
  statusEl.className='status';
  try{
    const res=await fetch(endpoint,{method:'POST',body:new FormData(form)});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||'Submission failed.');
    const destination=data.departmentName?` Destination: ${data.departmentName}.`:'';
    const validation=data.titleValidated?' Dissertation title validated against the uploaded work.':'';
    const review=data.reviewStatusLabel?` Status: ${data.reviewStatusLabel}. Scores will enter consolidated outputs only after departmental approval.`:'';
    setStatus(statusEl,true,`Submission received successfully. Reference: ${data.reference}.${destination}${validation}${review}`);
    form.reset();
    return data;
  }catch(err){
    setStatus(statusEl,false,err.message||'Submission failed.');
    throw err;
  }finally{
    submitBtn.disabled=false;
    submitBtn.textContent=old;
  }
}

function formatBytes(bytes){
  const n=Number(bytes||0);
  if(!n)return '';
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${(n/1024).toFixed(n<10*1024?1:0)} KB`;
  return `${(n/(1024*1024)).toFixed(n<10*1024*1024?1:0)} MB`;
}
function resourceEscape(value){
  return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
async function loadPortalResources(portal, sectionId='resourcesSection', listId='resourceList', department=''){
  const section=document.getElementById(sectionId),list=document.getElementById(listId);
  if(!section||!list)return;
  if(!department){section.hidden=true;list.innerHTML='';return;}
  try{
    const departmentPart=department?`&department=${encodeURIComponent(department)}`:'';
    const res=await fetch(`/api/resources?portal=${encodeURIComponent(portal)}${departmentPart}`);
    const resources=await res.json().catch(()=>[]);
    if(!res.ok)throw new Error(resources.error||'Could not load resources.');
    if(!Array.isArray(resources)||!resources.length){section.hidden=true;return;}
    const heading=section.querySelector('h3');if(heading)heading.textContent=`${resources[0]?.departmentName||'Department'} Resources`;
    list.innerHTML=resources.map(r=>`<article class="resource-card"><div class="resource-icon">↓</div><div class="resource-copy"><h4>${resourceEscape(r.title)}</h4>${r.description?`<p>${resourceEscape(r.description)}</p>`:''}<div class="resource-meta">${resourceEscape(r.departmentName||'')} · ${resourceEscape(r.originalName||'Resource')}${r.size?` · ${resourceEscape(formatBytes(r.size))}`:''}</div></div><a class="btn secondary resource-download" href="${resourceEscape(r.downloadUrl)}">Download</a></article>`).join('');
    section.hidden=false;
  }catch(e){
    console.error('Could not load portal resources:',e);
    section.hidden=true;
  }
}

async function loadStudyCentres(selectId='studyCentre',extraCentres=[],department=''){
  const select=document.getElementById(selectId);if(!select)return;
  if(!department){select.innerHTML=`<option value="" ${select.multiple?'disabled':''}>Select department first</option>`;return;}
  try{
    const res=await fetch(`/api/study-centres?department=${encodeURIComponent(department)}`);let centres=await res.json();
    if(!res.ok||!Array.isArray(centres))throw new Error(centres?.error||'Could not load study centres.');
    centres=[...new Set([...centres,...(Array.isArray(extraCentres)?extraCentres:[])])].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true,sensitivity:'base'}));
    const prompt=select.multiple?'Select one or more study centres':'Select study centre';
    select.innerHTML=`<option value="" ${select.multiple?'disabled':''}>${prompt}</option>`+centres.map(c=>`<option value="${resourceEscape(c)}">${resourceEscape(c)}</option>`).join('');
  }catch(e){console.error(e);select.innerHTML='<option value="">Study centres unavailable for this department</option>';}
}
