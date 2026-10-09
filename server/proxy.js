import { isIP } from 'node:net';

// Enable only when Node is reachable exclusively through our reverse proxy.
const trustProxy = process.env.TRUST_PROXY === 'true';
export const secureRequest = req => !!req.socket.encrypted || trustProxy && req.headers['x-forwarded-proto'] === 'https';
export function clientAddress(req) {
  const forwarded = trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim();
  return forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
}
