import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildClient({ apiBaseUrl = '', wsUrl = '', adminUrl = '/admin', out = resolve(root, 'dist/client') } = {}) {
  if (apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== apiBaseUrl) throw new Error('API_BASE_URL debe ser un origen HTTP/HTTPS sin barra final.');
    wsUrl ||= apiBaseUrl.replace(/^http/, 'ws');
    adminUrl = adminUrl === '/admin' ? `${apiBaseUrl}/admin` : adminUrl;
    if (url.protocol === 'https:' && !wsUrl.startsWith('wss://')) throw new Error('Una API HTTPS requiere WebSocket seguro.');
  }
  if (wsUrl && !['ws:', 'wss:'].includes(new URL(wsUrl).protocol)) throw new Error('WS_URL debe usar ws:// o wss://.');
  if (adminUrl !== '/admin' && !['http:', 'https:'].includes(new URL(adminUrl).protocol)) throw new Error('ADMIN_URL debe usar HTTP/HTTPS.');
  await mkdir(resolve(out, 'shared'), { recursive: true });
  await mkdir(resolve(out, 'vendor'), { recursive: true });
  const publicFiles = await readdir(resolve(root, 'public'), { withFileTypes: true });
  for (const file of publicFiles) {
    if (file.isFile() && !file.name.startsWith('admin') && file.name !== 'config.js') await copyFile(resolve(root, 'public', file.name), resolve(out, file.name));
  }
  await copyFile(resolve(root, 'shared/game.js'), resolve(out, 'shared/game.js'));
  for (const name of ['three.module.js', 'three.core.js']) await copyFile(resolve(root, 'node_modules/three/build', name), resolve(out, 'vendor', name));
  await writeFile(resolve(out, 'config.js'), [
    '// Public deployment addresses.',
    `export const config = Object.freeze(${JSON.stringify({ apiBaseUrl, wsUrl, adminUrl })});`,
    'export const apiUrl = path => config.apiBaseUrl + path;',
    "export const websocketUrl = () => config.wsUrl || (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;",
    ''
  ].join('\n'));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildClient({ apiBaseUrl: process.env.API_BASE_URL, wsUrl: process.env.WS_URL, adminUrl: process.env.ADMIN_URL });
  console.log(`Cliente listo en ${out}`);
}
