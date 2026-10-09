import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClient } from './build-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'tmp/floci');
const stateFile = resolve(dir, 'state.json');
const endpoint = 'http://localhost:4566';
const bucket = 'virus-laboratorio-local';
const network = 'virus-laboratorio-local';
const relay = 'virus-laboratorio-floci-relay';
const base = 'http://localhost:3100';
const frontend = `${endpoint}/${bucket}/index.html`;
mkdirSync(dir, { recursive: true });

function run(binary, args, { quiet = false } = {}) {
  try {
    return execFileSync(binary, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '', AWS_EC2_METADATA_DISABLED: 'true' }, maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch (error) {
    if (quiet) return null;
    throw new Error(`${binary} ${args.slice(0, 3).join(' ')}: ${error.stderr || error.message}`);
  }
}
function aws(...args) {
  // The profile AND explicit loopback endpoint prevent accidental real-AWS calls.
  const output = run('aws', ['--profile', 'floci', '--endpoint-url', endpoint, '--region', 'us-east-1', '--output', 'json', ...args]);
  return output ? JSON.parse(output) : null;
}
function docker(...args) { return run('docker', args); }
function state() {
  if (!existsSync(stateFile)) throw new Error('Primero ejecuta npm run floci:up.');
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}
async function containerFor(instanceId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ids = docker('ps', '-aq').split('\n').filter(Boolean);
    for (const id of ids) {
      const [info] = JSON.parse(docker('inspect', id));
      if (info.State.Running && (info.Name.includes(instanceId) || Object.values(info.Config.Labels || {}).includes(instanceId))) return id;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`No se encontró el contenedor de ${instanceId}.`);
}
async function waitHealth(online) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    let ready = false;
    try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }); ready = r.ok && (await r.json()).ok === true; } catch {}
    if (ready === online) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`El servidor no llegó al estado ${online ? 'en línea' : 'apagado'}.`);
}
function startGame(container) {
  const ready = run('docker', ['exec', container, 'pidof', 'node'], { quiet: true });
  if (ready !== null) return;
  // EC2's container guest has no systemd. This is the local boot adapter.
  docker('exec', '-d', container, 'sh', '-c', 'cd /app && echo $$ > /app/game.pid && exec env PORT=3000 HOST=0.0.0.0 STATE_FILE=/app/data/rooms.json DB_FILE=/app/data/virus.sqlite FRONTEND_ORIGINS=http://localhost:4566,http://127.0.0.1:4566 node server/index.js > /app/game.log 2>&1');
}
async function publish() {
  await buildClient({ apiBaseUrl: base, adminUrl: `${base}/admin` });
  run('aws', ['--profile', 'floci', '--endpoint-url', endpoint, '--region', 'us-east-1', 's3', 'sync', 'dist/client/', `s3://${bucket}/`, '--cache-control', 'no-cache', '--no-progress', '--only-show-errors']);
}
function describe(instanceId) { return aws('ec2', 'describe-instances', '--instance-ids', instanceId).Reservations[0].Instances[0]; }
async function waitState(instanceId, target) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const current = describe(instanceId).State.Name;
    if (current === target) return;
    if (['terminated', 'shutting-down'].includes(current)) throw new Error('La instancia de prueba fue terminada.');
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`EC2 no llegó al estado ${target}.`);
}
async function startInstance(instanceId) {
  if (describe(instanceId).State.Name === 'stopping') await waitState(instanceId, 'stopped');
  if (describe(instanceId).State.Name === 'stopped') aws('ec2', 'start-instances', '--instance-ids', instanceId);
  await waitState(instanceId, 'running');
}
function printStatus(s) {
  console.log(JSON.stringify({ instanceId: s.instanceId, state: describe(s.instanceId).State.Name, frontend, backend: base, admin: `${base}/admin`, bucket, localAdminPasswordFile: resolve(dir, 'admin-password.txt') }, null, 2));
}

