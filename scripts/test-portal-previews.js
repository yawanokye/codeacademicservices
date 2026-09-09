'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const developerUser = 'preview-tester';
const developerPassword = 'preview-test-password';
const developerAuthorization = `Basic ${Buffer.from(`${developerUser}:${developerPassword}`).toString('base64')}`;

function fixtureTicket({ id, reference, type, status, unit, unitLabel, sensitive = false }) {
  const createdAt = '2026-09-01T08:00:00.000Z';
  return { id, reference, type, status, categoryKey:'general-enquiry', categoryLabel:'General Enquiry', priorityKey:'normal', priorityLabel:'Normal', sensitive, name:`Student ${id}`, email:`${id}@example.edu`, phone:'0200000000', studentNumber:`IDX-${id}`, subject:`${type} ${id}`, description:'Portal verification fixture', studyCentre:'Cape Coast', programme:'Test Programme', ownerUnitId:unit, ownerUnit:unitLabel, assignedCaseOwner:'Test Officer', createdAt, lastUpdatedAt:createdAt, dueAt:status==='closed'?'2026-09-05T08:00:00.000Z':'2026-09-02T08:00:00.000Z', referrals:[], interUnitMessages:[], auditTrail:[], studentUpdates:[], evidence:[], officerEvidence:[] };
}

async function request(url, options = {}) {
  const response = await fetch(`${base}${url}`, options);
  return response;
}

function sessionCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/ucc_admin_session=[^;]+/);
  assert.ok(match, 'preview response must set a session cookie');
  return match[0];
}

