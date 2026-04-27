import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

const COOKIE_NAME = 'gm_session';
const ONE_DAY_S = 60 * 60 * 24;

function sign(value: string): string {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce<Record<string, string>>((acc, part) => {
    const [k, ...rest] = part.trim().split('=');
    acc[k] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

export function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function issueSession(res: Response, email: string): void {
  const exp = Math.floor(Date.now() / 1000) + ONE_DAY_S;
  const payload = `${email}|${exp}`;
  const token = `${payload}|${sign(payload)}`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_DAY_S}`);
}

export function clearSession(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/api/login' || req.path === '/api/health') {
    next();
    return;
  }

  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required', detail: {} } });
    return;
  }

  const [email, expRaw, signature] = token.split('|');
  const payload = `${email}|${expRaw}`;
  const exp = Number(expRaw);
  if (!email || !exp || !signature || sign(payload) !== signature || exp * 1000 < Date.now()) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid session', detail: {} } });
    return;
  }

  next();
}

export function verifyAdmin(email: string, password: string): boolean {
  if (!config.adminPasswordHash) {
    return false;
  }

  return email.trim().toLowerCase() === config.adminEmail.toLowerCase() && hashPassword(password) === config.adminPasswordHash;
}
