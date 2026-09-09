'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pairs = [
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

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('DOM contracts verified for protected portals.');