async function developerPost(url, body) {
  const response = await request(url, { method:'POST', headers:{ authorization:developerAuthorization, 'content-type':'application/json' }, body:JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, 200, `${url}: ${data.error || response.status}`);
  return { data, cookie:sessionCookie(response) };
}

async function expectPage(url, cookie, marker) {
  const response = await request(url, { headers:{ cookie, accept:'text/html' } });
  const text = await response.text();
  assert.equal(response.status, 200, `${url} should load`);
  assert.match(text, marker, `${url} should contain its portal content`);
}

async function expectJson(url, cookie) {
  const response = await request(url, { headers:{ cookie, accept:'application/json' } });
  const data = await response.json();
  assert.equal(response.status, 200, `${url}: ${data.error || response.status}`);
  return data;
}

async function main() {
  const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeacademicservices-preview-'));
  const dataDir = path.join(storage, 'data');
  await fsp.mkdir(dataDir, { recursive:true });
  const submissions = [{ id:'project-search-fixture', portalType:'project-work', department:'education', departmentName:'Education', reference:'PWORK-SEARCH-001', submittedAt:'2026-09-01T09:00:00.000Z', title:'Dr', firstName:'Ama', lastName:'Supervisor', fullName:'Dr Ama Supervisor', email:'ama.supervisor@example.edu', phone:'0240000000', groupCount:'1', studyCentre:'Cape Coast', studyCentres:['Cape Coast'], projectStream:'distance', scoreSheet:{ rows:[{ originalSn:'1', name:'Kwame Search Student', registrationNo:'STU001', groupNo:'G1', totalScore:'87' }] }, files:{} }];
  const tickets = [
    fixtureTicket({ id:'one', reference:'SUP-ONE', type:'complaint', status:'received', unit:'student-support', unitLabel:'Student Support Services Unit' }),
    fixtureTicket({ id:'two', reference:'SUP-TWO', type:'service-request', status:'in-progress', unit:'examinations', unitLabel:'Examinations Unit' }),
    fixtureTicket({ id:'three', reference:'SUP-THREE', type:'complaint', status:'closed', unit:'admissions', unitLabel:'Admissions Unit' })
  ];
  await Promise.all([
    fsp.writeFile(path.join(dataDir, 'submissions.json'), JSON.stringify(submissions)),
    fsp.writeFile(path.join(dataDir, 'support-tickets.json'), JSON.stringify(tickets))
  ]);

  const child = spawn(process.execPath, ['server.js'], { cwd:root, env:{ ...process.env, PORT:String(port), STORAGE_DIR:storage, DEVELOPER_ADMIN_USER:developerUser, DEVELOPER_ADMIN_PASSWORD:developerPassword, SUPPORT_STATUS_TOKEN_SECRET:'independent-test-secret' }, stdio:['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes('listening on') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /listening on/, `server did not start: ${output}`);

    const publicStaffScript = await request('/staff.js');
    assert.equal(publicStaffScript.status, 200, 'staff.js must load even when a session expires');
    const publicSupportScript = await request('/support-admin.js');
    assert.equal(publicSupportScript.status, 200, 'support-admin.js must load even when a session expires');

    const options = await request('/api/developer/preview-options', { headers:{ authorization:developerAuthorization } }).then(response => response.json());
    assert.ok(options.staffUnits.length >= 19, 'all configured staff units should be previewable');
    for (const unit of options.staffUnits) {
      const preview = await developerPost('/api/developer/staff-preview-session', { unit:unit.id });
      await expectPage(preview.data.redirect, preview.cookie, unit.id === 'student-support' ? /Support Services triage/ : /Complaint and request reports/);
      const meUrl = unit.id === 'student-support' ? '/api/support/admin/me' : '/api/staff/me';
      const me = await expectJson(meUrl, preview.cookie);
      assert.equal(Boolean(me.identity?.developerPreview || me.staff?.developerPreview), true, `${unit.id} preview identity should be visible`);
      await expectJson('/api/staff/dashboard', preview.cookie);
    }

    const staffPreview = await developerPost('/api/developer/staff-preview-session', { unit:'student-support' });
    const dashboard = await expectJson('/api/staff/dashboard', staffPreview.cookie);
    assert.equal(dashboard.overview.total, 3, 'monitoring overview should count visible complaints and requests');
    assert.equal(dashboard.statusStatistics.length, 14, 'every support status should be returned, including zero counts');
    assert.equal(dashboard.unitStatistics.length, 19, 'every configured functional unit should be returned');
    assert.equal(dashboard.overview.complaints, 2);
    assert.equal(dashboard.overview.requests, 1);

    const routedReferences = {};
    const categoryRoutes = [
      ['deferment','Student Support Services Unit'],
      ['resumption-deferment','Student Support Services Unit'],
      ['resumption-rustication','Student Support Services Unit'],
      ['registration-challenge','Registration Officer Portal']
    ];
    for (const [category, expectedOwner] of categoryRoutes) {
      const routeForm = new FormData();
      Object.entries({ type:'service-request', category, priority:'normal', name:`Routing Test ${category}`, email:`${category}@example.edu`, studentNumber:`ROUTE-${category}`, studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:`Routing test for ${category}`, description:`Please verify the configured responsible portal for the ${category} service request.` }).forEach(([key,value]) => routeForm.set(key,value));
      const routeResponse = await request('/api/support/tickets', { method:'POST', body:routeForm });
      const routeData = await routeResponse.json();
      assert.equal(routeResponse.status, 201, routeData.error || `${category} should be accepted`);
      assert.equal(routeData.ticket.ownerUnit, expectedOwner, `${category} should route to ${expectedOwner}`);
      routedReferences[category] = routeData.ticket.reference;
    }
    const registrationPreview = await developerPost('/api/developer/staff-preview-session', { unit:'registration-officer' });
    const registrationReferrals = await expectJson('/api/staff/referrals', registrationPreview.cookie);
    assert.ok(registrationReferrals.referrals.some(item => item.reference === routedReferences['registration-challenge']), 'Registration Officer Portal must receive registration challenges');
    const supportRoutingQueue = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    assert.ok(supportRoutingQueue.tickets.some(item => item.reference === routedReferences.deferment), 'Student Support must receive deferment requests directly');
    assert.ok(supportRoutingQueue.tickets.some(item => item.reference === routedReferences['resumption-deferment']), 'Student Support must receive resumption-after-deferment requests directly');
    assert.ok(supportRoutingQueue.tickets.some(item => item.reference === routedReferences['resumption-rustication']), 'Student Support must receive resumption-after-rustication requests directly');
    assert.ok(supportRoutingQueue.tickets.some(item => item.reference === routedReferences['registration-challenge']), 'Student Support must also monitor registration challenges');

    const submissionForm = new FormData();
    Object.entries({ type:'service-request', category:'transcript', priority:'normal', name:'Workflow Test Student', email:'workflow.student@example.edu', phone:'0240000001', studentNumber:'WF-001', studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:'Transcript routing workflow test', description:'Please verify the automatic dual registration and assigned staff resolution workflow.' }).forEach(([key,value]) => submissionForm.set(key,value));
    const submissionResponse = await request('/api/support/tickets', { method:'POST', body:submissionForm });
    const submissionData = await submissionResponse.json();
    assert.equal(submissionResponse.status, 201, submissionData.error || 'workflow ticket should be created');
    assert.equal(submissionData.ticket.ownerUnit, 'General Office', 'category should route directly to General Office');
    assert.equal(submissionData.ticket.staffAssignment.colour, 'red', 'new responsible-unit register must start red');

    const generalOfficePreview = await developerPost('/api/developer/staff-preview-session', { unit:'general-office' });
    const generalOfficeReferrals = await expectJson('/api/staff/referrals', generalOfficePreview.cookie);
    const workflowTicket = generalOfficeReferrals.referrals.find(item => item.reference === submissionData.ticket.reference);
    assert.ok(workflowTicket, 'responsible unit must receive the new ticket directly');
    assert.ok(workflowTicket.registrations.some(item => item.unitId === 'student-support'), 'Student Support must retain a simultaneous oversight registration');
    assert.ok(workflowTicket.registrations.some(item => item.unitId === 'general-office'), 'responsible unit registration must be recorded');

    const assignmentResponse = await request(`/api/staff/referrals/${workflowTicket.id}/staff-assignments`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ unitId:'general-office', officerName:'Workflow Officer', officerEmail:'workflow.officer@ucc.edu.gh' }) });
    const assignmentData = await assignmentResponse.json();
    assert.equal(assignmentResponse.status, 200, assignmentData.error || 'unit administrator should assign by institutional email');
    assert.equal(assignmentData.assignment.colour, 'red');
    const secureAssignmentPath = new URL(assignmentData.secureUrl).pathname;
    const openedResponse = await request(secureAssignmentPath);
    assert.equal(openedResponse.status, 200, 'assigned staff secure link should open');
    assert.match(await openedResponse.text(), /Opened by assigned staff/);

    const supportQueueAfterOpen = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    const openedTicket = supportQueueAfterOpen.tickets.find(item => item.reference === workflowTicket.reference);
    assert.equal(openedTicket.assignment.colour, 'yellow', 'opening the link must turn the shared register yellow');

    const resolutionBody = new URLSearchParams({ reviewed:'yes', actionCompleted:'yes', resolutionRecorded:'yes', resolutionNote:'The responsible unit completed the transcript request and recorded the outcome.' });
    const resolutionResponse = await request(`${secureAssignmentPath}/resolve`, { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' }, body:resolutionBody });
    assert.equal(resolutionResponse.status, 200, 'all checked resolution confirmations should complete the assignment');
    assert.match(await resolutionResponse.text(), /indicator is now green/i);
    const supportQueueAfterResolution = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    const resolvedWorkflowTicket = supportQueueAfterResolution.tickets.find(item => item.reference === workflowTicket.reference);
    assert.equal(resolvedWorkflowTicket.assignment.colour, 'green', 'resolution must turn every authorised register green');
    assert.equal(resolvedWorkflowTicket.status, 'resolved');
    const supportRegisterResponse = await request('/api/support/admin/tickets.csv', { headers:{ cookie:staffPreview.cookie } });
    const supportRegisterText = await supportRegisterResponse.text();
    assert.equal(supportRegisterResponse.status, 200);
    assert.match(supportRegisterText, /Assignment indicator/);
    assert.match(supportRegisterText, /Resolved by assigned staff/);
    const unitRegisterResponse = await request('/api/staff/support-register.xlsx', { headers:{ cookie:generalOfficePreview.cookie } });
    assert.equal(unitRegisterResponse.status, 200, 'functional-unit Excel register should download');
    assert.match(unitRegisterResponse.headers.get('content-type') || '', /spreadsheetml/);

    const reassignmentForm = new FormData();
    Object.entries({ type:'complaint', category:'transcript', priority:'high', name:'Reassignment Test Student', email:'reassignment.student@example.edu', studentNumber:'WF-002', studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:'Reassignment workflow test', description:'Please verify that another functional unit receives the same permanent complaint reference.' }).forEach(([key,value]) => reassignmentForm.set(key,value));
    const reassignmentSubmission = await request('/api/support/tickets', { method:'POST', body:reassignmentForm });
    const reassignmentData = await reassignmentSubmission.json();
    assert.equal(reassignmentSubmission.status, 201, reassignmentData.error || 'reassignment fixture should be created');
    const refreshedGeneralOffice = await expectJson('/api/staff/referrals', generalOfficePreview.cookie);
    const ticketToReassign = refreshedGeneralOffice.referrals.find(item => item.reference === reassignmentData.ticket.reference);
    const reassignResponse = await request(`/api/staff/referrals/${ticketToReassign.id}/reassign`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ targetUnit:'examinations', note:'Examinations must complete the requested record verification.' }) });
    const reassignData = await reassignResponse.json();
    assert.equal(reassignResponse.status, 200, reassignData.error || 'functional unit should reassign the case');
    assert.equal(reassignData.reference, reassignmentData.ticket.reference, 'reassignment must preserve the permanent reference');
    const examinationsPreview = await developerPost('/api/developer/staff-preview-session', { unit:'examinations' });
    const examinationsReferrals = await expectJson('/api/staff/referrals', examinationsPreview.cookie);
    const reassignedTicket = examinationsReferrals.referrals.find(item => item.reference === reassignData.reference);
    assert.ok(reassignedTicket, 'receiving functional unit must see the reassigned case');
    assert.equal(reassignedTicket.assignment.colour, 'red', 'new receiving unit must start with a red unassigned indicator');
    assert.ok(reassignedTicket.registrations.some(item => item.unitId === 'student-support'), 'Student Support oversight registration must remain after reassignment');
    assert.ok(reassignedTicket.registrations.some(item => item.unitId === 'examinations'), 'new functional-unit registration must be added');

    const previewCases = [
      ['department-administrator','admin','/admin/education',/Find a Project Work student/],
      ['department-administrator','payroll','/payroll/education',/Payroll/],
      ['department-administrator','auditor','/auditor/education',/Auditor/],
      ['department-officer','admin','/admin/education',/Department submissions/],
      ['department-viewer','admin','/admin/education',/Department submissions/],
      ['operations-officer','payroll','/payroll/education',/Payroll/],
      ['operations-officer','auditor','/auditor/education',/Auditor/],
      ['payroll-officer','payroll','/payroll/education',/Payroll/],
      ['auditor','auditor','/auditor/education',/Auditor/]
    ];
    for (const [profileId,destination,url,marker] of previewCases) {
      const preview = await developerPost('/api/developer/preview-session', { mode:'profile', department:'education', destination, profileId });
      assert.equal(preview.data.redirect, url);
      await expectPage(url, preview.cookie, marker);
      await expectJson('/api/admin/education/info', preview.cookie);
    }

    const adminPreview = await developerPost('/api/developer/preview-session', { mode:'profile', department:'education', destination:'admin', profileId:'department-administrator' });
    const search = await expectJson('/api/admin/education/project-student-search?q=STU001', adminPreview.cookie);
    assert.equal(search.total, 1);
    assert.equal(search.results[0].studentName, 'Kwame Search Student');
    assert.equal(search.results[0].supervisorName, 'Dr Ama Supervisor');
    assert.ok(search.results[0].files.some(file => file.label === 'Clean score sheet'));

    console.log(`Portal preview integration checks passed for ${options.staffUnits.length} staff units and ${previewCases.length} department/operations roles.`);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await fsp.rm(storage, { recursive:true, force:true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
