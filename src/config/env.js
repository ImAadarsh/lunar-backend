import dotenv from 'dotenv';

dotenv.config();

function req(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

export const env = {
  nodeEnv: req('NODE_ENV', 'development'),
  port: Number(req('PORT', '4000')),
  db: {
    host: req('DB_HOST', '127.0.0.1'),
    port: Number(req('DB_PORT', '3306')),
    user: req('DB_USER', 'root'),
    password: req('DB_PASSWORD', ''),
    database: req('DB_NAME', 'lunar_security'),
    ssl: req('DB_SSL', 'false') === 'true',
  },
  jwt: {
    accessSecret: req('JWT_ACCESS_SECRET', 'dev-access-secret-change-me-min-32-chars!!'),
    refreshSecret: req('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me-min-32-chars!!'),
    accessExpires: req('JWT_ACCESS_EXPIRES', '15m'),
    refreshExpires: req('JWT_REFRESH_EXPIRES', '7d'),
    preAuthExpires: req('JWT_PREAUTH_EXPIRES', '5m'),
  },
  /** Directory for generated export CSV files (default: ./exports under cwd) */
  exportFilesDir: req('EXPORT_FILES_DIR', ''),
  /** Directory for uploaded media files (default: ./uploads under cwd) */
  uploadFilesDir: req('UPLOAD_FILES_DIR', ''),
  /** Optional origin for absolute download URLs in export_jobs.file_url, e.g. http://localhost:4000 */
  publicBaseUrl: req('PUBLIC_BASE_URL', ''),
  corsOrigins: (req('CORS_ORIGINS', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
