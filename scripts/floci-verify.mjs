import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const base = 'http://localhost:3100';
const origin = 'http://localhost:4566';
const site = `${origin}/virus-laboratorio-local/`;
const password = readFileSync(new URL('../tmp/floci/admin-password.txt', import.meta.url), 'utf8').trim();
let cookie;
async function api(path, data, admin = false) {
  const r = await fetch(`${base}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(admin ? { cookie } : { Origin: origin }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
  const value = await r.json();
  assert.ok(r.ok, value.error);
  return { value, headers: r.headers };
}
async function connect() {
  const ws = new WebSocket(base.replace('http', 'ws'), { origin });
  const messages = [], waiters = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw); messages.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(msg); }
  });
  const next = match => new Promise((resolve, reject) => { const w = { match, resolve, timer: setTimeout(() => reject(new Error('No llegó el mensaje WebSocket esperado.')), 6000) }; waiters.push(w); });
  await once(ws, 'open');
  if (!messages.some(m => m.type === 'hello')) await next(m => m.type === 'hello');
  return { ws, messages, next, request(msg) { const promise = next(m => m.type === 'state' || m.type === 'error'); ws.send(JSON.stringify(msg)); return promise; } };
}
function lifecycle(action) { console.log(`EC2 local: ${action}`); execFileSync(process.execPath, ['scripts/floci.mjs', action], { stdio: 'pipe' }); }

console.log('Comprobando los recursos estáticos publicados…');
for (const file of ['index.html', 'app.js', 'config.js', 'availability.css', 'shared/game.js', 'vendor/three.module.js', 'vendor/three.core.js']) {
  const r = await fetch(site + file); assert.equal(r.status, 200, file);
  if (file.endsWith('.js')) assert.match(r.headers.get('content-type'), /javascript/);
}
const preflight = await fetch(`${base}/api/access`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
const login = await api('admin/login', { password }, true); cookie = login.headers.get('set-cookie').split(';')[0];
const issued = await api('admin/codes', { kind: 'full', label: 'Prueba S3 / EC2 en Floci', expiresAt: Date.now() + 7 * 86400000 }, true);
const code = issued.value.codes[0].code;
writeFileSync(new URL('../tmp/floci/demo-access.txt', import.meta.url), `${code}\n`, { mode: 0o600 });
const token = (await api('access', { code })).value.token;
const clients = [];
let stopped = false;
try {
  const a = await connect(); clients.push(a);
  const lobby = await a.request({ type: 'create', name: 'Prueba Ana', maxPlayers: 2, roomName: 'S3 + EC2 local', accessToken: token });
  assert.equal(lobby.status, 'lobby');
  const b = await connect(); clients.push(b);
  await b.request({ type: 'join', code: lobby.code, name: 'Prueba Beto', accessToken: token });
  const sync = await a.request({ type: 'sync' });
  const game = await a.request({ type: 'start', version: sync.version });
  assert.equal(game.status, 'playing');
  const moved = await a.request({ type: 'action', version: game.version, action: { type: 'discard', cardIds: [game.game.hand[0].id] } });
  assert.equal(moved.game.discardCount, 1);
  const session = a.messages.findLast(m => m.type === 'session');
  console.log('Partida de dos jugadores y jugada real: correctas.');
  stopped = true; lifecycle('stop');
  assert.equal((await fetch(site + 'index.html')).status, 200);
  await assert.rejects(fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }));
  console.log('EC2 apagada; S3 sigue disponible.');
  lifecycle('start'); stopped = false;
  const returned = await connect(); clients.push(returned);
  const restored = await returned.request({ ...session, type: 'resume' });
  assert.equal(restored.status, 'playing'); assert.equal(restored.meId, moved.meId);
  assert.deepEqual(restored.game.hand, moved.game.hand); assert.equal(restored.game.discardCount, 1);
  assert.equal((await api('access', { token })).value.access.kind, 'full');
  console.log('Mismo asiento, mano, descarte y acceso tras el reinicio: correctos.');
  const left = returned.next(m => m.type === 'left'); returned.ws.send(JSON.stringify({ type: 'leave' })); await left;
} finally {
  clients.forEach(c => c.ws.terminate());
  if (stopped) lifecycle('start');
}
console.log('Prueba Floci completada. Código para el navegador: tmp/floci/demo-access.txt');
