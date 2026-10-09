const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = ms => new Date(ms).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
const duration = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const kinds = { room: 'Individual', limited: 'Temporal', full: 'Total' };
const codesPageSize = 5;
let loggedIn = false, offset = 0, refreshing = false, codes = [], codesPage = 0, groups = [], visibleCodes = [], modalTitle = '', pendingRevoke = null;
const codeModal = $('#admin-modal'), revokeModal = $('#revoke-modal');
async function api(path, data) {
  const r = await fetch(`/api/admin/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'same-origin' });
  const value = await r.json();
  if (r.status === 401 && path !== 'login') setLogin(false);
  if (!r.ok) throw new Error(value.error || 'No se pudo completar la solicitud.');
  return value;
}
function setLogin(value) {
  loggedIn = value; $('#login-section').hidden = value; $('#dashboard').hidden = !value; $('#logout').hidden = !value;
  if (!value) { codeModal.close(); revokeModal.close(); codes = []; codesPage = 0; groups = []; visibleCodes = []; }
}
function error(e) { $('#admin-error').textContent = e?.message || ''; }
function defaults() {
  const tomorrow = new Date(Date.now() + 86400_000); tomorrow.setMinutes(tomorrow.getMinutes() - tomorrow.getTimezoneOffset());
  document.querySelectorAll('[name="expiresAt"]').forEach(el => el.value = tomorrow.toISOString().slice(0, 16));
}
function renderCodes(serverTime = Date.now()) {
  const pages = Math.max(1, Math.ceil(codes.length / codesPageSize));
  codesPage = Math.min(codesPage, pages - 1);
  $('#codes').innerHTML = codes.slice(codesPage * codesPageSize, (codesPage + 1) * codesPageSize).map(c => {
    const state = c.revokedAt ? 'Revocado' : c.expiresAt <= serverTime ? 'Vencido' : 'Activo';
    return `<tr><td>${esc(c.label)}<small>•••• ${esc(c.hint)}${c.roomCode ? ` · Sala ${c.roomCode}` : ''}</small></td><td>${kinds[c.kind]}</td><td>${c.usedRooms} / ${c.maxRooms || '∞'}</td><td>${date(c.expiresAt)}</td><td><span class="status ${state === 'Activo' ? '' : 'off'}">${state}</span></td></tr>`;
  }).join('') || '<tr><td colspan="5">Todavía no has generado accesos.</td></tr>';
  $('#codes-page').textContent = `Página ${codesPage + 1} de ${pages} · ${codes.length} acceso${codes.length === 1 ? '' : 's'}`;
  $('#codes-previous').disabled = codesPage === 0;
  $('#codes-next').disabled = codesPage === pages - 1;
}
function roomStates(group) {
  const rooms = [...new Map(group.codes.flatMap(c => c.rooms || []).map(r => [r.code, r])).values()];
  if (!rooms.length) return '<div class="code-room-states"><span class="status off">Sin salas abiertas</span></div>';
  const labels = { lobby: 'En espera', playing: 'En curso', finished: 'Finalizada', closed: 'Cerrada' };
  return `<div class="code-room-states">${rooms.map(r => `<span class="status ${r.status === 'lobby' ? 'wait' : ['finished', 'closed'].includes(r.status) ? 'off' : ''}">${group.kind === 'room' ? '' : `${esc(r.code)} · `}${labels[r.status] || 'Sin partida en curso'}</span>`).join('')}</div>`;
}
function renderGroups(overview) {
  const active = codes.filter(c => !c.revokedAt && c.expiresAt > overview.serverTime), grouped = new Map();
  for (const c of active) {
    const key = c.kind === 'room' ? `room:${c.roomCode}` : c.id;
    if (!grouped.has(key)) grouped.set(key, { title: c.kind === 'room' ? overview.rooms.find(r => r.code === c.roomCode)?.name || `Sala ${c.roomCode}` : c.label || `Acceso ${kinds[c.kind].toLowerCase()}`, roomCode: c.roomCode, kind: c.kind, codes: [] });
    grouped.get(key).codes.push(c);
  }
  groups = [...grouped.values()];
  $('#active-codes').innerHTML = groups.map((g, i) => `<button type="button" class="monitor-room code-card" data-group="${i}" aria-label="Ver códigos de ${esc(g.title)}"><span class="status">${g.kind === 'room' ? 'Accesos de la sala' : kinds[g.kind]}</span><h3>${esc(g.title)}</h3>${g.roomCode ? `<code>${esc(g.roomCode)}</code>` : ''}${roomStates(g)}<p>${g.codes.length} acceso${g.codes.length === 1 ? '' : 's'} vigente${g.codes.length === 1 ? '' : 's'}${g.kind === 'limited' ? ` · ${g.codes[0].usedRooms}/${g.codes[0].maxRooms} salas utilizadas` : ''}</p><p>Hasta ${date(Math.max(...g.codes.map(c => c.expiresAt)))}</p><span class="card-link">Ver y copiar códigos →</span></button>`).join('') || '<div class="empty-list">No hay códigos activos en este momento.</div>';
}
function renderCodeModal() {
  const access = visibleCodes[0], room = access?.kind === 'room';
  codeModal.innerHTML = `<div class="modal-head"><div><div class="eyebrow">ACCESOS VIGENTES</div><h2 id="codes-modal-title">${esc(modalTitle)}</h2></div><button type="button" class="icon-btn" data-close-codes aria-label="Cerrar códigos">×</button></div><div class="code-details">${visibleCodes.map(c => `<article class="code-detail"><div class="code-detail-heading"><strong>${esc(c.label || kinds[c.kind])}</strong><span class="status">${kinds[c.kind]}</span></div><p class="muted">Válido hasta ${date(c.expiresAt)}</p>${c.roomCode ? `<div class="room-copy">Sala <b>${esc(c.roomCode)}</b><button class="text-btn" data-room-copy="${esc(c.roomCode)}">Copiar sala</button></div>` : ''}${c.code ? `<label class="field">Código de acceso<input readonly value="${esc(c.code)}" aria-label="Código de acceso de ${esc(c.label || kinds[c.kind])}" class="revealed-code"></label><button type="button" class="primary" data-copy-code="${esc(c.id)}">Copiar código</button>` : `<p class="legacy-note">Este acceso se generó antes del visor. Puedes preparar una copia con los mismos permisos, vigencia y cupos. El código original seguirá funcionando.</p><button type="button" class="secondary" data-recover-code="${esc(c.id)}">Preparar copia del acceso</button>`}</article>`).join('') || '<p class="modal-copy">Ya no quedan códigos vigentes en este grupo.</p>'}</div><p id="modal-feedback" role="status" aria-live="polite"></p><div class="modal-actions">${access ? `<button type="button" class="secondary revoke-link" data-revoke="${esc(access.id)}" ${room ? 'data-revoke-room="true"' : ''}>${room ? 'Revocar acceso completo' : 'Revocar acceso'}</button>` : ''}${visibleCodes.some(c => c.code) ? '<button type="button" class="secondary" id="download-codes">Descargar accesos</button>' : ''}${visibleCodes.filter(c => c.code).length > 1 ? '<button type="button" class="primary" id="copy-codes">Copiar todos los códigos</button>' : ''}<button type="button" class="secondary" data-close-codes>Cerrar</button></div>`;
}
function showCodes(values, title) { if (!loggedIn) return; visibleCodes = values.toSorted((a, b) => (a.label || '').localeCompare(b.label || '', 'es', { numeric: true })); modalTitle = title; renderCodeModal(); if (!codeModal.open) codeModal.showModal(); }
function showIssued(value) { showCodes(value.codes, value.room ? `Sala ${value.room.code}` : value.codes[0].label || 'Tu acceso está listo'); }
async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); if (button) button.textContent = 'Copiado'; }
  catch { showCodes([], 'Copiar código'); $('#modal-feedback').textContent = 'Selecciona y copia el código de abajo.'; const input = document.createElement('input'); input.readOnly = true; input.value = text; input.className = 'manual-copy'; $('#modal-feedback').after(input); input.select(); }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const [o, history] = await Promise.all([api('overview'), api(`history?offset=${offset}`)]);
    setLogin(true); codes = o.codes;
    const selected = $('#admin-capacity').value || '4';
    if (!$('#admin-capacity').options.length) $('#admin-capacity').innerHTML = Array.from({ length: o.maxPlayers - 1 }, (_, i) => `<option value="${i + 2}">${i + 2} jugadores</option>`).join('');
    $('#admin-capacity').value = String(Math.min(Number(selected), o.maxPlayers));
    $('#metrics').innerHTML = [[o.rooms.filter(r => r.status === 'playing').length, 'Partidas en curso'], [o.rooms.filter(r => r.status === 'lobby').length, 'Salas en espera'], [o.summary.completed, 'Partidas registradas'], [duration(o.summary.averageDurationMs), 'Duración media']].map(([n, text]) => `<div class="metric"><strong>${n}</strong><span>${text}</span></div>`).join('');
    $('#updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es-PE')}`;
    renderGroups(o); renderCodes(o.serverTime);
    if (codeModal.open && visibleCodes.length) {
      const available = visibleCodes.filter(c => codes.some(current => current.id === c.id && !current.revokedAt && current.expiresAt > o.serverTime));
      if (available.length !== visibleCodes.length) { visibleCodes = available; renderCodeModal(); }
    }
    const results = { victory: 'Victoria', abandonment: 'Victoria por abandono', abandoned: 'Sin ganador', interrupted: 'Interrumpida' };
    $('#history').innerHTML = history.matches.map(m => `<tr><td>${esc(m.roomName)}<small>${m.roomCode} · Partida ${m.number}${m.practice ? ' · Práctica' : ''}</small></td><td>${m.players.map(p => esc(p.name)).join(', ')}</td><td>${date(m.startedAt)}</td><td>${duration(m.durationMs)}</td><td>${esc(results[m.result] || m.result)}${m.winnerName ? `<small>${esc(m.winnerName)}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No hay partidas en esta página.</td></tr>';
    $('#previous').disabled = offset === 0; $('#next').disabled = history.matches.length < 50;
  } catch (e) { if (loggedIn) error(e); } finally { refreshing = false; }
}
document.addEventListener('submit', async e => {
  e.preventDefault(); const button = e.target.querySelector('button[type="submit"],button'); button.disabled = true; error(null);
  try {
    const data = Object.fromEntries(new FormData(e.target));
    if (e.target.id === 'login-form') { await api('login', data); e.target.reset(); await refresh(); }
    if (e.target.id === 'create-room') { const value = await api('rooms', { name: data.name, capacity: Number(data.capacity), maxGames: Number(data.maxGames), expiresAt: new Date(data.expiresAt).getTime() }); await refresh(); showIssued(value); }
    if (e.target.id === 'create-code') { const value = await api('codes', { label: data.label, kind: data.kind, maxRooms: Number(data.maxRooms), expiresAt: new Date(data.expiresAt).getTime() }); await refresh(); showIssued(value); }
  } catch (e) { error(e); } finally { button.disabled = false; }
});
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button || button.disabled) return;
  try {
    if (button.id === 'logout') { await api('logout', {}); setLogin(false); error(null); }
    if (button.id === 'codes-previous' || button.id === 'codes-next') { codesPage = Math.max(0, codesPage + (button.id === 'codes-next' ? 1 : -1)); renderCodes(); }
    if (button.id === 'refresh') { error(null); await refresh(); }
    if (button.id === 'previous' || button.id === 'next') { offset = Math.max(0, offset + (button.id === 'next' ? 50 : -50)); await refresh(); }
    if (button.dataset.group !== undefined) { const group = groups[Number(button.dataset.group)]; showCodes((await api('codes/reveal', { ids: group.codes.map(c => c.id) })).codes, group.title); }
    if (button.hasAttribute('data-close-codes')) codeModal.close();
    if (button.hasAttribute('data-close-revoke')) revokeModal.close();
    if (button.dataset.revoke) {
      const access = codes.find(c => c.id === button.dataset.revoke), room = button.dataset.revokeRoom === 'true';
      pendingRevoke = { id: button.dataset.revoke, room };
      $('#revoke-title').textContent = room ? '¿Revocar el acceso completo de la sala?' : '¿Revocar este acceso?';
      $('#revoke-label').textContent = room ? `${modalTitle} · Sala ${access?.roomCode || ''}` : access?.label || 'Código de acceso';
      $('#revoke-description').textContent = room ? 'Se revocarán todos los códigos individuales de esta sala. Se bloquearán nuevas entradas y revanchas; la partida actual podrá terminar.' : 'Se bloquearán nuevas entradas y revanchas con este acceso. La partida actual podrá terminar.';
      $('#confirm-revoke').textContent = room ? 'Revocar todos los accesos' : 'Revocar acceso';
      $('#revoke-error').textContent = ''; revokeModal.showModal();
    }
    if (button.id === 'confirm-revoke' && pendingRevoke) {
      button.disabled = true;
      try { await api(pendingRevoke.room ? 'codes/revoke-room' : 'codes/revoke', { id: pendingRevoke.id }); revokeModal.close(); await refresh(); }
      catch (e) { $('#revoke-error').textContent = e.message; } finally { button.disabled = false; }
    }
    if (button.dataset.recoverCode) {
      button.disabled = true;
      try { const value = (await api('codes/recover', { id: button.dataset.recoverCode })).codes[0]; visibleCodes = visibleCodes.map(c => c.id === value.id ? value : c); renderCodeModal(); await refresh(); }
      finally { button.disabled = false; }
    }
    if (button.dataset.copyCode) { const c = visibleCodes.find(c => c.id === button.dataset.copyCode); if (!c || c.expiresAt <= Date.now()) throw new Error('Este acceso ya no está vigente.'); await copyText(c.code, button); }
    if (button.dataset.roomCopy) await copyText(button.dataset.roomCopy, button);
    if (button.id === 'copy-codes') await copyText(visibleCodes.filter(c => c.code && c.expiresAt > Date.now()).map(c => c.code).join('\n'), button);
    if (button.id === 'download-codes') { const text = visibleCodes.filter(c => c.code && c.expiresAt > Date.now()).map(c => `${c.label || kinds[c.kind]}${c.roomCode ? ` · Sala ${c.roomCode}` : ''}\n${c.code}\nVigencia: ${date(c.expiresAt)}`).join('\n\n'); const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = 'virus-accesos.txt'; a.click(); URL.revokeObjectURL(url); }
  } catch (e) { if (codeModal.open) $('#modal-feedback').textContent = e.message; else error(e); }
});
for (const dialog of [codeModal, revokeModal]) dialog.addEventListener('click', e => {
  if (e.target !== dialog) return; const b = dialog.getBoundingClientRect();
  if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close();
});
codeModal.addEventListener('close', () => { visibleCodes = []; codeModal.textContent = ''; });
revokeModal.addEventListener('close', () => { pendingRevoke = null; });
$('#code-kind').addEventListener('change', e => { $('#limit-field').hidden = e.target.value === 'full'; $('#full-note').hidden = e.target.value !== 'full'; });
defaults(); await refresh(); setInterval(() => { if (loggedIn && !document.hidden) refresh(); }, 5000);
