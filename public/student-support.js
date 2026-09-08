(function () {
  const page = document.body;
  const supportForm = document.getElementById('supportForm');
  const supportMessage = document.getElementById('supportMessage');
  const trackForm = document.getElementById('trackForm');
  const trackMessage = document.getElementById('trackMessage');
  const ticketResult = document.getElementById('ticketResult');
  const params = new URLSearchParams(location.search);
  let currentAccessToken = params.get('token') || '';
  let currentEmail = '';
  let categoryInformation = {};

  const statusLabels = {
    received: 'Received', triaged: 'Triaged', assigned: 'Assigned', accepted: 'Resolution accepted', appealed: 'Appealed',
    'awaiting-student': 'Awaiting your response', 'evidence-requested': 'Additional evidence requested',
    'lacks-evidence': 'Additional evidence needed', 'investigation-ongoing': 'Investigation ongoing',
    'in-progress': 'In progress', resolved: 'Resolution proposed', reopened: 'Reopened',
    'final-decision': 'Final decision issued', closed: 'Closed'
  };
  const evidenceGuidance = {
    'incomplete-result': 'Helpful evidence: result slip, course code, academic year, semester and any earlier correspondence.',
    'fees-payment': 'Helpful evidence: payment receipt, transaction reference, date, amount and student account screenshot.',
    certificate: 'Helpful evidence: completion details, graduation year and earlier certificate correspondence.',
    'change-of-name': 'Helpful evidence: approved identity documents and the formal name-change record.',
    transcript: 'Helpful evidence: application receipt, payment reference, date and intended destination.',
    'change-study-centre': 'Helpful evidence: current centre, proposed centre and reason for the request.',
    'centre-transit': 'Helpful evidence: current centre, temporary centre, dates and coordinator confirmation.',
    'programme-department': 'Helpful evidence: programme, course or departmental correspondence.',
    'assessment-project': 'Helpful evidence: course code, assessment or project details, dates and relevant correspondence.',
    sensitive: 'Share only evidence necessary for the confidential handler. Do not include passwords or payment-card details.',
    general: 'Attach receipts, screenshots, messages, incident references or instructions that help explain the matter.'
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
  const formatDate = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' }) : 'Not available';
  const show = (element, text, ok) => { if (!element) return; element.textContent = text; element.className = `status show ${ok ? 'ok' : 'bad'}`; };
  const authFields = () => currentAccessToken ? { accessToken: currentAccessToken } : { email: currentEmail || document.getElementById('trackEmail')?.value.trim() || '' };

  function updates(ticket) {
    const items = ticket.updates || [];
    return items.length ? `<ol class="ticket-timeline">${items.map(update => `<li><strong>${esc(update.label)}</strong><span>${esc(formatDate(update.at))}</span><p>${esc(update.message)}</p></li>`).join('')}</ol>` : '<p>No progress updates have been recorded yet.</p>';
  }
  function responseForm(ticket) {
    if (!ticket.canRespond || ticket.status === 'accepted') return '';
    const requested = ticket.needsEvidence ? '<div class="response-alert"><strong>Action required</strong><span>The responsible unit needs more information before work can continue.</span></div>' : '';
    return `<section class="ticket-response">${requested}<h4>${ticket.needsEvidence ? 'Provide the requested evidence' : 'Add information to this case'}</h4><form class="student-response-form"><div class="field"><label>Message to the responsible unit</label><textarea name="note" placeholder="Add a clarification, response or description of the evidence."></textarea></div><div class="field"><label>Additional evidence <span class="optional-label">Optional</span></label><input name="evidenceFiles" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,.txt"><small class="hint">Up to 10 files, maximum 15 MB each.</small></div><button class="btn" type="submit">Send response</button><div class="evidence-response-status status" role="status" aria-live="polite"></div></form></section>`;
  }
  function decisionPanel(ticket) {
    if (!ticket.canAccept && !ticket.canReopen && !ticket.canAppeal) return '';
    return `<section class="ticket-decision-actions"><h4>Respond to this decision</h4><p>Accept the resolution, reopen the case during the response period, or send a formal appeal to a higher authority.</p><div class="decision-buttons">${ticket.canAccept ? '<button class="btn accept-resolution" type="button">Accept resolution</button>' : ''}${ticket.canReopen ? '<button class="btn secondary reopen-case" type="button">Matter not resolved</button>' : ''}${ticket.canAppeal ? '<button class="btn secondary appeal-case" type="button">Appeal decision</button>' : ''}</div><form class="decision-reason hidden"><div class="field"><label>Reason <span class="req">*</span></label><textarea name="reason" minlength="10" placeholder="Explain what remains unresolved or why you are appealing."></textarea></div><button class="btn submit-decision" type="submit">Submit</button><button class="btn secondary cancel-decision" type="button">Cancel</button><div class="decision-status status" role="status" aria-live="polite"></div></form></section>`;
  }
  function feedbackPanel(ticket) {
    if (ticket.feedbackSubmitted) return '<section class="ticket-feedback feedback-complete"><h4>Thank you for your feedback</h4><p>Your response has been included in the service-quality dashboard.</p></section>';
    if (!ticket.canGiveFeedback) return '';
    const ratingOptions='<option value="">Choose 1 to 5</option><option value="5">5 — Excellent</option><option value="4">4 — Good</option><option value="3">3 — Fair</option><option value="2">2 — Poor</option><option value="1">1 — Very poor</option>';
    return `<section class="ticket-feedback"><h4>Student satisfaction survey</h4><p>Rate the complete service experience. Your feedback supports centre and unit improvement and does not affect your right to raise another matter.</p><form class="student-feedback-form"><div class="survey-rating-grid"><div class="field"><label>Overall satisfaction <span class="req">*</span></label><select name="rating" required>${ratingOptions}</select></div><div class="field"><label>Ease of using the service <span class="req">*</span></label><select name="easeOfUse" required>${ratingOptions}</select></div><div class="field"><label>Clarity of communication <span class="req">*</span></label><select name="communication" required>${ratingOptions}</select></div><div class="field"><label>Timeliness of the response <span class="req">*</span></label><select name="timeliness" required>${ratingOptions}</select></div><div class="field"><label>Courtesy and professionalism <span class="req">*</span></label><select name="staffCourtesy" required>${ratingOptions}</select></div><div class="field"><label>Was the matter resolved? <span class="req">*</span></label><select name="resolved" required><option value="">Choose an answer</option><option value="yes">Yes</option><option value="partly">Partly</option><option value="no">No</option></select></div><div class="field"><label>Were notifications helpful? <span class="req">*</span></label><select name="notificationHelpful" required><option value="">Choose an answer</option><option value="yes">Yes</option><option value="no">No</option><option value="not-used">I did not use them</option></select></div><div class="field"><label>Did language assistance meet your need? <span class="req">*</span></label><select name="languageHelp" required><option value="">Choose an answer</option><option value="yes">Yes</option><option value="no">No</option><option value="not-needed">Not needed</option></select></div></div><div class="field"><label>What worked well or should improve? <span class="optional-label">Required if any rating is 1–2</span></label><textarea name="comment" maxlength="2000"></textarea></div><button class="btn" type="submit">Submit survey</button><div class="feedback-status status" role="status" aria-live="polite"></div></form></section>`;
  }
  function renderTicket(ticket) {
    ticketResult.classList.remove('hidden');
    const slaText = ticket.sla?.paused ? `Paused: ${ticket.sla.pauseReason || 'awaiting information'}` : ticket.sla?.overdue ? 'Overdue' : ticket.sla?.atRisk ? 'Due soon' : 'Within target';
    const languageLabel=({en:'English',tw:'Twi',fr:'French'})[ticket.language]||'English';
    const notificationLabel=({'email':'Email only','email-sms':'Email and SMS','email-whatsapp':'Email and WhatsApp'})[ticket.notificationPreference]||'Email only';
    ticketResult.innerHTML = `<div class="ticket-result-head"><div><span class="ticket-ref-label">${esc(ticket.reference)}</span><h3>${esc(ticket.subject || 'Support matter')}</h3></div><span class="status-chip status-${esc(ticket.status)}">${esc(statusLabels[ticket.status] || ticket.status)}</span></div><dl><dt>Matter</dt><dd>${ticket.type === 'service-request' ? 'Service request' : 'Complaint'}</dd><dt>Category</dt><dd>${esc(ticket.category)}</dd><dt>Responsible unit</dt><dd>${esc(ticket.ownerUnit)}</dd><dt>Reported urgency</dt><dd>${esc(ticket.priority)}</dd><dt>Evidence received</dt><dd>${esc(ticket.evidenceCount || 0)} file(s)</dd><dt>Assistance language</dt><dd>${esc(languageLabel)}</dd><dt>Notifications</dt><dd>${esc(notificationLabel)}</dd><dt>Service target</dt><dd>${ticket.sla?.paused ? esc(slaText) : esc(formatDate(ticket.dueAt))}</dd><dt>SLA position</dt><dd>${esc(slaText)}</dd><dt>Last updated</dt><dd>${esc(formatDate(ticket.lastUpdatedAt))}</dd></dl><section class="ticket-updates"><h4>Case progress</h4>${updates(ticket)}</section>${ticket.resolution ? `<section class="ticket-decision"><h4>Decision</h4><p>${esc(ticket.resolution)}</p></section>` : ''}${responseForm(ticket)}${decisionPanel(ticket)}${feedbackPanel(ticket)}`;
    ticketResult.querySelector('.student-response-form')?.addEventListener('submit', submitResponse);
    ticketResult.querySelector('.accept-resolution')?.addEventListener('click', () => submitDecision('accept', 'Resolution accepted by student.'));
    ticketResult.querySelector('.reopen-case')?.addEventListener('click', () => openDecisionForm('reopen'));
    ticketResult.querySelector('.appeal-case')?.addEventListener('click', () => openDecisionForm('appeal'));
    ticketResult.querySelector('.decision-reason')?.addEventListener('submit', event => { event.preventDefault(); submitDecision(event.currentTarget.dataset.action, event.currentTarget.elements.reason.value); });
    ticketResult.querySelector('.cancel-decision')?.addEventListener('click', () => ticketResult.querySelector('.decision-reason')?.classList.add('hidden'));
    ticketResult.querySelector('.student-feedback-form')?.addEventListener('submit', submitFeedback);
  }
  function openDecisionForm(action) {
    const form = ticketResult.querySelector('.decision-reason');
    if (!form) return;
    form.dataset.action = action;
    form.querySelector('.submit-decision').textContent = action === 'appeal' ? 'Submit appeal' : 'Reopen case';
    form.classList.remove('hidden');
    form.elements.reason.focus();
  }
  async function submitDecision(action, reason) {
    const status = ticketResult.querySelector('.decision-status');
    const reference = ticketResult.querySelector('.ticket-ref-label')?.textContent || '';
    show(status, 'Submitting your response…', true);
    try {
      const response = await fetch(`/api/support/tickets/${encodeURIComponent(reference)}/decision`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ action, reason, ...authFields() }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Your response could not be submitted.');
      renderTicket(data.ticket);
      show(trackMessage, action === 'accept' ? 'Resolution accepted and case closed.' : action === 'appeal' ? 'Appeal registered with a higher authority.' : 'The case has been reopened.', true);
    } catch (error) { show(status, error.message || 'Your response could not be submitted.', false); }
  }
  async function submitResponse(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    const status = form.querySelector('.evidence-response-status');
    const reference = ticketResult.querySelector('.ticket-ref-label')?.textContent || '';
    const data = new FormData(form);
    Object.entries(authFields()).forEach(([key, value]) => data.append(key, value));
    if (!String(data.get('note') || '').trim() && !data.getAll('evidenceFiles').some(file => file && file.size)) return show(status, 'Add a message or attach evidence.', false);
    button.disabled = true;
    show(status, 'Sending your response…', true);
    try {
      const response = await fetch(`/api/support/tickets/${encodeURIComponent(reference)}/respond`, { method:'POST', body:data });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Your response could not be sent.');
      renderTicket(body.ticket);
      show(trackMessage, 'Your response has been added to the case.', true);
    } catch (error) { show(status, error.message || 'Your response could not be sent.', false); }
    finally { button.disabled = false; }
  }
  async function submitFeedback(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type=submit]');
    const status = form.querySelector('.feedback-status');
    const reference = ticketResult.querySelector('.ticket-ref-label')?.textContent || '';
    const body = { rating:Number(form.elements.rating.value), easeOfUse:Number(form.elements.easeOfUse.value), communication:Number(form.elements.communication.value), timeliness:Number(form.elements.timeliness.value), staffCourtesy:Number(form.elements.staffCourtesy.value), resolved:form.elements.resolved.value, notificationHelpful:form.elements.notificationHelpful.value, languageHelp:form.elements.languageHelp.value, comment:form.elements.comment.value, ...authFields() };
    button.disabled = true;
    show(status, 'Saving your feedback…', true);
    try {
      const response = await fetch(`/api/support/tickets/${encodeURIComponent(reference)}/feedback`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Your feedback could not be saved.');
      renderTicket(data.ticket);
      show(trackMessage, 'Thank you. Your feedback has been saved.', true);
    } catch (error) { show(status, error.message || 'Your feedback could not be saved.', false); button.disabled = false; }
  }
  async function trackTicket() {
    show(trackMessage, 'Checking the ticket…', true);
    try {
      let response;
      if (currentAccessToken) response = await fetch(`/api/support/tickets/access/${encodeURIComponent(currentAccessToken)}`);
      else {
        const reference = document.getElementById('trackReference').value.trim();
        currentEmail = document.getElementById('trackEmail').value.trim();
        response = await fetch('/api/support/tickets/lookup', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ reference, email:currentEmail }) });
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Ticket not found.');
      if (data.accessToken) currentAccessToken = data.accessToken;
      renderTicket(data.ticket);
      show(trackMessage, 'Ticket found.', true);
    } catch (error) { ticketResult?.classList.add('hidden'); show(trackMessage, error.message || 'Ticket not found.', false); }
  }
  async function loadSupportConfig() {
    try {
      const response = await fetch('/api/support/config');
      const data = await response.json();
      if (!response.ok) return;
      categoryInformation = Object.fromEntries((data.categories || []).map(item => [item.id, item]));
      const centre = document.getElementById('studyCentre');
      if (centre?.tagName === 'SELECT') centre.innerHTML = '<option value="">Select study centre</option>' + data.studyCentres.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('') + '<option value="Other / Online">Other / Online</option>';
      const department = document.getElementById('academicDepartment');
      if (department) department.innerHTML = '<option value="">Select department</option>' + data.departments.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('');
      const language = document.getElementById('language');
      if (language && data.languages?.length) language.innerHTML = data.languages.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('');
      const notifications = document.getElementById('notificationPreference');
      const availableNotifications = (data.notificationChannels || []).filter(item => item.available);
      if (notifications && availableNotifications.length) notifications.innerHTML = availableNotifications.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('');
      const notificationHint = document.getElementById('notificationHint');
      if (notificationHint && availableNotifications.length === 1) notificationHint.textContent = 'Email is currently the available notification channel.';
      applyRequestedDefaults();
      syncCategoryGuidance();
    } catch {}
  }
  function syncCategoryGuidance() {
    const category = document.getElementById('category')?.value || 'general';
    const language = document.getElementById('language')?.value || 'en';
    const guidance = document.getElementById('evidenceGuidance');
    const information = categoryInformation[category];
    const translatedEvidence={tw:'Fa receipt, screenshot, krataa, nna ne reference biara a ɛbɛboa ma wɔate asɛm no ase ka ho.',fr:'Joignez les reçus, captures, messages, dates et références utiles pour expliquer clairement la demande.'};
    if (guidance) guidance.textContent = language === 'en' ? (information?.evidenceGuidance || evidenceGuidance[category] || evidenceGuidance.general) : translatedEvidence[language];
    const expectation = document.getElementById('serviceExpectation');
    const assistance={tw:{title:'Twi mmoa',text:'Kyerɛ asɛm no mu pefee, fa nna ne reference ka ho. Sɛ wohia mmoa a, study centre coordinator betumi aboa wo.'},fr:{title:'Aide en français',text:'Décrivez clairement la situation avec les dates et références. Un coordonnateur de centre peut vous aider si nécessaire.'}};
    if (expectation) expectation.innerHTML = information ? `<strong>Before submitting</strong><span>${esc(information.beforeSubmitting)}</span><small>Expected owner: ${esc(information.responsibleUnit)} · Standard target: ${esc(information.workingDays)} working day${Number(information.workingDays) === 1 ? '' : 's'}.</small>${assistance[language]?`<div class="translated-assistance"><strong>${esc(assistance[language].title)}</strong><span>${esc(assistance[language].text)}</span></div>`:''}` : '';
    const academic = document.getElementById('academicFields');
    if (academic) academic.hidden = !['programme-department','assessment-project','incomplete-result'].includes(category);
  }
  function applyRequestedDefaults() {
    const type=document.getElementById('type');
    const category=document.getElementById('category');
    const language=document.getElementById('language');
    const requestedType=params.get('type');
    const requestedCategory=params.get('category');
    const requestedLanguage=params.get('language');
    if(type) type.value=['complaint','service-request'].includes(requestedType)?requestedType:(page.dataset.defaultType||type.value);
    if(category&&requestedCategory&&[...category.options].some(option=>option.value===requestedCategory)) category.value=requestedCategory;
    if(language&&requestedLanguage&&[...language.options].some(option=>option.value===requestedLanguage)) language.value=requestedLanguage;
  }
  applyRequestedDefaults();
  document.getElementById('category')?.addEventListener('change', syncCategoryGuidance);
  document.getElementById('language')?.addEventListener('change', syncCategoryGuidance);
  loadSupportConfig();
  syncCategoryGuidance();
  supportForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!supportForm.reportValidity()) return;
    const formData = new FormData(supportForm);
    const submittedEmail = String(formData.get('email') || '').trim();
    formData.append('originRole', page.dataset.originRole || 'student');
    const button = supportForm.querySelector('button[type=submit]');
    if (['email-sms','email-whatsapp'].includes(String(formData.get('notificationPreference') || '')) && !String(formData.get('phone') || '').trim()) return show(supportMessage, 'Enter a phone number for SMS or WhatsApp notifications.', false);
    button.disabled = true;
    show(supportMessage, 'Submitting your matter and uploading evidence…', true);
    try {
      const response = await fetch('/api/support/tickets', { method:'POST', body:formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The matter could not be submitted.');
      currentEmail = submittedEmail;
      show(supportMessage, `Submitted successfully. Your permanent reference is ${data.ticket.reference}. Save this number for tracking.`, true);
      supportMessage.insertAdjacentHTML('beforeend', `<div class="receipt-actions"><button type="button" class="btn secondary copy-reference" data-reference="${esc(data.ticket.reference)}">Copy reference</button><button type="button" class="btn track-new-ticket">Open ticket status</button></div>`);
      supportMessage.querySelector('.copy-reference')?.addEventListener('click', event => navigator.clipboard?.writeText(event.currentTarget.dataset.reference));
      supportMessage.querySelector('.track-new-ticket')?.addEventListener('click', () => { document.getElementById('trackReference').value = data.ticket.reference; document.getElementById('trackEmail').value = submittedEmail; trackTicket(); document.getElementById('trackForm').scrollIntoView({ behavior:'smooth' }); });
      supportForm.reset();
      applyRequestedDefaults();
      syncCategoryGuidance();
    } catch (error) { show(supportMessage, error.message || 'The matter could not be submitted.', false); }
    finally { button.disabled = false; }
  });
  trackForm?.addEventListener('submit', event => { event.preventDefault(); if (trackForm.reportValidity()) { currentAccessToken = ''; trackTicket(); } });
  if (currentAccessToken && trackForm) {
    trackForm.classList.add('hidden');
    trackTicket();
  }
})();
