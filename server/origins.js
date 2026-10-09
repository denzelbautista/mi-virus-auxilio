// Player APIs may be hosted separately. Administration stays on its own origin.
const configured = (process.env.FRONTEND_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
export const frontendOrigins = new Set(configured.map(value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('FRONTEND_ORIGINS debe contener orígenes HTTP/HTTPS exactos, sin rutas ni barra final.');
  return url.origin;
}));

export function allowedOrigin(req, players = false) {
  if (!req.headers.origin) return true;
  try {
    const url = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === req.headers.origin &&
      (url.host === req.headers.host || players && frontendOrigins.has(url.origin));
  } catch { return false; }
}

export function playerCors(req, res) {
  if (!req.headers.origin || !allowedOrigin(req, true)) return;
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
}
