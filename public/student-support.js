(function () {
  const page = document.body;
  const supportForm = document.getElementById('supportForm');
  const supportMessage = document.getElementById('supportMessage');
  const trackForm = document.getElementById('trackForm');
  const trackMessage = document.getElementById('trackMessage');
  const ticketResult = document.getElementById('ticketResult');
  const params = new URLSearchParams(location.search);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
  function show(el, text, ok) { if (!el) return; el.textContent = text; el.className = `status show ${ok ? 'ok' : 'bad'}`; }
  function formatDate(value) { return value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available'; }
  function renderTicket(ticket) {
    ticketResult.classList.remove('hidden');
    ticketResult.innerHTML = `<strong>${esc(ticket.reference)}</strong><dl><dt>Status</dt><dd>${esc(String(ticket.status || '').replaceAll('-', ' '))}</dd><dt>Responsible unit</dt><dd>${esc(ticket.ownerUnit)}</dd><dt>Learner level</dt><dd>${esc(ticket.studyLevel || 'Not stated')}</dd><dt>Evidence received</dt><dd>${esc(ticket.evidenceCount || 0)} file(s)</dd><dt>Target response</dt><dd>${esc(formatDate(ticket.dueAt))}</dd><dt>Last updated</dt><dd>${esc(formatDate(ticket.lastUpdatedAt))}</dd></dl>`;
  }
  if (page.dataset.defaultType) { const type = document.getElementById('type'); if (type) type.value = page.dataset.defaultType; }
  if (supportForm) supportForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!supportForm.reportValidity()) return;
    const formData = new FormData(supportForm);
    const submittedEmail = String(formData.get('email') || '').trim();
    formData.append('originRole', page.dataset.originRole || 'student');
    const button = supportForm.querySelector('button[type=submit]');
    button.disabled = true;
    show(supportMessage, 'Submitting your matter and uploading any evidence…', true);
    try {
      const response = await fetch('/api/support/tickets', { method: 'POST', body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The matter could not be submitted.');
      show(supportMessage, `Submitted successfully. Your reference is ${data.ticket.reference}. Save it to track this matter.`, true);
      supportForm.reset();
      if (page.dataset.defaultType) document.getElementById('type').value = page.dataset.defaultType;
      if (trackForm && data.ticket.reference && submittedEmail) {
        document.getElementById('trackReference').value = data.ticket.reference;
        document.getElementById('trackEmail').value = submittedEmail;
      }
    } catch (error) { show(supportMessage, error.message || 'The matter could not be submitted.', false); }
    finally { button.disabled = false; }
  });
  if (trackForm) trackForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!trackForm.reportValidity()) return;
    const ref = document.getElementById('trackReference').value.trim();
    const email = document.getElementById('trackEmail').value.trim();
    show(trackMessage, 'Checking the ticket…', true);
    try {
      const response = await fetch(`/api/support/tickets/${encodeURIComponent(ref)}?email=${encodeURIComponent(email)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Ticket not found.');
      renderTicket(data.ticket);
      show(trackMessage, 'Ticket found.', true);
    } catch (error) {
      if (ticketResult) ticketResult.classList.add('hidden');
      show(trackMessage, error.message || 'Ticket not found.', false);
    }
  });
  if (params.get('reference') && params.get('email') && trackForm) {
    document.getElementById('trackReference').value = params.get('reference');
    document.getElementById('trackEmail').value = params.get('email');
    trackForm.requestSubmit();
  }
})();
