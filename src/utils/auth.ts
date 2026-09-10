import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SECRET = () => process.env.AUTH_SECRET || process.env.GITHUB_CLIENT_SECRET || 'excalidrop-dev-secret';

export interface Session { login: string; id: number; iat: number; }

function b64u(buf: Buffer | string): string {
  return Buffer.from(buf as any).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s: string): Buffer { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64'); }

export function signSession(s: Session): string {
  const payload = b64u(JSON.stringify(s));
  const sig = b64u(crypto.createHmac('sha256', SECRET()).update(payload).digest());
  return `${payload}.${sig}`;
}
export function verifySession(token: string): Session | null {
  try {
    const [p, sig] = token.split('.');
    if (!p || !sig) return null;
    const expect = b64u(crypto.createHmac('sha256', SECRET()).update(p).digest());
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const s = JSON.parse(unb64u(p).toString()) as Session;
    if (Date.now() / 1000 - s.iat > 30 * 24 * 3600) return null;
    return s;
  } catch { return null; }
}

export function getToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/excalidrop_token=([^;]+)/);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export function authOptional(req: Request, _res: Response, next: NextFunction) {
  const t = getToken(req);
  (req as any).user = t ? verifySession(t) : null;
  next();
}


export function requireWriteAuth(req: Request, res: Response, next: NextFunction) {
  if (!process.env.GITHUB_CLIENT_ID) return next(); // local dev: open
  const tok = getToken(req);
  const user = tok ? verifySession(tok) : null;
  if (user) { (req as any).user = user; return next(); }
  return res.status(401).json({ success: false, error: 'Authentication required. Login with GitHub.' });
}

export function requireReadAuth(req: Request, res: Response, next: NextFunction) {
  if (String(process.env.PUBLIC_READ || 'false').toLowerCase() === 'true') { const t = getToken(req); (req as any).user = t ? verifySession(t) : null; return next(); }
  if (!process.env.GITHUB_CLIENT_ID) return next();
  return requireWriteAuth(req, res, next);
}

export function allowedLogins(): string[] {
  return (process.env.ALLOWED_GITHUB_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
