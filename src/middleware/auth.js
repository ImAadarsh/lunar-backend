import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/httpError.js';

/**
 * Attaches `req.auth` = { userId, email, role } from Bearer JWT.
 */
export function requireAuth(req, _res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Missing bearer token'));
  }
  const token = h.slice(7);
  try {
    const payload = verifyAccessToken(token);
    const sub = payload.sub ?? payload.userId;
    req.auth = {
      userId: Number(sub),
      email: payload.email,
      role: payload.role,
    };
    return next();
  } catch {
    return next(new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token'));
  }
}
