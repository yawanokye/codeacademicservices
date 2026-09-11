'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pairs = [
  ['public/student-support.js', 'public/student-support.html'],
  ['public/staff.js', 'public/staff.html'],
  ['public/support-admin.js', 'public/support-admin.html'],
  ['admin/admin.js', 'admin/index.html'],
  ['operations/payroll.js', 'operations/payroll.html'],
  ['operations/auditor.js', 'operations/auditor.html']
];
const dynamicallyCreated = new Set(['scoreReviewCount', 'developerPreviewBanner']);
const failures = [];

for (const [scriptName, pageName] of pairs) {
  const script = fs.readFileSync(path.join(root, scriptName), 'utf8');
  const page = fs.readFileSync(path.join(root, pageName), 'utf8');
  const references = [...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  const pageIds = new Set([...page.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
  const missing = [...new Set(references)].filter(id => !pageIds.has(id) && !dynamicallyCreated.has(id));
  if (missing.length) failures.push(`${scriptName} expects missing IDs in ${pageName}: ${missing.join(', ')}`);
}

const contentContracts = [
  ['public/student-support.html', /<dialog id="trackTicketDialog"/, 'student tracking must open in a dialog'],
  ['public/student-support.html', /id="studyCentreOptions"[^>]*role="group"/, 'student support must provide a checkbox study-centre group'],
  ['public/student-support.html', /name="firstName"[\s\S]*name="middleName"[\s\S]*name="lastName"/, 'student support must collect separated name parts'],
  ['public/centre-coordinators.html', /<dialog id="trackTicketDialog"/, 'assisted tracking must open in a dialog'],
  ['public/centre-coordinators.html', /id="studyCentreOptions"[^>]*aria-required="true"/, 'assisted support must require a checkbox study-centre group'],
  ['public/centre-coordinators.html', /name="firstName"[\s\S]*name="middleName"[\s\S]*name="lastName"/, 'assisted support must collect separated student names'],
  ['public/project-work.html', /name="firstName"[\s\S]*name="middleName"[\s\S]*name="lastName"/, 'project work must collect separated supervisor names'],
  ['public/field-experience.html', /name="firstName"[\s\S]*name="middleName"[\s\S]*name="lastName"/, 'field experience must collect separated examiner names'],
  ['public/dissertation.html', /name="studentFirstName"[\s\S]*name="studentMiddleName"[\s\S]*name="studentLastName"/, 'dissertation student names must be separated'],
  ['public/dissertation.html', /name="supervisorFirstName"[\s\S]*name="supervisorMiddleName"[\s\S]*name="supervisorLastName"/, 'dissertation supervisor names must be separated'],
  ['public/assessor.html', /name="assessorFirstName"[\s\S]*name="assessorMiddleName"[\s\S]*name="assessorLastName"/, 'assessor names must be separated'],
  ['admin/index.html', /id="assignmentAssessorFirstName"[\s\S]*id="assignmentAssessorMiddleName"[\s\S]*id="assignmentAssessorLastName"/, 'dissertation assignment names must be separated'],
  ['developer/index.html', /name="firstName"[\s\S]*name="middleName"[\s\S]*name="lastName"/, 'developer-created staff names must be separated'],
  ['public/support-admin.js', /name="officerFirstName"[\s\S]*name="officerMiddleName"[\s\S]*name="officerLastName"/, 'Student Support staff assignment names must be separated'],
  ['public/staff.js', /name="officerFirstName"[\s\S]*name="officerMiddleName"[\s\S]*name="officerLastName"/, 'functional-unit staff assignment names must be separated']
];
for (const [fileName, pattern, description] of contentContracts) {
  const content = fs.readFileSync(path.join(root, fileName), 'utf8');
  if (!pattern.test(content)) failures.push(`${fileName}: ${description}`);
}
for (const fileName of ['public/student-support.html', 'public/centre-coordinators.html']) {
  const content = fs.readFileSync(path.join(root, fileName), 'utf8');
  if (/<select[^>]+(?:id|name)="studyCentre"/i.test(content)) failures.push(`${fileName}: study-centre selection must not use a select menu`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('DOM and form contracts verified for public and protected portals.');
