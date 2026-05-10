export function ok(res, data, status = 200) {
  return res.status(status).json({ data });
}

export function fail(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, details } });
}
