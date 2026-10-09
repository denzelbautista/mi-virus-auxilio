import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { allowedOrigin, playerCors } from './origins.js';
import { secureRequest, clientAddress } from './proxy.js';

export function adminApi({ store, rooms, createRoom, maxPlayers, dbFile }) {
  const passwordFile = resolve(dirname(dbFile), 'admin-password.txt');
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(18).toString('base64url'), { mode: 0o600, flag: 'wx' });
    chmodSync(passwordFile, 0o600);
    password = readFileSync(passwordFile, 'utf8').trim();
    console.log(`Administración: /admin · contraseña local en ${passwordFile}`);
  }
  if (password.length < 12 || password.length > 256) throw new Error('ADMIN_PASSWORD debe tener de 12 a 256 caracteres.');
  const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 32), attempts = new Map();
  const reply = (res, status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(JSON.stringify(body)); };
  const cookie = req => /(?:^|;\s*)virus_admin=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
  const cookies = (req, value, age) => ({ 'Set-Cookie': `virus_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secureRequest(req) ? '; Secure' : ''}` });
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Se requiere JSON.');
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('Solicitud demasiado grande.'); }
    const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Solicitud inválida.'); return value;
  }
  const expiry = value => {
    if (!Number.isSafeInteger(value) || value <= Date.now() || value > Date.now() + 10 * 366 * 86400_000) throw new Error('Elige una vigencia futura de hasta diez años.'); return value;
  };
  const label = value => typeof value === 'string' ? value.trim().slice(0, 80) : '';
  function rate(req, category, limit) {
    const key = `${category}:${clientAddress(req)}`, now = Date.now();
    if (attempts.size > 5000) for (const [k, v] of attempts) if (now - v.start > 60_000) attempts.delete(k);
    let entry = attempts.get(key); if (!entry || now - entry.start > 60_000) { entry = { start: now, n: 0 }; attempts.set(key, entry); }
    if (++entry.n > limit) return false; return true;
  }
  return async (req, res, path) => {
    if (!path.startsWith('/api/')) return false;
    try {
      const playerEndpoint = path === '/api/access';
      if (!allowedOrigin(req, playerEndpoint)) { reply(res, 403, { error: 'Origen no permitido.' }); return true; }
      if (playerEndpoint) playerCors(req, res);
      if (req.method === 'OPTIONS' && playerEndpoint) {
        const headers = (req.headers['access-control-request-headers'] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (req.headers['access-control-request-method'] !== 'POST' || headers.some(h => h !== 'content-type')) { reply(res, 403, { error: 'Solicitud no permitida.' }); return true; }
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); return true;
      }
      if (!['GET', 'POST'].includes(req.method)) { reply(res, 405, { error: 'Método no permitido.' }); return true; }
      if (path === '/api/access' && req.method === 'POST') {
        if (!rate(req, 'access', 30)) { reply(res, 429, { error: 'Demasiados intentos. Espera un minuto.' }); return true; }
        const data = await body(req); reply(res, 200, data.token ? { access: store.view(store.access(data.token)) } : store.redeem(data.code)); return true;
      }
      if (path === '/api/admin/login' && req.method === 'POST') {
        if (!rate(req, 'login', 8)) { reply(res, 429, { error: 'Demasiados intentos. Espera un minuto.' }); return true; }
        const data = await body(req);
        if (typeof data.password !== 'string' || data.password.length > 256 || !timingSafeEqual(passwordHash, scryptSync(data.password, salt, 32))) { reply(res, 401, { error: 'Contraseña incorrecta.' }); return true; }
        reply(res, 200, { ok: true }, cookies(req, store.adminSession(), 12 * 3600)); return true;
      }
      if (!path.startsWith('/api/admin/')) { reply(res, 404, { error: 'No encontrado.' }); return true; }
      if (!store.isAdmin(cookie(req))) { reply(res, 401, { error: 'Inicia sesión como administrador.' }); return true; }
      if (path === '/api/admin/logout' && req.method === 'POST') { store.logout(cookie(req)); reply(res, 200, { ok: true }, cookies(req, '', 0)); return true; }
      if (path === '/api/admin/overview' && req.method === 'GET') {
        const active = [...rooms.values()].filter(r => r.status === 'lobby' || r.status === 'playing').map(r => ({
          code: r.code, name: r.name, capacity: r.capacity, status: r.status, practice: r.practice,
          members: r.members.filter(m => !m.eliminated).map(m => ({ name: m.name, connected: m.connected, bot: !!m.bot })),
          createdAt: r.createdAt, startedAt: r.startedAt || null, durationMs: r.status === 'playing' ? Date.now() - r.startedAt : 0,
          matchNumber: r.matchNumber || 0, maxGames: r.maxGames || null
        }));
        const roomsById = new Map([...rooms.values()].map(r => [r.id, r]));
        const codes = store.codes().map(({ roomId, roomIds, ...code }) => ({ ...code, rooms: [...new Set([roomId, ...roomIds])].map(id => roomsById.get(id)).filter(Boolean).map(r => ({ code: r.code, name: r.name, status: r.status })) }));
        reply(res, 200, { rooms: active, codes, summary: store.summary(), maxPlayers, serverTime: Date.now() }); return true;
      }
      if (path === '/api/admin/history' && req.method === 'GET') {
        const offset = Number(new URL(req.url, 'http://localhost').searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Página inválida.');
        reply(res, 200, { matches: store.history(50, offset), offset }); return true;
      }
      if (path === '/api/admin/codes' && req.method === 'POST') {
        const data = await body(req);
        if (!['limited', 'full'].includes(data.kind)) throw new Error('Tipo de acceso inválido.');
        if (data.kind === 'limited' && ![1, 2].includes(data.maxRooms)) throw new Error('El código temporal admite una o dos salas.');
        const issued = store.issue({ kind: data.kind, label: label(data.label), expiresAt: expiry(data.expiresAt), maxRooms: data.kind === 'full' ? null : data.maxRooms });
        reply(res, 201, { codes: [issued] }); return true;
      }
      if (path === '/api/admin/codes/revoke' && req.method === 'POST') { const data = await body(req); store.revoke(data.id); reply(res, 200, { ok: true }); return true; }
      if (path === '/api/admin/codes/revoke-room' && req.method === 'POST') { const data = await body(req); reply(res, 200, { ok: true, revoked: store.revokeRoom(data.id) }); return true; }
      if (path === '/api/admin/codes/reveal' && req.method === 'POST') { const data = await body(req); reply(res, 200, { codes: store.reveal(data.ids) }); return true; }
      if (path === '/api/admin/codes/recover' && req.method === 'POST') { const data = await body(req); reply(res, 200, { codes: [store.recoverSecret(data.id)] }); return true; }
      if (path === '/api/admin/rooms' && req.method === 'POST') {
        const data = await body(req), expiresAt = expiry(data.expiresAt);
        if (!Number.isInteger(data.capacity) || data.capacity < 2 || data.capacity > maxPlayers) throw new Error(`Elige de 2 a ${maxPlayers} jugadores.`);
        if (!Number.isInteger(data.maxGames) || data.maxGames < 0 || data.maxGames > 1000) throw new Error('Elige de 1 a 1000 partidas, o cero para ilimitadas.');
        const r = createRoom({ maxPlayers: data.capacity, roomName: label(data.name), adminCreated: true, maxGames: data.maxGames, expiresAt });
        const codes = Array.from({ length: r.capacity }, (_, i) => store.issue({ kind: 'room', label: `${r.name} · Jugador ${i + 1}`, expiresAt, maxRooms: 1, roomId: r.id, roomCode: r.code }));
        reply(res, 201, { room: { code: r.code, capacity: r.capacity, maxGames: r.maxGames }, codes }); return true;
      }
      reply(res, 404, { error: 'No encontrado.' });
    } catch (e) { reply(res, 400, { error: e instanceof SyntaxError ? 'Solicitud inválida.' : e.message }); }
    return true;
  };
}
