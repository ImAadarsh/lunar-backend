import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signAccessToken, signPreAuthToken, verifyAccessToken } from '../src/utils/jwt.js';

describe('createApp', () => {
  it('GET /health returns ok', async () => {
    const res = await request(createApp()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.time).toBeDefined();
  });

  it('GET /api/v1 returns API meta', async () => {
    const res = await request(createApp()).get('/api/v1').expect(200);
    expect(res.body.name).toBe('lunar-security-api');
  });

  it('unknown route returns NOT_FOUND envelope', async () => {
    const res = await request(createApp()).get('/api/v1/does-not-exist').expect(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('pre-auth (2FA pending) JWT is not accepted as a bearer for protected routes', async () => {
    const preAuth = signPreAuthToken(1);
    const res = await request(createApp())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${preAuth}`);
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/auth/login validates body', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({})
      .expect(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('signAccessToken signs subject without throwing and verifies payload', () => {
    const token = signAccessToken({ sub: 3, email: 'guard@lunarsecurity.demo', role: 'guard' });
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe('3');
    expect(payload.email).toBe('guard@lunarsecurity.demo');
    expect(payload.role).toBe('guard');
  });
});
