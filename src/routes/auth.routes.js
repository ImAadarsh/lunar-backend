import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AppError } from '../utils/httpError.js';
import { ok } from '../utils/response.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { authenticator } from 'otplib';
import { signAccessToken, verifyAccessToken, signPreAuthToken, verifyPreAuthToken } from '../utils/jwt.js';
import { randomToken, sha256Hex } from '../utils/cryptoToken.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { writeAudit } from '../utils/audit.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['admin', 'supervisor', 'guard']),
  phone: z.string().optional(),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

const login2faSchema = z.object({
  preAuthToken: z.string().min(10),
  token: z.string().min(6).max(10),
});

const totpCodeSchema = z.object({
  token: z.string().min(6).max(10),
});

const disable2faSchema = z.object({
  password: z.string().min(1),
  token: z.string().min(6).max(10),
});

function refreshExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d;
}

router.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.validated.body;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.status, r.slug AS role_slug,
              u.two_factor_enabled, u.two_factor_secret
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.email = ? LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid credentials');
    }
    const match = await verifyPassword(password, user.password_hash);
    if (!match) throw new AppError(401, 'UNAUTHORIZED', 'Invalid credentials');

    const has2fa = Number(user.two_factor_enabled) === 1 && user.two_factor_secret;
    if (has2fa) {
      const preAuthToken = signPreAuthToken(user.id);
      return ok(res, {
        requiresTwoFactor: true,
        preAuthToken,
        user: { id: user.id, email: user.email, role: user.role_slug },
      });
    }

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role_slug,
    });
    const rawRefresh = randomToken(32);
    const tokenHash = sha256Hex(rawRefresh);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [user.id, tokenHash, refreshExpiresAt()]
    );

    await writeAudit({
      userId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });

    return ok(res, {
      accessToken,
      refreshToken: rawRefresh,
      expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
      user: { id: user.id, email: user.email, role: user.role_slug },
    });
  })
);

router.post(
  '/login/2fa',
  validate(login2faSchema),
  asyncHandler(async (req, res) => {
    const { preAuthToken, token } = req.validated.body;
    let payload;
    try {
      payload = verifyPreAuthToken(preAuthToken);
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired pre-auth token');
    }
    const userId = Number(payload.sub);
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.status, r.slug AS role_slug, u.two_factor_enabled, u.two_factor_secret
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? LIMIT 1`,
      [userId]
    );
    const user = rows[0];
    if (!user || user.status !== 'active' || Number(user.two_factor_enabled) !== 1 || !user.two_factor_secret) {
      throw new AppError(401, 'UNAUTHORIZED', 'Two-factor authentication not active');
    }
    const secretBuf = user.two_factor_secret;
    const secret =
      typeof secretBuf === 'string' ? secretBuf : Buffer.from(secretBuf).toString('utf8');
    if (!authenticator.check(token, secret)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid authenticator code');

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role_slug,
    });
    const rawRefresh = randomToken(32);
    const tokenHash = sha256Hex(rawRefresh);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [user.id, tokenHash, refreshExpiresAt()]
    );

    await writeAudit({
      userId: user.id,
      action: 'auth.login_2fa',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });

    return ok(res, {
      accessToken,
      refreshToken: rawRefresh,
      expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
      user: { id: user.id, email: user.email, role: user.role_slug },
    });
  })
);

router.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT two_factor_enabled FROM users WHERE id = ?`,
      [req.auth.userId]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (Number(rows[0].two_factor_enabled) === 1) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Two-factor authentication is already enabled');
    }
    const secret = authenticator.generateSecret();
    await pool.query(`UPDATE users SET two_factor_secret = ? WHERE id = ?`, [
      Buffer.from(secret, 'utf8'),
      req.auth.userId,
    ]);
    const otpauthUrl = authenticator.keyuri(req.auth.email, 'Lunar Security', secret);
    return ok(res, {
      secret,
      otpauthUrl,
      message: 'Scan the QR or enter the secret, then POST /auth/2fa/enable with a valid code.',
    });
  })
);

