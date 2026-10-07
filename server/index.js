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
const rooms = new Map(), sockets = new Map(), timers = new Map(), offlineTimers = new Map();
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
  return { type: 'state', code: r.code, roomName: r.name, maxPlayers: r.capacity, hostId: r.hostId, meId: p.id, status: r.status, version: r.version, practice: r.practice, serverTime: Date.now(), disconnectTimeoutMs: DISCONNECT_TIMEOUT_MS,
    members: r.members.filter(m => !m.eliminated).map(m => ({ id: m.id, name: m.name, connected: m.connected, bot: !!m.bot, offlineSince: m.offlineSince || null })), game: r.game ? publicGame(r.game, p.id) : null, history: r.history };
}
function broadcast(r) {
  r.version++; r.updatedAt = Date.now(); save();
  for (const p of r.members) if (!p.eliminated) { const ws = sockets.get(p.token); if (ws) send(ws, snapshot(r, p)); }
  schedule(r); scheduleOffline(r);
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
  for (const m of expired) m.eliminated = true;
  if (r.game) { eliminatePlayers(r.game, expired.map(m => m.id), () => randomInt(0x100000000) / 0x100000000); remember(r); }
  const active = r.members.filter(m => !m.eliminated);
  if (!active.some(m => m.id === r.hostId)) r.hostId = (active.find(m => m.connected) || active[0])?.id || null;
  broadcast(r); return true;
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
function schedule(r) {
  clearTimeout(timers.get(r.code)); timers.delete(r.code);
  if (r.status !== 'playing') return;
  const p = r.game.players[r.game.turn], m = r.members.find(m => m.id === p.id);
  // Empty rooms pause; otherwise automated turns would keep updating their TTL forever.
  if (!r.members.some(m => !m.bot && !m.eliminated && m.connected)) return;
  // Keep the absent player's turn intact until reconnection or elimination.
  if (!m.connected || !p.skip && !m.bot) return;
  const delay = m.bot ? 1800 : 1400;
  timers.set(r.code, setTimeout(() => {
    if (!rooms.has(r.code) || r.status !== 'playing') return;
    try {
      if (p.skip) refillTurn(r.game);
      else act(r.game, p.id, chooseBot(r.game, p));
      remember(r); broadcast(r);
    } catch (e) { console.error('Error de turno automático:', e.message); }
  }, delay));
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
  send(ws, { type: 'session', code: r.code, token: p.token }); broadcast(r);
}
function begin(r) {
  const active = r.members.filter(m => !m.eliminated);
  if (active.length < 2) throw new Error('Necesitas al menos dos jugadores.');
  if (active.some(m => !m.connected)) throw new Error('Espera a que todos los jugadores se conecten.');
  // Unbiased cryptographic shuffle at the server; tests inject deterministic randomness.
  r.game = newGame(active.map(m => ({ id: m.id, name: m.name, bot: m.bot })), () => randomInt(0x100000000) / 0x100000000);
  r.status = 'playing'; r.history = [];
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
        const p = r?.members.find(p => typeof msg.token === 'string' && p.token === msg.token && !p.bot);
        if (p?.eliminated) { send(ws, { type: 'eliminated', message: 'Quedaste eliminado tras cinco minutos de ausencia. Puedes entrar en una nueva partida.' }); return; }
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
          if (!r.members.some(m => !m.eliminated)) { rooms.delete(r.code); clearTimeout(timers.get(r.code)); clearTimeout(offlineTimers.get(r.code)); save(); } else broadcast(r);
        } else if (r.practice) { rooms.delete(r.code); clearTimeout(timers.get(r.code)); clearTimeout(offlineTimers.get(r.code)); save(); }
        else { p.connected = false; p.offlineSince = Date.now(); broadcast(r); }
        send(ws, { type: 'left' }); return;
      }
      if (msg.version !== r.version) { send(ws, snapshot(r, p)); throw new Error('La mesa se actualizó. Vuelve a seleccionar tu jugada.'); }
      if (msg.type === 'start' || msg.type === 'rematch') {
        if (r.hostId !== p.id) throw new Error('Solo el anfitrión puede iniciar la partida.');
        if (msg.type === 'start' && r.status !== 'lobby' || msg.type === 'rematch' && r.status !== 'finished') throw new Error('No se puede iniciar ahora.');
        begin(r); broadcast(r); return;
      }
      if (msg.type === 'action') {
        if (r.status !== 'playing') throw new Error('No hay una partida en curso.');
        if (!msg.action || typeof msg.action !== 'object') throw new Error('Jugada inválida.');
        act(r.game, p.id, msg.action); remember(r); broadcast(r); return;
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
  for (const [code, r] of rooms) if (!r.members.some(p => p.connected && !p.bot && !p.eliminated) && Date.now() - r.updatedAt > (r.status === 'lobby' ? 30 * 60_000 : 24 * 3600_000)) { rooms.delete(code); clearTimeout(timers.get(code)); clearTimeout(offlineTimers.get(code)); save(); }
}, 30_000);
heartbeat.unref();
server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`VIRUS! listo en http://localhost:${server.address().port} · ${MAX_PLAYERS} plazas por sala`));
for (const r of rooms.values()) { if (!expireAbsent(r)) { schedule(r); scheduleOffline(r); } }
function shutdown() { clearInterval(heartbeat); for (const t of timers.values()) clearTimeout(t); for (const t of offlineTimers.values()) clearTimeout(t); save(); for (const ws of wss.clients) ws.close(1001, 'Reiniciando servidor'); wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
