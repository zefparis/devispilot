import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { validStripeLink } from '../validate.js';

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireCompany);

  app.get('/api/settings', async (req) => {
    const { rows } = await pool.query(
      `SELECT c.name AS company, s.signature, s.stripe_link
       FROM companies c JOIN company_settings s ON s.company_id = c.id
       WHERE c.id = $1`, [req.companyId]);
    return rows[0] ?? { company: '', signature: '', stripe_link: '' };
  });

  app.patch('/api/settings', async (req, reply) => {
    const b = req.body as any;
    const company = String(b?.company ?? '').trim();
    const signature = String(b?.signature ?? '').trim();
    const stripe = String(b?.stripe ?? '').trim();
    if (!company || company.length > 100) return reply.code(400).send({ error: 'Nom d’entreprise invalide (1 à 100 caractères).' });
    if (signature.length > 100) return reply.code(400).send({ error: 'Signature trop longue (100 caractères max).' });
    if (stripe && !validStripeLink(stripe)) return reply.code(400).send({ error: 'Lien de paiement invalide : https://buy.stripe.com/… attendu.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE companies SET name=$2 WHERE id=$1', [req.companyId, company]);
      await client.query(
        `INSERT INTO company_settings (company_id, signature, stripe_link)
         VALUES ($1,$2,$3)
         ON CONFLICT (company_id) DO UPDATE SET signature=$2, stripe_link=$3, updated_at=now()`,
        [req.companyId, signature, stripe]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    return { ok: true };
  });
}
