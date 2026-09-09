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
    assert.ok(options.staffUnits.length >= 18, 'all configured staff units should be previewable');
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
    assert.equal(dashboard.unitStatistics.length, 18, 'every configured functional unit should be returned');
    assert.equal(dashboard.overview.complaints, 2);
    assert.equal(dashboard.overview.requests, 1);

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
