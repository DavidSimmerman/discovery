import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_SECRET } from '$env/static/private';
import type { Cookies } from '@sveltejs/kit';

const COOKIE_NAME = 'disccovery_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sign(value: string): string {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

export function setSessionCookie(cookies: Cookies, userId: string): void {
  const sig = sign(userId);
  cookies.set(COOKIE_NAME, `${userId}.${sig}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
  });
}

export function readSessionCookie(cookies: Cookies): string | null {
  const raw = cookies.get(COOKIE_NAME);
  if (!raw) return null;
  const [userId, sig] = raw.split('.');
  if (!userId || !sig) return null;
  const expected = sign(userId);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}
