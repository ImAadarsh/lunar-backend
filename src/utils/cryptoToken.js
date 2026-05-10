import crypto from 'crypto';

export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
