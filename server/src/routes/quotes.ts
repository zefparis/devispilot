import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { validateQuote, isDate } from '../validate.js';
import { remainingQuoteQuota } from '../stripe.js';

const ACTIVE = ['sent', 'replied'];
const LIMIT_ERROR = {
  error: `Limite de l'offre Gratuit atteinte : 10 devis actifs maximum. Passez en Pro pour continuer.`,
  code: 'PLAN_LIMIT',
};

const SELECT = `
  SELECT q.id, q.client, q.email, q.project,
         (q.amount_cents / 100.0)::float8 AS amount, q.currency,
         q.sent::text AS sent, q.next::text AS next, q.status, q.notes,
         COALESCE(h.cnt, 0) AS followup_count
  FROM quotes q
  LEFT JOIN (SELECT quote_id, count(*) AS cnt FROM followups GROUP BY quote_id) h ON h.quote_id = q.id`;

export default async function quoteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireCompany);

  // Liste avec recherche et filtres — toujours bornée à l'entreprise de la session.
  app.get('/api/quotes', async (req) => {
    const { search = '', status = '', due = '' } = req.query as Record<string, string>;
    const params: unknown[] = [req.companyId];
    let where = 'q.company_id = $1';
    if (status && ['sent', 'replied', 'won', 'lost'].includes(status)) {
      params.push(status); where += ` AND q.status = $${params.length}`;
    }
    if (due === '1') { where += ` AND q.status IN ('sent','replied') AND q.next <= CURRENT_DATE`; }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (lower(q.client) LIKE $${params.length} OR lower(q.project) LIKE $${params.length})`;
    }
    const { rows } = await pool.query(`${SELECT} WHERE ${where} ORDER BY q.next ASC, q.created_at DESC`, params);
    return { quotes: rows };
  });

  app.post('/api/quotes', async (req, reply) => {
    const v = validateQuote(req.body);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const q = v.value;
    // Limite Gratuit : 10 devis actifs. Appliquée côté serveur, jamais au seul front.
    if (ACTIVE.includes(q.status) && (await remainingQuoteQuota(req.companyId!)) < 1)
      return reply.code(403).send(LIMIT_ERROR);
    const { rows } = await pool.query(
      `INSERT INTO quotes (company_id, client, email, project, amount_cents, currency, sent, next, status, notes)
       VALUES ($1,$2,$3,$4,$5,'EUR',$6,$7,$8,$9) RETURNING id`,
      [req.companyId, q.client, q.email, q.project, q.amountCents, q.sent, q.next, q.status, q.notes],
    );
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch('/api/quotes/:id', async (req, reply) => {
    const v = validateQuote(req.body);
    if (!v.value) return reply.code(400).send({ error: v.error });
    const q = v.value;
    // Réactivation d'un devis signé/perdu : il reconsomme le quota Gratuit.
    if (ACTIVE.includes(q.status)) {
      const { rows: cur } = await pool.query(
        'SELECT status FROM quotes WHERE id=$1 AND company_id=$2',
        [(req.params as any).id, req.companyId]);
      if (!cur.length) return reply.code(404).send({ error: 'Devis introuvable.' });
      if (!ACTIVE.includes(cur[0].status) && (await remainingQuoteQuota(req.companyId!)) < 1)
        return reply.code(403).send(LIMIT_ERROR);
    }
    const { rowCount } = await pool.query(
      `UPDATE quotes SET client=$3, email=$4, project=$5, amount_cents=$6, sent=$7,
              next=$8, status=$9, notes=$10, updated_at=now()
       WHERE id=$1 AND company_id=$2`,
      [(req.params as any).id, req.companyId, q.client, q.email, q.project, q.amountCents, q.sent, q.next, q.status, q.notes],
    );
    if (!rowCount) return reply.code(404).send({ error: 'Devis introuvable.' });
    return { ok: true };
  });

  app.delete('/api/quotes/:id', async (req, reply) => {
    const { rowCount } = await pool.query(
      'DELETE FROM quotes WHERE id=$1 AND company_id=$2',
      [(req.params as any).id, req.companyId],
    );
    if (!rowCount) return reply.code(404).send({ error: 'Devis introuvable.' });
    return { ok: true };
  });

  // Déclarer une relance : insertion historique + prochaine date en UNE transaction.
  // idem_key unique par entreprise → double clic ou retry sans doublon.
  app.post('/api/quotes/:id/followups', async (req, reply) => {
    const b = req.body as any;
    const subject = String(b?.subject ?? '').slice(0, 200);
    const next = b?.next;
    const idemKey = String(b?.idemKey ?? '').slice(0, 80) || null;
    if (!isDate(next)) return reply.code(400).send({ error: 'Date de prochain suivi invalide.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (idemKey) {
        const { rows: ex } = await client.query(
          'SELECT id FROM followups WHERE company_id=$1 AND idem_key=$2', [req.companyId, idemKey]);
        if (ex.length) { await client.query('ROLLBACK'); return { ok: true, duplicated: true }; }
      }
      const { rows: owned } = await client.query(
        `UPDATE quotes SET next=$3, updated_at=now()
         WHERE id=$1 AND company_id=$2 AND status IN ('sent','replied') RETURNING id`,
        [(req.params as any).id, req.companyId, next],
      );
      if (!owned.length) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'Devis introuvable ou suivi clôturé.' });
      }
      const ins = await client.query(
        `INSERT INTO followups (company_id, quote_id, subject, idem_key)
         VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, idem_key) DO NOTHING RETURNING id`,
        [req.companyId, owned[0].id, subject, idemKey],
      );
      await client.query('COMMIT');
      // idem_key déjà utilisé → la relance existait déjà : succès idempotent.
      return reply.code(ins.rowCount ? 201 : 200).send({ ok: true, duplicated: !ins.rowCount });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
