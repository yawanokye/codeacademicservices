'use strict';

const assert=require('assert/strict');
const crypto=require('crypto');
const fsp=require('fs/promises');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const XLSX=require('xlsx');

const root=path.resolve(__dirname,'..'),port=19500+Math.floor(Math.random()*300),base=`http://127.0.0.1:${port}`,username='hod.education@example.edu',password='Strong-HoD-Test-Password!';
const authorization=`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const headers={authorization};
async function request(url,options={}){return fetch(`${base}${url}`,options)}
async function json(url,options={}){const response=await request(url,options),data=await response.json().catch(()=>({}));assert.equal(response.status,options.expectedStatus||200,`${url}: ${data.error||response.status}`);return data}
function hashFile(buffer){return crypto.createHash('sha256').update(buffer).digest('hex')}

async function main(){
  const storage=await fsp.mkdtemp(path.join(os.tmpdir(),'codeacademicservices-v43-')),dataDir=path.join(storage,'data'),filesDir=path.join(storage,'files');await fsp.mkdir(dataDir,{recursive:true});await fsp.mkdir(filesDir,{recursive:true});
  const sourceFiles={claim:'claim-original.pdf',report:'report.docx',score:'scores.xlsx',work1:'work-one.docx',work2:'work-two.docx'},claimBytes=Buffer.from('%PDF-1.4\noriginal claim fixture\n%%EOF');
  await Promise.all([fsp.writeFile(path.join(filesDir,sourceFiles.claim),claimBytes),fsp.writeFile(path.join(filesDir,sourceFiles.report),'report'),fsp.writeFile(path.join(filesDir,sourceFiles.score),'scores'),fsp.writeFile(path.join(filesDir,sourceFiles.work1),'work one'),fsp.writeFile(path.join(filesDir,sourceFiles.work2),'work two')]);
  const file=(storedName,originalName)=>({storedName,originalName,mimeType:'application/octet-stream',size:1});
  const record={id:'project-payment-fixture',portalType:'project-work',department:'education',departmentName:'Department of Education Programmes',reference:'PWORK-V43-001',submittedAt:'2026-09-10T09:00:00.000Z',title:'Dr',firstName:'Ama',lastName:'Mensah',fullName:'Dr Ama Mensah',email:'ama.claimant@example.edu',staffId:'STAFF-001',phone:'0240000000',groupCount:'2',claimedGroupCount:2,studyCentres:['Centre A','Centre B'],studyCentre:'Centre A | Centre B',projectStream:'distance',reviewStatus:'approved',reviewedAt:'2026-09-10T11:00:00.000Z',reviewedBy:'Department Reviewer',reviewHistory:[{status:'approved',reviewedAt:'2026-09-10T11:00:00.000Z',reviewedBy:'Department Reviewer'}],scoreSheet:{rows:[{originalSn:'1',name:'Student A',registrationNo:'BEP/CA/01/001',groupNo:'1',totalScore:'80'},{originalSn:'2',name:'Student B',registrationNo:'BEP/CB/02/001',groupNo:'1',totalScore:'82'}]},scoreReviewExcludedRows:[],claimantCertification:{status:'verified',declarationText:'I certify that this claim is accurate and authorize its submission for processing.',claimantName:'Dr Ama Mensah',claimantEmail:'ama.claimant@example.edu',staffId:'STAFF-001',declaredAt:'2026-09-10T09:00:00.000Z',verifiedAt:'2026-09-10T09:05:00.000Z',verificationChannel:'verified-email-link',history:[{action:'claim-electronically-certified',at:'2026-09-10T09:05:00.000Z'}]},files:{claimForm:file(sourceFiles.claim,'claim-original.pdf'),reportFile:file(sourceFiles.report,'report.docx'),scoresFile:file(sourceFiles.score,'scores.xlsx'),completedWork:[file(sourceFiles.work1,'work-one.docx'),file(sourceFiles.work2,'work-two.docx')]}};
  const salt=crypto.randomBytes(16).toString('hex'),passwordHash=crypto.scryptSync(password,salt,64).toString('hex'),account={id:'hod-account',name:'Prof. Head of Department',email:username,username,role:'administrator',departments:['education'],hodDepartments:['education'],sections:['project-work','payroll','auditor'],units:[],active:true,passwordSalt:salt,passwordHash};
  await Promise.all([fsp.writeFile(path.join(dataDir,'submissions.json'),JSON.stringify([record],null,2)),fsp.writeFile(path.join(dataDir,'admin-users.json'),JSON.stringify([account],null,2)),fsp.writeFile(path.join(dataDir,'support-tickets.json'),'[]')]);
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),STORAGE_DIR:storage,GMAIL_CLIENT_ID:'',GMAIL_CLIENT_SECRET:'',GMAIL_REFRESH_TOKEN:'',GMAIL_SENDER_EMAIL:'',DEVELOPER_ADMIN_PASSWORD:'test-developer-secret',SUPPORT_STATUS_TOKEN_SECRET:'different-support-secret'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});
  try{
    const deadline=Date.now()+15000;while(!output.includes('listening on')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));assert.match(output,/listening on/,output);
    let detail=await json('/api/admin/education/submissions/project-payment-fixture',{headers});assert.equal(detail.groupValidation.scoreSheetGroupCount,2,'Group 1 at two centres must count as two groups');assert.equal(detail.paymentUnits.length,2);
    const signature=new FormData();signature.set('signature',new Blob([await fsp.readFile(path.join(root,'public','ucc-logo.png'))],{type:'image/png'}),'hod-signature.png');await json('/api/admin/education/hod-signature-profile',{method:'POST',headers,body:signature});
    const keys=detail.paymentUnits.map(unit=>unit.key);let response=await request('/api/admin/education/claims/project-payment-fixture/payment-approval',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({password:'wrong',approvedUnitKeys:[keys[0]],adjustmentReason:'Test part payment'})});assert.equal(response.status,401);assert.match((await response.json()).error,/password/i);
    const originalHash=hashFile(await fsp.readFile(path.join(filesDir,sourceFiles.claim)));
    let approval=await json('/api/admin/education/claims/project-payment-fixture/payment-approval',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({password,approvedUnitKeys:[keys[0]],adjustmentReason:'One group held for reconciliation'})});assert.equal(approval.paymentApproval.approvedQuantity,1);assert.equal(hashFile(await fsp.readFile(path.join(filesDir,sourceFiles.claim))),originalHash,'Original claim must remain unchanged');
    response=await request(approval.approvedClaimUrl,{headers});assert.equal(response.status,200);const pdf=Buffer.from(await response.arrayBuffer());assert.equal(pdf.subarray(0,4).toString(),'%PDF');
    response=await request('/api/admin/education/export/payment-approved-register.xlsx',{headers});assert.equal(response.status,200);let wb=XLSX.read(await response.arrayBuffer(),{type:'array'});assert.equal(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1}).length,2);
    await json('/api/payroll/education/claims/project-payment-fixture/status',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({status:'approved-for-payment',note:'Approved by Payroll'})});
    response=await request('/api/payroll/education/approved-register.xlsx',{headers});wb=XLSX.read(await response.arrayBuffer(),{type:'array'});assert.equal(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1}).length,2);
    let auditor=await json('/api/auditor/education/claims',{headers});assert.equal(auditor.length,1);assert.ok(auditor[0].approvedClaimUrl);assert.ok(auditor[0].auditUrl);
    await json('/api/payroll/education/claims/project-payment-fixture/status',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({status:'returned-to-department',note:'Quantity reconciliation required'})});
    let verification=await json(`/api/claim-verification/${encodeURIComponent(approval.paymentApproval.verificationCode)}`);assert.equal(verification.valid,false);detail=await json('/api/admin/education/submissions/project-payment-fixture',{headers});assert.equal(detail.paymentApproval.status,'returned');assert.match(detail.paymentApproval.returnReason,/reconciliation/i);auditor=await json('/api/auditor/education/claims',{headers});assert.equal(auditor.length,0);
    approval=await json('/api/admin/education/claims/project-payment-fixture/payment-approval',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({password,approvedUnitKeys:keys,adjustmentReason:''})});verification=await json(`/api/claim-verification/${encodeURIComponent(approval.paymentApproval.verificationCode)}`);assert.equal(verification.valid,true);
    await json('/api/admin/education/project-work/project-payment-fixture/review',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({status:'approved',note:'Source review repeated',excludedRowIndexes:[1]})});verification=await json(`/api/claim-verification/${encodeURIComponent(approval.paymentApproval.verificationCode)}`);assert.equal(verification.valid,false,'Changing approved source data must invalidate the HoD approval');
    console.log('v43 payment workflow verified');
  }finally{child.kill('SIGTERM');await fsp.rm(storage,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
