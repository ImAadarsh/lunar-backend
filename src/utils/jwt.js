import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export function signAccessToken(payload) {
  const { sub, email, role } = payload;
  return jwt.sign({ email, role }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires,
    subject: String(sub),
  });
}

export function verifyAccessToken(token) {
  const p = jwt.verify(token, env.jwt.accessSecret);
  if (p.purpose === '2fa_pending') {
    const e = new Error('Wrong token type');
    e.name = 'JsonWebTokenError';
    throw e;
  }
  return p;
}

/** Short-lived token after password OK, before TOTP (when 2FA enabled). */
export function signPreAuthToken(userId) {
  return jwt.sign({ purpose: '2fa_pending' }, env.jwt.accessSecret, {
    expiresIn: env.jwt.preAuthExpires,
    subject: String(userId),
  });
}

export function verifyPreAuthToken(token) {
  const p = jwt.verify(token, env.jwt.accessSecret);
  if (p.purpose !== '2fa_pending') {
    const e = new Error('Invalid pre-auth token');
    e.name = 'JsonWebTokenError';
    throw e;
  }
  return p;
}
