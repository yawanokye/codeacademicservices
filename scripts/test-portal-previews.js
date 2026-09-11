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
  const workflowPassword = 'workflow-test-password';
  await Promise.all([
    fsp.writeFile(path.join(dataDir, 'submissions.json'), JSON.stringify(submissions)),
    fsp.writeFile(path.join(dataDir, 'support-tickets.json'), JSON.stringify(tickets)),
    fsp.writeFile(path.join(dataDir, 'admin-users.json'), '[]')
  ]);

  const child = spawn(process.execPath, ['server.js'], { cwd:root, env:{ ...process.env, PORT:String(port), STORAGE_DIR:storage, DEVELOPER_ADMIN_USER:developerUser, DEVELOPER_ADMIN_PASSWORD:developerPassword, SUPPORT_STATUS_TOKEN_SECRET:'independent-test-secret', GMAIL_CLIENT_ID:'', GMAIL_CLIENT_SECRET:'', GMAIL_REFRESH_TOKEN:'', GMAIL_SENDER_EMAIL:'' }, stdio:['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes('listening on') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /listening on/, `server did not start: ${output}`);

    const publicStaffScript = await request('/staff.js');
    assert.equal(publicStaffScript.status, 200, 'staff.js must load even when a session expires');
    assert.match(await publicStaffScript.text(), /Assignment not completed/, 'functional-unit assignment failures should be rendered as a readable reason');
    const publicSupportScript = await request('/support-admin.js');
    assert.equal(publicSupportScript.status, 200, 'support-admin.js must load even when a session expires');
    assert.match(await publicSupportScript.text(), /Assignment not completed/, 'Student Support assignment failures should be rendered as a readable reason');
    const studentSupportPage = await request('/student-support.html');
    const studentSupportHtml = await studentSupportPage.text();
    assert.equal(studentSupportPage.status, 200, 'student support submission page must load');
    assert.match(studentSupportHtml, /<dialog id="trackTicketDialog"/, 'ticket tracking should use a focused modal');
    assert.match(studentSupportHtml, /id="studyCentreOptions"[^>]*role="group"/, 'study-centre selection should be a checkbox group');
    assert.doesNotMatch(studentSupportHtml, /<select[^>]+(?:id|name)="studyCentre"/i, 'student support should not use a study-centre select menu');
    const studentTrackingScript = await request('/student-support.js').then(response => response.text());
    assert.match(studentTrackingScript, /showModal/, 'the tracking launcher should open the modal');
    assert.match(studentTrackingScript, /type="checkbox" name="studyCentre"/, 'study-centre choices should render as checkboxes');
    const secureHeaderResponse = await request('/', { headers:{ 'x-forwarded-proto':'https' } });
    assert.match(secureHeaderResponse.headers.get('content-security-policy') || '', /default-src 'self'/, 'production responses should include a content-security policy');
    assert.match(secureHeaderResponse.headers.get('strict-transport-security') || '', /max-age=31536000/, 'HTTPS responses should require transport security');

    const staffAccountResponse = await request('/api/developer/admin-users', { method:'POST', headers:{ authorization:developerAuthorization, 'content-type':'application/json' }, body:JSON.stringify({ firstName:'Akosua', middleName:'Efua', lastName:'Mensah', email:'akosua.mensah@ucc.edu.gh', role:'officer', units:['student-support'] }) });
    const staffAccountData = await staffAccountResponse.json();
    assert.equal(staffAccountResponse.status, 201, staffAccountData.error || 'developer should create an account from separated name parts');
    assert.equal(staffAccountData.user.name, 'Akosua Efua Mensah');
    assert.equal(staffAccountData.user.firstName, 'Akosua');
    assert.equal(staffAccountData.user.middleName, 'Efua');
    assert.equal(staffAccountData.user.lastName, 'Mensah');

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

    const structuredNameForm = new FormData();
    Object.entries({ type:'complaint', category:'general', priority:'normal', firstName:'Ama', middleName:'Serwaa', lastName:'Boateng', email:'structured.name@example.edu', studentNumber:'STRUCT-001', studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:'Structured student name test', description:'Please verify that each part of the student name is stored and displayed together.' }).forEach(([key,value]) => structuredNameForm.set(key,value));
    const structuredNameResponse = await request('/api/support/tickets', { method:'POST', body:structuredNameForm });
    const structuredNameData = await structuredNameResponse.json();
    assert.equal(structuredNameResponse.status, 201, structuredNameData.error || 'separated student names should be accepted');
    const queueWithStructuredName = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    const structuredTicket = queueWithStructuredName.tickets.find(item => item.reference === structuredNameData.ticket.reference);
    assert.ok(structuredTicket, 'structured-name ticket should appear in Student Support');
    assert.equal(structuredTicket.name, 'Ama Serwaa Boateng');
    assert.equal(structuredTicket.firstName, 'Ama');
    assert.equal(structuredTicket.middleName, 'Serwaa');
    assert.equal(structuredTicket.lastName, 'Boateng');

    const multiCentreForm = new FormData();
    Object.entries({ type:'complaint', category:'general', priority:'normal', firstName:'Kojo', lastName:'Owusu', email:'multi.centre@example.edu', subject:'Multiple centre validation test', description:'Please reject this complaint because it includes more than one current study centre.' }).forEach(([key,value]) => multiCentreForm.set(key,value));
    multiCentreForm.append('studyCentre', 'Cape Coast');
    multiCentreForm.append('studyCentre', 'Accra');
    const multiCentreResponse = await request('/api/support/tickets', { method:'POST', body:multiCentreForm });
    const multiCentreData = await multiCentreResponse.json();
    assert.equal(multiCentreResponse.status, 400);
    assert.match(multiCentreData.error, /only one study centre/i);
    for (const directorate of ['directorate-education-business','directorate-arts-stem']) {
      const directoratePreview = await developerPost('/api/developer/staff-preview-session', { unit:directorate });
      const directorateDashboard = await expectJson('/api/staff/dashboard', directoratePreview.cookie);
      assert.equal(directorateDashboard.overview.total, 4, `${directorate} should monitor every non-confidential complaint and request`);
      assert.equal(directorateDashboard.unitStatistics.length, 19, `${directorate} should receive the all-unit monitoring matrix`);
    }

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

    const malformedAssignmentResponse = await request(`/api/staff/referrals/${workflowTicket.id}/staff-assignments`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ unitId:'general-office', officerName:'Invalid Officer', officerEmail:'not-an-email' }) });
    assert.match(malformedAssignmentResponse.headers.get('content-type') || '', /application\/json/, 'assignment failures must use a structured API response');
    const malformedAssignmentData = await malformedAssignmentResponse.json();
    assert.equal(malformedAssignmentResponse.status, 400);
    assert.equal(malformedAssignmentData.error, 'Enter a valid staff email address.', 'the portal must return the actual assignment failure reason');

    const externalAssignmentResponse = await request(`/api/staff/referrals/${workflowTicket.id}/staff-assignments`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ unitId:'general-office', officerName:'External Officer', officerEmail:'external@example.com' }) });
    const externalAssignmentData = await externalAssignmentResponse.json();
    assert.equal(externalAssignmentResponse.status, 400);
    assert.equal(externalAssignmentData.error, 'Use an approved institutional staff email address.', 'non-institutional assignment failures must explain what to correct');

    const assignmentResponse = await request(`/api/staff/referrals/${workflowTicket.id}/staff-assignments`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ unitId:'general-office', officerFirstName:'Workflow', officerMiddleName:'Case', officerLastName:'Officer', officerEmail:'workflow.officer@ucc.edu.gh' }) });
    const assignmentData = await assignmentResponse.json();
    assert.equal(assignmentResponse.status, 200, assignmentData.error || 'unit administrator should assign by institutional email');
    assert.equal(assignmentData.assignment.colour, 'red');
    assert.equal(assignmentData.assignment.officerName, 'Workflow Case Officer');
    assert.equal(assignmentData.assignment.officerMiddleName, 'Case');
    assert.equal(assignmentData.account.created, true, 'first assignment should create a permanent staff account automatically');
    assert.equal(assignmentData.account.activationRequired, true, 'new staff account should require one-time activation');
    assert.ok(assignmentData.activationUrl, 'activation link should be returned when test email delivery is not configured');
    const secureAssignmentPath = new URL(assignmentData.secureUrl).pathname;
    const blockedAssignment = await request(secureAssignmentPath, { redirect:'manual', headers:{ accept:'text/html' } });
    assert.equal(blockedAssignment.status, 302, 'assignment must require staff authentication before showing case data');
    assert.match(blockedAssignment.headers.get('location') || '', /^\/staff-login\.html\?next=/);
    const activationToken = new URL(assignmentData.activationUrl).searchParams.get('token');
    assert.ok(activationToken, 'automatic account should receive a one-time activation token');
    const activationResponse = await request(`/api/admin-invitation/${activationToken}/set-password`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ password:workflowPassword, confirmPassword:workflowPassword, next:secureAssignmentPath }) });
    const activationData = await activationResponse.json();
    assert.equal(activationResponse.status, 200, activationData.error || 'assigned staff should activate the permanent account');
    assert.equal(activationData.redirect, secureAssignmentPath, 'first activation should return directly to the assigned case');
    const workflowOfficerCookie = sessionCookie(activationResponse);
    const openedResponse = await request(secureAssignmentPath, { headers:{ cookie:workflowOfficerCookie, accept:'text/html' } });
    assert.equal(openedResponse.status, 200, 'assigned staff secure link should open');
    assert.match(openedResponse.headers.get('x-robots-tag') || '', /noindex/, 'assignment pages must be excluded from indexing');
    assert.match(await openedResponse.text(), /Opened by assigned staff/);

    const supportQueueAfterOpen = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    const openedTicket = supportQueueAfterOpen.tickets.find(item => item.reference === workflowTicket.reference);
    assert.equal(openedTicket.assignment.colour, 'yellow', 'opening the link must turn the shared register yellow');

    const resolutionBody = new URLSearchParams({ reviewed:'yes', actionCompleted:'yes', resolutionRecorded:'yes', resolutionNote:'The responsible unit completed the transcript request and recorded the outcome.' });
    const resolutionResponse = await request(`${secureAssignmentPath}/resolve`, { method:'POST', headers:{ cookie:workflowOfficerCookie, 'content-type':'application/x-www-form-urlencoded' }, body:resolutionBody });
    assert.equal(resolutionResponse.status, 200, 'all checked resolution confirmations should complete the assignment');
    assert.match(await resolutionResponse.text(), /indicator is now green/i);
    const supportQueueAfterResolution = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    const resolvedWorkflowTicket = supportQueueAfterResolution.tickets.find(item => item.reference === workflowTicket.reference);
    assert.equal(resolvedWorkflowTicket.assignment.colour, 'green', 'resolution must turn every authorised register green');
    assert.equal(resolvedWorkflowTicket.status, 'resolved');
    const supportRegisterResponse = await request('/api/support/admin/tickets.csv', { headers:{ cookie:staffPreview.cookie } });
    const supportRegisterText = await supportRegisterResponse.text();
    assert.equal(supportRegisterResponse.status, 200);
    assert.match(supportRegisterText, /ASSIGNMENT INDICATOR/i);
    assert.match(supportRegisterText, /Resolved by assigned staff/);
    const unitRegisterResponse = await request('/api/staff/support-register.xlsx', { headers:{ cookie:generalOfficePreview.cookie } });
    assert.equal(unitRegisterResponse.status, 200, 'functional-unit Excel register should download');
    assert.match(unitRegisterResponse.headers.get('content-type') || '', /spreadsheetml/);

    const finalDecisionForm = new FormData();
    Object.entries({ type:'complaint', category:'transcript', priority:'normal', name:'Final Decision Student', email:'decision.student@example.edu', studentNumber:'WF-DECISION', studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:'Final decision colour workflow test', description:'Please verify that the final decision changes the shared indicator to green and preserves the decision narrative.' }).forEach(([key,value]) => finalDecisionForm.set(key,value));
    const finalDecisionSubmission = await request('/api/support/tickets', { method:'POST', body:finalDecisionForm });
    const finalDecisionSubmissionData = await finalDecisionSubmission.json();
    assert.equal(finalDecisionSubmission.status, 201, finalDecisionSubmissionData.error || 'final-decision fixture should be created');
    const generalOfficeBeforeDecision = await expectJson('/api/staff/referrals', generalOfficePreview.cookie);
    const finalDecisionTicket = generalOfficeBeforeDecision.referrals.find(item => item.reference === finalDecisionSubmissionData.ticket.reference);
    assert.ok(finalDecisionTicket, 'responsible unit should receive the final-decision fixture');
    const finalAssignmentResponse = await request(`/api/staff/referrals/${finalDecisionTicket.id}/staff-assignments`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ unitId:'general-office', officerName:'Workflow Officer', officerEmail:'workflow.officer@ucc.edu.gh' }) });
    const finalAssignmentData = await finalAssignmentResponse.json();
    assert.equal(finalAssignmentResponse.status, 200, finalAssignmentData.error || 'existing staff account should receive the final-decision fixture');
    const finalSecurePath = new URL(finalAssignmentData.secureUrl).pathname;
    const finalOpenResponse = await request(finalSecurePath, { headers:{ cookie:workflowOfficerCookie, accept:'text/html' } });
    assert.equal(finalOpenResponse.status, 200, 'assigned officer should open the final-decision fixture');
    await finalOpenResponse.text();
    const finalNarrative = 'The responsible unit completed its review and issued the final decision recorded for the student.';
    const finalDecisionResponse = await request(`/api/staff/referrals/${finalDecisionTicket.id}`, { method:'PATCH', headers:{ cookie:workflowOfficerCookie, 'content-type':'application/json' }, body:JSON.stringify({ action:'final-decision', note:finalNarrative }) });
    const finalDecisionData = await finalDecisionResponse.json();
    assert.equal(finalDecisionResponse.status, 200, finalDecisionData.error || 'authorised officer should record a final decision');
    assert.equal(finalDecisionData.ticket.status, 'final-decision');
    assert.equal(finalDecisionData.ticket.assignment.colour, 'green', 'a final decision must turn the current indicator green');
    assert.equal(finalDecisionData.ticket.finalDecision.narrative, finalNarrative, 'the final decision narrative must be retained');
    assert.deepEqual(finalDecisionData.ticket.assignment.stateHistory.map(item => item.colour), ['red','yellow','green'], 'red, yellow and green transitions must be recorded');
    const supportQueueAfterFinalDecision = await expectJson('/api/support/admin/tickets', staffPreview.cookie);
    const supportFinalDecisionTicket = supportQueueAfterFinalDecision.tickets.find(item => item.reference === finalDecisionTicket.reference);
    assert.equal(supportFinalDecisionTicket.assignment.colour, 'green', 'Student Support must see the same green final-decision indicator');
    assert.equal(supportFinalDecisionTicket.finalDecision.narrative, finalNarrative);
    const decisionRegisterResponse = await request('/api/support/admin/tickets.csv', { headers:{ cookie:staffPreview.cookie } });
    const decisionRegisterText = await decisionRegisterResponse.text();
    assert.match(decisionRegisterText, /FINAL DECISION \/ RESOLUTION NARRATIVE/);
    assert.match(decisionRegisterText, new RegExp(finalNarrative));

    const reassignmentForm = new FormData();
    Object.entries({ type:'complaint', category:'transcript', priority:'high', name:'Reassignment Test Student', email:'reassignment.student@example.edu', studentNumber:'WF-002', studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:'Reassignment workflow test', description:'Please verify that another functional unit receives the same permanent complaint reference.' }).forEach(([key,value]) => reassignmentForm.set(key,value));
    const reassignmentSubmission = await request('/api/support/tickets', { method:'POST', body:reassignmentForm });
    const reassignmentData = await reassignmentSubmission.json();
    assert.equal(reassignmentSubmission.status, 201, reassignmentData.error || 'reassignment fixture should be created');
    const refreshedGeneralOffice = await expectJson('/api/staff/referrals', generalOfficePreview.cookie);
    const ticketToReassign = refreshedGeneralOffice.referrals.find(item => item.reference === reassignmentData.ticket.reference);
    const reusedAssignmentResponse = await request(`/api/staff/referrals/${ticketToReassign.id}/staff-assignments`, { method:'POST', headers:{ cookie:generalOfficePreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ unitId:'general-office', officerName:'Workflow Officer', officerEmail:'workflow.officer@ucc.edu.gh' }) });
    const reusedAssignmentData = await reusedAssignmentResponse.json();
    assert.equal(reusedAssignmentResponse.status, 200, reusedAssignmentData.error || 'existing permanent account should be reusable');
    assert.equal(reusedAssignmentData.account.created, false, 'later assignments must reuse the existing staff account');
    assert.equal(reusedAssignmentData.account.activationRequired, false, 'an activated account must not receive another activation workflow');
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

    const supportReassignmentForm = new FormData();
    Object.entries({ type:'service-request', category:'transcript', priority:'normal', name:'Support Reassignment Student', email:'support.reassignment@example.edu', studentNumber:'WF-SUPPORT-REASSIGN', studyCentre:'Cape Coast', programme:'Test Programme', studyLevel:'undergraduate', subject:'Student Support supervisory reassignment test', description:'Please verify that Student Support can redirect a case from its current responsible office and preserve the old register.' }).forEach(([key,value]) => supportReassignmentForm.set(key,value));
    const supportReassignmentSubmission = await request('/api/support/tickets', { method:'POST', body:supportReassignmentForm });
    const supportReassignmentSubmissionData = await supportReassignmentSubmission.json();
    assert.equal(supportReassignmentSubmission.status, 201, supportReassignmentSubmissionData.error || 'Student Support reassignment fixture should be created');
    const generalOfficeForSupportReassignment = await expectJson('/api/staff/referrals', generalOfficePreview.cookie);
    const supportReassignmentTicket = generalOfficeForSupportReassignment.referrals.find(item => item.reference === supportReassignmentSubmissionData.ticket.reference);
    assert.ok(supportReassignmentTicket, 'the initial responsible unit should receive the supervisory reassignment fixture');
    const supportRedirectReason = 'Student Support redirected the request after screening showed that Student Records must complete the action.';
    const supportReassignResponse = await request(`/api/support/admin/tickets/${supportReassignmentTicket.id}/reassign`, { method:'POST', headers:{ cookie:staffPreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ targetUnit:'student-records', note:supportRedirectReason }) });
    const supportReassignData = await supportReassignResponse.json();
    assert.equal(supportReassignResponse.status, 200, supportReassignData.error || 'Student Support should reassign any visible complaint or request');
    assert.equal(supportReassignData.previousUnit.id, 'general-office', 'Student Support must redirect from the actual responsible unit, not from its oversight registration');
    assert.equal(supportReassignData.referral.targetUnit, 'student-records');
    assert.equal(supportReassignData.reference, supportReassignmentTicket.reference, 'Student Support reassignment must preserve the reference');
    const oldUnitAfterSupportReassignment = await expectJson('/api/staff/referrals', generalOfficePreview.cookie);
    const redirectedOldUnitTicket = oldUnitAfterSupportReassignment.referrals.find(item => item.reference === supportReassignmentTicket.reference);
    assert.ok(redirectedOldUnitTicket, 'the previous unit must retain a historical register entry');
    assert.equal(redirectedOldUnitTicket.routingState.key, 'redirected');
    assert.equal(redirectedOldUnitTicket.routingState.redirectedToUnit, 'student-records');
    assert.equal(redirectedOldUnitTicket.routingState.narrative, supportRedirectReason);
    assert.equal(redirectedOldUnitTicket.activeUnitIds.length, 0, 'the previous unit must no longer have operational controls');
    const oldRegistration = redirectedOldUnitTicket.registrations.find(item => item.unitId === 'general-office');
    assert.equal(oldRegistration.status, 'redirected');
    assert.equal(oldRegistration.redirectedToUnit, 'student-records');
    const studentRecordsPreview = await developerPost('/api/developer/staff-preview-session', { unit:'student-records' });
    const studentRecordsReferrals = await expectJson('/api/staff/referrals', studentRecordsPreview.cookie);
    const redirectedReceivingTicket = studentRecordsReferrals.referrals.find(item => item.reference === supportReassignmentTicket.reference);
    assert.ok(redirectedReceivingTicket, 'the Student Records register must receive the redirected case');
    assert.equal(redirectedReceivingTicket.routingState.key, 'active');
    assert.ok(redirectedReceivingTicket.registrations.some(item => item.unitId === 'student-support' && item.status === 'active'), 'Student Support oversight registration must remain active');
    assert.ok(redirectedReceivingTicket.routingHistory.some(item => item.fromUnit === 'general-office' && item.toUnit === 'student-records' && item.note === supportRedirectReason), 'the complete redirection narrative must be recorded');
    const supportFinalNarrative = 'Student Support recorded the final decision after Student Records confirmed that the requested action was completed.';
    const supportFinalResponse = await request(`/api/support/admin/tickets/${supportReassignmentTicket.id}`, { method:'PATCH', headers:{ cookie:staffPreview.cookie, 'content-type':'application/json' }, body:JSON.stringify({ status:'final-decision', categoryKey:'transcript', priorityKey:'normal', note:supportFinalNarrative }) });
    const supportFinalData = await supportFinalResponse.json();
    assert.equal(supportFinalResponse.status, 200, supportFinalData.error || 'Student Support should record a final decision');
    assert.equal(supportFinalData.ticket.staffAssignment.colour, 'green', 'student-facing ticket status should become green after the final decision');
    assert.equal(supportFinalData.ticket.finalDecision.narrative, supportFinalNarrative);
    const receivingUnitAfterSupportDecision = await expectJson('/api/staff/referrals', studentRecordsPreview.cookie);
    const receivingFinalTicket = receivingUnitAfterSupportDecision.referrals.find(item => item.reference === supportReassignmentTicket.reference);
    assert.equal(receivingFinalTicket.assignment.colour, 'green', 'the receiving unit register must also turn green after Student Support records the final decision');
    assert.equal(receivingFinalTicket.finalDecision.narrative, supportFinalNarrative);

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
