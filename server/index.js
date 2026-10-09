import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newGame, publicGame, legalActions, act, refillTurn, healthyCount, status, eliminatePlayers } from '../shared/game.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PLAYERS = Math.max(2, Math.min(8, Math.trunc(Number(process.env.MAX_PLAYERS)) || 8));
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const STATE_FILE = resolve(process.env.STATE_FILE || `${ROOT}/data/rooms.json`);
const DISCONNECT_TIMEOUT_MS = Number(process.env.DISCONNECT_TIMEOUT_MS) || 5 * 60_000;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS) || 25_000;
const AUTO_TURN_LIMIT = Number(process.env.AUTO_TURN_LIMIT) || 15;
const AUTO_DELAY_MS = Number(process.env.AUTO_DELAY_MS) || 1800;
const REMATCH_TIMEOUT_MS = Number(process.env.REMATCH_TIMEOUT_MS) || 90_000;
const rooms = new Map(), sockets = new Map(), timers = new Map(), offlineTimers = new Map(), rematchTimers = new Map();
const id = () => randomBytes(16).toString('hex');
function save() {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify([...rooms.values()]), { mode: 0o600 });
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}
if (existsSync(STATE_FILE)) {
  try {
    for (const r of JSON.parse(readFileSync(STATE_FILE, 'utf8'))) {
      for (const p of r.members) if (p.bot) { p.connected = true; p.offlineSince = null; } else { p.offlineSince = !p.connected && p.offlineSince ? p.offlineSince : Date.now(); p.connected = false; }
      r.version++; rooms.set(r.code, r);
    }
  } catch (e) { console.error('No se pudo recuperar rooms.json. Conserva el archivo y revisa su contenido.', e.message); process.exit(1); }
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (path === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size, capacity: MAX_PLAYERS })); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const allowed = path === '/' ? '/public/index.html' : path.startsWith('/shared/') ? path : path === '/vendor/three.module.js' ? '/node_modules/three/build/three.module.js' : path === '/vendor/three.core.js' ? '/node_modules/three/build/three.core.js' : `/public${path}`;
  const file = resolve(ROOT, `.${allowed}`);
  if (!(file.startsWith(`${ROOT}/public/`) || file.startsWith(`${ROOT}/shared/`) || file === `${ROOT}/node_modules/three/build/three.module.js` || file === `${ROOT}/node_modules/three/build/three.core.js`) || !mime[extname(file)]) { res.writeHead(404).end(); return; }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'Content-Type': `${mime[extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end('No encontrado'); }
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function snapshot(r, p) {
  const current = r.game?.players[r.game.turn];
  return { type: 'state', code: r.code, roomName: r.name, maxPlayers: r.capacity, hostId: r.hostId, meId: p.id, status: r.status, version: r.version, practice: r.practice, serverTime: Date.now(), disconnectTimeoutMs: DISCONNECT_TIMEOUT_MS,
    turnDeadline: r.status === 'playing' && current?.id === p.id && !p.autopilot && !current.skip ? r.turnClock?.deadline || null : null, autoTurnLimit: AUTO_TURN_LIMIT, rematch: r.rematch || null,
    members: r.members.filter(m => !m.eliminated).map(m => ({ id: m.id, name: m.name, connected: m.connected, bot: !!m.bot, offlineSince: m.offlineSince || null, ...(m.id === p.id ? { autopilot: !!m.autopilot, autoTurns: m.autoTurns || 0 } : {}) })), game: r.game ? publicGame(r.game, p.id) : null, history: r.history };
}
function broadcast(r) {
  prepareTurn(r);
  r.version++; r.updatedAt = Date.now(); save();
  for (const p of r.members) if (!p.eliminated) { const ws = sockets.get(p.token); if (ws) send(ws, snapshot(r, p)); }
  schedule(r); scheduleOffline(r); scheduleRematch(r);
}
function remember(r) {
  const e = r.game.lastEvent;
  if (e && r.history.at(-1)?.sequence !== e.sequence) r.history.push({ ...e, at: Date.now() });
  r.history = r.history.slice(-18);
  if (r.game.winnerId) r.status = 'finished';
  if (r.game.abandoned) r.status = 'closed';
}
function expireAbsent(r) {
  if (r.status !== 'lobby' && r.status !== 'playing') return false;
  const expired = r.members.filter(m => !m.bot && !m.connected && !m.eliminated && m.offlineSince && Date.now() - m.offlineSince >= DISCONNECT_TIMEOUT_MS);
  if (!expired.length) return false;
  eliminateMembers(r, expired, { kind: 'disconnect' });
  broadcast(r); return true;
}
function detachMember(r, p, type, message) {
  const ws = sockets.get(p.token);
  if (ws) { send(ws, { type, message }); ws.token = null; ws.roomCode = null; sockets.delete(p.token); }
}
function eliminateMembers(r, members, reason) {
  for (const m of members) { m.eliminated = true; m.eliminationReason = reason.kind; m.autopilot = false; }
  if (r.game) { eliminatePlayers(r.game, members.map(m => m.id), () => randomInt(0x100000000) / 0x100000000, reason); remember(r); }
  const active = r.members.filter(m => !m.eliminated);
  if (!active.some(m => m.id === r.hostId)) r.hostId = (active.find(m => m.connected) || active[0])?.id || null;
  for (const m of members) detachMember(r, m, 'eliminated', reason.kind === 'autopilot' ? `Quedaste eliminado tras ${AUTO_TURN_LIMIT} turnos en piloto automático. Tus cartas volvieron al mazo.` : 'Quedaste eliminado tras cinco minutos de ausencia. Puedes entrar en una nueva partida.');
}
function scheduleOffline(r) {
  clearTimeout(offlineTimers.get(r.code)); offlineTimers.delete(r.code);
  if (r.status !== 'lobby' && r.status !== 'playing') return;
  const deadlines = r.members.filter(m => !m.bot && !m.connected && !m.eliminated && m.offlineSince).map(m => m.offlineSince + DISCONNECT_TIMEOUT_MS);
  if (!deadlines.length) return;
  offlineTimers.set(r.code, setTimeout(() => { if (rooms.has(r.code)) { if (!expireAbsent(r)) scheduleOffline(r); } }, Math.max(1, Math.min(...deadlines) - Date.now())));
}
function chooseBot(g, p) {
  const actions = legalActions(g, p.id);
  const score = a => {
    const c = p.hand.find(c => c.id === a.cardId), target = g.players.find(p => p.id === a.targetPlayerId), o = target?.body.find(o => o.card.id === a.targetOrganId);
    if (c.type === 'organ') return 80;
    if (c.special === 'thief') return 78;
    if (c.special === 'contagion') return 85;
    if (c.special === 'error') return (healthyCount(target) - healthyCount(p)) * 25;
    if (c.special === 'transplant') return a.targetPlayerId === p.id || a.otherPlayerId === p.id ? 5 : -20;
    if (c.special === 'glove') return 25;
    if (c.type === 'medicine') return target.id === p.id ? status(o) === 'infected' ? 90 : 45 : -15;
    if (c.type === 'virus') return target.id === p.id ? -50 : 35 + healthyCount(target) * 6;
    return 0;
  };
  actions.sort((a, b) => score(b) - score(a));
  return actions.length && score(actions[0]) > 0 ? { type: 'play', key: actions[0].key } : { type: 'discard', cardIds: p.hand.map(c => c.id) };
}
function prepareTurn(r) {
  if (r.status !== 'playing' || !r.members.some(m => !m.bot && !m.eliminated && m.connected)) { r.turnClock = null; return; }
  const p = r.game.players[r.game.turn], m = r.members.find(m => m.id === p.id);
  const key = `${p.id}:${r.game.sequence}`;
  // Broadcasts and reconnections must not extend another player's turn.
  if (r.turnClock?.key !== key) r.turnClock = { key, deadline: Date.now() + (m.bot || m.autopilot ? AUTO_DELAY_MS : p.skip ? 1400 : TURN_TIMEOUT_MS) };
}
function schedule(r) {
  clearTimeout(timers.get(r.code)); timers.delete(r.code);
  if (r.status !== 'playing' || !r.turnClock) return;
  const p = r.game.players[r.game.turn], m = r.members.find(m => m.id === p.id);
  const key = r.turnClock.key, delay = Math.max(0, r.turnClock.deadline - Date.now());
  timers.set(r.code, setTimeout(() => {
    if (!rooms.has(r.code) || r.status !== 'playing' || r.turnClock?.key !== key) return;
    try {
      if (!m.bot && !m.autopilot && !p.skip) {
        m.autopilot = true; m.autoTurns = 0; r.turnClock = null;
        broadcast(r); return;
      }
      if (p.skip) refillTurn(r.game);
      else act(r.game, p.id, chooseBot(r.game, p));
      if (!m.bot && m.autopilot) m.autoTurns = (m.autoTurns || 0) + 1;
      remember(r);
      if (r.status === 'playing' && m.autopilot && m.autoTurns >= AUTO_TURN_LIMIT) {
        eliminateMembers(r, [m], { kind: 'autopilot', turns: AUTO_TURN_LIMIT });
      }
      broadcast(r);
    } catch (e) { console.error('Error de turno automático:', e.message); }
  }, delay));
}
function clearRoomTimers(code) {
  for (const map of [timers, offlineTimers, rematchTimers]) { clearTimeout(map.get(code)); map.delete(code); }
}
function resolveRematch(r, expired = false) {
  const vote = r.rematch;
  if (r.status !== 'finished' || vote?.status !== 'pending') return false;
  const accepted = r.members.filter(m => !m.eliminated && m.connected && vote.acceptedIds.includes(m.id));
  const allAnswered = vote.eligibleIds.every(id => vote.acceptedIds.includes(id) || vote.declinedIds.includes(id));
  const allAcceptedPresent = vote.acceptedIds.every(id => accepted.some(m => m.id === id));
  if (!expired && !(allAnswered && allAcceptedPresent)) return false;
  if (accepted.length < 2) {
    vote.status = 'cancelled'; vote.message = 'La revancha necesita al menos dos jugadores que confirmen y estén conectados.';
    return true;
  }
  const excluded = r.members.filter(m => !accepted.includes(m));
  r.members = accepted;
  if (!accepted.some(m => m.id === r.hostId)) r.hostId = accepted.find(m => m.id === vote.requestedBy)?.id || accepted[0].id;
  begin(r);
  for (const m of excluded) detachMember(r, m, 'rematchExcluded', 'La revancha comenzó con quienes confirmaron y estaban conectados. Puedes entrar en otra sala.');
  return true;
}
function scheduleRematch(r) {
  clearTimeout(rematchTimers.get(r.code)); rematchTimers.delete(r.code);
  if (r.status !== 'finished' || r.rematch?.status !== 'pending') return;
  rematchTimers.set(r.code, setTimeout(() => {
    if (rooms.has(r.code) && resolveRematch(r, true)) broadcast(r);
  }, Math.max(0, r.rematch.deadline - Date.now())));
}
function rematch(r, p, msg) {
  if (r.status !== 'finished') throw new Error('La partida todavía no ha terminado.');
  if (r.rematch?.status === 'pending' && Date.now() >= r.rematch.deadline) {
    resolveRematch(r, true); broadcast(r); return;
  }
  if (msg.type === 'rematch') {
    if (r.rematch?.status !== 'pending') {
      if (msg.version !== r.version) throw new Error('La mesa se actualizó. Vuelve a solicitar la revancha.');
      const eligible = r.members.filter(m => !m.eliminated);
      if (eligible.length < 2) throw new Error('Necesitas al menos dos jugadores para una revancha.');
      r.rematch = { id: id(), status: 'pending', requestedBy: p.id, deadline: Date.now() + REMATCH_TIMEOUT_MS,
        eligibleIds: eligible.map(m => m.id), acceptedIds: [p.id, ...eligible.filter(m => m.bot).map(m => m.id)], declinedIds: [] };
    } else {
      if (!r.rematch.acceptedIds.includes(p.id)) r.rematch.acceptedIds.push(p.id);
      r.rematch.declinedIds = r.rematch.declinedIds.filter(id => id !== p.id);
    }
  } else {
    if (r.rematch?.status !== 'pending' || msg.rematchId !== r.rematch.id) throw new Error('Esta invitación a la revancha ya no está disponible.');
    if (typeof msg.accept !== 'boolean') throw new Error('Confirma si quieres jugar la revancha.');
    r.rematch.acceptedIds = r.rematch.acceptedIds.filter(id => id !== p.id);
    r.rematch.declinedIds = r.rematch.declinedIds.filter(id => id !== p.id);
    r.rematch[msg.accept ? 'acceptedIds' : 'declinedIds'].push(p.id);
  }
  resolveRematch(r); broadcast(r);
}
function name(value, fallback) {
  if (typeof value !== 'string') { if (fallback) return fallback; throw new Error('Escribe tu nombre.'); }
  const s = value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24); if (!s) { if (fallback) return fallback; throw new Error('Escribe tu nombre.'); } return s;
}
function membership(ws) {
  const r = rooms.get(ws.roomCode), p = r?.members.find(p => p.token === ws.token);
  if (!r || !p || p.eliminated || sockets.get(p.token) !== ws) throw new Error('Tu sesión no está disponible. Vuelve a entrar.'); return { r, p };
}
function attach(ws, r, p) {
  const previous = sockets.get(p.token);
  sockets.set(p.token, ws); ws.roomCode = r.code; ws.token = p.token;
  if (previous && previous !== ws) previous.close(4001, 'Sesión abierta en otra conexión');
  p.connected = true; p.offlineSince = null;
  send(ws, { type: 'session', code: r.code, token: p.token }); resolveRematch(r); broadcast(r);
}
function begin(r) {
  const active = r.members.filter(m => !m.eliminated);
  if (active.length < 2) throw new Error('Necesitas al menos dos jugadores.');
  if (active.some(m => !m.connected)) throw new Error('Espera a que todos los jugadores se conecten.');
  // Unbiased cryptographic shuffle at the server; tests inject deterministic randomness.
  r.game = newGame(active.map(m => ({ id: m.id, name: m.name, bot: m.bot })), () => randomInt(0x100000000) / 0x100000000);
  for (const m of active) { m.autopilot = false; m.autoTurns = 0; }
  r.status = 'playing'; r.history = []; r.turnClock = null; r.rematch = null;
}
wss.on('connection', (ws, req) => {
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) { ws.close(1008, 'Origen no permitido'); return; } } catch { ws.close(1008); return; }
  }
  ws.alive = true; ws.bucket = { start: Date.now(), count: 0 };
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { type: 'hello', maxPlayers: MAX_PLAYERS });
  ws.on('message', raw => {
    try {
      if (Date.now() - ws.bucket.start > 10_000) ws.bucket = { start: Date.now(), count: 0 };
      if (++ws.bucket.count > 60) throw new Error('Demasiadas solicitudes. Espera unos segundos.');
      const msg = JSON.parse(raw.toString()); if (!msg || typeof msg !== 'object') throw new Error('Solicitud inválida.');
      if (msg.type === 'resume') {
        if (ws.token) throw new Error('Ya tienes una sesión abierta.');
        const r = rooms.get(msg.code); if (r) expireAbsent(r);
        if (r?.rematch?.status === 'pending' && Date.now() >= r.rematch.deadline) { resolveRematch(r, true); broadcast(r); }
        const p = r?.members.find(p => typeof msg.token === 'string' && p.token === msg.token && !p.bot);
        if (p?.eliminated) { send(ws, { type: 'eliminated', message: p.eliminationReason === 'autopilot' ? 'Quedaste eliminado por inactividad en piloto automático. Puedes entrar en una nueva partida.' : 'Quedaste eliminado tras cinco minutos de ausencia. Puedes entrar en una nueva partida.' }); return; }
        if (!p) { send(ws, { type: 'sessionExpired' }); return; } attach(ws, r, p); return;
      }
      if (msg.type === 'create' || msg.type === 'join' || msg.type === 'practice') {
        if (ws.token) throw new Error('Sal de tu sala actual antes de entrar en otra.');
        const playerName = name(msg.name); let r;
        if (msg.type === 'join') {
          r = rooms.get(typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '');
          if (!r) throw new Error('No encontramos esa sala. Revisa el código.');
          if (r.status !== 'lobby' || r.practice) throw new Error('La partida ya empezó.');
          expireAbsent(r);
          if (r.members.filter(p => !p.eliminated).length >= r.capacity) throw new Error('La sala está llena.');
          if (r.members.some(p => !p.eliminated && p.name.toLowerCase() === playerName.toLowerCase())) throw new Error('Ese nombre ya está en la sala. Elige otro.');
        } else {
          if (rooms.size >= MAX_ROOMS) throw new Error('El servidor está lleno. Intenta más tarde.');
          let code; do { code = [...randomBytes(6)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join(''); } while (rooms.has(code));
          const capacity = msg.maxPlayers === undefined ? MAX_PLAYERS : msg.maxPlayers;
          if (!Number.isInteger(capacity) || capacity < 2 || capacity > MAX_PLAYERS) throw new Error(`Elige entre 2 y ${MAX_PLAYERS} plazas.`);
          r = { code, name: name(msg.roomName, 'Laboratorio privado'), capacity, members: [], hostId: null, status: 'lobby', game: null, version: 0, history: [], practice: msg.type === 'practice', updatedAt: Date.now() }; rooms.set(code, r);
        }
        const p = { id: id(), token: id(), name: playerName, connected: true, bot: false };
        r.members.push(p); r.hostId ||= p.id;
        if (r.practice) { for (let i = 1; i < r.capacity; i++) r.members.push({ id: id(), token: id(), name: ['Dra. Lima', 'Dr. Zeta', 'Dra. Mora', 'Dr. Kiwi', 'Dra. Azul', 'Dr. Ámbar', 'Dra. Coral'][i - 1], bot: true, connected: true }); begin(r); }
        attach(ws, r, p); return;
      }
      const { r, p } = membership(ws);
      if (msg.type === 'sync') { send(ws, snapshot(r, p)); return; }
      if (msg.type === 'leave') {
        sockets.delete(p.token); ws.token = null; ws.roomCode = null;
        if (r.status === 'lobby') {
          r.members.splice(r.members.indexOf(p), 1); if (r.hostId === p.id) r.hostId = r.members.find(m => !m.eliminated)?.id || null;
          if (!r.members.some(m => !m.eliminated)) { rooms.delete(r.code); clearRoomTimers(r.code); save(); } else broadcast(r);
        } else if (r.practice) { rooms.delete(r.code); clearRoomTimers(r.code); save(); }
        else {
          p.connected = false; p.offlineSince = Date.now();
          if (r.rematch?.status === 'pending') {
            r.rematch.acceptedIds = r.rematch.acceptedIds.filter(id => id !== p.id);
            if (!r.rematch.declinedIds.includes(p.id)) r.rematch.declinedIds.push(p.id);
            resolveRematch(r);
          }
          broadcast(r);
        }
        send(ws, { type: 'left' }); return;
      }
      // Votes and taking control do not depend on unrelated state revisions.
      if (msg.type === 'rematch' || msg.type === 'rematchReply') { rematch(r, p, msg); return; }
      if (msg.type === 'takeover') {
        if (r.status !== 'playing' || !p.autopilot) throw new Error('No estás en piloto automático.');
        p.autopilot = false; p.autoTurns = 0;
        if (r.game.players[r.game.turn].id === p.id) r.turnClock = null;
        broadcast(r); return;
      }
      if (msg.version !== r.version) { send(ws, snapshot(r, p)); throw new Error('La mesa se actualizó. Vuelve a seleccionar tu jugada.'); }
      if (msg.type === 'start') {
        if (r.hostId !== p.id) throw new Error('Solo el anfitrión puede iniciar la partida.');
        if (r.status !== 'lobby') throw new Error('No se puede iniciar ahora.');
        begin(r); broadcast(r); return;
      }
      if (msg.type === 'action') {
        if (r.status !== 'playing') throw new Error('No hay una partida en curso.');
        if (!msg.action || typeof msg.action !== 'object') throw new Error('Jugada inválida.');
        act(r.game, p.id, msg.action); p.autopilot = false; p.autoTurns = 0; remember(r); broadcast(r); return;
      }
      throw new Error('Solicitud desconocida.');
    } catch (e) { send(ws, { type: 'error', message: e instanceof SyntaxError ? 'Solicitud inválida.' : e.message }); }
  });
  ws.on('close', () => {
    if (!ws.token || sockets.get(ws.token) !== ws) return;
    const r = rooms.get(ws.roomCode), p = r?.members.find(p => p.token === ws.token); sockets.delete(ws.token);
    if (p) { p.connected = false; p.offlineSince = Date.now(); broadcast(r); }
  });
  ws.on('error', () => {});
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  for (const [code, r] of rooms) if (!r.members.some(p => p.connected && !p.bot && !p.eliminated) && Date.now() - r.updatedAt > (r.status === 'lobby' ? 30 * 60_000 : 24 * 3600_000)) { rooms.delete(code); clearRoomTimers(code); save(); }
}, 30_000);
heartbeat.unref();
server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`VIRUS! listo en http://localhost:${server.address().port} · ${MAX_PLAYERS} plazas por sala`));
for (const r of rooms.values()) { if (!expireAbsent(r)) { prepareTurn(r); schedule(r); scheduleOffline(r); scheduleRematch(r); } }
function shutdown() { clearInterval(heartbeat); for (const code of rooms.keys()) clearRoomTimers(code); save(); for (const ws of wss.clients) ws.close(1001, 'Reiniciando servidor'); wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
