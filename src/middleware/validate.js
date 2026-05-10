/**
 * @param {import('zod').ZodSchema} schema
 * @param {'body'|'query'|'params'} source
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const err = new Error('Validation failed');
      err.name = 'ZodError';
      err.flatten = () => parsed.error.flatten();
      err.issues = parsed.error.issues;
      return next(err);
    }
    req.validated = req.validated || {};
    req.validated[source] = parsed.data;
    next();
  };
}
