import { AppError } from '../utils/httpError.js';

/** @param {...string} allowedSlugs */
export function requireRoles(...allowedSlugs) {
  const set = new Set(allowedSlugs);
  return (req, _res, next) => {
    const role = req.auth?.role;
    if (!role || !set.has(role)) {
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
    }
    next();
  };
}
