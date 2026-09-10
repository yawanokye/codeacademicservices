const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const { CanvasFactory } = require('pdf-parse/worker');
const { PDFParse } = require('pdf-parse');

const app = express();

app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; frame-src 'self' blob:");
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (req.secure || forwardedProtocol === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32Update(crc, buffer) {
  let c = crc >>> 0;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return c >>> 0;
}
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
  const dosDate = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { dosTime, dosDate };
}
async function writeResponseChunk(res, chunk) {
  if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
}
async function streamZipArchive(res, files) {
  let offset = 0;
  const central = [];
  const { dosTime, dosDate } = dosDateTime();
  async function write(chunk) { await writeResponseChunk(res, chunk); offset += chunk.length; }

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0008, 6); // data descriptor follows file data
    local.writeUInt16LE(0, 8);      // stored, no compression
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local); await write(nameBuf);

    let crc = 0xFFFFFFFF;
    let size = 0;
    for await (const chunk of fs.createReadStream(file.path)) {
      crc = crc32Update(crc, chunk);
      size += chunk.length;
      await write(chunk);
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size >>> 0, 8);
    descriptor.writeUInt32LE(size >>> 0, 12);
    await write(descriptor);
    central.push({ nameBuf, crc, size, localOffset, dosTime, dosDate });
  }

  const centralOffset = offset;
  for (const entry of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0008, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(entry.dosTime, 12);
    h.writeUInt16LE(entry.dosDate, 14);
    h.writeUInt32LE(entry.crc, 16);
    h.writeUInt32LE(entry.size >>> 0, 20);
    h.writeUInt32LE(entry.size >>> 0, 24);
    h.writeUInt16LE(entry.nameBuf.length, 28);
    h.writeUInt16LE(0, 30);
    h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);
    h.writeUInt16LE(0, 36);
    h.writeUInt32LE(0, 38);
    h.writeUInt32LE(entry.localOffset >>> 0, 42);
    await write(h); await write(entry.nameBuf);
  }
  const centralSize = offset - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize >>> 0, 12);
  end.writeUInt32LE(centralOffset >>> 0, 16);
  end.writeUInt16LE(0, 20);
  await write(end);
  res.end();
}
async function zipBufferFromFiles(files) {
  const chunks=[]; const central=[]; let offset=0;
  const {dosTime,dosDate}=dosDateTime();
  const push=chunk=>{chunks.push(chunk);offset+=chunk.length;};
  for(const file of files){
    const data=await fsp.readFile(file.path);
    const nameBuf=Buffer.from(file.name,'utf8');
    let crc=crc32Update(0xFFFFFFFF,data);crc=(crc^0xFFFFFFFF)>>>0;
    const localOffset=offset;
    const h=Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x0800,6);h.writeUInt16LE(0,8);
    h.writeUInt16LE(dosTime,10);h.writeUInt16LE(dosDate,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length>>>0,18);h.writeUInt32LE(data.length>>>0,22);h.writeUInt16LE(nameBuf.length,26);h.writeUInt16LE(0,28);
    push(h);push(nameBuf);push(data);
    central.push({nameBuf,crc,size:data.length,localOffset});
  }
  const centralOffset=offset;
  for(const entry of central){
    const h=Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(20,6);h.writeUInt16LE(0x0800,8);h.writeUInt16LE(0,10);
    h.writeUInt16LE(dosTime,12);h.writeUInt16LE(dosDate,14);h.writeUInt32LE(entry.crc,16);h.writeUInt32LE(entry.size>>>0,20);h.writeUInt32LE(entry.size>>>0,24);h.writeUInt16LE(entry.nameBuf.length,28);h.writeUInt16LE(0,30);h.writeUInt16LE(0,32);h.writeUInt16LE(0,34);h.writeUInt16LE(0,36);h.writeUInt32LE(0,38);h.writeUInt32LE(entry.localOffset>>>0,42);
    push(h);push(entry.nameBuf);
  }
  const centralSize=offset-centralOffset;
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(central.length,8);end.writeUInt16LE(central.length,10);end.writeUInt32LE(centralSize>>>0,12);end.writeUInt32LE(centralOffset>>>0,16);end.writeUInt16LE(0,20);push(end);
  return Buffer.concat(chunks);
}
const PORT = Number(process.env.PORT || 10000);
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'storage'));
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const FILES_DIR = path.join(STORAGE_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'submissions.json');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'dissertation-assignments.json');
const RESOURCES_FILE = path.join(DATA_DIR, 'resources.json');
const ADMIN_USERS_FILE = path.join(DATA_DIR, 'admin-users.json');
const STUDY_CENTRES_FILE = path.join(DATA_DIR, 'study-centres.json');
const STUDY_CENTRE_DIRECTORY_FILE = path.join(DATA_DIR, 'study-centre-directory.json');
const PORTAL_SETTINGS_FILE = path.join(DATA_DIR, 'portal-settings.json');
const SUPPORT_TICKETS_FILE = path.join(DATA_DIR, 'support-tickets.json');
const SUPPORT_DB_FILE = path.resolve(String(process.env.SUPPORT_DB_FILE || path.join(DATA_DIR, 'support-tickets.sqlite')));
const DEFAULT_STUDY_CENTRE_DIRECTORY_PATH = path.join(__dirname, 'defaults', 'study-centre-directory.json');
const RESOURCES_DIR = path.join(STORAGE_DIR, 'resources');
const GMAIL_CLIENT_ID = String(process.env.GMAIL_CLIENT_ID || '').trim();
const GMAIL_CLIENT_SECRET = String(process.env.GMAIL_CLIENT_SECRET || '').trim();
const GMAIL_REFRESH_TOKEN = String(process.env.GMAIL_REFRESH_TOKEN || '').trim();
const GMAIL_SENDER_EMAIL = String(process.env.GMAIL_SENDER_EMAIL || '').trim();
const GMAIL_FROM_NAME = String(process.env.GMAIL_FROM_NAME || 'CoDE Academic Services Portal').trim();
const TWILIO_ACCOUNT_SID = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
const TWILIO_SMS_FROM = String(process.env.TWILIO_SMS_FROM || '').trim();
const TWILIO_WHATSAPP_FROM = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();
const SUPPORT_SMS_ENABLED = String(process.env.SUPPORT_SMS_ENABLED || 'false').trim().toLowerCase() === 'true';
const SUPPORT_WHATSAPP_ENABLED = String(process.env.SUPPORT_WHATSAPP_ENABLED || 'false').trim().toLowerCase() === 'true';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
const ASSIGNMENT_EXPIRY_DAYS = Math.min(60, Math.max(1, Number(process.env.ASSIGNMENT_EXPIRY_DAYS || 14) || 14));
const DEVELOPER_ADMIN_USER = String(process.env.DEVELOPER_ADMIN_USER || 'developer').trim();
const DEVELOPER_ADMIN_PASSWORD = String(process.env.DEVELOPER_ADMIN_PASSWORD || 'change-this-password');
const STUDENT_FEEDBACK_EXPIRY_DAYS = Math.min(90, Math.max(1, Number(process.env.STUDENT_FEEDBACK_EXPIRY_DAYS || 30) || 30));
const ADMIN_INVITATION_EXPIRY_HOURS = Math.min(168, Math.max(1, Number(process.env.ADMIN_INVITATION_EXPIRY_HOURS || 24) || 24));
const PROJECT_HIGH_ROW_WARNING = Math.max(1, Number(process.env.PROJECT_HIGH_ROW_WARNING || 100) || 100);
const SUPPORT_FORWARD_EXPIRY_DAYS = Math.min(60, Math.max(1, Number(process.env.SUPPORT_FORWARD_EXPIRY_DAYS || 14) || 14));
const SUPPORT_STATUS_TOKEN_SECRET = String(process.env.SUPPORT_STATUS_TOKEN_SECRET || DEVELOPER_ADMIN_PASSWORD).trim();
const SUPPORT_ALLOWED_EMAIL_DOMAINS = new Set(String(process.env.SUPPORT_ALLOWED_EMAIL_DOMAINS || 'ucc.edu.gh').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const SUPPORT_HOLIDAYS = new Set(String(process.env.SUPPORT_HOLIDAYS || '').split(',').map(v => v.trim()).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v)));
const SUPPORT_EVIDENCE_REMINDER_WORKING_DAYS = Math.min(10, Math.max(1, Number(process.env.SUPPORT_EVIDENCE_REMINDER_WORKING_DAYS || 3) || 3));
const SUPPORT_LANGUAGES = Object.freeze({ en:'English', tw:'Twi', fr:'French' });

const DEPARTMENTS = {
  'education': {
    name: 'Department of Education Programmes',
    user: process.env.EDUCATION_ADMIN_USER || 'education-admin',
    password: process.env.EDUCATION_ADMIN_PASSWORD || 'change-this-password'
  },
  'business': {
    name: 'Department of Business Programmes',
    user: process.env.BUSINESS_ADMIN_USER || 'business-admin',
    password: process.env.BUSINESS_ADMIN_PASSWORD || 'change-this-password'
  },
  'arts-social-sciences': {
    name: 'Department of Arts and Social Sciences',
    user: process.env.ARTS_SOCIAL_ADMIN_USER || 'arts-admin',
    password: process.env.ARTS_SOCIAL_ADMIN_PASSWORD || 'change-this-password'
  },
  'science-mathematics': {
    name: 'Department of Science and Mathematics Programmes',
    user: process.env.SCIENCE_MATH_ADMIN_USER || 'science-admin',
    password: process.env.SCIENCE_MATH_ADMIN_PASSWORD || 'change-this-password'
  }
};

const RESOURCE_PORTALS = new Set(['project-work','field-experience','dissertation','assessor']);

const ADMIN_SECTIONS = new Set(['project-work','field-experience','dissertation','assessor','payroll','auditor']);
const ADMIN_ROLES = new Set(['viewer','officer','administrator']);
const ROLE_RANK = { viewer:1, officer:2, administrator:3 };
const STAFF_UNITS = Object.freeze({
  'student-support': { label: 'Student Support Services Unit', summary: 'Triage complaints and service requests, communicate with students, and forward matters with comments.' },
  'confidential-handler': { label: 'Confidential Case Handler', summary: 'Restricted handling of sensitive complaints, protected evidence and authorised escalations.' },
  'general-office': { label: 'General Office', summary: 'Receive transcript requests and general administrative service matters.' },
  'student-records': { label: 'Student Records Management Unit', summary: 'Receive and process assigned records matters. Official records remain controlled through approved UCC systems.' },
  'registration-officer': { label: 'Registration Officer Portal', summary: 'Receive and resolve student course-registration challenges while preserving approved academic records.' },
  'college-registrar': { label: 'College Registrar', summary: 'Handle registrar matters, certificates, name changes and escalated service requests.' },
  'provost': { label: 'Provost', summary: 'Read-only oversight of service performance, sensitive escalation and institutional trends.' },
  'directorate-education-business': { label: 'Directorate of Education and Business Studies', summary: 'Academic oversight for Education and Business programmes.' },
  'directorate-arts-stem': { label: 'Directorate of Arts and STEM Studies', summary: 'Academic oversight for Arts, Social Sciences, STEM and ICT programmes.' },
  'academic-departments': { label: 'Academic Departments', summary: 'Receive programme, assessment, project-work, teaching-practice and departmental academic matters.' },
  'examinations': { label: 'Examinations Unit', summary: 'Process examination-related matters and support controlled results workflows.' },
  'payroll': { label: 'Payroll Portal', summary: 'Process only department-approved claims for payment.' },
  'auditor': { label: "Auditor's Portal", summary: 'Read-only verification of payroll-approved or paid claims.' },
  'regional-administrator': { label: 'Regional Administrators', summary: 'Facilitate, verify and escalate centre matters without approving academic records.' },
  'coordinator': { label: 'Centre Coordinators', summary: 'Submit, verify, monitor and escalate centre matters without altering official records.' },
  'quality-assurance': { label: 'Quality Assurance Unit', summary: 'Read-only quality oversight and monitoring.' },
  'college-finance': { label: 'College Finance Officer', summary: 'Receive finance-related service matters and approved payment workflows.' },
  'admissions': { label: 'Admissions Unit', summary: 'Receive assigned admissions and applicant service matters.' },
  'stores': { label: 'Stores Unit', summary: 'Receive assigned stores and logistics service matters.' }
});

const BUILTIN_RESOURCES = [
  {
    id: 'builtin-project-score-sheet',
    title: 'Project Work Score Sheet Sample',
    description: 'Use this sample score sheet for undergraduate project work. The submission validator checks only the five required headings.',
    portals: ['project-work'],
    originalName: 'SCORE SHEET_PROJECT WORK sample.xlsx',
    builtIn: true,
    resourcePath: ['project-work', 'score-sheet-project-work-sample.xlsx']
  },
  {
    id: 'builtin-field-experience-1-2-score-sheet',
    title: 'Field Experience I & II Score Sheet',
    description: 'Approved Excel template for submitting Field Experience I and Field Experience II scores together.',
    portals: ['field-experience'],
    originalName: 'UCC_Field_Experience_I_II_Score_Sheet.xlsx',
    builtIn: true,
    resourcePath: ['field-experience', 'UCC_Field_Experience_I_II_Score_Sheet.xlsx']
  },
  {
    id: 'builtin-field-experience-3-4-score-sheet',
    title: 'Field Experience III & IV Score Sheet',
    description: 'Approved Excel template for submitting Field Experience III and Field Experience IV scores together.',
    portals: ['field-experience'],
    originalName: 'UCC_Field_Experience_III_IV_Score_Sheet.xlsx',
    builtIn: true,
    resourcePath: ['field-experience', 'UCC_Field_Experience_III_IV_Score_Sheet.xlsx']
  },
  {
    id: 'builtin-field-experience-5-score-sheet',
    title: 'Field Experience V Score Sheet',
    description: 'Approved Excel template for Field Experience V score submission.',
    portals: ['field-experience'],
    originalName: 'UCC_Field_Experience_V_Score_Sheet.xlsx',
    builtIn: true,
    resourcePath: ['field-experience', 'UCC_Field_Experience_V_Score_Sheet.xlsx']
  },
  {
    id: 'builtin-micro-teaching-score-sheet',
    title: 'Micro-Teaching Score Sheet',
    description: 'Approved Excel template for Micro-Teaching score submission.',
    portals: ['field-experience'],
    originalName: 'UCC_Micro_Teaching_Score_Sheet.xlsx',
    builtIn: true,
    resourcePath: ['field-experience', 'UCC_Micro_Teaching_Score_Sheet.xlsx']
  },
  {
    id: 'builtin-macro-teaching-score-sheet',
    title: 'Macro-Teaching Score Sheet',
    description: 'Approved Excel template for Macro-Teaching score submission.',
    portals: ['field-experience'],
    originalName: 'UCC_Macro_Teaching_Score_Sheet.xlsx',
    builtIn: true,
    resourcePath: ['field-experience', 'UCC_Macro_Teaching_Score_Sheet.xlsx']
  },
  {
    id: 'builtin-reflection-score-sheet',
    title: 'Reflection Score Sheet',
    description: 'Approved Excel template for Reflection score submission.',
    portals: ['field-experience'],
    originalName: 'UCC_Reflection_Score_Sheet.xlsx',
    builtIn: true,
    resourcePath: ['field-experience', 'UCC_Reflection_Score_Sheet.xlsx']
  },
  {
    id: 'builtin-project-supervisor-report',
    title: 'Supervisor Report Sample',
    description: 'Supervisor report template for study centre, groups supervised, performance, challenges and recommendations.',
    portals: ['project-work'],
    originalName: 'Supervisor Report sample.docx',
    builtIn: true,
    resourcePath: ['project-work', 'supervisor-report-sample.docx']
  },
  {
    id: 'builtin-project-claim-form',
    title: 'Claim Form for Undergraduate Supervision',
    description: 'Claim form template to complete and upload with the undergraduate project work submission.',
    portals: ['project-work'],
    originalName: 'Claim Form sample.docx',
    builtIn: true,
    resourcePath: ['project-work', 'claim-form-sample.docx']
  },
  {
    id: 'builtin-field-experience-claim-form',
    title: 'Field Experience and Reflection Allocation / Claim Form',
    description: 'Department-specific allocation and claim form with Study Centre, Programme, Quantity, marker and banking information.',
    portals: ['field-experience'],
    originalName: 'UCC_Allocation_Sheet_Field_Experience_and_Reflection.docx',
    builtIn: true,
    resourcePath: ['field-experience', 'field-experience-and-reflection-claim-form.docx']
  }
];

const REQUIRED_HEADERS = ['S/N', 'NAME', 'REGISTRATION NO.', 'GROUP NO.', 'TOTAL SCORE'];
const MAX_HEADER_SCAN_ROWS = 40;

const FIELD_ASSESSMENTS = Object.freeze({
  'field-experience-1-2': {
    label: 'Field Experience I & II',
    sheetName: 'FE I & II',
    identityAliases: ['FIELD EXPERIENCE I & II','FIELD EXPERIENCE I AND II','FIELD EXP I & II','FE I & II'],
    scoreHeaders: ['F. EXP I','F. EXP II'],
    scoreAliases: [
      ['F. EXP I','F EXP I','FIELD EXPERIENCE I','FE I'],
      ['F. EXP II','F EXP II','FIELD EXPERIENCE II','FE II']
    ]
  },
  'field-experience-3-4': {
    label: 'Field Experience III & IV',
    sheetName: 'FE III & IV',
    identityAliases: ['FIELD EXPERIENCE III & IV','FIELD EXPERIENCE III AND IV','FIELD EXP III & IV','FE III & IV'],
    scoreHeaders: ['F. EXP III','F. EXP IV'],
    scoreAliases: [
      ['F. EXP III','F EXP III','FIELD EXPERIENCE III','FE III'],
      ['F. EXP IV','F EXP IV','FIELD EXPERIENCE IV','FE IV']
    ]
  },
  'field-experience-5': {
    label: 'Field Experience V',
    sheetName: 'FE V',
    identityAliases: ['FIELD EXPERIENCE V','FIELD EXP V','FE V'],
    scoreHeaders: ['F. EXP V'],
    scoreAliases: [['F. EXP V','F EXP V','FIELD EXPERIENCE V','FE V','SCORE']]
  },
  'micro-teaching': {
    label: 'Micro-Teaching',
    sheetName: 'Micro-Teaching',
    identityAliases: ['MICRO-TEACHING','MICRO TEACHING'],
    scoreHeaders: ['SCORE'],
    scoreAliases: [['MICRO-TEACHING','MICRO TEACHING','SCORE']]
  },
  'macro-teaching': {
    label: 'Macro-Teaching',
    sheetName: 'Macro-Teaching',
    identityAliases: ['MACRO-TEACHING','MACRO TEACHING'],
    scoreHeaders: ['SCORE'],
    scoreAliases: [['MACRO-TEACHING','MACRO TEACHING','SCORE']]
  },
  'reflection': {
    label: 'Reflection',
    sheetName: 'Reflection',
    identityAliases: ['REFLECTION'],
    scoreHeaders: ['SCORE'],
    scoreAliases: [['REFLECTION','SCORE']]
  }
});
const FIELD_ASSESSMENT_KEYS = Object.keys(FIELD_ASSESSMENTS);
const FIELD_SCORE_REPORTS = Object.freeze({
  'field-experience-1': { label:'Field Experience I', assessmentType:'field-experience-1-2', scoreIndex:0, scoreHeader:'F. EXP I', sheetName:'Field Experience I' },
  'field-experience-2': { label:'Field Experience II', assessmentType:'field-experience-1-2', scoreIndex:1, scoreHeader:'F. EXP II', sheetName:'Field Experience II' },
  'field-experience-3': { label:'Field Experience III', assessmentType:'field-experience-3-4', scoreIndex:0, scoreHeader:'F. EXP III', sheetName:'Field Experience III' },
  'field-experience-4': { label:'Field Experience IV', assessmentType:'field-experience-3-4', scoreIndex:1, scoreHeader:'F. EXP IV', sheetName:'Field Experience IV' },
  'field-experience-5': { label:'Field Experience V', assessmentType:'field-experience-5', scoreIndex:0, scoreHeader:'F. EXP V', sheetName:'Field Experience V' },
  'micro-teaching': { label:'Micro-Teaching', assessmentType:'micro-teaching', scoreIndex:0, scoreHeader:'SCORE', sheetName:'Micro-Teaching' },
  'macro-teaching': { label:'Macro-Teaching', assessmentType:'macro-teaching', scoreIndex:0, scoreHeader:'SCORE', sheetName:'Macro-Teaching' },
  'reflection': { label:'Reflection', assessmentType:'reflection', scoreIndex:0, scoreHeader:'SCORE', sheetName:'Reflection' }
});
const FIELD_SCORE_REPORT_KEYS = Object.keys(FIELD_SCORE_REPORTS);

let supportDatabase = null;
function initSupportDatabase() {
  fs.mkdirSync(path.dirname(SUPPORT_DB_FILE), { recursive: true });
  supportDatabase = new DatabaseSync(SUPPORT_DB_FILE);
  supportDatabase.exec('PRAGMA journal_mode = WAL');
  supportDatabase.exec('PRAGMA busy_timeout = 5000');
  supportDatabase.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    student_email TEXT NOT NULL,
    status TEXT NOT NULL,
    category_key TEXT NOT NULL,
    owner_unit TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_updated_at TEXT NOT NULL,
    due_at TEXT,
    data_json TEXT NOT NULL
  )`);
  supportDatabase.exec('CREATE INDEX IF NOT EXISTS idx_support_email ON support_tickets(student_email)');
  supportDatabase.exec('CREATE INDEX IF NOT EXISTS idx_support_queue ON support_tickets(status, category_key, owner_unit, sensitive, due_at)');
  const existing = Number(supportDatabase.prepare('SELECT COUNT(*) AS count FROM support_tickets').get()?.count || 0);
  if (!existing && fs.existsSync(SUPPORT_TICKETS_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(SUPPORT_TICKETS_FILE, 'utf8') || '[]');
      if (Array.isArray(legacy) && legacy.length) persistSupportTickets(legacy);
    } catch (error) {
      console.error('Legacy support-ticket migration failed:', error.message);
    }
  }
}
function persistSupportTickets(tickets) {
  const insert = supportDatabase.prepare(`INSERT INTO support_tickets
    (id, reference, student_email, status, category_key, owner_unit, sensitive, created_at, last_updated_at, due_at, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  supportDatabase.exec('BEGIN IMMEDIATE');
  try {
    supportDatabase.exec('DELETE FROM support_tickets');
    for (const ticket of tickets) insert.run(
      ticket.id, ticket.reference, ticket.email || '', ticket.status || 'received', ticket.categoryKey || 'general',
      ticket.ownerUnit || 'Student Support Services Unit', ticket.sensitive ? 1 : 0, ticket.createdAt || new Date().toISOString(),
      ticket.lastUpdatedAt || ticket.createdAt || new Date().toISOString(), ticket.dueAt || null, JSON.stringify(ticket)
    );
    supportDatabase.exec('COMMIT');
  } catch (error) {
    supportDatabase.exec('ROLLBACK');
    throw error;
  }
}

for (const dir of [STORAGE_DIR, DATA_DIR, FILES_DIR, RESOURCES_DIR, path.dirname(SUPPORT_DB_FILE)]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');
if (!fs.existsSync(ASSIGNMENTS_FILE)) fs.writeFileSync(ASSIGNMENTS_FILE, '[]', 'utf8');
if (!fs.existsSync(RESOURCES_FILE)) fs.writeFileSync(RESOURCES_FILE, '[]', 'utf8');
if (!fs.existsSync(ADMIN_USERS_FILE)) fs.writeFileSync(ADMIN_USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(STUDY_CENTRES_FILE)) fs.writeFileSync(STUDY_CENTRES_FILE, JSON.stringify({version:0,departments:{}}, null, 2), 'utf8');
if (!fs.existsSync(STUDY_CENTRE_DIRECTORY_FILE)) {
  if (fs.existsSync(DEFAULT_STUDY_CENTRE_DIRECTORY_PATH)) fs.copyFileSync(DEFAULT_STUDY_CENTRE_DIRECTORY_PATH, STUDY_CENTRE_DIRECTORY_FILE);
  else fs.writeFileSync(STUDY_CENTRE_DIRECTORY_FILE, JSON.stringify({version:2,centres:[]}, null, 2), 'utf8');
}
if (!fs.existsSync(PORTAL_SETTINGS_FILE)) fs.writeFileSync(PORTAL_SETTINGS_FILE, JSON.stringify({version:1,fieldExperienceClaimFormRequired:false}, null, 2), 'utf8');
if (!fs.existsSync(SUPPORT_TICKETS_FILE)) fs.writeFileSync(SUPPORT_TICKETS_FILE, '[]', 'utf8');
initSupportDatabase();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Form-based administrator sessions. Basic authentication remains accepted for backward compatibility.
const ADMIN_SESSIONS = new Map();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEVELOPER_PREVIEW_TTL_MS = 30 * 60 * 1000;
function parseCookies(req) {
  const out={};
  for(const part of String(req.headers.cookie||'').split(';')){
    const i=part.indexOf('='); if(i<0) continue;
    out[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function createAdminSession(identity, department, ttlMs=ADMIN_SESSION_TTL_MS) {
  const token=crypto.randomBytes(32).toString('hex');
  const safeTtl=Math.max(60*1000,Number(ttlMs)||ADMIN_SESSION_TTL_MS);
  ADMIN_SESSIONS.set(token,{identity,department,ttlMs:safeTtl,expiresAt:Date.now()+safeTtl});
  return token;
}
function sessionIdentity(req, department) {
  const token=parseCookies(req).ucc_admin_session; if(!token) return null;
  const s=ADMIN_SESSIONS.get(token);
  if(!s || s.expiresAt<=Date.now()){if(s)ADMIN_SESSIONS.delete(token);return null;}
  if(s.department!==department && !(s.identity?.departments||[]).includes(department)) return null;
  s.department=department;
  s.expiresAt=Date.now()+(Number(s.ttlMs)||ADMIN_SESSION_TTL_MS);
  if(s.identity?.developerPreview) s.identity.previewExpiresAt=new Date(s.expiresAt).toISOString();
  return s.identity;
}
function clearAdminSession(req) { const token=parseCookies(req).ucc_admin_session; if(token) ADMIN_SESSIONS.delete(token); }
function staffSessionIdentity(req) {
  const token=parseCookies(req).ucc_admin_session; if(!token) return null;
  const session=ADMIN_SESSIONS.get(token);
  if(!session || session.expiresAt<=Date.now()){if(session)ADMIN_SESSIONS.delete(token);return null;}
  if(session.department!=='__staff__' || !normalizeStaffUnits(session.identity?.units).length) return null;
  session.expiresAt=Date.now()+(Number(session.ttlMs)||ADMIN_SESSION_TTL_MS);
  return session.identity;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function departmentFromSlug(slug) {
  return Object.prototype.hasOwnProperty.call(DEPARTMENTS, slug) ? DEPARTMENTS[slug] : null;
}

async function readAdminUsers() {
  try {
    const raw = await fsp.readFile(ADMIN_USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
let adminUserWriteQueue = Promise.resolve();
function mutateAdminUsers(mutator) {
  adminUserWriteQueue = adminUserWriteQueue.catch(() => {}).then(async () => {
    const records = await readAdminUsers();
    const result = await mutator(records);
    const temp = ADMIN_USERS_FILE + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(records, null, 2), 'utf8');
    await fsp.rename(temp, ADMIN_USERS_FILE);
    return result;
  });
  return adminUserWriteQueue;
}
function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = crypto.scryptSync(String(password), String(salt || ''), 64);
    const expected = Buffer.from(String(expectedHash || ''), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function normalizeAdminSections(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map(v => String(v || '').trim()).filter(v => ADMIN_SECTIONS.has(v)))];
}
function normalizeAdminDepartments(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map(v => String(v || '').trim()).filter(v => departmentFromSlug(v)))];
}
function normalizeStaffUnits(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map(v => String(v || '').trim()).filter(v => Object.prototype.hasOwnProperty.call(STAFF_UNITS, v)))];
}
function staffUnitNames(units) { return normalizeStaffUnits(units).map(unit => STAFF_UNITS[unit].label); }
function publicAdminUser(user) {
  const passwordSet=Boolean(user.passwordHash && user.passwordSalt);
  const invitationExpiresAt=user.invitationExpiresAt || null;
  const invitationExpired=Boolean(invitationExpiresAt && new Date(invitationExpiresAt).getTime() <= Date.now());
  return {
    id:user.id, name:user.name || user.username, username:user.username, email:user.email || '',
    role:user.role || 'viewer', departments:user.departments || [], sections:user.sections || [], units:normalizeStaffUnits(user.units),
    active:user.active !== false, createdAt:user.createdAt || null,
    passwordSet, passwordSetAt:user.passwordSetAt || null,
    invitationSentAt:user.invitationSentAt || null, invitationExpiresAt,
    invitationExpired, invitationEmailStatus:user.invitationEmailStatus || null,
    invitationLastError:user.invitationLastError || null
  };
}
function hashOneTimeToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}
function newAdminInvitation() {
  const token=crypto.randomBytes(32).toString('hex');
  return {
    token,
    tokenHash:hashOneTimeToken(token),
    expiresAt:new Date(Date.now()+ADMIN_INVITATION_EXPIRY_HOURS*60*60*1000).toISOString()
  };
}
function safeSupportAssignmentNext(value) {
  const next = String(value || '').trim();
  return /^\/secure\/support-assignment\/[a-f0-9]{64}$/i.test(next) ? next : '';
}
function uniqueStaffUsername(email, accounts) {
  const base = String(email || '').trim().toLowerCase();
  const used = new Set(accounts.map(account => String(account.username || '').trim().toLowerCase()));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
async function ensureSupportAssignmentAccount({ email, name, unitId, actor }) {
  let result = null;
  await mutateAdminUsers(accounts => {
    let account = accounts.find(item => String(item.email || '').trim().toLowerCase() === email);
    if (account?.active === false) {
      result = { state:'disabled', account:publicAdminUser(account) };
      return result;
    }
    let created = false;
    let unitAdded = false;
    if (!account) {
      const invitation = newAdminInvitation();
      account = {
        id:crypto.randomUUID(), name:name || email.split('@')[0], email,
        username:uniqueStaffUsername(email, accounts), role:'officer', departments:[], sections:[], units:[unitId],
        active:true, createdAt:new Date().toISOString(), createdFrom:'support-assignment', createdBy:actor,
        invitationTokenHash:invitation.tokenHash, invitationExpiresAt:invitation.expiresAt, invitationEmailStatus:'pending'
      };
      accounts.push(account);
      result = { state:'pending', created:true, unitAdded:true, invitationToken:invitation.token, account:{...account} };
      return result;
    }
    account.units = normalizeStaffUnits(account.units);
    if (!account.units.includes(unitId)) {
      account.units.push(unitId);
      unitAdded = true;
    }
    if ((ROLE_RANK[account.role] || 0) < ROLE_RANK.officer) account.role = 'officer';
    account.accessHistory = Array.isArray(account.accessHistory) ? account.accessHistory : [];
    if (unitAdded) account.accessHistory.push({ action:'functional-unit-added', unitId, at:new Date().toISOString(), by:actor, reason:'First assignment for this functional unit' });
    if (account.passwordHash && account.passwordSalt) {
      result = { state:'active', created, unitAdded, invitationToken:null, account:{...account} };
      return result;
    }
    const invitation = newAdminInvitation();
    account.invitationTokenHash = invitation.tokenHash;
    account.invitationExpiresAt = invitation.expiresAt;
    account.invitationEmailStatus = 'pending';
    account.invitationLastError = null;
    result = { state:'pending', created, unitAdded, invitationToken:invitation.token, account:{...account} };
    return result;
  });
  return result;
}
function requestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwarded=String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol=forwarded || req.protocol || 'https';
  return `${protocol}://${req.get('host')}`.replace(/\/$/, '');
}
function adminLoginLinks(departments, baseUrl, units=[]) {
  const links=(departments || []).map(slug=>({slug,name:departmentFromSlug(slug)?.name || slug,url:`${baseUrl}/admin/${encodeURIComponent(slug)}`}));
  if(normalizeStaffUnits(units).length) links.unshift({slug:'staff',name:'Functional Units Staff Portal',url:`${baseUrl}/staff`});
  return links;
}
async function sendAdminPasswordSetupEmail({to,name,username,role,departments,sections,units=[],setupUrl,expiresAt,baseUrl,isReset=false}) {
  const deptNames=(departments || []).map(slug=>departmentFromSlug(slug)?.name || slug);
  const unitNames=staffUnitNames(units);
  const sectionNames=(sections || []).map(section=>section==='project-work'?'Undergraduate Project Work':section==='field-experience'?'Field Experience and Teaching Practice':section==='dissertation'?'Dissertation Submission':section==='assessor'?'Assessment/Vetting Reports':section==='payroll'?'Payroll Portal':section==='auditor'?"Auditor's Portal":section);
  const expiryText=new Date(expiresAt).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'})+' UTC';
  const portalRows=adminLoginLinks(departments,baseUrl,units).map(x=>`<li><a href="${htmlEscape(x.url)}">${htmlEscape(x.name)} Administration Portal</a></li>`).join('');
  const subject=isReset?'UCC Submission Portal password reset':'Your UCC Submission Portal administrator account';
  const action=isReset?'reset your administrator password':'set your administrator password';
  const html=`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">${isReset?'Password Reset':'Staff Account Invitation'}</h2><p>Dear ${htmlEscape(name)},</p><p>${isReset?'A secure password-reset link has been issued for your':'An individual staff account has been created for you on the'} CoDE Academic Services Portal.</p><div style="margin:18px 0;padding:16px;background:#f5f7fa;border-left:4px solid #d4a72c"><strong>Temporary account credential</strong><br>Username: <strong>${htmlEscape(username)}</strong><br>Password: <strong>Set by you using the one-time link below</strong></div><p><a href="${htmlEscape(setupUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">${isReset?'Set New Password':'Set Your Password'}</a></p><p>This one-time link expires on <strong>${htmlEscape(expiryText)}</strong>. After the password is set, the link cannot be used again.</p><p><strong>Role:</strong> ${htmlEscape(role)}<br><strong>Functional unit access:</strong> ${htmlEscape(unitNames.join(', ') || 'None')}<br><strong>Department access:</strong> ${htmlEscape(deptNames.join(', ') || 'None')}<br><strong>Section access:</strong> ${htmlEscape(sectionNames.join(', ') || 'None')}</p><p>After setting your password, use the appropriate portal below:</p><ul>${portalRows}</ul><p>If you did not expect this account, do not use the link and contact the portal administrator.</p><p>Regards,<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  return sendGmailHtmlEmail({to,subject,html});
}
async function verifyDepartmentCredentials(slug,user,pass) {
  const dept=departmentFromSlug(slug); if(!dept) return null;
  if(safeEqual(user,dept.user)&&safeEqual(pass,dept.password)) return {
    id:`department-master:${slug}`,name:`${dept.name} Administrator`,username:user,
    role:'administrator',sections:['project-work','field-experience','dissertation','assessor','payroll','auditor'],departments:[slug],master:true
  };
  const accounts=await readAdminUsers();
  const account=accounts.find(a=>a.active!==false&&String(a.username||'').toLowerCase()===String(user||'').toLowerCase());
  if(!account || !(account.departments||[]).includes(slug) || !verifyPassword(pass,account.passwordSalt,account.passwordHash)) return null;
  return {...publicAdminUser(account),master:false};
}
async function verifyStaffCredentials(user, pass) {
  const account=(await readAdminUsers()).find(item => item.active!==false && normalizeStaffUnits(item.units).length && String(item.username||'').toLowerCase()===String(user||'').toLowerCase());
  if(!account || !verifyPassword(pass, account.passwordSalt, account.passwordHash)) return null;
  return {...publicAdminUser(account),master:false};
}
async function staffAuth(req,res,next) {
  try {
    const session=staffSessionIdentity(req);
    if(session){req.staffIdentity=session;return next();}
    const header=req.headers.authorization||'';
    if(header.startsWith('Basic ')){
      const decoded=Buffer.from(header.slice(6),'base64').toString('utf8'); const sep=decoded.indexOf(':');
      const identity=await verifyStaffCredentials(sep>=0?decoded.slice(0,sep):decoded,sep>=0?decoded.slice(sep+1):'');
      if(identity){req.staffIdentity=identity;return next();}
    }
    const wantsHtml=req.method==='GET'&&!req.path.startsWith('/api/')&&(String(req.headers.accept||'').includes('text/html')||!req.headers.accept);
    return wantsHtml?res.redirect(`/staff-login.html?next=${encodeURIComponent(req.originalUrl||'/staff')}`):res.status(401).json({error:'Functional unit staff authentication required.'});
  } catch(error) { console.error('Staff authentication failed:',error); return res.status(401).json({error:'Invalid functional unit staff credentials.'}); }
}
function requireStaffUnit(unit, minimumRole='viewer') {
  return (req,res,next) => {
    const identity=req.staffIdentity||{};
    if(normalizeStaffUnits(identity.units).includes(unit) && (ROLE_RANK[identity.role]||0)>=(ROLE_RANK[minimumRole]||1)) return next();
    return res.status(403).json({error:'Your staff account does not have the required functional-unit access.'});
  };
}
async function departmentAuth(req, res, next) {
  const slug=String(req.params.department||''); const dept=departmentFromSlug(slug);
  if(!dept) return res.status(404).send('Department administrator portal not found.');
  try {
    const session=sessionIdentity(req,slug);
    if(session){req.adminDepartment=slug;req.adminDepartmentName=dept.name;req.adminIdentity=session;return next();}
    const header=req.headers.authorization||'';
    if(header.startsWith('Basic ')){
      const decoded=Buffer.from(header.slice(6),'base64').toString('utf8'); const sep=decoded.indexOf(':');
      const user=sep>=0?decoded.slice(0,sep):decoded,pass=sep>=0?decoded.slice(sep+1):'';
      const identity=await verifyDepartmentCredentials(slug,user,pass);
      if(identity){req.adminDepartment=slug;req.adminDepartmentName=dept.name;req.adminIdentity=identity;return next();}
    }
    const wantsHtml=req.method==='GET' && !req.path.startsWith('/api/') && (String(req.headers.accept||'').includes('text/html')||!req.headers.accept);
    if(wantsHtml){const next=String(req.originalUrl||'');return res.redirect(`/admin-login.html?department=${encodeURIComponent(slug)}&next=${encodeURIComponent(next)}`);}
    return res.status(401).json({error:'Department administrator authentication required.'});
  } catch(e){console.error('Department authentication failed:',e);return res.status(401).json({error:'Invalid department administrator credentials.'});}
}

function portalSectionForRecord(record) {
  const type = record?.portalType || 'project-work';
  return ADMIN_SECTIONS.has(type) ? type : 'project-work';
}
function adminCan(req, section, minimumRole='viewer') {
  const identity=req.adminIdentity || {};
  return (identity.sections || []).includes(section) && (ROLE_RANK[identity.role] || 0) >= (ROLE_RANK[minimumRole] || 1);
}
function adminActorLabel(req, fallback='Department administrator') {
  const identity=req.adminIdentity || {};
  const base=identity.name||identity.username||fallback;
  return identity.developerPreview ? `Developer Preview as ${identity.developerPreviewLabel||base}` : base;
}
function requireAdminAccess(section, minimumRole='viewer') {
  return (req,res,next) => adminCan(req, section, minimumRole)
    ? next()
    : res.status(403).json({error:`Your administrator account does not have ${minimumRole} access to this section.`});
}
function requireRecordAccess(req, res, record, minimumRole='viewer') {
  const section=portalSectionForRecord(record);
  if (!adminCan(req, section, minimumRole)) {
    res.status(403).json({error:`Your administrator account does not have ${minimumRole} access to this submission section.`});
    return false;
  }
  return true;
}

function developerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Developer Resource Administration"');
    return res.status(401).send('Developer authentication required.');
  }
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (!safeEqual(user, DEVELOPER_ADMIN_USER) || !safeEqual(pass, DEVELOPER_ADMIN_PASSWORD)) {
      res.set('WWW-Authenticate', 'Basic realm="Developer Resource Administration"');
      return res.status(401).send('Invalid developer credentials.');
    }
    next();
  } catch {
    return res.status(401).send('Invalid developer credentials.');
  }
}
async function supportWorkspaceAuth(req, res, next) {
  const header=req.headers.authorization||'';
  if(header.startsWith('Basic ')){
    try {
      const decoded=Buffer.from(header.slice(6),'base64').toString('utf8'); const sep=decoded.indexOf(':');
      const user=sep>=0?decoded.slice(0,sep):decoded,pass=sep>=0?decoded.slice(sep+1):'';
      if(safeEqual(user,DEVELOPER_ADMIN_USER)&&safeEqual(pass,DEVELOPER_ADMIN_PASSWORD)){req.supportIdentity={name:'Developer',role:'administrator',developer:true};return next();}
    } catch {}
  }
  return staffAuth(req,res,()=>{
    const identity=req.staffIdentity||{};
    const units=normalizeStaffUnits(identity.units);
    if(!units.includes('student-support')&&!units.includes('confidential-handler')) return res.status(403).json({error:'Student Support Services or Confidential Case Handler access is required.'});
    req.supportIdentity=identity;
    next();
  });
}
function canAccessSensitiveSupport(identity) {
  if (identity?.developer) return true;
  const units = normalizeStaffUnits(identity?.units);
  return units.includes('confidential-handler') || units.includes('provost');
}
function canAccessSupportTicket(identity, ticket) {
  return !ticket?.sensitive || canAccessSensitiveSupport(identity);
}
function requireSupportRole(minimumRole='viewer') {
  return (req,res,next) => (ROLE_RANK[req.supportIdentity?.role]||0)>=(ROLE_RANK[minimumRole]||1)
    ? next() : res.status(403).json({error:'Your Student Support account does not have permission for this action.'});
}

const DEVELOPER_PREVIEW_PROFILES = {
  'department-administrator': {label:'Department Administrator',role:'administrator',sections:['project-work','field-experience','dissertation','assessor','payroll','auditor']},
  'department-officer': {label:'Department Officer',role:'officer',sections:['project-work','field-experience','dissertation','assessor']},
  'department-viewer': {label:'Department Viewer',role:'viewer',sections:['project-work','field-experience','dissertation','assessor']},
  'operations-officer': {label:'Central Payroll and Auditor Officer',role:'officer',sections:['project-work','field-experience','assessor','payroll','auditor']},
  'payroll-officer': {label:'Payroll Officer',role:'officer',sections:['project-work','field-experience','payroll']},
  'auditor': {label:'Auditor',role:'viewer',sections:['project-work','field-experience','auditor']}
};
function developerPreviewRedirect(department,destination) {
  if(destination==='payroll') return `/payroll/${encodeURIComponent(department)}`;
  if(destination==='auditor') return `/auditor/${encodeURIComponent(department)}`;
  return `/admin/${encodeURIComponent(department)}`;
}
function previewDestinationAllowed(identity,destination) {
  if(destination==='payroll') return (identity.sections||[]).includes('payroll');
  if(destination==='auditor') return (identity.sections||[]).includes('auditor');
  return ['project-work','field-experience','dissertation','assessor'].some(section=>(identity.sections||[]).includes(section));
}

async function readDb() {
  try {
    const raw = await fsp.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let writeQueue = Promise.resolve();
function writeDb(records) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const temp = DB_FILE + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(records, null, 2), 'utf8');
    await fsp.rename(temp, DB_FILE);
  });
  return writeQueue;
}
function mutateDb(mutator) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const records = await readDb();
    const result = await mutator(records);
    const temp = DB_FILE + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(records, null, 2), 'utf8');
    await fsp.rename(temp, DB_FILE);
    return result;
  });
  return writeQueue;
}

async function readSupportTickets() {
  try {
    return supportDatabase.prepare('SELECT data_json FROM support_tickets ORDER BY created_at DESC').all().map(row => JSON.parse(row.data_json));
  } catch {
    return [];
  }
}

let supportTicketWriteQueue = Promise.resolve();
function mutateSupportTickets(mutator) {
  supportTicketWriteQueue = supportTicketWriteQueue.catch(() => {}).then(async () => {
    const tickets = await readSupportTickets();
    const result = await mutator(tickets);
    persistSupportTickets(tickets);
    const temp = SUPPORT_TICKETS_FILE + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(tickets, null, 2), 'utf8');
    await fsp.rename(temp, SUPPORT_TICKETS_FILE);
    return result;
  });
  return supportTicketWriteQueue;
}

async function readAssignments() {
  try {
    const raw = await fsp.readFile(ASSIGNMENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let assignmentWriteQueue = Promise.resolve();
function mutateAssignments(mutator) {
  assignmentWriteQueue = assignmentWriteQueue.catch(() => {}).then(async () => {
    const records = await readAssignments();
    const result = await mutator(records);
    const temp = ASSIGNMENTS_FILE + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(records, null, 2), 'utf8');
    await fsp.rename(temp, ASSIGNMENTS_FILE);
    return result;
  });
  return assignmentWriteQueue;
}


async function readResources() {
  try {
    const raw = await fsp.readFile(RESOURCES_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
let resourceWriteQueue = Promise.resolve();
function mutateResources(mutator) {
  resourceWriteQueue = resourceWriteQueue.catch(() => {}).then(async () => {
    const records = await readResources();
    const result = await mutator(records);
    const temp = RESOURCES_FILE + '.tmp';
    await fsp.writeFile(temp, JSON.stringify(records, null, 2), 'utf8');
    await fsp.rename(temp, RESOURCES_FILE);
    return result;
  });
  return resourceWriteQueue;
}
function normalizeResourcePortals(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map(v => String(v || '').trim()).filter(v => RESOURCE_PORTALS.has(v)))];
}
function normalizePortalSettings(raw) {
  return {
    version: 1,
    fieldExperienceClaimFormRequired: Boolean(raw?.fieldExperienceClaimFormRequired)
  };
}
async function readPortalSettings() {
  try { return normalizePortalSettings(JSON.parse(await fsp.readFile(PORTAL_SETTINGS_FILE,'utf8'))); }
  catch { return normalizePortalSettings({}); }
}
let portalSettingsWriteQueue=Promise.resolve();
function writePortalSettings(settings) {
  portalSettingsWriteQueue=portalSettingsWriteQueue.catch(()=>{}).then(async()=>{
    const cleaned=normalizePortalSettings(settings);
    const temp=PORTAL_SETTINGS_FILE+'.tmp';
    await fsp.writeFile(temp,JSON.stringify(cleaned,null,2),'utf8');
    await fsp.rename(temp,PORTAL_SETTINGS_FILE);
    return cleaned;
  });
  return portalSettingsWriteQueue;
}

function emptyStudyCentreCatalogue() {
  return Object.fromEntries(Object.keys(DEPARTMENTS).map(slug => [slug, []]));
}
function defaultStudyCentreNames() {
  return [...new Set(readStudyCentreDirectorySync().map(item=>item.name))];
}
function defaultStudyCentreCatalogue() {
  const names=defaultStudyCentreNames();
  return Object.fromEntries(Object.keys(DEPARTMENTS).map(slug=>[slug,names.slice()]));
}
function normalizeStudyCentreCatalogue(parsed) {
  const catalogue=emptyStudyCentreCatalogue();
  // Backward compatibility: every v20-and-earlier study-centres.json file was a
  // single list. The current list has been confirmed as Business-programme centres.
  if(Array.isArray(parsed)){
    catalogue.business=[...new Set(parsed.map(cleanHumanText).filter(Boolean))];
    return catalogue;
  }
  const source=(parsed && typeof parsed==='object' && parsed.departments && typeof parsed.departments==='object') ? parsed.departments : parsed;
  if(source && typeof source==='object'){
    for(const slug of Object.keys(DEPARTMENTS)){
      const values=Array.isArray(source[slug])?source[slug]:[];
      catalogue[slug]=[...new Set(values.map(cleanHumanText).filter(Boolean))];
    }
  }
  return catalogue;
}
async function readStudyCentreCatalogue() {
  try {
    const raw=await fsp.readFile(STUDY_CENTRES_FILE,'utf8');
    const parsed=JSON.parse(raw||'{}');
    if(Number(parsed?.version||0)<3) return defaultStudyCentreCatalogue();
    const catalogue=normalizeStudyCentreCatalogue(parsed);
    if(!Object.values(catalogue).some(list=>list.length)) return defaultStudyCentreCatalogue();
    return catalogue;
  } catch {
    return defaultStudyCentreCatalogue();
  }
}
async function readStudyCentres(department='business') {
  const catalogue=await readStudyCentreCatalogue();
  const centres=Array.isArray(catalogue[department]) ? catalogue[department] : [];
  const disabledNames=new Set(readStudyCentreDirectorySync().filter(item=>item.enabled===false).map(item=>item.name.toLowerCase()));
  // Always expose public study-centre choices alphabetically, regardless of
  // the order in which the Developer/System Admin uploaded the list.
  return centres.filter(name=>!disabledNames.has(String(name||'').toLowerCase())).slice().sort((a,b)=>String(a||'').localeCompare(String(b||''),undefined,{numeric:true,sensitivity:'base'}));
}
async function readProjectStudyCentres(department='business') {
  const centres = await readStudyCentres(department);
  return centres.includes('Non-Residential') ? centres : [...centres, 'Non-Residential'];
}
let studyCentreWriteQueue = Promise.resolve();
function writeStudyCentreCatalogue(catalogue) {
  studyCentreWriteQueue = studyCentreWriteQueue.catch(() => {}).then(async () => {
    const cleaned=normalizeStudyCentreCatalogue({departments:catalogue});
    const temp=STUDY_CENTRES_FILE+'.tmp';
    await fsp.writeFile(temp, JSON.stringify({version:3,departments:cleaned}, null, 2), 'utf8');
    await fsp.rename(temp, STUDY_CENTRES_FILE);
    return cleaned;
  });
  return studyCentreWriteQueue;
}
async function writeStudyCentres(centres, departments=['business']) {
  const selected=normalizeAdminDepartments(departments);
  if(!selected.length) throw new Error('Select at least one department for the uploaded study-centre list.');
  const cleaned=[...new Set((centres || []).map(cleanHumanText).filter(Boolean))];
  const catalogue=await readStudyCentreCatalogue();
  for(const slug of selected) catalogue[slug]=cleaned.slice();
  return writeStudyCentreCatalogue(catalogue);
}
function parseStudyCentreCsv(filePath) {
  const wb=XLSX.readFile(filePath,{raw:false});
  if(!wb.SheetNames.length) throw new Error('The CSV contains no worksheet.');
  const matrix=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:'',raw:false});
  const values=[];
  for(const row of matrix){
    const first=cleanHumanText(row?.[0]);
    if(!first) continue;
    const normalized=first.toLowerCase().replace(/[^a-z]/g,'');
    if(['studycentre','studycenter','centre','center','name'].includes(normalized)) continue;
    values.push(first);
  }
  const unique=[...new Set(values)];
  if(!unique.length) throw new Error('No study centres were found in the first column of the CSV file.');
  return unique;
}

function normalizeCentreCode(value) {
  return cleanHumanText(value).toUpperCase().replace(/\s+/g,'');
}
function normalizeStudyCentreDirectory(raw) {
  const source=Array.isArray(raw)?raw:(Array.isArray(raw?.centres)?raw.centres:[]);
  const seen=new Set();const out=[];
  for(const item of source){
    const code=normalizeCentreCode(item?.code);const name=cleanHumanText(item?.name||item?.centerName||item?.centreName);
    if(!code||!name||seen.has(code)) continue;
    seen.add(code);
    const idText=cleanHumanText(item?.id);
    out.push({id:idText&&/^\d+$/.test(idText)?Number(idText):(idText||''),code,name,enabled:item?.enabled!==false});
  }
  return out.sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true,sensitivity:'base'}));
}
function readStudyCentreDirectorySync() {
  try{const parsed=JSON.parse(fs.readFileSync(STUDY_CENTRE_DIRECTORY_FILE,'utf8')||'{}');if(Number(parsed?.version||0)>=2)return normalizeStudyCentreDirectory(parsed);}
  catch{
    // Fall through to the bundled approved directory.
  }
  try{return normalizeStudyCentreDirectory(JSON.parse(fs.readFileSync(DEFAULT_STUDY_CENTRE_DIRECTORY_PATH,'utf8')||'{}'));}catch{return [];}
}
async function readStudyCentreDirectory(){ return readStudyCentreDirectorySync(); }
let studyCentreDirectoryWriteQueue=Promise.resolve();
function writeStudyCentreDirectory(entries){
  studyCentreDirectoryWriteQueue=studyCentreDirectoryWriteQueue.catch(()=>{}).then(async()=>{
    const cleaned=normalizeStudyCentreDirectory(entries);
    if(!cleaned.length) throw new Error('The study-centre directory cannot be empty.');
    const temp=STUDY_CENTRE_DIRECTORY_FILE+'.tmp';
    await fsp.writeFile(temp,JSON.stringify({version:2,updatedAt:new Date().toISOString(),centres:cleaned},null,2),'utf8');
    await fsp.rename(temp,STUDY_CENTRE_DIRECTORY_FILE);
    return cleaned;
  });
  return studyCentreDirectoryWriteQueue;
}
function centreDirectoryHeaderKey(value){return cleanHumanText(value).toUpperCase().replace(/[^A-Z0-9]/g,'');}
function parseStudyCentreDirectoryFile(filePath){
  const book=XLSX.readFile(filePath,{raw:false});
  if(!book.SheetNames.length) throw new Error('The uploaded study-centre directory contains no worksheet.');
  const matrix=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',raw:false});
  let headerIndex=-1,codeCol=-1,nameCol=-1,idCol=-1,statusCol=-1;
  for(let r=0;r<Math.min(matrix.length,30);r++){
    const keys=(matrix[r]||[]).map(centreDirectoryHeaderKey);
    const c=keys.findIndex(k=>['CODE','CENTRECODE','CENTERCODE','STUDYCENTRECODE','STUDYCENTERCODE'].includes(k));
    const n=keys.findIndex(k=>['CENTERNAME','CENTRENAME','CENTER','CENTRE','STUDYCENTERNAME','STUDYCENTRENAME'].includes(k));
    if(c>=0&&n>=0){headerIndex=r;codeCol=c;nameCol=n;idCol=keys.findIndex(k=>['ID','CENTREID','CENTERID'].includes(k));statusCol=keys.findIndex(k=>['STATUS','ENABLED','ACTIVE'].includes(k));break;}
  }
  if(headerIndex<0) throw new Error('Could not find CODE and CENTER_NAME/CENTRE_NAME columns in the uploaded file.');
  const entries=[];const seen=new Set();
  for(let r=headerIndex+1;r<matrix.length;r++){
    const row=matrix[r]||[];const code=normalizeCentreCode(row[codeCol]);const name=cleanHumanText(row[nameCol]);
    if(!code&&!name) continue;
    if(!code||!name) throw new Error(`Row ${r+1} must contain both centre CODE and centre NAME.`);
    if(seen.has(code)) throw new Error(`Duplicate study-centre code detected: ${code}.`);
    seen.add(code);const idText=idCol>=0?cleanHumanText(row[idCol]):'';
    const status=statusCol>=0?cleanHumanText(row[statusCol]).toUpperCase():'';
    entries.push({id:idText&&/^\d+$/.test(idText)?Number(idText):(idText||''),code,name,enabled:!['DISABLED','INACTIVE','NO','FALSE','0'].includes(status)});
  }
  if(!entries.length) throw new Error('No study-centre code records were found in the uploaded file.');
  return normalizeStudyCentreDirectory(entries);
}
function registrationCentreCode(registrationNo){
  const parts=String(registrationNo||'').split('/').map(v=>v.trim());
  return parts.length>=3&&parts[1]&&parts[2]?normalizeCentreCode(`${parts[1]}/${parts[2]}`):'';
}
function studyCentreDirectoryMapSync(){return new Map(readStudyCentreDirectorySync().map(item=>[item.code,item]));}
function studyCentreInfoFromRegistration(registrationNo,directoryMap=studyCentreDirectoryMapSync()){
  const code=registrationCentreCode(registrationNo);
  if(!code) return {code:'UNCLASSIFIED',name:'UNCLASSIFIED STUDY CENTRE'};
  const found=directoryMap.get(code);
  return found?{code:found.code,name:found.name}:{code,name:`UNKNOWN STUDY CENTRE (${code})`};
}
function centreDirectoryAoA(entries){return [['S/N','ID','CODE','CENTER_NAME','STATUS'],...normalizeStudyCentreDirectory(entries).map((c,i)=>[i+1,c.id||'',c.code,c.name,c.enabled===false?'DISABLED':'ENABLED'])];}
function centreDirectoryWorkbookBuffer(entries){
  const book=XLSX.utils.book_new();addSheet(book,'Study Centre Directory',centreDirectoryAoA(entries),[8,10,14,58,14]);
  return XLSX.write(book,{type:'buffer',bookType:'xlsx'});
}

function builtinResourcePath(resource, department) {
  if(!resource?.builtIn||!departmentFromSlug(department)||!Array.isArray(resource.resourcePath)) return '';
  return path.join(__dirname,'public','resources','departments',department,...resource.resourcePath);
}
function publicResource(resource, department='') {
  const selectedDepartment=departmentFromSlug(department)?department:'';
  return {
    id: resource.id,
    title: resource.title,
    description: resource.description || '',
    portals: resource.portals || [],
    departments: Array.isArray(resource.departments) ? resource.departments : [],
    originalName: resource.originalName || 'Download resource',
    size: Number(resource.size || 0),
    uploadedAt: resource.uploadedAt || null,
    builtIn: Boolean(resource.builtIn),
    department:selectedDepartment,
    departmentName:selectedDepartment?DEPARTMENTS[selectedDepartment].name:'',
    downloadUrl: `/api/resources/${encodeURIComponent(resource.id)}/download${selectedDepartment?`?department=${encodeURIComponent(selectedDepartment)}`:''}`
  };
}

function assignmentTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function newAssignmentToken() { return crypto.randomBytes(32).toString('hex'); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

const PERSON_TITLES = new Set(['mr','mrs','ms','miss','dr','prof','professor','rev','reverend','ing','esq','esquire']);
function cleanHumanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}
function buildDisplayName(title, firstName, lastName) {
  return [cleanHumanText(title), cleanHumanText(firstName), cleanHumanText(lastName)].filter(Boolean).join(' ');
}
function personNameTokens(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter(Boolean).filter(t => !PERSON_TITLES.has(t)).sort();
}
function samePersonName(a, b) {
  const aa = personNameTokens(a), bb = personNameTokens(b);
  if (aa.length < 2 || bb.length < 2) return false;
  const small = aa.length <= bb.length ? aa : bb;
  const large = aa.length <= bb.length ? bb : aa;
  return small.every(v => large.includes(v));
}
function personKey(name, email='') {
  const tokens=personNameTokens(name);
  return tokens.length>=2 ? `name:${tokens.join('|')}` : `email:${String(email||'').trim().toLowerCase()}`;
}
function normalizeDissertationTitle(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function compactDissertationTitle(value) {
  return normalizeDissertationTitle(value).replace(/\s+/g, '');
}
async function extractDissertationText(file) {
  const ext = path.extname(file.originalname || file.path).toLowerCase();
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: file.path });
    return String(result.value || '');
  }
  if (ext === '.doc') {
    const extractor = new WordExtractor();
    const result = await extractor.extract(file.path);
    return String(result.getBody ? result.getBody() : '');
  }
  if (ext === '.pdf') {
    const buffer = await fsp.readFile(file.path);
    const parser = new PDFParse({ data: buffer, CanvasFactory });
    try {
      const result = await parser.getText({ first: 4 });
      return String(result.text || '');
    } finally {
      if (typeof parser.destroy === 'function') { try { await parser.destroy(); } catch {} }
    }
  }
  throw new Error('Dissertation title validation supports PDF, DOC and DOCX files only.');
}

async function sendInlineClaimPreview(res, item, previewTitle = 'Claim Form Preview') {
  if(!item?.storedName) return res.status(404).send('Claim form is unavailable.');
  const fp=path.join(FILES_DIR,path.basename(item.storedName));
  if(!fs.existsSync(fp)) return res.status(404).send('Claim form file is unavailable.');
  const ext=path.extname(item.originalName||fp).toLowerCase();
  if(ext==='.pdf'){
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`inline; filename="${safeBaseName(item.originalName||'claim-form.pdf')}"`);
    return fs.createReadStream(fp).pipe(res);
  }
  if(['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)){
    res.setHeader('Content-Type',item.mimeType||'image/jpeg');
    res.setHeader('Content-Disposition',`inline; filename="${safeBaseName(item.originalName||'claim-form')}"`);
    return fs.createReadStream(fp).pipe(res);
  }
  let body='';
  try{
    if(ext==='.docx'){
      const result=await mammoth.convertToHtml({path:fp});body=String(result.value||'');
    }else if(ext==='.doc'){
      const extractor=new WordExtractor();const result=await extractor.extract(fp);body=`<pre>${htmlEscape(result.getBody?result.getBody():'')}</pre>`;
    }else if(['.xlsx','.xls','.csv'].includes(ext)){
      const wb=XLSX.readFile(fp,{raw:false});const first=wb.SheetNames[0];body=first?XLSX.utils.sheet_to_html(wb.Sheets[first]):'<p>No worksheet available.</p>';
    }else{
      body=`<p>This file type cannot be rendered inline. <a href="#" onclick="history.back();return false">Return</a> and use Download.</p>`;
    }
  }catch(e){console.error('Claim preview conversion failed:',e);body=`<p>The claim form could not be rendered inline. Use the Download action to inspect the original file.</p>`;}
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(previewTitle)}</title><style>body{font-family:Arial,sans-serif;margin:0;padding:22px;color:#172431;background:#fff}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #cbd5df;padding:6px 8px}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.5}.preview-head{position:sticky;top:0;background:#fff;border-bottom:1px solid #dce3ea;padding:0 0 12px;margin-bottom:18px}.preview-head strong{color:#082b4c}</style></head><body><div class="preview-head"><strong>${htmlEscape(previewTitle)}</strong><br><small>${htmlEscape(item.originalName||'Document')}</small></div>${body}</body></html>`);
}

async function uploadedFileContainsReviewerIdentity(file, reviewerName='', reviewerEmail='') {
  if(!file) return false;
  const ext=path.extname(file.originalname||file.path).toLowerCase();
  if(!['.pdf','.doc','.docx'].includes(ext)) return false;
  try {
    const raw=(await extractDissertationText(file)).slice(0,200000);
    const normalized=normalizeDissertationTitle(raw);
    const email=String(reviewerEmail||'').trim().toLowerCase();
    if(email && raw.toLowerCase().includes(email)) return true;
    const tokens=personNameTokens(reviewerName);
    if(tokens.length>=2){const joined=tokens.join(' ');if(normalized.includes(joined))return true;}
    return false;
  } catch { return false; }
}

async function validateDissertationTitleAgainstFile(enteredTitle, file) {
  const expected = normalizeDissertationTitle(enteredTitle);
  const expectedCompact = compactDissertationTitle(enteredTitle);
  if (expected.length < 8) throw new Error('Enter the full dissertation title as it appears on the title page.');
  let extracted;
  try {
    extracted = await extractDissertationText(file);
  } catch (e) {
    throw new Error(`The dissertation text could not be read for title validation. ${e.message || e}`);
  }
  const firstText = String(extracted || '').slice(0, 120000);
  if (normalizeDissertationTitle(firstText).length < 20) {
    throw new Error('The uploaded dissertation does not contain enough readable text for automatic title validation. Upload a searchable PDF, DOC or DOCX file.');
  }
  const normalDoc = normalizeDissertationTitle(firstText);
  const compactDoc = compactDissertationTitle(firstText);
  const matched = normalDoc.includes(expected) || (expectedCompact.length >= 12 && compactDoc.includes(expectedCompact));
  if (!matched) {
    throw new Error('The entered dissertation title does not match the title found in the uploaded work. Copy the title exactly as it appears on the dissertation title page and submit again.');
  }
  return { matched: true, method: 'document-text', checkedAt: new Date().toISOString() };
}
function baseUrlFor(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}
function assignmentState(a) {
  if (a.revokedAt) return 'revoked';
  if (a.expiresAt && new Date(a.expiresAt).getTime() <= Date.now()) return 'expired';
  if (a.downloadedAt) return 'downloaded';
  if (a.emailStatus === 'failed') return 'email-failed';
  if (a.sentAt) return 'sent';
  return a.emailStatus || 'pending';
}
function publicAssignment(a, dissertationRecordsForDepartment=[], assessorSubmissionRecords=[]) {
  const linked=(a.dissertationIds||[]).map(id=>dissertationRecordsForDepartment.find(r=>r.id===id)).filter(Boolean);
  const fallbackDeadlines=assignmentDeadlineDates(new Date(a.sentAt||a.createdAt||Date.now()));
  const completion=assignmentWorkCompletion(a,assessorSubmissionRecords);
  let status;
  if(a.revokedAt)status='revoked';
  else if(completion.total>0&&completion.submittedCount>=completion.total)status='completed';
  else if(completion.submittedCount>0)status='in-progress';
  else if(a.emailStatus==='failed')status='email-failed';
  else if(a.expiresAt&&new Date(a.expiresAt).getTime()<=Date.now())status='download-expired';
  else if(a.downloadedAt)status='downloaded';
  else if(a.sentAt)status='sent';
  else status=a.emailStatus||'pending';
  const earlyBirdCount=[...completion.submitted.values()].filter(x=>earlyBirdForSubmission(a,x.record?.submittedAt)).length;
  return {
    id:a.id, reference:a.reference, department:a.department, departmentName:a.departmentName,
    assessorTitle:a.assessorTitle || '', assessorFirstName:a.assessorFirstName || '', assessorLastName:a.assessorLastName || '',
    assessorName:a.assessorName, assessorEmail:a.assessorEmail, dissertationCount:(a.dissertationIds || []).length,
    assignmentType:a.assignmentType || 'assessment',
    dissertationIds:(a.dissertationIds||[]).slice(),
    studentNames:linked.map(r=>r.studentName||r.name||r.reference).filter(Boolean),
    studentIndexNumbers:linked.map(r=>r.indexNumber||'').filter(Boolean),
    createdAt:a.createdAt, sentAt:a.sentAt || null, expiresAt:a.expiresAt, earlyBirdDueAt:a.earlyBirdDueAt||fallbackDeadlines.earlyBirdDueAt, assessmentDueAt:a.assessmentDueAt||fallbackDeadlines.assessmentDueAt, downloadedAt:a.downloadedAt || null,
    downloadCount:Number(a.downloadCount || 0), revokedAt:a.revokedAt || null, emailStatus:a.emailStatus || 'pending',
    submittedCount:completion.submittedCount, pendingCount:completion.pendingCount, earlyBirdCount,
    status, resendCount:Number(a.resendCount || 0), lastEmailError:a.lastEmailError || ''
  };
}
function activeAssessorMap(assignments, includePending=false) {
  const map = new Map();
  for (const a of assignments || []) {
    if (a.revokedAt || (!a.sentAt && !(includePending && a.emailStatus === 'pending'))) continue;
    const email = String(a.assessorEmail || '').trim().toLowerCase();
    const name = a.assessorName || a.assessorEmail || '';
    const key = personKey(name,email);
    if (!key) continue;
    for (const id of a.dissertationIds || []) {
      if (!map.has(id)) map.set(id, new Map());
      if (!map.get(id).has(key)) map.get(id).set(key, {email,name});
    }
  }
  return map;
}
function reservedAssessorMap(assignments) {
  const map = new Map();
  for (const a of assignments || []) {
    if (a.revokedAt) continue;
    const email = String(a.assessorEmail || '').trim().toLowerCase();
    const name = a.assessorName || a.assessorEmail || '';
    const key = personKey(name,email);
    if (!key) continue;
    for (const id of a.dissertationIds || []) {
      if (!map.has(id)) map.set(id, new Map());
      if (!map.get(id).has(key)) map.get(id).set(key, {email,name,assignmentId:a.id});
    }
  }
  return map;
}
function dissertationAssignmentInfo(dissertationId, assignments, assignmentType=null) {
  const map=new Map();
  for(const a of assignments||[]){
    if(a.revokedAt) continue;
    if(assignmentType && (a.assignmentType||'assessment')!==assignmentType) continue;
    if(!(a.dissertationIds||[]).map(String).includes(String(dissertationId))) continue;
    const email=String(a.assessorEmail||'').trim().toLowerCase(),name=a.assessorName||a.assessorEmail||'',key=personKey(name,email);
    if(key&&!map.has(key))map.set(key,{email,name,assignmentId:a.id});
  }
  return {count:map.size,assessors:[...map.values()]};
}
function gmailConfigured() {
  return Boolean(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN && GMAIL_SENDER_EMAIL);
}
function cleanMailHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}
function encodeMailHeader(value) {
  const text = cleanMailHeader(value);
  if (!text) return '';
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}
function base64Url(value) {
  const buffer=Buffer.isBuffer(value)?value:Buffer.from(value,'utf8');
  return buffer.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function wrapBase64(buffer){return Buffer.from(buffer).toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';}

async function getGmailAccessToken() {
  if (!gmailConfigured()) {
    throw new Error('Gmail API is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN and GMAIL_SENDER_EMAIL.');
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body:new URLSearchParams({
      client_id:GMAIL_CLIENT_ID,
      client_secret:GMAIL_CLIENT_SECRET,
      refresh_token:GMAIL_REFRESH_TOKEN,
      grant_type:'refresh_token'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const detail = data.error_description || data.error || `Google OAuth returned HTTP ${response.status}.`;
    throw new Error(`Could not obtain a Gmail access token: ${detail}`);
  }
  return data.access_token;
}
async function sendGmailHtmlEmail({to, subject, html, attachments=[]}) {
  if (!gmailConfigured()) throw new Error('Gmail API is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN and GMAIL_SENDER_EMAIL.');
  if (!isEmail(to)) throw new Error('The recipient email address is invalid.');
  if (!isEmail(GMAIL_SENDER_EMAIL)) throw new Error('GMAIL_SENDER_EMAIL is not a valid email address.');
  const fromName = encodeMailHeader(GMAIL_FROM_NAME || 'UCC Dissertation Portal');
  const fromHeader = fromName ? `${fromName} <${cleanMailHeader(GMAIL_SENDER_EMAIL)}>` : cleanMailHeader(GMAIL_SENDER_EMAIL);
  const baseHeaders=[`From: ${fromHeader}`,`To: ${cleanMailHeader(to)}`,`Subject: ${encodeMailHeader(subject)}`,'MIME-Version: 1.0'];
  let rawMessage;
  if(Array.isArray(attachments)&&attachments.length){
    const boundary=`ucc-portal-${crypto.randomBytes(12).toString('hex')}`;
    const parts=[...baseHeaders,`Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,'Content-Type: text/html; charset="UTF-8"','Content-Transfer-Encoding: 8bit','',html];
    for(const attachment of attachments){
      const filename=safeBaseName(attachment.filename||'attachment.bin');
      const content=Buffer.isBuffer(attachment.content)?attachment.content:Buffer.from(attachment.content||'');
      parts.push(`--${boundary}`,`Content-Type: ${cleanMailHeader(attachment.contentType||'application/octet-stream')}; name="${filename}"`,`Content-Disposition: attachment; filename="${filename}"`,'Content-Transfer-Encoding: base64','',wrapBase64(content));
    }
    parts.push(`--${boundary}--`,'');
    rawMessage=parts.join('\r\n');
  }else{
    rawMessage=[...baseHeaders,'Content-Type: text/html; charset="UTF-8"','Content-Transfer-Encoding: 8bit','',html].join('\r\n');
  }
  const accessToken = await getGmailAccessToken();
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:'POST', headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ raw:base64Url(rawMessage) })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.error_description || data?.error || `Gmail API returned HTTP ${response.status}.`;
    throw new Error(detail);
  }
  return data;
}
function assignmentDeadlineDates(baseDate=new Date()) {
  const start=new Date(baseDate);
  return {
    earlyBirdDueAt:new Date(start.getTime()+28*24*60*60*1000).toISOString(),
    assessmentDueAt:new Date(start.getTime()+56*24*60*60*1000).toISOString()
  };
}
async function sendGmailEmail({ to, assessorName, departmentName, dissertationCount, expiresAt, secureUrl, earlyBirdDueAt, assessmentDueAt, message, assignmentType='assessment' }) {
  const isVetting=assignmentType==='vetting';
  const taskLabel=isVetting?'vetting':'assessment';
  const taskTitle=isVetting?'Vetting':'Assessment';
  const expiresText = new Date(expiresAt).toLocaleString('en-GB', { dateStyle:'long', timeStyle:'short', timeZone:'UTC' }) + ' UTC';
  const earlyText = new Date(earlyBirdDueAt).toLocaleDateString('en-GB', { dateStyle:'long', timeZone:'UTC' });
  const dueText = new Date(assessmentDueAt).toLocaleDateString('en-GB', { dateStyle:'long', timeZone:'UTC' });
  const optionalMessage = message ? `<div style="margin:18px 0;padding:14px 16px;background:#f5f7fa;border-left:4px solid #d4a72c"><strong>Message from the department</strong><br>${htmlEscape(message).replace(/\n/g,'<br>')}</div>` : '';
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">Dissertations Assigned for ${taskTitle}</h2><p>Dear ${htmlEscape(assessorName)},</p><p>${htmlEscape(departmentName)} has assigned <strong>${dissertationCount}</strong> dissertation${dissertationCount===1?'':'s'} to you for ${taskLabel}.</p>${optionalMessage}<p><a href="${htmlEscape(secureUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Access Your ${taskTitle} Assignment</a></p><p>This <strong>single secure assignment link</strong> contains all assigned works. Use it to download the dissertations and to submit each ${taskLabel} report separately as you complete it. Please do not forward the link.</p><div style="margin:20px 0;padding:16px;background:#fff7dc;border:1px solid #ead58c;border-radius:8px"><strong>${taskTitle} timeline</strong><ul style="margin-bottom:0"><li>Dissertation downloads are available through <strong>${htmlEscape(expiresText)}</strong>. The same assignment workspace remains available for report submission through the 8-week due date.</li><li>Please submit each ${taskLabel} report, claim form and score sheet within <strong>8 weeks</strong> of the original assignment, by <strong>${htmlEscape(dueText)}</strong>.</li><li>Each individual work submitted within <strong>4 weeks</strong>, by <strong>${htmlEscape(earlyText)}</strong>, qualifies for the <strong>Early Bird</strong> completion category.</li></ul></div><p>Your assigned student names, index numbers, programmes and student-email links are bound to the secure assignment. You do not need to re-enter student information.</p><p style="font-size:13px;color:#526575">Assignment link: ${htmlEscape(secureUrl)}<br>You can return to this same link to submit remaining reports until the 8-week due date unless the department revokes the assignment.</p><p>Regards,<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  return sendGmailHtmlEmail({to,subject:`Dissertations for ${taskTitle} - ${departmentName}`,html});
}
async function sendStudentFeedbackEmail({to, studentName, departmentName, secureUrl, expiresAt, reportType='assessment'}) {
  const isVetting=reportType==='vetting';
  const label=isVetting?'Vetting':'Assessment';
  const expiryText=new Date(expiresAt).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'})+' UTC';
  const html=`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">Dissertation ${label} Feedback</h2><p>Dear ${htmlEscape(studentName)},</p><p>${htmlEscape(departmentName)} has made your dissertation ${label.toLowerCase()} feedback available.</p><p>The feedback is provided anonymously. The portal does not disclose the identity, name or email address of the assessor/vetter.</p><p><a href="${htmlEscape(secureUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Access ${label} Feedback</a></p><p>This secure link expires on <strong>${htmlEscape(expiryText)}</strong>. Please do not forward the link.</p><p>Regards,<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  return sendGmailHtmlEmail({to,subject:`Dissertation ${label} Feedback`,html});
}
async function sendDissertationReturnedEmail({to,studentName,departmentName,submissionType,reason,portalUrl}) {
  const typeLabel=submissionType==='final'?'Final Dissertation':submissionType==='revised'?'Revised Dissertation':'Fresh Dissertation';
  const html=`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">${typeLabel} Returned for Correction</h2><p>Dear ${htmlEscape(studentName)},</p><p>${htmlEscape(departmentName)} has returned your ${typeLabel.toLowerCase()} submission without further processing.</p><div style="margin:18px 0;padding:15px;background:#fff4e5;border-left:4px solid #cf7b00"><strong>Reason</strong><br>${htmlEscape(reason)}</div><p>Please address the issue and submit the appropriate dissertation stage again through the Dissertation Submission Portal.</p><p><a href="${htmlEscape(portalUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:11px 16px;border-radius:7px;font-weight:bold">Open Dissertation Submission Portal</a></p><p>Regards,<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  return sendGmailHtmlEmail({to,subject:`${typeLabel} returned for correction`,html});
}

async function sendScoreSubmissionReturnedEmail({to,supervisorName,departmentName,reference,studyCentre,reason,portalType='project-work',portalUrl}) {
  const isField=portalType==='field-experience';
  const typeLabel=isField?'Field Experience and Teaching Practice Score Submission':'Undergraduate Project Work Submission';
  const html=`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">${typeLabel} Returned for Correction</h2><p>Dear ${htmlEscape(supervisorName||'Mentor / Supervisor / Examiner')},</p><p>${htmlEscape(departmentName)} has reviewed your submission and returned it for correction.</p><div style="margin:18px 0;padding:15px;background:#f5f8fb;border:1px solid #d9e2ec;border-radius:8px"><strong>Submission reference:</strong> ${htmlEscape(reference||'')}<br><strong>Study centre:</strong> ${htmlEscape(studyCentre||'')}</div><div style="margin:18px 0;padding:15px;background:#fff4e5;border-left:4px solid #cf7b00"><strong>Reason / correction required</strong><br>${htmlEscape(reason).replace(/\n/g,'<br>')}</div><p>Please correct the identified issue and submit the corrected ${isField?'Field Experience and Teaching Practice score':'Undergraduate Project Work'} records again through the submission portal. The corrected submission will enter <strong>Pending Verification</strong> for departmental review.</p><p><a href="${htmlEscape(portalUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:11px 16px;border-radius:7px;font-weight:bold">Open ${isField?'Field Experience and Teaching Practice':'Project Work'} Submission Portal</a></p><p>If you believe this notice was sent in error, please contact the department and quote the submission reference above.</p><p>Regards,<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  return sendGmailHtmlEmail({to,subject:`${typeLabel} returned for correction - ${reference||''}`,html});
}

async function assignmentByToken(token) {
  const hash = assignmentTokenHash(token);
  const assignments = await readAssignments();
  return assignments.find(a => a.tokenHash === hash) || null;
}
function validateLiveAssignment(a) {
  if (!a) return { ok:false, status:404, message:'This secure dissertation link is invalid.' };
  if (a.revokedAt) return { ok:false, status:410, message:'This secure dissertation link has been revoked.' };
  if (new Date(a.expiresAt).getTime() <= Date.now()) return { ok:false, status:410, message:'This secure dissertation download link has expired. Please contact the department for a new download link.' };
  return { ok:true };
}
async function noteAssignmentDownload(assignmentId){
  return mutateAssignments(list=>{const item=list.find(x=>x.id===assignmentId);if(item){item.downloadedAt=item.downloadedAt||new Date().toISOString();item.lastDownloadedAt=new Date().toISOString();item.downloadCount=Number(item.downloadCount||0)+1;}return true;});
}
function validateLiveAssignmentForSubmission(a) {
  if (!a) return { ok:false, status:404, message:'This secure assignment link is invalid.' };
  if (a.revokedAt) return { ok:false, status:410, message:'This secure assignment link has been revoked.' };
  const fallback=assignmentDeadlineDates(new Date(a.sentAt||a.createdAt||Date.now()));
  const dueAt=a.assessmentDueAt||fallback.assessmentDueAt;
  if (new Date(dueAt).getTime() <= Date.now()) return { ok:false, status:410, message:'The 8-week report submission period for this assignment has ended. Please contact the department administrator.' };
  return { ok:true };
}

function assignmentSubmittedWorkMap(assignmentId, records) {
  const map=new Map();
  for(const record of assessorRecords(records||[])){
    if(String(record.assignmentId||'')!==String(assignmentId||'')) continue;
    for(let i=0;i<(record.works||[]).length;i++){
      const work=record.works[i];
      const dissertationId=work?.studentSubmissionId || record.assignmentWorkId || '';
      if(!dissertationId || map.has(String(dissertationId))) continue;
      map.set(String(dissertationId), {record,work,workIndex:i});
    }
  }
  return map;
}
function assignmentWorkCompletion(assignment, records) {
  const submitted=assignmentSubmittedWorkMap(assignment?.id,records);
  const ids=(assignment?.dissertationIds||[]).map(String);
  const submittedCount=ids.filter(id=>submitted.has(id)).length;
  const total=ids.length;
  return {submitted,total,pendingCount:Math.max(0,total-submittedCount),submittedCount};
}
function earlyBirdForSubmission(assignment, submittedAt) {
  const base=new Date(assignment?.sentAt||assignment?.createdAt||Date.now());
  const due=assignment?.earlyBirdDueAt||assignmentDeadlineDates(base).earlyBirdDueAt;
  return Boolean(submittedAt && new Date(submittedAt).getTime()<=new Date(due).getTime());
}
const assignmentWorkQueues=new Map();
function withAssignmentWorkLock(key, task){
  const k=String(key||'');
  const previous=assignmentWorkQueues.get(k)||Promise.resolve();
  const current=previous.catch(()=>{}).then(task);
  const tracked=current.finally(()=>{if(assignmentWorkQueues.get(k)===tracked)assignmentWorkQueues.delete(k);});
  assignmentWorkQueues.set(k,tracked);
  return tracked;
}

function normalizeIndexNumber(value){return String(value||'').trim().toLowerCase().replace(/\s+/g,'');}
function feedbackState(feedback){
  if(!feedback) return 'not-forwarded';
  if(feedback.revokedAt) return 'revoked';
  if(feedback.expiresAt && new Date(feedback.expiresAt).getTime()<=Date.now()) return 'expired';
  if(feedback.downloadedAt) return 'downloaded';
  if(feedback.emailStatus==='failed') return 'email-failed';
  if(feedback.sentAt) return 'sent';
  return feedback.emailStatus || 'pending';
}
async function feedbackByToken(token){
  const hash=assignmentTokenHash(token);
  const records=await readDb();
  for(const record of assessorRecords(records)){
    for(let i=0;i<(record.works||[]).length;i++){
      const work=record.works[i];
      if(work?.feedback?.tokenHash===hash) return {record,work,workIndex:i};
    }
  }
  return null;
}
function validateLiveFeedback(found){
  if(!found?.work?.feedback) return {ok:false,status:404,message:'This assessment feedback link is invalid.'};
  const f=found.work.feedback;
  if(f.revokedAt) return {ok:false,status:410,message:'This assessment feedback link has been revoked.'};
  if(f.expiresAt && new Date(f.expiresAt).getTime()<=Date.now()) return {ok:false,status:410,message:'This assessment feedback link has expired. Please contact the department.'};
  return {ok:true};
}
async function mutateAssessmentWork(recordId, workIndex, mutator){
  let result=null;
  const all=await readDb();
  const record=all.find(r=>r.id===recordId && r.portalType==='assessor');
  const work=record?.works?.[workIndex];
  if(!record||!work) return null;
  result=await mutator(work,record);
  await writeDb(all);
  return result;
}
function latestStudentDissertation(records, department, indexNumber){
  const key=normalizeIndexNumber(indexNumber);
  return dissertationRecords(recordsForDepartment(records,department))
    .filter(r=>normalizeIndexNumber(r.indexNumber)===key && isEmail(r.email))
    .sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')))[0] || null;
}
function latestDissertationOfType(records, department, indexNumber, submissionType) {
  const key=normalizeIndexNumber(indexNumber);
  return dissertationRecords(recordsForDepartment(records,department))
    .filter(r=>normalizeIndexNumber(r.indexNumber)===key && (r.submissionType||'fresh')===submissionType)
    .sort((a,b)=>String(b.submittedAt||'').localeCompare(String(a.submittedAt||'')))[0] || null;
}
function dissertationLineageParent(records, department, indexNumber, submissionType) {
  if(submissionType==='revised') return latestDissertationOfType(records,department,indexNumber,'fresh');
  if(submissionType==='final') return latestDissertationOfType(records,department,indexNumber,'revised') || latestDissertationOfType(records,department,indexNumber,'fresh');
  return null;
}
function dissertationProcessingStatus(record){return record?.processingStatus||'received';}
function dissertationReturnReason(record){return record?.returnReason||'';}


function normalizeHeader(value) {
  return String(value ?? '')
    .trim().toUpperCase().replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/')
    .replace(/\.$/, '');
}
const NORMALIZED_REQUIRED = REQUIRED_HEADERS.map(normalizeHeader);

function findHeader(matrix) {
  const limit = Math.min(matrix.length, MAX_HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const normalized = (matrix[r] || []).map(normalizeHeader);
    if (NORMALIZED_REQUIRED.every(h => normalized.includes(h))) {
      const map = {};
      normalized.forEach((h, i) => { if (h && map[h] === undefined) map[h] = i; });
      return { rowIndex: r, map };
    }
  }
  return null;
}

function cellText(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function parseFlexiblePositiveCount(value) {
  const raw=cleanHumanText(value).toLowerCase();
  if(!raw) return null;
  const digits=raw.match(/\b(\d{1,4})\b/);
  if(digits){const n=Number(digits[1]);return Number.isInteger(n)&&n>0?n:null;}
  const small={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19};
  const tens={twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
  const words=raw.replace(/[()\-]/g,' ').split(/\s+/).filter(Boolean);
  let total=0,found=false;
  for(const word of words){
    if(Object.prototype.hasOwnProperty.call(small,word)){total+=small[word];found=true;continue;}
    if(Object.prototype.hasOwnProperty.call(tens,word)){total+=tens[word];found=true;continue;}
    if(word==='hundred'&&found){total=Math.max(1,total)*100;continue;}
  }
  return found&&total>0?total:null;
}
function normalizeProjectGroupNumber(value){return cleanHumanText(value).toUpperCase().replace(/\s+/g,' ');}
function projectUniqueGroupNumbersFromRows(rows){
  const seen=new Map();
  for(const row of rows||[]){const raw=cleanHumanText(row?.groupNo);const key=normalizeProjectGroupNumber(raw);if(key&&!seen.has(key))seen.set(key,raw);}
  return [...seen.values()];
}
function projectGroupValidation(record){
  const rows=validScoreRows(record);
  const groups=projectUniqueGroupNumbersFromRows(rows);
  const claimed=parseFlexiblePositiveCount(record?.groupCount);
  const works=Array.isArray(record?.files?.completedWork)?record.files.completedWork.length:(record?.files?.completedWork?1:0);
  const issues=[];
  if(!claimed) issues.push('The Total Number of Groups Submitting could not be interpreted as a positive number.');
  if(claimed&&groups.length!==claimed) issues.push(`Claimed groups (${claimed}) differ from the ${groups.length} distinct group number${groups.length===1?'':'s'} in the score sheet.`);
  if(claimed&&works!==claimed) issues.push(`Claimed groups (${claimed}) differ from the ${works} completed project work file${works===1?'':'s'} attached.`);
  if(groups.length&&works!==groups.length) issues.push(`The score sheet contains ${groups.length} distinct group${groups.length===1?'':'s'}, but ${works} completed project work file${works===1?'':'s'} ${works===1?'was':'were'} attached.`);
  return {claimedGroupCount:claimed,scoreSheetGroupCount:groups.length,groupNumbers:groups,completedProjectWorkCount:works,valid:issues.length===0,issues};
}
function numericSn(v) { return /^\d+(?:\.0+)?$/.test(String(v || '').trim()); }

// Project/Field score templates may contain signature metadata underneath the student table.
// These rows must never be treated as student results or included in consolidated/master exports.
function normalizeScoreFooterText(value) {
  return cellText(value)
    .replace(/[.…·_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().toUpperCase();
}
function isScoreFooterValues(values) {
  const nonEmpty = (values || []).map(cellText).filter(Boolean);
  if (!nonEmpty.length) return false;
  const cleaned = nonEmpty.map(normalizeScoreFooterText);
  if (cleaned.some(v => /^(SIGNATURE OF (THE )?(SUPERVISOR|EXAMINER)|SUPERVISOR SIGNATURE|EXAMINER SIGNATURE)\b/.test(v))) return true;
  // In the approved Project Work template, Date and Contact appear as standalone footer rows
  // immediately after the supervisor-signature line. Treat such single-value rows as metadata.
  if (cleaned.length === 1 && /^(DATE|CONTACT)\b/.test(cleaned[0])) return true;
  return false;
}
function isStoredScoreFooterRow(row) {
  return isScoreFooterValues([row?.name, row?.registrationNo, row?.groupNo, row?.totalScore]);
}

function parseScoreWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  if (!workbook.SheetNames.length) throw new Error('The workbook contains no worksheet.');
  if (workbook.SheetNames.length !== 1) throw new Error('Undergraduate Project Work score sheets must contain one Excel worksheet only. Remove additional worksheets and upload the single score sheet again.');
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const header = findHeader(matrix);
  if (!header) throw new Error(`The five required headings were not found: ${REQUIRED_HEADERS.join(' | ')}`);

  const idx = Object.fromEntries(NORMALIZED_REQUIRED.map(h => [h, header.map[h]]));
  const rows = [];
  for (let r = header.rowIndex + 1; r < matrix.length; r++) {
    const source = matrix[r] || [];
    const vals = NORMALIZED_REQUIRED.map(h => cellText(source[idx[h]]));
    const [sn, name, registrationNo, groupNo, totalScore] = vals;

    // Acceptance validation is header-only. These conditions are used only to avoid
    // treating blank template lines or signature/footer content as student score rows.
    // Stop when the supervisor/examiner signature metadata section is reached.
    // This excludes the Signature of Supervisor, Date and Contact lines from row counts
    // and from every consolidated/master score export.
    if (isScoreFooterValues([name, registrationNo, groupNo, totalScore])) break;

    // Ignore empty template rows, including rows that contain only a pre-filled S/N.
    // Header validation remains header-only.
    const hasStudentData = Boolean(name || registrationNo || groupNo || totalScore);
    if (!hasStudentData) continue;
    rows.push({ originalSn: sn, name, registrationNo, groupNo, totalScore });
  }
  return { sheetName: workbook.SheetNames[0], headerRow: header.rowIndex + 1, rows };
}


function fieldAssessmentSpec(key) {
  return FIELD_ASSESSMENTS[String(key||'').trim()] || null;
}
function fieldAssessmentLabel(record) {
  const spec=fieldAssessmentSpec(record?.assessmentType);
  return spec?.label || record?.assessmentLabel || 'Previous / Unclassified Field Experience';
}
function normalizedAliasSet(values) {
  return new Set((values||[]).map(normalizeHeader));
}
const FIELD_COMMON_HEADER_ALIASES = Object.freeze({
  sn: normalizedAliasSet(['S/N','SN','S NO','S. NO.']),
  registration: normalizedAliasSet(['REGISTRATION','REGISTRATION NO.','REGISTRATION NO','REGISTRATION NUMBER','REG NO.','REG NO']),
  name: normalizedAliasSet(['NAME OF STUDENT','NAME OF STUDENTS','STUDENT NAME','STUDENTS','STUDENT','NAME'])
});
function findAliasIndex(normalizedRow, aliases, used=new Set()) {
  for(let i=0;i<normalizedRow.length;i++){
    if(used.has(i)) continue;
    if(aliases.has(normalizedRow[i])) return i;
  }
  return -1;
}
function fieldAssessmentIdentityMatches(matrix, sheetName, spec) {
  const haystack=[
    normalizeHeader(sheetName),
    ...(matrix||[]).slice(0,12).flat().map(normalizeHeader).filter(Boolean)
  ];
  const aliases=normalizedAliasSet(spec?.identityAliases||[spec?.label||'']);
  return haystack.some(value=>aliases.has(value));
}
function findFieldAssessmentHeader(matrix, spec) {
  const scoreAliasSets=(spec?.scoreAliases||[]).map(normalizedAliasSet);
  const limit=Math.min(matrix.length,MAX_HEADER_SCAN_ROWS);
  for(let r=0;r<limit;r++){
    const normalized=(matrix[r]||[]).map(normalizeHeader);
    const used=new Set();
    const sn=findAliasIndex(normalized,FIELD_COMMON_HEADER_ALIASES.sn,used); if(sn<0)continue; used.add(sn);
    const registration=findAliasIndex(normalized,FIELD_COMMON_HEADER_ALIASES.registration,used); if(registration<0)continue; used.add(registration);
    const name=findAliasIndex(normalized,FIELD_COMMON_HEADER_ALIASES.name,used); if(name<0)continue; used.add(name);
    const scoreIndexes=[];
    let ok=true;
    for(const aliases of scoreAliasSets){
      const idx=findAliasIndex(normalized,aliases,used);
      if(idx<0){ok=false;break;}
      used.add(idx);scoreIndexes.push(idx);
    }
    if(ok) return {rowIndex:r,indexes:{sn,registration,name,scores:scoreIndexes}};
  }
  return null;
}
function parseFieldExperienceWorkbook(filePath, assessmentType) {
  const spec=fieldAssessmentSpec(assessmentType);
  if(!spec) throw new Error('Please select a valid Field Experience or Teaching Practice assessment type.');
  const workbook=XLSX.readFile(filePath,{cellDates:false});
  if(!workbook.SheetNames.length) throw new Error('The workbook contains no worksheet.');
  let selected=null;
  for(const sheetName of workbook.SheetNames){
    const sheet=workbook.Sheets[sheetName];
    const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false});
    const header=findFieldAssessmentHeader(matrix,spec);
    const usesGenericScore=(spec.scoreAliases||[]).some(group=>(group||[]).map(normalizeHeader).includes(normalizeHeader('SCORE')));
    if(header && (!usesGenericScore || fieldAssessmentIdentityMatches(matrix,sheetName,spec))){selected={sheetName,matrix,header};break;}
  }
  if(!selected){
    throw new Error(`The selected workbook does not contain the required ${spec.label} columns. Expected S/N, Registration, Name of Student and ${spec.scoreHeaders.join(' | ')}.`);
  }
  const rows=[];
  for(let r=selected.header.rowIndex+1;r<selected.matrix.length;r++){
    const source=selected.matrix[r]||[];
    const originalSn=cellText(source[selected.header.indexes.sn]);
    const registrationNo=cellText(source[selected.header.indexes.registration]);
    const name=cellText(source[selected.header.indexes.name]);
    const scoreValues=selected.header.indexes.scores.map(idx=>cellText(source[idx]));
    if(isScoreFooterValues([name,registrationNo,...scoreValues])) break;
    if(!Boolean(name||registrationNo||scoreValues.some(Boolean))) continue;
    rows.push({originalSn,registrationNo,name,scoreValues});
  }
  return {
    assessmentType,
    assessmentLabel:spec.label,
    sheetName:selected.sheetName,
    headerRow:selected.header.rowIndex+1,
    scoreHeaders:[...spec.scoreHeaders],
    rows
  };
}
function fieldValidScoreRowsWithMeta(record) {
  const spec=fieldAssessmentSpec(record?.assessmentType);
  if(!spec){
    // Backward compatibility for Field Experience submissions made before the
    // dedicated Field Experience and Teaching Practice templates were introduced.
    return validScoreRowsWithMeta(record).map(row=>({
      sourceIndex:row.sourceIndex,
      originalSn:row.originalSn||'',
      registrationNo:row.registrationNo||'',
      name:row.name||'',
      scoreHeaders:['TOTAL SCORE'],
      scoreValues:[row.totalScore||''],
      included:row.included!==false
    }));
  }
  const excluded=new Set((Array.isArray(record?.fieldScoreReviewExcludedRows)?record.fieldScoreReviewExcludedRows:[]).map(Number).filter(Number.isInteger));
  const headers=Array.isArray(record?.scoreSheet?.scoreHeaders)&&record.scoreSheet.scoreHeaders.length
    ? record.scoreSheet.scoreHeaders.map(cellText)
    : [...spec.scoreHeaders];
  const out=[];
  (record?.scoreSheet?.rows||[]).forEach((row,sourceIndex)=>{
    const name=cellText(row?.name),registrationNo=cellText(row?.registrationNo);
    const scoreValues=Array.isArray(row?.scoreValues)?row.scoreValues.map(cellText):[];
    if(isScoreFooterValues([name,registrationNo,...scoreValues])) return;
    if(!Boolean(name||registrationNo||scoreValues.some(Boolean))) return;
    out.push({sourceIndex,originalSn:cellText(row?.originalSn),registrationNo,name,scoreHeaders:headers,scoreValues,included:!excluded.has(sourceIndex)});
  });
  return out;
}
function fieldValidScoreRows(record) {
  return fieldValidScoreRowsWithMeta(record).map(({sourceIndex,included,...row})=>row);
}
function approvedFieldExperienceScoreRows(record) {
  return fieldValidScoreRowsWithMeta(record).filter(row=>row.included!==false).map(({sourceIndex,included,...row})=>row);
}
function fieldClaimValidation(record) {
  const claimedCandidateCount=Number(record?.claimedCandidateCount||parseFlexiblePositiveCount(record?.groupCount)||0);
  const scoreRowCount=fieldValidScoreRows(record).length;
  const issues=[];
  if(!claimedCandidateCount)issues.push('The claimed candidate count is missing or invalid.');
  if(claimedCandidateCount!==scoreRowCount)issues.push(`The claimed candidate count (${claimedCandidateCount||0}) does not match the extracted score rows (${scoreRowCount}).`);
  return {claimedCandidateCount,scoreRowCount,valid:issues.length===0,issues};
}
function fieldAssessmentAoA(records, assessmentType) {
  const spec=fieldAssessmentSpec(assessmentType);
  if(!spec) return [['S/N','STUDY CENTRE','REGISTRATION','NAME OF STUDENT','SCORE']];
  const rows=[];const directory=studyCentreDirectoryMapSync();
  fieldExperienceRecords(records)
    .filter(record=>record.assessmentType===assessmentType&&projectReviewStatus(record)==='approved')
    .forEach(record=>{
      for(const row of approvedFieldExperienceScoreRows(record)) rows.push({...row,studyCentre:studyCentreInfoFromRegistration(row.registrationNo,directory).name});
    });
  rows.sort((a,b)=>String(a.studyCentre||'').localeCompare(String(b.studyCentre||''),undefined,{numeric:true,sensitivity:'base'})||compareRegistrationValues(a.registrationNo,b.registrationNo)||String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'}));
  const headers=['S/N','STUDY CENTRE','REGISTRATION','NAME OF STUDENT',...spec.scoreHeaders];
  return [headers,...rows.map((row,i)=>[i+1,row.studyCentre||'',row.registrationNo||'',row.name||'',...spec.scoreHeaders.map((_,idx)=>row.scoreValues?.[idx]||'')])];
}
function individualFieldScoreSheetAoA(record) {
  const spec=fieldAssessmentSpec(record?.assessmentType);
  if(!spec) return individualScoreSheetAoA(record);
  const rows=projectReviewStatus(record)==='approved'?approvedFieldExperienceScoreRows(record):fieldValidScoreRows(record);
  const headers=['S/N','REGISTRATION','NAME OF STUDENT',...spec.scoreHeaders];
  return [headers,...rows.map((row,i)=>[i+1,row.registrationNo||'',row.name||'',...spec.scoreHeaders.map((_,idx)=>row.scoreValues?.[idx]||'')])];
}
function fieldLegacyScoreSheetAoA(records) {
  const rows=[];const directory=studyCentreDirectoryMapSync();
  fieldExperienceRecords(records)
    .filter(record=>!fieldAssessmentSpec(record.assessmentType)&&projectReviewStatus(record)==='approved')
    .forEach(record=>{
      for(const row of validScoreRows(record)) {const centre=studyCentreInfoFromRegistration(row.registrationNo,directory);rows.push({'S/N':0,'STUDY CENTRE':centre.name,'NAME':row.name||'','REGISTRATION NO.':row.registrationNo||'','GROUP NO.':row.groupNo||'','TOTAL SCORE':row.totalScore||''});}
    });
  rows.sort((a,b)=>String(a['STUDY CENTRE']||'').localeCompare(String(b['STUDY CENTRE']||''),undefined,{numeric:true,sensitivity:'base'})||compareRegistrationValues(a['REGISTRATION NO.'],b['REGISTRATION NO.'])||String(a.NAME||'').localeCompare(String(b.NAME||''),undefined,{sensitivity:'base'}));
  return [PROJECT_EXPORT_HEADERS,...renumberScoreRows(rows).map(r=>PROJECT_EXPORT_HEADERS.map(h=>r[h]))];
}

function makeReference(prefix) {
  const d = new Date();
  const date = [d.getUTCFullYear(), String(d.getUTCMonth()+1).padStart(2,'0'), String(d.getUTCDate()).padStart(2,'0')].join('');
  return `${prefix}-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function safeBaseName(name) { return path.basename(name || 'file').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 140); }

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILES_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBaseName(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 80 } });
const SUPPORT_EVIDENCE_EXTENSIONS = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.csv','.png','.jpg','.jpeg','.webp','.txt']);
const supportUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => cb(null, SUPPORT_EVIDENCE_EXTENSIONS.has(path.extname(file.originalname || '').toLowerCase()))
});
const resourceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RESOURCES_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBaseName(file.originalname)}`)
});
const RESOURCE_EXTENSIONS = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.csv','.ppt','.pptx','.txt','.zip','.png','.jpg','.jpeg']);
const resourceUpload = multer({
  storage: resourceStorage,
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, RESOURCE_EXTENSIONS.has(ext));
  }
});
function filesFor(req, key) { return (req.files && req.files[key]) || []; }
async function removeUploaded(req) { await Promise.all(Object.values(req.files || {}).flat().map(f => fsp.unlink(f.path).catch(() => {}))); }
function fileRecord(f) { return f ? { storedName: path.basename(f.path), originalName: f.originalname, mimeType: f.mimetype, size: f.size } : null; }
function text(req, key) { return String(req.body[key] || '').trim(); }
function textList(req,key) {
  const raw=req.body?.[key];
  const source=Array.isArray(raw)?raw:[raw];
  return [...new Set(source.map(cleanHumanText).filter(Boolean))];
}
function requireText(req, fields) { return fields.find(k => !text(req, k)); }
function submitterName(req, prefix='') {
  const title = text(req, `${prefix}Title`);
  const firstName = text(req, `${prefix}FirstName`);
  const lastName = text(req, `${prefix}LastName`);
  return { title, firstName, lastName, fullName: buildDisplayName(title, firstName, lastName) };
}
function validateDepartment(req) {
  const slug = text(req, 'department');
  return departmentFromSlug(slug) ? slug : null;
}

async function saveRecord(record) {
  return mutateDb(records => { records.push(record); return record; });
}

const SUPPORT_CATEGORIES = Object.freeze({
  'incomplete-result': { label: 'Incomplete result', owner: 'Student Records Management Unit', support: 'Examinations Section', suggestedUnit: 'student-records', days: 10 },
  'fees-payment': { label: 'Fees or payment issue', owner: 'College Finance Officer', support: 'College Finance Officer', suggestedUnit: 'college-finance', days: 5 },
  'certificate': { label: 'Certificate issue', owner: 'College Registrar', support: 'Student Records Management Unit', suggestedUnit: 'college-registrar', days: 10 },
  'change-of-name': { label: 'Change of name', owner: 'College Registrar', support: 'Student Records Management Unit', suggestedUnit: 'college-registrar', days: 10 },
  'transcript': { label: 'Transcript request', owner: 'General Office', support: 'College Registrar / Student Records Management Unit', suggestedUnit: 'general-office', days: 10 },
  'deferment': { label: 'Request for deferment', owner: 'Student Support Services Unit', support: 'Student Support Services Unit', suggestedUnit: 'student-support', days: 10 },
  'resumption-deferment': { label: 'Request for resumption from deferment', owner: 'Student Support Services Unit', support: 'Student Support Services Unit', suggestedUnit: 'student-support', days: 10 },
  'resumption-rustication': { label: 'Request for resumption from rustication', owner: 'Student Support Services Unit', support: 'Student Support Services Unit', suggestedUnit: 'student-support', days: 10 },
  'registration-challenge': { label: 'Registration challenges', owner: 'Registration Officer Portal', support: 'Student Records Management Unit / College Registrar', suggestedUnit: 'registration-officer', days: 5 },
  'change-study-centre': { label: 'Change of study centre', owner: 'Student Support Services Unit', support: 'Student Support Services Unit', suggestedUnit: 'student-support', days: 10 },
  'centre-transit': { label: 'Transit between centres', owner: 'Student Support Services Unit', support: 'Student Support Services Unit', suggestedUnit: 'student-support', days: 10 },
  'programme-department': { label: 'Programme or departmental issue', owner: 'Academic Departments', support: 'Director / College Registrar', suggestedUnit: 'academic-departments', days: 10 },
  'assessment-project': { label: 'Assessment or project-work issue', owner: 'Academic Departments', support: 'Examinations / Student Records Management Unit', suggestedUnit: 'academic-departments', days: 10 },
  'general': { label: 'General or unclassified complaint', owner: 'Student Support Services', support: 'Responsible unit after screening', days: 10 },
  'sensitive': { label: 'Sensitive complaint', owner: 'Confidential Handler', support: 'Provost or designated authority', days: 2 }
});
const SUPPORT_CATEGORY_GUIDANCE = Object.freeze({
  'incomplete-result': { evidence: 'Result slip, course code, academic year, semester and earlier correspondence.', before: 'Confirm the course code and check that the published correction period has passed.' },
  'fees-payment': { evidence: 'Payment receipt, transaction reference, date, amount and student-account screenshot.', before: 'Check that the transaction reference and amount match the student account.' },
  certificate: { evidence: 'Completion details, graduation year and earlier certificate correspondence.', before: 'Confirm the programme name, completion year and collection or delivery method.' },
  'change-of-name': { evidence: 'Approved identity documents and the formal name-change record.', before: 'Use the exact current and requested names and prepare the authorised supporting record.' },
  transcript: { evidence: 'Application receipt, payment reference, application date and intended destination.', before: 'Confirm the destination address and whether the request is electronic or physical.' },
  deferment: { evidence: 'Student number, programme, requested deferment period, reason and relevant supporting documents.', before: 'State the academic year and semester from which the deferment should take effect.' },
  'resumption-deferment': { evidence: 'Approved deferment letter or reference, programme, deferred period and proposed resumption semester.', before: 'Confirm that the approved deferment period has ended and state the academic period for resumption.' },
  'resumption-rustication': { evidence: 'Rustication decision or reference, stated end date, evidence of compliance and proposed resumption semester.', before: 'Confirm that the rustication period and any stated conditions have been completed.' },
  'registration-challenge': { evidence: 'Course codes, academic year, semester, registration screenshots, error message and any payment or clearance evidence.', before: 'List every affected course code and copy the exact message shown during registration.' },
  'change-study-centre': { evidence: 'Current centre, proposed centre and reason for the request.', before: 'Confirm both centre names and the semester from which the change should apply.' },
  'centre-transit': { evidence: 'Current centre, temporary centre, dates and coordinator confirmation.', before: 'Confirm the start and end dates of the temporary transit.' },
  'programme-department': { evidence: 'Programme, course details and relevant departmental correspondence.', before: 'Identify the programme, department and specific academic action required.' },
  'assessment-project': { evidence: 'Course code, assessment or project details, dates and relevant correspondence.', before: 'Identify the assessment, academic period and responsible department.' },
  sensitive: { evidence: 'Only evidence necessary for the confidential handler. Never include passwords or payment-card details.', before: 'Use a private device where possible and avoid naming unrelated people.' },
  general: { evidence: 'Receipts, screenshots, messages, incident references or instructions that explain the matter.', before: 'Search existing open tickets and use the closest category if one applies.' }
});
const SUPPORT_PRIORITIES = Object.freeze({
  low: { label: 'Low' },
  normal: { label: 'Normal' },
  high: { label: 'High' },
  urgent: { label: 'Urgent' }
});
const SUPPORT_STUDY_LEVELS = Object.freeze({
  undergraduate: 'Undergraduate',
  postgraduate: 'Postgraduate',
  'certificate-microcredential': 'Certificate / Microcredential',
  other: 'Other CoDE learner'
});

function supportReference() { return makeReference('CAS'); }
function supportDateFromHours(hours) { return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(); }
function supportDateKey(value) { return new Date(value).toISOString().slice(0, 10); }
function supportIsWorkingDay(value) {
  const date = new Date(value);
  const day = date.getUTCDay();
  return day !== 0 && day !== 6 && !SUPPORT_HOLIDAYS.has(supportDateKey(date));
}
function supportMoveWorkingDays(value, count) {
  const date = new Date(value);
  const direction = count < 0 ? -1 : 1;
  let remaining = Math.abs(Number(count) || 0);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    if (supportIsWorkingDay(date)) remaining -= 1;
  }
  return date.toISOString();
}
function supportWorkingDaysBetween(fromValue, toValue) {
  const cursor = new Date(fromValue);
  const end = new Date(toValue).getTime();
  let days = 0;
  let guard = 0;
  while (cursor.getTime() < end && guard < 370) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (supportIsWorkingDay(cursor)) days += 1;
    guard += 1;
  }
  return Math.max(1, days);
}
function supportElapsedWorkingDays(fromValue, toValue = new Date()) {
  const cursor = new Date(fromValue);
  const end = new Date(toValue).getTime();
  let days = 0;
  let guard = 0;
  while (cursor.getTime() < end && guard < 370) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getTime() <= end && supportIsWorkingDay(cursor)) days += 1;
    guard += 1;
  }
  return days;
}
function supportDueDays(categoryKey, priorityKey, sensitive = false) {
  if (sensitive || categoryKey === 'sensitive') return 2;
  const categoryDays = SUPPORT_CATEGORIES[categoryKey]?.days || 10;
  if (priorityKey === 'urgent') return Math.min(categoryDays, 2);
  if (priorityKey === 'high') return Math.min(categoryDays, 5);
  if (priorityKey === 'low') return categoryDays + 2;
  return categoryDays;
}
function supportSlaSummary(ticket) {
  const now = Date.now();
  const due = ticket.dueAt ? new Date(ticket.dueAt).getTime() : 0;
  const warningAt = due ? new Date(supportMoveWorkingDays(ticket.dueAt, -1)).getTime() : 0;
  const closed = ['resolved','final-decision','closed','accepted'].includes(ticket.status);
  return {
    paused: Boolean(ticket.slaPausedAt),
    overdue: Boolean(!closed && !ticket.slaPausedAt && due && due < now),
    atRisk: Boolean(!closed && !ticket.slaPausedAt && due && due >= now && warningAt <= now),
    firstResponseAt: ticket.firstResponseAt || null,
    assignmentDueAt: ticket.assignmentDueAt || null,
    resolutionDueAt: ticket.dueAt || null,
    pausedAt: ticket.slaPausedAt || null,
    pauseReason: ticket.slaPauseReason || ''
  };
}
function supportPauseSla(ticket, reason) {
  if (ticket.slaPausedAt) return;
  ticket.slaPausedAt = new Date().toISOString();
  ticket.slaPauseReason = reason || 'Awaiting student information';
  ticket.slaRemainingDays = ticket.dueAt ? supportWorkingDaysBetween(new Date(), ticket.dueAt) : 1;
}
function supportResumeSla(ticket) {
  if (!ticket.slaPausedAt) return;
  ticket.dueAt = supportMoveWorkingDays(new Date(), Math.max(1, Number(ticket.slaRemainingDays) || 1));
  ticket.slaPausedAt = null;
  ticket.slaPauseReason = '';
  ticket.slaRemainingDays = null;
}
function supportStatusToken(ticket) {
  const payload = Buffer.from(JSON.stringify({ reference: ticket.reference, email: ticket.email }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', SUPPORT_STATUS_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function supportStatusIdentity(token) {
  try {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', SUPPORT_STATUS_TOKEN_SECRET).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed?.reference && parsed?.email ? parsed : null;
  } catch { return null; }
}
const SUPPORT_ASSIGNMENT_CHECKS = Object.freeze([
  { id:'reviewed', label:'I have reviewed the complaint or request and all available evidence.' },
  { id:'actionCompleted', label:'I have completed the action required from my functional unit.' },
  { id:'resolutionRecorded', label:'I have recorded a clear resolution for the student and oversight units.' }
]);
function supportAssignmentState(assignment) {
  if (!assignment) return { key:'unassigned', label:'Not assigned to staff', colour:'red' };
  if (assignment.state === 'resolved') return { key:'resolved', label:'Resolved by assigned staff', colour:'green' };
  if (assignment.state === 'opened') return { key:'opened', label:'Opened by assigned staff', colour:'yellow' };
  return { key:'unopened', label:'Assigned, not yet opened', colour:'red' };
}
function supportAssignmentSummary(ticket, unitIds = []) {
  const allowed = new Set(normalizeStaffUnits(unitIds));
  const assignments = (Array.isArray(ticket?.staffAssignments) ? ticket.staffAssignments : [])
    .filter(item => item.state !== 'superseded' && (!allowed.size || allowed.has(item.unitId)))
    .sort((a,b) => String(b.assignedAt || '').localeCompare(String(a.assignedAt || '')));
  const assignment = assignments[0] || null;
  const state = supportAssignmentState(assignment);
  return { ...state, id:assignment?.id || '', unitId:assignment?.unitId || '', unitLabel:assignment?.unitLabel || '', officerName:assignment?.officerName || '', officerEmail:assignment?.officerEmail || '', assignedAt:assignment?.assignedAt || null, openedAt:assignment?.openedAt || null, resolvedAt:assignment?.resolvedAt || null, emailStatus:assignment?.emailStatus || '', resolutionNote:assignment?.resolutionNote || '' };
}
function supportAssignmentList(ticket) {
  return (Array.isArray(ticket?.staffAssignments)?ticket.staffAssignments:[]).filter(item=>item.state!=='superseded').map(item=>({id:item.id,unitId:item.unitId,unitLabel:item.unitLabel,officerName:item.officerName,officerEmail:item.officerEmail,assignedBy:item.assignedBy,assignedAt:item.assignedAt,expiresAt:item.expiresAt,state:supportAssignmentState(item),openedAt:item.openedAt||null,resolvedAt:item.resolvedAt||null,emailStatus:item.emailStatus||'',resolutionNote:item.resolutionNote||''}));
}
function supportAssignmentForToken(tickets, token) {
  const tokenHash = hashOneTimeToken(token);
  for (const ticket of tickets) {
    const assignment = (ticket.staffAssignments || []).find(item => item.tokenHash === tokenHash);
    if (assignment) return { ticket, assignment };
  }
  return null;
}
function supportPublicTicket(ticket) {
  const responseDeadline = ticket.studentResponseDueAt ? new Date(ticket.studentResponseDueAt).getTime() : 0;
  const staffAssignment=supportAssignmentSummary(ticket,[ticket.ownerUnitId]);
  return {
    reference: ticket.reference,
    type: ticket.type,
    category: ticket.categoryLabel,
    priority: ticket.priorityLabel,
    subject: ticket.subject,
    studyLevel: ticket.studyLevelLabel || '',
    status: ticket.status,
    ownerUnit: ticket.ownerUnit,
    createdAt: ticket.createdAt,
    acknowledgedAt: ticket.acknowledgedAt,
    dueAt: ticket.dueAt,
    lastUpdatedAt: ticket.lastUpdatedAt,
    studentResponseDueAt: ticket.studentResponseDueAt || null,
    resolution: ['resolved','closed','final-decision','accepted'].includes(ticket.status) ? ticket.resolution || '' : '',
    evidenceCount: Array.isArray(ticket.evidence) ? ticket.evidence.length : 0,
    needsEvidence: ['evidence-requested','lacks-evidence'].includes(ticket.status),
    canAccept: ['resolved','final-decision'].includes(ticket.status),
    canReopen: ['resolved','final-decision','closed'].includes(ticket.status) && (!responseDeadline || responseDeadline > Date.now()),
    canAppeal: ['resolved','final-decision','closed'].includes(ticket.status),
    canRespond: !['accepted','closed','resolved','final-decision'].includes(ticket.status),
    canGiveFeedback: ['accepted','closed'].includes(ticket.status) && !ticket.feedback,
    feedbackSubmitted: Boolean(ticket.feedback),
    language: ticket.language || 'en',
    notificationPreference: ticket.notificationPreference || 'email',
    staffAssignment:{key:staffAssignment.key,label:staffAssignment.label,colour:staffAssignment.colour,unitLabel:staffAssignment.unitLabel,openedAt:staffAssignment.openedAt,resolvedAt:staffAssignment.resolvedAt},
    sla: supportSlaSummary(ticket),
    updates: (ticket.studentUpdates || []).slice(-12)
  };
}
function supportTicketPayload(req) {
  const type = ['complaint', 'service-request'].includes(String(req.body?.type || '').trim())
    ? String(req.body.type).trim() : 'complaint';
  const categoryKey = String(req.body?.category || '').trim();
  const category = SUPPORT_CATEGORIES[categoryKey] || SUPPORT_CATEGORIES.general;
  const priorityKey = Object.prototype.hasOwnProperty.call(SUPPORT_PRIORITIES, String(req.body?.priority || '').trim())
    ? String(req.body.priority).trim() : 'normal';
  const priority = SUPPORT_PRIORITIES[priorityKey];
  const name = cleanHumanText(req.body?.name).slice(0, 160);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const subject = cleanHumanText(req.body?.subject).slice(0, 220);
  const description = String(req.body?.description || '').trim().slice(0, 10000);
  const studyCentre = cleanHumanText(req.body?.studyCentre).slice(0, 180);
  const studentNumber = cleanHumanText(req.body?.studentNumber).slice(0, 100);
  const phone = cleanHumanText(req.body?.phone).slice(0, 40);
  const language = Object.prototype.hasOwnProperty.call(SUPPORT_LANGUAGES, String(req.body?.language || '').trim()) ? String(req.body.language).trim() : 'en';
  const notificationPreference = ['email','email-sms','email-whatsapp'].includes(String(req.body?.notificationPreference || '').trim()) ? String(req.body.notificationPreference).trim() : 'email';
  const programme = cleanHumanText(req.body?.programme).slice(0, 180);
  const academicDepartment = ['education','business','arts-social-sciences','science-mathematics'].includes(String(req.body?.academicDepartment || '').trim()) ? String(req.body.academicDepartment).trim() : '';
  const studyLevelKey = Object.prototype.hasOwnProperty.call(SUPPORT_STUDY_LEVELS, String(req.body?.studyLevel || '').trim())
    ? String(req.body.studyLevel).trim() : 'other';
  const sensitive = categoryKey === 'sensitive' || String(req.body?.sensitive || '') === 'true';
  return { type, categoryKey, category, priorityKey, priority, name, email, subject, description, studyCentre, studentNumber, phone, language, notificationPreference, programme, academicDepartment, studyLevelKey, studyLevelLabel: SUPPORT_STUDY_LEVELS[studyLevelKey], sensitive };
}
function supportNormaliseMobile(value) {
  const raw = String(value || '').trim().replace(/^whatsapp:/i, '');
  if (!raw) return '';
  const compact = raw.replace(/[\s().-]/g, '');
  const candidate = compact.startsWith('+') ? compact : compact.startsWith('0') && compact.length === 10 ? `+233${compact.slice(1)}` : compact.startsWith('233') ? `+${compact}` : `+${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : '';
}
function supportMobileChannelConfigured(channel) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return false;
  return channel === 'sms' ? SUPPORT_SMS_ENABLED && Boolean(TWILIO_SMS_FROM) : channel === 'whatsapp' ? SUPPORT_WHATSAPP_ENABLED && Boolean(TWILIO_WHATSAPP_FROM) : false;
}
function supportMobileChannels(ticket) {
  if (ticket.notificationPreference === 'email-sms') return ['sms'];
  if (ticket.notificationPreference === 'email-whatsapp') return ['whatsapp'];
  return [];
}
function supportNotificationText(ticket, kind, statusUrl) {
  const reference = ticket.reference;
  const status = SUPPORT_STATUS_LABELS[ticket.status] || ticket.status;
  const language = ticket.language || 'en';
  const messages = {
    en: {
      acknowledgement:`CoDE: Ticket ${reference} has been received. Track it at ${statusUrl}`,
      reminder:`CoDE: Information is still required for ticket ${reference}. Respond at ${statusUrl}`,
      update:`CoDE: Ticket ${reference} is now ${status}. View or respond at ${statusUrl}`
    },
    tw: {
      acknowledgement:`CoDE: Yɛagye wo asɛm ${reference}. Hwɛ ne tebea wɔ ${statusUrl}`,
      reminder:`CoDE: Yɛda so hia nsɛm ma ${reference}. Fa mmuae no kɔ ${statusUrl}`,
      update:`CoDE: Wɔayɛ ${reference} ho nsakrae. Hwɛ wɔ ${statusUrl}`
    },
    fr: {
      acknowledgement:`CoDE : dossier ${reference} reçu. Suivi : ${statusUrl}`,
      reminder:`CoDE : informations requises pour ${reference}. Répondez : ${statusUrl}`,
      update:`CoDE : dossier ${reference}, statut ${status}. Consultez : ${statusUrl}`
    }
  };
  return (messages[language] || messages.en)[kind] || messages.en.update;
}
async function sendTwilioSupportMessage(channel, phone, body) {
  if (!supportMobileChannelConfigured(channel)) throw new Error(`${channel === 'sms' ? 'SMS' : 'WhatsApp'} notifications are not configured.`);
  const mobile = supportNormaliseMobile(phone);
  if (!mobile) throw new Error('A valid international mobile number is required.');
  const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';
  const from = channel === 'whatsapp' ? TWILIO_WHATSAPP_FROM : TWILIO_SMS_FROM;
  const fromAddress = channel === 'whatsapp' ? supportNormaliseMobile(from) : (supportNormaliseMobile(from) || String(from).trim());
  if (!fromAddress) throw new Error('The sender address is not configured.');
  const form = new URLSearchParams({ To:`${prefix}${mobile}`, From:`${prefix}${fromAddress}`, Body:String(body || '').slice(0, 1400) });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method:'POST', headers:{ authorization:`Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type':'application/x-www-form-urlencoded' }, body:form
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(result.message || `Twilio returned ${response.status}`).slice(0, 300));
  return result.sid || '';
}
async function dispatchSupportStudentNotification(ticket, { kind='update', subject, html, req }) {
  const baseUrl = req ? baseUrlFor(req) : PUBLIC_BASE_URL;
  const statusUrl = baseUrl ? `${baseUrl}/support-track.html?token=${encodeURIComponent(supportStatusToken(ticket))}` : '';
  const operations = [];
  if (gmailConfigured() && isEmail(ticket.email)) operations.push({ channel:'email', send:() => sendGmailHtmlEmail({ to:ticket.email, subject, html }) });
  for (const channel of supportMobileChannels(ticket)) {
    if (supportMobileChannelConfigured(channel)) operations.push({ channel, send:() => sendTwilioSupportMessage(channel, ticket.phone, supportNotificationText(ticket, kind, statusUrl)) });
  }
  if (!operations.length) return;
  const results = await Promise.allSettled(operations.map(operation => operation.send()));
  const at = new Date().toISOString();
  await mutateSupportTickets(tickets => {
    const stored = tickets.find(item => item.id === ticket.id);
    if (!stored) return tickets;
    stored.notificationHistory = Array.isArray(stored.notificationHistory) ? stored.notificationHistory : [];
    results.forEach((result, index) => stored.notificationHistory.push({ type:kind, channel:operations[index].channel, status:result.status === 'fulfilled' ? 'sent' : 'failed', providerMessageId:result.status === 'fulfilled' ? String(result.value?.id || result.value || '') : '', error:result.status === 'rejected' ? String(result.reason?.message || result.reason || 'Delivery failed').slice(0, 300) : '', at }));
    if (stored.notificationHistory.length > 100) stored.notificationHistory = stored.notificationHistory.slice(-100);
    return tickets;
  });
  const failure = results.find(result => result.status === 'rejected');
  if (failure && results.every(result => result.status === 'rejected')) throw failure.reason;
}
async function sendSupportAcknowledgementEmail(ticket, req) {
  const statusUrl = `${baseUrlFor(req)}/support-track.html?token=${encodeURIComponent(supportStatusToken(ticket))}`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">CoDE Academic Services Portal acknowledgement</h2><p>Dear ${htmlEscape(ticket.name || 'Student')},</p><p>Your ${ticket.type === 'service-request' ? 'service request' : 'complaint'} has been received by Student Support Services.</p><div style="margin:18px 0;padding:16px;background:#f5f8fb;border-left:4px solid #d4a72c"><strong>Reference:</strong> ${htmlEscape(ticket.reference)}<br><strong>Category:</strong> ${htmlEscape(ticket.categoryLabel)}<br><strong>Responsible unit:</strong> ${htmlEscape(ticket.ownerUnit)}<br><strong>Target response:</strong> ${htmlEscape(new Date(ticket.dueAt).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'}))} UTC</div><p><a href="${htmlEscape(statusUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Track this ticket</a></p><p>Please quote the reference in any follow-up communication.</p><p>Regards,<br>Student Support Services<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  await dispatchSupportStudentNotification(ticket, { kind:'acknowledgement', subject:`Support ticket received - ${ticket.reference}`, html, req });
}
async function sendSupportStudentUpdateEmail(ticket, update, req) {
  const statusUrl = `${baseUrlFor(req)}/support-track.html?token=${encodeURIComponent(supportStatusToken(ticket))}`;
  const final = ['resolved','closed','final-decision'].includes(ticket.status);
  const subject = final ? `Final decision on your support ticket - ${ticket.reference}` : `Update on your support ticket - ${ticket.reference}`;
  const heading = final ? 'Final decision recorded' : 'Your support ticket has been updated';
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">${heading}</h2><p>Dear ${htmlEscape(ticket.name || 'Student')},</p><p>Student Support Services has updated your ${ticket.type === 'service-request' ? 'service request' : 'complaint'}.</p><div style="margin:18px 0;padding:16px;background:#f5f8fb;border-left:4px solid #d4a72c"><strong>Reference:</strong> ${htmlEscape(ticket.reference)}<br><strong>Current stage:</strong> ${htmlEscape(SUPPORT_STATUS_LABELS[ticket.status] || ticket.status)}<br><strong>Responsible unit:</strong> ${htmlEscape(ticket.ownerUnit)}</div><p><strong>Update</strong><br>${htmlEscape(update.message || update.label || 'Your case has been updated.').replace(/\n/g,'<br>')}</p><p><a href="${htmlEscape(statusUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Track your case or respond</a></p><p>${final?'This is the final decision recorded for this case. You may use the tracking page if you need to review the decision or submit an authorised reopening request.':'Please use the tracking page to review the update. If more evidence is requested, upload it there.'}</p><p>Regards,<br>Student Support Services<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
  await dispatchSupportStudentNotification(ticket, { kind:'update', subject, html, req });
}
async function sendSupportRegistrationEmails(ticket, req) {
  if (!gmailConfigured()) return;
  const unitIds = ticket.sensitive
    ? [ticket.ownerUnitId]
    : [...new Set(['student-support', ticket.ownerUnitId].filter(unit => STAFF_UNITS[unit]))];
  for (const unitId of unitIds) {
    const recipients = (await supportUnitNotificationRecipients(unitId)).filter(email => supportEmailsAreInstitutional([email]));
    if (!recipients.length) continue;
    const unitLabel = STAFF_UNITS[unitId].label;
    const portalPath = unitId === 'student-support' ? '/support-admin' : '/staff';
    const portalUrl = `${baseUrlFor(req)}${portalPath}`;
    const roleText = unitId === ticket.ownerUnitId ? 'responsible functional unit' : 'Student Support oversight unit';
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">New complaint or service request registered</h2><p>A student matter has been registered with <strong>${htmlEscape(unitLabel)}</strong> as the ${htmlEscape(roleText)}.</p><div style="margin:18px 0;padding:16px;background:#f5f8fb;border-left:4px solid #d4a72c"><strong>Reference:</strong> ${htmlEscape(ticket.reference)}<br><strong>Type:</strong> ${htmlEscape(ticket.type === 'service-request' ? 'Service request' : 'Complaint')}<br><strong>Category:</strong> ${htmlEscape(ticket.categoryLabel)}<br><strong>Subject:</strong> ${htmlEscape(ticket.subject)}</div><p><a href="${htmlEscape(portalUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Open unit register</a></p><p>The unit administrator should assign the matter to a staff email. The assignment remains red until the staff member opens the secure link, changes to yellow when opened, and changes to green when the resolution checklist is completed.</p><p>Regards,<br>Student Support Services<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
    await Promise.all(recipients.map(to => sendGmailHtmlEmail({to,subject:`New ${ticket.type === 'service-request' ? 'service request' : 'complaint'} registered - ${ticket.reference}`,html})));
  }
}

const supportRateBuckets = new Map();
function supportRateLimit(limit, windowMs = 60 * 60 * 1000) {
  return (req, res, next) => {
    const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.path.split('/').slice(0, 4).join('/')}`;
    const now = Date.now();
    const current = supportRateBuckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    supportRateBuckets.set(key, bucket);
    if (bucket.count > limit) return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    next();
  };
}
function supportSameOrigin(req, res, next) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch {}
  return res.status(403).json({ error: 'This request could not be verified.' });
}
function supportTicketCredentials(req, reference) {
  const tokenIdentity = supportStatusIdentity(req.body?.accessToken || req.query?.token);
  if (tokenIdentity && tokenIdentity.reference.toUpperCase() === String(reference || '').toUpperCase()) return tokenIdentity;
  const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
  return isEmail(email) ? { reference, email } : null;
}

// 1A. STUDENT SUPPORT SERVICES AND CENTRE COORDINATOR TICKETS
app.use('/api/support/tickets', supportSameOrigin);
app.get('/api/support/config', async (_req, res) => {
  const directory = (await readStudyCentreDirectory()).filter(centre => centre.enabled !== false).map(centre => centre.name).filter(Boolean).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'}));
  const units = Object.entries(STAFF_UNITS).filter(([id]) => !['payroll','auditor'].includes(id)).map(([id, unit]) => ({ id, label: unit.label }));
  const categories = Object.entries(SUPPORT_CATEGORIES).map(([id, category]) => ({ id, label: category.label, suggestedUnit: category.suggestedUnit || 'student-support', responsibleUnit: category.owner, workingDays: category.days, evidenceGuidance: SUPPORT_CATEGORY_GUIDANCE[id]?.evidence || SUPPORT_CATEGORY_GUIDANCE.general.evidence, beforeSubmitting: SUPPORT_CATEGORY_GUIDANCE[id]?.before || SUPPORT_CATEGORY_GUIDANCE.general.before }));
  const departments = Object.entries(DEPARTMENTS).map(([id, department]) => ({ id, label: department.name }));
  const notificationChannels = [
    { id:'email', label:'Email only', available:true },
    { id:'email-sms', label:'Email and SMS', available:supportMobileChannelConfigured('sms') },
    { id:'email-whatsapp', label:'Email and WhatsApp', available:supportMobileChannelConfigured('whatsapp') }
  ];
  const languages = Object.entries(SUPPORT_LANGUAGES).map(([id, label]) => ({ id, label }));
  res.json({ ok: true, units, categories, departments, studyCentres: [...new Set(directory)], languages, notificationChannels });
});
app.get('/centre-coordinators.html', staffAuth, (req, res) => {
  const units = normalizeStaffUnits(req.staffIdentity?.units);
  if (!units.some(unit => ['coordinator','regional-administrator'].includes(unit)) || (ROLE_RANK[req.staffIdentity?.role] || 0) < ROLE_RANK.officer) return res.status(403).send('Centre Coordinator or Regional Administrator officer access is required.');
  return res.sendFile(path.join(__dirname, 'public', 'centre-coordinators.html'));
});
app.post('/api/support/tickets', supportRateLimit(12), supportUpload.array('evidenceFiles', 10), async (req, res) => {
  try {
    const payload = supportTicketPayload(req);
    if (String(req.body?.website || '').trim()) { await removeUploaded(req).catch(() => {}); return res.status(400).json({ error: 'The submission could not be verified.' }); }
    if (!payload.name || !payload.email || !payload.subject || !payload.description) {
      return res.status(400).json({ error: 'Name, email, subject and description are required.' });
    }
    if (!isEmail(payload.email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const requestedMobile = payload.notificationPreference === 'email-sms' ? 'sms' : payload.notificationPreference === 'email-whatsapp' ? 'whatsapp' : '';
    if (requestedMobile && !supportMobileChannelConfigured(requestedMobile)) return res.status(400).json({ error: `${requestedMobile === 'sms' ? 'SMS' : 'WhatsApp'} notifications are not available. Choose email notifications.` });
    if (requestedMobile && !supportNormaliseMobile(payload.phone)) return res.status(400).json({ error: 'Enter a valid mobile number for SMS or WhatsApp notifications.' });
    if (payload.description.length < 20) return res.status(400).json({ error: 'Please provide at least 20 characters describing the matter.' });
    const now = new Date().toISOString();
    const duplicate = (await readSupportTickets()).find(item =>
      item.email.toLowerCase() === payload.email.toLowerCase() &&
      item.categoryKey === (payload.categoryKey || 'general') &&
      String(item.subject || '').trim().toLowerCase() === payload.subject.trim().toLowerCase() &&
      !['accepted','closed'].includes(item.status) &&
      Date.now() - new Date(item.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000
    );
    if (duplicate) {
      await removeUploaded(req).catch(() => {});
      return res.status(409).json({ error: `This appears to duplicate open ticket ${duplicate.reference}. Track that ticket or reply to it instead.` });
    }
    const submittingStaff = staffSessionIdentity(req);
    const submittingUnits = normalizeStaffUnits(submittingStaff?.units);
    const assisted = submittingUnits.some(unit => ['coordinator','regional-administrator'].includes(unit));
    const responsibleUnitId = payload.sensitive ? 'confidential-handler' : (payload.category.suggestedUnit || 'student-support');
    const responsibleUnitLabel = STAFF_UNITS[responsibleUnitId]?.label || STAFF_UNITS['student-support'].label;
    const supportRegistration = { id:crypto.randomUUID(), sourceUnit:'student', sourceLabel:'Student submission', targetUnit:'student-support', targetLabel:STAFF_UNITS['student-support'].label, comment:'Automatically registered with Student Support Services for acknowledgement, monitoring and follow-up.', status:responsibleUnitId==='student-support'?'assigned':'oversight', origin:'automatic-dual-registration', createdAt:now, reassignmentHistory:[] };
    const responsibleRegistration = responsibleUnitId === 'student-support' ? null : { id:crypto.randomUUID(), sourceUnit:'student-support', sourceLabel:STAFF_UNITS['student-support'].label, targetUnit:responsibleUnitId, targetLabel:responsibleUnitLabel, comment:'Automatically routed from the selected complaint or service-request category.', status:'assigned', origin:'automatic-category-routing', createdAt:now, reassignmentHistory:[] };
    const ticket = {
      id: crypto.randomUUID(), reference: supportReference(), type: payload.type,
      categoryKey: payload.categoryKey || 'general', categoryLabel: payload.category.label,
      priorityKey: payload.priorityKey, priorityLabel: payload.priority.label,
      name: payload.name, email: payload.email, phone: payload.phone, language: payload.language, notificationPreference: payload.notificationPreference,
      studentNumber: payload.studentNumber, studyCentre: payload.studyCentre,
      programme: payload.programme, academicDepartment: payload.academicDepartment,
      studyLevel: payload.studyLevelKey, studyLevelLabel: payload.studyLevelLabel,
      subject: payload.subject, description: payload.description,
      evidence: Array.isArray(req.files) ? req.files.map(fileRecord) : [],
      sensitive: payload.sensitive, confidentiality: payload.sensitive ? 'restricted' : 'standard', originRole: assisted ? (submittingUnits.includes('coordinator') ? 'centre-coordinator' : 'regional-administrator') : 'student', submittedBy: assisted ? (submittingStaff.name || submittingStaff.username || 'Authorised staff') : payload.name,
      ownerUnit: responsibleUnitLabel,
      ownerUnitId: responsibleUnitId, intendedUnit: responsibleUnitLabel, supportUnit: STAFF_UNITS['student-support'].label, supportFollowUp:true,
      status: responsibleUnitId === 'student-support' ? 'received' : 'assigned', resolution: '', createdAt: now, acknowledgedAt: now,
      lastUpdatedAt: now, assignmentDueAt: supportMoveWorkingDays(now, 2), dueAt: supportMoveWorkingDays(now, supportDueDays(payload.categoryKey, payload.priorityKey, payload.sensitive)),
      auditTrail: [{ action: `Ticket registered with ${STAFF_UNITS['student-support'].label} and ${responsibleUnitLabel}`, note:'Automatic dual registration from the student submission category.', at:now, by:assisted?(submittingStaff.name||submittingStaff.username||'Authorised staff'):'Student' }],
      studentUpdates: [{ label:'Ticket registered', message:responsibleUnitId==='student-support'?'Your matter has been registered with Student Support Services.':`Your matter has been registered with ${responsibleUnitLabel}, while Student Support Services monitors the same reference for follow-up.`, at:now }],
      officerEvidence: [], referrals: [supportRegistration, ...(responsibleRegistration?[responsibleRegistration]:[])], registrations:[{unitId:'student-support',unitLabel:STAFF_UNITS['student-support'].label,role:responsibleUnitId==='student-support'?'responsible':'oversight',registeredAt:now},{unitId:responsibleUnitId,unitLabel:responsibleUnitLabel,role:'responsible',registeredAt:now}].filter((item,index,list)=>list.findIndex(other=>other.unitId===item.unitId)===index), staffAssignments:[], interUnitMessages: []
    };
    await mutateSupportTickets(tickets => { tickets.push(ticket); return ticket; });
    sendSupportAcknowledgementEmail(ticket, req).catch(error => console.error('Support acknowledgement email failed:', error.message));
    sendSupportRegistrationEmails(ticket, req).catch(error => console.error('Support unit registration email failed:', error.message));
    res.status(201).json({ ok: true, ticket: supportPublicTicket(ticket), emailNotice: isEmail(ticket.email) && gmailConfigured() ? 'An acknowledgement email is being sent.' : 'Save the reference number to track this ticket.' });
  } catch (error) {
    console.error('Support ticket creation failed:', error);
    await removeUploaded(req).catch(() => {});
    res.status(500).json({ error: 'The support ticket could not be created.' });
  }
});

app.get('/api/support/tickets/access/:token', supportRateLimit(40), async (req, res) => {
  const identity = supportStatusIdentity(req.params.token);
  if (!identity) return res.status(401).json({ error: 'This tracking link is invalid.' });
  const ticket = (await readSupportTickets()).find(item => item.reference.toUpperCase() === identity.reference.toUpperCase() && item.email.toLowerCase() === identity.email.toLowerCase());
  if (!ticket) return res.status(404).json({ error: 'This ticket is no longer available.' });
  res.json({ ok: true, ticket: supportPublicTicket(ticket), accessToken: req.params.token });
});
app.post('/api/support/tickets/lookup', supportRateLimit(40), async (req, res) => {
  const reference = String(req.body?.reference || '').trim().toUpperCase();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!reference || !isEmail(email)) return res.status(400).json({ error: 'Enter the ticket reference and the email used to submit it.' });
  const ticket = (await readSupportTickets()).find(item => item.reference.toUpperCase() === reference && item.email.toLowerCase() === email);
  if (!ticket) return res.status(404).json({ error: 'No ticket was found with that reference and email combination.' });
  res.json({ ok: true, ticket: supportPublicTicket(ticket) });
});
app.get('/api/support/tickets/:reference', supportRateLimit(40), async (req, res) => {
  const reference = String(req.params.reference || '').trim().toUpperCase();
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!reference || !isEmail(email)) return res.status(400).json({ error: 'Enter the ticket reference and the email used to submit it.' });
  const ticket = (await readSupportTickets()).find(item => item.reference.toUpperCase() === reference && item.email.toLowerCase() === email);
  if (!ticket) return res.status(404).json({ error: 'No ticket was found with that reference and email combination.' });
  res.json({ ok: true, ticket: supportPublicTicket(ticket) });
});
app.post('/api/support/tickets/:reference/evidence', supportRateLimit(20), supportUpload.array('evidenceFiles', 10), async (req,res)=>{
  try {
    const reference=String(req.params.reference||'').trim().toUpperCase();
    const credentials=supportTicketCredentials(req, reference);
    const email=String(credentials?.email||'').trim().toLowerCase();
    const note=String(req.body?.note||'').trim().slice(0,2000);
    if(!reference||!isEmail(email)) { await removeUploaded(req).catch(()=>{}); return res.status(400).json({error:'Enter the ticket reference and the email used to submit it.'}); }
    if(!Array.isArray(req.files)||!req.files.length) return res.status(400).json({error:'Attach at least one evidence file.'});
    let updated=null;
    await mutateSupportTickets(tickets=>{
      const ticket=tickets.find(item=>item.reference.toUpperCase()===reference&&item.email.toLowerCase()===email);
      if(!ticket) return null;
      if(!['evidence-requested','lacks-evidence','awaiting-student'].includes(ticket.status)) { updated='not-requested'; return ticket; }
      const now=new Date().toISOString();
      supportResumeSla(ticket);
      ticket.evidence=Array.isArray(ticket.evidence)?ticket.evidence:[];
      ticket.evidence.push(...req.files.map(file=>({...fileRecord(file),source:'student-follow-up',uploadedAt:now,note})));
      ticket.status='in-progress'; ticket.lastUpdatedAt=now;
      ticket.auditTrail=Array.isArray(ticket.auditTrail)?ticket.auditTrail:[];
      ticket.auditTrail.push({action:'Student supplied additional evidence',note,at:now,by:'Student'});
      ticket.studentUpdates=Array.isArray(ticket.studentUpdates)?ticket.studentUpdates:[];
      ticket.studentUpdates.push({label:'Additional evidence received',message:'Student Support Services has received the additional evidence and the investigation is continuing.',at:now});
      updated={...ticket}; return ticket;
    });
    if(updated==='not-requested') { await removeUploaded(req).catch(()=>{}); return res.status(409).json({error:'Student Support has not requested additional evidence for this case.'}); }
    if(!updated) { await removeUploaded(req).catch(()=>{}); return res.status(404).json({error:'No ticket was found with that reference and email combination.'}); }
    sendSupportStudentUpdateEmail(updated,{label:'Additional evidence received',message:'We have received your additional evidence and the investigation is continuing.'},req).catch(error=>console.error('Support evidence confirmation email failed:',error.message));
    return res.json({ok:true,ticket:supportPublicTicket(updated)});
  } catch(error) { console.error('Student support evidence upload failed:',error); await removeUploaded(req).catch(()=>{}); return res.status(500).json({error:'The additional evidence could not be uploaded.'}); }
});

app.post('/api/support/tickets/:reference/respond', supportRateLimit(20), supportUpload.array('evidenceFiles', 10), async (req, res) => {
  try {
    const reference = String(req.params.reference || '').trim().toUpperCase();
    const credentials = supportTicketCredentials(req, reference);
    const note = String(req.body?.note || '').trim().slice(0, 4000);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!credentials || (!note && !files.length)) { await removeUploaded(req).catch(() => {}); return res.status(400).json({ error: 'Provide a message or attach evidence.' }); }
    let updated = null;
    await mutateSupportTickets(tickets => {
      const ticket = tickets.find(item => item.reference.toUpperCase() === reference && item.email.toLowerCase() === credentials.email.toLowerCase());
      if (!ticket) return null;
      if (['accepted','closed','resolved','final-decision'].includes(ticket.status)) { updated = 'closed'; return ticket; }
      const now = new Date().toISOString();
      if (ticket.slaPausedAt) supportResumeSla(ticket);
      ticket.evidence = Array.isArray(ticket.evidence) ? ticket.evidence : [];
      ticket.evidence.push(...files.map(file => ({ ...fileRecord(file), source: 'student-follow-up', uploadedAt: now, note })));
      ticket.status = 'in-progress';
      ticket.lastUpdatedAt = now;
      ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
      ticket.auditTrail.push({ action: 'Student response received', note, at: now, by: 'Student' });
      ticket.studentUpdates = Array.isArray(ticket.studentUpdates) ? ticket.studentUpdates : [];
      ticket.studentUpdates.push({ label: 'Your response was received', message: note || `${files.length} additional evidence file(s) received.`, at: now });
      updated = { ...ticket };
      return ticket;
    });
    if (updated === 'closed') { await removeUploaded(req).catch(() => {}); return res.status(409).json({ error: 'Use the decision controls to accept, reopen, or appeal this case.' }); }
    if (!updated) { await removeUploaded(req).catch(() => {}); return res.status(404).json({ error: 'No ticket was found with those details.' }); }
    sendSupportStudentUpdateEmail(updated, { label: 'Response received', message: 'Your response and supporting evidence have been added to the case.' }, req).catch(error => console.error('Support response email failed:', error.message));
    return res.json({ ok: true, ticket: supportPublicTicket(updated) });
  } catch (error) { console.error('Student support response failed:', error); await removeUploaded(req).catch(() => {}); return res.status(500).json({ error: 'Your response could not be submitted.' }); }
});

function supportAppealUnit(ticket) {
  if (ticket.sensitive) return 'provost';
  if (['programme-department','assessment-project'].includes(ticket.categoryKey)) {
    return ['education','business'].includes(ticket.academicDepartment) ? 'directorate-education-business' : 'directorate-arts-stem';
  }
  if (['certificate','change-of-name','transcript'].includes(ticket.categoryKey)) return 'provost';
  return 'college-registrar';
}
app.post('/api/support/tickets/:reference/decision', supportRateLimit(12), async (req, res) => {
  const reference = String(req.params.reference || '').trim().toUpperCase();
  const credentials = supportTicketCredentials(req, reference);
  const action = String(req.body?.action || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 4000);
  if (!credentials || !['accept','reopen','appeal'].includes(action)) return res.status(400).json({ error: 'Choose a valid response to the decision.' });
  if (['reopen','appeal'].includes(action) && reason.length < 10) return res.status(400).json({ error: 'Briefly explain why the matter remains unresolved or why you are appealing.' });
  let updated = null;
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.reference.toUpperCase() === reference && item.email.toLowerCase() === credentials.email.toLowerCase());
    if (!ticket) return null;
    if (!['resolved','final-decision','closed'].includes(ticket.status)) { updated = 'not-ready'; return ticket; }
    const now = new Date().toISOString();
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.studentUpdates = Array.isArray(ticket.studentUpdates) ? ticket.studentUpdates : [];
    if (action === 'accept') {
      ticket.status = 'accepted';
      ticket.acceptedAt = now;
      ticket.closedAt = now;
      ticket.studentUpdates.push({ label: 'Resolution accepted', message: 'You accepted the resolution and the case is now closed.', at: now });
      ticket.auditTrail.push({ action: 'Resolution accepted and case closed', note: reason, at: now, by: 'Student' });
    } else if (action === 'reopen') {
      if (ticket.studentResponseDueAt && new Date(ticket.studentResponseDueAt).getTime() < Date.now()) { updated = 'window-expired'; return ticket; }
      ticket.status = 'reopened';
      ticket.reopenedAt = now;
      ticket.studentResponseDueAt = null;
      ticket.dueAt = supportMoveWorkingDays(now, 5);
      ticket.ownerUnit = STAFF_UNITS['student-support'].label;
      ticket.ownerUnitId = 'student-support';
      ticket.studentUpdates.push({ label: 'Case reopened', message: reason, at: now });
      ticket.auditTrail.push({ action: 'Case reopened by student', note: reason, at: now, by: 'Student' });
    } else {
      const targetUnit = supportAppealUnit(ticket);
      const sourceUnit = ticket.ownerUnitId || 'student-support';
      ticket.status = 'appealed';
      ticket.appealedAt = now;
      ticket.studentResponseDueAt = null;
      ticket.dueAt = supportMoveWorkingDays(now, 5);
      ticket.ownerUnit = STAFF_UNITS[targetUnit].label;
      ticket.ownerUnitId = targetUnit;
      ticket.referrals = Array.isArray(ticket.referrals) ? ticket.referrals : [];
      ticket.referrals.push({ id: crypto.randomUUID(), sourceUnit, sourceLabel: STAFF_UNITS[sourceUnit]?.label || sourceUnit, targetUnit, targetLabel: STAFF_UNITS[targetUnit].label, status: 'assigned', origin: 'student-appeal', comment: reason, createdAt: now, reassignmentHistory: [] });
      ticket.studentUpdates.push({ label: 'Appeal registered', message: `Your appeal has been registered with ${STAFF_UNITS[targetUnit].label}.`, at: now });
      ticket.auditTrail.push({ action: `Appeal registered with ${STAFF_UNITS[targetUnit].label}`, note: reason, at: now, by: 'Student' });
    }
    ticket.lastUpdatedAt = now;
    updated = { ...ticket };
    return ticket;
  });
  if (updated === 'not-ready') return res.status(409).json({ error: 'A resolution must be recorded before this response is available.' });
  if (updated === 'window-expired') return res.status(409).json({ error: 'The reopening period has ended. Submit an appeal instead.' });
  if (!updated) return res.status(404).json({ error: 'No ticket was found with those details.' });
  sendSupportStudentUpdateEmail(updated, { label: action === 'accept' ? 'Resolution accepted' : action === 'reopen' ? 'Case reopened' : 'Appeal registered', message: reason }, req).catch(error => console.error('Support decision email failed:', error.message));
  return res.json({ ok: true, ticket: supportPublicTicket(updated) });
});

app.post('/api/support/tickets/:reference/feedback', supportRateLimit(10), async (req, res) => {
  const reference = String(req.params.reference || '').trim().toUpperCase();
  const credentials = supportTicketCredentials(req, reference);
  const rating = Number(req.body?.rating);
  const easeOfUse = Number(req.body?.easeOfUse);
  const communication = Number(req.body?.communication);
  const timeliness = Number(req.body?.timeliness);
  const staffCourtesy = Number(req.body?.staffCourtesy);
  const resolved = String(req.body?.resolved || '').trim();
  const notificationHelpful = String(req.body?.notificationHelpful || 'not-used').trim();
  const languageHelp = String(req.body?.languageHelp || 'not-needed').trim();
  const comment = String(req.body?.comment || '').trim().slice(0, 2000);
  const scores = [rating, easeOfUse, communication, timeliness, staffCourtesy];
  if (!credentials || scores.some(score => !Number.isInteger(score) || score < 1 || score > 5) || !['yes','partly','no'].includes(resolved) || !['yes','no','not-used'].includes(notificationHelpful) || !['yes','no','not-needed'].includes(languageHelp)) return res.status(400).json({ error: 'Complete every service rating from 1 to 5 and choose the required survey responses.' });
  if (scores.some(score => score <= 2) && comment.length < 10) return res.status(400).json({ error: 'Please briefly explain any low rating so the service can be improved.' });
  let updated = null;
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.reference.toUpperCase() === reference && item.email.toLowerCase() === credentials.email.toLowerCase());
    if (!ticket) return null;
    if (!['accepted','closed'].includes(ticket.status)) { updated = 'not-closed'; return ticket; }
    const now = new Date().toISOString();
    ticket.feedback = { rating, easeOfUse, communication, timeliness, staffCourtesy, resolved, notificationHelpful, languageHelp, comment, submittedAt: now };
    ticket.lastUpdatedAt = now;
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.auditTrail.push({ action: 'Student service feedback submitted', note: `Overall ${rating}/5; ease ${easeOfUse}/5; communication ${communication}/5; timeliness ${timeliness}/5; courtesy ${staffCourtesy}/5; resolved: ${resolved}.`, at: now, by: 'Student' });
    updated = { ...ticket };
    return ticket;
  });
  if (updated === 'not-closed') return res.status(409).json({ error: 'Service feedback becomes available after the case is closed.' });
  if (!updated) return res.status(404).json({ error: 'No ticket was found with those details.' });
  return res.json({ ok: true, ticket: supportPublicTicket(updated) });
});

const SUPPORT_STATUS_LABELS = Object.freeze({
  received: 'Received', triaged: 'Triaged', assigned: 'Assigned', accepted: 'Resolution accepted', appealed: 'Appealed', 'awaiting-student': 'Awaiting student', 'evidence-requested': 'Additional evidence requested', 'lacks-evidence': 'Additional evidence needed', 'investigation-ongoing': 'Investigation ongoing', 'in-progress': 'In progress', resolved: 'Resolved', reopened: 'Reopened', 'final-decision': 'Final decision issued', closed: 'Closed'
});
app.use('/api/support/admin', supportSameOrigin);
app.get('/support-admin', supportWorkspaceAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'support-admin.html')));
// Browser code contains no protected records. Serving it publicly lets the page
// report an expired session instead of remaining on an unresponsive loading shell.
app.get('/support-admin.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'support-admin.js')));
app.get('/api/support/admin/me', supportWorkspaceAuth, async (req, res) => res.json({ ok:true, identity:{ name:req.supportIdentity?.name || req.supportIdentity?.username || 'Student Support officer', role:req.supportIdentity?.role || 'viewer', units:normalizeStaffUnits(req.supportIdentity?.units).length?normalizeStaffUnits(req.supportIdentity?.units):(req.supportIdentity?.developer?['student-support']:[]), confidentialAccess:canAccessSensitiveSupport(req.supportIdentity), developerPreview:Boolean(req.supportIdentity?.developerPreview), developerPreviewLabel:req.supportIdentity?.developerPreviewLabel || '', previewExpiresAt:req.supportIdentity?.previewExpiresAt || null } }));
app.post('/api/support/admin/lifecycle/refresh', supportWorkspaceAuth, requireSupportRole('officer'), async (_req, res) => {
  await refreshSupportLifecycle();
  res.json({ ok:true, refreshedAt:new Date().toISOString() });
});
function filterSupportAdminTickets(tickets, identity, query = {}) {
  const units = normalizeStaffUnits(identity?.units);
  let filtered = tickets.filter(ticket => canAccessSupportTicket(identity, ticket));
  if (units.includes('confidential-handler') && !units.includes('student-support') && !identity?.developer) filtered = filtered.filter(ticket => ticket.sensitive);
  const search = String(query.search || '').trim().toLowerCase();
  const status = String(query.status || '').trim();
  const category = String(query.category || '').trim();
  const priority = String(query.priority || '').trim();
  const owner = String(query.owner || '').trim();
  const confidentiality = String(query.confidentiality || '').trim();
  if (search) filtered = filtered.filter(ticket => [ticket.reference,ticket.name,ticket.email,ticket.studentNumber,ticket.subject,ticket.studyCentre,ticket.programme].some(value => String(value || '').toLowerCase().includes(search)));
  if (status) filtered = filtered.filter(ticket => ticket.status === status);
  if (category) filtered = filtered.filter(ticket => ticket.categoryKey === category);
  if (priority) filtered = filtered.filter(ticket => ticket.priorityKey === priority);
  if (owner) filtered = filtered.filter(ticket => (ticket.ownerUnitId || '') === owner);
  if (confidentiality === 'restricted') filtered = filtered.filter(ticket => ticket.sensitive);
  if (confidentiality === 'standard') filtered = filtered.filter(ticket => !ticket.sensitive);
  return filtered.sort((a, b) => String(b.lastUpdatedAt || b.createdAt).localeCompare(String(a.lastUpdatedAt || a.createdAt)));
}
app.get('/api/support/admin/tickets', supportWorkspaceAuth, async (req, res) => {
  const allTickets = await readSupportTickets();
  const permissionTotal = filterSupportAdminTickets(allTickets, req.supportIdentity, {}).length;
  const tickets = filterSupportAdminTickets(allTickets, req.supportIdentity, req.query);
  const total = tickets.length;
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 25) || 25));
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const start = (page - 1) * pageSize;
  const pageTickets = tickets.slice(start, start + pageSize);
  res.json({ ok: true, total, permissionTotal, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), tickets: pageTickets.map(ticket => ({
    id: ticket.id, reference: ticket.reference, name: ticket.name, email: ticket.email, phone:ticket.phone || '', type: ticket.type, studyLevel: ticket.studyLevelLabel || '', language:ticket.language || 'en', notificationPreference:ticket.notificationPreference || 'email',
    categoryKey: ticket.categoryKey, category: ticket.categoryLabel, priority: ticket.priorityLabel, status: ticket.status, statusLabel: SUPPORT_STATUS_LABELS[ticket.status] || ticket.status,
    priorityKey: ticket.priorityKey, ownerUnit: ticket.ownerUnit, ownerUnitId: ticket.ownerUnitId || '', assignedCaseOwner: ticket.assignedCaseOwner || '', intendedUnit: ticket.intendedUnit || '', supportUnit: ticket.supportUnit, studyCentre: ticket.studyCentre, programme: ticket.programme || '', academicDepartment: ticket.academicDepartment || '', subject: ticket.subject,
    description: ticket.description, originRole: ticket.originRole, sensitive: ticket.sensitive, createdAt: ticket.createdAt,
    dueAt: ticket.dueAt, assignmentDueAt: ticket.assignmentDueAt || null, lastUpdatedAt: ticket.lastUpdatedAt, resolution: ticket.resolution || '', feedback: ticket.feedback || null, sla: supportSlaSummary(ticket), assignment:supportAssignmentSummary(ticket,[ticket.ownerUnitId]), assignments:supportAssignmentList(ticket), auditTrail: ticket.auditTrail || [], studentUpdates:ticket.studentUpdates||[],
    evidence: Array.isArray(ticket.evidence) ? ticket.evidence : [], officerEvidence: Array.isArray(ticket.officerEvidence) ? ticket.officerEvidence : [], forwardHistory: ticket.forwardHistory || [], referrals: ticket.referrals || [], registrations: ticket.registrations || [], interUnitMessages: ticket.interUnitMessages || []
  })) });
});
function supportCsvValue(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
app.get('/api/support/admin/tickets.csv', supportWorkspaceAuth, async (req, res) => {
  const tickets = filterSupportAdminTickets(await readSupportTickets(), req.supportIdentity, req.query);
  const headers = ['Reference','Created','Last updated','Status','Priority','Category','Matter type','Confidentiality','Student','Email','Phone','Student number','Study centre','Programme','Responsible unit','Assignment indicator','Assigned staff','Assigned staff email','Assignment sent','Assignment opened','Assignment resolved','Due','SLA','First response hours','Resolution hours','Feedback rating','Ease of use','Communication','Timeliness','Staff courtesy','Feedback resolved','Notification preference','Assistance language'];
  const hours = (start, end) => start && end ? Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 3600000).toFixed(1) : '';
  const rows = tickets.map(ticket => {
    const sla = supportSlaSummary(ticket);
    const assignment = supportAssignmentSummary(ticket,[ticket.ownerUnitId]);
    const slaLabel = sla.overdue ? 'Overdue' : sla.atRisk ? 'At risk' : sla.paused ? 'Paused' : 'On track';
    return [ticket.reference,ticket.createdAt,ticket.lastUpdatedAt,SUPPORT_STATUS_LABELS[ticket.status] || ticket.status,ticket.priorityLabel,ticket.categoryLabel,ticket.type,ticket.sensitive ? 'Restricted' : 'Standard',ticket.name,ticket.email,ticket.phone,ticket.studentNumber,ticket.studyCentre,ticket.programme,ticket.ownerUnit,assignment.label,assignment.officerName || ticket.assignedCaseOwner,assignment.officerEmail,assignment.assignedAt,assignment.openedAt,assignment.resolvedAt,ticket.dueAt,slaLabel,hours(ticket.createdAt,ticket.firstResponseAt),hours(ticket.createdAt,ticket.resolvedAt),ticket.feedback?.rating || '',ticket.feedback?.easeOfUse || '',ticket.feedback?.communication || '',ticket.feedback?.timeliness || '',ticket.feedback?.staffCourtesy || '',ticket.feedback?.resolved || '',ticket.notificationPreference || 'email',SUPPORT_LANGUAGES[ticket.language] || SUPPORT_LANGUAGES.en].map(supportCsvValue).join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="student-support-cases-${supportDateKey(new Date())}.csv"`);
  res.send(`\uFEFF${[headers.map(supportCsvValue).join(','), ...rows].join('\r\n')}`);
});
app.get('/api/support/admin/tickets.xlsx', supportWorkspaceAuth, async (req, res) => {
  const tickets = filterSupportAdminTickets(await readSupportTickets(), req.supportIdentity, req.query);
  sendSupportWorkbook(res, tickets, `student-support-register-${supportDateKey(new Date())}.xlsx`, false);
});
app.patch('/api/support/admin/tickets/:id', supportWorkspaceAuth, requireSupportRole('officer'), async (req, res) => {
  const nextStatus = String(req.body?.status || '').trim();
  if (!Object.prototype.hasOwnProperty.call(SUPPORT_STATUS_LABELS, nextStatus)) return res.status(400).json({ error: 'Choose a valid ticket status.' });
  if (nextStatus === 'accepted') return res.status(400).json({ error: 'Only the student may accept a resolution.' });
  const categoryKey = String(req.body?.categoryKey || '').trim();
  const priorityKey = String(req.body?.priorityKey || '').trim();
  const ownerUnitId = String(req.body?.ownerUnitId || '').trim();
  const assignedCaseOwner = cleanHumanText(req.body?.assignedCaseOwner).slice(0, 180);
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  if(['evidence-requested','lacks-evidence','investigation-ongoing','resolved','final-decision','closed'].includes(nextStatus)&&!note) return res.status(400).json({error:'Provide a clear message for the student before recording this case update.'});
  let updated = null;
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.id === req.params.id);
    if (!ticket) return null;
    if (!canAccessSupportTicket(req.supportIdentity, ticket)) { updated = 'forbidden'; return ticket; }
    const now = new Date().toISOString();
    const classificationChanged = categoryKey && SUPPORT_CATEGORIES[categoryKey] && categoryKey !== ticket.categoryKey;
    const priorityChanged = priorityKey && SUPPORT_PRIORITIES[priorityKey] && priorityKey !== ticket.priorityKey;
    if (classificationChanged) {
      ticket.categoryKey = categoryKey;
      ticket.categoryLabel = SUPPORT_CATEGORIES[categoryKey].label;
      ticket.intendedUnit = SUPPORT_CATEGORIES[categoryKey].owner;
      ticket.sensitive = categoryKey === 'sensitive';
      ticket.confidentiality = ticket.sensitive ? 'restricted' : 'standard';
      if (ticket.sensitive) {
        ticket.ownerUnitId = 'confidential-handler';
        ticket.ownerUnit = STAFF_UNITS['confidential-handler'].label;
        ticket.referrals = Array.isArray(ticket.referrals) ? ticket.referrals : [];
        if (!ticket.referrals.some(referral => referral.targetUnit === 'confidential-handler' && !['reassigned','closed','cancelled'].includes(referral.status))) ticket.referrals.push({ id:crypto.randomUUID(), sourceUnit:'student-support', sourceLabel:STAFF_UNITS['student-support'].label, targetUnit:'confidential-handler', targetLabel:STAFF_UNITS['confidential-handler'].label, status:'assigned', origin:'confidential-triage', comment:note || 'Reclassified for restricted handling.', createdAt:now, reassignmentHistory:[] });
      }
    }
    if (priorityChanged) {
      ticket.priorityKey = priorityKey;
      ticket.priorityLabel = SUPPORT_PRIORITIES[priorityKey].label;
    }
    if ((classificationChanged || priorityChanged) && !ticket.slaPausedAt) ticket.dueAt = supportMoveWorkingDays(now, supportDueDays(ticket.categoryKey, ticket.priorityKey, ticket.sensitive));
    ticket.status = nextStatus;
    if (ownerUnitId && Object.prototype.hasOwnProperty.call(STAFF_UNITS, ownerUnitId)) {
      if (ticket.sensitive && !['confidential-handler','provost'].includes(ownerUnitId)) { updated = 'restricted-route'; return ticket; }
      ticket.ownerUnitId = ownerUnitId;
      ticket.ownerUnit = STAFF_UNITS[ownerUnitId].label;
    }
    if (assignedCaseOwner) ticket.assignedCaseOwner = assignedCaseOwner;
    if (!ticket.firstResponseAt && nextStatus !== 'received') ticket.firstResponseAt = now;
    if (['evidence-requested','lacks-evidence','awaiting-student'].includes(nextStatus)) supportPauseSla(ticket, note || 'Awaiting student information');
    else if (ticket.slaPausedAt) supportResumeSla(ticket);
    if (['resolved','final-decision','closed'].includes(nextStatus)) ticket.studentResponseDueAt = supportMoveWorkingDays(now, 5);
    if (nextStatus === 'reopened') ticket.studentResponseDueAt = null;
    if (note) ticket.resolution = ['resolved','final-decision','closed'].includes(nextStatus) ? note : ticket.resolution || '';
    ticket.lastUpdatedAt = now;
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.auditTrail.push({ action: `Status changed to ${SUPPORT_STATUS_LABELS[nextStatus]}`, note, at: now, by: req.supportIdentity?.name || 'Support administrator' });
    ticket.studentUpdates=Array.isArray(ticket.studentUpdates)?ticket.studentUpdates:[];
    ticket.studentUpdates.push({label:SUPPORT_STATUS_LABELS[nextStatus],message:note||`Your case status is now ${SUPPORT_STATUS_LABELS[nextStatus]}.`,at:now});
    if (ticket.auditTrail.length > 100) ticket.auditTrail = ticket.auditTrail.slice(-100);
    updated={...ticket};
    return ticket;
  });
  if (updated === 'forbidden') return res.status(403).json({ error: 'You do not have access to this restricted case.' });
  if (updated === 'restricted-route') return res.status(400).json({ error: 'Sensitive cases may only be assigned to the Confidential Case Handler or Provost.' });
  if (!updated) return res.status(404).json({ error: 'Support ticket not found.' });
  sendSupportStudentUpdateEmail(updated,{label:SUPPORT_STATUS_LABELS[updated.status],message:note},req).catch(error=>console.error('Support status email failed:',error.message));
  res.json({ ok: true, ticket: supportPublicTicket(updated) });
});

function supportEvidenceFor(ticket, index, collection='evidence') {
  const evidence = Array.isArray(ticket?.[collection]) ? ticket[collection] : [];
  const file = evidence[Number(index)];
  if (!Number.isInteger(Number(index)) || Number(index) < 0 || !file?.storedName) return null;
  const filePath = path.join(FILES_DIR, path.basename(file.storedName));
  return fs.existsSync(filePath) ? { file, filePath } : null;
}
async function sendSupportEvidence(req, res, evidence) {
  if (String(req.query.download || '') === '1') return res.download(evidence.filePath, safeBaseName(evidence.file.originalName || 'evidence'));
  return sendInlineClaimPreview(res, evidence.file, 'Evidence Preview');
}
function supportForwardForToken(tickets, token) {
  const tokenHash = hashOneTimeToken(token);
  for (const ticket of tickets) {
    const forward = (ticket.forwardHistory || []).find(item => item.tokenHash === tokenHash);
    if (forward) return { ticket, forward };
  }
  return null;
}
function secureSupportForwardPage(ticket, forward, token) {
  const framedEvidence = (files, collection, emptyText) => Array.isArray(files) && files.length
    ? `<div class="evidence">${files.map((file, index) => { const url=`/secure/support/${encodeURIComponent(token)}/${collection}/${index}`; const name=htmlEscape(file.originalName || `evidence ${index + 1}`); return `<section><strong>${name}</strong><iframe src="${url}" title="${name}"></iframe><a href="${url}" target="_blank" rel="noopener">Open in new tab</a></section>`; }).join('')}</div>`
    : `<p>${emptyText}</p>`;
  const studentEvidenceHtml = framedEvidence(ticket.evidence, 'evidence', 'No student evidence files were attached.');
  const officerEvidenceHtml = framedEvidence(ticket.officerEvidence, 'officer-evidence', 'No officer evidence files were attached.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(ticket.reference)} | CoDE Academic Services</title><style>body{margin:0;background:#f4f7fa;color:#162331;font:16px/1.55 Arial,sans-serif}.wrap{max-width:800px;margin:38px auto;padding:0 20px}.card{background:#fff;border:1px solid #dce4eb;border-radius:14px;padding:26px;box-shadow:0 10px 28px rgba(15,38,61,.09)}h1,h2{color:#082b4c}h1{margin:0 0 4px;font-size:25px}h2{font-size:17px;margin:24px 0 8px}.tag{color:#936b00;font-weight:bold;font-size:12px;letter-spacing:.08em}.meta{display:grid;grid-template-columns:170px 1fr;gap:7px 14px;background:#f7fafc;border-radius:9px;padding:14px}.meta b{color:#082b4c}.copy{white-space:pre-wrap}.notice{margin-top:20px;padding:12px 14px;border-left:4px solid #d4a72c;background:#fff8df;color:#5c4a14;font-size:13px}a{color:#082b4c;font-weight:bold}.evidence{display:grid;gap:16px}.evidence section{display:grid;gap:8px;border-top:1px solid #dce4eb;padding-top:14px}.evidence section:first-child{border-top:0;padding-top:0}.evidence iframe{width:100%;height:500px;border:1px solid #cbd6df;border-radius:8px;background:#fff}</style></head><body><main class="wrap"><section class="card"><p class="tag">STUDENT SUPPORT FORWARD</p><h1>${htmlEscape(ticket.reference)}</h1><p>This matter was sent to <strong>${htmlEscape(forward.officeName)}</strong> by Student Support Services.</p><div class="meta"><b>Category</b><span>${htmlEscape(ticket.categoryLabel)}</span><b>Learner level</b><span>${htmlEscape(ticket.studyLevelLabel || 'Not stated')}</span><b>Student</b><span>${htmlEscape(ticket.name)}</span><b>Index / student number</b><span>${htmlEscape(ticket.studentNumber || 'Not stated')}</span><b>Study centre</b><span>${htmlEscape(ticket.studyCentre || 'Not stated')}</span><b>Subject</b><span>${htmlEscape(ticket.subject)}</span></div><h2>Student description</h2><p class="copy">${htmlEscape(ticket.description)}</p><h2>Student Support comments</h2><p class="copy">${htmlEscape(forward.comment)}</p><h2>Student evidence</h2>${studentEvidenceHtml}<h2>Officer evidence</h2>${officerEvidenceHtml}<p class="notice">This is a confidential, time-limited link. Do not forward it outside the office handling this matter.</p></section></main></body></html>`;
}

app.get('/api/support/admin/tickets/:id/evidence/:index', supportWorkspaceAuth, async (req, res) => {
  const ticket = (await readSupportTickets()).find(item => item.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Support ticket not found.' });
  if (!canAccessSupportTicket(req.supportIdentity, ticket)) return res.status(403).json({ error: 'You do not have access to this restricted case.' });
  const evidence = supportEvidenceFor(ticket, req.params.index);
  if (!evidence) return res.status(404).json({ error: 'Evidence file not found.' });
  return sendSupportEvidence(req, res, evidence);
});
app.get('/api/support/admin/tickets/:id/officer-evidence/:index', supportWorkspaceAuth, async (req,res)=>{
  const ticket=(await readSupportTickets()).find(item=>item.id===req.params.id);
  if(!ticket) return res.status(404).json({error:'Support ticket not found.'});
  if(!canAccessSupportTicket(req.supportIdentity,ticket)) return res.status(403).json({error:'You do not have access to this restricted case.'});
  const evidence=supportEvidenceFor(ticket,req.params.index,'officerEvidence');
  if(!evidence) return res.status(404).json({error:'Officer evidence file not found.'});
  return sendSupportEvidence(req,res,evidence);
});
app.post('/api/support/admin/tickets/:id/officer-evidence', supportWorkspaceAuth, requireSupportRole('officer'), supportUpload.array('evidenceFiles',10), async(req,res)=>{
  try {
    const note=String(req.body?.note||'').trim().slice(0,2000);
    if(!Array.isArray(req.files)||!req.files.length) return res.status(400).json({error:'Attach at least one evidence file.'});
    let updated=null;
    await mutateSupportTickets(tickets=>{
      const ticket=tickets.find(item=>item.id===req.params.id); if(!ticket) return null;
      if(!canAccessSupportTicket(req.supportIdentity,ticket)) { updated='forbidden'; return ticket; }
      const now=new Date().toISOString(); ticket.officerEvidence=Array.isArray(ticket.officerEvidence)?ticket.officerEvidence:[];
      ticket.officerEvidence.push(...req.files.map(file=>({...fileRecord(file),uploadedAt:now,note,uploadedBy:req.supportIdentity?.name||'Support officer'})));
      ticket.lastUpdatedAt=now; ticket.auditTrail=Array.isArray(ticket.auditTrail)?ticket.auditTrail:[];
      ticket.auditTrail.push({action:'Officer evidence added',note,at:now,by:req.supportIdentity?.name||'Support officer'});
      updated={...ticket}; return ticket;
    });
    if(updated==='forbidden') { await removeUploaded(req).catch(()=>{}); return res.status(403).json({error:'You do not have access to this restricted case.'}); }
    if(!updated) return res.status(404).json({error:'Support ticket not found.'});
    return res.json({ok:true,evidenceCount:updated.officerEvidence.length});
  } catch(error) { console.error('Officer evidence upload failed:',error); await removeUploaded(req).catch(()=>{}); return res.status(500).json({error:'Officer evidence could not be uploaded.'}); }
});

async function supportUnitNotificationRecipients(unitId) {
  const accounts = await readAdminUsers();
  return [...new Set(accounts.filter(account => account.active !== false && normalizeStaffUnits(account.units).includes(unitId) && (ROLE_RANK[account.role] || 0) >= ROLE_RANK.officer && isEmail(account.email)).map(account => String(account.email).trim().toLowerCase()))];
}
function supportEmailsAreInstitutional(emails) {
  return emails.every(email => {
    const domain = String(email).split('@').pop().toLowerCase();
    return [...SUPPORT_ALLOWED_EMAIL_DOMAINS].some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
  });
}
async function createSupportStaffAssignment(req, res, { identity, allowedUnits }) {
  const unitId = String(req.body?.unitId || '').trim();
  const officerEmail = String(req.body?.officerEmail || '').trim().toLowerCase();
  const officerName = cleanHumanText(req.body?.officerName || '').slice(0, 180);
  const units = normalizeStaffUnits(allowedUnits);
  if (!STAFF_UNITS[unitId] || !units.includes(unitId)) return res.status(403).json({ error:'You may assign staff only for a functional unit you administer.' });
  if (!isEmail(officerEmail)) return res.status(400).json({ error:'Enter a valid staff email address.' });
  if (!supportEmailsAreInstitutional([officerEmail])) return res.status(400).json({ error:'Use an approved institutional staff email address.' });
  const availableTicket = (await readSupportTickets()).find(ticket => ticket.id === req.params.id && (ticket.ownerUnitId === unitId || activeReferralForUnits(ticket,[unitId])));
  if (!availableTicket) return res.status(404).json({ error:'This complaint or request is not registered with the selected functional unit.' });
  if (availableTicket.sensitive && !['confidential-handler','provost'].includes(unitId)) return res.status(403).json({ error:'This restricted complaint cannot be assigned through the selected functional unit.' });
  const actor = identity?.name || identity?.username || 'Functional-unit administrator';
  const accountSetup = await ensureSupportAssignmentAccount({ email:officerEmail, name:officerName, unitId, actor });
  if (!accountSetup || accountSetup.state === 'disabled') return res.status(409).json({ error:'This staff account is suspended. Reactivate it in the Developer Portal before assigning a complaint or request.' });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const assignmentId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SUPPORT_FORWARD_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let assignedTicket = null;
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.id === req.params.id);
    if (!ticket || (ticket.ownerUnitId !== unitId && !activeReferralForUnits(ticket,[unitId]))) return tickets;
    if (ticket.sensitive && !['confidential-handler','provost'].includes(unitId)) return tickets;
    ticket.staffAssignments = Array.isArray(ticket.staffAssignments) ? ticket.staffAssignments : [];
    for (const assignment of ticket.staffAssignments) {
      if (assignment.unitId === unitId && !['resolved','superseded'].includes(assignment.state)) {
        assignment.state = 'superseded';
        assignment.supersededAt = now;
        assignment.supersededBy = actor;
      }
    }
    ticket.staffAssignments.push({ id:assignmentId, unitId, unitLabel:STAFF_UNITS[unitId].label, officerName:officerName || accountSetup.account.name || officerEmail.split('@')[0], officerEmail, staffAccountId:accountSetup.account.id, accountCreated:Boolean(accountSetup.created), activationRequired:accountSetup.state==='pending', assignedBy:actor, assignedAt:now, expiresAt, tokenHash:hashOneTimeToken(rawToken), state:'unopened', emailStatus:'pending', checks:{}, openedAt:null, resolvedAt:null, resolutionNote:'' });
    ticket.assignedCaseOwner = officerName || officerEmail;
    ticket.assignedCaseEmail = officerEmail;
    ticket.assignmentDueAt = supportMoveWorkingDays(now, 2);
    if (!['resolved','final-decision','closed','accepted'].includes(ticket.status)) ticket.status = 'assigned';
    ticket.lastUpdatedAt = now;
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.auditTrail.push({ action:`Assigned to ${officerEmail}`, note:`${STAFF_UNITS[unitId].label} staff assignment created. Register indicator is red until the secure link is opened.`, at:now, by:actor });
    assignedTicket = JSON.parse(JSON.stringify(ticket));
    return tickets;
  });
  if (!assignedTicket) return res.status(404).json({ error:'This complaint or request is not registered with the selected functional unit.' });
  const secureUrl = `${baseUrlFor(req)}/secure/support-assignment/${rawToken}`;
  const activationUrl = accountSetup.invitationToken ? `${requestBaseUrl(req)}/admin-set-password.html?token=${encodeURIComponent(accountSetup.invitationToken)}&next=${encodeURIComponent(new URL(secureUrl).pathname)}` : '';
  let emailStatus = 'not-configured';
  let emailError = '';
  if (gmailConfigured()) {
    try {
      const actionUrl = activationUrl || secureUrl;
      const actionLabel = activationUrl ? 'Activate account and open assigned case' : 'Sign in and open assigned case';
      const accountText = activationUrl
        ? `A permanent Officer account has ${accountSetup.created ? 'been created' : 'not yet been activated'} for ${htmlEscape(officerEmail)}. Use the one-time button below to choose your password. After activation, the assigned case opens automatically.`
        : `Your existing permanent staff account for ${htmlEscape(officerEmail)} has been linked to this assignment. Sign in with that account to open the case.`;
      const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><div style="font-size:12px;text-transform:uppercase;color:#956f00;font-weight:bold">University of Cape Coast</div><h2 style="color:#082b4c">Complaint or request assigned to you</h2><p>Dear ${htmlEscape(officerName || accountSetup.account.name || 'Staff Member')},</p><p>${htmlEscape(STAFF_UNITS[unitId].label)} has assigned the matter below to you.</p><div style="margin:18px 0;padding:16px;background:#f5f8fb;border-left:4px solid #c6404d"><strong>Reference:</strong> ${htmlEscape(assignedTicket.reference)}<br><strong>Type:</strong> ${htmlEscape(assignedTicket.type === 'service-request' ? 'Service request' : 'Complaint')}<br><strong>Category:</strong> ${htmlEscape(assignedTicket.categoryLabel)}<br><strong>Subject:</strong> ${htmlEscape(assignedTicket.subject)}</div><p>${accountText}</p><p><a href="${htmlEscape(actionUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">${actionLabel}</a></p><p>Username: <strong>${htmlEscape(accountSetup.account.username)}</strong></p><p>No temporary password is sent by email. ${activationUrl ? `The activation link expires on ${htmlEscape(new Date(accountSetup.account.invitationExpiresAt).toLocaleString('en-GB'))}.` : ''}</p><p>The register is red until the authorised staff member opens the case, yellow while it is being handled, and green after all resolution checks are completed.</p><p>The case-assignment link expires on ${htmlEscape(new Date(expiresAt).toLocaleDateString('en-GB'))}. Do not forward this email.</p><p>Regards,<br>${htmlEscape(STAFF_UNITS[unitId].label)}<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
      await sendGmailHtmlEmail({to:officerEmail,subject:`${activationUrl ? 'Activate account and open' : 'Assigned'} support matter - ${assignedTicket.reference}`,html});
      emailStatus = 'sent';
    } catch (error) {
      emailStatus = 'failed';
      emailError = String(error.message || error).slice(0, 300);
    }
  }
  await mutateSupportTickets(tickets => {
    const assignment = tickets.find(ticket => ticket.id === req.params.id)?.staffAssignments?.find(item => item.id === assignmentId);
    if (assignment) { assignment.emailStatus = emailStatus; assignment.emailSentAt = emailStatus === 'sent' ? new Date().toISOString() : null; assignment.emailError = emailError; }
    return tickets;
  });
  if (accountSetup.state === 'pending') {
    await mutateAdminUsers(accounts => {
      const account = accounts.find(item => item.id === accountSetup.account.id);
      if (account) {
        account.invitationEmailStatus = emailStatus === 'sent' ? 'sent' : emailStatus;
        account.invitationSentAt = emailStatus === 'sent' ? new Date().toISOString() : null;
        account.invitationLastError = emailError;
      }
      return account || null;
    });
  }
  const assignment = supportAssignmentSummary({ staffAssignments:assignedTicket.staffAssignments }, [unitId]);
  const accountMessage = accountSetup.created ? 'A permanent Officer account was created automatically.' : accountSetup.unitAdded ? 'The functional unit was added to the existing permanent account.' : accountSetup.state === 'pending' ? 'The existing pending account received a new activation link.' : 'The existing permanent staff account was reused.';
  const deliveryMessage = emailStatus === 'sent' ? 'The activation or assignment email was sent.' : emailStatus === 'failed' ? 'Email delivery failed. Copy the activation link below or correct the email settings and assign again.' : 'Email delivery is not configured. Copy the activation link below to the staff member.';
  return res.json({ ok:true, reference:assignedTicket.reference, assignment:{...assignment,emailStatus}, secureUrl, activationUrl:activationUrl && emailStatus!=='sent' ? activationUrl : '', account:{ id:accountSetup.account.id, username:accountSetup.account.username, email:officerEmail, created:Boolean(accountSetup.created), unitAdded:Boolean(accountSetup.unitAdded), activationRequired:accountSetup.state==='pending' }, message:`${accountMessage} ${deliveryMessage}` });
}

app.post('/api/support/admin/tickets/:id/staff-assignments', supportWorkspaceAuth, requireSupportRole('administrator'), async(req,res)=>{
  const identity=req.supportIdentity||{};
  const allowedUnits=normalizeStaffUnits(identity.units).length?identity.units:(identity.developer?['student-support']:[]);
  return createSupportStaffAssignment(req,res,{identity,allowedUnits});
});
app.post('/api/support/admin/tickets/:id/messages', supportWorkspaceAuth, requireSupportRole('officer'), async(req,res)=>{
  const targetUnit=String(req.body?.targetUnit||'').trim();
  const recipientName=STAFF_UNITS[targetUnit]?.label || '';
  const recipientEmails=Object.prototype.hasOwnProperty.call(STAFF_UNITS,targetUnit) ? await supportUnitNotificationRecipients(targetUnit) : [];
  const message=String(req.body?.message||'').trim().slice(0,4000);
  if(!recipientName||!message) return res.status(400).json({error:'Select the receiving unit and provide the information required.'});
  if(!recipientEmails.length) return res.status(409).json({error:'The selected unit has no active officer email. Ask the System Administrator to assign an officer account.'});
  if(!supportEmailsAreInstitutional(recipientEmails)) return res.status(409).json({error:'The selected unit has a non-institutional email address. Correct the staff account before sharing case information.'});
  if(!gmailConfigured()) return res.status(503).json({error:'Inter-unit messaging email is not configured yet.'});
  const now=new Date().toISOString(); let ticketForEmail=null; const messageId=crypto.randomUUID();
  await mutateSupportTickets(tickets=>{
    const ticket=tickets.find(item=>item.id===req.params.id); if(!ticket) return null;
    ticket.interUnitMessages=Array.isArray(ticket.interUnitMessages)?ticket.interUnitMessages:[];
    if(!canAccessSupportTicket(req.supportIdentity,ticket)) { ticketForEmail='forbidden'; return ticket; }
    ticket.interUnitMessages.push({id:messageId,targetUnit,recipientName,recipientCount:recipientEmails.length,message,status:'pending',createdAt:now,sentBy:req.supportIdentity?.name||'Support officer'});
    ticket.auditTrail=Array.isArray(ticket.auditTrail)?ticket.auditTrail:[];
    ticket.auditTrail.push({action:`Information requested from ${recipientName}`,note:message,at:now,by:req.supportIdentity?.name||'Support officer'});
    ticket.lastUpdatedAt=now; ticketForEmail=JSON.parse(JSON.stringify(ticket)); return ticket;
  });
  if(ticketForEmail==='forbidden') return res.status(403).json({error:'You do not have access to this restricted case.'});
  if(!ticketForEmail) return res.status(404).json({error:'Support ticket not found.'});
  try {
    const html=`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">Information requested by Student Support Services</h2><p>Student Support Services requests information from ${htmlEscape(recipientName)} regarding the case below.</p><div style="margin:18px 0;padding:16px;background:#f5f8fb;border-left:4px solid #d4a72c"><strong>Reference:</strong> ${htmlEscape(ticketForEmail.reference)}<br><strong>Category:</strong> ${htmlEscape(ticketForEmail.categoryLabel)}<br><strong>Student:</strong> ${htmlEscape(ticketForEmail.name)}<br><strong>Subject:</strong> ${htmlEscape(ticketForEmail.subject)}</div><p><strong>Request</strong><br>${htmlEscape(message).replace(/\n/g,'<br>')}</p><p>Please reply through the official Student Support communication channel, quoting the reference number.</p><p>Regards,<br>Student Support Services<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
    await Promise.all(recipientEmails.map(to => sendGmailHtmlEmail({to,subject:`Information requested: ${ticketForEmail.reference}`,html})));
    await mutateSupportTickets(tickets=>{const item=tickets.find(ticket=>ticket.id===req.params.id)?.interUnitMessages?.find(item=>item.id===messageId);if(item){item.status='sent';item.sentAt=new Date().toISOString();}return tickets;});
    return res.json({ok:true,reference:ticketForEmail.reference});
  } catch(error) { console.error('Inter-unit support message failed:',error); await mutateSupportTickets(tickets=>{const item=tickets.find(ticket=>ticket.id===req.params.id)?.interUnitMessages?.find(item=>item.id===messageId);if(item){item.status='failed';item.error=String(error.message||'Email delivery failed').slice(0,500);}return tickets;}); return res.status(502).json({error:'The message could not be delivered. Check the official email and try again.'}); }
});

app.post('/api/support/admin/tickets/:id/forward', supportWorkspaceAuth, requireSupportRole('officer'), async (req, res) => {
  const recipientUnit = String(req.body?.recipientUnit || '').trim();
  const officeName = STAFF_UNITS[recipientUnit]?.label || '';
  const recipientEmails = Object.prototype.hasOwnProperty.call(STAFF_UNITS, recipientUnit) ? await supportUnitNotificationRecipients(recipientUnit) : [];
  const officeEmail = recipientEmails.join(', ');
  const comment = String(req.body?.comment || '').trim().slice(0, 4000);
  if (!Object.prototype.hasOwnProperty.call(STAFF_UNITS, recipientUnit)) return res.status(400).json({ error: 'Select the receiving functional unit.' });
  if (!comment) return res.status(400).json({ error: 'Provide clear routing comments for the receiving unit.' });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const forwardId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SUPPORT_FORWARD_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let ticketForEmail = null;
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.id === req.params.id);
    if (!ticket) return null;
    if (!canAccessSupportTicket(req.supportIdentity, ticket)) { ticketForEmail = 'forbidden'; return ticket; }
    if (ticket.sensitive && !['confidential-handler','provost'].includes(recipientUnit)) { ticketForEmail = 'restricted-route'; return ticket; }
    const forward = { id: forwardId, recipientUnit, officeName, officeEmail, comment, tokenHash: hashOneTimeToken(rawToken), createdAt: now, expiresAt, status: 'pending' };
    ticket.forwardHistory = Array.isArray(ticket.forwardHistory) ? ticket.forwardHistory : [];
    ticket.forwardHistory.push(forward);
    ticket.referrals = Array.isArray(ticket.referrals) ? ticket.referrals : [];
    ticket.referrals.push({ id: forwardId, sourceUnit: 'student-support', sourceLabel: STAFF_UNITS['student-support'].label, targetUnit: recipientUnit, targetLabel: STAFF_UNITS[recipientUnit].label, officeName, officeEmail, comment, status: 'registered', createdAt: now, reassignmentHistory: [] });
    ticket.registrations = Array.isArray(ticket.registrations) ? ticket.registrations : [];
    if (!ticket.registrations.some(item => item.unitId === recipientUnit)) ticket.registrations.push({ unitId:recipientUnit, unitLabel:STAFF_UNITS[recipientUnit].label, role:'responsible-unit', registeredAt:now, status:'active' });
    ticket.staffAssignments = Array.isArray(ticket.staffAssignments) ? ticket.staffAssignments : [];
    for (const assignment of ticket.staffAssignments) {
      if (assignment.unitId === ticket.ownerUnitId && !['resolved','superseded'].includes(assignment.state)) {
        assignment.state = 'superseded'; assignment.supersededAt = now; assignment.supersededBy = req.supportIdentity?.name || 'Student Support Services';
      }
    }
    ticket.ownerUnit = STAFF_UNITS[recipientUnit].label;
    ticket.ownerUnitId = recipientUnit;
    ticket.supportUnit = STAFF_UNITS['student-support'].label;
    ticket.supportFollowUp = true;
    ticket.assignedCaseOwner = '';
    ticket.assignedCaseEmail = '';
    ticket.status = 'assigned';
    ticket.lastUpdatedAt = now;
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.auditTrail.push({ action: `Forwarded to ${officeName}`, note: comment, at: now, by: req.supportIdentity?.name || 'Support administrator' });
    if (ticket.auditTrail.length > 100) ticket.auditTrail = ticket.auditTrail.slice(-100);
    ticketForEmail = JSON.parse(JSON.stringify(ticket));
    return ticket;
  });
  if (ticketForEmail === 'forbidden') return res.status(403).json({ error: 'You do not have access to this restricted case.' });
  if (ticketForEmail === 'restricted-route') return res.status(400).json({ error: 'Sensitive cases may only be referred to the Confidential Case Handler or Provost.' });
  if (!ticketForEmail) return res.status(404).json({ error: 'Support ticket not found.' });
  if (!recipientEmails.length) return res.json({ ok: true, reference: ticketForEmail.reference, expiresAt, emailStatus: 'unit-unassigned', message: 'The case is registered in the receiving unit portal. Assign an officer account to notify the unit.' });
  if (!supportEmailsAreInstitutional(recipientEmails)) return res.json({ ok: true, reference: ticketForEmail.reference, expiresAt, emailStatus: 'blocked', message: 'The case is registered, but notification was blocked because the unit email is not institutional.' });
  if (!gmailConfigured()) return res.json({ ok: true, reference: ticketForEmail.reference, expiresAt, emailStatus: 'not-configured', message: 'The case is registered in the receiving unit portal. Email notification is not configured yet.' });
  const secureUrl = `${baseUrlFor(req)}/secure/support/${rawToken}`;
  try {
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">Student Support matter forwarded</h2><p>Student Support Services has forwarded a matter for your office's attention.</p><div style="margin:18px 0;padding:16px;background:#f5f8fb;border-left:4px solid #d4a72c"><strong>Reference:</strong> ${htmlEscape(ticketForEmail.reference)}<br><strong>Category:</strong> ${htmlEscape(ticketForEmail.categoryLabel)}<br><strong>Learner level:</strong> ${htmlEscape(ticketForEmail.studyLevelLabel || 'Not stated')}<br><strong>Subject:</strong> ${htmlEscape(ticketForEmail.subject)}</div><p><strong>Student Support comments</strong><br>${htmlEscape(comment).replace(/\n/g, '<br>')}</p><p><a href="${htmlEscape(secureUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:7px;font-weight:bold">Open the confidential case file</a></p><p>This secure link includes the submitted evidence and expires on ${htmlEscape(new Date(expiresAt).toLocaleDateString('en-GB'))}. Do not forward it outside your office.</p><p>Regards,<br>Student Support Services<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
    const results = await Promise.all(recipientEmails.map(to => sendGmailHtmlEmail({ to, subject: `Action required: ${ticketForEmail.reference} - ${ticketForEmail.subject}`, html })));
    await mutateSupportTickets(tickets => {
      const item=tickets.find(item => item.id === req.params.id);
      const forward = item?.forwardHistory?.find(item => item.id === forwardId);
      if (forward) { forward.status = 'sent'; forward.sentAt = new Date().toISOString(); forward.messageId = results[0]?.id || ''; forward.recipientCount = recipientEmails.length; }
      const referral=item?.referrals?.find(item=>item.id===forwardId);
      if(referral){referral.status='sent';referral.sentAt=new Date().toISOString();}
      return tickets;
    });
    return res.json({ ok: true, reference: ticketForEmail.reference, expiresAt, emailStatus: 'sent' });
  } catch (error) {
    console.error('Support ticket forwarding failed:', error);
    await mutateSupportTickets(tickets => {
      const item=tickets.find(item => item.id === req.params.id);
      const forward = item?.forwardHistory?.find(item => item.id === forwardId);
      if (forward) { forward.status = 'failed'; forward.error = String(error.message || 'Email delivery failed').slice(0, 500); }
      const referral=item?.referrals?.find(item=>item.id===forwardId);
      if(referral){referral.status='registered';referral.deliveryError=String(error.message||'Email delivery failed').slice(0,500);}
      return tickets;
    });
    return res.json({ ok: true, reference: ticketForEmail.reference, expiresAt, emailStatus: 'failed', message: 'The case is registered in the receiving unit portal, but the email notification could not be delivered.' });
  }
});

function activeReferralForUnits(ticket, unitIds) {
  const allowed = new Set(normalizeStaffUnits(unitIds));
  return [...(Array.isArray(ticket?.referrals) ? ticket.referrals : [])].reverse().find(referral =>
    allowed.has(referral.targetUnit) && !['reassigned', 'closed', 'cancelled', 'resolved', 'returned-to-support'].includes(referral.status)
  ) || null;
}
async function reassignSupportReferral(ticketId, { targetUnit, note, actor, sourceUnits, allowUnassigned=false }) {
  let result = { state: 'not-found' };
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.id === ticketId);
    if (!ticket) return tickets;
    if (ticket.sensitive && !['confidential-handler','provost'].includes(targetUnit)) { result = { state: 'restricted-route' }; return tickets; }
    ticket.referrals = Array.isArray(ticket.referrals) ? ticket.referrals : [];
    const current = activeReferralForUnits(ticket, sourceUnits);
    if (!current && !allowUnassigned) { result = { state: 'not-assigned' }; return tickets; }
    const sourceUnit = current?.targetUnit || 'student-support';
    if (sourceUnit === targetUnit) { result = { state: 'same-unit' }; return tickets; }
    const now = new Date().toISOString();
    if (current) {
      current.status = 'reassigned';
      current.reassignedAt = now;
      current.reassignmentHistory = Array.isArray(current.reassignmentHistory) ? current.reassignmentHistory : [];
      current.reassignmentHistory.push({ at: now, by: actor, targetUnit, targetLabel: STAFF_UNITS[targetUnit].label, note });
    }
    const referral = {
      id: crypto.randomUUID(), sourceUnit, sourceLabel: STAFF_UNITS[sourceUnit]?.label || sourceUnit,
      targetUnit, targetLabel: STAFF_UNITS[targetUnit].label, status: 'assigned', origin: 'reassignment', comment: note,
      createdAt: now, reassignmentHistory: []
    };
    ticket.referrals.push(referral);
    ticket.registrations = Array.isArray(ticket.registrations) ? ticket.registrations : [];
    if (!ticket.registrations.some(item => item.unitId === targetUnit)) {
      ticket.registrations.push({ unitId:targetUnit, unitLabel:STAFF_UNITS[targetUnit].label, role:'responsible-unit', registeredAt:now, status:'active' });
    }
    ticket.staffAssignments = Array.isArray(ticket.staffAssignments) ? ticket.staffAssignments : [];
    for (const assignment of ticket.staffAssignments) {
      if (assignment.unitId === sourceUnit && !['resolved','superseded'].includes(assignment.state)) {
        assignment.state = 'superseded';
        assignment.supersededAt = now;
        assignment.supersededBy = actor;
      }
    }
    ticket.ownerUnit = STAFF_UNITS[targetUnit].label;
    ticket.ownerUnitId = targetUnit;
    ticket.assignedCaseOwner = '';
    ticket.assignedCaseEmail = '';
    ticket.status = 'assigned';
    ticket.lastUpdatedAt = now;
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.auditTrail.push({ action: `Case reassigned from ${STAFF_UNITS[sourceUnit]?.label || sourceUnit} to ${STAFF_UNITS[targetUnit].label}`, note, at: now, by: actor });
    ticket.studentUpdates = Array.isArray(ticket.studentUpdates) ? ticket.studentUpdates : [];
    ticket.studentUpdates.push({ label: 'Case reassigned', message: `Your case has been reassigned to ${STAFF_UNITS[targetUnit].label} for continued action.`, at: now });
    if (ticket.auditTrail.length > 100) ticket.auditTrail = ticket.auditTrail.slice(-100);
    result = { state: 'ok', ticket: JSON.parse(JSON.stringify(ticket)), referral };
    return ticket;
  });
  return result;
}
function reassignSupportReferralResponse(result, res, req) {
  if (result.state === 'not-found') return res.status(404).json({ error: 'Support ticket not found.' });
  if (result.state === 'not-assigned') return res.status(403).json({ error: 'This case is not currently assigned to one of your functional units.' });
  if (result.state === 'same-unit') return res.status(400).json({ error: 'Choose a different functional unit for reassignment.' });
  if (result.state === 'restricted-route') return res.status(400).json({ error: 'Sensitive cases may only be reassigned to the Confidential Case Handler or Provost.' });
  sendSupportStudentUpdateEmail(result.ticket, { label: 'Case reassigned', message: `Your case has been reassigned to ${result.referral.targetLabel} for continued action.` }, req).catch(error => console.error('Support reassignment email failed:', error.message));
  return res.json({ ok: true, reference: result.ticket.reference, referral: result.referral });
}
app.post('/api/support/admin/tickets/:id/reassign', supportWorkspaceAuth, requireSupportRole('officer'), async (req, res) => {
  const targetUnit = String(req.body?.targetUnit || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  if (!Object.prototype.hasOwnProperty.call(STAFF_UNITS, targetUnit)) return res.status(400).json({ error: 'Select the receiving functional unit.' });
  if (!note) return res.status(400).json({ error: 'Provide reassignment comments for the receiving unit.' });
  const result = await reassignSupportReferral(req.params.id, { targetUnit, note, actor: req.supportIdentity?.name || 'Student Support Services', sourceUnits: ['student-support'], allowUnassigned: true });
  return reassignSupportReferralResponse(result, res, req);
});

function secureSupportAssignmentPage(ticket, assignment, token, notice = '') {
  const state=supportAssignmentState(assignment);
  const framedEvidence=(files,collection,emptyText)=>Array.isArray(files)&&files.length
    ? `<div class="assignment-evidence">${files.map((file,index)=>{const url=`/secure/support-assignment/${encodeURIComponent(token)}/${collection}/${index}`;const name=htmlEscape(file.originalName||`Evidence ${index+1}`);return `<section><strong>${name}</strong><iframe src="${url}" title="${name}"></iframe><a href="${url}?download=1">Download original</a></section>`;}).join('')}</div>`
    : `<p>${emptyText}</p>`;
  const resolved=assignment.state==='resolved';
  const checklist=SUPPORT_ASSIGNMENT_CHECKS.map(item=>`<label class="resolution-check"><input type="checkbox" name="${item.id}" value="yes" ${resolved?'checked disabled':'required'}><span>${htmlEscape(item.label)}</span></label>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(ticket.reference)} Staff Assignment</title><style>:root{--navy:#082b4c;--gold:#d4a72c;--green:#238154;--red:#c6404d;--yellow:#d79a00;--line:#d9e3ea}*{box-sizing:border-box}body{margin:0;background:#f4f7fa;color:#172431;font:16px/1.55 Arial,sans-serif}.wrap{max-width:960px;margin:32px auto;padding:0 18px 50px}.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:0 10px 28px rgba(15,38,61,.08);margin-bottom:18px}h1,h2{color:var(--navy)}h1{font-size:28px;margin:4px 0}.eyebrow{color:#956f00;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.state{display:inline-flex;padding:7px 11px;border-radius:999px;font-weight:800;font-size:14px}.state-red{background:#fde8ea;color:#982b38}.state-yellow{background:#fff1c9;color:#795400}.state-green{background:#def3e7;color:#11683a}.meta{display:grid;grid-template-columns:180px 1fr;gap:8px 14px;padding:15px;background:#f4f8fb;border-radius:9px}.copy{white-space:pre-wrap}.assignment-evidence{display:grid;gap:16px}.assignment-evidence section{display:grid;gap:8px}.assignment-evidence iframe{width:100%;height:430px;border:1px solid var(--line);border-radius:8px}.assignment-evidence a{color:var(--navy);font-weight:800}.resolution-form{display:grid;gap:12px}.resolution-check{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:9px}.resolution-check input{width:20px;height:20px;accent-color:var(--green)}textarea{width:100%;min-height:120px;padding:11px;border:1px solid #b9c7d1;border-radius:8px;font:inherit}.button{border:0;border-radius:8px;background:var(--green);color:#fff;padding:12px 17px;font:inherit;font-weight:800;cursor:pointer}.notice{padding:12px 14px;border-left:4px solid var(--green);background:#eaf7ef;color:#145f38;margin-bottom:16px}@media(max-width:650px){.meta{grid-template-columns:1fr}.assignment-evidence iframe{height:320px}}</style></head><body><main class="wrap">${notice?`<div class="notice">${htmlEscape(notice)}</div>`:''}<section class="card"><span class="eyebrow">Assigned staff workspace</span><h1>${htmlEscape(ticket.reference)}</h1><p><span class="state state-${state.colour}">${htmlEscape(state.label)}</span></p><div class="meta"><b>Functional unit</b><span>${htmlEscape(assignment.unitLabel)}</span><b>Assigned staff</b><span>${htmlEscape(assignment.officerName)} · ${htmlEscape(assignment.officerEmail)}</span><b>Type</b><span>${htmlEscape(ticket.type==='service-request'?'Service request':'Complaint')}</span><b>Category</b><span>${htmlEscape(ticket.categoryLabel)}</span><b>Student</b><span>${htmlEscape(ticket.name)} · ${htmlEscape(ticket.studentNumber||'Number not stated')}</span><b>Study centre</b><span>${htmlEscape(ticket.studyCentre||'Not stated')}</span><b>Subject</b><span>${htmlEscape(ticket.subject)}</span></div><h2>Student submission</h2><p class="copy">${htmlEscape(ticket.description)}</p></section><section class="card"><h2>Student evidence</h2>${framedEvidence(ticket.evidence,'evidence','No student evidence was attached.')}<h2>Officer evidence</h2>${framedEvidence(ticket.officerEvidence,'officer-evidence','No officer evidence has been added.')}</section><section class="card"><h2>${resolved?'Resolution completed':'Complete this assignment'}</h2>${resolved?`<p><strong>Resolved:</strong> ${htmlEscape(new Date(assignment.resolvedAt).toLocaleString('en-GB'))}</p><p class="copy">${htmlEscape(assignment.resolutionNote)}</p>`:`<p>All three confirmations and a clear resolution note are required. Completing this form changes the assignment indicator from yellow to green in every authorised register.</p><form class="resolution-form" method="post" action="/secure/support-assignment/${encodeURIComponent(token)}/resolve">${checklist}<label><strong>Resolution provided to the student and oversight units</strong><textarea name="resolutionNote" minlength="10" maxlength="4000" required></textarea></label><button class="button" type="submit">Mark complaint or request resolved</button></form>`}</section></main></body></html>`;
}

async function secureSupportAssignmentAuth(req, res, next) {
  return staffAuth(req, res, async () => {
    const match = supportAssignmentForToken(await readSupportTickets(), req.params.token);
    if (!match || match.assignment.state === 'superseded') return res.status(404).send('This staff assignment link is unavailable.');
    const identity = req.staffIdentity || {};
    const accountEmail = String(identity.email || '').trim().toLowerCase();
    const assignedEmail = String(match.assignment.officerEmail || '').trim().toLowerCase();
    const unitAdministrator = identity.role === 'administrator' && normalizeStaffUnits(identity.units).includes(match.assignment.unitId);
    if (!accountEmail || (accountEmail !== assignedEmail && !unitAdministrator)) return res.status(403).send('This assignment belongs to another staff account. Sign out and use the institutional account named in the assignment email.');
    req.supportAssignmentMatch = match;
    return next();
  });
}

app.get('/secure/support-assignment/:token', secureSupportAssignmentAuth, async(req,res)=>{
  const match=req.supportAssignmentMatch;
  if(new Date(match.assignment.expiresAt).getTime()<=Date.now()&&match.assignment.state!=='resolved')return res.status(410).send('This staff assignment link has expired. Ask the functional-unit administrator to assign the case again.');
  if(match.assignment.state==='unopened'){
    const now=new Date().toISOString();
    await mutateSupportTickets(tickets=>{const ticket=tickets.find(item=>item.id===match.ticket.id),assignment=ticket?.staffAssignments?.find(item=>item.id===match.assignment.id);if(!ticket||!assignment)return tickets;assignment.state='opened';assignment.openedAt=now;ticket.lastUpdatedAt=now;if(ticket.ownerUnitId===assignment.unitId&&!['resolved','final-decision','closed','accepted'].includes(ticket.status))ticket.status='in-progress';const referral=[...(ticket.referrals||[])].reverse().find(item=>item.targetUnit===assignment.unitId&&!['reassigned','resolved','closed'].includes(item.status));if(referral){referral.status='opened';referral.openedAt=now;}ticket.auditTrail=Array.isArray(ticket.auditTrail)?ticket.auditTrail:[];ticket.auditTrail.push({action:`Assignment opened by ${assignment.officerEmail}`,note:'Register indicator changed from red to yellow.',at:now,by:assignment.officerName||assignment.officerEmail});return tickets;});
    match.assignment.state='opened';match.assignment.openedAt=now;
  }
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  return res.send(secureSupportAssignmentPage(match.ticket,match.assignment,req.params.token));
});
app.post('/secure/support-assignment/:token/resolve', secureSupportAssignmentAuth, supportSameOrigin, async(req,res)=>{
  const checks=Object.fromEntries(SUPPORT_ASSIGNMENT_CHECKS.map(item=>[item.id,String(req.body?.[item.id]||'')==='yes']));
  const resolutionNote=String(req.body?.resolutionNote||'').trim().slice(0,4000);
  if(Object.values(checks).some(value=>!value)||resolutionNote.length<10)return res.status(400).send('Complete all resolution checkboxes and provide a clear resolution note of at least 10 characters.');
  const found=supportAssignmentForToken(await readSupportTickets(),req.params.token);
  if(!found||found.assignment.state==='superseded')return res.status(404).send('This staff assignment link is unavailable.');
  if(new Date(found.assignment.expiresAt).getTime()<=Date.now()&&found.assignment.state!=='resolved')return res.status(410).send('This staff assignment link has expired.');
  const now=new Date().toISOString();let updated=null,isResponsible=false;
  await mutateSupportTickets(tickets=>{const ticket=tickets.find(item=>item.id===found.ticket.id),assignment=ticket?.staffAssignments?.find(item=>item.id===found.assignment.id);if(!ticket||!assignment)return tickets;assignment.state='resolved';assignment.resolvedAt=assignment.resolvedAt||now;assignment.checks=checks;assignment.resolutionNote=resolutionNote;ticket.lastUpdatedAt=now;isResponsible=ticket.ownerUnitId===assignment.unitId;if(isResponsible){ticket.status='resolved';ticket.resolution=resolutionNote;ticket.resolvedAt=now;ticket.resolvedBy=assignment.officerName||assignment.officerEmail;ticket.studentResponseDueAt=supportMoveWorkingDays(now,5);ticket.studentUpdates=Array.isArray(ticket.studentUpdates)?ticket.studentUpdates:[];ticket.studentUpdates.push({label:'Resolution proposed',message:resolutionNote,at:now});}const referral=[...(ticket.referrals||[])].reverse().find(item=>item.targetUnit===assignment.unitId&&!['reassigned','closed'].includes(item.status));if(referral){referral.status='resolved';referral.resolvedAt=now;}ticket.auditTrail=Array.isArray(ticket.auditTrail)?ticket.auditTrail:[];ticket.auditTrail.push({action:`Assignment resolved by ${assignment.officerEmail}`,note:`Register indicator changed to green. ${resolutionNote}`,at:now,by:assignment.officerName||assignment.officerEmail});updated=JSON.parse(JSON.stringify(ticket));return tickets;});
  if(!updated)return res.status(404).send('This staff assignment link is unavailable.');
  if(isResponsible)sendSupportStudentUpdateEmail(updated,{label:'Resolution proposed',message:resolutionNote},req).catch(error=>console.error('Assigned-staff resolution email failed:',error.message));
  const assignment=updated.staffAssignments.find(item=>item.id===found.assignment.id);
  res.setHeader('Cache-Control','no-store');
  return res.send(secureSupportAssignmentPage(updated,assignment,req.params.token,'Resolution recorded. The assignment indicator is now green in every authorised register.'));
});
app.get('/secure/support-assignment/:token/:collection/:index', secureSupportAssignmentAuth, async(req,res)=>{
  const match=req.supportAssignmentMatch;
  if(new Date(match.assignment.expiresAt).getTime()<=Date.now()&&match.assignment.state!=='resolved')return res.status(410).send('This staff assignment link has expired.');
  const collection=req.params.collection==='officer-evidence'?'officerEvidence':req.params.collection==='evidence'?'evidence':'';
  if(!collection)return res.status(404).send('Evidence file not found.');
  const evidence=supportEvidenceFor(match.ticket,req.params.index,collection);
  if(!evidence)return res.status(404).send('Evidence file not found.');
  res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
  return sendSupportEvidence(req,res,evidence);
});

app.get('/secure/support/:token', async (req, res) => {
  const match = supportForwardForToken(await readSupportTickets(), req.params.token);
  if (!match || match.forward.status !== 'sent' || new Date(match.forward.expiresAt).getTime() < Date.now()) return res.status(404).send('This confidential support link is invalid or has expired.');
  return res.type('html').send(secureSupportForwardPage(match.ticket, match.forward, req.params.token));
});
app.get('/secure/support/:token/evidence/:index', async (req, res) => {
  const match = supportForwardForToken(await readSupportTickets(), req.params.token);
  if (!match || match.forward.status !== 'sent' || new Date(match.forward.expiresAt).getTime() < Date.now()) return res.status(404).send('This confidential support link is invalid or has expired.');
  const evidence = supportEvidenceFor(match.ticket, req.params.index);
  if (!evidence) return res.status(404).send('Evidence file not found.');
  return sendSupportEvidence(req, res, evidence);
});
app.get('/secure/support/:token/officer-evidence/:index', async (req, res) => {
  const match = supportForwardForToken(await readSupportTickets(), req.params.token);
  if (!match || match.forward.status !== 'sent' || new Date(match.forward.expiresAt).getTime() < Date.now()) return res.status(404).send('This confidential support link is invalid or has expired.');
  const evidence = supportEvidenceFor(match.ticket, req.params.index, 'officerEvidence');
  if (!evidence) return res.status(404).send('Officer evidence file not found.');
  return sendSupportEvidence(req, res, evidence);
});

// 1. UNDERGRADUATE PROJECT WORK
app.post('/api/project-work', upload.fields([
  { name: 'claimForm', maxCount: 1 }, { name: 'reportFile', maxCount: 1 },
  { name: 'completedWork', maxCount: 25 }, { name: 'scoresFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const department = validateDepartment(req);
    if (!department) { await removeUploaded(req); return res.status(400).json({ error: 'Please select a valid department.' }); }
    const missing = requireText(req, ['title','firstName','lastName','phone','email','groupCount']);
    if (missing) { await removeUploaded(req); return res.status(400).json({ error: `Missing required field: ${missing}` }); }
    const selectedCentres=textList(req,'studyCentre');
    if(!selectedCentres.length){await removeUploaded(req);return res.status(400).json({error:'Select at least one study centre.'});}
    const allowedCentres=await readProjectStudyCentres(department);
    if(selectedCentres.some(c=>!allowedCentres.includes(c))){await removeUploaded(req);return res.status(400).json({error:'One or more selected study centres are not published for this department.'});}
    if(selectedCentres.includes('Non-Residential')&&selectedCentres.length>1){await removeUploaded(req);return res.status(400).json({error:'Non-Residential cannot be combined with Distance study centres in the same submission.'});}
    if (!filesFor(req,'claimForm').length || !filesFor(req,'reportFile').length || !filesFor(req,'completedWork').length || !filesFor(req,'scoresFile').length) {
      await removeUploaded(req); return res.status(400).json({ error: 'Claim form, report, score sheet and completed project work are required.' });
    }
    let scoreResult;
    try { scoreResult = parseScoreWorkbook(filesFor(req,'scoresFile')[0].path); }
    catch (e) { await removeUploaded(req); return res.status(400).json({ error: e.message }); }
    const claimedGroupCount=parseFlexiblePositiveCount(text(req,'groupCount'));
    const groupNumbers=projectUniqueGroupNumbersFromRows(scoreResult.rows);
    const completedProjectWorkCount=filesFor(req,'completedWork').length;
    if(!claimedGroupCount){await removeUploaded(req);return res.status(400).json({error:'Enter Total Number of Groups Submitting as a number or words, for example 8, eight, eight (8), or eight(8).'});}
    if(groupNumbers.length!==claimedGroupCount || completedProjectWorkCount!==claimedGroupCount){
      const parts=[`Claim form/portal total: ${claimedGroupCount}`,`Distinct groups in score sheet: ${groupNumbers.length}`,`Completed project works attached: ${completedProjectWorkCount}`];
      await removeUploaded(req);
      return res.status(400).json({error:`The number being claimed cannot be different from the completed supervised project works. ${parts.join(' · ')}. Correct the Total Number of Groups Submitting, GROUP NO. entries, or project-work attachments before submitting.`});
    }
    const record = {
      id: crypto.randomUUID(), portalType: 'project-work', department, departmentName: DEPARTMENTS[department].name,
      reference: makeReference('PWORK'), submittedAt: new Date().toISOString(),
      title:text(req,'title'), firstName:text(req,'firstName'), lastName:text(req,'lastName'),
      fullName:buildDisplayName(text(req,'title'),text(req,'firstName'),text(req,'lastName')),
      phone: text(req,'phone'), email: text(req,'email'), groupCount: text(req,'groupCount'), claimedGroupCount, studyCentres:selectedCentres, studyCentre:selectedCentres.join(' | '),
      projectStream: selectedCentres.length===1 && selectedCentres[0] === 'Non-Residential' ? 'non-residential' : 'distance',
      scoreSheet: { worksheet: scoreResult.sheetName, headerRow: scoreResult.headerRow, rowCount: scoreResult.rows.length, rows: scoreResult.rows },
      groupValidation:{claimedGroupCount,scoreSheetGroupCount:groupNumbers.length,groupNumbers,completedProjectWorkCount,valid:true,validatedAt:new Date().toISOString()},
      reviewStatus:'pending', reviewNote:'', reviewedAt:null, reviewedBy:'', reviewHistory:[],
      files: {
        claimForm: fileRecord(filesFor(req,'claimForm')[0]), reportFile: fileRecord(filesFor(req,'reportFile')[0]),
        scoresFile: fileRecord(filesFor(req,'scoresFile')[0]), completedWork: filesFor(req,'completedWork').map(fileRecord)
      }
    };
    await saveRecord(record);
    res.status(201).json({ ok:true, reference:record.reference, submittedAt:record.submittedAt, departmentName:record.departmentName, scoreRowsIncluded:scoreResult.rows.length, projectStream:record.projectStream, reviewStatus:'pending', reviewStatusLabel:'Pending Verification' });
  } catch (e) { console.error(e); await removeUploaded(req).catch(()=>{}); res.status(500).json({ error:'The project work submission could not be saved.' }); }
});

// 1B. FIELD EXPERIENCE AND TEACHING PRACTICE SCORES
app.post('/api/field-experience', upload.fields([
  { name: 'scoresFile', maxCount: 1 },
  { name: 'claimForm', maxCount: 1 }
]), async (req, res) => {
  try {
    const department = validateDepartment(req);
    if (!department) { await removeUploaded(req); return res.status(400).json({ error: 'Please select a valid department.' }); }
    const missing = requireText(req, ['title','firstName','lastName','phone','email','groupCount','assessmentType']);
    if (missing) { await removeUploaded(req); return res.status(400).json({ error: `Missing required field: ${missing}` }); }
    const assessmentType=text(req,'assessmentType');
    const assessmentSpec=fieldAssessmentSpec(assessmentType);
    if(!assessmentSpec){await removeUploaded(req);return res.status(400).json({error:'Please select a valid Field Experience or Teaching Practice assessment type.'});}
    const selectedCentres=textList(req,'studyCentre');
    if(!selectedCentres.length){await removeUploaded(req);return res.status(400).json({error:'Please select at least one study centre.'});}
    const allowedCentres=await readStudyCentres(department);
    const invalidCentres=selectedCentres.filter(c=>!allowedCentres.includes(c));
    if(invalidCentres.length){await removeUploaded(req);return res.status(400).json({error:`The following study centre selection is not published for this department: ${invalidCentres.join(', ')}.`});}
    const portalSettings=await readPortalSettings();
    if (portalSettings.fieldExperienceClaimFormRequired && !filesFor(req,'claimForm').length) {
      await removeUploaded(req); return res.status(400).json({ error: 'The Claim Form is currently compulsory for Field Experience and Teaching Practice submissions.' });
    }
    if (!filesFor(req,'scoresFile').length) {
      await removeUploaded(req); return res.status(400).json({ error: `The ${assessmentSpec.label} score sheet is required.` });
    }
    let scoreResult;
    try { scoreResult = parseFieldExperienceWorkbook(filesFor(req,'scoresFile')[0].path,assessmentType); }
    catch (e) { await removeUploaded(req); return res.status(400).json({ error: e.message }); }
    const claimedCandidateCount=parseFlexiblePositiveCount(text(req,'groupCount'));
    if(!claimedCandidateCount){await removeUploaded(req);return res.status(400).json({error:'Enter Number of Students / Candidates as a positive number.'});}
    if(claimedCandidateCount!==scoreResult.rows.length){await removeUploaded(req);return res.status(400).json({error:`The number being claimed cannot be different from the extracted score rows. Claim form/portal total: ${claimedCandidateCount} · Score rows extracted: ${scoreResult.rows.length}. Correct the Number of Students / Candidates or the score sheet before submitting.`});}
    const record = {
      id: crypto.randomUUID(), portalType: 'field-experience', department, departmentName: DEPARTMENTS[department].name,
      reference: makeReference('FIELD'), submittedAt: new Date().toISOString(),
      assessmentType, assessmentLabel:assessmentSpec.label,
      title:text(req,'title'), firstName:text(req,'firstName'), lastName:text(req,'lastName'),
      fullName:buildDisplayName(text(req,'title'),text(req,'firstName'),text(req,'lastName')),
      phone: text(req,'phone'), email: text(req,'email'), groupCount: text(req,'groupCount'), claimedCandidateCount, studyCentres:selectedCentres, studyCentre:selectedCentres.join(' | '),
      scoreSheet: {
        worksheet: scoreResult.sheetName,
        headerRow: scoreResult.headerRow,
        rowCount: scoreResult.rows.length,
        scoreHeaders: scoreResult.scoreHeaders,
        rows: scoreResult.rows
      },
      fieldValidation:{claimedCandidateCount,scoreRowCount:scoreResult.rows.length,valid:true,validatedAt:new Date().toISOString()},
      reviewStatus:'pending', reviewNote:'', reviewedAt:null, reviewedBy:'', reviewHistory:[],
      files: { scoresFile: fileRecord(filesFor(req,'scoresFile')[0]), claimForm: fileRecord(filesFor(req,'claimForm')[0]) }
    };
    await saveRecord(record);
    res.status(201).json({
      ok:true,
      reference:record.reference,
      submittedAt:record.submittedAt,
      departmentName:record.departmentName,
      assessmentType,
      assessmentLabel:assessmentSpec.label,
      scoreRowsIncluded:scoreResult.rows.length,
      studyCentres:selectedCentres,
      reviewStatus:'pending',
      reviewStatusLabel:'Pending Verification'
    });
  } catch (e) {
    console.error(e);
    await removeUploaded(req).catch(()=>{});
    res.status(500).json({ error:'The Field Experience and Teaching Practice score submission could not be saved.' });
  }
});

// 2. STUDENT DISSERTATION
app.post('/api/dissertation', upload.fields([
  { name:'dissertationFile', maxCount:1 },
  { name:'revisedDissertationFile', maxCount:1 },
  { name:'finalDissertationFile', maxCount:1 },
  { name:'reviewerResponses', maxCount:10 },
  { name:'turnitinReport', maxCount:1 }
]), async (req, res) => {
  try {
    const department=validateDepartment(req);
    if(!department){await removeUploaded(req);return res.status(400).json({error:'Please select a valid department.'});}
    const submissionType=text(req,'submissionType');
    if(!['fresh','revised','final'].includes(submissionType)){await removeUploaded(req);return res.status(400).json({error:'Select Fresh Submission, Revised Submission or Final Dissertation.'});}
    const missing=requireText(req,['studentTitle','studentFirstName','studentLastName','indexNumber','phone','email','supervisorTitle','supervisorFirstName','supervisorLastName','programme','dissertationTopic']);
    if(missing){await removeUploaded(req);return res.status(400).json({error:`Missing required field: ${missing}`});}
    const freshFile=filesFor(req,'dissertationFile')[0]||null;
    const revisedFile=filesFor(req,'revisedDissertationFile')[0]||null;
    const finalFile=filesFor(req,'finalDissertationFile')[0]||null;
    const reviewerResponses=filesFor(req,'reviewerResponses');
    const turnitinReport=filesFor(req,'turnitinReport')[0]||null;
    const dissertationFile=submissionType==='final'?finalFile:(submissionType==='revised'?revisedFile:freshFile);
    if(!dissertationFile){await removeUploaded(req);return res.status(400).json({error:submissionType==='final'?'The final dissertation file is required.':submissionType==='revised'?'The revised dissertation file is required.':'The dissertation file is required.'});}
    if(['revised','final'].includes(submissionType)&&!reviewerResponses.length){await removeUploaded(req);return res.status(400).json({error:"At least one reviewer-response file is required for revised and final submissions."});}
    if(submissionType==='final'&&!turnitinReport){await removeUploaded(req);return res.status(400).json({error:'The plagiarism (Turnitin) report is required for the final dissertation submission.'});}
    const ext=path.extname(dissertationFile.originalname||'').toLowerCase();
    if(!['.pdf','.doc','.docx'].includes(ext)){await removeUploaded(req);return res.status(400).json({error:'Upload the dissertation as a PDF, DOC or DOCX file.'});}
    let titleValidation;
    try{titleValidation=await validateDissertationTitleAgainstFile(text(req,'dissertationTopic'),dissertationFile);}
    catch(e){await removeUploaded(req);return res.status(400).json({error:e.message||String(e)});}
    const all=await readDb();
    const parent=dissertationLineageParent(all,department,text(req,'indexNumber'),submissionType);
    const studentName=buildDisplayName(text(req,'studentTitle'),text(req,'studentFirstName'),text(req,'studentLastName'));
    const supervisorName=buildDisplayName(text(req,'supervisorTitle'),text(req,'supervisorFirstName'),text(req,'supervisorLastName'));
    const id=crypto.randomUUID();
    const record={
      id,portalType:'dissertation',submissionType,department,departmentName:DEPARTMENTS[department].name,
      reference:makeReference(submissionType==='final'?'DFINAL':submissionType==='revised'?'DREV':'DISS'),submittedAt:new Date().toISOString(),processingStatus:'received',
      lineageId:parent?.lineageId||parent?.id||id,previousSubmissionId:parent?.id||null,previousDissertationTopic:parent?.dissertationTopic||'',
      studentTitle:text(req,'studentTitle'),studentFirstName:text(req,'studentFirstName'),studentLastName:text(req,'studentLastName'),studentName,
      indexNumber:text(req,'indexNumber'),phone:text(req,'phone'),email:text(req,'email'),
      supervisorTitle:text(req,'supervisorTitle'),supervisorFirstName:text(req,'supervisorFirstName'),supervisorLastName:text(req,'supervisorLastName'),supervisorName,
      programme:text(req,'programme'),dissertationTopic:text(req,'dissertationTopic'),titleValidation,
      files:{dissertationFile:fileRecord(dissertationFile),reviewerResponses:reviewerResponses.map(fileRecord),turnitinReport:turnitinReport?fileRecord(turnitinReport):null}
    };
    all.push(record); await writeDb(all);
    res.status(201).json({ok:true,reference:record.reference,submittedAt:record.submittedAt,departmentName:record.departmentName,titleValidated:true,submissionType,titleChangedFromPrevious:Boolean(parent&&normalizeDissertationTitle(parent.dissertationTopic)!==normalizeDissertationTitle(record.dissertationTopic))});
  } catch(e){console.error(e);await removeUploaded(req).catch(()=>{});res.status(500).json({error:'The dissertation submission could not be saved.'});}
});

// 3. ASSESSOR / VETTING SUBMISSION
// Each declared report gets its own student fields and its own file inputs.
const assessorUploadFields = [];
for (let i = 0; i < 25; i++) {
  assessorUploadFields.push(
    { name:`reportFile_${i}`, maxCount:1 },
    { name:`claimForm_${i}`, maxCount:1 },
    { name:`scoreSheet_${i}`, maxCount:1 },
    { name:`dissertationFile_${i}`, maxCount:1 }
  );
}

// Assignment-linked report submission context. Student email remains server-side and is never editable by the assessor.
app.get('/api/assessor/assignment-context/:token', async(req,res)=>{
  const assignment=await assignmentByToken(req.params.token);
  const live=validateLiveAssignmentForSubmission(assignment);
  res.setHeader('Cache-Control','no-store');
  if(!live.ok) return res.status(live.status).json({error:live.message});
  const allRecords=await readDb();
  const records=dissertationRecords(recordsForDepartment(allRecords,assignment.department));
  const linked=(assignment.dissertationIds||[]).map(id=>records.find(r=>r.id===id)).filter(Boolean);
  if(linked.length!==(assignment.dissertationIds||[]).length) return res.status(409).json({error:'One or more dissertations in this assignment are no longer available. Contact the department administrator.'});
  const completion=assignmentWorkCompletion(assignment,allRecords);
  res.json({
    ok:true,
    assignmentReference:assignment.reference,
    assignmentType:assignment.assignmentType||'assessment',
    department:assignment.department,
    departmentName:assignment.departmentName,
    assessorTitle:assignment.assessorTitle||'',
    assessorFirstName:assignment.assessorFirstName||'',
    assessorLastName:assignment.assessorLastName||'',
    assessorName:assignment.assessorName||'',
    assessorEmail:assignment.assessorEmail||'',
    assessorPhone:assignment.assessorPhone||'',
    workCount:linked.length,
    submittedCount:completion.submittedCount,
    pendingCount:completion.pendingCount,
    downloadExpiresAt:assignment.expiresAt,
    earlyBirdDueAt:assignment.earlyBirdDueAt||assignmentDeadlineDates(new Date(assignment.sentAt||assignment.createdAt||Date.now())).earlyBirdDueAt,
    assessmentDueAt:assignment.assessmentDueAt||assignmentDeadlineDates(new Date(assignment.sentAt||assignment.createdAt||Date.now())).assessmentDueAt,
    works:linked.map((r,i)=>{
      const found=completion.submitted.get(String(r.id));
      return {
        workNo:i+1,
        studentSubmissionId:r.id,
        studentFirstName:r.studentFirstName||'',
        studentLastName:r.studentLastName||'',
        studentName:r.studentName||'',
        indexNumber:r.indexNumber||'',
        programme:r.programme||'',
        dissertationTitle:r.dissertationTopic||'',
        studentSubmissionType:r.submissionType||'fresh',
        reviewerResponseCount:Array.isArray(r.files?.reviewerResponses)?r.files.reviewerResponses.length:0,
        submitted:Boolean(found),
        reportReference:found?.record?.reference||'',
        submittedAt:found?.record?.submittedAt||null,
        earlyBirdQualified:found?earlyBirdForSubmission(assignment,found.record.submittedAt):false
      };
    })
  });
});

const assignmentWorkUpload=upload.fields([
  {name:'reportFile',maxCount:1},
  {name:'claimForm',maxCount:1},
  {name:'scoreSheet',maxCount:1},
  {name:'dissertationFile',maxCount:1}
]);

// Submit one assigned work at a time. The same assignment link can be reused for the remaining works.
app.post('/api/assessor/assignment/:token/works/:dissertationId', assignmentWorkUpload, async(req,res)=>{
  const lockKey=`${req.params.token}:${req.params.dissertationId}`;
  return withAssignmentWorkLock(lockKey, async()=>{
    try{
      const assignment=await assignmentByToken(req.params.token);
      const live=validateLiveAssignmentForSubmission(assignment);
      if(!live.ok){await removeUploaded(req);return res.status(live.status).json({error:live.message});}
      const dissertationId=String(req.params.dissertationId||'');
      if(!(assignment.dissertationIds||[]).map(String).includes(dissertationId)){await removeUploaded(req);return res.status(403).json({error:'This dissertation is not part of the secure assignment.'});}
      const allRecords=await readDb();
      const student=allRecords.find(r=>r.id===dissertationId&&r.portalType==='dissertation'&&r.department===assignment.department);
      if(!student){await removeUploaded(req);return res.status(404).json({error:'The assigned dissertation is no longer available.'});}
      const existing=assignmentSubmittedWorkMap(assignment.id,allRecords).get(dissertationId);
      if(existing){await removeUploaded(req);return res.status(409).json({error:`This work has already been submitted under reference ${existing.record.reference}. If a replacement is required, contact the department administrator.`});}
      const phone=text(req,'phone');
      if(!phone){await removeUploaded(req);return res.status(400).json({error:`Enter the ${((assignment.assignmentType||'assessment')==='vetting')?'vetter':'assessor'} telephone number before submitting this work.`});}
      const report=filesFor(req,'reportFile')[0];
      const claim=filesFor(req,'claimForm')[0];
      const scoreSheet=filesFor(req,'scoreSheet')[0];
      const reviewed=filesFor(req,'dissertationFile')[0]||null;
      const reportType=assignment.assignmentType||'assessment';
      if(!report||!claim||!scoreSheet){await removeUploaded(req);return res.status(400).json({error:`One ${reportType==='vetting'?'vetting':'assessment'} report, one claim form and one score sheet are required for this work.`});}
      const submittedAt=new Date().toISOString();
      const workNo=Math.max(1,(assignment.dissertationIds||[]).map(String).indexOf(dissertationId)+1);
      const work={
        workNo,
        studentFirstName:student.studentFirstName||'',studentLastName:student.studentLastName||'',studentName:student.studentName||'',
        indexNumber:student.indexNumber||'',programme:student.programme||'',studentEmail:student.email||'',studentSubmissionId:student.id,studentSubmissionType:student.submissionType||'fresh',
        files:{reportFile:fileRecord(report),claimForm:fileRecord(claim),scoreSheet:fileRecord(scoreSheet),dissertationFile:reviewed?fileRecord(reviewed):null}
      };
      const earlyBirdQualified=earlyBirdForSubmission(assignment,submittedAt);
      const record={
        id:crypto.randomUUID(),portalType:'assessor',reportType,department:assignment.department,departmentName:assignment.departmentName,
        reference:makeReference(reportType==='vetting'?'VET':'ASSESS'),submittedAt,
        assignmentId:assignment.id,assignmentReference:assignment.reference,assignmentWorkId:student.id,assignmentWorkNo:workNo,assignmentTotalWorks:(assignment.dissertationIds||[]).length,
        earlyBirdQualified,earlyBirdDueAt:assignment.earlyBirdDueAt||null,assessmentDueAt:assignment.assessmentDueAt||null,
        assessorTitle:assignment.assessorTitle||'',assessorFirstName:assignment.assessorFirstName||'',assessorLastName:assignment.assessorLastName||'',assessorName:assignment.assessorName||'',
        phone,email:assignment.assessorEmail||'',workCount:1,works:[work],studentName:work.studentName,indexNumber:work.indexNumber,programme:work.programme,
        claimReviewStatus:'pending',claimReviewNote:'',claimReviewedAt:null,claimReviewedBy:'',claimReviewHistory:[],
        files:{reportFile:[work.files.reportFile],claimForm:[work.files.claimForm],scoreSheet:[work.files.scoreSheet],dissertationFile:work.files.dissertationFile?[work.files.dissertationFile]:[]}
      };
      await saveRecord(record);
      if(!assignment.assessorPhone){await mutateAssignments(list=>{const a=list.find(x=>x.id===assignment.id);if(a&&!a.assessorPhone)a.assessorPhone=phone;return true;});}
      const after=await readDb();
      const completion=assignmentWorkCompletion(assignment,after);
      return res.status(201).json({ok:true,reference:record.reference,submittedAt,workNo,studentName:work.studentName,earlyBirdQualified,submittedCount:completion.submittedCount,totalWorks:completion.total,pendingCount:completion.pendingCount,allComplete:completion.submittedCount===completion.total});
    }catch(e){console.error('Assignment work submission failed:',e);await removeUploaded(req).catch(()=>{});if(!res.headersSent)res.status(500).json({error:'This report could not be saved.'});}
  });
});

app.post('/api/assessor', upload.fields(assessorUploadFields), async (req, res) => {
  try {
    const assignmentToken=text(req,'assignmentToken');
    if(assignmentToken){await removeUploaded(req);return res.status(409).json({error:'This secure assignment now uses one report submission per assigned work. Reopen the secure assignment link from your email and submit each work from that workspace.'});}
    let assignment=null;
    let linkedDissertations=[];
    let department=null;
    let reportType=text(req,'reportType');

    if(assignmentToken){
      assignment=await assignmentByToken(assignmentToken);
      const live=validateLiveAssignmentForSubmission(assignment);
      if(!live.ok){await removeUploaded(req);return res.status(live.status).json({error:live.message});}
      department=assignment.department;
      reportType=assignment.assignmentType||'assessment';
      const allRecords=await readDb();
      linkedDissertations=(assignment.dissertationIds||[]).map(id=>allRecords.find(r=>r.id===id&&r.portalType==='dissertation'&&r.department===department)).filter(Boolean);
      if(linkedDissertations.length!==(assignment.dissertationIds||[]).length){await removeUploaded(req);return res.status(409).json({error:'One or more dissertations in this assignment are no longer available. Contact the department administrator.'});}
      const existing=assessorRecords(allRecords).find(r=>r.assignmentId===assignment.id);
      if(existing){await removeUploaded(req);return res.status(409).json({error:`Reports for assignment ${assignment.reference} have already been submitted under reference ${existing.reference}. Contact the department if a replacement submission is required.`});}
    }else{
      department=validateDepartment(req);
      if (!department) { await removeUploaded(req); return res.status(400).json({ error: 'Please select a valid department.' }); }
      if(!['assessment','vetting'].includes(reportType)){await removeUploaded(req);return res.status(400).json({error:'Select Assessment Report or Vetting Report.'});}
    }

    if(!['assessment','vetting'].includes(reportType)){await removeUploaded(req);return res.status(400).json({error:'Invalid report submission type.'});}

    let assessorTitle=text(req,'assessorTitle'), assessorFirstName=text(req,'assessorFirstName'), assessorLastName=text(req,'assessorLastName'), assessorEmail=text(req,'email');
    if(assignment){
      assessorTitle=assignment.assessorTitle||'';
      assessorFirstName=assignment.assessorFirstName||'';
      assessorLastName=assignment.assessorLastName||'';
      assessorEmail=assignment.assessorEmail||'';
    }
    const phone=text(req,'phone');
    if(!assessorTitle||!assessorFirstName||!assessorLastName||!assessorEmail||!phone){await removeUploaded(req);return res.status(400).json({error:'Assessor title, first name, surname, telephone number and email are required.'});}

    const workCount=assignment ? linkedDissertations.length : Number.parseInt(text(req,'workCount'),10);
    if (!Number.isInteger(workCount) || workCount < 1 || workCount > 25) {
      await removeUploaded(req); return res.status(400).json({ error:'Number of reports must be between 1 and 25.' });
    }

    const works=[];
    for(let i=0;i<workCount;i++){
      let studentFirstName,studentLastName,indexNumber,programme,studentEmail='',studentSubmissionId=null,studentSubmissionType='';
      if(assignment){
        const student=linkedDissertations[i];
        studentFirstName=student.studentFirstName||'';
        studentLastName=student.studentLastName||'';
        indexNumber=student.indexNumber||'';
        programme=student.programme||'';
        studentEmail=student.email||'';
        studentSubmissionId=student.id;
        studentSubmissionType=student.submissionType||'fresh';
      }else{
        studentFirstName=text(req,`studentFirstName_${i}`);
        studentLastName=text(req,`studentLastName_${i}`);
        indexNumber=text(req,`indexNumber_${i}`);
        programme=text(req,`programme_${i}`);
      }
      if(!studentFirstName||!studentLastName||!indexNumber||!programme){await removeUploaded(req);return res.status(400).json({error:`Complete all required student details for Work ${i+1}.`});}
      const report=filesFor(req,`reportFile_${i}`)[0];
      const claim=filesFor(req,`claimForm_${i}`)[0];
      const scoreSheet=filesFor(req,`scoreSheet_${i}`)[0];
      const dissertation=filesFor(req,`dissertationFile_${i}`)[0]||null;
      if(!report||!claim||!scoreSheet){await removeUploaded(req);return res.status(400).json({error:`Work ${i+1} requires one ${reportType==='vetting'?'vetting':'assessment'} report, one claim form and one score sheet.`});}
      works.push({
        workNo:i+1,
        studentFirstName,studentLastName,
        studentName:buildDisplayName('',studentFirstName,studentLastName),
        indexNumber,programme,
        studentEmail,studentSubmissionId,studentSubmissionType,
        files:{reportFile:fileRecord(report),claimForm:fileRecord(claim),scoreSheet:fileRecord(scoreSheet),dissertationFile:dissertation?fileRecord(dissertation):null}
      });
    }

    const record={
      id:crypto.randomUUID(), portalType:'assessor', reportType, department, departmentName:DEPARTMENTS[department].name,
      reference:makeReference(reportType==='vetting'?'VET':'ASSESS'), submittedAt:new Date().toISOString(),
      assignmentId:assignment?.id||null, assignmentReference:assignment?.reference||'',
      assessorTitle, assessorFirstName, assessorLastName,
      assessorName:buildDisplayName(assessorTitle,assessorFirstName,assessorLastName),
      phone, email:assessorEmail, workCount,
      works,
      studentName:works.map(w=>w.studentName).join('; '),
      indexNumber:works.map(w=>w.indexNumber).join('; '),
      programme:[...new Set(works.map(w=>w.programme))].join('; '),
      claimReviewStatus:'pending',claimReviewNote:'',claimReviewedAt:null,claimReviewedBy:'',claimReviewHistory:[],
      files:{
        reportFile:works.map(w=>w.files.reportFile),
        claimForm:works.map(w=>w.files.claimForm),
        scoreSheet:works.map(w=>w.files.scoreSheet),
        dissertationFile:works.map(w=>w.files.dissertationFile).filter(Boolean)
      }
    };
    await saveRecord(record);
    res.status(201).json({ok:true,reference:record.reference,submittedAt:record.submittedAt,departmentName:record.departmentName,reportType,workCount,assignmentLinked:Boolean(assignment),reportFiles:works.length,claimForms:works.length,dissertationFiles:works.filter(w=>w.files.dissertationFile).length});
  } catch(e){console.error(e);await removeUploaded(req).catch(()=>{});res.status(500).json({error:'The report submission could not be saved.'});}
});

function recordsForDepartment(records, department) { return records.filter(r => r.department === department); }
function projectRecords(records) { return records.filter(r => r.portalType === 'project-work' || !r.portalType); }
function projectStudyCentres(record) {
  const direct=Array.isArray(record?.studyCentres)?record.studyCentres.map(cleanHumanText).filter(Boolean):[];
  if(direct.length) return [...new Set(direct)];
  const legacy=String(record?.studyCentre||'').split(/\s*\|\s*/).map(cleanHumanText).filter(Boolean);
  return [...new Set(legacy)];
}
function studyCentreDisplay(record) {
  return projectStudyCentres(record).join(', ') || String(record?.studyCentre||'').trim();
}
function projectStream(record) {
  const explicit=String(record?.projectStream||'').trim().toLowerCase();
  if(explicit==='non-residential') return 'non-residential';
  const centres=projectStudyCentres(record);
  return centres.length===1 && centres[0].toLowerCase()==='non-residential' ? 'non-residential' : 'distance';
}
function distanceProjectRecords(records) { return projectRecords(records).filter(r => projectStream(r)==='distance'); }
function nonResidentialProjectRecords(records) { return projectRecords(records).filter(r => projectStream(r)==='non-residential'); }
function fieldExperienceRecords(records) { return records.filter(r => r.portalType === 'field-experience'); }
function dissertationRecords(records) { return records.filter(r => r.portalType === 'dissertation'); }
function assessorRecords(records) { return records.filter(r => r.portalType === 'assessor'); }

const PROJECT_REVIEW_STATUSES = new Set(['pending','approved','rejected','returned']);
function projectReviewStatus(record) {
  const raw=String(record?.reviewStatus||record?.projectReview?.status||'').trim().toLowerCase();
  return PROJECT_REVIEW_STATUSES.has(raw)?raw:'pending';
}
function projectReviewLabel(status) {
  return {pending:'Pending Verification',approved:'Approved',rejected:'Rejected',returned:'Returned for Correction'}[status]||'Pending Verification';
}
function assessorClaimReviewStatus(record) {
  const raw=String(record?.claimReviewStatus||'').trim().toLowerCase();
  return PROJECT_REVIEW_STATUSES.has(raw)?raw:'pending';
}
function departmentPaymentApprovalStatus(record) {
  return record?.portalType==='assessor'?assessorClaimReviewStatus(record):projectReviewStatus(record);
}
function departmentPaymentApprovedAt(record) {
  return record?.portalType==='assessor'?(record.claimReviewedAt||''):(record.reviewedAt||'');
}
function departmentPaymentApprovedBy(record) {
  return record?.portalType==='assessor'?(record.claimReviewedBy||''):(record.reviewedBy||'');
}
function supervisorIdentityKey(record) {
  const email=String(record?.email||'').trim().toLowerCase();
  if(isEmail(email)) return `email:${email}`;
  const tokens=personNameTokens(record?.fullName||record?.name||'');
  return tokens.length?`name:${tokens.join('|')}`:'';
}
function projectAccessWarning(record) {
  const access=record?.projectSubmissionAccess||record?.submissionAccess||record?.secureSubmission||null;
  if(!access) return null;
  if(access.revokedAt||String(access.status||'').toLowerCase()==='revoked') return {code:'revoked-link',message:'Submission was made from a secure link that is now marked revoked.'};
  if(access.expiresAt && new Date(access.expiresAt).getTime()<=Date.now()) return {code:'expired-link',message:'Submission is associated with an expired secure submission link.'};
  return null;
}
function projectSubmissionWarnings(record, records) {
  if(!record) return [];
  const warnings=[];
  const stream=projectStream(record);
  const projects=projectRecords(records||[]).filter(r=>projectStream(r)===stream);
  const others=projects.filter(r=>r.id!==record.id);
  const supervisorEmail=String(record.email||'').trim().toLowerCase();
  const supervisorName=record.fullName||record.name||'';
  const sameSupervisor=others.filter(r=>{
    const otherEmail=String(r.email||'').trim().toLowerCase();
    const emailMatch=isEmail(supervisorEmail)&&isEmail(otherEmail)&&supervisorEmail===otherEmail;
    return emailMatch||samePersonName(supervisorName,r.fullName||r.name||'');
  });
  if(sameSupervisor.length) warnings.push({code:'repeat-supervisor',message:`Same supervisor/examiner has ${sameSupervisor.length} other ${stream==='non-residential'?'Non-Residential':'Distance'} project-work submission${sameSupervisor.length===1?'':'s'} in this department.`});
  const centreKeys=new Set(projectStudyCentres(record).map(c=>c.toLowerCase()));
  const sameCombo=sameSupervisor.filter(r=>projectStudyCentres(r).some(c=>centreKeys.has(c.toLowerCase())));
  if(centreKeys.size&&sameCombo.length) warnings.push({code:'repeat-supervisor-centre',message:`Same supervisor/examiner has ${sameCombo.length} other submission${sameCombo.length===1?'':'s'} sharing at least one selected study centre.`});
  const approvedOthers=others.filter(r=>projectReviewStatus(r)==='approved');
  const approvedRegMap=new Map();
  for(const other of approvedOthers){
    for(const row of approvedProjectScoreRows(other)){
      const key=normalizeIndexNumber(row.registrationNo);
      if(!key) continue;
      if(!approvedRegMap.has(key)) approvedRegMap.set(key,[]);
      approvedRegMap.get(key).push(other.reference||other.id);
    }
  }
  const duplicateRegs=[];
  for(const row of validScoreRowsWithMeta(record).filter(item=>item.included!==false)){
    const key=normalizeIndexNumber(row.registrationNo);
    if(key&&approvedRegMap.has(key)) duplicateRegs.push({registrationNo:row.registrationNo,references:approvedRegMap.get(key)});
  }
  if(duplicateRegs.length){
    const unique=[...new Map(duplicateRegs.map(x=>[normalizeIndexNumber(x.registrationNo),x])).values()];
    const sample=unique.slice(0,5).map(x=>x.registrationNo).join(', ');
    warnings.push({code:'duplicate-approved-registration',message:`Potential duplicate student detected: ${unique.length} registration number${unique.length===1?'':'s'} already appear in other approved score sheet${unique.length===1?'':'s'}${sample?`: ${sample}${unique.length>5?'…':''}`:''}. Open Duplicate Reconciliation to compare the two score sheets and supervisors before approval.`});
  }
  const groupValidation=projectGroupValidation(record);
  if(!groupValidation.valid) warnings.push({code:'group-count-mismatch',message:`Group-count verification requires attention. ${groupValidation.issues.join(' ')}`});
  const rowCount=validScoreRows(record).length;
  if(rowCount>PROJECT_HIGH_ROW_WARNING) warnings.push({code:'high-row-count',message:`This submission contains ${rowCount} score rows, above the current review-warning threshold of ${PROJECT_HIGH_ROW_WARNING}.`});
  const accessWarning=projectAccessWarning(record);
  if(accessWarning) warnings.push(accessWarning);
  return warnings;
}

function projectDuplicateReconciliation(record, records) {
  if(!record) return [];
  const stream=projectStream(record);
  const projects=projectRecords(records||[]).filter(r=>projectStream(r)===stream);
  const others=projects.filter(r=>r.id!==record.id&&projectReviewStatus(r)==='approved');
  const byRegistration=new Map();
  for(const other of others){
    for(const row of validScoreRowsWithMeta(other).filter(x=>x.included!==false)){
      const key=normalizeIndexNumber(row.registrationNo);if(!key)continue;
      if(!byRegistration.has(key))byRegistration.set(key,[]);
      byRegistration.get(key).push({record:other,row});
    }
  }
  const groups=[];
  for(const currentRow of validScoreRowsWithMeta(record)){
    const key=normalizeIndexNumber(currentRow.registrationNo);if(!key||!byRegistration.has(key))continue;
    const occurrences=[{record,row:currentRow},...byRegistration.get(key)];
    groups.push({
      registrationNo:currentRow.registrationNo,
      normalizedRegistrationNo:key,
      occurrences:occurrences.map(({record:r,row})=>({
        submissionId:r.id,reference:r.reference||r.id,supervisorName:r.fullName||r.name||'',supervisorEmail:r.email||'',studyCentres:projectStudyCentres(r),status:projectReviewLabel(projectReviewStatus(r)),sourceIndex:row.sourceIndex,originalSn:row.originalSn||'',studentName:row.name||'',registrationNo:row.registrationNo||'',groupNo:row.groupNo||'',totalScore:row.totalScore||'',included:row.included!==false,scoreRows:validScoreRowsWithMeta(r).map(x=>({sourceIndex:x.sourceIndex,originalSn:x.originalSn||'',name:x.name||'',registrationNo:x.registrationNo||'',groupNo:x.groupNo||'',totalScore:x.totalScore||'',included:x.included!==false}))
      }))
    });
  }
  return [...new Map(groups.map(g=>[g.normalizedRegistrationNo,g])).values()];
}

function fieldDuplicateReconciliation(record, records) {
  if(!record) return [];
  const assessmentType=String(record.assessmentType||'');
  const others=fieldExperienceRecords(records||[]).filter(r=>r.id!==record.id&&projectReviewStatus(r)==='approved'&&String(r.assessmentType||'')===assessmentType);
  const byRegistration=new Map();
  for(const other of others){
    for(const row of fieldValidScoreRowsWithMeta(other).filter(item=>item.included!==false)){
      const key=normalizeIndexNumber(row.registrationNo);if(!key)continue;
      if(!byRegistration.has(key))byRegistration.set(key,[]);
      byRegistration.get(key).push({record:other,row});
    }
  }
  const groups=[];
  for(const currentRow of fieldValidScoreRowsWithMeta(record)){
    const key=normalizeIndexNumber(currentRow.registrationNo);if(!key||!byRegistration.has(key))continue;
    const occurrences=[{record,row:currentRow},...byRegistration.get(key)];
    groups.push({
      registrationNo:currentRow.registrationNo,
      normalizedRegistrationNo:key,
      occurrences:occurrences.map(({record:r,row})=>({
        submissionId:r.id,reference:r.reference||r.id,supervisorName:r.fullName||r.name||'',supervisorEmail:r.email||'',studyCentres:projectStudyCentres(r),assessmentLabel:fieldAssessmentLabel(r),status:projectReviewLabel(projectReviewStatus(r)),sourceIndex:row.sourceIndex,originalSn:row.originalSn||'',studentName:row.name||'',registrationNo:row.registrationNo||'',scoreHeaders:row.scoreHeaders||[],scoreValues:row.scoreValues||[],included:row.included!==false,
        scoreRows:fieldValidScoreRowsWithMeta(r).map(item=>({sourceIndex:item.sourceIndex,originalSn:item.originalSn||'',name:item.name||'',registrationNo:item.registrationNo||'',scoreHeaders:item.scoreHeaders||[],scoreValues:item.scoreValues||[],included:item.included!==false}))
      }))
    });
  }
  return [...new Map(groups.map(group=>[group.normalizedRegistrationNo,group])).values()];
}

function fieldExperienceSubmissionWarnings(record, records) {
  if(!record) return [];
  const warnings=[];
  const fields=fieldExperienceRecords(records||[]);
  const others=fields.filter(r=>r.id!==record.id);
  const supervisorEmail=String(record.email||'').trim().toLowerCase();
  const supervisorName=record.fullName||record.name||'';
  const sameSupervisor=others.filter(r=>{
    const otherEmail=String(r.email||'').trim().toLowerCase();
    const emailMatch=isEmail(supervisorEmail)&&isEmail(otherEmail)&&supervisorEmail===otherEmail;
    return emailMatch||samePersonName(supervisorName,r.fullName||r.name||'');
  });
  if(sameSupervisor.length) warnings.push({code:'repeat-supervisor',message:`Same mentor/supervisor/examiner has ${sameSupervisor.length} other Field Experience or Teaching Practice submission${sameSupervisor.length===1?'':'s'} in this department.`});
  const centreKeys=new Set(projectStudyCentres(record).map(c=>c.toLowerCase()));
  const sameAssessment=sameSupervisor.filter(r=>String(r.assessmentType||'')===String(record.assessmentType||''));
  const sameCombo=sameAssessment.filter(r=>projectStudyCentres(r).some(c=>centreKeys.has(c.toLowerCase())));
  if(centreKeys.size&&sameCombo.length) warnings.push({code:'repeat-supervisor-centre',message:`Same mentor/supervisor/examiner and assessment type appear in ${sameCombo.length} other submission${sameCombo.length===1?'':'s'} sharing at least one selected study centre.`});
  const approvedOthers=others.filter(r=>projectReviewStatus(r)==='approved'&&String(r.assessmentType||'')===String(record.assessmentType||''));
  const approvedRegMap=new Map();
  for(const other of approvedOthers){
    for(const row of approvedFieldExperienceScoreRows(other)){
      const key=normalizeIndexNumber(row.registrationNo);
      if(!key) continue;
      if(!approvedRegMap.has(key)) approvedRegMap.set(key,[]);
      approvedRegMap.get(key).push(other.reference||other.id);
    }
  }
  const duplicateRegs=[];
  for(const row of fieldValidScoreRowsWithMeta(record).filter(item=>item.included!==false)){
    const key=normalizeIndexNumber(row.registrationNo);
    if(key&&approvedRegMap.has(key)) duplicateRegs.push({registrationNo:row.registrationNo,references:approvedRegMap.get(key)});
  }
  if(duplicateRegs.length){
    const unique=[...new Map(duplicateRegs.map(x=>[normalizeIndexNumber(x.registrationNo),x])).values()];
    const sample=unique.slice(0,5).map(x=>x.registrationNo).join(', ');
    warnings.push({code:'duplicate-approved-registration',message:`${unique.length} registration number${unique.length===1?'':'s'} already appear in another approved ${fieldAssessmentLabel(record)} score sheet${unique.length===1?'':'s'}${sample?`: ${sample}${unique.length>5?'…':''}`:''}. Open Duplicate Reconciliation to compare the score sheets and supervisors before approval.`});
  }
  const claimValidation=fieldClaimValidation(record);
  if(!claimValidation.valid)warnings.push({code:'candidate-count-mismatch',message:`Candidate-count verification requires attention. ${claimValidation.issues.join(' ')}`});
  const rowCount=fieldValidScoreRows(record).length;
  if(rowCount>PROJECT_HIGH_ROW_WARNING) warnings.push({code:'high-row-count',message:`This submission contains ${rowCount} score rows, above the current review-warning threshold of ${PROJECT_HIGH_ROW_WARNING}.`});
  const accessWarning=projectAccessWarning(record);
  if(accessWarning) warnings.push(accessWarning);
  return warnings;
}

function validScoreRowsWithMeta(record) {
  const excluded=new Set((Array.isArray(record?.scoreReviewExcludedRows)?record.scoreReviewExcludedRows:[]).map(Number).filter(Number.isInteger));
  const out=[];
  (record?.scoreSheet?.rows || []).forEach((row,sourceIndex)=>{
    // Backward-compatible cleanup: older submissions may already have stored the
    // template footer lines as score rows. Filter them at review/export/count time so
    // existing records are corrected without requiring users to resubmit score sheets.
    if (isStoredScoreFooterRow(row)) return;
    const name=cellText(row?.name), registrationNo=cellText(row?.registrationNo), groupNo=cellText(row?.groupNo), totalScore=cellText(row?.totalScore);
    if(!Boolean(name || registrationNo || groupNo || totalScore)) return;
    out.push({sourceIndex,originalSn:cellText(row?.originalSn),name,registrationNo,groupNo,totalScore,included:!excluded.has(sourceIndex)});
  });
  return out;
}
function validScoreRows(record) {
  return validScoreRowsWithMeta(record).map(({sourceIndex,included,...row})=>row);
}
function approvedProjectScoreRows(record) {
  return validScoreRowsWithMeta(record).filter(row=>row.included).map(({sourceIndex,included,...row})=>row);
}
function registrationSortValue(value) {
  return String(value||'').trim().toUpperCase();
}
function compareRegistrationValues(a,b) {
  return registrationSortValue(a).localeCompare(registrationSortValue(b),undefined,{numeric:true,sensitivity:'base'});
}
function renumberScoreRows(rows) {
  return rows.map((row,i)=>({...row,'S/N':i+1}));
}
const PROJECT_EXPORT_HEADERS=['S/N','STUDY CENTRE','NAME','REGISTRATION NO.','GROUP NO.','TOTAL SCORE'];
function projectScoreRowsForStream(records, stream='distance') {
  const out=[];const directory=studyCentreDirectoryMapSync();
  projectRecords(records).filter(record=>projectStream(record)===stream && projectReviewStatus(record)==='approved').forEach(record => {
    for (const row of approvedProjectScoreRows(record)) {
      const centre=studyCentreInfoFromRegistration(row.registrationNo,directory);
      out.push({'S/N':0,'STUDY CENTRE':centre.name,'CENTRE CODE':centre.code,'NAME':row.name||'','REGISTRATION NO.':row.registrationNo||'','GROUP NO.':row.groupNo||'','TOTAL SCORE':row.totalScore||''});
    }
  });
  out.sort((a,b)=>String(a['STUDY CENTRE']||'').localeCompare(String(b['STUDY CENTRE']||''),undefined,{numeric:true,sensitivity:'base'})||compareRegistrationValues(a['REGISTRATION NO.'],b['REGISTRATION NO.'])||String(a.NAME||'').localeCompare(String(b.NAME||''),undefined,{sensitivity:'base'}));
  return renumberScoreRows(out);
}
function allScoreRows(records) { return projectScoreRowsForStream(records,'distance'); }
function allNonResidentialScoreRows(records) { return projectScoreRowsForStream(records,'non-residential'); }
function scoreRowsAoA(rows) { return [PROJECT_EXPORT_HEADERS, ...renumberScoreRows(rows).map(r=>PROJECT_EXPORT_HEADERS.map(h=>r[h]))]; }
function scoreSheetAoA(records) { return scoreRowsAoA(allScoreRows(records)); }
function nonResidentialScoreSheetAoA(records) { return scoreRowsAoA(allNonResidentialScoreRows(records)); }
function individualScoreSheetAoA(record) { const rows=validScoreRows(record); return [REQUIRED_HEADERS, ...rows.map((row,i)=>[i+1,row.name||'',row.registrationNo||'',row.groupNo||'',row.totalScore||''])]; }
function registrationProgrammeCentre(registrationNo) {
  const parts=String(registrationNo||'').split('/').map(v=>v.trim());
  if(parts.length<3||!parts[0]||!parts[1]||!parts[2]) return {key:'UNCLASSIFIED',programme:'UNCLASSIFIED',centre:'UNCLASSIFIED'};
  return {key:`${parts[0]}/${parts[1]}/${parts[2]}`,programme:parts[0],centre:normalizeCentreCode(`${parts[1]}/${parts[2]}`)};
}
function projectCentreGroups(records,stream='distance') {
  const groups=new Map();const directory=studyCentreDirectoryMapSync();
  for(const row of projectScoreRowsForStream(records,stream)){
    const code=row['CENTRE CODE']||registrationCentreCode(row['REGISTRATION NO.'])||'UNCLASSIFIED';
    const centre=code==='UNCLASSIFIED'?{code,name:'UNCLASSIFIED STUDY CENTRE'}:(directory.get(code)||{code,name:`UNKNOWN STUDY CENTRE (${code})`});
    if(!groups.has(code)) groups.set(code,{key:code,centreCode:code,centreName:centre.name,rows:[]});
    groups.get(code).rows.push({...row,'STUDY CENTRE':centre.name,'CENTRE CODE':code});
  }
  return [...groups.values()].sort((a,b)=>String(a.centreName).localeCompare(String(b.centreName),undefined,{numeric:true,sensitivity:'base'})).map(g=>({...g,rows:renumberScoreRows(g.rows.sort((a,b)=>compareRegistrationValues(a['REGISTRATION NO.'],b['REGISTRATION NO.'])||String(a.NAME||'').localeCompare(String(b.NAME||''))))}));
}
function allFieldExperienceScoreRows(records) {
  const out=[];
  fieldExperienceRecords(records).filter(record=>projectReviewStatus(record)==='approved').forEach(record => {
    for(const row of approvedFieldExperienceScoreRows(record)) out.push({assessmentType:record.assessmentType||'legacy',registrationNo:row.registrationNo||'',name:row.name||'',scoreValues:row.scoreValues||[]});
  });
  out.sort((a,b)=>String(a.assessmentType||'').localeCompare(String(b.assessmentType||''))||compareRegistrationValues(a.registrationNo,b.registrationNo)||String(a.name||'').localeCompare(String(b.name||'')));
  return out;
}
function fieldScoreReportSpec(key) { return FIELD_SCORE_REPORTS[String(key||'').trim()] || null; }
function fieldScoreReportRows(records, reportKey) {
  const report=fieldScoreReportSpec(reportKey); if(!report) return [];
  const out=[];const directory=studyCentreDirectoryMapSync();
  fieldExperienceRecords(records)
    .filter(record=>record.assessmentType===report.assessmentType&&projectReviewStatus(record)==='approved')
    .forEach(record=>{
      for(const row of approvedFieldExperienceScoreRows(record)) {const centre=studyCentreInfoFromRegistration(row.registrationNo,directory);out.push({registrationNo:row.registrationNo||'',name:row.name||'',score:row.scoreValues?.[report.scoreIndex]||'',centreCode:centre.code,studyCentre:centre.name});}
    });
  out.sort((a,b)=>String(a.studyCentre||'').localeCompare(String(b.studyCentre||''),undefined,{numeric:true,sensitivity:'base'})||compareRegistrationValues(a.registrationNo,b.registrationNo)||String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'}));
  return out;
}
function fieldScoreReportAoA(records, reportKey) {
  const report=fieldScoreReportSpec(reportKey); if(!report) return [['S/N','STUDY CENTRE','REGISTRATION','NAME OF STUDENT','SCORE']];
  return [['S/N','STUDY CENTRE','REGISTRATION','NAME OF STUDENT',report.scoreHeader],...fieldScoreReportRows(records,reportKey).map((row,i)=>[i+1,row.studyCentre,row.registrationNo,row.name,row.score])];
}
function fieldScoreReportRegisterAoA(records, reportKey) {
  const report=fieldScoreReportSpec(reportKey); if(!report) return [['S/N','REFERENCE']];
  const h=['S/N','REFERENCE','SUBMITTED AT','REPORT','SOURCE SCORE SHEET','MENTOR / SUPERVISOR / EXAMINER','PHONE','EMAIL','STUDY CENTRE(S)','NO. OF STUDENTS / CANDIDATES','SCORE ROWS EXTRACTED','REVIEW STATUS','REVIEWED AT','REVIEWED BY','REVIEW NOTE'];
  const body=fieldExperienceRecords(records)
    .filter(r=>r.assessmentType===report.assessmentType)
    .slice().sort((a,b)=>String(a.submittedAt||'').localeCompare(String(b.submittedAt||'')))
    .map((r,i)=>[i+1,r.reference,r.submittedAt,report.label,fieldAssessmentLabel(r),r.fullName,r.phone,r.email,studyCentreDisplay(r),r.groupCount,fieldValidScoreRows(r).length,projectReviewLabel(projectReviewStatus(r)),r.reviewedAt||'',r.reviewedBy||'',r.reviewNote||'']);
  return [h,...body];
}
function fieldScoreReportCentreGroups(records,reportKey) {
  const groups=new Map();
  for(const row of fieldScoreReportRows(records,reportKey)){
    const key=row.centreCode||'UNCLASSIFIED';
    if(!groups.has(key))groups.set(key,{key,centreCode:key,centreName:row.studyCentre||'UNCLASSIFIED STUDY CENTRE',rows:[]});
    groups.get(key).rows.push({...row});
  }
  return [...groups.values()].sort((a,b)=>String(a.centreName).localeCompare(String(b.centreName),undefined,{numeric:true,sensitivity:'base'})).map(g=>({...g,rows:g.rows.sort((a,b)=>compareRegistrationValues(a.registrationNo,b.registrationNo)||String(a.name||'').localeCompare(String(b.name||'')))}));
}
function fieldScoreReportWorkbookBuffer(records,reportKey,kind='scores') {
  const report=fieldScoreReportSpec(reportKey); if(!report) throw new Error('Unknown Field Experience report.');
  const wb=XLSX.utils.book_new();
  addSheet(wb,report.sheetName.slice(0,31),fieldScoreReportAoA(records,reportKey),[8,48,24,34,16]);
  if(kind==='master') addSheet(wb,`${report.sheetName} Register`.slice(0,31),fieldScoreReportRegisterAoA(records,reportKey),[8,22,24,24,28,34,18,30,28,24,20,24,24,28,38]);
  if(kind==='register'){
    const only=XLSX.utils.book_new(); addSheet(only,`${report.sheetName} Register`.slice(0,31),fieldScoreReportRegisterAoA(records,reportKey),[8,22,24,24,28,34,18,30,28,24,20,24,24,28,38]); return XLSX.write(only,{type:'buffer',bookType:'xlsx'});
  }
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}
function fieldReportRowsWorkbookBuffer(reportKey,rows,sheetName='Scores') {
  const report=fieldScoreReportSpec(reportKey); if(!report) throw new Error('Unknown Field Experience report.');
  const wb=XLSX.utils.book_new();
  const aoa=[['S/N','STUDY CENTRE','REGISTRATION','NAME OF STUDENT',report.scoreHeader],...rows.map((row,i)=>[i+1,row.studyCentre||'',row.registrationNo||'',row.name||'',row.score||''])];
  addSheet(wb,String(sheetName||report.sheetName).replace(/[\/?*\[\]:]/g,'-').slice(0,31)||'Scores',aoa,[8,48,24,34,16]);
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}
function uniqueCentreZipName(group,used){
  const base=safeBaseName(group.centreName||'UNCLASSIFIED STUDY CENTRE').replace(/\.xlsx$/i,'').trim()||'UNCLASSIFIED STUDY CENTRE';
  let name=`${base}.xlsx`;let n=1;
  while(used.has(name.toLowerCase())){
    const code=safeBaseName(group.centreCode||'CENTRE').replace(/\//g,'-');
    name=`${base} (${code}${n>1?` ${n}`:''}).xlsx`;n++;
  }
  used.add(name.toLowerCase());return name;
}
async function streamFieldCentreByCentreScoreZip(res,records,reportKey,downloadName) {
  const report=fieldScoreReportSpec(reportKey); if(!report){res.status(404).json({error:'Unknown Field Experience report.'});return;}
  const groups=fieldScoreReportCentreGroups(records,reportKey);
  if(!groups.length){res.status(404).json({error:`No approved ${report.label} score rows are available for Centre by Centre export.`});return;}
  const tempDir=path.join(DATA_DIR,`field-centre-by-centre-${crypto.randomUUID()}`);await fsp.mkdir(tempDir,{recursive:true});
  try{
    const zipFiles=[];const used=new Set();
    for(const group of groups){
      const filename=uniqueCentreZipName(group,used);const fp=path.join(tempDir,filename);
      await fsp.writeFile(fp,fieldReportRowsWorkbookBuffer(reportKey,group.rows,group.centreCode));zipFiles.push({path:fp,name:filename});
    }
    res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(downloadName)}"`);
    await streamZipArchive(res,zipFiles);
  }finally{await fsp.rm(tempDir,{recursive:true,force:true}).catch(()=>{});}
}

function projectRegisterAoA(records, stream='distance') {
  const h=['S/N','REFERENCE','SUBMITTED AT','EXAMINER / SUPERVISOR','PHONE','EMAIL','STUDY CENTRE(S)','STUDENT STREAM','NO. OF GROUPS / CANDIDATES','SCORE ROWS EXTRACTED','ROWS INCLUDED FOR CONSOLIDATION','REVIEW STATUS','REVIEWED AT','REVIEWED BY','REVIEW NOTE'];
  const body=projectRecords(records).filter(r=>projectStream(r)===stream).map((r,i)=>[i+1,r.reference,r.submittedAt,r.fullName,r.phone,r.email,studyCentreDisplay(r),stream==='non-residential'?'Non-Residential (Regular)':'Distance',r.groupCount,validScoreRows(r).length,approvedProjectScoreRows(r).length,projectReviewLabel(projectReviewStatus(r)),r.reviewedAt||'',r.reviewedBy||'',r.reviewNote||'']); return [h,...body];
}

function approvedProjectRegisterRecords(records, stream='all') {
  return projectRecords(records).filter(r=>projectReviewStatus(r)==='approved'&&(stream==='all'||projectStream(r)===stream)).slice().sort((a,b)=>String(a.reviewedAt||a.submittedAt||'').localeCompare(String(b.reviewedAt||b.submittedAt||''))||String(a.reference||'').localeCompare(String(b.reference||'')));
}
function projectApprovedRegisterAoA(records, stream='all') {
  const h=['S/N','REFERENCE','APPROVED AT','EXAMINER / SUPERVISOR','PHONE','EMAIL','STUDY CENTRE(S)','STUDENT STREAM','TOTAL NUMBER OF GROUPS SUBMITTING','INTERPRETED GROUP COUNT','DISTINCT GROUPS IN SCORE SHEET','COMPLETED PROJECT WORKS ATTACHED','SCORE ROWS APPROVED','CLAIM FORM','GROUP VERIFICATION','APPROVED BY'];
  const body=approvedProjectRegisterRecords(records,stream).map((r,i)=>{const gv=projectGroupValidation(r);const claim=Array.isArray(r.files?.claimForm)?r.files.claimForm[0]:r.files?.claimForm;return [i+1,r.reference,r.reviewedAt||'',r.fullName,r.phone,r.email,studyCentreDisplay(r),projectStream(r)==='non-residential'?'Non-Residential (Regular)':'Distance',r.groupCount||'',gv.claimedGroupCount||'',gv.scoreSheetGroupCount,gv.completedProjectWorkCount,approvedProjectScoreRows(r).length,claim?.originalName||'',gv.valid?'MATCH':'REQUIRES RECONCILIATION',r.reviewedBy||''];});
  return [h,...body];
}
function payrollStatusLabel(record){return {pending:'Pending Payroll Verification',verified:'Verified','approved-for-payment':'Approved for Payment',paid:'Paid',queried:'Queried / On Hold'}[String(record?.payroll?.status||'pending')]||'Pending Payroll Verification';}
function approvedPaymentClaimRecords(records){
  return records.filter(record=>['project-work','field-experience','assessor'].includes(record.portalType||'project-work')&&departmentPaymentApprovalStatus(record)==='approved').slice().sort((a,b)=>String(departmentPaymentApprovedAt(a)||a.submittedAt||'').localeCompare(String(departmentPaymentApprovedAt(b)||b.submittedAt||''))||String(a.reference||'').localeCompare(String(b.reference||'')));
}
function auditorVisibleClaimRecords(records){return approvedPaymentClaimRecords(records).filter(record=>['approved-for-payment','paid'].includes(String(record?.payroll?.status||'')));}
function paymentRecordFiles(record,key){const value=record?.files?.[key];return Array.isArray(value)?value.filter(Boolean):(value?[value]:[]);}
function paymentClaimValidation(record){
  if(record.portalType==='assessor'){
    const claimedQuantity=Math.max(1,Number(record.workCount||record.works?.length||0));
    const scoreSheetQuantity=paymentRecordFiles(record,'scoreSheet').length;
    const supportingWorkCount=paymentRecordFiles(record,'reportFile').length;
    const claimFormCount=paymentRecordFiles(record,'claimForm').length;
    return {claimedQuantity,scoreSheetQuantity,supportingWorkCount,claimFormCount,valid:Boolean(claimedQuantity)&&claimedQuantity===scoreSheetQuantity&&claimedQuantity===supportingWorkCount&&claimedQuantity===claimFormCount,label:'Dissertation report claim check'};
  }
  if(record.portalType==='field-experience'){
    const claimedQuantity=Number(record?.claimedCandidateCount||parseFlexiblePositiveCount(record?.groupCount)||0);
    const scoreSheetQuantity=approvedFieldExperienceScoreRows(record).length;
    return {claimedQuantity,scoreSheetQuantity,supportingWorkCount:null,claimFormCount:paymentRecordFiles(record,'claimForm').length,valid:Boolean(claimedQuantity)&&claimedQuantity===scoreSheetQuantity,label:'Candidate check'};
  }
  const validation=projectGroupValidation(record);
  return {claimedQuantity:validation.claimedGroupCount,scoreSheetQuantity:validation.scoreSheetGroupCount,supportingWorkCount:validation.completedProjectWorkCount,claimFormCount:paymentRecordFiles(record,'claimForm').length,valid:validation.valid,label:'Group check',groupNumbers:validation.groupNumbers};
}
function payrollClaimRow(record){
  const validation=paymentClaimValidation(record),claims=paymentRecordFiles(record,'claimForm'),isField=record.portalType==='field-experience',isAssessor=record.portalType==='assessor';
  const reportType=record.reportType==='vetting'?'vetting':'assessment';
  const workType=isAssessor?(reportType==='vetting'?'Dissertation Vetting':'Dissertation Assessment'):(isField?'Field Experience and Teaching Practice':'Undergraduate Project Work');
  const activityKey=isAssessor?`dissertation-${reportType}`:(isField?(record.assessmentType||'field-experience'): 'project-work');
  const category=isAssessor?(reportType==='vetting'?'Vetting Report':'Assessment Report'):(isField?fieldAssessmentLabel(record):(projectStream(record)==='non-residential'?'Non-Residential (Regular)':'Distance'));
  const claimFormPresent=isAssessor?claims.length>=validation.claimedQuantity:Boolean(claims[0]);
  return {id:record.id,department:record.department,departmentName:record.departmentName||DEPARTMENTS[record.department]?.name||record.department,portalType:isAssessor?'assessor':(isField?'field-experience':'project-work'),activityKey,activityGroup:isAssessor?'dissertation':(isField?'field-experience':'project-work'),workType,reference:record.reference,approvedAt:departmentPaymentApprovedAt(record),approvedBy:departmentPaymentApprovedBy(record),supervisorName:isAssessor?(record.assessorName||''):(record.fullName||''),email:record.email||'',phone:record.phone||'',studyCentres:isAssessor?'':studyCentreDisplay(record),contextLabel:isAssessor?([record.studentName,record.programme].filter(Boolean).join(' · ')) : studyCentreDisplay(record),category,studentStream:category,claimedGroupsRaw:record.groupCount||record.workCount||'',claimedGroupCount:validation.claimedQuantity,scoreSheetGroupCount:validation.scoreSheetQuantity,completedProjectWorkCount:validation.supportingWorkCount,claimedQuantity:validation.claimedQuantity,scoreSheetQuantity:validation.scoreSheetQuantity,supportingWorkCount:validation.supportingWorkCount,groupValidation:validation,validation,approvedScoreRows:isAssessor?validation.scoreSheetQuantity:(isField?approvedFieldExperienceScoreRows(record).length:approvedProjectScoreRows(record).length),claimFormName:claims.map(item=>item.originalName||'Claim form').join(', '),claimFormCount:claims.length,claimFormPresent,claimPreviewUrl:`/api/admin/${encodeURIComponent(record.department)}/submissions/${encodeURIComponent(record.id)}/claim-preview`,payrollStatus:String(record?.payroll?.status||'pending'),payrollStatusLabel:payrollStatusLabel(record),payrollNote:record?.payroll?.note||'',payrollUpdatedAt:record?.payroll?.updatedAt||null,payrollUpdatedBy:record?.payroll?.updatedBy||''};
}
function payrollRegisterAoA(records,scope='payroll'){
  const h=['S/N','WORKFLOW','CATEGORY / STREAM','REFERENCE','DEPARTMENT APPROVED AT','CLAIMANT','EMAIL','PHONE','STUDY CENTRE / SUBMISSION','CLAIMED QUANTITY','APPROVED SCORE QUANTITY','SUPPORTING DOCUMENTS','RECONCILIATION','CLAIM FORM','PAYROLL STATUS','PAYROLL NOTE','PAYROLL UPDATED AT','PAYROLL UPDATED BY'];
  const source=scope==='auditor'?auditorVisibleClaimRecords(records):approvedPaymentClaimRecords(records);
  const body=source.map((record,i)=>{const x=payrollClaimRow(record);return [i+1,x.workType,x.category,x.reference,x.approvedAt,x.supervisorName,x.email,x.phone,x.contextLabel||x.studyCentres,x.claimedQuantity||x.claimedGroupsRaw,x.scoreSheetQuantity,x.supportingWorkCount??'',x.validation.valid?'MATCH':'REQUIRES RECONCILIATION',x.claimFormName,x.payrollStatusLabel,x.payrollNote,x.payrollUpdatedAt||'',x.payrollUpdatedBy||''];});
  return [h,...body];
}
function resetPayrollAfterDepartmentChange(record,actor,now,reason){
  if(!record?.payroll||String(record.payroll.status||'pending')==='pending')return;
  record.payroll={...record.payroll,status:'pending',note:reason,updatedAt:now,updatedBy:actor};
  record.payroll.history=Array.isArray(record.payroll.history)?record.payroll.history:[];
  record.payroll.history.push({status:'pending',note:reason,updatedAt:now,updatedBy:actor,action:'department-change-reset'});
  if(record.payroll.history.length>100)record.payroll.history=record.payroll.history.slice(-100);
}

function fieldExperienceRegisterAoA(records) {
  const h=['S/N','REFERENCE','SUBMITTED AT','ASSESSMENT TYPE','MENTOR / SUPERVISOR / EXAMINER','PHONE','EMAIL','STUDY CENTRE(S)','NO. OF STUDENTS / CANDIDATES','SCORE ROWS EXTRACTED','ROWS INCLUDED FOR CONSOLIDATION','REVIEW STATUS','REVIEWED AT','REVIEWED BY','REVIEW NOTE'];
  const body=fieldExperienceRecords(records)
    .slice()
    .sort((a,b)=>String(fieldAssessmentLabel(a)).localeCompare(String(fieldAssessmentLabel(b)))||String(a.submittedAt||'').localeCompare(String(b.submittedAt||'')))
    .map((r,i)=>[i+1,r.reference,r.submittedAt,fieldAssessmentLabel(r),r.fullName,r.phone,r.email,studyCentreDisplay(r),r.groupCount,fieldValidScoreRows(r).length,approvedFieldExperienceScoreRows(r).length,projectReviewLabel(projectReviewStatus(r)),r.reviewedAt||'',r.reviewedBy||'',r.reviewNote||'']);
  return [h,...body];
}
function fieldExperienceApprovedRegisterAoA(records) {
  const h=['S/N','REFERENCE','APPROVED AT','ASSESSMENT TYPE','MENTOR / SUPERVISOR / EXAMINER','PHONE','EMAIL','STUDY CENTRE(S)','CLAIMED STUDENTS / CANDIDATES','SCORE ROWS APPROVED','CLAIM FORM','CANDIDATE RECONCILIATION','APPROVED BY'];
  const body=fieldExperienceRecords(records).filter(record=>projectReviewStatus(record)==='approved').slice().sort((a,b)=>String(a.reviewedAt||'').localeCompare(String(b.reviewedAt||''))||String(a.reference||'').localeCompare(String(b.reference||''))).map((record,index)=>{const validation=paymentClaimValidation(record);const claim=Array.isArray(record.files?.claimForm)?record.files.claimForm[0]:record.files?.claimForm;return [index+1,record.reference,record.reviewedAt||'',fieldAssessmentLabel(record),record.fullName,record.phone,record.email,studyCentreDisplay(record),validation.claimedQuantity,validation.scoreSheetQuantity,claim?.originalName||'',validation.valid?'MATCH':'REQUIRES RECONCILIATION',record.reviewedBy||''];});
  return [h,...body];
}
function dedupDissertationStage(records, submissionType) {
  const map=new Map();
  dissertationRecords(records).filter(r=>(r.submissionType||'fresh')===submissionType).forEach(r=>{
    const key=normalizeIndexNumber(r.indexNumber)||String(r.id);
    const prev=map.get(key);
    if(!prev||String(r.submittedAt||'').localeCompare(String(prev.submittedAt||''))>0)map.set(key,r);
  });
  return [...map.values()].sort((a,b)=>String(a.studentName||'').localeCompare(String(b.studentName||'')));
}
function dissertationRegisterAoA(records, submissionType='fresh') {
  const h=['S/N','Name of Student','Index Number','Dissertation Title','Programme',"Supervisor's Name"];
  const body=dedupDissertationStage(records,submissionType).map((r,i)=>[i+1,r.studentName,r.indexNumber,r.dissertationTopic,r.programme,r.supervisorName]);
  return [h,...body];
}
function addSheet(wb,name,aoa,widths) {
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=widths.map(w=>({wch:w}));
  if(ws['!ref']) ws['!autofilter']={ref:ws['!ref']};
  XLSX.utils.book_append_sheet(wb,ws,name);
}
function addFieldAssessmentSheets(wb,records,prefix='') {
  for(const key of FIELD_ASSESSMENT_KEYS){
    const spec=FIELD_ASSESSMENTS[key];
    const name=(prefix?`${prefix} ${spec.sheetName}`:spec.sheetName).slice(0,31);
    const widths=[8,48,24,34,...spec.scoreHeaders.map(()=>14)];
    addSheet(wb,name,fieldAssessmentAoA(records,key),widths);
  }
  const legacy=fieldExperienceRecords(records).filter(r=>!fieldAssessmentSpec(r.assessmentType)&&projectReviewStatus(r)==='approved');
  if(legacy.length) addSheet(wb,(prefix?'Legacy Scores':'Legacy').slice(0,31),fieldLegacyScoreSheetAoA(records),[10,48,34,24,16,16]);
}
function workbookBuffer(kind,records) {
  const wb=XLSX.utils.book_new();
  if(kind==='scores') addSheet(wb,'Consolidated Distance Scores',scoreSheetAoA(records),[10,48,34,24,16,16]);
  if(kind==='non-residential-scores') addSheet(wb,'Consolidated Non-Residential',nonResidentialScoreSheetAoA(records),[10,48,34,24,16,16]);
  if(kind==='single-score') {
    const record=records[0];
    if(record?.portalType==='field-experience'){
      const spec=fieldAssessmentSpec(record.assessmentType);
      addSheet(wb,(spec?.sheetName||'Clean Scores').slice(0,31),individualFieldScoreSheetAoA(record),spec?[8,24,34,...spec.scoreHeaders.map(()=>14)]:[10,34,24,16,16]);
    } else addSheet(wb,'Clean Scores',individualScoreSheetAoA(record),[10,34,24,16,16]);
  }
  if(kind==='project-register') addSheet(wb,'Distance Project Register',projectRegisterAoA(records,'distance'),[8,22,24,32,18,30,22,22,24,20,24,24,24,28,38]);
  if(kind==='project-approved-register') addSheet(wb,'Approved Distance Register',projectApprovedRegisterAoA(records,'distance'),[8,22,24,34,18,30,34,24,26,22,24,26,22,32,28,28]);
  if(kind==='non-residential-project-approved-register') addSheet(wb,'Approved Non-Residential',projectApprovedRegisterAoA(records,'non-residential'),[8,22,24,34,18,30,34,24,26,22,24,26,22,32,28,28]);
  if(kind==='payroll-register') addSheet(wb,'Payroll Register',payrollRegisterAoA(records,'payroll'),[8,34,28,22,24,34,30,18,34,20,24,24,28,32,28,38,24,28]);
  if(kind==='auditor-register') addSheet(wb,'Auditor Claims Register',payrollRegisterAoA(records,'auditor'),[8,34,28,22,24,34,30,18,34,20,24,24,28,32,28,38,24,28]);
  if(kind==='non-residential-project-register') addSheet(wb,'Non-Residential Register',projectRegisterAoA(records,'non-residential'),[8,22,24,32,18,30,22,22,24,20,24,24,24,28,38]);
  if(kind==='project-master') {
    addSheet(wb,'Master Distance Project Scores',scoreSheetAoA(records),[10,48,34,24,16,16]);
    addSheet(wb,'Distance Project Register',projectRegisterAoA(records,'distance'),[8,22,24,32,18,30,22,22,24,20,24,24,24,28,38]);
  }
  if(kind==='non-residential-project-master') {
    addSheet(wb,'Master Non-Residential Scores',nonResidentialScoreSheetAoA(records),[10,48,34,24,16,16]);
    addSheet(wb,'Non-Residential Register',projectRegisterAoA(records,'non-residential'),[8,22,24,32,18,30,22,22,24,20,24,24,24,28,38]);
  }
  if(kind==='field-scores') addFieldAssessmentSheets(wb,records,'');
  if(kind==='field-register') addSheet(wb,'Field Teaching Register',fieldExperienceRegisterAoA(records),[8,22,24,28,34,18,30,32,24,20,24,24,24,28,38]);
  if(kind==='field-approved-register') addSheet(wb,'Approved Field Teaching',fieldExperienceApprovedRegisterAoA(records),[8,22,24,28,34,18,30,34,24,24,32,28,28]);
  if(kind==='field-master') {
    addFieldAssessmentSheets(wb,records,'Master');
    addSheet(wb,'Field Teaching Register',fieldExperienceRegisterAoA(records),[8,22,24,28,34,18,30,32,24,20,24,24,24,28,38]);
  }
  if(kind==='fresh-dissertation-register') addSheet(wb,'Fresh Dissertation Register',dissertationRegisterAoA(records,'fresh'),[8,34,24,58,32,34]);
  if(kind==='revised-dissertation-register') addSheet(wb,'Revised Dissertation Register',dissertationRegisterAoA(records,'revised'),[8,34,24,58,32,34]);
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}
function sendWorkbook(res,kind,records,filename){
  const buffer=workbookBuffer(kind,records);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  res.send(buffer);
}

function scoreRowsWorkbookBuffer(rows,sheetName='Scores') {
  const wb=XLSX.utils.book_new();
  addSheet(wb,String(sheetName||'Scores').replace(/[\\/?*\[\]:]/g,'-').slice(0,31)||'Scores',scoreRowsAoA(rows),[10,34,24,16,16]);
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}
function claimFilesForSelectedProject(records,ids,stream='distance') {
  const allowed=new Set((ids||[]).map(String));
  const selected=projectRecords(records).filter(r=>allowed.has(String(r.id))&&projectStream(r)===stream);
  const counts=new Map();const files=[];
  for(const record of selected){
    const item=record.files?.claimForm;if(!item)continue;
    const fp=path.join(FILES_DIR,path.basename(item.storedName));if(!fs.existsSync(fp))continue;
    const stem=safeBaseName(record.fullName||'Supervisor Examiner').trim()||'Supervisor Examiner';
    const n=(counts.get(stem.toLowerCase())||0)+1;counts.set(stem.toLowerCase(),n);
    const ext=(path.extname(item.originalName||'')||path.extname(fp)||'.docx').toLowerCase();
    const name=safeBaseName(`${stem}${n>1?` (${n})`:''}${ext}`);
    files.push({path:fp,name,size:Number(item.size||fs.statSync(fp).size),record});
  }
  return files;
}
async function streamCentreByCentreScoreZip(res,records,stream,downloadName) {
  const groups=projectCentreGroups(records,stream);
  if(!groups.length){res.status(404).json({error:'No approved project-work score rows are available for Centre by Centre export.'});return;}
  const tempDir=path.join(DATA_DIR,`centre-by-centre-${crypto.randomUUID()}`);await fsp.mkdir(tempDir,{recursive:true});
  try{
    const zipFiles=[];const used=new Set();
    for(const group of groups){
      const filename=uniqueCentreZipName(group,used);const fp=path.join(tempDir,filename);
      await fsp.writeFile(fp,scoreRowsWorkbookBuffer(group.rows,group.centreCode));zipFiles.push({path:fp,name:filename});
    }
    res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(downloadName)}"`);
    await streamZipArchive(res,zipFiles);
  }finally{await fsp.rm(tempDir,{recursive:true,force:true}).catch(()=>{});}
}

function feedbackAdminInfoForWork(work, records, department){
  const exact=work?.studentSubmissionId ? records.find(r=>r.id===work.studentSubmissionId && r.portalType==='dissertation' && r.department===department) : null;
  const student=exact || latestStudentDissertation(records,department,work?.indexNumber);
  const email=student?.email || work?.studentEmail || work?.feedback?.recipientEmail || '';
  const state=!email?'unavailable':feedbackState(work?.feedback);
  return {state,email,studentSubmissionId:student?.id||work?.studentSubmissionId||null,studentSubmissionType:student?.submissionType||work?.studentSubmissionType||'',sentAt:work?.feedback?.sentAt||null,downloadedAt:work?.feedback?.downloadedAt||null,downloadCount:Number(work?.feedback?.downloadCount||0),lastEmailError:work?.feedback?.lastEmailError||''};
}
function adminRecordsMap(records, assignments=[]) {
  return records.slice().reverse().map(r=>{
    const submissionType=r.submissionType||'fresh';
    const expectedAssignmentType=submissionType==='revised'?'vetting':submissionType==='fresh'?'assessment':null;
    const info=expectedAssignmentType?dissertationAssignmentInfo(r.id,assignments,expectedAssignmentType):{count:0,assessors:[]};
    const assignmentLimit=submissionType==='revised'?2:submissionType==='fresh'?3:0;
    return {
      id:r.id,reference:r.reference,submittedAt:r.submittedAt,portalType:r.portalType||'project-work',
      name:r.fullName||r.studentName||r.assessorName||'',secondaryName:r.portalType==='assessor'?r.studentName:(r.portalType==='dissertation'?r.supervisorName:''),
      title:r.title||r.studentTitle||r.assessorTitle||'',firstName:r.firstName||r.studentFirstName||r.assessorFirstName||'',lastName:r.lastName||r.studentLastName||r.assessorLastName||'',
      email:r.email||'',phone:r.phone||'',programme:r.programme||'',studyCentre:(r.portalType==='project-work'||!r.portalType||r.portalType==='field-experience')?studyCentreDisplay(r):(r.studyCentre||''),studyCentres:(r.portalType==='project-work'||!r.portalType||r.portalType==='field-experience')?projectStudyCentres(r):[],projectStream:(r.portalType==='project-work'||!r.portalType)?projectStream(r):'',assessmentType:r.portalType==='field-experience'?(r.assessmentType||'legacy'):'',assessmentLabel:r.portalType==='field-experience'?fieldAssessmentLabel(r):'',scoreRows:r.portalType==='field-experience'?fieldValidScoreRows(r).length:validScoreRows(r).length,scoreRowsIncluded:(r.portalType==='project-work'||!r.portalType)?approvedProjectScoreRows(r).length:(r.portalType==='field-experience'?approvedFieldExperienceScoreRows(r).length:validScoreRows(r).length),
      projectReviewStatus:projectReviewStatus(r),projectReviewLabel:projectReviewLabel(projectReviewStatus(r)),projectReviewNote:r.reviewNote||'',projectReviewedAt:r.reviewedAt||null,projectReviewedBy:r.reviewedBy||'',projectWarnings:(r.portalType==='project-work'||!r.portalType)?projectSubmissionWarnings(r,records):[],projectReturnEmailStatus:r.reviewReturnEmailStatus||'',projectReturnEmailSentAt:r.reviewReturnEmailSentAt||null,projectReturnEmailError:r.reviewReturnEmailError||'',projectReturnEmailRecipient:r.reviewReturnEmailRecipient||'',
      fieldReviewStatus:projectReviewStatus(r),fieldReviewLabel:projectReviewLabel(projectReviewStatus(r)),fieldReviewNote:r.reviewNote||'',fieldReviewedAt:r.reviewedAt||null,fieldReviewedBy:r.reviewedBy||'',fieldWarnings:r.portalType==='field-experience'?fieldExperienceSubmissionWarnings(r,records):[],fieldReturnEmailStatus:r.reviewReturnEmailStatus||'',fieldReturnEmailSentAt:r.reviewReturnEmailSentAt||null,fieldReturnEmailError:r.reviewReturnEmailError||'',fieldReturnEmailRecipient:r.reviewReturnEmailRecipient||'',
      studentName:r.studentName||'',indexNumber:r.indexNumber||'',dissertationTopic:r.dissertationTopic||'',previousDissertationTopic:r.previousDissertationTopic||'',supervisorName:r.supervisorName||'',submissionType,
      processingStatus:dissertationProcessingStatus(r),returnReason:dissertationReturnReason(r),returnedAt:r.returnedAt||null,returnedBy:r.returnedBy||'',returnEmailStatus:r.returnEmailStatus||'',
      titleValidated:Boolean(r.titleValidation?.matched),lineageId:r.lineageId||r.id,previousSubmissionId:r.previousSubmissionId||null,
      reviewerResponseCount:Array.isArray(r.files?.reviewerResponses)?r.files.reviewerResponses.length:0,turnitinReportPresent:Boolean(r.files?.turnitinReport),
      assessorName:r.assessorName||'',workCount:r.workCount||1,reportType:r.reportType||'assessment',assignmentId:r.assignmentId||null,assignmentReference:r.assignmentReference||'',
      claimReviewStatus:assessorClaimReviewStatus(r),claimReviewLabel:projectReviewLabel(assessorClaimReviewStatus(r)),claimReviewNote:r.claimReviewNote||'',claimReviewedAt:r.claimReviewedAt||null,claimReviewedBy:r.claimReviewedBy||'',
      assignmentWorkNo:r.assignmentWorkNo||null,assignmentTotalWorks:r.assignmentTotalWorks||null,earlyBirdQualified:Boolean(r.earlyBirdQualified),
      assignmentCount:info.count,assignmentLimit,assignedAssessors:info.assessors,assignmentRole:submissionType==='revised'?'vetter':submissionType==='fresh'?'assessor':'none',
      reportFileCount:Array.isArray(r.files?.reportFile)?r.files.reportFile.length:(r.files?.reportFile?1:0),claimFormCount:Array.isArray(r.files?.claimForm)?r.files.claimForm.length:(r.files?.claimForm?1:0),scoreSheetCount:Array.isArray(r.files?.scoreSheet)?r.files.scoreSheet.length:(r.files?.scoreSheet?1:0),
      dissertationFileCount:Array.isArray(r.files?.dissertationFile)?r.files.dissertationFile.length:(r.files?.dissertationFile?1:0),dissertationFileName:Array.isArray(r.files?.dissertationFile)?(r.files.dissertationFile[0]?.originalName||''):(r.files?.dissertationFile?.originalName||''),
      feedbackStates:r.portalType==='assessor'?(r.works||[]).map(w=>feedbackAdminInfoForWork(w,records,r.department)):[]
    };
  });
}
function collectStoredFiles(record) {
  const out=[];
  const visit=v=>{
    if(!v) return;
    if(Array.isArray(v)){v.forEach(visit);return;}
    if(typeof v==='object'){
      if(v.storedName) out.push(path.join(FILES_DIR,path.basename(v.storedName)));
      else Object.values(v).forEach(visit);
    }
  };
  visit(record?.files);
  visit(record?.works);
  return [...new Set(out)];
}
async function deleteDepartmentSubmissions(department, ids) {
  const unique=[...new Set((ids||[]).map(String))];
  if(!unique.length) return {deleted:0, records:[]};
  const all=await readDb();
  const targets=all.filter(r=>r.department===department && unique.includes(r.id));
  if(!targets.length) return {deleted:0, records:[]};
  const targetIds=new Set(targets.map(r=>r.id));
  await writeDb(all.filter(r=>!targetIds.has(r.id)));
  await Promise.all(targets.flatMap(collectStoredFiles).map(fp=>fsp.unlink(fp).catch(()=>{})));
  const dissertationIds=new Set(targets.filter(r=>r.portalType==='dissertation').map(r=>r.id));
  if(dissertationIds.size){
    await mutateAssignments(list=>{
      const now=new Date().toISOString();
      for(const a of list){
        if(a.department!==department) continue;
        const before=(a.dissertationIds||[]).length;
        a.dissertationIds=(a.dissertationIds||[]).filter(id=>!dissertationIds.has(id));
        if(before!==a.dissertationIds.length && !a.dissertationIds.length){
          a.revokedAt=a.revokedAt||now;
          a.emailStatus='revoked';
          a.revokedReason='All dissertation submissions in this assignment were deleted by the department administrator.';
        }
      }
    });
  }
  return {deleted:targets.length,records:targets};
}

// SECURE DISSERTATION ASSIGNMENT WORKSPACE
// One token opens all assigned works. Download access can expire before the 8-week report-submission window.
app.get('/secure/dissertations/:token', async (req, res) => {
  const a=await assignmentByToken(req.params.token);
  const live=validateLiveAssignmentForSubmission(a);
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if(!live.ok)return res.status(live.status).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Assignment Workspace</title></head><body style="font-family:Arial,sans-serif;background:#f4f7fa;color:#182431"><main style="max-width:760px;margin:70px auto;background:#fff;padding:32px;border-radius:14px"><h2 style="color:#082b4c">Assignment Workspace</h2><p>${htmlEscape(live.message)}</p></main></body></html>`);
  const allRecords=await readDb();
  const dissertations=dissertationRecords(recordsForDepartment(allRecords,a.department));
  const selected=(a.dissertationIds||[]).map(id=>dissertations.find(r=>r.id===id)).filter(Boolean);
  if(selected.length!==(a.dissertationIds||[]).length)return res.status(409).send('One or more dissertations in this assignment are no longer available. Contact the department administrator.');
  const completion=assignmentWorkCompletion(a,allRecords);
  const deadlineBase=new Date(a.sentAt||a.createdAt||Date.now());
  const deadlines={earlyBirdDueAt:a.earlyBirdDueAt||assignmentDeadlineDates(deadlineBase).earlyBirdDueAt,assessmentDueAt:a.assessmentDueAt||assignmentDeadlineDates(deadlineBase).assessmentDueAt};
  const early=new Date(deadlines.earlyBirdDueAt).toLocaleDateString('en-GB',{dateStyle:'long',timeZone:'UTC'});
  const due=new Date(deadlines.assessmentDueAt).toLocaleDateString('en-GB',{dateStyle:'long',timeZone:'UTC'});
  const downloadActive=!a.expiresAt||new Date(a.expiresAt).getTime()>Date.now();
  const expiry=a.expiresAt?new Date(a.expiresAt).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'})+' UTC':'Not specified';
  const assignmentType=a.assignmentType||'assessment';
  const taskTitle=assignmentType==='vetting'?'Vetting':'Assessment';
  const taskLabel=assignmentType==='vetting'?'vetting':'assessment';
  const cards=selected.map((r,i)=>{
    const found=completion.submitted.get(String(r.id));
    const submitted=Boolean(found);
    const submittedAt=found?.record?.submittedAt||'';
    const earlyBird=submitted?earlyBirdForSubmission(a,submittedAt):false;
    const reviewerCount=Array.isArray(r.files?.reviewerResponses)?r.files.reviewerResponses.length:0;
    const revised=(r.submissionType||'fresh')==='revised';
    const downloadButtons=downloadActive?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><a href="/secure/dissertations/${encodeURIComponent(req.params.token)}/works/${encodeURIComponent(r.id)}/dissertation" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:9px 12px;border-radius:7px;font-weight:700">Download ${revised?'Revised ':''}Dissertation</a>${revised&&reviewerCount?`<a href="/secure/dissertations/${encodeURIComponent(req.params.token)}/works/${encodeURIComponent(r.id)}/package" style="display:inline-block;background:#5b6670;color:#fff;text-decoration:none;padding:9px 12px;border-radius:7px;font-weight:700">Download Work Package (${reviewerCount} response${reviewerCount===1?'':'s'})</a>`:''}</div>`:`<div style="margin:12px 0;padding:10px 12px;background:#fff4dd;border:1px solid #ecd7a3;border-radius:7px;color:#795600"><strong>Download period ended.</strong> Report submission remains available until the 8-week due date.</div>`;
    const statusBlock=submitted?`<div style="margin-top:14px;padding:14px;background:#eaf7ef;border:1px solid #b9dfc9;border-radius:8px;color:#12683d"><strong>✓ Submitted</strong><br>Reference: ${htmlEscape(found.record.reference)}<br>Submitted: ${htmlEscape(new Date(submittedAt).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}))} UTC${earlyBird?'<br><strong>Early Bird ✓</strong>':''}</div>`:`<form class="work-submit-form" data-work-id="${htmlEscape(r.id)}" style="margin-top:16px;padding-top:14px;border-top:1px solid #dde5eb"><div class="upload-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px"><label style="display:grid;gap:5px;font-weight:700;font-size:13px">${taskTitle} Report *<input name="reportFile" type="file" accept=".pdf,.doc,.docx" required style="padding:9px;border:1px solid #c9d3db;border-radius:7px"></label><label style="display:grid;gap:5px;font-weight:700;font-size:13px">Claim Form *<input name="claimForm" type="file" accept=".pdf,.doc,.docx" required style="padding:9px;border:1px solid #c9d3db;border-radius:7px"></label><label style="display:grid;gap:5px;font-weight:700;font-size:13px">Score Sheet *<input name="scoreSheet" type="file" accept=".xlsx,.xls,.csv,.pdf,.doc,.docx" required style="padding:9px;border:1px solid #c9d3db;border-radius:7px"></label><label style="display:grid;gap:5px;font-weight:700;font-size:13px">Reviewed Dissertation <span style="font-weight:400;color:#657584">Optional</span><input name="dissertationFile" type="file" accept=".pdf,.doc,.docx" style="padding:9px;border:1px solid #c9d3db;border-radius:7px"></label></div><button type="submit" style="margin-top:12px;background:#137a45;color:#fff;border:0;border-radius:7px;padding:10px 15px;font-weight:800;cursor:pointer">Submit Work ${i+1}</button><div class="work-message" aria-live="polite" style="margin-top:9px;font-size:13px"></div></form>`;
    return `<section style="background:#fff;border:1px solid #d8e1e8;border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 2px 8px rgba(8,43,76,.04)"><div style="display:flex;justify-content:space-between;gap:15px;align-items:flex-start"><div><span style="font-size:12px;font-weight:800;color:#a57900;text-transform:uppercase">Work ${i+1} · ${revised?'Revised':'Fresh'} submission</span><h3 style="margin:5px 0;color:#082b4c">${htmlEscape(r.studentName||'Student')}</h3><div style="color:#526575;font-size:14px">${htmlEscape(r.indexNumber||'')} · ${htmlEscape(r.programme||'')}</div></div><span style="border-radius:999px;padding:6px 10px;font-size:12px;font-weight:800;${submitted?'background:#e8f6ee;color:#12683d':'background:#fff4dd;color:#8a5b00'}">${submitted?'Submitted':'Pending'}</span></div><p style="margin:12px 0 4px;color:#34495a"><strong>Title:</strong> ${htmlEscape(r.dissertationTopic||'')}</p>${revised?`<p style="margin:5px 0;color:#526575;font-size:13px">Reviewer response files linked: <strong>${reviewerCount}</strong></p>`:''}${downloadButtons}${statusBlock}</section>`;
  }).join('');
  const phoneValue=htmlEscape(a.assessorPhone||'');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${taskTitle} Assignment</title></head><body style="font-family:Arial,sans-serif;background:#f4f7fa;color:#182431;margin:0"><main style="max-width:900px;margin:38px auto;padding:0 16px 50px"><section style="background:#fff;padding:28px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.07)"><div style="font-size:12px;text-transform:uppercase;color:#d4a72c;font-weight:bold">University of Cape Coast</div><h1 style="color:#082b4c;font-size:28px;margin-bottom:6px">Your ${taskTitle} Assignment</h1><p style="margin-top:0;color:#526575">${htmlEscape(a.departmentName)} · ${htmlEscape(a.reference)}</p><p>Dear <strong>${htmlEscape(a.assessorName)}</strong>, you have <strong>${selected.length}</strong> assigned dissertation${selected.length===1?'':'s'}.</p><div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:#eef5f9;padding:14px;border-radius:10px;margin:18px 0"><strong style="font-size:20px;color:#082b4c">${completion.submittedCount} of ${completion.total} submitted</strong><span style="color:#526575">${completion.pendingCount} pending</span></div><div style="margin:18px 0;padding:14px 16px;background:#fff7dc;border:1px solid #ead58c;border-radius:8px"><strong>${taskTitle} timeline</strong><p style="margin:7px 0">Early Bird per work: submit by <strong>${htmlEscape(early)}</strong>.</p><p style="margin:7px 0">Final ${taskLabel} deadline: <strong>${htmlEscape(due)}</strong>.</p><p style="margin:7px 0">Dissertation download access: <strong>${htmlEscape(expiry)}</strong>.</p></div>${downloadActive?`<a href="/secure/dissertations/${encodeURIComponent(req.params.token)}/download" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:12px 17px;border-radius:8px;font-weight:bold">Download All ${selected.length} Work${selected.length===1?'':'s'} as ZIP</a>`:''}<div style="margin-top:20px;max-width:420px"><label style="display:grid;gap:6px;font-weight:800">${taskTitle==='Vetting'?'Vetter':'Assessor'} Telephone Number *<input id="assessorPhone" value="${phoneValue}" placeholder="Enter once for report submissions" style="font:inherit;padding:10px 11px;border:1px solid #bcc9d3;border-radius:8px"></label><small style="color:#657584">Student details are securely linked and cannot be edited.</small></div></section><div>${cards}</div></main><script>const assignmentToken=${JSON.stringify(req.params.token).replace(/</g,'\u003c')};document.querySelectorAll('.work-submit-form').forEach(form=>{form.addEventListener('submit',async e=>{e.preventDefault();const msg=form.querySelector('.work-message'),btn=form.querySelector('button[type="submit"]'),phone=document.getElementById('assessorPhone').value.trim();if(!phone){msg.style.color='#a12f2f';msg.textContent='Enter the assessor/vetter telephone number above.';document.getElementById('assessorPhone').focus();return;}if(!form.reportValidity())return;const fd=new FormData(form);fd.append('phone',phone);btn.disabled=true;msg.style.color='#526575';msg.textContent='Uploading and saving this report…';try{const r=await fetch('/api/assessor/assignment/'+encodeURIComponent(assignmentToken)+'/works/'+encodeURIComponent(form.dataset.workId),{method:'POST',body:fd});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'The report could not be submitted.');msg.style.color='#12683d';msg.textContent='Submitted successfully. Updating progress…';setTimeout(()=>location.reload(),600);}catch(err){msg.style.color='#a12f2f';msg.textContent=err.message||'The report could not be submitted.';btn.disabled=false;}});});</script></body></html>`);
});

app.get('/secure/dissertations/:token/works/:dissertationId/dissertation', async(req,res)=>{
  const a=await assignmentByToken(req.params.token);const live=validateLiveAssignment(a);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(!live.ok)return res.status(live.status).send(live.message);
  const id=String(req.params.dissertationId||'');if(!(a.dissertationIds||[]).map(String).includes(id))return res.status(403).send('This dissertation is not part of the assignment.');
  const record=(await readDb()).find(r=>r.id===id&&r.portalType==='dissertation'&&r.department===a.department);const file=record?.files?.dissertationFile;
  if(!file)return res.status(404).send('The dissertation file is unavailable.');const fp=path.join(FILES_DIR,path.basename(file.storedName));if(!fs.existsSync(fp))return res.status(404).send('The dissertation file is unavailable.');
  res.download(fp,safeBaseName(file.originalName||`${record.indexNumber||'dissertation'}${path.extname(fp)}`),async err=>{if(err){console.error('Individual dissertation download failed:',err);return;}await noteAssignmentDownload(a.id).catch(e=>console.error('Could not record assignment download:',e));});
});

app.get('/secure/dissertations/:token/works/:dissertationId/package', async(req,res)=>{
  const a=await assignmentByToken(req.params.token);const live=validateLiveAssignment(a);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(!live.ok)return res.status(live.status).send(live.message);
  const id=String(req.params.dissertationId||'');if(!(a.dissertationIds||[]).map(String).includes(id))return res.status(403).send('This dissertation is not part of the assignment.');
  const record=(await readDb()).find(r=>r.id===id&&r.portalType==='dissertation'&&r.department===a.department);if(!record)return res.status(404).send('The assigned work is unavailable.');
  const zipFiles=[];const main=record.files?.dissertationFile;if(main){const fp=path.join(FILES_DIR,path.basename(main.storedName));if(fs.existsSync(fp))zipFiles.push({path:fp,name:safeBaseName(`01 - ${record.indexNumber||'Student'} - Dissertation${path.extname(main.originalName||fp)||'.docx'}`),size:Number(main.size||fs.statSync(fp).size)});}
  (record.files?.reviewerResponses||[]).forEach((f,i)=>{const fp=path.join(FILES_DIR,path.basename(f.storedName));if(fs.existsSync(fp))zipFiles.push({path:fp,name:safeBaseName(`${String(i+2).padStart(2,'0')} - Reviewer Response - ${f.originalName||'response'}`),size:Number(f.size||fs.statSync(fp).size)});});
  if(!zipFiles.length)return res.status(404).send('The assigned work files are unavailable.');res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(`${record.indexNumber||record.reference}-work-package.zip`)}"`);try{await streamZipArchive(res,zipFiles);await noteAssignmentDownload(a.id);}catch(e){console.error('Work package ZIP failed:',e);if(!res.headersSent)res.status(500).send('Could not prepare the work package.');else res.end();}
});

app.get('/secure/dissertations/:token/download', async (req, res) => {
  const a = await assignmentByToken(req.params.token);
  const live = validateLiveAssignment(a);
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  if (!live.ok) return res.status(live.status).send(live.message);

  const records = dissertationRecords(recordsForDepartment(await readDb(), a.department));
  const selected = (a.dissertationIds || []).map(id => records.find(r => r.id === id)).filter(Boolean);
  const zipFiles=[];
  selected.forEach((r,i)=>{
    const item=r.files?.dissertationFile;
    const prefix=String(i+1).padStart(3,'0');
    if(item){
      const fp=path.join(FILES_DIR,path.basename(item.storedName));
      if(fs.existsSync(fp)){
        const ext=path.extname(item.originalName || fp) || '.docx';
        zipFiles.push({path:fp,name:safeBaseName(`${prefix} - ${r.indexNumber || 'No Index'} - ${r.studentName || 'Student'} - Dissertation${ext}`),size:Number(item.size||fs.statSync(fp).size)});
      }
    }
    (r.files?.reviewerResponses||[]).forEach((f,j)=>{
      const fp=path.join(FILES_DIR,path.basename(f.storedName));
      if(!fs.existsSync(fp))return;
      const ext=path.extname(f.originalName||fp)||'.docx';
      zipFiles.push({path:fp,name:safeBaseName(`${prefix} - ${r.indexNumber || 'No Index'} - Reviewer Response ${j+1}${ext}`),size:Number(f.size||fs.statSync(fp).size)});
    });
  });
  if(!zipFiles.length) return res.status(404).send('The assigned dissertation files are currently unavailable.');
  const totalSize=zipFiles.reduce((sum,f)=>sum+f.size,0);
  if(totalSize > 3.5 * 1024 * 1024 * 1024) return res.status(413).send('This dissertation package is too large for one ZIP. Please contact the department administrator.');

  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(`${a.reference}-dissertations.zip`)}"`);
  try {
    await streamZipArchive(res, zipFiles);
    await noteAssignmentDownload(a.id);
  } catch(e) {
    console.error('Secure dissertation ZIP download failed:', e);
    if(!res.headersSent) res.status(500).send('Could not prepare the dissertation ZIP file.'); else res.end();
  }
});

// SECURE STUDENT ASSESSMENT FEEDBACK LINKS
app.get('/secure/feedback/:token', async(req,res)=>{
  const found=await feedbackByToken(req.params.token);
  const live=validateLiveFeedback(found);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  if(!live.ok) return res.status(live.status).send(`<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f7fa;color:#182431"><main style="max-width:680px;margin:70px auto;background:#fff;padding:32px;border-radius:14px"><h2>Assessment Feedback</h2><p>${htmlEscape(live.message)}</p></main></body></html>`);
  const {record,work}=found;const f=work.feedback;const expiry=new Date(f.expiresAt).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'})+' UTC';
  const reportType=f.reportType||record.reportType||'assessment';const label=reportType==='vetting'?'Vetting':'Assessment';
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label} Feedback</title></head><body style="font-family:Arial,sans-serif;background:#f4f7fa;color:#182431;margin:0"><main style="max-width:680px;margin:60px auto;background:#fff;padding:32px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.08)"><div style="font-size:12px;text-transform:uppercase;color:#d4a72c;font-weight:bold">University of Cape Coast</div><h1 style="color:#082b4c;font-size:26px">Dissertation ${label} Feedback</h1><p>Dear ${htmlEscape(work.studentName||f.studentName||'Student')},</p><p>Your ${label.toLowerCase()} feedback from ${htmlEscape(record.departmentName||'the department')} is ready.</p><p>The download contains an anonymised ${label.toLowerCase()} report${work.feedback?.studentFiles?.dissertationFile?' and an anonymised reviewed dissertation':''}. The claim form, score sheet and assessor/vetter identity are not included.</p><form method="get" action="/secure/feedback/${encodeURIComponent(req.params.token)}/download"><button type="submit" style="background:#082b4c;color:white;border:0;border-radius:8px;padding:13px 18px;font-weight:bold;cursor:pointer">Download ${label} Feedback</button></form><p style="margin-top:22px;color:#647382;font-size:13px">This secure link expires on <strong>${htmlEscape(expiry)}</strong>. Please keep it private.</p></main></body></html>`);
});
app.get('/secure/feedback/:token/download', async(req,res)=>{
  const found=await feedbackByToken(req.params.token);const live=validateLiveFeedback(found);
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  if(!live.ok)return res.status(live.status).send(live.message);
  const {record,work,workIndex}=found;const zipFiles=[];const reportType=work.feedback?.reportType||record.reportType||'assessment';const reportLabel=reportType==='vetting'?'Vetting Report':'Assessment Report';
  const report=work.feedback?.studentFiles?.reportFile;if(report){const fp=path.join(FILES_DIR,path.basename(report.storedName));if(fs.existsSync(fp))zipFiles.push({path:fp,name:safeBaseName(`${reportLabel} - ${work.indexNumber||work.studentName}${path.extname(report.originalName||fp)}`),size:Number(report.size||fs.statSync(fp).size)});}
  const reviewed=work.feedback?.studentFiles?.dissertationFile;if(reviewed){const fp=path.join(FILES_DIR,path.basename(reviewed.storedName));if(fs.existsSync(fp))zipFiles.push({path:fp,name:safeBaseName(`Reviewed Dissertation - ${work.indexNumber||work.studentName}${path.extname(reviewed.originalName||fp)}`),size:Number(reviewed.size||fs.statSync(fp).size)});}
  if(!zipFiles.length)return res.status(404).send('The assessment feedback files are unavailable.');
  res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(`${record.reference}-${work.indexNumber||'student'}-feedback.zip`)}"`);
  try{await streamZipArchive(res,zipFiles);await mutateAssessmentWork(record.id,workIndex,w=>{w.feedback.downloadedAt=w.feedback.downloadedAt||new Date().toISOString();w.feedback.lastDownloadedAt=new Date().toISOString();w.feedback.downloadCount=Number(w.feedback.downloadCount||0)+1;return true;});}
  catch(e){console.error('Student feedback ZIP failed:',e);if(!res.headersSent)res.status(500).send('Could not prepare the feedback ZIP.');else res.end();}
});

// PUBLIC RESOURCES + DEVELOPER RESOURCE ADMINISTRATION
app.get('/api/resources', async (req, res) => {
  const portal = String(req.query.portal || '').trim();
  const department = String(req.query.department || '').trim();
  if (portal && !RESOURCE_PORTALS.has(portal)) return res.status(400).json({ error:'Unknown submission portal.' });
  if (department && !departmentFromSlug(department)) return res.status(400).json({ error:'Unknown department.' });
  const uploaded = await readResources();
  const all = [...BUILTIN_RESOURCES, ...uploaded];
  const filtered = all.filter(r => {
    if (portal && !(r.portals || []).includes(portal)) return false;
    if(r.builtIn&&!department) return false;
    const departments=Array.isArray(r.departments)?r.departments:[];
    if (department) return !departments.length || departments.includes(department);
    return departments.length===0;
  });
  res.json(filtered.map(r=>publicResource(r,department)));
});

app.get('/api/resources/:id/download', async (req, res) => {
  const id = String(req.params.id || '');
  const builtin = BUILTIN_RESOURCES.find(r => r.id === id);
  if (builtin) {
    const department=String(req.query.department||'').trim();
    if(!departmentFromSlug(department)) return res.status(400).send('Select a valid department before downloading this resource.');
    const sourcePath=builtinResourcePath(builtin,department);
    if (!sourcePath||!fs.existsSync(sourcePath)) return res.status(404).send('The department-specific resource file is unavailable.');
    return res.download(sourcePath, `${department}-${builtin.originalName}`);
  }
  const resource = (await readResources()).find(r => r.id === id);
  if (!resource) return res.status(404).send('Resource not found.');
  const filePath = path.join(RESOURCES_DIR, path.basename(resource.storedName || ''));
  if (!fs.existsSync(filePath)) return res.status(404).send('Resource file is unavailable.');
  return res.download(filePath, resource.originalName || 'resource');
});

app.get('/developer', developerAuth, (_req,res)=>res.sendFile(path.join(__dirname,'developer','index.html')));
app.get('/developer/developer.css', developerAuth, (_req,res)=>res.sendFile(path.join(__dirname,'developer','developer.css')));
app.get('/developer/developer.js', developerAuth, (_req,res)=>res.sendFile(path.join(__dirname,'developer','developer.js')));
app.get('/api/developer/preview-options', developerAuth, async(_req,res)=>{
  const accounts=(await readAdminUsers()).filter(a=>a.active!==false).map(publicAdminUser);
  res.json({
    departments:Object.entries(DEPARTMENTS).map(([slug,dept])=>({slug,name:dept.name})),
    staffUnits:Object.entries(STAFF_UNITS).map(([id,unit])=>({id,label:unit.label})),
    profiles:Object.entries(DEVELOPER_PREVIEW_PROFILES).map(([id,p])=>({id,label:p.label,role:p.role,sections:p.sections})),
    accounts
  });
});
app.post('/api/developer/staff-preview-session', developerAuth, async(req,res)=>{
  const unit=String(req.body?.unit||'').trim();
  if(!Object.prototype.hasOwnProperty.call(STAFF_UNITS,unit)) return res.status(400).json({error:'Choose a valid functional unit.'});
  const expiresAt=new Date(Date.now()+DEVELOPER_PREVIEW_TTL_MS).toISOString();
  const identity={id:`developer-preview:staff:${unit}`,name:`Developer Preview · ${STAFF_UNITS[unit].label}`,username:DEVELOPER_ADMIN_USER,role:'administrator',units:[unit],departments:Object.keys(DEPARTMENTS),sections:['project-work','field-experience','dissertation','assessor','payroll','auditor'],developerPreview:true,developerPreviewLabel:STAFF_UNITS[unit].label,previewExpiresAt:expiresAt};
  const token=createAdminSession(identity,'__staff__',DEVELOPER_PREVIEW_TTL_MS);
  res.cookie('ucc_admin_session',token,{httpOnly:true,secure:req.secure||String(req.headers['x-forwarded-proto']||'').includes('https'),sameSite:'lax',maxAge:DEVELOPER_PREVIEW_TTL_MS,path:'/'});
  res.json({ok:true,redirect:unit==='student-support'?'/support-admin':'/staff',expiresAt,previewLabel:STAFF_UNITS[unit].label});
});
app.post('/api/developer/preview-session', developerAuth, async(req,res)=>{
  try {
    const department=String(req.body?.department||'').trim();
    const destination=String(req.body?.destination||'admin').trim();
    const mode=String(req.body?.mode||'profile').trim();
    if(!departmentFromSlug(department)) return res.status(400).json({error:'Choose a valid department.'});
    if(!['admin','payroll','auditor'].includes(destination)) return res.status(400).json({error:'Choose a valid destination portal.'});
    let identity;
    let previewLabel='';
    if(mode==='account') {
      const accountId=String(req.body?.accountId||'').trim();
      const account=(await readAdminUsers()).find(a=>a.id===accountId&&a.active!==false);
      if(!account) return res.status(404).json({error:'The selected administrator account is unavailable or disabled.'});
      if(!(account.departments||[]).includes(department)) return res.status(400).json({error:'The selected administrator does not have access to this department.'});
      const publicAccount=publicAdminUser(account);
      previewLabel=`${publicAccount.name||publicAccount.username} (${publicAccount.role})`;
      identity={...publicAccount,master:false};
    } else {
      const profileId=String(req.body?.profileId||'department-administrator').trim();
      const profile=DEVELOPER_PREVIEW_PROFILES[profileId];
      if(!profile) return res.status(400).json({error:'Choose a valid preview role.'});
      const previewDepartments=['operations-officer','payroll-officer','auditor'].includes(profileId)?Object.keys(DEPARTMENTS):[department];
      previewLabel=profile.label;
      identity={
        id:`developer-preview:${profileId}:${department}`,
        name:`Developer Preview · ${profile.label}`,
        username:DEVELOPER_ADMIN_USER,
        role:profile.role,
        sections:[...profile.sections],
        departments:previewDepartments,
        master:profileId==='department-administrator'
      };
    }
    if(!previewDestinationAllowed(identity,destination)) return res.status(400).json({error:'The selected preview identity does not have access to that destination portal.'});
    const expiresAt=new Date(Date.now()+DEVELOPER_PREVIEW_TTL_MS).toISOString();
    identity={...identity,developerPreview:true,developerPreviewLabel:previewLabel,previewExpiresAt:expiresAt};
    const token=createAdminSession(identity,department,DEVELOPER_PREVIEW_TTL_MS);
    res.cookie('ucc_admin_session',token,{httpOnly:true,secure:req.secure||String(req.headers['x-forwarded-proto']||'').includes('https'),sameSite:'lax',maxAge:DEVELOPER_PREVIEW_TTL_MS,path:'/'});
    res.json({ok:true,redirect:developerPreviewRedirect(department,destination),expiresAt,previewLabel,department,destination});
  } catch(e) {
    console.error('Developer preview session failed:',e);
    res.status(500).json({error:'Could not create the developer preview session.'});
  }
});
app.get('/api/developer/resources', developerAuth, async (_req,res)=>{
  const uploaded = await readResources();
  const builtIns=Object.keys(DEPARTMENTS).flatMap(department=>BUILTIN_RESOURCES.map(r=>({...publicResource(r,department),departments:[department],canDelete:false})));
  res.json([...builtIns, ...uploaded.map(r => ({...publicResource(r), canDelete:true}))]);
});
app.post('/api/developer/resources', developerAuth, resourceUpload.single('resourceFile'), async (req,res)=>{
  try {
    if (!req.file) return res.status(400).json({ error:'Select a supported resource file to upload.' });
    const title = cleanHumanText(req.body?.title);
    const description = String(req.body?.description || '').trim().slice(0, 1000);
    const portals = normalizeResourcePortals(req.body?.portals);
    const departments = normalizeAdminDepartments(req.body?.departments);
    if (!title) { await fsp.unlink(req.file.path).catch(()=>{}); return res.status(400).json({ error:'Resource title is required.' }); }
    if (!portals.length) { await fsp.unlink(req.file.path).catch(()=>{}); return res.status(400).json({ error:'Select at least one submission portal where the resource should appear.' }); }
    if (!departments.length) { await fsp.unlink(req.file.path).catch(()=>{}); return res.status(400).json({ error:'Select at least one department where the resource should appear.' }); }
    const record = {
      id: crypto.randomUUID(), title: title.slice(0,180), description, portals, departments,
      originalName: req.file.originalname, storedName: path.basename(req.file.path), mimeType:req.file.mimetype,
      size:req.file.size, uploadedAt:new Date().toISOString(), builtIn:false
    };
    await mutateResources(records => { records.push(record); return record; });
    res.status(201).json({ ok:true, resource:publicResource(record) });
  } catch (e) {
    console.error('Developer resource upload failed:', e);
    if (req.file?.path) await fsp.unlink(req.file.path).catch(()=>{});
    res.status(500).json({ error:'The resource could not be uploaded.' });
  }
});
app.delete('/api/developer/resources/:id', developerAuth, async (req,res)=>{
  const id=String(req.params.id||'');
  if (BUILTIN_RESOURCES.some(r=>r.id===id)) return res.status(400).json({ error:'Built-in resources cannot be deleted from the developer portal.' });
  let removed=null;
  await mutateResources(records => {
    const index=records.findIndex(r=>r.id===id);
    if(index<0) return null;
    removed=records.splice(index,1)[0];
    return removed;
  });
  if(!removed) return res.status(404).json({ error:'Resource not found.' });
  if(removed.storedName) await fsp.unlink(path.join(RESOURCES_DIR,path.basename(removed.storedName))).catch(()=>{});
  res.json({ ok:true, deleted:id });
});

// PUBLIC FIELD EXPERIENCE / TEACHING PRACTICE SETTINGS
app.get('/api/field-experience/settings', async(_req,res)=>{
  const settings=await readPortalSettings();
  res.json({claimFormRequired:settings.fieldExperienceClaimFormRequired});
});

// PUBLIC STUDY CENTRES + DEVELOPER ADMIN ACCOUNT / STUDY CENTRE MANAGEMENT
app.get('/api/study-centres', async(req,res)=>{
  const department=String(req.query.department||'').trim();
  if(!departmentFromSlug(department)) return res.status(400).json({error:'Select a valid department before loading study centres.'});
  res.json(await readStudyCentres(department));
});
app.get('/api/developer/portal-settings', developerAuth, async(_req,res)=>{
  const settings=await readPortalSettings();
  res.json({fieldExperienceClaimFormRequired:settings.fieldExperienceClaimFormRequired});
});
app.patch('/api/developer/portal-settings', developerAuth, async(req,res)=>{
  const current=await readPortalSettings();
  if(req.body?.fieldExperienceClaimFormRequired!==undefined) current.fieldExperienceClaimFormRequired=Boolean(req.body.fieldExperienceClaimFormRequired);
  const saved=await writePortalSettings(current);
  res.json({ok:true,fieldExperienceClaimFormRequired:saved.fieldExperienceClaimFormRequired});
});

app.get('/api/developer/study-centres', developerAuth, async(_req,res)=>{
  const departments=await readStudyCentreCatalogue();
  const total=Object.values(departments).reduce((n,list)=>n+(Array.isArray(list)?list.length:0),0);
  const directory=await readStudyCentreDirectory();
  const centreStates=Object.fromEntries(directory.map(item=>[item.name.toLowerCase(),item.enabled!==false]));
  res.json({departments,total,centreStates});
});
app.post('/api/developer/study-centres/item', developerAuth, async(req,res)=>{
  try{
    const name=cleanHumanText(req.body?.name),code=normalizeCentreCode(req.body?.code),idText=cleanHumanText(req.body?.id);
    const departments=normalizeAdminDepartments(req.body?.departments);
    if(!name)return res.status(400).json({error:'Enter the study-centre name.'});
    if(!code)return res.status(400).json({error:'Enter the official centre code.'});
    if(!departments.length)return res.status(400).json({error:'Select at least one department for the study centre.'});
    const directory=await readStudyCentreDirectory();
    const existing=directory.find(item=>item.code===code);
    const oldName=existing?.name||'';
    const id=idText&&/^\d+$/.test(idText)?Number(idText):(idText||existing?.id||'');
    if(existing){existing.name=name;existing.id=id;existing.enabled=true;}else directory.push({id,code,name,enabled:true});
    await writeStudyCentreDirectory(directory);
    const catalogue=await readStudyCentreCatalogue();
    if(oldName&&oldName.localeCompare(name,undefined,{sensitivity:'base'})!==0){
      for(const slug of Object.keys(DEPARTMENTS)) catalogue[slug]=(catalogue[slug]||[]).map(item=>String(item).localeCompare(oldName,undefined,{sensitivity:'base'})===0?name:item);
    }
    for(const slug of departments){
      const list=Array.isArray(catalogue[slug])?catalogue[slug]:[];
      if(!list.some(x=>String(x).localeCompare(name,undefined,{sensitivity:'base'})===0)) list.push(name);
      catalogue[slug]=list;
    }
    const saved=await writeStudyCentreCatalogue(catalogue);
    res.status(existing?200:201).json({ok:true,name,code,id,departments,updated:Boolean(existing),catalogue:saved});
  }catch(e){res.status(400).json({error:e.message||'Could not add the study centre.'});}
});
app.delete('/api/developer/study-centres/item', developerAuth, async(req,res)=>{
  try{
    const name=cleanHumanText(req.body?.name);
    const departments=normalizeAdminDepartments(req.body?.departments);
    if(!name)return res.status(400).json({error:'Specify the study centre to delete.'});
    if(!departments.length)return res.status(400).json({error:'Specify the department containing the study centre.'});
    const catalogue=await readStudyCentreCatalogue();
    let removed=0;
    for(const slug of departments){
      const before=Array.isArray(catalogue[slug])?catalogue[slug]:[];
      const after=before.filter(x=>String(x).localeCompare(name,undefined,{sensitivity:'base'})!==0);
      removed+=before.length-after.length;catalogue[slug]=after;
    }
    if(!removed)return res.status(404).json({error:'Study centre not found in the selected department.'});
    const saved=await writeStudyCentreCatalogue(catalogue);
    res.json({ok:true,removed,name,departments,catalogue:saved});
  }catch(e){res.status(400).json({error:e.message||'Could not delete the study centre.'});}
});

app.post('/api/developer/study-centres', developerAuth, upload.single('studyCentresCsv'), async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'Select a CSV file containing study centres.'});
    const departments=normalizeAdminDepartments(req.body?.departments);
    if(!departments.length){await fsp.unlink(req.file.path).catch(()=>{});return res.status(400).json({error:'Select at least one department for this study-centre list.'});}
    if(path.extname(req.file.originalname||'').toLowerCase()!=='.csv'){await fsp.unlink(req.file.path).catch(()=>{});return res.status(400).json({error:'Upload a CSV file. Put one study centre per row in the first column.'});}
    const centres=parseStudyCentreCsv(req.file.path);await fsp.unlink(req.file.path).catch(()=>{});
    const saved=await writeStudyCentres(centres,departments);res.json({ok:true,count:centres.length,departments,centres,catalogue:saved});
  }catch(e){if(req.file?.path)await fsp.unlink(req.file.path).catch(()=>{});res.status(400).json({error:e.message||'Could not update study centres.'});}
});
app.post('/api/developer/study-centres/reset', developerAuth, async(_req,res)=>{
  const catalogue=defaultStudyCentreCatalogue();
  const saved=await writeStudyCentreCatalogue(catalogue);res.json({ok:true,count:defaultStudyCentreNames().length,departments:Object.keys(DEPARTMENTS),catalogue:saved});
});

app.get('/api/developer/study-centre-directory', developerAuth, async(_req,res)=>{
  const centres=await readStudyCentreDirectory(),catalogue=await readStudyCentreCatalogue();
  const enriched=centres.map(centre=>({...centre,departments:Object.keys(DEPARTMENTS).filter(slug=>(catalogue[slug]||[]).some(name=>String(name).localeCompare(centre.name,undefined,{sensitivity:'base'})===0))}));
  res.json({count:enriched.length,enabled:enriched.filter(c=>c.enabled!==false).length,disabled:enriched.filter(c=>c.enabled===false).length,centres:enriched});
});
app.get('/api/developer/study-centre-directory.xlsx', developerAuth, async(_req,res)=>{
  const centres=await readStudyCentreDirectory();const buffer=centreDirectoryWorkbookBuffer(centres);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="study-centre-code-directory.xlsx"');res.send(buffer);
});
app.post('/api/developer/study-centre-directory/item', developerAuth, async(req,res)=>{
  try{
    const code=normalizeCentreCode(req.body?.code),name=cleanHumanText(req.body?.name),idText=cleanHumanText(req.body?.id);
    const departments=normalizeAdminDepartments(req.body?.departments);
    if(!code||!name)return res.status(400).json({error:'Centre code and centre name are required.'});
    const list=await readStudyCentreDirectory();
    const existing=list.find(x=>x.code===code);
    const id=idText&&/^\d+$/.test(idText)?Number(idText):(idText||'');
    const oldName=existing?.name||'';
    if(existing){existing.name=name;existing.enabled=req.body?.enabled===undefined?existing.enabled!==false:Boolean(req.body.enabled);if(idText!=='')existing.id=id;}else list.push({id,code,name,enabled:req.body?.enabled!==false});
    const saved=await writeStudyCentreDirectory(list);
    let catalogue=await readStudyCentreCatalogue();
    if(oldName&&oldName.localeCompare(name,undefined,{sensitivity:'base'})!==0){for(const slug of Object.keys(DEPARTMENTS))catalogue[slug]=(catalogue[slug]||[]).map(item=>String(item).localeCompare(oldName,undefined,{sensitivity:'base'})===0?name:item);}
    for(const slug of departments){if(!(catalogue[slug]||[]).some(item=>String(item).localeCompare(name,undefined,{sensitivity:'base'})===0))catalogue[slug].push(name);}
    if(departments.length||oldName)catalogue=await writeStudyCentreCatalogue(catalogue);
    res.status(existing?200:201).json({ok:true,updated:Boolean(existing),centre:saved.find(x=>x.code===code),departments,catalogue,count:saved.length});
  }catch(e){res.status(400).json({error:e.message||'Could not add or update the study-centre code.'});}
});
app.patch('/api/developer/study-centre-directory/:code/status', developerAuth, async(req,res)=>{
  try{
    const code=normalizeCentreCode(req.params.code);const enabled=Boolean(req.body?.enabled);
    const list=await readStudyCentreDirectory();const centre=list.find(item=>item.code===code);
    if(!centre)return res.status(404).json({error:'Centre code not found.'});
    centre.enabled=enabled;const saved=await writeStudyCentreDirectory(list);
    res.json({ok:true,centre:saved.find(item=>item.code===code),message:`${centre.name} is now ${enabled?'enabled':'disabled'}.`});
  }catch(e){res.status(400).json({error:e.message||'Could not change the study-centre status.'});}
});
app.delete('/api/developer/study-centre-directory/item', developerAuth, async(req,res)=>{
  try{
    const code=normalizeCentreCode(req.body?.code);if(!code)return res.status(400).json({error:'Specify the centre code to delete.'});
    const list=await readStudyCentreDirectory();const after=list.filter(x=>x.code!==code);
    if(after.length===list.length)return res.status(404).json({error:'Centre code not found.'});
    if(!after.length)return res.status(400).json({error:'The centre-code directory cannot be empty.'});
    const saved=await writeStudyCentreDirectory(after);res.json({ok:true,deleted:code,count:saved.length});
  }catch(e){res.status(400).json({error:e.message||'Could not delete the centre code.'});}
});

app.post('/api/developer/study-centre-directory', developerAuth, upload.single('studyCentreDirectoryFile'), async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'Select an Excel or CSV study-centre directory.'});
    const ext=path.extname(req.file.originalname||'').toLowerCase();
    if(!['.xlsx','.xls','.csv'].includes(ext)){await fsp.unlink(req.file.path).catch(()=>{});return res.status(400).json({error:'Upload an .xlsx, .xls or .csv file containing CODE and CENTER_NAME/CENTRE_NAME columns.'});}
    const departments=normalizeAdminDepartments(req.body?.departments);
    if(!departments.length){await fsp.unlink(req.file.path).catch(()=>{});return res.status(400).json({error:'Select at least one department for the imported centre directory.'});}
    const centres=parseStudyCentreDirectoryFile(req.file.path);await fsp.unlink(req.file.path).catch(()=>{});const saved=await writeStudyCentreDirectory(centres);
    const catalogue=await writeStudyCentres(saved.filter(item=>item.enabled!==false).map(item=>item.name),departments);
    res.json({ok:true,count:saved.length,departments,centres:saved,catalogue});
  }catch(e){if(req.file?.path)await fsp.unlink(req.file.path).catch(()=>{});res.status(400).json({error:e.message||'Could not update the study-centre code directory.'});}
});
app.post('/api/developer/study-centre-directory/reset', developerAuth, async(_req,res)=>{
  try{const defaults=normalizeStudyCentreDirectory(JSON.parse(await fsp.readFile(DEFAULT_STUDY_CENTRE_DIRECTORY_PATH,'utf8')));const saved=await writeStudyCentreDirectory(defaults);const catalogue=await writeStudyCentreCatalogue(defaultStudyCentreCatalogue());res.json({ok:true,count:saved.length,departments:Object.keys(DEPARTMENTS),centres:saved,catalogue});}
  catch(e){res.status(500).json({error:'Could not restore the bundled study-centre directory.'});}
});

app.get('/api/developer/admin-users', developerAuth, async(_req,res)=>res.json((await readAdminUsers()).map(publicAdminUser)));
app.post('/api/developer/admin-users', developerAuth, async(req,res)=>{
  const name=cleanHumanText(req.body?.name).slice(0,160),email=cleanHumanText(req.body?.email).toLowerCase().slice(0,254);
  const requestedUsername=cleanHumanText(req.body?.username).toLowerCase().slice(0,100);
  const username=requestedUsername || email;
  const role=String(req.body?.role||'viewer').trim();const departments=normalizeAdminDepartments(req.body?.departments);const sections=normalizeAdminSections(req.body?.sections);const units=normalizeStaffUnits(req.body?.units);
  if(!name||!isEmail(email)||!username)return res.status(400).json({error:'Administrator name and a valid email address are required.'});
  if(!/^[a-z0-9._@-]+$/i.test(username))return res.status(400).json({error:'Username may contain letters, numbers, dots, underscores, @ and hyphens only.'});
  if(!ADMIN_ROLES.has(role))return res.status(400).json({error:'Select a valid role.'});
  if(!departments.length&&!units.length)return res.status(400).json({error:'Assign at least one functional unit or department.'});
  let error='';let created=null;const invitation=newAdminInvitation();
  await mutateAdminUsers(list=>{
    if(list.some(a=>String(a.username||'').toLowerCase()===username)){error='That administrator username already exists.';return null;}
    if(list.some(a=>String(a.email||'').toLowerCase()===email)){error='That administrator email address already has an account.';return null;}
    created={id:crypto.randomUUID(),name,email,username,role,departments,sections,units,active:true,createdAt:new Date().toISOString(),invitationTokenHash:invitation.tokenHash,invitationExpiresAt:invitation.expiresAt,invitationEmailStatus:'pending'};
    list.push(created);return created;
  });
  if(error)return res.status(400).json({error});
  const baseUrl=requestBaseUrl(req),setupUrl=`${baseUrl}/admin-set-password.html?token=${encodeURIComponent(invitation.token)}`;
  let emailSent=false,warning='';
  try{
    await sendAdminPasswordSetupEmail({to:email,name,username,role,departments,sections,units,setupUrl,expiresAt:invitation.expiresAt,baseUrl});
    emailSent=true;
    await mutateAdminUsers(list=>{const a=list.find(x=>x.id===created.id);if(a){a.invitationEmailStatus='sent';a.invitationSentAt=new Date().toISOString();a.invitationLastError=null;}return null;});
  }catch(e){
    warning=`The administrator account was created, but the invitation email could not be sent: ${e.message}`;
    console.error('Administrator invitation email failed:',e);
    await mutateAdminUsers(list=>{const a=list.find(x=>x.id===created.id);if(a){a.invitationEmailStatus='failed';a.invitationLastError=String(e.message||e).slice(0,500);}return null;});
  }
  const current=(await readAdminUsers()).find(x=>x.id===created.id) || created;
  res.status(201).json({ok:true,emailSent,warning:warning||null,user:publicAdminUser(current)});
});
app.post('/api/developer/admin-users/:id/resend-invitation', developerAuth, async(req,res)=>{
  const invitation=newAdminInvitation();let account=null;
  await mutateAdminUsers(list=>{const a=list.find(x=>x.id===req.params.id);if(!a)return null;if(!isEmail(a.email))return null;a.invitationTokenHash=invitation.tokenHash;a.invitationExpiresAt=invitation.expiresAt;a.invitationEmailStatus='pending';a.invitationLastError=null;account={...a};return account;});
  if(!account)return res.status(404).json({error:'Administrator account not found or does not have a valid email address.'});
  const baseUrl=requestBaseUrl(req),setupUrl=`${baseUrl}/admin-set-password.html?token=${encodeURIComponent(invitation.token)}`;
  try{
    await sendAdminPasswordSetupEmail({to:account.email,name:account.name||account.username,username:account.username,role:account.role||'viewer',departments:account.departments||[],sections:account.sections||[],units:account.units||[],setupUrl,expiresAt:invitation.expiresAt,baseUrl,isReset:Boolean(account.passwordHash)});
    await mutateAdminUsers(list=>{const a=list.find(x=>x.id===req.params.id);if(a){a.invitationEmailStatus='sent';a.invitationSentAt=new Date().toISOString();a.invitationLastError=null;}return null;});
    const updated=(await readAdminUsers()).find(x=>x.id===req.params.id);
    return res.json({ok:true,emailSent:true,user:publicAdminUser(updated)});
  }catch(e){
    console.error('Administrator invitation resend failed:',e);
    await mutateAdminUsers(list=>{const a=list.find(x=>x.id===req.params.id);if(a){a.invitationEmailStatus='failed';a.invitationLastError=String(e.message||e).slice(0,500);}return null;});
    const updated=(await readAdminUsers()).find(x=>x.id===req.params.id);
    return res.status(502).json({error:`The password setup email could not be sent: ${e.message}`,user:publicAdminUser(updated)});
  }
});
app.patch('/api/developer/admin-users/:id', developerAuth, async(req,res)=>{
  const role=req.body?.role?String(req.body.role).trim():null;const departments=req.body?.departments!==undefined?normalizeAdminDepartments(req.body.departments):null;const sections=req.body?.sections!==undefined?normalizeAdminSections(req.body.sections):null;const units=req.body?.units!==undefined?normalizeStaffUnits(req.body.units):null;
  let item=null;await mutateAdminUsers(list=>{const a=list.find(x=>x.id===req.params.id);if(!a)return null;if(role&&ADMIN_ROLES.has(role))a.role=role;if(departments!==null)a.departments=departments;if(sections!==null)a.sections=sections;if(units!==null)a.units=units;if(req.body?.active!==undefined)a.active=Boolean(req.body.active);if(!(a.departments||[]).length&&!normalizeStaffUnits(a.units).length)return null;item=publicAdminUser(a);return item;});
  if(!item)return res.status(404).json({error:'Administrator account not found.'});res.json({ok:true,user:item});
});
app.delete('/api/developer/admin-users/:id', developerAuth, async(req,res)=>{let removed=false;await mutateAdminUsers(list=>{const i=list.findIndex(x=>x.id===req.params.id);if(i>=0){list.splice(i,1);removed=true;}return removed;});if(!removed)return res.status(404).json({error:'Administrator account not found.'});res.json({ok:true});});

// PUBLIC ONE-TIME ADMIN PASSWORD SETUP / RESET
app.get('/api/admin-invitation/:token', async(req,res)=>{
  const token=String(req.params.token||'');
  if(!/^[a-f0-9]{64}$/i.test(token))return res.status(400).json({error:'This password setup link is invalid.'});
  const tokenHash=hashOneTimeToken(token);const list=await readAdminUsers();const a=list.find(x=>x.invitationTokenHash===tokenHash);
  if(!a)return res.status(404).json({error:'This password setup link is invalid or has already been used.'});
  if(a.active===false)return res.status(403).json({error:'This administrator account is disabled. Contact the portal administrator.'});
  if(!a.invitationExpiresAt||new Date(a.invitationExpiresAt).getTime()<=Date.now())return res.status(410).json({error:'This password setup link has expired. Ask the portal developer to send a new link.'});
  const baseUrl=requestBaseUrl(req);
  res.json({ok:true,name:a.name||a.username,username:a.username,email:a.email||'',role:a.role||'viewer',departments:(a.departments||[]).map(slug=>({slug,name:departmentFromSlug(slug)?.name||slug})),units:normalizeStaffUnits(a.units).map(slug=>({slug,name:STAFF_UNITS[slug].label})),sections:a.sections||[],expiresAt:a.invitationExpiresAt,passwordAlreadySet:Boolean(a.passwordHash),loginUrls:adminLoginLinks(a.departments||[],baseUrl,a.units||[])});
});
app.post('/api/admin-invitation/:token/set-password', async(req,res)=>{
  const token=String(req.params.token||''),password=String(req.body?.password||''),confirmPassword=String(req.body?.confirmPassword||''),next=safeSupportAssignmentNext(req.body?.next);
  if(!/^[a-f0-9]{64}$/i.test(token))return res.status(400).json({error:'This password setup link is invalid.'});
  if(password.length<10)return res.status(400).json({error:'Choose a password containing at least 10 characters.'});
  if(password!==confirmPassword)return res.status(400).json({error:'The password confirmation does not match.'});
  const tokenHash=hashOneTimeToken(token);let updated=null,error='';
  await mutateAdminUsers(list=>{const a=list.find(x=>x.invitationTokenHash===tokenHash);if(!a){error='This password setup link is invalid or has already been used.';return null;}if(a.active===false){error='This administrator account is disabled.';return null;}if(!a.invitationExpiresAt||new Date(a.invitationExpiresAt).getTime()<=Date.now()){error='This password setup link has expired. Ask the portal developer to send a new link.';return null;}const pw=hashPassword(password);a.passwordSalt=pw.salt;a.passwordHash=pw.hash;a.passwordSetAt=new Date().toISOString();a.invitationAcceptedAt=a.passwordSetAt;delete a.invitationTokenHash;delete a.invitationExpiresAt;a.invitationEmailStatus='accepted';a.invitationLastError=null;updated={...a};return updated;});
  if(error)return res.status(error.includes('expired')?410:400).json({error});
  const baseUrl=requestBaseUrl(req);
  if(next && normalizeStaffUnits(updated.units).length){
    const sessionToken=createAdminSession({...publicAdminUser(updated),master:false},'__staff__');
    res.cookie('ucc_admin_session',sessionToken,{httpOnly:true,secure:req.secure||String(req.headers['x-forwarded-proto']||'').includes('https'),sameSite:'lax',maxAge:ADMIN_SESSION_TTL_MS,path:'/'});
  }
  res.json({ok:true,message:'Your staff password has been set successfully.',user:publicAdminUser(updated),loginUrls:adminLoginLinks(updated.departments||[],baseUrl,updated.units||[]),redirect:next||null});
});

// DEPARTMENT ADMIN: dissertation assignment by secure emailed link
app.get('/api/admin/:department/dissertation-assignments', departmentAuth, async(req,res)=>{
  if(!adminCan(req,'dissertation','viewer'))return res.json([]);
  const departmentRecords=recordsForDepartment(await readDb(),req.adminDepartment);
  const records=dissertationRecords(departmentRecords);
  const reports=assessorRecords(departmentRecords);
  const list=(await readAssignments()).filter(a=>a.department===req.adminDepartment).slice().reverse().map(a=>publicAssignment(a,records,reports));
  res.json(list);
});

app.post('/api/admin/:department/dissertation-assignments/delete-selected', departmentAuth, requireAdminAccess('dissertation','administrator'), async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?[...new Set(req.body.ids.map(String))]:[];
  if(!ids.length) return res.status(400).json({error:'Select at least one dissertation assignment to delete.'});
  if(ids.length>500) return res.status(400).json({error:'A maximum of 500 assignment records can be deleted at once.'});
  const idSet=new Set(ids);
  const deleted=await mutateAssignments(list=>{
    let count=0;
    for(let i=list.length-1;i>=0;i--){
      if(list[i].department===req.adminDepartment && idSet.has(String(list[i].id))){list.splice(i,1);count++;}
    }
    return count;
  });
  if(!deleted) return res.status(404).json({error:'No selected dissertation assignments were found in this department.'});
  res.json({ok:true,deleted});
});

app.post('/api/admin/:department/dissertation-assignments', departmentAuth, requireAdminAccess('dissertation','officer'), async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?[...new Set(req.body.ids.map(String))]:[];
  const assessorTitle=String(req.body?.assessorTitle||'').trim();
  const assessorFirstName=String(req.body?.assessorFirstName||'').trim();
  const assessorLastName=String(req.body?.assessorLastName||'').trim();
  const assessorName=buildDisplayName(assessorTitle,assessorFirstName,assessorLastName);
  const assessorEmail=String(req.body?.assessorEmail||'').trim();
  const message=String(req.body?.message||'').trim().slice(0,4000);
  const assignmentType=String(req.body?.assignmentType||'assessment').trim().toLowerCase();
  const expiryDays=Math.min(60,Math.max(1,Number.parseInt(req.body?.expiryDays,10)||ASSIGNMENT_EXPIRY_DAYS));
  if(!['assessment','vetting'].includes(assignmentType)) return res.status(400).json({error:'Select Assessment or Vetting as the assignment type.'});
  const requestedRoleLabel=assignmentType==='vetting'?'vetter':'assessor';
  if(!gmailConfigured()) return res.status(503).json({error:'Email sending is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN and GMAIL_SENDER_EMAIL in Render.'});
  if(!ids.length) return res.status(400).json({error:'Select at least one dissertation.'});
  if(ids.length>500) return res.status(400).json({error:'A maximum of 500 dissertations can be assigned at once.'});
  if(!assessorTitle || !assessorFirstName || !assessorLastName) return res.status(400).json({error:`Enter the ${requestedRoleLabel}'s title, first name and surname.`});
  if(!isEmail(assessorEmail)) return res.status(400).json({error:`Enter a valid ${requestedRoleLabel} email address.`});

  const records=dissertationRecords(recordsForDepartment(await readDb(),req.adminDepartment));
  const selected=ids.map(id=>records.find(r=>r.id===id)).filter(Boolean);
  if(selected.length!==ids.length) return res.status(400).json({error:'One or more selected dissertations are unavailable in this department.'});
  const selectedTypes=new Set(selected.map(r=>r.submissionType||'fresh'));
  if(selectedTypes.size>1) return res.status(400).json({error:'Fresh and revised dissertation submissions must be assigned separately.'});
  const selectedType=[...selectedTypes][0]||'fresh';
  if(selectedType==='final') return res.status(400).json({error:'Final dissertation submissions are archival/final-stage records and cannot be assigned to an assessor or vetter.'});
  if(selected.some(r=>dissertationProcessingStatus(r)==='returned')) return res.status(400).json({error:'One or more selected dissertations were returned to the student and cannot be assigned until a new submission is received.'});
  if(selectedType==='fresh' && assignmentType!=='assessment') return res.status(400).json({error:'Fresh dissertation submissions can only be assigned for Assessment.'});
  if(selectedType==='revised' && assignmentType!=='vetting') return res.status(400).json({error:'Revised dissertation submissions can only be assigned for Vetting.'});
  const maxAssignments=selectedType==='revised'?2:3;
  const roleLabel=selectedType==='revised'?'vetter':'assessor';
  for(const r of selected){const info=dissertationAssignmentInfo(r.id,await readAssignments(),assignmentType);if(info.count>=maxAssignments)return res.status(400).json({error:`${r.studentName||r.indexNumber||'A selected dissertation'} has already reached the maximum of ${maxAssignments} ${roleLabel}${maxAssignments===1?'':'s'}.`});}

  const supervisorConflicts=selected.filter(r=>samePersonName(assessorName,r.supervisorName));
  if(supervisorConflicts.length){
    const labels=supervisorConflicts.slice(0,5).map(r=>`${r.indexNumber||r.studentName||r.reference}`).join(', ');
    return res.status(400).json({error:`This assessor is recorded as the supervisor for the following selected dissertation${supervisorConflicts.length===1?'':'s'}: ${labels}. A supervisor cannot be assigned as assessor/vetter for the same work.`});
  }

  const token=newAssignmentToken();
  const now=new Date();
  const expiresAt=new Date(now.getTime()+expiryDays*24*60*60*1000).toISOString();
  const deadlines=assignmentDeadlineDates(now);
  const assignment={
    id:crypto.randomUUID(), reference:makeReference(assignmentType==='vetting'?'VETASSIGN':'ASSIGN'), department:req.adminDepartment, departmentName:req.adminDepartmentName,
    assignmentType, assessorTitle, assessorFirstName, assessorLastName, assessorName, assessorEmail, dissertationIds:ids,
    createdAt:now.toISOString(), expiresAt, earlyBirdDueAt:deadlines.earlyBirdDueAt, assessmentDueAt:deadlines.assessmentDueAt, tokenHash:assignmentTokenHash(token),
    sentAt:null, downloadedAt:null, lastDownloadedAt:null, downloadCount:0, revokedAt:null, emailStatus:'pending', resendCount:0, message
  };
  let reservationError='';
  const reserved=await mutateAssignments(list=>{
    const activeMap=reservedAssessorMap(list.filter(a=>a.department===req.adminDepartment));
    const alreadyAssigned=[];
    const atLimit=[];
    for(const r of selected){
      const people=activeMap.get(r.id)||new Map();
      const duplicate=[...people.values()].some(p=>String(p.email||'').toLowerCase()===assessorEmail.toLowerCase() || samePersonName(p.name,assessorName));
      if(duplicate) alreadyAssigned.push(r);
      if(people.size>=maxAssignments) atLimit.push(r);
    }
    if(alreadyAssigned.length){
      const labels=alreadyAssigned.slice(0,5).map(r=>r.indexNumber||r.studentName||r.reference).join(', ');
      reservationError=`This ${roleLabel} has already been assigned the following dissertation${alreadyAssigned.length===1?'':'s'}: ${labels}. Use Resend Link on the existing assignment instead.`;
      return false;
    }
    if(atLimit.length){
      const labels=atLimit.slice(0,5).map(r=>r.indexNumber||r.studentName||r.reference).join(', ');
      reservationError=`The following dissertation${atLimit.length===1?' has':'s have'} already reached the maximum of ${maxAssignments} ${roleLabel}s: ${labels}.`;
      return false;
    }
    list.push(assignment);
    return true;
  });
  if(!reserved) return res.status(400).json({error:reservationError||'The dissertation assignment could not be created.'});
  const secureUrl=`${baseUrlFor(req)}/secure/dissertations/${token}`;
  try {
    const email=await sendGmailEmail({to:assessorEmail,assessorName,departmentName:req.adminDepartmentName,dissertationCount:ids.length,expiresAt,secureUrl,earlyBirdDueAt:assignment.earlyBirdDueAt,assessmentDueAt:assignment.assessmentDueAt,message,assignmentType});
    await mutateAssignments(list=>{const a=list.find(x=>x.id===assignment.id);if(a){a.sentAt=new Date().toISOString();a.emailStatus='sent';a.emailProvider='gmail';a.emailProviderMessageId=email.id||'';a.lastEmailError='';}});
    const final=(await readAssignments()).find(x=>x.id===assignment.id)||assignment;
    res.status(201).json({ok:true,assignment:publicAssignment(final)});
  } catch(e) {
    console.error('Gmail assignment email failed:',e);
    await mutateAssignments(list=>{const a=list.find(x=>x.id===assignment.id);if(a){a.emailStatus='failed';a.lastEmailError=String(e.message||e).slice(0,500);}});
    res.status(502).json({error:`The assignment was recorded, but the email could not be sent: ${e.message||e}`,assignmentId:assignment.id});
  }
});

app.post('/api/admin/:department/dissertation-assignments/:id/revoke', departmentAuth, requireAdminAccess('dissertation','officer'), async(req,res)=>{
  const item=await mutateAssignments(list=>{
    const a=list.find(x=>x.id===req.params.id&&x.department===req.adminDepartment);
    if(!a) return null;
    a.revokedAt=new Date().toISOString(); a.emailStatus='revoked'; return publicAssignment(a);
  });
  if(!item) return res.status(404).json({error:'Assignment not found.'});
  res.json({ok:true,assignment:item});
});

app.post('/api/admin/:department/dissertation-assignments/:id/resend', departmentAuth, requireAdminAccess('dissertation','officer'), async(req,res)=>{
  if(!gmailConfigured()) return res.status(503).json({error:'Email sending is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN and GMAIL_SENDER_EMAIL in Render.'});
  const all=await readAssignments();
  const existing=all.find(x=>x.id===req.params.id&&x.department===req.adminDepartment);
  if(!existing) return res.status(404).json({error:'Assignment not found.'});
  if(existing.revokedAt){
    const maxAssignments=(existing.assignmentType||'assessment')==='vetting'?2:3;
    const roleLabel=(existing.assignmentType||'assessment')==='vetting'?'vetter':'assessor';
    const records=dissertationRecords(recordsForDepartment(await readDb(),req.adminDepartment));
    const selected=(existing.dissertationIds||[]).map(id=>records.find(r=>r.id===id)).filter(Boolean);
    const supervisorConflicts=selected.filter(r=>samePersonName(existing.assessorName,r.supervisorName));
    if(supervisorConflicts.length){
      const labels=supervisorConflicts.slice(0,5).map(r=>r.indexNumber||r.studentName||r.reference).join(', ');
      return res.status(400).json({error:`This revoked assignment cannot be reactivated because the ${roleLabel} is recorded as supervisor for: ${labels}.`});
    }
    const otherAssignments=all.filter(a=>a.department===req.adminDepartment && a.id!==existing.id);
    const reservedMap=reservedAssessorMap(otherAssignments);
    const duplicates=[]; const atLimit=[];
    for(const r of selected){
      const people=reservedMap.get(r.id)||new Map();
      const duplicate=[...people.values()].some(p=>String(p.email||'').toLowerCase()===String(existing.assessorEmail||'').toLowerCase() || samePersonName(p.name,existing.assessorName));
      if(duplicate) duplicates.push(r);
      if(people.size>=maxAssignments) atLimit.push(r);
    }
    if(duplicates.length){
      const labels=duplicates.slice(0,5).map(r=>r.indexNumber||r.studentName||r.reference).join(', ');
      return res.status(400).json({error:`This ${roleLabel} is already assigned to the following dissertation${duplicates.length===1?'':'s'} in another active assignment: ${labels}.`});
    }
    if(atLimit.length){
      const labels=atLimit.slice(0,5).map(r=>r.indexNumber||r.studentName||r.reference).join(', ');
      return res.status(400).json({error:`The following dissertation${atLimit.length===1?' has':'s have'} already reached the maximum of ${maxAssignments} ${roleLabel}s: ${labels}.`});
    }
  }
  const expiryDays=Math.min(60,Math.max(1,Number.parseInt(req.body?.expiryDays,10)||ASSIGNMENT_EXPIRY_DAYS));
  const token=newAssignmentToken();
  const expiresAt=new Date(Date.now()+expiryDays*24*60*60*1000).toISOString();
  await mutateAssignments(list=>{const a=list.find(x=>x.id===existing.id);if(a){a.tokenHash=assignmentTokenHash(token);a.expiresAt=expiresAt;a.revokedAt=null;a.emailStatus='pending';a.lastEmailError='';a.resendCount=Number(a.resendCount||0)+1;}});
  const secureUrl=`${baseUrlFor(req)}/secure/dissertations/${token}`;
  try {
    const deadlineBase=new Date(existing.sentAt||existing.createdAt||Date.now());
    const deadlines={earlyBirdDueAt:existing.earlyBirdDueAt||assignmentDeadlineDates(deadlineBase).earlyBirdDueAt,assessmentDueAt:existing.assessmentDueAt||assignmentDeadlineDates(deadlineBase).assessmentDueAt};
    await mutateAssignments(list=>{const a=list.find(x=>x.id===existing.id);if(a){a.earlyBirdDueAt=deadlines.earlyBirdDueAt;a.assessmentDueAt=deadlines.assessmentDueAt;}});
    const email=await sendGmailEmail({to:existing.assessorEmail,assessorName:existing.assessorName,departmentName:existing.departmentName,dissertationCount:(existing.dissertationIds||[]).length,expiresAt,secureUrl,earlyBirdDueAt:deadlines.earlyBirdDueAt,assessmentDueAt:deadlines.assessmentDueAt,message:existing.message||'',assignmentType:existing.assignmentType||'assessment'});
    const item=await mutateAssignments(list=>{const a=list.find(x=>x.id===existing.id);if(a){a.sentAt=new Date().toISOString();a.emailStatus='sent';a.emailProvider='gmail';a.emailProviderMessageId=email.id||'';a.lastEmailError='';return publicAssignment(a);}return null;});
    res.json({ok:true,assignment:item});
  } catch(e) {
    console.error('Gmail assignment email failed:',e);
    await mutateAssignments(list=>{const a=list.find(x=>x.id===existing.id);if(a){a.emailStatus='failed';a.lastEmailError=String(e.message||e).slice(0,500);}});
    res.status(502).json({error:`The secure link was regenerated, but the email could not be sent: ${e.message||e}`});
  }
});

// Form-based administrator login/logout.
app.get('/admin-login.html',(_req,res)=>res.sendFile(path.join(__dirname,'public','admin-login.html')));
app.post('/api/admin-login',supportRateLimit(15),async(req,res)=>{
  const department=String(req.body?.department||'').trim(),username=String(req.body?.username||'').trim(),password=String(req.body?.password||'');
  if(!departmentFromSlug(department))return res.status(400).json({error:'Select a valid department.'});
  const identity=await verifyDepartmentCredentials(department,username,password);
  if(!identity)return res.status(401).json({error:'Invalid username or password for the selected department.'});
  const token=createAdminSession(identity,department);
  res.cookie('ucc_admin_session',token,{httpOnly:true,secure:req.secure||String(req.headers['x-forwarded-proto']||'').includes('https'),sameSite:'lax',maxAge:ADMIN_SESSION_TTL_MS,path:'/'});
  res.json({ok:true,redirect:`/admin/${encodeURIComponent(department)}`});
});
app.post('/api/admin-logout',(req,res)=>{clearAdminSession(req);res.clearCookie('ucc_admin_session',{path:'/'});res.json({ok:true,redirect:'/'});});
app.get('/admin/logout',(req,res)=>{clearAdminSession(req);res.clearCookie('ucc_admin_session',{path:'/'});res.redirect('/');});

// FUNCTIONAL UNITS STAFF PORTAL
app.get('/staff-login.html',(_req,res)=>res.sendFile(path.join(__dirname,'public','staff-login.html')));
app.post('/api/staff-login',supportRateLimit(15),async(req,res)=>{
  const username=String(req.body?.username||'').trim(),password=String(req.body?.password||'');
  const identity=await verifyStaffCredentials(username,password);
  if(!identity)return res.status(401).json({error:'Invalid username or password, or this account has no functional-unit access.'});
  const token=createAdminSession(identity,'__staff__');
  res.cookie('ucc_admin_session',token,{httpOnly:true,secure:req.secure||String(req.headers['x-forwarded-proto']||'').includes('https'),sameSite:'lax',maxAge:ADMIN_SESSION_TTL_MS,path:'/'});
  res.json({ok:true,redirect:'/staff'});
});
app.get('/staff',staffAuth,(_req,res)=>res.sendFile(path.join(__dirname,'public','staff.html')));
app.get('/staff.js',(_req,res)=>res.sendFile(path.join(__dirname,'public','staff.js')));
app.get('/api/staff/me',staffAuth,async(req,res)=>{
  const identity=req.staffIdentity;
  const units=normalizeStaffUnits(identity.units).map(id=>({id,...STAFF_UNITS[id]}));
  const tickets=await readSupportTickets();
  const supportCount=units.some(unit=>unit.id==='student-support')?tickets.filter(ticket=>!['resolved','closed'].includes(ticket.status)).length:0;
  res.json({ok:true,staff:{name:identity.name||identity.username,username:identity.username,role:identity.role,units,departments:normalizeAdminDepartments(identity.departments),sections:normalizeAdminSections(identity.sections),developerPreview:Boolean(identity.developerPreview),developerPreviewLabel:identity.developerPreviewLabel||'',previewExpiresAt:identity.previewExpiresAt||null},metrics:{openSupportTickets:supportCount}});
});
function supportDashboardTickets(tickets, unitId) {
  const visible=tickets.filter(ticket=>!ticket.sensitive);
  if(unitId==='provost') return tickets;
  if(unitId==='confidential-handler') return tickets.filter(ticket=>ticket.sensitive);
  if(unitId==='student-support'||unitId==='quality-assurance') return visible;
  if(unitId==='college-registrar') return visible.filter(ticket=>['certificate','change-of-name','transcript','incomplete-result','deferment','resumption-deferment','resumption-rustication','registration-challenge'].includes(ticket.categoryKey));
  if(unitId==='college-finance') return visible.filter(ticket=>ticket.categoryKey==='fees-payment');
  if(['directorate-education-business','directorate-arts-stem'].includes(unitId)) return visible;
  if(unitId==='coordinator') return visible.filter(ticket=>ticket.originRole==='centre-coordinator');
  if(unitId==='regional-administrator') return visible.filter(ticket=>ticket.originRole==='centre-coordinator'||(ticket.referrals||[]).some(referral=>referral.targetUnit===unitId));
  return visible.filter(ticket=>ticket.ownerUnitId===unitId||(ticket.referrals||[]).some(referral=>referral.targetUnit===unitId));
}
function supportTicketsForStaffIdentity(tickets, identity) {
  const units = normalizeStaffUnits(identity?.units);
  const visible = new Map();
  for (const unit of units) for (const ticket of supportDashboardTickets(tickets, unit)) visible.set(ticket.id, ticket);
  return [...visible.values()].filter(ticket => !ticket.sensitive || units.some(unit => ['confidential-handler','provost'].includes(unit)));
}
function supportTicketInUnit(ticket, unitId) {
  return ticket.ownerUnitId === unitId || (ticket.referrals || []).some(referral => referral.targetUnit === unitId || referral.sourceUnit === unitId) || (ticket.interUnitMessages || []).some(message => message.targetUnit === unitId || message.sourceUnit === unitId);
}
function filterSupportReportTickets(tickets, query = {}) {
  const from = String(query.from || '').trim();
  const to = String(query.to || '').trim();
  const centre = String(query.centre || '').trim().toLowerCase();
  const unit = String(query.unit || '').trim();
  const type = String(query.type || '').trim();
  const status = String(query.status || '').trim();
  const category = String(query.category || '').trim();
  return tickets.filter(ticket => {
    const created = new Date(ticket.createdAt).getTime();
    if (from && Number.isFinite(created) && created < new Date(`${from}T00:00:00.000Z`).getTime()) return false;
    if (to && Number.isFinite(created) && created > new Date(`${to}T23:59:59.999Z`).getTime()) return false;
    if (centre && String(ticket.studyCentre || '').trim().toLowerCase() !== centre) return false;
    if (unit && !supportTicketInUnit(ticket, unit)) return false;
    if (type && ticket.type !== type) return false;
    if (status && ticket.status !== status) return false;
    if (category && ticket.categoryKey !== category) return false;
    return true;
  });
}
function supportPerformanceMetric(tickets) {
  const terminal = tickets.filter(ticket => ['resolved','final-decision','closed','accepted'].includes(ticket.status));
  const open = tickets.filter(ticket => !['resolved','final-decision','closed','accepted'].includes(ticket.status));
  const feedback = tickets.map(ticket => ticket.feedback).filter(Boolean);
  const average = (values) => { const numeric=values.map(Number).filter(Number.isFinite); return numeric.length ? Number((numeric.reduce((sum,value)=>sum+value,0)/numeric.length).toFixed(1)) : null; };
  const resolutionHours = terminal.filter(ticket => ticket.createdAt && ticket.resolvedAt).map(ticket => (new Date(ticket.resolvedAt).getTime() - new Date(ticket.createdAt).getTime()) / 3600000).filter(value => Number.isFinite(value) && value >= 0);
  return {
    total:tickets.length,
    complaints:tickets.filter(ticket=>ticket.type==='complaint').length,
    requests:tickets.filter(ticket=>ticket.type==='service-request').length,
    open:open.length,
    resolved:terminal.length,
    overdue:open.filter(ticket=>supportSlaSummary(ticket).overdue).length,
    atRisk:open.filter(ticket=>supportSlaSummary(ticket).atRisk).length,
    slaCompliance:terminal.length ? Number((terminal.filter(ticket=>!ticket.slaBreachedAt).length / terminal.length * 100).toFixed(1)) : null,
    feedbackResponses:feedback.length,
    feedbackRate:terminal.length ? Number((feedback.length / terminal.length * 100).toFixed(1)) : null,
    satisfaction:average(feedback.map(item=>item.rating)),
    easeOfUse:average(feedback.map(item=>item.easeOfUse)),
    communication:average(feedback.map(item=>item.communication)),
    timeliness:average(feedback.map(item=>item.timeliness)),
    staffCourtesy:average(feedback.map(item=>item.staffCourtesy)),
    averageResolutionHours:average(resolutionHours)
  };
}
function supportGroupedPerformance(tickets, kind) {
  const groups = new Map();
  if (kind === 'centre') {
    for (const ticket of tickets) {
      const key = String(ticket.studyCentre || 'Not stated').trim() || 'Not stated';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ticket);
    }
  } else {
    for (const ticket of tickets) {
      const units = new Set([ticket.ownerUnitId, ...(ticket.referrals || []).flatMap(referral => [referral.sourceUnit, referral.targetUnit])].filter(unit => STAFF_UNITS[unit]));
      for (const unit of units) {
        const key = STAFF_UNITS[unit].label;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ticket);
      }
    }
  }
  return [...groups.entries()].map(([label, items]) => ({ label, ...supportPerformanceMetric(items) })).sort((a,b)=>b.total-a.total || a.label.localeCompare(b.label));
}
function supportSafeSheetValue(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
function supportRegisterAoA(tickets) {
  const headers = ['S/N','REFERENCE','CREATED','LAST UPDATED','MATTER TYPE','STATUS','PRIORITY','CATEGORY','CONFIDENTIALITY','STUDENT','EMAIL','PHONE','STUDENT NUMBER','STUDY CENTRE','PROGRAMME','RESPONSIBLE UNIT','ASSIGNMENT INDICATOR','ASSIGNED STAFF','ASSIGNED STAFF EMAIL','ASSIGNMENT SENT','ASSIGNMENT OPENED','ASSIGNMENT RESOLVED','DUE','SLA','FIRST RESPONSE HOURS','RESOLUTION HOURS','OVERALL RATING','EASE OF USE','COMMUNICATION','TIMELINESS','STAFF COURTESY','RESOLVED BY STUDENT','NOTIFICATION PREFERENCE','ASSISTANCE LANGUAGE'];
  const hours=(start,end)=>start&&end?Number(Math.max(0,(new Date(end).getTime()-new Date(start).getTime())/3600000).toFixed(1)):'';
  const rows=tickets.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map((ticket,index)=>{
    const sla=supportSlaSummary(ticket);
    const assignment=supportAssignmentSummary(ticket,[ticket.ownerUnitId]);
    const slaLabel=sla.overdue?'Overdue':sla.atRisk?'At risk':sla.paused?'Paused':'On track';
    return [index+1,ticket.reference,ticket.createdAt,ticket.lastUpdatedAt,ticket.type,SUPPORT_STATUS_LABELS[ticket.status]||ticket.status,ticket.priorityLabel,ticket.categoryLabel,ticket.sensitive?'Restricted':'Standard',ticket.name,ticket.email,ticket.phone,ticket.studentNumber,ticket.studyCentre,ticket.programme,ticket.ownerUnit,assignment.label,assignment.officerName||ticket.assignedCaseOwner,assignment.officerEmail,assignment.assignedAt,assignment.openedAt,assignment.resolvedAt,ticket.dueAt,slaLabel,hours(ticket.createdAt,ticket.firstResponseAt),hours(ticket.createdAt,ticket.resolvedAt),ticket.feedback?.rating||'',ticket.feedback?.easeOfUse||'',ticket.feedback?.communication||'',ticket.feedback?.timeliness||'',ticket.feedback?.staffCourtesy||'',ticket.feedback?.resolved||'',ticket.notificationPreference||'email',SUPPORT_LANGUAGES[ticket.language]||SUPPORT_LANGUAGES.en].map(supportSafeSheetValue);
  });
  return [headers,...rows];
}
function supportPerformanceAoA(rows, heading) {
  const headers=[heading,'TOTAL','COMPLAINTS','SERVICE REQUESTS','OPEN','RESOLVED / CLOSED','OVERDUE','AT RISK','SLA COMPLIANCE %','FEEDBACK RESPONSES','FEEDBACK RATE %','SATISFACTION /5','EASE /5','COMMUNICATION /5','TIMELINESS /5','COURTESY /5','AVG RESOLUTION HOURS'];
  return [headers,...rows.map(row=>[row.label,row.total,row.complaints,row.requests,row.open,row.resolved,row.overdue,row.atRisk,row.slaCompliance??'',row.feedbackResponses,row.feedbackRate??'',row.satisfaction??'',row.easeOfUse??'',row.communication??'',row.timeliness??'',row.staffCourtesy??'',row.averageResolutionHours??''])];
}
function supportWorkbookBuffer(tickets, includeRegister = true) {
  const workbook=XLSX.utils.book_new();
  const overall=supportPerformanceMetric(tickets);
  addSheet(workbook,'Summary',[['SERVICE PERFORMANCE SUMMARY','VALUE'],['Generated at',new Date().toISOString()],['Total cases',overall.total],['Complaints',overall.complaints],['Service requests',overall.requests],['Open cases',overall.open],['Resolved or closed',overall.resolved],['Overdue',overall.overdue],['At risk',overall.atRisk],['SLA compliance %',overall.slaCompliance??''],['Feedback responses',overall.feedbackResponses],['Feedback response rate %',overall.feedbackRate??''],['Average satisfaction /5',overall.satisfaction??''],['Average resolution hours',overall.averageResolutionHours??'']],[34,24]);
  addSheet(workbook,'By Study Centre',supportPerformanceAoA(supportGroupedPerformance(tickets,'centre'),'STUDY CENTRE'),[38,12,14,18,12,18,12,12,20,20,18,18,14,20,14,14,22]);
  addSheet(workbook,'By Functional Unit',supportPerformanceAoA(supportGroupedPerformance(tickets,'unit'),'FUNCTIONAL UNIT'),[42,12,14,18,12,18,12,12,20,20,18,18,14,20,14,14,22]);
  if (includeRegister) addSheet(workbook,'Complaint Request Register',supportRegisterAoA(tickets),[8,23,22,22,18,22,14,28,18,28,30,18,20,30,30,34,28,24,30,22,22,22,22,16,22,22,16,16,18,16,18,22,24,22]);
  return XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
}
function sendSupportWorkbook(res, tickets, filename, performanceOnly = false) {
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(filename)}"`);
  res.send(supportWorkbookBuffer(tickets,!performanceOnly));
}
function supportDashboardSummary(tickets, unitId) {
  const open=tickets.filter(ticket=>!['resolved','final-decision','closed','accepted'].includes(ticket.status));
  const completed=tickets.filter(ticket=>['resolved','final-decision','closed','accepted'].includes(ticket.status));
  const feedback=tickets.map(ticket=>ticket.feedback).filter(item=>item&&Number.isFinite(Number(item.rating)));
  const now=Date.now();
  const countBy=(items,key)=>Object.entries(items.reduce((out,item)=>{const value=key==='status'?(SUPPORT_STATUS_LABELS[item.status]||item.status||'Not recorded'):(item[key]||'Not recorded');out[value]=(out[value]||0)+1;return out;},{})).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,count])=>({label,count}));
  const averageHours=(items,endKey)=>{const values=items.filter(ticket=>ticket[endKey]&&ticket.createdAt).map(ticket=>(new Date(ticket[endKey]).getTime()-new Date(ticket.createdAt).getTime())/3600000).filter(value=>Number.isFinite(value)&&value>=0);return values.length?Number((values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(1)):null;};
  const auditCount=pattern=>tickets.filter(ticket=>(ticket.auditTrail||[]).some(item=>pattern.test(String(item.action||'')))).length;
  const feedbackAverage=key=>{const values=feedback.map(item=>Number(item[key])).filter(Number.isFinite);return values.length?Number((values.reduce((sum,value)=>sum+value,0)/values.length).toFixed(1)):null;};
  return { unitId, label: STAFF_UNITS[unitId].label, total:tickets.length, open:open.length, resolved:tickets.length-open.length,
    overdue:open.filter(ticket=>ticket.dueAt&&new Date(ticket.dueAt).getTime()<now).length,
    atRisk:open.filter(ticket=>supportSlaSummary(ticket).atRisk).length,
    awaitingEvidence:open.filter(ticket=>['evidence-requested','lacks-evidence','awaiting-student'].includes(ticket.status)).length,
    reopened:auditCount(/reopened/i), appealed:auditCount(/appeal/i), accepted:auditCount(/accepted/i),
    slaCompliancePercent:completed.length?Number((completed.filter(ticket=>!ticket.slaBreachedAt).length/completed.length*100).toFixed(1)):null,
    feedbackResponses:feedback.length, averageSatisfaction:feedbackAverage('rating'), averageEaseOfUse:feedbackAverage('easeOfUse'), averageCommunication:feedbackAverage('communication'), averageTimeliness:feedbackAverage('timeliness'), averageStaffCourtesy:feedbackAverage('staffCourtesy'), lowRatings:feedback.filter(item=>[item.rating,item.easeOfUse,item.communication,item.timeliness,item.staffCourtesy].some(value=>Number(value)<=2)).length,
    averageFirstResponseHours:averageHours(tickets,'firstResponseAt'), averageResolutionHours:averageHours(tickets,'resolvedAt'),
    routed:tickets.filter(ticket=>(ticket.referrals||[]).length).length,
    categoryBreakdown:countBy(tickets,'categoryLabel'), statusBreakdown:countBy(tickets,'status'), centreBreakdown:countBy(tickets,'studyCentre') };
}
app.get('/api/staff/dashboard', staffAuth, async(req,res)=>{
  const allUnits=Object.keys(STAFF_UNITS);
  const detailedUnits=allUnits.filter(unit=>!['payroll','auditor','stores'].includes(unit));
  const tickets=await readSupportTickets();
  const assignedUnits=normalizeStaffUnits(req.staffIdentity?.units);
  const monitoringAll=assignedUnits.some(unit=>['student-support','quality-assurance','provost','directorate-education-business','directorate-arts-stem'].includes(unit));
  const visibleTickets=filterSupportReportTickets(supportTicketsForStaffIdentity(tickets,req.staffIdentity),req.query);
  const dashboardUnits=monitoringAll?allUnits:assignedUnits;
  const dashboards=assignedUnits.filter(unit=>detailedUnits.includes(unit)).map(unit=>supportDashboardSummary(filterSupportReportTickets(supportDashboardTickets(tickets,unit),req.query),unit));
  const overview=supportPerformanceMetric(visibleTickets);
  const statusStatistics=Object.entries(SUPPORT_STATUS_LABELS).map(([id,label])=>({id,label,count:visibleTickets.filter(ticket=>ticket.status===id).length}));
  const unitStatistics=dashboardUnits.map(unit=>{
    const items=visibleTickets.filter(ticket=>supportTicketInUnit(ticket,unit));
    const metric=supportPerformanceMetric(items);
    return {id:unit,label:STAFF_UNITS[unit].label,total:metric.total,complaints:metric.complaints,requests:metric.requests,statusCounts:Object.fromEntries(Object.keys(SUPPORT_STATUS_LABELS).map(status=>[status,items.filter(ticket=>ticket.status===status).length]))};
  });
  res.json({ok:true,overview,statusStatistics,unitStatistics,dashboards});
});
app.get('/api/staff/support-report-options', staffAuth, async(req,res)=>{
  const tickets=supportTicketsForStaffIdentity(await readSupportTickets(),req.staffIdentity);
  const centres=[...new Set(tickets.map(ticket=>String(ticket.studyCentre||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const permittedUnits=[...new Set(tickets.flatMap(ticket=>[ticket.ownerUnitId,...(ticket.referrals||[]).flatMap(referral=>[referral.sourceUnit,referral.targetUnit])]).filter(unit=>STAFF_UNITS[unit]))].map(id=>({id,label:STAFF_UNITS[id].label})).sort((a,b)=>a.label.localeCompare(b.label));
  res.json({ok:true,centres,units:permittedUnits,categories:Object.entries(SUPPORT_CATEGORIES).map(([id,item])=>({id,label:item.label})),statuses:Object.entries(SUPPORT_STATUS_LABELS).map(([id,label])=>({id,label}))});
});
app.get('/api/staff/support-performance', staffAuth, async(req,res)=>{
  const tickets=filterSupportReportTickets(supportTicketsForStaffIdentity(await readSupportTickets(),req.staffIdentity),req.query);
  res.json({ok:true,summary:supportPerformanceMetric(tickets),byCentre:supportGroupedPerformance(tickets,'centre'),byUnit:supportGroupedPerformance(tickets,'unit')});
});
app.get('/api/staff/support-register.csv', staffAuth, async(req,res)=>{
  const tickets=filterSupportReportTickets(supportTicketsForStaffIdentity(await readSupportTickets(),req.staffIdentity),req.query);
  const rows=supportRegisterAoA(tickets).map(row=>row.map(supportCsvValue).join(','));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="support-register-${supportDateKey(new Date())}.csv"`);
  res.send(`\uFEFF${rows.join('\r\n')}`);
});
app.get('/api/staff/support-register.xlsx', staffAuth, async(req,res)=>{
  const tickets=filterSupportReportTickets(supportTicketsForStaffIdentity(await readSupportTickets(),req.staffIdentity),req.query);
  sendSupportWorkbook(res,tickets,`support-register-${supportDateKey(new Date())}.xlsx`,false);
});
app.get('/api/staff/support-performance.xlsx', staffAuth, async(req,res)=>{
  const tickets=filterSupportReportTickets(supportTicketsForStaffIdentity(await readSupportTickets(),req.staffIdentity),req.query);
  sendSupportWorkbook(res,tickets,`support-performance-${supportDateKey(new Date())}.xlsx`,true);
});
function staffReferralTicket(ticket, unitIds = []) {
  const activeUnitIds = normalizeStaffUnits(unitIds).filter(unitId => ticket.ownerUnitId === unitId || Boolean(activeReferralForUnits(ticket,[unitId])));
  return {
    id: ticket.id, reference: ticket.reference, name: ticket.name, email: ticket.email, type: ticket.type,
    studyLevel: ticket.studyLevelLabel || '', category: ticket.categoryLabel, priority: ticket.priorityLabel,
    status: ticket.status, statusLabel: SUPPORT_STATUS_LABELS[ticket.status] || ticket.status,
    ownerUnit: ticket.ownerUnit, subject: ticket.subject, description: ticket.description, studyCentre: ticket.studyCentre,
    lastUpdatedAt: ticket.lastUpdatedAt, dueAt: ticket.dueAt || null, assignedCaseOwner: ticket.assignedCaseOwner || '', sensitive: Boolean(ticket.sensitive), sla: supportSlaSummary(ticket), evidence: Array.isArray(ticket.evidence) ? ticket.evidence : [],
    officerEvidence: Array.isArray(ticket.officerEvidence) ? ticket.officerEvidence : [], referrals: ticket.referrals || [], registrations:ticket.registrations || [],
    assignment:supportAssignmentSummary(ticket,unitIds), assignments:supportAssignmentList(ticket), activeUnitIds,
    interUnitMessages: ticket.interUnitMessages || [], studentUpdates: ticket.studentUpdates || [], auditTrail: ticket.auditTrail || [], feedback:ticket.feedback || null,
    notificationPreference:ticket.notificationPreference || 'email', language:ticket.language || 'en'
  };
}
app.use('/api/staff/referrals', supportSameOrigin);
app.get('/api/staff/referrals', staffAuth, async(req, res) => {
  const unitIds = normalizeStaffUnits(req.staffIdentity?.units);
  const tickets = await readSupportTickets();
  const referrals = tickets.filter(ticket => (!ticket.sensitive || unitIds.some(unit => ['confidential-handler','provost'].includes(unit))) && ((ticket.referrals || []).some(referral => unitIds.includes(referral.targetUnit)) || (ticket.interUnitMessages || []).some(message => unitIds.includes(message.targetUnit))))
    .sort((a,b) => String(b.lastUpdatedAt || b.createdAt).localeCompare(String(a.lastUpdatedAt || a.createdAt)))
    .map(ticket => staffReferralTicket(ticket, unitIds));
  res.json({ ok: true, referrals });
});
app.post('/api/staff/referrals/:id/staff-assignments', staffAuth, async(req,res)=>{
  if ((ROLE_RANK[req.staffIdentity?.role] || 0) < ROLE_RANK.administrator) return res.status(403).json({ error:'Only a functional-unit administrator may assign a complaint or request to staff.' });
  return createSupportStaffAssignment(req,res,{identity:req.staffIdentity,allowedUnits:req.staffIdentity?.units||[]});
});
app.get('/api/staff/referrals/:id/:collection/:index', staffAuth, async(req, res) => {
  const collection = req.params.collection === 'officer-evidence' ? 'officerEvidence' : req.params.collection === 'evidence' ? 'evidence' : '';
  if (!collection) return res.status(404).json({ error: 'Evidence file not found.' });
  const unitIds = normalizeStaffUnits(req.staffIdentity?.units);
  const ticket = (await readSupportTickets()).find(item => item.id === req.params.id && (!item.sensitive || unitIds.some(unit => ['confidential-handler','provost'].includes(unit))) && (item.referrals || []).some(referral => unitIds.includes(referral.targetUnit)));
  if (!ticket) return res.status(404).json({ error: 'Referred case not found.' });
  const evidence = supportEvidenceFor(ticket, req.params.index, collection);
  if (!evidence) return res.status(404).json({ error: 'Evidence file not found.' });
  return sendSupportEvidence(req, res, evidence);
});
app.post('/api/staff/referrals/:id/officer-evidence', staffAuth, supportUpload.array('evidenceFiles', 10), async (req, res) => {
  try {
    if ((ROLE_RANK[req.staffIdentity?.role] || 0) < ROLE_RANK.officer) { await removeUploaded(req).catch(() => {}); return res.status(403).json({ error: 'Your role is read-only.' }); }
    const unitIds = normalizeStaffUnits(req.staffIdentity?.units);
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    if (!Array.isArray(req.files) || !req.files.length) return res.status(400).json({ error: 'Attach at least one evidence file.' });
    let updated = null;
    await mutateSupportTickets(tickets => {
      const ticket = tickets.find(item => item.id === req.params.id && activeReferralForUnits(item, unitIds));
      if (!ticket || (ticket.sensitive && !unitIds.some(unit => ['confidential-handler','provost'].includes(unit)))) return null;
      const now = new Date().toISOString();
      ticket.officerEvidence = Array.isArray(ticket.officerEvidence) ? ticket.officerEvidence : [];
      ticket.officerEvidence.push(...req.files.map(file => ({ ...fileRecord(file), uploadedAt: now, note, uploadedBy: req.staffIdentity?.name || req.staffIdentity?.username || 'Functional-unit officer' })));
      ticket.lastUpdatedAt = now;
      ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
      ticket.auditTrail.push({ action: 'Officer evidence added', note, at: now, by: req.staffIdentity?.name || req.staffIdentity?.username || 'Functional-unit officer' });
      updated = { ...ticket };
      return ticket;
    });
    if (!updated) { await removeUploaded(req).catch(() => {}); return res.status(404).json({ error: 'This case is not currently assigned to your unit.' }); }
    return res.json({ ok: true, evidenceCount: updated.officerEvidence.length });
  } catch (error) { console.error('Functional-unit evidence upload failed:', error); await removeUploaded(req).catch(() => {}); return res.status(500).json({ error: 'Officer evidence could not be uploaded.' }); }
});
app.patch('/api/staff/referrals/:id', staffAuth, async (req, res) => {
  if ((ROLE_RANK[req.staffIdentity?.role] || 0) < ROLE_RANK.officer) return res.status(403).json({ error: 'Your role is read-only.' });
  const action = String(req.body?.action || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 4000);
  const assignedCaseOwner = cleanHumanText(req.body?.assignedCaseOwner || req.staffIdentity?.name || req.staffIdentity?.username).slice(0, 180);
  const allowed = new Set(['accept','internal-note','progress','request-evidence','resolve','final-decision','return-to-support']);
  if (!allowed.has(action) || !note) return res.status(400).json({ error: 'Choose a valid action and provide a clear case note.' });
  const unitIds = normalizeStaffUnits(req.staffIdentity?.units);
  const monitoringOnly = unitIds.length > 0 && unitIds.every(unit => ['coordinator','regional-administrator','quality-assurance'].includes(unit));
  if (monitoringOnly && action !== 'internal-note') return res.status(403).json({ error: 'This monitoring role may add evidence, record internal notes, and escalate by reassignment, but may not issue operational case decisions.' });
  let updated = null;
  await mutateSupportTickets(tickets => {
    const ticket = tickets.find(item => item.id === req.params.id);
    const referral = ticket ? activeReferralForUnits(ticket, unitIds) : null;
    if (!ticket || !referral || (ticket.sensitive && !unitIds.some(unit => ['confidential-handler','provost'].includes(unit)))) return tickets;
    const now = new Date().toISOString();
    const actor = req.staffIdentity?.name || req.staffIdentity?.username || 'Functional-unit officer';
    ticket.assignedCaseOwner = assignedCaseOwner || actor;
    ticket.firstResponseAt = ticket.firstResponseAt || now;
    ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
    ticket.studentUpdates = Array.isArray(ticket.studentUpdates) ? ticket.studentUpdates : [];
    if (action === 'internal-note') {
      ticket.auditTrail.push({ action: 'Internal case note added', note, at: now, by: actor });
    } else if (action === 'accept') {
      referral.status = 'accepted';
      referral.acceptedAt = now;
      referral.acceptedBy = actor;
      ticket.status = 'assigned';
      ticket.auditTrail.push({ action: 'Referral accepted by receiving unit', note, at: now, by: actor });
      ticket.studentUpdates.push({ label: 'Assigned to responsible unit', message: `${referral.targetLabel} has accepted the case for action.`, at: now });
    } else if (action === 'progress') {
      ticket.status = 'investigation-ongoing';
      if (ticket.slaPausedAt) supportResumeSla(ticket);
      ticket.auditTrail.push({ action: 'Investigation update recorded', note, at: now, by: actor });
      ticket.studentUpdates.push({ label: 'Investigation ongoing', message: note, at: now });
    } else if (action === 'request-evidence') {
      ticket.status = 'evidence-requested';
      supportPauseSla(ticket, note);
      ticket.auditTrail.push({ action: 'Additional evidence requested from student', note, at: now, by: actor });
      ticket.studentUpdates.push({ label: 'Additional evidence requested', message: note, at: now });
    } else if (action === 'resolve' || action === 'final-decision') {
      ticket.status = action === 'resolve' ? 'resolved' : 'final-decision';
      ticket.resolution = note;
      ticket.resolvedAt = now;
      ticket.resolvedBy = actor;
      ticket.studentResponseDueAt = supportMoveWorkingDays(now, 5);
      referral.status = 'resolved';
      referral.resolvedAt = now;
      ticket.auditTrail.push({ action: action === 'resolve' ? 'Resolution proposed' : 'Final decision issued', note, at: now, by: actor });
      ticket.studentUpdates.push({ label: action === 'resolve' ? 'Resolution proposed' : 'Final decision issued', message: note, at: now });
    } else {
      referral.status = 'returned-to-support';
      referral.returnedAt = now;
      ticket.status = 'assigned';
      ticket.ownerUnitId = 'student-support';
      ticket.ownerUnit = STAFF_UNITS['student-support'].label;
      ticket.referrals.push({ id: crypto.randomUUID(), sourceUnit: referral.targetUnit, sourceLabel: referral.targetLabel, targetUnit: 'student-support', targetLabel: STAFF_UNITS['student-support'].label, status: 'assigned', origin: 'returned-to-support', comment: note, createdAt: now, reassignmentHistory: [] });
      ticket.auditTrail.push({ action: 'Case returned to Student Support Services', note, at: now, by: actor });
      ticket.studentUpdates.push({ label: 'Returned to Student Support Services', message: 'The responsible unit has returned the case to Student Support Services for continued action.', at: now });
    }
    ticket.lastUpdatedAt = now;
    updated = { ...ticket };
    return ticket;
  });
  if (!updated) return res.status(404).json({ error: 'This case is not currently assigned to your unit.' });
  if (action !== 'internal-note') {
    const studentMessage = updated.studentUpdates?.[updated.studentUpdates.length - 1];
    sendSupportStudentUpdateEmail(updated, studentMessage || { label: 'Case updated', message: note }, req).catch(error => console.error('Functional-unit update email failed:', error.message));
  }
  return res.json({ ok: true, ticket: staffReferralTicket(updated, unitIds) });
});
app.post('/api/staff/referrals/:id/reassign', staffAuth, async(req, res) => {
  if ((ROLE_RANK[req.staffIdentity?.role] || 0) < ROLE_RANK.officer) return res.status(403).json({ error: 'Your staff role is read-only. An officer or administrator must reassign a case.' });
  const targetUnit = String(req.body?.targetUnit || '').trim();
  const note = String(req.body?.note || '').trim().slice(0, 2000);
  if (!Object.prototype.hasOwnProperty.call(STAFF_UNITS, targetUnit)) return res.status(400).json({ error: 'Select the receiving functional unit.' });
  if (!note) return res.status(400).json({ error: 'Provide reassignment comments for the receiving unit.' });
  const result = await reassignSupportReferral(req.params.id, { targetUnit, note, actor: req.staffIdentity?.name || req.staffIdentity?.username || 'Functional-unit officer', sourceUnits: req.staffIdentity?.units || [] });
  return reassignSupportReferralResponse(result, res, req);
});

// Public admin chooser. Department data remain protected behind department-specific credentials.
app.get('/admin',(_req,res)=>res.sendFile(path.join(__dirname,'admin','chooser.html')));
app.get('/admin/admin.css',(_req,res)=>res.sendFile(path.join(__dirname,'admin','admin.css')));
app.get('/admin/admin.js',(_req,res)=>res.sendFile(path.join(__dirname,'admin','admin.js')));
app.get('/admin/:department',departmentAuth,(req,res)=>res.sendFile(path.join(__dirname,'admin','index.html')));
app.get('/operations/portal.css',(_req,res)=>res.sendFile(path.join(__dirname,'operations','portal.css')));
app.get('/operations/payroll.js',(_req,res)=>res.sendFile(path.join(__dirname,'operations','payroll.js')));
app.get('/operations/auditor.js',(_req,res)=>res.sendFile(path.join(__dirname,'operations','auditor.js')));
app.get('/payroll/:department',departmentAuth,(req,res)=>adminCan(req,'payroll','viewer')?res.sendFile(path.join(__dirname,'operations','payroll.html')):res.status(403).send('Your account does not have access to the Payroll Portal.'));
app.get('/auditor/:department',departmentAuth,(req,res)=>adminCan(req,'auditor','viewer')?res.sendFile(path.join(__dirname,'operations','auditor.html')):res.status(403).send("Your account does not have access to the Auditor's Portal."));

app.get('/api/admin/:department/info', departmentAuth, async(req,res)=>{
  const availableDepartmentSlugs=normalizeAdminDepartments(req.adminIdentity?.departments||[req.adminDepartment]);
  const availableDepartments=(availableDepartmentSlugs.length?availableDepartmentSlugs:[req.adminDepartment]).map(slug=>({slug,name:DEPARTMENTS[slug].name}));
  res.json({ department:req.adminDepartment, departmentName:req.adminDepartmentName, availableDepartments, admin:{name:req.adminIdentity?.name||'',username:req.adminIdentity?.username||'',role:req.adminIdentity?.role||'viewer',sections:req.adminIdentity?.sections||[],departments:availableDepartmentSlugs,master:Boolean(req.adminIdentity?.master),developerPreview:Boolean(req.adminIdentity?.developerPreview),developerPreviewLabel:req.adminIdentity?.developerPreviewLabel||'',previewExpiresAt:req.adminIdentity?.previewExpiresAt||null} });
});
app.get('/api/admin/:department/submissions', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  const assignments=adminCan(req,'dissertation','viewer')?(await readAssignments()).filter(a=>a.department===req.adminDepartment):[];
  const mapped=adminRecordsMap(records,assignments).filter(r=>adminCan(req,portalSectionForRecord(r),'viewer'));
  res.json(mapped);
});
app.get('/api/admin/:department/project-student-search', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const query=String(req.query.q||'').trim();
  if(query.length<2)return res.status(400).json({error:'Enter at least two characters to search by student, index number, or supervisor.'});
  const needle=query.toLocaleLowerCase();
  const records=recordsForDepartment(await readDb(),req.adminDepartment).filter(record=>(record.portalType||'project-work')==='project-work');
  const results=[];
  for(const record of records){
    const supervisorName=record.fullName||'';
    const supervisorMatch=[supervisorName,record.email,record.reference].some(value=>String(value||'').toLocaleLowerCase().includes(needle));
    const rows=validScoreRowsWithMeta(record);
    const matchingRows=supervisorMatch?rows:rows.filter(row=>[row.name,row.registrationNo].some(value=>String(value||'').toLocaleLowerCase().includes(needle)));
    if(!matchingRows.length&&!supervisorMatch)continue;
    const files=[];
    const addFile=(label,kind,item,index)=>{if(!item)return;const suffix=index===undefined?'':`/${index}`;files.push({label,name:item.originalName||label,url:`/api/admin/${encodeURIComponent(req.adminDepartment)}/submissions/${encodeURIComponent(record.id)}/files/${kind}${suffix}`});};
    addFile('Original score sheet','scoresFile',record.files?.scoresFile);
    files.push({label:'Clean score sheet',name:`${record.reference}-clean-scores.xlsx`,url:`/api/admin/${encodeURIComponent(req.adminDepartment)}/submissions/${encodeURIComponent(record.id)}/scores.xlsx`});
    addFile('Claim form','claimForm',record.files?.claimForm);
    addFile('Project report','reportFile',record.files?.reportFile);
    const completedWorks=Array.isArray(record.files?.completedWork)?record.files.completedWork:(record.files?.completedWork?[record.files.completedWork]:[]);
    completedWorks.forEach((file,index)=>addFile(`Completed project work ${index+1}`,'completedWork',file,index));
    const studentRows=matchingRows.length?matchingRows:[{name:'',registrationNo:'',groupNo:'',totalScore:''}];
    for(const row of studentRows)results.push({studentName:row.name||'',registrationNo:row.registrationNo||'',groupNo:row.groupNo||'',totalScore:row.totalScore||'',supervisorName,supervisorEmail:record.email||'',supervisorPhone:record.phone||'',submissionId:record.id,reference:record.reference,submittedAt:record.submittedAt,studyCentre:studyCentreDisplay(record),stream:projectStream(record)==='non-residential'?'Non-Residential':'Distance',reviewStatus:projectReviewLabel(projectReviewStatus(record)),files});
  }
  results.sort((a,b)=>String(a.studentName||a.registrationNo).localeCompare(String(b.studentName||b.registrationNo),undefined,{numeric:true,sensitivity:'base'}));
  res.json({ok:true,query,total:results.length,truncated:results.length>200,results:results.slice(0,200)});
});
app.post('/api/admin/:department/project-work/:id/review', departmentAuth, requireAdminAccess('project-work','administrator'), async(req,res)=>{
  const status=String(req.body?.status||'').trim().toLowerCase();
  if(!PROJECT_REVIEW_STATUSES.has(status)) return res.status(400).json({error:'Choose Pending, Approved, Rejected or Returned for Correction.'});
  const note=String(req.body?.note||'').trim().slice(0,1500);
  if(status==='returned'&&!note) return res.status(400).json({error:'Enter the reason or correction required before returning this submission.'});
  const all=await readDb();
  const target=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&(r.portalType==='project-work'||!r.portalType));
  if(!target) return res.status(404).json({error:'Project work submission not found in this department.'});
  if(Array.isArray(req.body?.excludedRowIndexes)){
    const validIndexes=new Set(validScoreRowsWithMeta(target).map(row=>row.sourceIndex));
    target.scoreReviewExcludedRows=[...new Set(req.body.excludedRowIndexes.map(Number).filter(i=>Number.isInteger(i)&&validIndexes.has(i)))].sort((a,b)=>a-b);
  }
  if(status==='approved'&&!approvedProjectScoreRows(target).length)return res.status(400).json({error:'At least one score row must remain included before this submission can be approved.'});
  const now=new Date().toISOString();
  const reviewer=adminActorLabel(req,'Department administrator');
  resetPayrollAfterDepartmentChange(target,reviewer,now,'Departmental Project Work review changed.');
  target.reviewStatus=status; target.reviewNote=note; target.reviewedAt=now; target.reviewedBy=reviewer;
  target.reviewHistory=Array.isArray(target.reviewHistory)?target.reviewHistory:[];
  target.reviewHistory.push({status,note,reviewedAt:now,reviewedBy:reviewer});
  if(target.reviewHistory.length>50) target.reviewHistory=target.reviewHistory.slice(-50);
  if(status==='returned'){
    target.reviewReturnEmailStatus='pending';
    target.reviewReturnEmailError='';
  }
  await writeDb(all);
  let emailSent=null,emailError='';
  if(status==='returned'){
    if(!isEmail(target.email)){
      emailSent=false;emailError='The submission does not contain a valid supervisor/examiner email address.';
      target.reviewReturnEmailStatus='failed';target.reviewReturnEmailError=emailError;
      await writeDb(all);
    }else{
      try{
        const mail=await sendScoreSubmissionReturnedEmail({to:target.email,supervisorName:target.fullName,departmentName:req.adminDepartmentName,reference:target.reference,studyCentre:studyCentreDisplay(target),reason:note,portalType:'project-work',portalUrl:`${baseUrlFor(req)}/project-work.html`});
        emailSent=true;target.reviewReturnEmailStatus='sent';target.reviewReturnEmailSentAt=new Date().toISOString();target.reviewReturnEmailMessageId=mail.id||'';target.reviewReturnEmailRecipient=target.email;target.reviewReturnEmailError='';await writeDb(all);
      }catch(e){emailSent=false;emailError=String(e.message||e).slice(0,500);target.reviewReturnEmailStatus='failed';target.reviewReturnEmailError=emailError;await writeDb(all);console.error('Project Work correction email failed:',e);}
    }
  }
  const departmentRecords=recordsForDepartment(all,req.adminDepartment);
  res.json({ok:true,status,label:projectReviewLabel(status),reviewedAt:now,reviewedBy:reviewer,includedRows:approvedProjectScoreRows(target).length,totalRows:validScoreRows(target).length,warnings:projectSubmissionWarnings(target,departmentRecords),emailSent,emailError});
});


app.post('/api/admin/:department/project-work/:id/reconcile-duplicates', departmentAuth, requireAdminAccess('project-work','administrator'), async(req,res)=>{
  try{
    const edits=Array.isArray(req.body?.edits)?req.body.edits:[];
    const requestedIds=Array.isArray(req.body?.affectedSubmissionIds)?req.body.affectedSubmissionIds.map(String):[];
    if(!edits.length)return res.status(400).json({error:'No registration/index-number corrections were submitted.'});
    const all=await readDb();
    const current=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&(r.portalType==='project-work'||!r.portalType));
    if(!current)return res.status(404).json({error:'Project work submission not found in this department.'});
    const affected=new Set([current.id,...requestedIds]);
    const reviewer=adminActorLabel(req,'Department administrator');
    const now=new Date().toISOString();
    const audit=[];
    for(const edit of edits){
      const submissionId=String(edit?.submissionId||'');const sourceIndex=Number(edit?.sourceIndex);const registrationNo=cleanHumanText(edit?.registrationNo).slice(0,120);
      if(!submissionId||!Number.isInteger(sourceIndex)||!registrationNo)return res.status(400).json({error:'Each correction must identify a submission row and contain the corrected registration/index number.'});
      const record=all.find(r=>r.id===submissionId&&r.department===req.adminDepartment&&(r.portalType==='project-work'||!r.portalType));
      if(!record)return res.status(400).json({error:'One of the selected duplicate score sheets is no longer available in this department.'});
      const row=record?.scoreSheet?.rows?.[sourceIndex];
      if(!row||isStoredScoreFooterRow(row))return res.status(400).json({error:`A selected score row could not be found in ${record.reference||record.id}. Refresh the record and try again.`});
      const oldRegistrationNo=cellText(row.registrationNo);
      if(oldRegistrationNo!==registrationNo){
        row.registrationNo=registrationNo;
        record.registrationCorrectionHistory=Array.isArray(record.registrationCorrectionHistory)?record.registrationCorrectionHistory:[];
        const history={sourceIndex,oldRegistrationNo,newRegistrationNo:registrationNo,correctedAt:now,correctedBy:reviewer,reason:'Duplicate registration/index-number reconciliation'};
        record.registrationCorrectionHistory.push(history);if(record.registrationCorrectionHistory.length>100)record.registrationCorrectionHistory=record.registrationCorrectionHistory.slice(-100);
        audit.push({submissionId,reference:record.reference,sourceIndex,oldRegistrationNo,newRegistrationNo:registrationNo});
      }
      affected.add(submissionId);
    }
    // Re-approve every score sheet participating in the reconciliation. Consolidated outputs
    // are generated dynamically, so corrected registration numbers replace the old approved rows.
    for(const id of affected){
      const record=all.find(r=>r.id===id&&r.department===req.adminDepartment&&(r.portalType==='project-work'||!r.portalType));
      if(!record)continue;
      record.reviewStatus='approved';record.reviewedAt=now;record.reviewedBy=reviewer;
      record.reviewNote='Re-approved after duplicate registration/index-number reconciliation.';
      record.reviewHistory=Array.isArray(record.reviewHistory)?record.reviewHistory:[];
      record.reviewHistory.push({status:'approved',note:record.reviewNote,reviewedAt:now,reviewedBy:reviewer,action:'duplicate-reconciliation'});
      if(record.reviewHistory.length>50)record.reviewHistory=record.reviewHistory.slice(-50);
      resetPayrollAfterDepartmentChange(record,reviewer,now,'Project Work duplicate reconciliation changed approved score data.');
    }
    // Do not commit a reconciliation that still leaves an approved duplicate in the affected score sheets.
    const remaining=[];
    const departmentRecords=recordsForDepartment(all,req.adminDepartment);
    for(const id of affected){
      const record=departmentRecords.find(r=>r.id===id);if(!record)continue;
      const duplicateWarning=projectSubmissionWarnings(record,departmentRecords).find(w=>w.code==='duplicate-approved-registration');
      if(duplicateWarning)remaining.push(`${record.reference||id}: ${duplicateWarning.message}`);
    }
    if(remaining.length)return res.status(400).json({error:`The correction still leaves duplicate approved registration/index numbers. ${remaining.slice(0,3).join(' ')}`});
    await writeDb(all);
    res.json({ok:true,correctedRows:audit.length,reapprovedSubmissions:affected.size,reviewedAt:now,reviewedBy:reviewer});
  }catch(e){console.error('Duplicate reconciliation failed:',e);res.status(500).json({error:'The duplicate score-sheet reconciliation could not be completed.'});}
});

app.post('/api/admin/:department/project-work/:id/resend-return-email', departmentAuth, requireAdminAccess('project-work','administrator'), async(req,res)=>{
  const all=await readDb();const target=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&(r.portalType==='project-work'||!r.portalType));
  if(!target)return res.status(404).json({error:'Project work submission not found in this department.'});
  if(projectReviewStatus(target)!=='returned')return res.status(400).json({error:'Only a submission currently Returned for Correction can receive a correction email.'});
  if(!String(target.reviewNote||'').trim())return res.status(400).json({error:'This returned submission has no recorded correction reason. Reset it to Pending and return it again with a reason.'});
  const recipient=String(req.body?.recipientEmail||target.email||'').trim().toLowerCase();
  if(!isEmail(recipient))return res.status(400).json({error:'Enter a valid supervisor/examiner email address for the correction notice.'});
  try{const mail=await sendScoreSubmissionReturnedEmail({to:recipient,supervisorName:target.fullName,departmentName:req.adminDepartmentName,reference:target.reference,studyCentre:studyCentreDisplay(target),reason:target.reviewNote,portalType:'project-work',portalUrl:`${baseUrlFor(req)}/project-work.html`});target.reviewReturnEmailStatus='sent';target.reviewReturnEmailSentAt=new Date().toISOString();target.reviewReturnEmailMessageId=mail.id||'';target.reviewReturnEmailRecipient=recipient;target.reviewReturnEmailError='';await writeDb(all);res.json({ok:true,emailSent:true,sentAt:target.reviewReturnEmailSentAt,recipient});}
  catch(e){target.reviewReturnEmailStatus='failed';target.reviewReturnEmailError=String(e.message||e).slice(0,500);await writeDb(all);console.error('Project Work correction resend failed:',e);res.status(502).json({error:`The correction email could not be sent: ${e.message||e}`});}
});

app.post('/api/admin/:department/field-experience/:id/review', departmentAuth, requireAdminAccess('field-experience','administrator'), async(req,res)=>{
  const status=String(req.body?.status||'').trim().toLowerCase();
  if(!PROJECT_REVIEW_STATUSES.has(status)) return res.status(400).json({error:'Choose Pending, Approved, Rejected or Returned for Correction.'});
  const note=String(req.body?.note||'').trim().slice(0,1500);
  if(status==='returned'&&!note) return res.status(400).json({error:'Enter the reason or correction required before returning this submission.'});
  const all=await readDb();
  const target=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&r.portalType==='field-experience');
  if(!target) return res.status(404).json({error:'Field Experience and Teaching Practice score submission not found in this department.'});
  if(Array.isArray(req.body?.excludedRowIndexes)){
    const validIndexes=new Set(fieldValidScoreRowsWithMeta(target).map(row=>row.sourceIndex));
    target.fieldScoreReviewExcludedRows=[...new Set(req.body.excludedRowIndexes.map(Number).filter(index=>Number.isInteger(index)&&validIndexes.has(index)))].sort((a,b)=>a-b);
  }
  if(status==='approved'&&!approvedFieldExperienceScoreRows(target).length)return res.status(400).json({error:'At least one score row must remain included before this submission can be approved.'});
  const now=new Date().toISOString();
  const reviewer=adminActorLabel(req,'Department administrator');
  resetPayrollAfterDepartmentChange(target,reviewer,now,'Departmental Field Experience and Teaching Practice review changed.');
  target.reviewStatus=status; target.reviewNote=note; target.reviewedAt=now; target.reviewedBy=reviewer;
  target.reviewHistory=Array.isArray(target.reviewHistory)?target.reviewHistory:[];
  target.reviewHistory.push({status,note,reviewedAt:now,reviewedBy:reviewer});
  if(target.reviewHistory.length>50) target.reviewHistory=target.reviewHistory.slice(-50);
  if(status==='returned'){target.reviewReturnEmailStatus='pending';target.reviewReturnEmailError='';}
  await writeDb(all);
  let emailSent=null,emailError='';
  if(status==='returned'){
    if(!isEmail(target.email)){emailSent=false;emailError='The submission does not contain a valid supervisor/examiner email address.';target.reviewReturnEmailStatus='failed';target.reviewReturnEmailError=emailError;await writeDb(all);}
    else try{const mail=await sendScoreSubmissionReturnedEmail({to:target.email,supervisorName:target.fullName,departmentName:req.adminDepartmentName,reference:target.reference,studyCentre:target.studyCentre,reason:note,portalType:'field-experience',portalUrl:`${baseUrlFor(req)}/field-experience.html`});emailSent=true;target.reviewReturnEmailStatus='sent';target.reviewReturnEmailSentAt=new Date().toISOString();target.reviewReturnEmailMessageId=mail.id||'';target.reviewReturnEmailRecipient=target.email;target.reviewReturnEmailError='';await writeDb(all);}catch(e){emailSent=false;emailError=String(e.message||e).slice(0,500);target.reviewReturnEmailStatus='failed';target.reviewReturnEmailError=emailError;await writeDb(all);console.error('Field Experience and Teaching Practice correction email failed:',e);}
  }
  const departmentRecords=recordsForDepartment(all,req.adminDepartment);
  res.json({ok:true,status,label:projectReviewLabel(status),reviewedAt:now,reviewedBy:reviewer,includedRows:approvedFieldExperienceScoreRows(target).length,totalRows:fieldValidScoreRows(target).length,warnings:fieldExperienceSubmissionWarnings(target,departmentRecords),emailSent,emailError});
});

app.post('/api/admin/:department/field-experience/:id/reconcile-duplicates', departmentAuth, requireAdminAccess('field-experience','administrator'), async(req,res)=>{
  try{
    const edits=Array.isArray(req.body?.edits)?req.body.edits:[];
    const requestedIds=Array.isArray(req.body?.affectedSubmissionIds)?req.body.affectedSubmissionIds.map(String):[];
    if(!edits.length)return res.status(400).json({error:'No registration-number corrections were submitted.'});
    const all=await readDb();
    const current=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&r.portalType==='field-experience');
    if(!current)return res.status(404).json({error:'Field Experience and Teaching Practice score submission not found in this department.'});
    const assessmentType=String(current.assessmentType||'');
    const affected=new Set([current.id,...requestedIds]);
    const reviewer=adminActorLabel(req,'Department administrator');const now=new Date().toISOString();const audit=[];
    for(const edit of edits){
      const submissionId=String(edit?.submissionId||'');const sourceIndex=Number(edit?.sourceIndex);const registrationNo=cleanHumanText(edit?.registrationNo).slice(0,120);
      if(!submissionId||!Number.isInteger(sourceIndex)||!registrationNo)return res.status(400).json({error:'Each correction must identify a submission row and contain the corrected registration number.'});
      const record=all.find(r=>r.id===submissionId&&r.department===req.adminDepartment&&r.portalType==='field-experience'&&String(r.assessmentType||'')===assessmentType);
      if(!record)return res.status(400).json({error:'One of the selected score sheets is unavailable or belongs to a different assessment category.'});
      const row=record?.scoreSheet?.rows?.[sourceIndex];
      if(!row)return res.status(400).json({error:`A selected score row could not be found in ${record.reference||record.id}. Refresh the record and try again.`});
      const oldRegistrationNo=cellText(row.registrationNo);
      if(oldRegistrationNo!==registrationNo){
        row.registrationNo=registrationNo;
        record.registrationCorrectionHistory=Array.isArray(record.registrationCorrectionHistory)?record.registrationCorrectionHistory:[];
        record.registrationCorrectionHistory.push({sourceIndex,oldRegistrationNo,newRegistrationNo:registrationNo,correctedAt:now,correctedBy:reviewer,reason:'Field Experience duplicate registration-number reconciliation'});
        if(record.registrationCorrectionHistory.length>100)record.registrationCorrectionHistory=record.registrationCorrectionHistory.slice(-100);
        audit.push({submissionId,reference:record.reference,sourceIndex,oldRegistrationNo,newRegistrationNo:registrationNo});
      }
      affected.add(submissionId);
    }
    for(const id of affected){
      const record=all.find(r=>r.id===id&&r.department===req.adminDepartment&&r.portalType==='field-experience'&&String(r.assessmentType||'')===assessmentType);
      if(!record)continue;
      record.reviewStatus='approved';record.reviewedAt=now;record.reviewedBy=reviewer;record.reviewNote='Re-approved after duplicate registration-number reconciliation.';
      record.reviewHistory=Array.isArray(record.reviewHistory)?record.reviewHistory:[];
      record.reviewHistory.push({status:'approved',note:record.reviewNote,reviewedAt:now,reviewedBy:reviewer,action:'duplicate-reconciliation'});
      if(record.reviewHistory.length>50)record.reviewHistory=record.reviewHistory.slice(-50);
      resetPayrollAfterDepartmentChange(record,reviewer,now,'Field Experience duplicate reconciliation changed approved score data.');
    }
    const departmentRecords=recordsForDepartment(all,req.adminDepartment);const remaining=[];
    for(const id of affected){const record=departmentRecords.find(r=>r.id===id);if(!record)continue;const warning=fieldExperienceSubmissionWarnings(record,departmentRecords).find(item=>item.code==='duplicate-approved-registration');if(warning)remaining.push(`${record.reference||id}: ${warning.message}`);}
    if(remaining.length)return res.status(400).json({error:`The correction still leaves duplicate approved registration numbers. ${remaining.slice(0,3).join(' ')}`});
    await writeDb(all);
    res.json({ok:true,correctedRows:audit.length,reapprovedSubmissions:affected.size,reviewedAt:now,reviewedBy:reviewer});
  }catch(e){console.error('Field Experience duplicate reconciliation failed:',e);res.status(500).json({error:'The duplicate score-sheet reconciliation could not be completed.'});}
});

app.post('/api/admin/:department/field-experience/:id/resend-return-email', departmentAuth, requireAdminAccess('field-experience','administrator'), async(req,res)=>{
  const all=await readDb();const target=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&r.portalType==='field-experience');
  if(!target)return res.status(404).json({error:'Field Experience and Teaching Practice score submission not found in this department.'});
  if(projectReviewStatus(target)!=='returned')return res.status(400).json({error:'Only a submission currently Returned for Correction can receive a correction email.'});
  if(!String(target.reviewNote||'').trim())return res.status(400).json({error:'This returned submission has no recorded correction reason. Reset it to Pending and return it again with a reason.'});
  const recipient=String(req.body?.recipientEmail||target.email||'').trim().toLowerCase();
  if(!isEmail(recipient))return res.status(400).json({error:'Enter a valid supervisor/examiner email address for the correction notice.'});
  try{const mail=await sendScoreSubmissionReturnedEmail({to:recipient,supervisorName:target.fullName,departmentName:req.adminDepartmentName,reference:target.reference,studyCentre:target.studyCentre,reason:target.reviewNote,portalType:'field-experience',portalUrl:`${baseUrlFor(req)}/field-experience.html`});target.reviewReturnEmailStatus='sent';target.reviewReturnEmailSentAt=new Date().toISOString();target.reviewReturnEmailMessageId=mail.id||'';target.reviewReturnEmailRecipient=recipient;target.reviewReturnEmailError='';await writeDb(all);res.json({ok:true,emailSent:true,sentAt:target.reviewReturnEmailSentAt,recipient});}
  catch(e){target.reviewReturnEmailStatus='failed';target.reviewReturnEmailError=String(e.message||e).slice(0,500);await writeDb(all);console.error('Field Experience and Teaching Practice correction resend failed:',e);res.status(502).json({error:`The correction email could not be sent: ${e.message||e}`});}
});

app.post('/api/admin/:department/assessor/:id/claim-review', departmentAuth, requireAdminAccess('assessor','administrator'), async(req,res)=>{
  const status=String(req.body?.status||'').trim().toLowerCase();
  if(!PROJECT_REVIEW_STATUSES.has(status))return res.status(400).json({error:'Choose Pending, Approved, Rejected or Returned for Correction.'});
  const note=String(req.body?.note||'').trim().slice(0,1500);
  if(['rejected','returned'].includes(status)&&!note)return res.status(400).json({error:'Enter the reason for rejecting or returning this claim.'});
  const all=await readDb();const record=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&r.portalType==='assessor');
  if(!record)return res.status(404).json({error:'Assessment or vetting claim not found in this department.'});
  const validation=paymentClaimValidation(record),claims=paymentRecordFiles(record,'claimForm');
  if(status==='approved'&&(!validation.valid||claims.length<validation.claimedQuantity))return res.status(400).json({error:'Every claimed dissertation activity must have one report, score sheet and claim form before department approval.'});
  const now=new Date().toISOString(),reviewer=adminActorLabel(req,'Department administrator');
  record.claimReviewStatus=status;record.claimReviewNote=note;record.claimReviewedAt=now;record.claimReviewedBy=reviewer;
  record.claimReviewHistory=Array.isArray(record.claimReviewHistory)?record.claimReviewHistory:[];
  record.claimReviewHistory.push({status,note,reviewedAt:now,reviewedBy:reviewer});
  if(record.claimReviewHistory.length>50)record.claimReviewHistory=record.claimReviewHistory.slice(-50);
  resetPayrollAfterDepartmentChange(record,reviewer,now,'The department changed the assessment or vetting claim approval.');
  await writeDb(all);
  res.json({ok:true,status,label:projectReviewLabel(status),reviewedAt:now,reviewedBy:reviewer});
});

app.post('/api/admin/:department/dissertations/:id/return-to-student', departmentAuth, requireAdminAccess('dissertation','officer'), async(req,res)=>{
  const reasonCode=String(req.body?.reasonCode||'').trim();
  const otherReason=String(req.body?.otherReason||'').trim().slice(0,1500);
  const reasons={fees:'Fees not paid in full',turnitin:'Plagiarism (Turnitin) report not satisfactory / not valid',reviewer:'Reviewer response not complete / invalid',other:otherReason};
  const reason=reasons[reasonCode]; if(!reason)return res.status(400).json({error:'Select a valid reason. If Other is selected, enter the reason.'});
  const all=await readDb();const record=all.find(r=>r.id===req.params.id&&r.portalType==='dissertation'&&r.department===req.adminDepartment);
  if(!record)return res.status(404).json({error:'Dissertation submission not found.'});
  if(!isEmail(record.email))return res.status(400).json({error:'This submission has no valid student email address.'});
  record.processingStatus='returned';record.returnReasonCode=reasonCode;record.returnReason=reason;record.returnedAt=new Date().toISOString();record.returnedBy=adminActorLabel(req,'Department administrator');record.returnEmailStatus='pending';
  await writeDb(all);
  await mutateAssignments(list=>{for(const a of list){if(a.department!==req.adminDepartment||a.revokedAt)continue;if(!(a.dissertationIds||[]).map(String).includes(String(record.id)))continue;a.dissertationIds=(a.dissertationIds||[]).filter(x=>String(x)!==String(record.id));a.returnedWorkIds=[...new Set([...(a.returnedWorkIds||[]),record.id])];if(!a.dissertationIds.length){a.revokedAt=new Date().toISOString();a.emailStatus='revoked';a.revokedReason='All works in this assignment were returned to students.';}}return true;});
  try{const mail=await sendDissertationReturnedEmail({to:record.email,studentName:record.studentName,departmentName:req.adminDepartmentName,submissionType:record.submissionType||'fresh',reason,portalUrl:`${baseUrlFor(req)}/dissertation.html`});
    const fresh=await readDb();const target=fresh.find(r=>r.id===record.id);if(target){target.returnEmailStatus='sent';target.returnEmailMessageId=mail.id||'';await writeDb(fresh);}return res.json({ok:true,status:'returned',reason});
  }catch(e){const fresh=await readDb();const target=fresh.find(r=>r.id===record.id);if(target){target.returnEmailStatus='failed';target.returnEmailError=String(e.message||e).slice(0,500);await writeDb(fresh);}return res.status(502).json({error:`The dissertation was marked Returned to Student, but the email could not be sent: ${e.message||e}`});}
});

app.delete('/api/admin/:department/submissions/:id', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const target=records.find(r=>r.id===req.params.id);
  if(!target)return res.status(404).json({error:'Submission not found in this department.'});
  if(!requireRecordAccess(req,res,target,'administrator'))return;
  const result=await deleteDepartmentSubmissions(req.adminDepartment,[req.params.id]);
  res.json({ok:true,deleted:result.deleted});
});
app.post('/api/admin/:department/submissions/delete-selected', departmentAuth, async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?[...new Set(req.body.ids.map(String))]:[];
  if(!ids.length) return res.status(400).json({error:'Select at least one submission to delete.'});
  if(ids.length>500) return res.status(400).json({error:'A maximum of 500 submissions can be deleted at once.'});
  const all=recordsForDepartment(await readDb(),req.adminDepartment);const targets=all.filter(r=>ids.includes(String(r.id)));
  if(!targets.length)return res.status(404).json({error:'No selected submissions were found in this department.'});
  if(targets.some(r=>!adminCan(req,portalSectionForRecord(r),'administrator')))return res.status(403).json({error:'Your administrator account does not have permission to delete one or more selected submissions.'});
  const result=await deleteDepartmentSubmissions(req.adminDepartment,targets.map(r=>r.id));
  res.json({ok:true,deleted:result.deleted});
});
app.get('/api/admin/:department/submissions/:id', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  const r=records.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).json({error:'Submission not found in this department.'});
  if(!requireRecordAccess(req,res,r,'viewer'))return;
  if((r.portalType||'project-work')==='project-work'){
    return res.json({...r,reviewScoreRows:validScoreRowsWithMeta(r).map((row,i)=>({reviewNo:i+1,sourceIndex:row.sourceIndex,originalSn:row.originalSn,name:row.name,registrationNo:row.registrationNo,groupNo:row.groupNo,totalScore:row.totalScore,included:row.included})),groupValidation:projectGroupValidation(r),duplicateReconciliation:projectDuplicateReconciliation(r,records)});
  }
  if(r.portalType==='field-experience'){
    return res.json({...r,assessmentLabel:fieldAssessmentLabel(r),fieldValidation:fieldClaimValidation(r),reviewFieldScoreRows:fieldValidScoreRowsWithMeta(r).map((row,i)=>({reviewNo:i+1,sourceIndex:row.sourceIndex,originalSn:row.originalSn,registrationNo:row.registrationNo,name:row.name,scoreHeaders:row.scoreHeaders,scoreValues:row.scoreValues,included:row.included!==false})),duplicateReconciliation:fieldDuplicateReconciliation(r,records)});
  }
  res.json(r);
});
app.get('/api/admin/:department/submissions/:id/works/:workIndex/files/:kind', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  const r=records.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).send('Submission not found in this department.');
  if(r.portalType!=='assessor')return res.status(400).send('Work-level files are available only for assessment submissions.');
  if(!adminCan(req,'assessor','viewer'))return res.status(403).send('You do not have access to assessment report files.');
  const workIndex=Number.parseInt(req.params.workIndex,10);
  const work=Array.isArray(r.works)?r.works[workIndex]:null;
  if(!work)return res.status(404).send('Assessment work not found.');
  const allowed=['reportFile','claimForm','scoreSheet','dissertationFile'];
  if(!allowed.includes(req.params.kind))return res.status(400).send('Invalid file type.');
  const item=work.files?.[req.params.kind];
  if(!item)return res.status(404).send('File not found.');
  const fp=path.join(FILES_DIR,path.basename(item.storedName));
  if(!fs.existsSync(fp))return res.status(404).send('Stored file is unavailable.');
  res.download(fp,item.originalName);
});

const studentFeedbackUpload=upload.fields([{name:'studentReportFile',maxCount:1},{name:'studentDissertationFile',maxCount:1}]);
app.post('/api/admin/:department/submissions/:id/works/:workIndex/forward-to-student', departmentAuth, requireAdminAccess('assessor','officer'), studentFeedbackUpload, async(req,res)=>{
  if(!gmailConfigured()){await removeUploaded(req);return res.status(503).json({error:'Email sending is not configured for Gmail API.'});}
  const all=await readDb();const record=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&r.portalType==='assessor');
  if(!record){await removeUploaded(req);return res.status(404).json({error:'Assessment submission not found.'});}
  const workIndex=Number.parseInt(req.params.workIndex,10),work=record.works?.[workIndex];if(!work){await removeUploaded(req);return res.status(404).json({error:'Assessment work not found.'});}
  const exact=work.studentSubmissionId?all.find(r=>r.id===work.studentSubmissionId&&r.portalType==='dissertation'&&r.department===req.adminDepartment):null;
  const student=exact||latestStudentDissertation(all,req.adminDepartment,work.indexNumber);
  if(!student||!isEmail(student.email)){await removeUploaded(req);return res.status(400).json({error:`No dissertation submission with a valid student email was found for index number ${work.indexNumber||''}.`});}
  const reportType=record.reportType||'assessment';
  if((student.submissionType||'fresh')==='fresh'&&reportType!=='assessment'){await removeUploaded(req);return res.status(400).json({error:'Fresh dissertation submissions can only receive an Assessment Report.'});}
  const priorStudentFiles=work.feedback?.studentFiles||{};
  const newReport=filesFor(req,'studentReportFile')[0]||null,newDissertation=filesFor(req,'studentDissertationFile')[0]||null;
  if(newReport && await uploadedFileContainsReviewerIdentity(newReport,record.assessorName,record.email)){await removeUploaded(req);return res.status(400).json({error:'The proposed student report copy still appears to contain the assessor/vetter name or email. Remove all reviewer identity before forwarding.'});}
  if(newDissertation && await uploadedFileContainsReviewerIdentity(newDissertation,record.assessorName,record.email)){await removeUploaded(req);return res.status(400).json({error:'The proposed student reviewed-dissertation copy appears to contain the assessor/vetter name or email. Upload an anonymised copy.'});}
  const reportFile=newReport?fileRecord(newReport):priorStudentFiles.reportFile||null;
  const reviewedFile=newDissertation?fileRecord(newDissertation):priorStudentFiles.dissertationFile||null;
  if(!reportFile){await removeUploaded(req);return res.status(400).json({error:'Upload an anonymised student copy of the report before forwarding. The original assessor/vetter report is never sent directly to the student.'});}
  const token=newAssignmentToken(),now=new Date(),expiresAt=new Date(now.getTime()+STUDENT_FEEDBACK_EXPIRY_DAYS*24*60*60*1000).toISOString();
  work.feedback={...(work.feedback||{}),tokenHash:assignmentTokenHash(token),recipientEmail:student.email,studentSubmissionId:student.id,studentSubmissionType:student.submissionType||'fresh',reportType,createdAt:work.feedback?.createdAt||now.toISOString(),expiresAt,sentAt:null,downloadedAt:null,lastDownloadedAt:null,downloadCount:0,revokedAt:null,emailStatus:'pending',lastEmailError:'',studentFiles:{reportFile,dissertationFile:reviewedFile}};
  await writeDb(all);
  const secureUrl=`${baseUrlFor(req)}/secure/feedback/${token}`;
  try{
    const email=await sendStudentFeedbackEmail({to:student.email,studentName:student.studentName||work.studentName,departmentName:req.adminDepartmentName,secureUrl,expiresAt,reportType});
    await mutateAssessmentWork(record.id,workIndex,w=>{w.feedback.sentAt=new Date().toISOString();w.feedback.emailStatus='sent';w.feedback.emailProvider='gmail';w.feedback.emailProviderMessageId=email.id||'';w.feedback.lastEmailError='';return true;});
    res.json({ok:true,email:student.email,status:'sent'});
  }catch(e){console.error('Student feedback email failed:',e);await mutateAssessmentWork(record.id,workIndex,w=>{w.feedback.emailStatus='failed';w.feedback.lastEmailError=String(e.message||e).slice(0,500);return true;});res.status(502).json({error:`The anonymous feedback link was prepared, but the email could not be sent: ${e.message||e}`});}
});
app.post('/api/admin/:department/submissions/:id/works/:workIndex/revoke-feedback', departmentAuth, requireAdminAccess('assessor','officer'), async(req,res)=>{
  const workIndex=Number.parseInt(req.params.workIndex,10);const result=await mutateAssessmentWork(req.params.id,workIndex,(w,r)=>{if(r.department!==req.adminDepartment||!w.feedback)return null;w.feedback.revokedAt=new Date().toISOString();w.feedback.emailStatus='revoked';return true;});
  if(!result)return res.status(404).json({error:'Feedback link not found.'});res.json({ok:true});
});

app.get('/api/admin/:department/submissions/:id/files/:kind/:index?', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  const r=records.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).send('Submission not found in this department.');
  if(!adminCan(req,portalSectionForRecord(r),'viewer'))return res.status(403).send('You do not have access to this submission section.');
  const allowed=['claimForm','reportFile','scoresFile','completedWork','dissertationFile','reviewerResponses','turnitinReport'];
  if(!allowed.includes(req.params.kind))return res.status(400).send('Invalid file type.');
  let item=r.files?.[req.params.kind];
  if(Array.isArray(item))item=item[Number(req.params.index||0)];
  if(!item)return res.status(404).send('File not found.');
  const fp=path.join(FILES_DIR,path.basename(item.storedName));
  if(!fs.existsSync(fp))return res.status(404).send('Stored file is unavailable.');
  res.download(fp,item.originalName);
});

app.get('/api/admin/:department/submissions/:id/claim-preview', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const r=records.find(x=>x.id===req.params.id);
  if(!r)return res.status(404).send('Submission not found in this department.');
  const allowed=adminCan(req,'project-work','viewer')||adminCan(req,'field-experience','viewer')||adminCan(req,'assessor','viewer')||adminCan(req,'payroll','viewer')||adminCan(req,'auditor','viewer');
  if(!allowed)return res.status(403).send('You do not have access to claim-form verification.');
  if(!['project-work','field-experience','assessor'].includes(r.portalType||'project-work'))return res.status(400).send('This submission does not contain a supported claim form.');
  const claimIndex=Math.max(0,Number(req.query?.claim||0)||0);
  const item=Array.isArray(r.files?.claimForm)?r.files.claimForm[claimIndex]:r.files?.claimForm;
  if(!item)return res.status(404).send('No claim form was submitted with this record.');
  return sendInlineClaimPreview(res,item);
});

app.get('/api/admin/:department/submissions/:id/scores.xlsx', departmentAuth, async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  const r=records.find(x=>x.id===req.params.id);
  if(!r||!['project-work','field-experience'].includes(r.portalType||'project-work'))return res.status(404).send('Score submission not found.');
  if(!adminCan(req,portalSectionForRecord(r),'viewer'))return res.status(403).send('You do not have access to this score submission.');
  sendWorkbook(res,'single-score',[r],`${r.reference}-clean-scores.xlsx`);
});

// UNDERGRADUATE PROJECT WORK exports. Distance and Non-Residential (regular) results are kept separate.
app.get('/api/admin/:department/export/project-scores.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'scores',records,`${req.adminDepartment}-consolidated-distance-project-scores.xlsx`);
});
app.get('/api/admin/:department/export/project-register.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'project-register',records,`${req.adminDepartment}-distance-project-work-register.xlsx`);
});
app.get('/api/admin/:department/export/project-approved-register.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'project-approved-register',records,`${req.adminDepartment}-approved-distance-project-work-register.xlsx`);
});
app.get('/api/admin/:department/export/project-master.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'project-master',records,`${req.adminDepartment}-master-distance-project-scores.xlsx`);
});
app.get('/api/admin/:department/export/non-residential-project-scores.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'non-residential-scores',records,`${req.adminDepartment}-consolidated-non-residential-project-scores.xlsx`);
});
app.get('/api/admin/:department/export/non-residential-project-register.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'non-residential-project-register',records,`${req.adminDepartment}-non-residential-project-work-register.xlsx`);
});
app.get('/api/admin/:department/export/non-residential-project-approved-register.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'non-residential-project-approved-register',records,`${req.adminDepartment}-approved-non-residential-project-work-register.xlsx`);
});
app.get('/api/admin/:department/export/non-residential-project-master.xlsx', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'non-residential-project-master',records,`${req.adminDepartment}-master-non-residential-project-scores.xlsx`);
});
app.get('/api/admin/:department/export/project-centre-by-centre.zip', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);
  try{await streamCentreByCentreScoreZip(res,records,'distance',`${req.adminDepartment}-distance-centre-by-centre-scores.zip`);}catch(e){console.error('Centre by Centre ZIP failed:',e);if(!res.headersSent)res.status(500).json({error:'Could not create the Centre by Centre ZIP.'});else res.end();}
});
app.get('/api/admin/:department/export/non-residential-project-centre-by-centre.zip', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);
  try{await streamCentreByCentreScoreZip(res,records,'non-residential',`${req.adminDepartment}-non-residential-centre-by-centre-scores.zip`);}catch(e){console.error('Non-Residential Centre by Centre ZIP failed:',e);if(!res.headersSent)res.status(500).json({error:'Could not create the Centre by Centre ZIP.'});else res.end();}
});
// Backward-compatible aliases for bookmarks created before v25.
app.get('/api/admin/:department/export/project-programme-centre.zip', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);try{await streamCentreByCentreScoreZip(res,records,'distance',`${req.adminDepartment}-distance-centre-by-centre-scores.zip`);}catch(e){if(!res.headersSent)res.status(500).json({error:'Could not create the Centre by Centre ZIP.'});else res.end();}
});
app.get('/api/admin/:department/export/non-residential-project-programme-centre.zip', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);try{await streamCentreByCentreScoreZip(res,records,'non-residential',`${req.adminDepartment}-non-residential-centre-by-centre-scores.zip`);}catch(e){if(!res.headersSent)res.status(500).json({error:'Could not create the Centre by Centre ZIP.'});else res.end();}
});
app.post('/api/admin/:department/project-claims/download-selected', departmentAuth, requireAdminAccess('project-work','viewer'), async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String):[];const stream=req.body?.stream==='non-residential'?'non-residential':'distance';
  if(!ids.length)return res.status(400).json({error:'Select at least one Undergraduate Project Work submission.'});
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const zipFiles=claimFilesForSelectedProject(records,ids,stream);
  if(!zipFiles.length)return res.status(404).json({error:'No claim forms were found for the selected submissions.'});
  res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="${req.adminDepartment}-${stream}-selected-claim-forms.zip"`);
  try{await streamZipArchive(res,zipFiles);}catch(e){console.error('Project claim ZIP failed:',e);if(!res.headersSent)res.status(500).json({error:'Could not create the claim-form ZIP.'});else res.end();}
});
app.post('/api/admin/:department/project-claims/email-selected', departmentAuth, requireAdminAccess('project-work','officer'), async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(String):[];const stream=req.body?.stream==='non-residential'?'non-residential':'distance';const recipient=String(req.body?.recipientEmail||'').trim().toLowerCase();
  if(!ids.length)return res.status(400).json({error:'Select at least one Undergraduate Project Work submission.'});
  if(!isEmail(recipient))return res.status(400).json({error:'Enter a valid department email address.'});
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const zipFiles=claimFilesForSelectedProject(records,ids,stream);
  if(!zipFiles.length)return res.status(404).json({error:'No claim forms were found for the selected submissions.'});
  const total=zipFiles.reduce((n,f)=>n+Number(f.size||0),0);if(total>18*1024*1024)return res.status(400).json({error:'The selected claim forms are too large to email safely as one Gmail attachment. Download the ZIP instead or send a smaller selection.'});
  try{
    const zip=await zipBufferFromFiles(zipFiles);const streamLabel=stream==='non-residential'?'Non-Residential':'Distance';
    const html=`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">Undergraduate Project Work Claim Forms</h2><p>${htmlEscape(req.adminDepartmentName)}</p><p>Attached is a ZIP containing <strong>${zipFiles.length}</strong> selected ${htmlEscape(streamLabel)} Undergraduate Project Work claim form${zipFiles.length===1?'':'s'}.</p><p>Each claim form has been renamed using the Supervisor/Examiner name for easier departmental processing.</p><p>Regards,<br>${htmlEscape(GMAIL_FROM_NAME||'CoDE Academic Submission Portal')}<br>College of Distance Education<br>University of Cape Coast</p></div></body></html>`;
    const filename=`${req.adminDepartment}-${stream}-selected-claim-forms.zip`;
    const mail=await sendGmailHtmlEmail({to:recipient,subject:`Undergraduate Project Work Claim Forms - ${req.adminDepartmentName}`,html,attachments:[{filename,contentType:'application/zip',content:zip}]});
    res.json({ok:true,emailSent:true,recipient,count:zipFiles.length,messageId:mail.id||''});
  }catch(e){console.error('Email selected claim forms failed:',e);res.status(502).json({error:`Could not email the claim forms: ${e.message||e}`});}
});

// FIELD EXPERIENCE AND TEACHING PRACTICE individual score reports.
// Field Experience I & II and III & IV are submitted on paired templates, but approved outputs are split into individual reports.
app.get('/api/admin/:department/export/field-report/:reportKey/scores.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const report=fieldScoreReportSpec(req.params.reportKey); if(!report)return res.status(404).json({error:'Unknown Field Experience report.'});
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const buffer=fieldScoreReportWorkbookBuffer(records,req.params.reportKey,'scores');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(req.adminDepartment+'-'+req.params.reportKey+'-consolidated-scores.xlsx')}"`);res.send(buffer);
});
app.get('/api/admin/:department/export/field-report/:reportKey/master.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const report=fieldScoreReportSpec(req.params.reportKey); if(!report)return res.status(404).json({error:'Unknown Field Experience report.'});
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const buffer=fieldScoreReportWorkbookBuffer(records,req.params.reportKey,'master');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(req.adminDepartment+'-'+req.params.reportKey+'-master-scores.xlsx')}"`);res.send(buffer);
});
app.get('/api/admin/:department/export/field-report/:reportKey/register.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const report=fieldScoreReportSpec(req.params.reportKey); if(!report)return res.status(404).json({error:'Unknown Field Experience report.'});
  const records=recordsForDepartment(await readDb(),req.adminDepartment);const buffer=fieldScoreReportWorkbookBuffer(records,req.params.reportKey,'register');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${safeBaseName(req.adminDepartment+'-'+req.params.reportKey+'-register.xlsx')}"`);res.send(buffer);
});
app.get('/api/admin/:department/export/field-report/:reportKey/centre-by-centre.zip', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const report=fieldScoreReportSpec(req.params.reportKey); if(!report)return res.status(404).json({error:'Unknown Field Experience report.'});
  const records=recordsForDepartment(await readDb(),req.adminDepartment);
  try{await streamFieldCentreByCentreScoreZip(res,records,req.params.reportKey,`${req.adminDepartment}-${req.params.reportKey}-centre-by-centre.zip`);}catch(e){console.error('Field Centre by Centre ZIP failed:',e);if(!res.headersSent)res.status(500).json({error:'Could not create the Centre by Centre ZIP.'});else res.end();}
});
app.get('/api/admin/:department/export/field-report/:reportKey/programme-centre.zip', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const report=fieldScoreReportSpec(req.params.reportKey); if(!report)return res.status(404).json({error:'Unknown Field Experience report.'});const records=recordsForDepartment(await readDb(),req.adminDepartment);
  try{await streamFieldCentreByCentreScoreZip(res,records,req.params.reportKey,`${req.adminDepartment}-${req.params.reportKey}-centre-by-centre.zip`);}catch(e){if(!res.headersSent)res.status(500).json({error:'Could not create the Centre by Centre ZIP.'});else res.end();}
});

// FIELD EXPERIENCE AND TEACHING PRACTICE overall exports retained for backward compatibility.
app.get('/api/admin/:department/export/field-experience-scores.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'field-scores',records,`${req.adminDepartment}-consolidated-field-experience-and-teaching-practice-scores.xlsx`);
});
app.get('/api/admin/:department/export/field-experience-register.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'field-register',records,`${req.adminDepartment}-field-experience-and-teaching-practice-register.xlsx`);
});
app.get('/api/admin/:department/export/field-experience-approved-register.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'field-approved-register',records,`${req.adminDepartment}-approved-field-experience-and-teaching-practice-register.xlsx`);
});
app.get('/api/admin/:department/export/field-experience-master.xlsx', departmentAuth, requireAdminAccess('field-experience','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'field-master',records,`${req.adminDepartment}-master-field-experience-and-teaching-practice-scores.xlsx`);
});

// DISSERTATION register and selected-document ZIP. No dissertation content is consolidated.

// Payroll receives only department-approved Project Work, Field Experience and dissertation assessment/vetting claims.
// Auditor access begins only after Payroll marks a claim Approved for Payment.
app.get('/api/payroll/:department/claims', departmentAuth, requireAdminAccess('payroll','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);
  res.json(approvedPaymentClaimRecords(records).map(payrollClaimRow));
});
app.post('/api/payroll/:department/claims/:id/status', departmentAuth, requireAdminAccess('payroll','officer'), async(req,res)=>{
  const status=String(req.body?.status||'').trim();
  const allowed=new Set(['pending','verified','approved-for-payment','paid','queried']);
  if(!allowed.has(status))return res.status(400).json({error:'Choose a valid payroll processing status.'});
  const note=String(req.body?.note||'').trim().slice(0,1500);
  const all=await readDb();const record=all.find(r=>r.id===req.params.id&&r.department===req.adminDepartment&&['project-work','field-experience','assessor'].includes(r.portalType||'project-work'));
  if(!record)return res.status(404).json({error:'Approved departmental claim not found.'});
  if(departmentPaymentApprovalStatus(record)!=='approved')return res.status(400).json({error:'Only submissions approved by the department can be processed for payment.'});
  const validation=paymentClaimValidation(record);
  const paymentRow=payrollClaimRow(record);
  if(status==='approved-for-payment'&&!paymentRow.claimFormPresent)return res.status(400).json({error:'Every claimed activity must have a claim form before Payroll can approve this submission for payment.'});
  if(status==='approved-for-payment'&&!validation.valid)return res.status(400).json({error:'Resolve the claimed-quantity and approved-score reconciliation before approving this claim for payment.'});
  if(status==='paid'&&String(record?.payroll?.status||'pending')!=='approved-for-payment')return res.status(400).json({error:'Mark the claim Approved for Payment before recording it as Paid.'});
  const now=new Date().toISOString(),by=adminActorLabel(req,'Payroll officer');
  record.payroll={...(record.payroll||{}),status,note,updatedAt:now,updatedBy:by};
  record.payroll.history=Array.isArray(record.payroll.history)?record.payroll.history:[];
  record.payroll.history.push({status,note,updatedAt:now,updatedBy:by});if(record.payroll.history.length>100)record.payroll.history=record.payroll.history.slice(-100);
  await writeDb(all);res.json({ok:true,claim:payrollClaimRow(record)});
});
app.get('/api/payroll/:department/register.xlsx', departmentAuth, requireAdminAccess('payroll','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);sendWorkbook(res,'payroll-register',records,`${req.adminDepartment}-department-approved-payroll-register.xlsx`);
});
app.get('/api/payroll/:department/approved-register.xlsx', departmentAuth, requireAdminAccess('payroll','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);sendWorkbook(res,'payroll-register',records,`${req.adminDepartment}-department-approved-claims-register.xlsx`);
});
app.get('/api/auditor/:department/claims', departmentAuth, requireAdminAccess('auditor','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);res.json(auditorVisibleClaimRecords(records).map(payrollClaimRow));
});
app.get('/api/auditor/:department/register.xlsx', departmentAuth, requireAdminAccess('auditor','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);sendWorkbook(res,'auditor-register',records,`${req.adminDepartment}-auditor-payment-approved-claims-register.xlsx`);
});
app.get('/api/auditor/:department/approved-register.xlsx', departmentAuth, requireAdminAccess('auditor','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(),req.adminDepartment);sendWorkbook(res,'auditor-register',records,`${req.adminDepartment}-payroll-approved-for-payment-register.xlsx`);
});

app.get('/api/admin/:department/export/fresh-dissertation-register.xlsx', departmentAuth, requireAdminAccess('dissertation','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'fresh-dissertation-register',records,`${req.adminDepartment}-fresh-dissertation-register.xlsx`);
});
app.get('/api/admin/:department/export/revised-dissertation-register.xlsx', departmentAuth, requireAdminAccess('dissertation','viewer'), async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment);
  sendWorkbook(res,'revised-dissertation-register',records,`${req.adminDepartment}-revised-dissertation-register.xlsx`);
});
app.post('/api/admin/:department/dissertations/download-selected', departmentAuth, requireAdminAccess('dissertation','viewer'), async(req,res)=>{
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error:'Select at least one dissertation.' });
  if (ids.length > 500) return res.status(400).json({ error:'A maximum of 500 dissertations can be downloaded at once.' });

  const records=dissertationRecords(recordsForDepartment(await readDb(), req.adminDepartment));
  const selected = ids.map(id => records.find(r => r.id === id)).filter(Boolean);
  if (!selected.length) return res.status(404).json({ error:'No selected dissertations were found in this department.' });

  const zipFiles=[];
  selected.forEach((r,i)=>{
    const item=r.files?.dissertationFile;
    if(!item) return;
    const fp=path.join(FILES_DIR,path.basename(item.storedName));
    if(!fs.existsSync(fp)) return;
    const ext=path.extname(item.originalName || fp) || '.docx';
    const prefix=String(i+1).padStart(3,'0');
    zipFiles.push({path:fp,name:safeBaseName(`${prefix} - ${r.indexNumber || 'No Index'} - ${r.studentName || 'Student'}${ext}`),size:Number(item.size||fs.statSync(fp).size)});
  });
  if(!zipFiles.length) return res.status(404).json({ error:'Selected dissertation files are unavailable.' });
  const totalSize=zipFiles.reduce((a,f)=>a+f.size,0);
  if(totalSize > 3.5 * 1024 * 1024 * 1024) return res.status(400).json({ error:'The selected ZIP would exceed the supported 3.5 GB limit. Download the dissertations in smaller groups.' });

  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="${req.adminDepartment}-selected-dissertations.zip"`);
  try { await streamZipArchive(res, zipFiles); }
  catch(e) { console.error('ZIP download failed:', e); if(!res.headersSent)res.status(500).json({error:'Could not create the ZIP file.'}); else res.end(); }
});

app.get('/api/admin/:department/summary',departmentAuth,async(req,res)=>{
  const records=recordsForDepartment(await readDb(), req.adminDepartment).filter(r=>adminCan(req,portalSectionForRecord(r),'viewer'));
  res.json({
    total:records.length,
    project:adminCan(req,'project-work','viewer')?projectRecords(records).length:0,
    distanceProject:adminCan(req,'project-work','viewer')?distanceProjectRecords(records).length:0,
    nonResidentialProject:adminCan(req,'project-work','viewer')?nonResidentialProjectRecords(records).length:0,
    fieldExperience:adminCan(req,'field-experience','viewer')?fieldExperienceRecords(records).length:0,
    dissertation:adminCan(req,'dissertation','viewer')?dissertationRecords(records).length:0,
    assessor:adminCan(req,'assessor','viewer')?assessorRecords(records).length:0,
    scoreRows:adminCan(req,'project-work','viewer')?allScoreRows(records).length:0,
    nonResidentialScoreRows:adminCan(req,'project-work','viewer')?allNonResidentialScoreRows(records).length:0,
    fieldScoreRows:adminCan(req,'field-experience','viewer')?allFieldExperienceScoreRows(records).length:0
  });
});

app.get('/health',async(_req,res)=>{const admins=await readAdminUsers(),centreCatalogue=await readStudyCentreCatalogue(),centreDirectory=await readStudyCentreDirectory(),supportTickets=await readSupportTickets();const centreCount=Object.values(centreCatalogue).reduce((n,list)=>n+(Array.isArray(list)?list.length:0),0);res.json({ok:true,appName:'Codeacademicservices',departments:Object.keys(DEPARTMENTS).length,emailConfigured:gmailConfigured(),emailProvider:'gmail',smsConfigured:supportMobileChannelConfigured('sms'),whatsappConfigured:supportMobileChannelConfigured('whatsapp'),resources:(await readResources()).length+BUILTIN_RESOURCES.length,adminUsers:admins.length,pendingAdminInvitations:admins.filter(a=>!a.passwordHash&&a.invitationTokenHash).length,studyCentres:centreCount,studyCentreDirectory:centreDirectory.length,supportTickets:supportTickets.length,developerPortalConfigured:DEVELOPER_ADMIN_PASSWORD!=='change-this-password'});});
app.get('/vendor/xlsx.full.min.js', (_req,res)=>res.sendFile(path.join(__dirname,'node_modules','xlsx','dist','xlsx.full.min.js')));
app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));
app.use((err,req,res,_next)=>{
  console.error(err);
  if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'A file exceeds the 100 MB server limit.':err.message});
  res.status(500).json({error:'Unexpected server error.'});
});

async function supportLifecycleRecipients(ticket) {
  const accounts = (await readAdminUsers()).filter(account => account.active !== false && (ROLE_RANK[account.role] || 0) >= ROLE_RANK.officer && isEmail(account.email));
  const units = ticket.sensitive
    ? new Set([ticket.ownerUnitId || 'confidential-handler', 'provost'])
    : new Set([ticket.ownerUnitId || 'student-support', 'student-support']);
  const matching = accounts.filter(account => normalizeStaffUnits(account.units).some(unit => units.has(unit)));
  const administrators = matching.filter(account => account.role === 'administrator');
  const selected = administrators.length ? administrators : matching;
  return [...new Set(selected.map(account => String(account.email).trim().toLowerCase()))].filter(email => supportEmailsAreInstitutional([email]));
}
function supportLifecycleEmail(ticket, type) {
  const isBreach = type === 'sla-breach';
  const heading = isBreach ? 'Student Support SLA breach' : 'Student Support SLA warning';
  const action = isBreach ? 'The resolution target has been exceeded. Unit-head and Student Support follow-up are required.' : 'The resolution target is within one working day. Confirm the next action and update the student.';
  const portalLink = PUBLIC_BASE_URL ? `<p><a href="${htmlEscape(`${PUBLIC_BASE_URL}/staff`)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:11px 16px;border-radius:7px;font-weight:bold">Open staff workspace</a></p>` : '';
  return { subject:`${isBreach ? 'Overdue' : 'Due soon'}: ${ticket.reference}`, html:`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">${heading}</h2><p><strong>Reference:</strong> ${htmlEscape(ticket.reference)}<br><strong>Category:</strong> ${htmlEscape(ticket.categoryLabel)}<br><strong>Responsible unit:</strong> ${htmlEscape(ticket.ownerUnit)}<br><strong>Target:</strong> ${htmlEscape(new Date(ticket.dueAt).toLocaleString('en-GB',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'}))} UTC</p><p>${action}</p>${portalLink}<p>Do not forward case details outside authorised institutional channels.</p></div></body></html>` };
}
async function dispatchSupportLifecycleNotifications() {
  if (!gmailConfigured() && !supportMobileChannelConfigured('sms') && !supportMobileChannelConfigured('whatsapp')) return;
  const tickets = await readSupportTickets();
  const candidates = [];
  for (const ticket of tickets) {
    const eligible = type => { const state=ticket.notificationState?.[type]; return !state?.sentAt && Number(state?.attempts || 0) < 3 && (!state?.lastAttemptAt || Date.now() - new Date(state.lastAttemptAt).getTime() >= 60 * 60 * 1000); };
    if (gmailConfigured() && ticket.slaWarningAt && eligible('sla-warning')) candidates.push({ ticketId:ticket.id, type:'sla-warning' });
    if (gmailConfigured() && ticket.slaBreachedAt && eligible('sla-breach')) candidates.push({ ticketId:ticket.id, type:'sla-breach' });
    const reminderChannelAvailable=gmailConfigured() || supportMobileChannels(ticket).some(supportMobileChannelConfigured);
    if (reminderChannelAvailable && ticket.slaPausedAt && supportElapsedWorkingDays(ticket.slaPausedAt) >= SUPPORT_EVIDENCE_REMINDER_WORKING_DAYS && eligible('evidence-reminder')) candidates.push({ ticketId:ticket.id, type:'evidence-reminder' });
  }
  for (const candidate of candidates) {
    let claimed = null;
    await mutateSupportTickets(list => {
      const ticket = list.find(item => item.id === candidate.ticketId);
      if (!ticket) return list;
      ticket.notificationState = ticket.notificationState || {};
      const state = ticket.notificationState[candidate.type] || { attempts:0 };
      const retryReady = !state.lastAttemptAt || Date.now() - new Date(state.lastAttemptAt).getTime() >= 60 * 60 * 1000;
      if (state.sentAt || state.attempts >= 3 || !retryReady) return list;
      state.attempts += 1;
      state.lastAttemptAt = new Date().toISOString();
      state.status = 'sending';
      ticket.notificationState[candidate.type] = state;
      claimed = JSON.parse(JSON.stringify(ticket));
      return list;
    });
    if (!claimed) continue;
    try {
      if (candidate.type === 'evidence-reminder') {
        if (!isEmail(claimed.email)) throw new Error('Student email is unavailable.');
        const statusUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/support-track.html?token=${encodeURIComponent(supportStatusToken(claimed))}` : '';
        const link = statusUrl ? `<p><a href="${htmlEscape(statusUrl)}" style="display:inline-block;background:#082b4c;color:#fff;text-decoration:none;padding:11px 16px;border-radius:7px;font-weight:bold">Respond to this ticket</a></p>` : '';
        await dispatchSupportStudentNotification(claimed, { kind:'reminder', subject:`Information still required - ${claimed.reference}`, html:`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#182431;line-height:1.55"><div style="max-width:680px;margin:auto;padding:24px"><h2 style="color:#082b4c">Your response is still needed</h2><p>Dear ${htmlEscape(claimed.name || 'Student')},</p><p>The responsible unit is waiting for the information requested on ticket <strong>${htmlEscape(claimed.reference)}</strong>.</p><p>${htmlEscape(claimed.slaPauseReason || 'Please review the ticket and provide the requested evidence.')}</p>${link}<p>The service target remains paused until your response is received.</p></div></body></html>` });
      } else {
        const recipients = await supportLifecycleRecipients(claimed);
        if (!recipients.length) throw new Error('No eligible institutional escalation recipient is assigned.');
        const email = supportLifecycleEmail(claimed, candidate.type);
        await Promise.all(recipients.map(to => sendGmailHtmlEmail({ to, subject:email.subject, html:email.html })));
      }
      await mutateSupportTickets(list => { const ticket=list.find(item=>item.id===candidate.ticketId); const state=ticket?.notificationState?.[candidate.type]; if(state){state.status='sent';state.sentAt=new Date().toISOString();delete state.error;} return list; });
    } catch (error) {
      await mutateSupportTickets(list => { const ticket=list.find(item=>item.id===candidate.ticketId); const state=ticket?.notificationState?.[candidate.type]; if(state){state.status='failed';state.error=String(error.message||'Delivery failed').slice(0,300);} return list; });
      console.error(`Support ${candidate.type} notification failed:`, error.message);
    }
  }
}

async function refreshSupportLifecycle() {
  await mutateSupportTickets(tickets => {
    const now = Date.now();
    const terminal = new Set(['accepted','closed']);
    for (const ticket of tickets) {
      ticket.auditTrail = Array.isArray(ticket.auditTrail) ? ticket.auditTrail : [];
      ticket.studentUpdates = Array.isArray(ticket.studentUpdates) ? ticket.studentUpdates : [];
      if (['resolved','final-decision'].includes(ticket.status) && ticket.studentResponseDueAt && new Date(ticket.studentResponseDueAt).getTime() <= now) {
        const at = new Date().toISOString();
        ticket.status = 'closed';
        ticket.closedAt = at;
        ticket.lastUpdatedAt = at;
        ticket.auditTrail.push({ action: 'Response period ended and case closed', note: 'The student may still submit an appeal.', at, by: 'System' });
        ticket.studentUpdates.push({ label: 'Case closed', message: 'The response period has ended. You may still submit an appeal if the decision remains disputed.', at });
        continue;
      }
      if (terminal.has(ticket.status) || ticket.slaPausedAt || !ticket.dueAt) continue;
      const sla = supportSlaSummary(ticket);
      const at = new Date().toISOString();
      if (sla.overdue && !ticket.slaBreachedAt) {
        ticket.slaBreachedAt = at;
        ticket.lastUpdatedAt = at;
        ticket.auditTrail.push({ action: 'SLA escalation triggered', note: 'Resolution target exceeded; unit-head and Student Support follow-up required.', at, by: 'System' });
      } else if (sla.atRisk && !ticket.slaWarningAt) {
        ticket.slaWarningAt = at;
        ticket.lastUpdatedAt = at;
        ticket.auditTrail.push({ action: 'SLA warning triggered', note: 'Resolution target is within one working day.', at, by: 'System' });
      }
    }
    return tickets;
  });
  await dispatchSupportLifecycleNotifications();
}

const supportLifecycleTimer = setInterval(() => refreshSupportLifecycle().catch(error => console.error('Support lifecycle refresh failed:', error.message)), 15 * 60 * 1000);
supportLifecycleTimer.unref();
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`UCC submission portals listening on ${PORT}`);
  refreshSupportLifecycle().catch(error => console.error('Initial support lifecycle refresh failed:', error.message));
  for (const [slug, dept] of Object.entries(DEPARTMENTS)) {
    if (dept.password === 'change-this-password') console.warn(`WARNING: Set a secure admin password for ${slug}.`);
  }
  if (DEVELOPER_ADMIN_PASSWORD === 'change-this-password') console.warn('WARNING: Set DEVELOPER_ADMIN_PASSWORD before using the developer resource portal.');
  if (SUPPORT_STATUS_TOKEN_SECRET === DEVELOPER_ADMIN_PASSWORD) console.warn('WARNING: Set SUPPORT_STATUS_TOKEN_SECRET to a separate long random value.');
  if ((SUPPORT_SMS_ENABLED || SUPPORT_WHATSAPP_ENABLED) && (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)) console.warn('WARNING: Mobile notifications are enabled but Twilio credentials are incomplete.');
  if ((supportMobileChannelConfigured('sms') || supportMobileChannelConfigured('whatsapp')) && !PUBLIC_BASE_URL) console.warn('WARNING: Set PUBLIC_BASE_URL before enabling mobile notifications so tracking links are complete.');
});
