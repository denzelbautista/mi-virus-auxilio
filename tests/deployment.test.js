import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { start } from './helpers.js';
import { client } from './helpers.js';

test('Separate S3 origin: health, access preflight and redemption work; admin remains same-origin', async t => {
  const origin = 'http://localhost:4566';
  const dir = mkdtempSync(`${tmpdir()}/virus-deploy-`);
  const server = await start(`${dir}/rooms.json`, 300000, { FRONTEND_ORIGINS: origin });
  t.after(() => server.stop());
  const health = await fetch(`${server.base}/health`, { headers: { Origin: origin } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), origin);
  const preflight = await fetch(`${server.base}/api/access`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  const access = await fetch(`${server.base}/api/access`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: server.accessToken }) });
  assert.equal(access.status, 200);
  assert.equal(access.headers.get('access-control-allow-origin'), origin);
  for (const url of ['/health', '/api/access', '/api/admin/overview']) {
    const r = await fetch(server.base + url, { headers: { Origin: 'http://evil.example', cookie: server.cookie } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  const admin = await fetch(`${server.base}/api/admin/overview`, { headers: { Origin: origin, cookie: server.cookie } });
  assert.equal(admin.status, 403);
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-password-123' }) });
  assert.equal(login.status, 403);
  const sameOrigin = await fetch(`${server.base}/api/admin/overview`, { headers: { Origin: server.base, cookie: server.cookie } });
  assert.equal(sameOrigin.status, 200);
  const invalidPreflight = await fetch(`${server.base}/api/access`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE' } });
  assert.equal(invalidPreflight.status, 403);
});

test('Separate S3 origin: WebSocket admits the configured player origin and rejects other origins', async t => {
  const origin = 'http://localhost:4566';
  const dir = mkdtempSync(`${tmpdir()}/virus-ws-origin-`);
  const server = await start(`${dir}/rooms.json`, 300000, { FRONTEND_ORIGINS: origin });
  const sockets = [];
  t.after(async () => { sockets.forEach(ws => ws.terminate()); await server.stop(); });
  const allowed = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin }); sockets.push(allowed);
  const hello = once(allowed, 'message');
  assert.equal(JSON.parse((await hello)[0]).type, 'hello');
  const created = once(allowed, 'message');
  allowed.send(JSON.stringify({ type: 'create', name: 'Desde S3', maxPlayers: 2, accessToken: server.accessToken }));
  assert.equal(JSON.parse((await created)[0]).type, 'session');
  const denied = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: 'http://evil.example' }); sockets.push(denied);
  const [code] = await once(denied, 'close');
  assert.equal(code, 1008);
});

test('Trusted proxy secures admin cookies and keeps rate limits separate for different client IPs', async t => {
  const dir = mkdtempSync(`${tmpdir()}/virus-proxy-`);
  const server = await start(`${dir}/rooms.json`, 300000, { TRUST_PROXY: 'true' });
  t.after(() => server.stop());
  async function login(ip) {
    return fetch(`${server.base}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.base, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip },
      body: JSON.stringify({ password: 'test-admin-password-123' })
    });
  }
  const valid = await login('192.0.2.1');
  assert.equal(valid.status, 200); assert.match(valid.headers.get('set-cookie'), /; Secure(?:;|$)/);
  for (let i = 0; i < 7; i++) assert.equal((await login('192.0.2.1')).status, 200);
  assert.equal((await login('192.0.2.1')).status, 429);
  assert.equal((await login('192.0.2.2')).status, 200);
});

test('Default server ignores spoofed forwarding headers for cookies and rate limits', async t => {
  const dir = mkdtempSync(`${tmpdir()}/virus-direct-`), server = await start(`${dir}/rooms.json`, 300000, { TRUST_PROXY: '' });
  t.after(() => server.stop());
  for (let i = 0; i < 7; i++) {
    const response = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': `192.0.2.${i + 1}` }, body: JSON.stringify({ password: 'test-admin-password-123' }) });
    assert.equal(response.status, 200); assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
  }
  const blocked = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.250' }, body: JSON.stringify({ password: 'test-admin-password-123' }) });
  assert.equal(blocked.status, 429);
});

test('Four hours of server downtime preserve disconnected seats and pause turn and rematch deadlines', async t => {
  const dir = mkdtempSync(`${tmpdir()}/virus-downtime-`), file = `${dir}/rooms.json`, clients = [];
  let server = await start(file, 5000);
  t.after(async () => { clients.forEach(c => c.ws.terminate()); await server.stop(); });
  const connect = async () => { const c = client(`ws://127.0.0.1:${server.port}`); clients.push(c); await once(c.ws, 'open'); return c; };
  const request = async (c, msg) => { const wait = c.next(m => m.type === 'state'); c.send(msg); return wait; };
  const a = await connect(), lobby = await request(a, { type: 'create', name: 'Ana', maxPlayers: 2 });
  const b = await connect(); await request(b, { type: 'join', code: lobby.code, name: 'Beto' });
  await request(a, { type: 'sync' });
  await request(a, { type: 'start', version: a.state().version });
  const session = a.session(), hand = a.state().game.hand;
  const offline = b.next(m => m.type === 'state' && m.members.some(p => !p.connected)); a.ws.close(); await offline;
  await server.stop();
  const rooms = JSON.parse(readFileSync(file, 'utf8')), downtime = 4 * 3600000, r = rooms[0];
  r.serverSavedAt -= downtime; r.updatedAt -= downtime; r.turnClock.deadline -= downtime;
  for (const p of r.members) if (p.offlineSince) p.offlineSince -= downtime;
  // Include a separate finished room with a pending rematch to verify its clock too.
  const rematchRoom = structuredClone(r);
  rematchRoom.id = 'pending-rematch'; rematchRoom.code = 'WAIT22'; rematchRoom.status = 'finished';
  rematchRoom.rematch = { id: 'vote', status: 'pending', deadline: Date.now() - downtime + 90000, votes: Object.fromEntries(r.members.map(m => [m.id, 'pending'])) };
  rooms.push(rematchRoom); writeFileSync(file, JSON.stringify(rooms));
  server = await start(file, 5000);
  const returned = await connect(), restored = await request(returned, { ...session, type: 'resume' });
  assert.equal(restored.status, 'playing'); assert.equal(restored.members.length, 2);
  assert.deepEqual(restored.game.hand, hand);
  assert.ok(restored.turnDeadline - Date.now() > 20000);
  const recovered = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(recovered.find(r => r.code === 'WAIT22').rematch.deadline - Date.now() > 85000);
});
