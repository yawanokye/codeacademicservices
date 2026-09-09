(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]));
  const date = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' }) : 'Not available';
  const functionalUnits = { 'student-support':'Student Support Services Unit', 'confidential-handler':'Confidential Case Handler', 'general-office':'General Office', 'student-records':'Student Records Management Unit', 'college-registrar':'College Registrar', provost:'Provost', 'directorate-education-business':'Directorate of Education and Business Studies', 'directorate-arts-stem':'Directorate of Arts and STEM Studies', 'academic-departments':'Academic Departments', examinations:'Examinations Unit', payroll:'Payroll Portal', auditor:"Auditor's Portal", 'regional-administrator':'Regional Administrators', coordinator:'Centre Coordinators', 'quality-assurance':'Quality Assurance Unit', 'college-finance':'College Finance Officer', admissions:'Admissions Unit', stores:'Stores Unit' };
  const roleLabels = { viewer:'Viewer · read-only', officer:'Officer · operational actions', administrator:'Administrator · full assigned-unit control' };
  functionalUnits['registration-officer'] = 'Registration Officer Portal';
  let currentStaff = null;
  let referrals = [];
  let reportOptionsLoaded = false;

  function requireAuthentication(response) {
    if (response.status !== 401) return;
    const next = `${location.pathname}${location.search}`;
    location.href = `/staff-login.html?next=${encodeURIComponent(next)}`;
    throw new Error('Your staff session has expired. Redirecting to sign in.');
  }
  function showDeveloperPreviewBanner(staff) {
    const banner = document.getElementById('developerPreviewBanner');
    if (!banner) return;
    if (!staff?.developerPreview) { banner.hidden = true; banner.innerHTML = ''; return; }
    const label = staff.developerPreviewLabel || staff.name || 'functional-unit user';
    const expiry = staff.previewExpiresAt ? ` Preview expires ${date(staff.previewExpiresAt)}.` : '';
    banner.hidden = false;
    banner.innerHTML = `<div><strong>Developer Preview Mode</strong><span>Viewing as ${esc(label)}.${esc(expiry)}</span></div><div class="developer-preview-actions"><a href="/developer#staff-preview">Return to Developer Portal</a><button type="button" id="exitDeveloperPreview">Exit preview</button></div>`;
    banner.querySelector('#exitDeveloperPreview').addEventListener('click', async () => {
      await fetch('/api/admin-logout', { method:'POST' }).catch(() => {});
      location.href = '/developer#staff-preview';
    });
  }

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
    const metrics = [['Total',item.total],['Open',item.open],['Resolved',item.resolved],['Overdue',item.overdue],['At risk',item.atRisk],['Awaiting evidence',item.awaitingEvidence],['SLA compliance',item.slaCompliancePercent === null ? '—' : `${item.slaCompliancePercent}%`],['Satisfaction',item.averageSatisfaction === null ? '—' : `${item.averageSatisfaction}/5`],['Ease',item.averageEaseOfUse === null ? '—' : `${item.averageEaseOfUse}/5`],['Communication',item.averageCommunication === null ? '—' : `${item.averageCommunication}/5`],['Timeliness',item.averageTimeliness === null ? '—' : `${item.averageTimeliness}/5`],['Courtesy',item.averageStaffCourtesy === null ? '—' : `${item.averageStaffCourtesy}/5`],['Feedback',item.feedbackResponses],['Low ratings',item.lowRatings],['Reopened',item.reopened],['Appealed',item.appealed],['First response',hours(item.averageFirstResponseHours)],['Resolution',hours(item.averageResolutionHours)]];
    return `<article class="dashboard-card"><h3>${esc(item.label)}</h3><div class="dashboard-metrics">${metrics.map(([label, value]) => `<span><strong>${value}</strong>${label}</span>`).join('')}</div><div class="dashboard-columns"><section><h4>By category</h4>${breakdown(item.categoryBreakdown)}</section><section><h4>By status</h4>${breakdown(item.statusBreakdown)}</section><section><h4>By study centre</h4>${breakdown(item.centreBreakdown)}</section></div></article>`;
  }
  function statusClass(status) { return `status-${String(status || 'unknown').replace(/[^a-z0-9-]/g, '')}`; }
  function renderMonitoringStatistics(data) {
    const overview = data.overview || {};
    const headline = [['Total cases',overview.total ?? 0,'total'],['Complaints',overview.complaints ?? 0,'complaint'],['Service requests',overview.requests ?? 0,'request'],['Open',overview.open ?? 0,'open'],['Overdue',overview.overdue ?? 0,'overdue'],['Resolved or closed',overview.resolved ?? 0,'resolved']];
    document.getElementById('monitoringOverview').innerHTML = headline.map(([label,value,tone]) => `<article class="monitoring-stat ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join('');
    const statuses = data.statusStatistics || [];
    document.getElementById('statusStatistics').innerHTML = `<div class="monitoring-subhead"><h3>Cases by status</h3><p>Every workflow status is shown, including statuses with no current cases.</p></div><div class="status-stat-grid">${statuses.map(item => `<article class="status-stat ${statusClass(item.id)}"><span>${esc(item.label)}</span><strong>${esc(item.count)}</strong></article>`).join('')}</div>`;
    const units = data.unitStatistics || [];
    const statusHeaders = statuses.map(item => `<th class="${statusClass(item.id)}">${esc(item.label)}</th>`).join('');
    const rows = units.map(unit => `<tr><th scope="row">${esc(unit.label)}</th><td class="type-complaint">${esc(unit.complaints)}</td><td class="type-request">${esc(unit.requests)}</td><td><strong>${esc(unit.total)}</strong></td>${statuses.map(status => `<td class="status-count ${statusClass(status.id)}">${esc(unit.statusCounts?.[status.id] ?? 0)}</td>`).join('')}</tr>`).join('');
    document.getElementById('unitStatistics').innerHTML = `<div class="monitoring-subhead"><h3>Complaints and requests by functional unit</h3><p>Scroll horizontally to review every status for every unit in your permitted monitoring scope.</p></div><div class="unit-status-table-wrap"><table class="unit-status-table"><thead><tr><th>Functional unit</th><th class="type-complaint">Complaints</th><th class="type-request">Requests</th><th>Total</th>${statusHeaders}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
  function assignmentBadge(assignment) {
    const item = assignment || { colour:'red', label:'Not assigned to staff' };
    return `<span class="assignment-badge assignment-${esc(item.colour || 'red')}">${esc(item.label || 'Not assigned to staff')}</span>`;
  }
  function assignmentHistory(ticket) {
    if (!ticket.assignments?.length) return '<p class="admin-ticket-empty">No staff assignment has been created.</p>';
    return `<ul class="assignment-history">${ticket.assignments.slice().reverse().map(item => `<li>${assignmentBadge(item.state)}<span><strong>${esc(item.unitLabel)}</strong> · ${esc(item.officerName || item.officerEmail)}</span><small>Assigned ${esc(date(item.assignedAt))}${item.openedAt ? ` · Opened ${esc(date(item.openedAt))}` : ''}${item.resolvedAt ? ` · Resolved ${esc(date(item.resolvedAt))}` : ''}</small></li>`).join('')}</ul>`;
  }
  function referralCard(ticket, staff) {
    const canEdit = staff.role !== 'viewer' && ticket.activeUnitIds?.length > 0 && !['resolved','final-decision','closed','accepted'].includes(ticket.status);
    const canAssign = staff.role === 'administrator' && canEdit;
    const monitoringOnly = staff.units.length > 0 && staff.units.every(unit => ['coordinator','regional-administrator','quality-assurance'].includes(unit.id));
    const actionOptions = monitoringOnly ? '<option value="internal-note">Internal monitoring note</option>' : '<option value="accept">Accept assignment</option><option value="progress">Investigation update</option><option value="request-evidence">Request evidence from student</option><option value="resolve">Propose resolution</option><option value="final-decision">Issue final decision</option><option value="return-to-support">Return to Student Support</option><option value="internal-note">Internal note only</option>';
    const sensitive = ticket.sensitive ? '<span class="confidential-badge">Restricted</span>' : '';
    const activeUnits = staff.units.filter(unit => ticket.activeUnitIds?.includes(unit.id));
    const preferredUnit = activeUnits.some(unit => unit.id === ticket.assignment?.unitId) ? ticket.assignment.unitId : (activeUnits[0]?.id || '');
    const assignmentUnits = activeUnits.map(unit => `<option value="${esc(unit.id)}" ${unit.id === preferredUnit ? 'selected' : ''}>${esc(unit.label)}</option>`).join('');
    return `<details class="admin-ticket staff-referral-card" data-id="${esc(ticket.id)}"><summary class="admin-ticket-summary"><span><span class="ticket-ref">${esc(ticket.reference)}</span><strong>${esc(ticket.subject)}</strong><small>${esc(ticket.name)} · ${esc(ticket.category)} · ${esc(ticket.ownerUnit)}</small></span><span class="ticket-summary-badges">${assignmentBadge(ticket.assignment)}${sensitive}${slaBadge(ticket)}<span class="ticket-priority">${esc(ticket.priority)}</span></span></summary><div class="ticket-body">
      <div class="admin-ticket-meta"><span><strong>Status</strong>${esc(ticket.statusLabel)}</span><span><strong>Student</strong>${esc(ticket.email)}</span><span><strong>Study centre</strong>${esc(ticket.studyCentre || 'Not stated')}</span><span><strong>Staff assignment</strong>${assignmentBadge(ticket.assignment)}</span><span><strong>Assigned officer</strong>${esc(ticket.assignment?.officerName || ticket.assignedCaseOwner || 'Unassigned')}</span><span><strong>Resolution target</strong>${esc(date(ticket.dueAt))}</span><span><strong>Survey</strong>${ticket.feedback?`${esc(ticket.feedback.rating)}/5 overall`:'Not submitted'}</span><span><strong>Assistance language</strong>${esc(({en:'English',tw:'Twi',fr:'French'})[ticket.language]||'English')}</span><span><strong>Notifications</strong>${esc(({'email':'Email only','email-sms':'Email and SMS','email-whatsapp':'Email and WhatsApp'})[ticket.notificationPreference]||'Email only')}</span></div>
      <p class="admin-ticket-description">${esc(ticket.description)}</p>
      <section class="staff-assignment-panel"><div><h4>Staff email assignment</h4><p>Red means not opened. Yellow means the staff member opened the secure link. Green means all resolution checks were completed.</p></div>${canAssign ? `<form class="staff-assignment-form"><label>Functional unit<select name="unitId" required>${assignmentUnits}</select></label><label>Staff name<input name="officerName" placeholder="Staff member's name"></label><label>Institutional email<input name="officerEmail" type="email" placeholder="name@ucc.edu.gh" required></label><button class="btn" type="submit">Assign and send link</button></form><div class="assignment-result" aria-live="polite"></div>` : '<p class="staff-restricted">Only an administrator for the functional unit may assign a staff member.</p>'}${assignmentHistory(ticket)}</section>
      <div class="ticket-two-column"><section class="evidence-panel"><h4>Student evidence</h4>${evidence(ticket, ticket.evidence, 'evidence')}</section><section class="evidence-panel"><h4>Officer evidence</h4>${evidence(ticket, ticket.officerEvidence, 'officer-evidence')}${canEdit ? `<form class="officer-evidence-form" enctype="multipart/form-data"><label>Files<input name="evidenceFiles" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.txt"></label><label>Evidence note<input name="note" placeholder="Source and relevance"></label><button class="btn secondary" type="submit">Attach</button></form>` : ''}</section></div>
      ${canEdit ? `<section class="case-update-panel"><h4>${monitoringOnly ? 'Monitoring note' : 'Receiving-unit action'}</h4><p>${monitoringOnly ? 'This role may attach centre evidence, add internal monitoring notes, and escalate through reassignment; it cannot issue operational decisions.' : 'Accept the assignment, record progress, request student evidence, issue a resolution, or return the case to Student Support.'}</p><div class="case-controls"><label>Action<select class="staff-action">${actionOptions}</select></label><label class="wide">Case note<textarea class="staff-note" placeholder="Required. Explain the action, evidence needed, progress, or decision."></textarea></label><button class="btn staff-update" type="button">Record action</button></div></section>` : `<p class="staff-restricted">${staff.role === 'viewer' ? 'Your viewer role is read-only.' : 'This referral is historical or has reached a decision or closed state.'}</p>`}
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
    list.querySelectorAll('.staff-assignment-form').forEach(form => form.addEventListener('submit', assignStaff));
  }
  function reportQueryString() {
    const parameters = new URLSearchParams();
    const form = document.getElementById('reportFilters');
    new FormData(form).forEach((value, key) => { if (String(value).trim()) parameters.set(key, String(value).trim()); });
    return parameters.toString();
  }
  function optionMarkup(items, selected='') { return (items || []).map(item => `<option value="${esc(item.id ?? item)}" ${String(item.id ?? item) === selected ? 'selected' : ''}>${esc(item.label ?? item)}</option>`).join(''); }
  function performanceTable(rows) {
    if (!rows?.length) return '<p class="admin-ticket-empty">No cases match the selected period and filters.</p>';
    return `<div class="performance-table-wrap"><table class="performance-table"><thead><tr><th>Area</th><th>Total</th><th>Open</th><th>Resolved</th><th>Overdue</th><th>SLA</th><th>Rating</th><th>Resolution</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.label)}</td><td>${esc(row.total)}</td><td>${esc(row.open)}</td><td>${esc(row.resolved)}</td><td>${esc(row.overdue)}</td><td>${row.slaCompliance===null?'—':`${esc(row.slaCompliance)}%`}</td><td>${row.satisfaction===null?'—':`${esc(row.satisfaction)}/5`}</td><td>${row.averageResolutionHours===null?'—':`${esc(row.averageResolutionHours)}h`}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderPerformance(data) {
    const item=data.summary || {};
    const metrics=[['Cases',item.total??0],['Complaints',item.complaints??0],['Requests',item.requests??0],['Open',item.open??0],['Resolved',item.resolved??0],['Overdue',item.overdue??0],['SLA compliance',item.slaCompliance===null?'—':`${item.slaCompliance}%`],['Survey response',item.feedbackRate===null?'—':`${item.feedbackRate}%`],['Satisfaction',item.satisfaction===null?'—':`${item.satisfaction}/5`]];
    document.getElementById('performanceSummary').innerHTML=metrics.map(([label,value])=>`<span><strong>${esc(value)}</strong>${esc(label)}</span>`).join('');
    document.getElementById('centrePerformance').innerHTML=performanceTable(data.byCentre);
    document.getElementById('unitPerformance').innerHTML=performanceTable(data.byUnit);
  }
  async function loadReport() {
    const query=reportQueryString();
    const suffix=query?`?${query}`:'';
    const [dashboardResponse,performanceResponse]=await Promise.all([fetch(`/api/staff/dashboard${suffix}`),fetch(`/api/staff/support-performance${suffix}`)]);
    requireAuthentication(dashboardResponse); requireAuthentication(performanceResponse);
    const dashboardData=await dashboardResponse.json().catch(()=>({}));
    const performanceData=await performanceResponse.json().catch(()=>({}));
    if(!dashboardResponse.ok||!performanceResponse.ok) throw new Error(dashboardData.error||performanceData.error||'Could not load the service report.');
    const dashboards=dashboardData.dashboards||[];
    document.getElementById('leadershipDashboards').hidden=!dashboards.length && !(dashboardData.unitStatistics||[]).length;
    renderMonitoringStatistics(dashboardData);
    document.getElementById('dashboardList').innerHTML=dashboards.map(dashboard).join('');
    renderPerformance(performanceData);
  }
  async function load() {
    try {
      const [meResponse, referralResponse, optionsResponse] = await Promise.all([fetch('/api/staff/me'), fetch('/api/staff/referrals'), fetch('/api/staff/support-report-options')]);
      requireAuthentication(meResponse); requireAuthentication(referralResponse); requireAuthentication(optionsResponse);
      const meData = await meResponse.json().catch(() => ({}));
      const referralData = await referralResponse.json().catch(() => ({}));
      const optionsData = await optionsResponse.json().catch(() => ({}));
      if (!meResponse.ok || !referralResponse.ok || !optionsResponse.ok) throw new Error(meData.error || referralData.error || optionsData.error || 'Could not load the staff workspace.');
      currentStaff = meData.staff;
      showDeveloperPreviewBanner(currentStaff);
      referrals = referralData.referrals || [];
      document.getElementById('welcome').textContent = `Welcome, ${currentStaff.name}`;
      document.getElementById('accessSummary').textContent = `${roleLabels[currentStaff.role] || currentStaff.role}. ${currentStaff.units.length} assigned functional unit${currentStaff.units.length === 1 ? '' : 's'}.`;
      document.getElementById('staffMetrics').innerHTML = `<article class="staff-metric"><span>Shared referrals visible</span><strong>${referrals.length}</strong></article>${currentStaff.units.some(unit => unit.id === 'student-support') ? `<article class="staff-metric"><span>Open Student Support cases</span><strong>${esc(meData.metrics.openSupportTickets)}</strong></article>` : ''}`;
      if (!reportOptionsLoaded) {
        document.getElementById('reportCentre').insertAdjacentHTML('beforeend',optionMarkup(optionsData.centres));
        document.getElementById('reportUnit').insertAdjacentHTML('beforeend',optionMarkup(optionsData.units));
        document.getElementById('reportStatus').insertAdjacentHTML('beforeend',optionMarkup(optionsData.statuses));
        document.getElementById('reportCategory').insertAdjacentHTML('beforeend',optionMarkup(optionsData.categories));
        reportOptionsLoaded=true;
      }
      document.getElementById('unitCards').innerHTML = currentStaff.units.map(unit => unitCard(unit, currentStaff)).join('') || '<div class="resource-section">No functional-unit access is assigned.</div>';
      renderReferrals();
      await loadReport();
    } catch (error) { show(error.message, false); }
  }
  async function updateCase(event) {
    const article = event.currentTarget.closest('.staff-referral-card');
    const body = { action:article.querySelector('.staff-action').value, note:article.querySelector('.staff-note').value };
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
  async function assignStaff(event) {
    event.preventDefault();
    const article = event.currentTarget.closest('.staff-referral-card');
    const button = event.currentTarget.querySelector('button');
    const result = article.querySelector('.assignment-result');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget));
      const response = await fetch(`/api/staff/referrals/${encodeURIComponent(article.dataset.id)}/staff-assignments`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The staff assignment could not be created.');
      result.innerHTML = `<p class="assignment-link-result">${esc(data.message)} <a href="${esc(data.secureUrl)}" target="_blank" rel="noopener">Open or copy secure link</a></p>`;
      show(`Assigned ${data.reference} to ${body.officerEmail}.`, true);
      button.disabled = false;
    } catch (error) { result.textContent = error.message; show(error.message, false); button.disabled = false; }
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
  document.getElementById('reportFilters').addEventListener('submit', async event => { event.preventDefault(); try { await loadReport(); show('Report filters applied.',true); } catch(error) { show(error.message,false); } });
  document.getElementById('clearReportFilters').addEventListener('click', async () => { document.getElementById('reportFilters').reset(); try { await loadReport(); } catch(error) { show(error.message,false); } });
  document.getElementById('downloadRegisterExcel').addEventListener('click',()=>{ const query=reportQueryString(); window.location.href=`/api/staff/support-register.xlsx${query?`?${query}`:''}`; });
  document.getElementById('downloadRegisterCsv').addEventListener('click',()=>{ const query=reportQueryString(); window.location.href=`/api/staff/support-register.csv${query?`?${query}`:''}`; });
  document.getElementById('downloadPerformance').addEventListener('click',()=>{ const query=reportQueryString(); window.location.href=`/api/staff/support-performance.xlsx${query?`?${query}`:''}`; });
  load();
})();
