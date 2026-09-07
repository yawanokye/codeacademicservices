(function () {
  const list = document.getElementById('ticketList');
  const summary = document.getElementById('queueSummary');
  const message = document.getElementById('adminMessage');
  const statuses = ['received', 'triaged', 'assigned', 'awaiting-student', 'in-progress', 'resolved', 'reopened', 'closed'];
  const labels = { 'awaiting-student': 'Awaiting student', 'in-progress': 'In progress' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
  const date = value => value ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available';
  const evidencePath = (ticket, index) => `/api/support/admin/tickets/${encodeURIComponent(ticket.id)}/evidence/${index}`;
  function show(text, ok) { message.textContent = text; message.className = `status show ${ok ? 'ok' : 'bad'}`; }
  function evidence(ticket) {
    if (!ticket.evidence?.length) return '<p class="admin-ticket-empty">No evidence files were attached.</p>';
    return `<div class="evidence-list">${ticket.evidence.map((file, index) => {
      const url = evidencePath(ticket, index); const name = esc(file.originalName || `Evidence ${index + 1}`); const mime = String(file.mimeType || '').toLowerCase();
      if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) return `<section class="evidence-item"><strong>${name}</strong><iframe class="evidence-frame" src="${url}" title="${name}"></iframe><a href="${url}" target="_blank" rel="noopener">Open in new tab</a></section>`;
      if (mime.startsWith('image/')) return `<section class="evidence-item"><strong>${name}</strong><img class="evidence-image" src="${url}" alt="Evidence: ${name}"><a href="${url}" target="_blank" rel="noopener">Open image in new tab</a></section>`;
      return `<section class="evidence-item"><strong>${name}</strong><a class="btn secondary evidence-open" href="${url}" target="_blank" rel="noopener">Open supporting file</a></section>`;
    }).join('')}</div>`;
  }
  function history(ticket) {
    if (!ticket.forwardHistory?.length) return '';
    return `<p class="forward-history">Forwarding: ${ticket.forwardHistory.map(item => `${esc(item.officeName)} (${esc(item.status || 'pending')})`).join(' · ')}</p>`;
  }
  function card(ticket) {
    const options = statuses.map(status => `<option value="${status}" ${status === ticket.status ? 'selected' : ''}>${labels[status] || status[0].toUpperCase() + status.slice(1)}</option>`).join('');
    return `<article class="admin-ticket" data-id="${esc(ticket.id)}"><div class="admin-ticket-head"><div><span class="ticket-ref">${esc(ticket.reference)}</span><h3>${esc(ticket.subject)}</h3><p>${esc(ticket.name)} · ${esc(ticket.email)}${ticket.studyCentre ? ` · ${esc(ticket.studyCentre)}` : ''}</p></div><span class="ticket-priority">${esc(ticket.priority)}</span></div><div class="admin-ticket-meta"><span><strong>Type</strong>${ticket.type === 'service-request' ? 'Service request' : 'Complaint'}</span><span><strong>Learner level</strong>${esc(ticket.studyLevel || 'Not stated')}</span><span><strong>Category</strong>${esc(ticket.category)}</span><span><strong>Owner</strong>${esc(ticket.ownerUnit)}</span><span><strong>Target</strong>${esc(date(ticket.dueAt))}</span></div><p class="admin-ticket-description">${esc(ticket.description)}</p><section class="evidence-panel"><h4>Submitted evidence</h4>${evidence(ticket)}</section><div class="admin-ticket-actions"><label>Status<select class="ticket-status">${options}</select></label><label>Responsible unit<input class="ticket-owner" value="${esc(ticket.ownerUnit)}"></label><label>Note<input class="ticket-note" placeholder="Optional action or resolution note"></label><button class="btn save-ticket" type="button">Save update</button></div><section class="forward-panel"><div><h4>Forward to responsible office</h4><p>Send a time-limited confidential case file containing the student's description, evidence and your comments.</p></div><div class="forward-fields"><label>Office name<input class="forward-office-name" value="${esc(ticket.ownerUnit)}" placeholder="e.g. Student Records Management Unit"></label><label>Official office email<input class="forward-office-email" type="email" placeholder="office@ucc.edu.gh"></label><label class="forward-comment">Student Support comments<textarea class="forward-comment-text" placeholder="State the action required and any screening or routing comments."></textarea></label><button class="btn forward-ticket" type="button">Forward ticket</button></div>${history(ticket)}</section></article>`;
  }
  async function load() {
    list.innerHTML = '<div class="resource-section">Loading support queue…</div>';
    try {
      const response = await fetch('/api/support/admin/tickets'); const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The support queue could not be loaded.');
      const tickets = data.tickets || [];
      summary.textContent = `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} · ${tickets.filter(t => !['resolved', 'closed'].includes(t.status)).length} open`;
      list.innerHTML = tickets.length ? tickets.map(card).join('') : '<div class="resource-section">No support tickets have been received.</div>';
      list.querySelectorAll('.save-ticket').forEach(button => button.addEventListener('click', save));
      list.querySelectorAll('.forward-ticket').forEach(button => button.addEventListener('click', forward));
    } catch (error) { list.innerHTML = ''; show(error.message || 'The support queue could not be loaded.', false); }
  }
  async function save(event) {
    const article = event.currentTarget.closest('.admin-ticket'); const button = event.currentTarget;
    const body = { status: article.querySelector('.ticket-status').value, ownerUnit: article.querySelector('.ticket-owner').value, note: article.querySelector('.ticket-note').value };
    button.disabled = true;
    try {
      const response = await fetch(`/api/support/admin/tickets/${encodeURIComponent(article.dataset.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'The ticket could not be updated.');
      show(`Updated ${data.ticket.reference}.`, true); load();
    } catch (error) { show(error.message || 'The ticket could not be updated.', false); button.disabled = false; }
  }
  async function forward(event) {
    const article = event.currentTarget.closest('.admin-ticket'); const button = event.currentTarget;
    const body = { officeName: article.querySelector('.forward-office-name').value, officeEmail: article.querySelector('.forward-office-email').value, comment: article.querySelector('.forward-comment-text').value };
    button.disabled = true;
    try {
      const response = await fetch(`/api/support/admin/tickets/${encodeURIComponent(article.dataset.id)}/forward`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'The ticket could not be forwarded.');
      show(`Forwarded ${data.reference}. The confidential link expires ${date(data.expiresAt)}.`, true); load();
    } catch (error) { show(error.message || 'The ticket could not be forwarded.', false); button.disabled = false; }
  }
  document.getElementById('refreshTickets').addEventListener('click', load); load();
})();
