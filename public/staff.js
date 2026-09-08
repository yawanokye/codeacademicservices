(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]));
  const date = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' }) : 'Not available';
  const functionalUnits = { 'student-support':'Student Support Services Unit', 'confidential-handler':'Confidential Case Handler', 'general-office':'General Office', 'student-records':'Student Records Management Unit', 'college-registrar':'College Registrar', provost:'Provost', 'directorate-education-business':'Directorate of Education and Business Studies', 'directorate-arts-stem':'Directorate of Arts and STEM Studies', 'academic-departments':'Academic Departments', examinations:'Examinations Unit', payroll:'Payroll Portal', auditor:"Auditor's Portal", 'regional-administrator':'Regional Administrators', coordinator:'Centre Coordinators', 'quality-assurance':'Quality Assurance Unit', 'college-finance':'College Finance Officer', admissions:'Admissions Unit', stores:'Stores Unit' };
  const roleLabels = { viewer:'Viewer · read-only', officer:'Officer · operational actions', administrator:'Administrator · full assigned-unit control' };
  let currentStaff = null;
  let referrals = [];

  function show(text, ok) {
    const element = document.getElementById('staffMessage');
    element.textContent = text;
    element.className = `status show ${ok ? 'ok' : 'bad'}`;
    element.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  function unitOptions() {
    return `<option value="">Select functional unit</option>${Object.entries(functionalUnits).map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('')}`;
  }
  function unitCard(unit, staff) {
    let action = '<span class="staff-restricted">Cases assigned to this unit appear in Shared referrals below.</span>';
    if (unit.id === 'student-support') action = '<a class="btn" href="/support-admin">Open Student Support queue</a>';
    else if (['coordinator','regional-administrator'].includes(unit.id) && staff.role !== 'viewer') action = '<a class="btn" href="/centre-coordinators.html">Open assisted submission</a>';
    else if (unit.id === 'payroll' && staff.departments.length && staff.sections.includes('payroll')) action = `<a class="btn" href="/payroll/${encodeURIComponent(staff.departments[0])}">Open Payroll Portal</a>`;
    else if (unit.id === 'auditor' && staff.departments.length && staff.sections.includes('auditor')) action = `<a class="btn" href="/auditor/${encodeURIComponent(staff.departments[0])}">Open Auditor's Portal</a>`;
    return `<article class="staff-unit-card"><span class="service-tag">${esc(roleLabels[staff.role] || staff.role)}</span><h3>${esc(unit.label)}</h3><p>${esc(unit.summary)}</p>${action}</article>`;
  }
  function breakdown(items) {
    return items?.length ? `<ul class="dashboard-breakdown">${items.map(item => `<li><span>${esc(item.label)}</span><strong>${esc(item.count)}</strong></li>`).join('')}</ul>` : '<p class="admin-ticket-empty">No cases recorded.</p>';
  }
  function hours(value) { return value === null || value === undefined ? '—' : `${esc(value)}h`; }
  function dashboard(item) {
    const metrics = [['Total',item.total],['Open',item.open],['Resolved',item.resolved],['Overdue',item.overdue],['At risk',item.atRisk],['Awaiting evidence',item.awaitingEvidence],['SLA compliance',item.slaCompliancePercent === null ? '—' : `${item.slaCompliancePercent}%`],['Satisfaction',item.averageSatisfaction === null ? '—' : `${item.averageSatisfaction}/5`],['Feedback',item.feedbackResponses],['Low ratings',item.lowRatings],['Reopened',item.reopened],['Appealed',item.appealed],['First response',hours(item.averageFirstResponseHours)],['Resolution',hours(item.averageResolutionHours)]];
    return `<article class="dashboard-card"><h3>${esc(item.label)}</h3><div class="dashboard-metrics">${metrics.map(([label, value]) => `<span><strong>${value}</strong>${label}</span>`).join('')}</div><div class="dashboard-columns"><section><h4>By category</h4>${breakdown(item.categoryBreakdown)}</section><section><h4>By status</h4>${breakdown(item.statusBreakdown)}</section><section><h4>By study centre</h4>${breakdown(item.centreBreakdown)}</section></div></article>`;
  }
  function evidence(ticket, files, collection) {
    if (!files?.length) return '<p class="admin-ticket-empty">No files attached.</p>';
    return `<div class="evidence-list">${files.map((file, index) => {
      const name = esc(file.originalName || `Evidence ${index + 1}`);
      const path = `/api/staff/referrals/${encodeURIComponent(ticket.id)}/${collection}/${index}`;
      return `<section class="evidence-item"><strong>${name}</strong>${file.note ? `<small>${esc(file.note)}</small>` : ''}<iframe class="evidence-frame" src="${path}" title="Preview ${name}" loading="lazy"></iframe><div class="receipt-actions"><a class="btn secondary" href="${path}" target="_blank" rel="noopener">Open preview</a><a class="btn secondary" href="${path}?download=1">Download original</a></div></section>`;
    }).join('')}</div>`;
  }
  function history(ticket) {
    const items = ticket.referrals || [];
    return items.length ? `<ul class="case-history">${items.slice().reverse().map(item => `<li><strong>${esc(item.sourceLabel || item.sourceUnit)} → ${esc(item.targetLabel || item.targetUnit)}</strong><span>${esc(date(item.createdAt))} · ${esc(item.status || 'registered')}</span><p>${esc(item.comment || 'No routing comments recorded.')}</p></li>`).join('')}</ul>` : '<p class="admin-ticket-empty">No referral history is available.</p>';
  }
  function studentUpdates(ticket) {
    const items = ticket.studentUpdates || [];
    return items.length ? `<ul class="case-history">${items.slice(-10).reverse().map(item => `<li><strong>${esc(item.label)}</strong><span>${esc(date(item.at))}</span><p>${esc(item.message || '')}</p></li>`).join('')}</ul>` : '<p class="admin-ticket-empty">No student-facing progress updates.</p>';
  }
  function slaBadge(ticket) {
    const sla = ticket.sla || {};
    const tone = sla.overdue ? 'overdue' : sla.atRisk ? 'risk' : sla.paused ? 'paused' : 'on-track';
    const label = sla.overdue ? 'Overdue' : sla.atRisk ? 'At risk' : sla.paused ? 'SLA paused' : 'On track';
    return `<span class="sla-badge ${tone}">${label}</span>`;
  }
  function referralCard(ticket, staff) {
    const canEdit = staff.role !== 'viewer' && !['resolved','final-decision','closed','accepted'].includes(ticket.status);
    const monitoringOnly = staff.units.length > 0 && staff.units.every(unit => ['coordinator','regional-administrator','quality-assurance'].includes(unit.id));
    const actionOptions = monitoringOnly ? '<option value="internal-note">Internal monitoring note</option>' : '<option value="accept">Accept assignment</option><option value="progress">Investigation update</option><option value="request-evidence">Request evidence from student</option><option value="resolve">Propose resolution</option><option value="final-decision">Issue final decision</option><option value="return-to-support">Return to Student Support</option><option value="internal-note">Internal note only</option>';
    const sensitive = ticket.sensitive ? '<span class="confidential-badge">Restricted</span>' : '';
    return `<details class="admin-ticket staff-referral-card" data-id="${esc(ticket.id)}"><summary class="admin-ticket-summary"><span><span class="ticket-ref">${esc(ticket.reference)}</span><strong>${esc(ticket.subject)}</strong><small>${esc(ticket.name)} · ${esc(ticket.category)} · ${esc(ticket.ownerUnit)}</small></span><span class="ticket-summary-badges">${sensitive}${slaBadge(ticket)}<span class="ticket-priority">${esc(ticket.priority)}</span></span></summary><div class="ticket-body">
      <div class="admin-ticket-meta"><span><strong>Status</strong>${esc(ticket.statusLabel)}</span><span><strong>Student</strong>${esc(ticket.email)}</span><span><strong>Study centre</strong>${esc(ticket.studyCentre || 'Not stated')}</span><span><strong>Assigned officer</strong>${esc(ticket.assignedCaseOwner || 'Unassigned')}</span><span><strong>Resolution target</strong>${esc(date(ticket.dueAt))}</span></div>
      <p class="admin-ticket-description">${esc(ticket.description)}</p>
      <div class="ticket-two-column"><section class="evidence-panel"><h4>Student evidence</h4>${evidence(ticket, ticket.evidence, 'evidence')}</section><section class="evidence-panel"><h4>Officer evidence</h4>${evidence(ticket, ticket.officerEvidence, 'officer-evidence')}${canEdit ? `<form class="officer-evidence-form" enctype="multipart/form-data"><label>Files<input name="evidenceFiles" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.txt"></label><label>Evidence note<input name="note" placeholder="Source and relevance"></label><button class="btn secondary" type="submit">Attach</button></form>` : ''}</section></div>
      ${canEdit ? `<section class="case-update-panel"><h4>${monitoringOnly ? 'Monitoring note' : 'Receiving-unit action'}</h4><p>${monitoringOnly ? 'This role may attach centre evidence, add internal monitoring notes, and escalate through reassignment; it cannot issue operational decisions.' : 'Accept the assignment, record progress, request student evidence, issue a resolution, or return the case to Student Support.'}</p><div class="case-controls"><label>Action<select class="staff-action">${actionOptions}</select></label><label>Assigned officer<input class="staff-assignee" value="${esc(ticket.assignedCaseOwner || staff.name)}"></label><label class="wide">Case note<textarea class="staff-note" placeholder="Required. Explain the action, evidence needed, progress, or decision."></textarea></label><button class="btn staff-update" type="button">Record action</button></div></section>` : `<p class="staff-restricted">${staff.role === 'viewer' ? 'Your viewer role is read-only.' : 'This referral has reached a decision or closed state.'}</p>`}
      <div class="ticket-two-column"><section class="evidence-panel"><h4>Student-facing progress</h4>${studentUpdates(ticket)}</section><section class="evidence-panel"><h4>Referral and reassignment history</h4>${history(ticket)}</section></div>
      ${canEdit ? `<section class="forward-panel"><h4>Reassign this case</h4><p>The receiving unit gets the same reference, evidence, and history.</p><div class="forward-fields"><label>Receiving unit<select class="staff-reassign-unit">${unitOptions()}</select></label><label class="forward-comment">Reason<textarea class="staff-reassign-note"></textarea></label><button class="btn secondary staff-reassign" type="button">Reassign case</button></div></section>` : ''}
    </div></details>`;
  }
  function renderReferrals() {
    const search = document.getElementById('referralSearch').value.trim().toLowerCase();
    const visible = search ? referrals.filter(ticket => [ticket.reference,ticket.name,ticket.email,ticket.subject,ticket.category,ticket.studyCentre].some(value => String(value || '').toLowerCase().includes(search))) : referrals;
    const list = document.getElementById('referralList');
    list.innerHTML = visible.length ? visible.map(ticket => referralCard(ticket, currentStaff)).join('') : '<div class="resource-section">No referrals match this search.</div>';
    list.querySelectorAll('.staff-update').forEach(button => button.addEventListener('click', updateCase));
    list.querySelectorAll('.staff-reassign').forEach(button => button.addEventListener('click', reassign));
    list.querySelectorAll('.officer-evidence-form').forEach(form => form.addEventListener('submit', uploadEvidence));
  }
  async function load() {
    try {
      const [meResponse, referralResponse, dashboardResponse] = await Promise.all([fetch('/api/staff/me'), fetch('/api/staff/referrals'), fetch('/api/staff/dashboard')]);
      const meData = await meResponse.json().catch(() => ({}));
      const referralData = await referralResponse.json().catch(() => ({}));
      const dashboardData = await dashboardResponse.json().catch(() => ({}));
      if (!meResponse.ok || !referralResponse.ok || !dashboardResponse.ok) throw new Error(meData.error || referralData.error || dashboardData.error || 'Could not load the staff workspace.');
      currentStaff = meData.staff;
      referrals = referralData.referrals || [];
      document.getElementById('welcome').textContent = `Welcome, ${currentStaff.name}`;
      document.getElementById('accessSummary').textContent = `${roleLabels[currentStaff.role] || currentStaff.role}. ${currentStaff.units.length} assigned functional unit${currentStaff.units.length === 1 ? '' : 's'}.`;
      document.getElementById('staffMetrics').innerHTML = `<article class="staff-metric"><span>Shared referrals visible</span><strong>${referrals.length}</strong></article>${currentStaff.units.some(unit => unit.id === 'student-support') ? `<article class="staff-metric"><span>Open Student Support cases</span><strong>${esc(meData.metrics.openSupportTickets)}</strong></article>` : ''}`;
      const dashboards = dashboardData.dashboards || [];
      document.getElementById('leadershipDashboards').hidden = !dashboards.length;
      document.getElementById('dashboardList').innerHTML = dashboards.map(dashboard).join('');
      document.getElementById('unitCards').innerHTML = currentStaff.units.map(unit => unitCard(unit, currentStaff)).join('') || '<div class="resource-section">No functional-unit access is assigned.</div>';
      renderReferrals();
    } catch (error) { show(error.message, false); }
  }
  async function updateCase(event) {
    const article = event.currentTarget.closest('.staff-referral-card');
    const body = { action:article.querySelector('.staff-action').value, assignedCaseOwner:article.querySelector('.staff-assignee').value, note:article.querySelector('.staff-note').value };
    event.currentTarget.disabled = true;
    try {
      const response = await fetch(`/api/staff/referrals/${encodeURIComponent(article.dataset.id)}`, { method:'PATCH', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The case action could not be recorded.');
      show(`Updated ${data.ticket.reference}.`, true);
      await load();
    } catch (error) { show(error.message, false); event.currentTarget.disabled = false; }
  }
  async function uploadEvidence(event) {
    event.preventDefault();
    const article = event.currentTarget.closest('.staff-referral-card');
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch(`/api/staff/referrals/${encodeURIComponent(article.dataset.id)}/officer-evidence`, { method:'POST', body:new FormData(event.currentTarget) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Officer evidence could not be attached.');
      show('Officer evidence attached.', true);
      await load();
    } catch (error) { show(error.message, false); button.disabled = false; }
  }
  async function reassign(event) {
    const article = event.currentTarget.closest('.staff-referral-card');
    const body = { targetUnit:article.querySelector('.staff-reassign-unit').value, note:article.querySelector('.staff-reassign-note').value };
    event.currentTarget.disabled = true;
    try {
      const response = await fetch(`/api/staff/referrals/${encodeURIComponent(article.dataset.id)}/reassign`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The case could not be reassigned.');
      show(`Reassigned ${data.reference}.`, true);
      await load();
    } catch (error) { show(error.message, false); event.currentTarget.disabled = false; }
  }
  document.getElementById('referralSearch').addEventListener('input', renderReferrals);
  load();
})();