const action = process.argv[2] || 'status';
if (action === 'up') {
  const buckets = aws('s3api', 'list-buckets').Buckets;
  let s = existsSync(stateFile) ? state() : {};
  if (!buckets.some(b => b.Name === bucket)) {
    aws('s3api', 'create-bucket', '--bucket', bucket);
    aws('s3api', 'put-bucket-tagging', '--bucket', bucket, '--tagging', JSON.stringify({ TagSet: [{ Key: 'Project', Value: 'virus-laboratorio' }] }));
  } else {
    const tags = aws('s3api', 'get-bucket-tagging', '--bucket', bucket).TagSet;
    if (!tags.some(t => t.Key === 'Project' && t.Value === 'virus-laboratorio')) throw new Error('El bucket ya existe y no pertenece a esta prueba.');
  }
  aws('s3api', 'put-public-access-block', '--bucket', bucket, '--public-access-block-configuration', JSON.stringify({ BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false }));
  aws('s3api', 'put-bucket-policy', '--bucket', bucket, '--policy', JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'ReadClient', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${bucket}/*` }] }));
  if (!s.instanceId) {
    console.log('Creando EC2 local en Floci…');
    const launched = aws('ec2', 'run-instances', '--image-id', 'ami-alpine', '--instance-type', 't3.small', '--count', '1', '--tag-specifications', JSON.stringify([{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'virus-laboratorio-local' }, { Key: 'Project', Value: 'virus-laboratorio' }] }]));
    s = { instanceId: launched.Instances[0].InstanceId };
    writeFileSync(stateFile, JSON.stringify(s, null, 2));
  }
  await startInstance(s.instanceId);
  const container = await containerFor(s.instanceId);
  console.log('Preparando Node.js y el servidor en la instancia emulada…');
  if (run('docker', ['exec', container, 'pidof', 'node'], { quiet: true }) !== null) {
    docker('exec', container, 'sh', '-c', 'kill -TERM "$(cat /app/game.pid)"');
    const deadline = Date.now() + 10000;
    while (run('docker', ['exec', container, 'pidof', 'node'], { quiet: true }) !== null) {
      if (Date.now() >= deadline) throw new Error('El proceso de juego no se detuvo para actualizar.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  docker('exec', container, 'apk', 'add', '--no-cache', 'nodejs', 'npm');
  docker('exec', container, 'mkdir', '-p', '/app');
  for (const file of ['package.json', 'package-lock.json', 'public', 'server', 'shared']) docker('cp', resolve(root, file), `${container}:/app/`);
  docker('exec', '-w', '/app', container, 'npm', 'ci', '--omit=dev', '--no-audit', '--no-fund');
  if (run('docker', ['network', 'inspect', network], { quiet: true }) === null) docker('network', 'create', '--label', 'com.virus.floci=lab', network);
  const [info] = JSON.parse(docker('inspect', container));
  if (!info.NetworkSettings.Networks[network]) docker('network', 'connect', '--alias', 'virus-backend', network, container);
  if (run('docker', ['inspect', relay], { quiet: true }) === null) {
    docker('run', '-d', '--name', relay, '--label', 'com.virus.floci=lab', '--restart', 'unless-stopped', '--network', network, '-p', '127.0.0.1:3100:3100', 'alpine/socat', 'TCP-LISTEN:3100,fork,reuseaddr', 'TCP:virus-backend:3000');
  } else docker('start', relay);
  startGame(container);
  await waitHealth(true);
  docker('cp', `${container}:/app/data/admin-password.txt`, resolve(dir, 'admin-password.txt'));
  chmodSync(resolve(dir, 'admin-password.txt'), 0o600);
  await publish();
  printStatus(s);
} else if (action === 'stop') {
  const s = state();
  // Save and close SQLite before stopping the whole guest.
  if (describe(s.instanceId).State.Name === 'stopped') { printStatus(s); process.exit(0); }
  const container = await containerFor(s.instanceId);
  run('docker', ['exec', container, 'sh', '-c', 'if test -f /app/game.pid; then kill -TERM "$(cat /app/game.pid)"; fi'], { quiet: true });
  await waitHealth(false);
  aws('ec2', 'stop-instances', '--instance-ids', s.instanceId);
  await waitState(s.instanceId, 'stopped');
  printStatus(s);
} else if (action === 'start') {
  const s = state();
  await startInstance(s.instanceId);
  startGame(await containerFor(s.instanceId));
  await waitHealth(true);
  printStatus(s);
} else if (action === 'status') printStatus(state());
else throw new Error('Usa up, stop, start o status.');
