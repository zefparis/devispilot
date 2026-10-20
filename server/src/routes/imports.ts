import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { validateQuote, isDate } from '../validate.js';

// Import explicite des devis locaux (localStorage ou CSV parsé côté client).
// Idempotent : import_key unique par entreprise → une reprise ne duplique rien.
export default async function importRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireCompany);

  app.post('/api/import', async (req, reply) => {
    const items = (req.body as any)?.quotes;
    if (!Array.isArray(items) || !items.length)
      return reply.code(400).send({ error: 'Aucun devis à importer.' });
    if (items.length > 2000)
      return reply.code(400).send({ error: 'Maximum 2 000 devis par import.' });

    let imported = 0, skipped = 0;
    const errors: { index: number; error: string }[] = [];

    for (const [i, raw] of items.entries()) {
      const v = validateQuote(raw);
      if (!v.value) { errors.push({ index: i, error: v.error! }); continue; }
      const importKey = String(raw.import_key ?? '').trim().slice(0, 120) || null;
      const history = Array.isArray(raw.history) ? raw.history : [];
      const q = v.value;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO quotes (company_id, client, email, project, amount_cents, currency, sent, next, status, notes, import_key)
           VALUES ($1,$2,$3,$4,$5,'EUR',$6,$7,$8,$9,$10)
           ON CONFLICT (company_id, import_key) WHERE import_key IS NOT NULL DO NOTHING RETURNING id`,
          [req.companyId, q.client, q.email, q.project, q.amountCents, q.sent, q.next, q.status, q.notes, importKey],
        );
        if (!rows.length) { await client.query('ROLLBACK'); skipped++; continue; }
        const qid = rows[0].id;
        let h = 0;
        for (const f of history.slice(0, 100)) {
          const at = typeof f?.at === 'string' && !Number.isNaN(Date.parse(f.at)) ? new Date(f.at) : null;
          if (!at) continue;
          await client.query(
            'INSERT INTO followups (company_id, quote_id, subject, at) VALUES ($1,$2,$3,$4)',
            [req.companyId, qid, String(f.subject ?? '').slice(0, 200), at],
          );
          h++;
        }
        await client.query('COMMIT');
        imported++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        req.log.warn({ err }, 'ligne d’import refusée');
        errors.push({ index: i, error: 'Erreur serveur sur cette ligne.' });
      } finally { client.release(); }
    }
    return { imported, skipped, errors };
  });
}
