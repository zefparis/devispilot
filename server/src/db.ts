import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const { Pool, types } = pg;

// Les colonnes DATE métier restent des chaînes 'YYYY-MM-DD' (pas de décalage de fuseau).
types.setTypeParser(1082, v => v);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function migrate(): Promise<string[]> {
  const dir = process.env.MIGRATIONS_DIR
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map(r => r.version));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} a échoué : ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    client.release();
  }
}
