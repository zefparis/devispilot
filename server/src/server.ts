import { buildApp } from './app.js';
import { migrate, pool } from './db.js';
import { config } from './config.js';

const applied = await migrate();
if (applied.length) console.log(`Migrations appliquées : ${applied.join(', ')}`);

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
