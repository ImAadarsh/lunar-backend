import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env.js';
import { pingDb } from './db/pool.js';
import apiV1 from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '2mb' }));

  const uploadDir = env.uploadFilesDir || path.resolve(process.cwd(), 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  app.use('/uploads', express.static(uploadDir));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    try {
      const ok = await pingDb();
      if (ok) {
        return res.json({
          status: 'ready',
          database: { host: env.db.host, name: env.db.database },
        });
      }
      return res.status(503).json({ status: 'not_ready', error: 'db_ping_failed' });
    } catch (e) {
      return res.status(503).json({
        status: 'not_ready',
        error: e instanceof Error ? e.message : 'unknown',
      });
    }
  });

  app.get('/api/v1', (_req, res) => {
    res.json({ name: 'lunar-security-api', version: '0.1.0' });
  });

  app.use('/api/v1', apiV1);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: null } });
  });

  app.use(errorHandler);

  return app;
}
