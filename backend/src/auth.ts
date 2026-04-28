import crypto from 'crypto';
import { createRequire } from 'module';
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

type VerifyAdminResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_credentials' | 'missing_config' };

type BcryptModule = {
  compare: (password: string, hash: string) => Promise<boolean> | boolean;
};

let bcryptModulePromise: Promise<BcryptModule | null> | null = null;
const require = createRequire(import.meta.url);

async function loadBcryptModule(): Promise<BcryptModule | null> {
  if (!bcryptModulePromise) {
    bcryptModulePromise = (async () => {
      try {
        return require('bcrypt') as BcryptModule;
      } catch {
        // continue
      }
      try {
        return require('bcryptjs') as BcryptModule;
      } catch {
        return null;
      }
    })();
  }
  return bcryptModulePromise;
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

export async function verifyAdmin(email: string, password: string): Promise<VerifyAdminResult> {
  if (email.trim().toLowerCase() !== config.adminEmail.toLowerCase()) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (config.adminPasswordHash.trim()) {
    const bcrypt = await loadBcryptModule();
    if (!bcrypt) {
      console.error('Admin password hash is set but bcrypt library is not installed');
      return { ok: false, reason: 'missing_config' };
    }
    const isValid = await bcrypt.compare(password, config.adminPasswordHash);
    return isValid ? { ok: true } : { ok: false, reason: 'invalid_credentials' };
  }

  if (config.nodeEnv === 'development' && config.adminPassword) {
    return config.adminPassword === password
      ? { ok: true }
      : { ok: false, reason: 'invalid_credentials' };
  }

  return { ok: false, reason: 'missing_config' };
}
