(function () {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]));
  const date = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' }) : 'Not available';
  const statusLabels = { received:'Received', triaged:'Triaged', assigned:'Assigned', 'evidence-requested':'Additional evidence requested', 'lacks-evidence':'Additional evidence needed', 'investigation-ongoing':'Investigation ongoing', 'in-progress':'In progress', 'awaiting-student':'Awaiting student', resolved:'Resolved', reopened:'Reopened', appealed:'Appealed', 'final-decision':'Final decision issued', closed:'Closed' };
  const statusKeys = ['received','triaged','assigned','evidence-requested','lacks-evidence','investigation-ongoing','in-progress','awaiting-student','resolved','reopened','appealed','final-decision','closed'];
  const updateTemplates = {
    evidence: { status:'evidence-requested', text:'Please provide the missing supporting record so the responsible unit can continue its review. Use the ticket tracking page to upload the file and add any necessary explanation.' },
    investigation: { status:'investigation-ongoing', text:'The responsible unit is verifying the records connected to this matter. We will post the outcome or request further information through this ticket.' },
    delay: { status:'in-progress', text:'We apologise that this matter is taking longer than expected. The case has been escalated for follow-up and remains active under the same reference.' },
    resolution: { status:'resolved', text:'The responsible unit has completed its review. Please review the resolution recorded below and use the ticket controls to accept it, reopen the matter during the response period, or appeal.' }
  };
  let configuration = { units:[], categories:[] };
  let identity = { role:'viewer', confidentialAccess:false };
  let page = 1;
  let pages = 1;

  function requireAuthentication(response) {
    if (response.status !== 401) return;
    const next = `${location.pathname}${location.search}`;
    location.href = `/staff-login.html?next=${encodeURIComponent(next)}`;
    throw new Error('Your staff session has expired. Redirecting to sign in.');
  }
  function showDeveloperPreviewBanner(currentIdentity) {
    const banner = $('#developerPreviewBanner');
    if (!banner) return;
    if (!currentIdentity?.developerPreview) { banner.hidden = true; banner.innerHTML = ''; return; }
    const label = currentIdentity.developerPreviewLabel || currentIdentity.name || 'Student Support officer';
    const expiry = currentIdentity.previewExpiresAt ? ` Preview expires ${date(currentIdentity.previewExpiresAt)}.` : '';
    banner.hidden = false;
    banner.innerHTML = `<div><strong>Developer Preview Mode</strong><span>Viewing as ${esc(label)}.${esc(expiry)}</span></div><div class="developer-preview-actions"><a href="/developer#staff-preview">Return to Developer Portal</a><button type="button" id="exitDeveloperPreview">Exit preview</button></div>`;
    banner.querySelector('#exitDeveloperPreview').addEventListener('click', async () => {
      await fetch('/api/admin-logout', { method:'POST' }).catch(() => {});
      location.href = '/developer#staff-preview';
    });
  }

  function show(text, ok) {
    const element = $('#adminMessage');
    element.textContent = text;
    element.className = `status show ${ok ? 'ok' : 'bad'}`;
    element.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  function selectOptions(items, selected, blankLabel) {
    return `<option value="">${esc(blankLabel)}</option>${items.map(item => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}`;
  }
  function slaBadge(ticket) {
    const sla = ticket.sla || {};
    const tone = sla.overdue ? 'overdue' : sla.atRisk ? 'risk' : sla.paused ? 'paused' : 'on-track';
    const label = sla.overdue ? 'Overdue' : sla.atRisk ? 'At risk' : sla.paused ? 'SLA paused' : 'On track';
    return `<span class="sla-badge ${tone}">${label}</span>`;
  }
  function evidence(ticket, files, collection) {
    if (!files?.length) return '<p class="admin-ticket-empty">No files attached.</p>';
    return `<div class="evidence-list">${files.map((file, index) => {
      const name = esc(file.originalName || `Evidence ${index + 1}`);
      const path = `/api/support/admin/tickets/${encodeURIComponent(ticket.id)}/${collection}/${index}`;
      return `<section class="evidence-item"><strong>${name}</strong>${file.note ? `<small>${esc(file.note)}</small>` : ''}<iframe class="evidence-frame" src="${path}" title="Preview ${name}" loading="lazy"></iframe><div class="receipt-actions"><a class="btn secondary" href="${path}" target="_blank" rel="noopener">Open preview</a><a class="btn secondary" href="${path}?download=1">Download original</a></div></section>`;
    }).join('')}</div>`;
  }
  function history(items, emptyText, audit) {
    if (!items?.length) return `<p class="admin-ticket-empty">${esc(emptyText)}</p>`;
    return `<ul class="case-history">${items.slice(-12).reverse().map(item => `<li><strong>${esc(audit ? item.action : item.label)}</strong><span>${esc(date(item.at))}${item.by ? ` · ${esc(item.by)}` : ''}</span>${item.message || item.note ? `<p>${esc(item.message || item.note)}</p>` : ''}</li>`).join('')}</ul>`;
  }
  function referralHistory(ticket) {
    if (!ticket.referrals?.length) return '<p class="admin-ticket-empty">No referral has been registered.</p>';
    return `<ul class="case-history">${ticket.referrals.slice().reverse().map(item => `<li><strong>${esc(item.sourceLabel || item.sourceUnit)} → ${esc(item.targetLabel || item.targetUnit)}</strong><span>${esc(date(item.createdAt))} · ${esc(item.status || 'registered')}</span><p>${esc(item.comment || 'No routing comment.')}</p></li>`).join('')}</ul>`;
  }
  function ticketCard(ticket) {
    const canEdit = identity.role !== 'viewer';
    const categories = selectOptions(configuration.categories, ticket.categoryKey, 'Keep current category');
    const units = selectOptions(configuration.units, ticket.ownerUnitId, 'Keep current unit');
    const routingUnits = selectOptions(configuration.units, '', 'Select functional unit');
    const statuses = statusKeys.map(key => `<option value="${key}" ${key === ticket.status ? 'selected' : ''}>${esc(statusLabels[key])}</option>`).join('');
    return `<details class="admin-ticket" data-id="${esc(ticket.id)}">
      <summary class="admin-ticket-summary"><span><span class="ticket-ref">${esc(ticket.reference)}</span><strong>${esc(ticket.subject)}</strong><small>${esc(ticket.name)} · ${esc(ticket.category)} · ${esc(ticket.ownerUnit)}</small></span><span class="ticket-summary-badges">${ticket.sensitive ? '<span class="confidential-badge">Restricted</span>' : ''}${slaBadge(ticket)}<span class="ticket-priority">${esc(ticket.priority)}</span></span></summary>
      <div class="ticket-body">
        <div class="admin-ticket-meta"><span><strong>Status</strong>${esc(ticket.statusLabel)}</span><span><strong>Student</strong>${esc(ticket.email)}</span><span><strong>Study centre</strong>${esc(ticket.studyCentre || 'Not stated')}</span><span><strong>Programme</strong>${esc(ticket.programme || 'Not stated')}</span><span><strong>Resolution target</strong>${esc(date(ticket.dueAt))}</span><span><strong>Assigned officer</strong>${esc(ticket.assignedCaseOwner || 'Unassigned')}</span><span><strong>Student feedback</strong>${ticket.feedback ? `${esc(ticket.feedback.rating)}/5 · ${esc(ticket.feedback.resolved)}` : 'Not submitted'}</span><span><strong>Assistance language</strong>${esc(({en:'English',tw:'Twi',fr:'French'})[ticket.language] || ticket.language || 'English')}</span><span><strong>Notifications</strong>${esc(ticket.notificationPreference || 'email')}</span></div>
        <p class="admin-ticket-description">${esc(ticket.description)}</p>
        ${ticket.feedback ? `<section class="feedback-detail"><h4>Student satisfaction survey</h4><div class="feedback-score-grid"><span><strong>${esc(ticket.feedback.rating)}/5</strong>Overall</span><span><strong>${esc(ticket.feedback.easeOfUse ?? '—')}/5</strong>Ease</span><span><strong>${esc(ticket.feedback.communication ?? '—')}/5</strong>Communication</span><span><strong>${esc(ticket.feedback.timeliness ?? '—')}/5</strong>Timeliness</span><span><strong>${esc(ticket.feedback.staffCourtesy ?? '—')}/5</strong>Courtesy</span></div><p><strong>Resolved:</strong> ${esc(ticket.feedback.resolved)} · <strong>Notifications helpful:</strong> ${esc(ticket.feedback.notificationHelpful || 'not recorded')} · <strong>Language assistance:</strong> ${esc(ticket.feedback.languageHelp || 'not recorded')}</p><p>${esc(ticket.feedback.comment || 'No additional comment.')}</p><small>${esc(date(ticket.feedback.submittedAt))}</small></section>` : ''}
        <div class="ticket-two-column"><section class="evidence-panel"><h4>Student evidence</h4>${evidence(ticket, ticket.evidence, 'evidence')}</section><section class="evidence-panel"><h4>Officer evidence</h4>${evidence(ticket, ticket.officerEvidence, 'officer-evidence')}${canEdit ? `<form class="officer-evidence-form" enctype="multipart/form-data"><label>Files<input name="evidenceFiles" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.txt"></label><label>Evidence note<input name="note" placeholder="Source and relevance"></label><button class="btn secondary" type="submit">Attach</button></form>` : ''}</section></div>
        ${canEdit ? `<section class="case-update-panel"><h4>Classify, assign and update</h4><p>Every operational update is recorded in the audit trail. Student-facing notes appear in tracking and email when delivery is configured.</p><div class="case-controls"><label>Category<select class="ticket-category">${categories}</select></label><label>Priority<select class="ticket-priority-key"><option value="low" ${ticket.priorityKey === 'low' ? 'selected' : ''}>Low</option><option value="normal" ${ticket.priorityKey === 'normal' ? 'selected' : ''}>Normal</option><option value="high" ${ticket.priorityKey === 'high' ? 'selected' : ''}>High</option><option value="urgent" ${ticket.priorityKey === 'urgent' ? 'selected' : ''}>Urgent</option></select></label><label>Responsible unit<select class="ticket-owner-unit">${units}</select></label><label>Assigned officer<input class="ticket-assignee" value="${esc(ticket.assignedCaseOwner)}" placeholder="Officer name"></label><label>Case status<select class="ticket-status">${statuses}</select></label><label>Response template<select class="update-template"><option value="">Write a custom update</option><option value="evidence">Request missing evidence</option><option value="investigation">Investigation underway</option><option value="delay">Delay and escalation notice</option><option value="resolution">Resolution ready</option></select></label><label class="wide">Student-facing update<textarea class="ticket-note" placeholder="Required for evidence requests, investigation updates and decisions"></textarea></label><button class="btn save-ticket" type="button">Save and notify</button></div></section>` : '<p class="staff-restricted">Your viewer role is read-only.</p>'}
        <div class="ticket-two-column"><section class="evidence-panel"><h4>Student-facing progress</h4>${history(ticket.studentUpdates, 'No student-facing updates yet.', false)}</section><section class="evidence-panel"><h4>Audit trail</h4>${history(ticket.auditTrail, 'No audit entries yet.', true)}</section></div>
        ${canEdit ? `<section class="routing-grid"><div class="forward-panel"><h4>Request information</h4><p>Uses the selected unit's active institutional officer accounts.</p><label>Functional unit<select class="message-unit">${routingUnits}</select></label><label>Information required<textarea class="message-text"></textarea></label><button class="btn secondary message-unit-button" type="button">Send request</button></div><div class="forward-panel"><h4>Register and forward</h4><p>Creates the receiving unit's shared case record even when email is unavailable.</p><label>Receiving unit<select class="forward-unit">${routingUnits}</select></label><label>Routing instructions<textarea class="forward-note"></textarea></label><button class="btn forward-ticket" type="button">Forward case</button></div><div class="forward-panel"><h4>Reassign case</h4><p>Preserves the permanent reference and the full handover history.</p><label>Next unit<select class="reassign-unit">${routingUnits}</select></label><label>Reason for reassignment<textarea class="reassign-note"></textarea></label><button class="btn secondary reassign-ticket" type="button">Reassign</button></div></section>` : ''}
        <section class="evidence-panel"><h4>Referral history</h4>${referralHistory(ticket)}</section>
      </div>
    </details>`;
  }
  function bindTicketActions() {
    document.querySelectorAll('.save-ticket').forEach(button => button.addEventListener('click', saveTicket));
    document.querySelectorAll('.officer-evidence-form').forEach(form => form.addEventListener('submit', uploadEvidence));
    document.querySelectorAll('.message-unit-button').forEach(button => button.addEventListener('click', sendUnitMessage));
    document.querySelectorAll('.forward-ticket').forEach(button => button.addEventListener('click', forwardTicket));
    document.querySelectorAll('.reassign-ticket').forEach(button => button.addEventListener('click', reassignTicket));
    document.querySelectorAll('.update-template').forEach(select => select.addEventListener('change', applyUpdateTemplate));
  }
  function applyUpdateTemplate(event) {
    const template = updateTemplates[event.currentTarget.value];
    if (!template) return;
    const article = event.currentTarget.closest('.admin-ticket');
    article.querySelector('.ticket-status').value = template.status;
    article.querySelector('.ticket-note').value = template.text;
  }
  async function request(article, suffix, options, success) {
    const response = await fetch(`/api/support/admin/tickets/${encodeURIComponent(article.dataset.id)}${suffix}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The action could not be completed.');
    show(success(data), true);
    await load();
  }
  async function saveTicket(event) {
    const article = event.currentTarget.closest('.admin-ticket');
    event.currentTarget.disabled = true;
    const body = { categoryKey:article.querySelector('.ticket-category').value, priorityKey:article.querySelector('.ticket-priority-key').value, ownerUnitId:article.querySelector('.ticket-owner-unit').value, assignedCaseOwner:article.querySelector('.ticket-assignee').value, status:article.querySelector('.ticket-status').value, note:article.querySelector('.ticket-note').value };
    try { await request(article, '', { method:'PATCH', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }, data => `Updated ${data.ticket.reference}.`); } catch (error) { show(error.message, false); event.currentTarget.disabled = false; }
  }
  async function uploadEvidence(event) {
    event.preventDefault();
    const article = event.currentTarget.closest('.admin-ticket');
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try { await request(article, '/officer-evidence', { method:'POST', body:new FormData(event.currentTarget) }, () => 'Officer evidence attached.'); } catch (error) { show(error.message, false); button.disabled = false; }
  }
  async function sendUnitMessage(event) {
    const article = event.currentTarget.closest('.admin-ticket');
    const body = { targetUnit:article.querySelector('.message-unit').value, message:article.querySelector('.message-text').value };
    event.currentTarget.disabled = true;
    try { await request(article, '/messages', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }, data => `Information request recorded for ${data.reference}.`); } catch (error) { show(error.message, false); event.currentTarget.disabled = false; }
  }
  async function forwardTicket(event) {
    const article = event.currentTarget.closest('.admin-ticket');
    const body = { recipientUnit:article.querySelector('.forward-unit').value, comment:article.querySelector('.forward-note').value };
    event.currentTarget.disabled = true;
    try { await request(article, '/forward', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }, data => data.message || `Registered ${data.reference} with the receiving unit.`); } catch (error) { show(error.message, false); event.currentTarget.disabled = false; }
  }
  async function reassignTicket(event) {
    const article = event.currentTarget.closest('.admin-ticket');
    const body = { targetUnit:article.querySelector('.reassign-unit').value, note:article.querySelector('.reassign-note').value };
    event.currentTarget.disabled = true;
    try { await request(article, '/reassign', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) }, data => `Reassigned ${data.reference}.`); } catch (error) { show(error.message, false); event.currentTarget.disabled = false; }
  }
  function queryString() {
    const parameters = new URLSearchParams({ page:String(page), pageSize:'25' });
    [['search','#filterSearch'],['status','#filterStatus'],['category','#filterCategory'],['priority','#filterPriority'],['confidentiality','#filterConfidentiality']].forEach(([name, selector]) => { const value = $(selector).value.trim(); if (value) parameters.set(name, value); });
    return parameters.toString();
  }
  async function load() {
    $('#ticketList').innerHTML = '<div class="resource-section">Loading support queue…</div>';
    try {
      const response = await fetch(`/api/support/admin/tickets?${queryString()}`);
      requireAuthentication(response);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The support queue could not be loaded.');
      pages = data.pages || 1;
      page = Math.min(data.page || 1, pages);
      $('#queueSummary').textContent = `${data.total} matching case${data.total === 1 ? '' : 's'} · ${data.permissionTotal} visible to you`;
      $('#pageSummary').textContent = `Page ${page} of ${pages}`;
      $('#previousPage').disabled = page <= 1;
      $('#nextPage').disabled = page >= pages;
      $('#ticketList').innerHTML = data.tickets?.length ? data.tickets.map(ticketCard).join('') : '<div class="resource-section">No cases match these filters.</div>';
      bindTicketActions();
    } catch (error) { $('#ticketList').innerHTML = ''; show(error.message, false); }
  }
  async function initialise() {
    try {
      const [configResponse, identityResponse] = await Promise.all([fetch('/api/support/config'), fetch('/api/support/admin/me')]);
      requireAuthentication(identityResponse);
      const configData = await configResponse.json();
      const identityData = await identityResponse.json();
      if (!configResponse.ok || !identityResponse.ok) throw new Error(identityData.error || configData.error || 'The workspace could not be initialised.');
      configuration = configData;
      identity = identityData.identity;
      showDeveloperPreviewBanner(identity);
      $('#accessSummary').textContent = `${identity.name} · ${identity.role === 'viewer' ? 'read-only monitoring' : 'operational case management'}${identity.confidentialAccess ? ' · restricted-case access' : ''}.`;
      $('#filterStatus').insertAdjacentHTML('beforeend', statusKeys.map(key => `<option value="${key}">${esc(statusLabels[key])}</option>`).join(''));
      $('#filterCategory').insertAdjacentHTML('beforeend', configuration.categories.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join(''));
      if (!identity.confidentialAccess) $('#filterConfidentiality').closest('label').hidden = true;
      await load();
    } catch (error) { show(error.message, false); }
  }
  $('#queueFilters').addEventListener('submit', event => { event.preventDefault(); page = 1; load(); });
  $('#clearFilters').addEventListener('click', () => { $('#queueFilters').reset(); page = 1; load(); });
  $('#refreshTickets').addEventListener('click', async () => {
    const button = $('#refreshTickets');
    button.disabled = true;
    try {
      const response = await fetch('/api/support/admin/lifecycle/refresh', { method:'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The service-level refresh could not be completed.');
      await load();
      show('Queue and service-level flags refreshed.', true);
    } catch (error) { show(error.message, false); }
    finally { button.disabled = false; }
  });
  $('#exportQueue').addEventListener('click', () => { window.location.href = `/api/support/admin/tickets.csv?${queryString()}`; });
  $('#exportQueueExcel').addEventListener('click', () => { window.location.href = `/api/support/admin/tickets.xlsx?${queryString()}`; });
  $('#previousPage').addEventListener('click', () => { if (page > 1) { page -= 1; load(); } });
  $('#nextPage').addEventListener('click', () => { if (page < pages) { page += 1; load(); } });
  initialise();
})();
