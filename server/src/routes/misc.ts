import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireCompany, requireSession } from '../guards.js';
import { csvCell } from '../validate.js';

export default async function miscRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Sonde légère pour monitoring externe (Uptime Kuma) — pas de requête DB.
  app.get('/health', async () => ({ status: 'ok' }));

  // Configuration publique minimale lue par le frontend au démarrage.
  app.get('/api/config', async () => ({
    signupEnabled: (app as any).signupEnabled,
  }));

  app.get('/api/me', { preHandler: requireSession }, async (req, reply) => {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM companies c
       JOIN memberships m ON m.company_id = c.id
       WHERE m.user_id = $1 ORDER BY m.created_at LIMIT 1`, [req.userId]);
    const { rows: users } = await pool.query<{ name: string; email: string }>(
      'SELECT name, email FROM "user" WHERE id=$1', [req.userId]);
    return { user: users[0] ?? null, company: rows[0] ?? null, session_id: req.sessionId };
  });

  // Création de l'entreprise à la première connexion (propriétaire = utilisateur courant).
  app.post('/api/companies', { preHandler: requireSession }, async (req, reply) => {
    const name = String((req.body as any)?.name ?? '').trim();
    if (!name || name.length > 100)
      return reply.code(400).send({ error: 'Nom d’entreprise invalide (1 à 100 caractères).' });
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM memberships WHERE user_id=$1 LIMIT 1', [req.userId]);
    if (existing.length)
      return reply.code(409).send({ error: 'Une entreprise est déjà associée à ce compte.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO companies (name) VALUES ($1) RETURNING id', [name]);
      await client.query(
        `INSERT INTO memberships (company_id, user_id, role) VALUES ($1,$2,'owner')`, [rows[0].id, req.userId]);
      await client.query('INSERT INTO company_settings (company_id) VALUES ($1)', [rows[0].id]);
      await client.query('COMMIT');
      return reply.code(201).send({ id: rows[0].id, name });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  });

  // Export CSV (protection formules, dates AAAA-MM-JJ, montants en euros).
  app.get('/api/export.csv', { preHandler: requireCompany }, async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT client, email, project, (amount_cents/100.0)::float8 AS amount,
              sent::text AS sent, status, next::text AS next, notes
       FROM quotes WHERE company_id=$1 ORDER BY created_at`, [req.companyId]);
    const keys = ['client', 'email', 'project', 'amount', 'sent', 'status', 'next', 'notes'];
    const csv = '﻿' + [keys, ...rows.map(r => keys.map(k => (r as any)[k]))]
      .map(r => r.map(csvCell).join(';')).join('\r\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="devispilot-devis.csv"');
    return reply.send(csv);
  });
}
