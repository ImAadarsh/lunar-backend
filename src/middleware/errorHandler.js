import { AppError } from '../utils/httpError.js';

export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? null,
      },
    });
  }
  if (err?.name === 'ZodError') {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.flatten?.() ?? err.issues,
      },
    });
  }
  console.error(err);
  return res.status(500).json({
    error: { code: 'INTERNAL', message: 'Internal server error', details: null },
  });
}
