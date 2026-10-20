import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { requireCompany, requireSession } from '../guards.js';

const SIREN_RE = /^\d{9}$|^\d{14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const LOGO_MAX_BYTES = 200 * 1024;

export default async function profileRoutes(app: FastifyInstance) {
  // Nom affiché dans le compte (hors email — changé via /api/auth/change-email).
  app.patch('/api/profile', { preHandler: requireSession }, async (req, reply) => {
    const name = String((req.body as any)?.name ?? '').trim();
    if (!name || name.length > 100)
      return reply.code(400).send({ error: 'Nom invalide (1 à 100 caractères).' });
    await pool.query('UPDATE "user" SET name=$2 WHERE id=$1', [req.userId, name]);
    return { ok: true };
  });

  // Fiche entreprise utilisée sur les devis (mentions légales, contact).
  app.get('/api/company', { preHandler: requireCompany }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, name, siren, address, phone, contact_email,
              logo_mime IS NOT NULL AS has_logo
       FROM companies WHERE id=$1`, [req.companyId]);
    return rows[0];
  });

  app.patch('/api/company', { preHandler: requireCompany }, async (req, reply) => {
    const b = req.body as any;
    const name = String(b?.name ?? '').trim();
    const siren = String(b?.siren ?? '').replace(/\s/g, '');
    const address = String(b?.address ?? '').trim();
    const phone = String(b?.phone ?? '').trim();
    const contactEmail = String(b?.contact_email ?? '').trim();
    if (!name || name.length > 100)
      return reply.code(400).send({ error: 'Raison sociale invalide (1 à 100 caractères).' });
    if (siren && !SIREN_RE.test(siren))
      return reply.code(400).send({ error: 'SIREN/SIRET invalide (9 ou 14 chiffres).' });
    if (address.length > 300) return reply.code(400).send({ error: 'Adresse trop longue (300 caractères max).' });
    if (phone.length > 30) return reply.code(400).send({ error: 'Téléphone trop long (30 caractères max).' });
    if (contactEmail && (contactEmail.length > 200 || !EMAIL_RE.test(contactEmail)))
      return reply.code(400).send({ error: 'Email de contact invalide.' });
    await pool.query(
      'UPDATE companies SET name=$2, siren=$3, address=$4, phone=$5, contact_email=$6 WHERE id=$1',
      [req.companyId, name, siren, address, phone, contactEmail]);
    return { ok: true };
  });

  // Logo facultatif (data URL base64). Limite : 200 Ko, PNG/JPEG/WebP.
  app.put('/api/company/logo', { preHandler: requireCompany }, async (req, reply) => {
    const dataUrl = String((req.body as any)?.data ?? '');
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(dataUrl);
    if (!m) return reply.code(400).send({ error: 'Format attendu : image PNG, JPEG ou WebP.' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > LOGO_MAX_BYTES)
      return reply.code(400).send({ error: 'Logo trop lourd (200 Ko max).' });
    if (!LOGO_MIMES.has(m[1])) return reply.code(400).send({ error: 'Type d’image non pris en charge.' });
    await pool.query('UPDATE companies SET logo_data=$2, logo_mime=$3 WHERE id=$1', [req.companyId, buf, m[1]]);
    return { ok: true };
  });

  app.get('/api/company/logo', { preHandler: requireCompany }, async (req, reply) => {
    const { rows } = await pool.query<{ logo_data: Buffer | null; logo_mime: string | null }>(
      'SELECT logo_data, logo_mime FROM companies WHERE id=$1', [req.companyId]);
    if (!rows[0]?.logo_data) return reply.code(404).send({ error: 'Aucun logo.' });
    reply.header('Content-Type', rows[0].logo_mime);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(rows[0].logo_data);
  });

  app.delete('/api/company/logo', { preHandler: requireCompany }, async (req) => {
    await pool.query('UPDATE companies SET logo_data=NULL, logo_mime=NULL WHERE id=$1', [req.companyId]);
    return { ok: true };
  });

  // Export RGPD : toutes les données du compte en JSON.
  app.get('/api/export-data', { preHandler: requireSession }, async (req) => {
    const { rows: users } = await pool.query(
      'SELECT id, name, email, "emailVerified" AS email_verified, "createdAt" AS created_at FROM "user" WHERE id=$1',
      [req.userId]);
    const { rows: companies } = await pool.query(
      `SELECT c.id, c.name, c.siren, c.address, c.phone, c.contact_email,
              (c.logo_data IS NOT NULL) AS has_logo, m.role
       FROM companies c JOIN memberships m ON m.company_id = c.id
       WHERE m.user_id=$1`, [req.userId]);
    const { rows: quotes } = await pool.query(
      `SELECT q.* FROM quotes q
       WHERE q.company_id IN (SELECT company_id FROM memberships WHERE user_id=$1)
       ORDER BY q.created_at`, [req.userId]);
    const { rows: followups } = await pool.query(
      `SELECT f.* FROM followups f
       WHERE f.company_id IN (SELECT company_id FROM memberships WHERE user_id=$1)
       ORDER BY f.at`, [req.userId]);
    const { rows: settings } = await pool.query(
      `SELECT s.* FROM company_settings s
       WHERE s.company_id IN (SELECT company_id FROM memberships WHERE user_id=$1)`, [req.userId]);
    return {
      exported_at: new Date().toISOString(),
      user: users[0] ?? null,
      companies,
      settings,
      quotes,
      followups,
    };
  });
}
