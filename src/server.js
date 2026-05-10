import { createApp } from './app.js';
import { env } from './config/env.js';

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`API listening on http://0.0.0.0:${env.port} (${env.nodeEnv})`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${env.port} is already in use. Set PORT in .env to another value, or free the port (e.g. lsof -i :${env.port}).`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