router.post(
  '/2fa/enable',
  requireAuth,
  validate(totpCodeSchema),
  asyncHandler(async (req, res) => {
    const { token } = req.validated.body;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = ?`,
      [req.auth.userId]
    );
    if (!rows[0]?.two_factor_secret) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Run POST /auth/2fa/setup first');
    }
    if (Number(rows[0].two_factor_enabled) === 1) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Already enabled');
    }
    const secretBuf = rows[0].two_factor_secret;
    const secret =
      typeof secretBuf === 'string' ? secretBuf : Buffer.from(secretBuf).toString('utf8');
    if (!authenticator.check(token, secret)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid authenticator code');
    }
    await pool.query(`UPDATE users SET two_factor_enabled = 1 WHERE id = ?`, [req.auth.userId]);
    await writeAudit({
      userId: req.auth.userId,
      action: 'auth.2fa.enable',
      entityType: 'user',
      entityId: req.auth.userId,
      ip: req.ip,
    });
    return ok(res, { twoFactorEnabled: true });
  })
);

router.post(
  '/2fa/disable',
  requireAuth,
  validate(disable2faSchema),
  asyncHandler(async (req, res) => {
    const { password, token } = req.validated.body;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT password_hash, two_factor_secret, two_factor_enabled FROM users WHERE id = ?`,
      [req.auth.userId]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
    if (Number(rows[0].two_factor_enabled) !== 1) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Two-factor authentication is not enabled');
    }
    const match = await verifyPassword(password, rows[0].password_hash);
    if (!match) throw new AppError(401, 'UNAUTHORIZED', 'Invalid password');
    const secretBuf = rows[0].two_factor_secret;
    const secret = secretBuf
      ? typeof secretBuf === 'string'
        ? secretBuf
        : Buffer.from(secretBuf).toString('utf8')
      : '';
    if (!secret || !authenticator.check(token, secret)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid authenticator code');
    }
    await pool.query(
      `UPDATE users SET two_factor_enabled = 0, two_factor_secret = NULL WHERE id = ?`,
      [req.auth.userId]
    );
    await writeAudit({
      userId: req.auth.userId,
      action: 'auth.2fa.disable',
      entityType: 'user',
      entityId: req.auth.userId,
      ip: req.ip,
    });
    return ok(res, { twoFactorEnabled: false });
  })
);

router.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.validated.body;
    const tokenHash = sha256Hex(refreshToken);
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT rt.id, rt.user_id, u.email, u.status, r.slug AS role_slug
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE rt.token_hash = ? AND rt.revoked_at IS NULL AND rt.expires_at > NOW()
       LIMIT 1`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row || row.status !== 'active') {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid refresh token');
    }

    await pool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?`, [row.id]);

    const accessToken = signAccessToken({
      sub: row.user_id,
      email: row.email,
      role: row.role_slug,
    });
    const rawRefresh = randomToken(32);
    const newHash = sha256Hex(rawRefresh);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [row.user_id, newHash, refreshExpiresAt()]
    );

    return ok(res, {
      accessToken,
      refreshToken: rawRefresh,
      expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
      user: { id: row.user_id, email: row.email, role: row.role_slug },
    });
  })
);

router.post(
  '/logout',
  requireAuth,
  validate(logoutSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.validated.body;
    const pool = getPool();
    if (refreshToken) {
      const tokenHash = sha256Hex(refreshToken);
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
         WHERE token_hash = ? AND user_id = ?`,
        [tokenHash, req.auth.userId]
      );
    } else {
      await pool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?`, [
        req.auth.userId,
      ]);
    }
    await writeAudit({
      userId: req.auth.userId,
      action: 'auth.logout',
      entityType: 'user',
      entityId: req.auth.userId,
      ip: req.ip,
    });
    return ok(res, { loggedOut: true });
  })
);

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new Error('Validation failed');
      err.name = 'ZodError';
      err.flatten = () => parsed.error.flatten();
      err.issues = parsed.error.issues;
      throw err;
    }
    const { email, password, role, phone } = parsed.data;
    const pool = getPool();
    const [[{ cnt }]] = await pool.query(`SELECT COUNT(*) AS cnt FROM users`);
    const isBootstrap = Number(cnt) === 0;

    let actorUserId = null;
    if (!isBootstrap) {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) {
        throw new AppError(401, 'UNAUTHORIZED', 'Admin authentication required');
      }
      let payload;
      try {
        payload = verifyAccessToken(h.slice(7));
      } catch {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid token');
      }
      actorUserId = Number(payload.sub);
      const [admins] = await pool.query(
        `SELECT r.slug FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
        [actorUserId]
      );
      if (admins[0]?.slug !== 'admin') {
        throw new AppError(403, 'FORBIDDEN', 'Only admin can register users');
      }
    }

    const [[roleRow]] = await pool.query(`SELECT id FROM roles WHERE slug = ? LIMIT 1`, [role]);
    if (!roleRow) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid role');

    try {
      const password_hash = await hashPassword(password);
      const [r2] = await pool.query(
        `INSERT INTO users (email, phone, password_hash, role_id, status) VALUES (?, ?, ?, ?, 'active')`,
        [email, phone ?? null, password_hash, roleRow.id]
      );
      const id = r2.insertId;
      await writeAudit({
        userId: isBootstrap ? id : actorUserId,
        action: 'user.register',
        entityType: 'user',
        entityId: id,
        payload: { email, role },
        ip: req.ip,
      });
      return ok(res, { id, email, role }, 201);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        throw new AppError(409, 'CONFLICT', 'Email already registered');
      }
      throw e;
    }
  })
);

export default router;
