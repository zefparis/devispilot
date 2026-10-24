import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { pool } from '../db.js';
import { requireAdmin } from '../guards.js';
import { auth } from '../auth.js';
import { settingValue, setSetting } from '../settings.js';
import { config } from '../config.js';
import { priceInfo } from '../stripe.js';
import crypto from 'node:crypto';

// Journal d'audit : métadonnées uniquement — jamais de contenu métier
// (pas de devis, de clients finaux ni de relances).
async function audit(req: FastifyRequest, action: string, targetType = '', targetId = '', detail: Record<string, unknown> = {}) {
  const { rows } = await pool.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [req.userId]);
  await pool.query(
    `INSERT INTO audit_log (admin_user_id, admin_email, action, target_type, target_id, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.userId, rows[0]?.email ?? '', action, targetType, targetId, JSON.stringify(detail), req.ip ?? '']);
}

export default async function adminRoutes(app: FastifyInstance) {
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('preHandler', requireAdmin);

  /* ---------- Tableau de bord ---------- */
  app.get('/api/admin/stats', async () => {
    const [companies, users, signups7, signups30, unverified, quotes, suspended] = await Promise.all([
      pool.query('SELECT count(*) AS n FROM companies'),
      pool.query('SELECT count(*) AS n FROM "user"'),
      pool.query(`SELECT count(*) AS n FROM "user" WHERE "createdAt" >= now() - interval '7 days'`),
      pool.query(`SELECT count(*) AS n FROM "user" WHERE "createdAt" >= now() - interval '30 days'`),
      pool.query('SELECT count(*) AS n FROM "user" WHERE NOT "emailVerified"'),
      pool.query('SELECT count(*) AS n FROM quotes'),
      pool.query('SELECT count(*) AS n FROM "user" WHERE suspended_at IS NOT NULL'),
    ]);
    const one = (r: any) => Number(r.rows[0].n);

    // Abonnés payants (plan actif/trialing/past_due) + MRR normalisé :
    // montants relus depuis l'API Stripe (cache), annuel ÷ 12.
    const { rows: paying } = await pool.query<{ subscription_price_id: string; status: string }>(
      `SELECT subscription_price_id, subscription_status AS status FROM companies
        WHERE plan <> 'free' AND subscription_status IN ('active','trialing','past_due')`);
    let mrrCents = 0;
    for (const p of paying) {
      const info = p.subscription_price_id ? await priceInfo(p.subscription_price_id) : null;
      if (!info?.unit_amount) continue;
      mrrCents += info.interval === 'year' ? Math.round(info.unit_amount / 12) : info.unit_amount;
    }
    return {
      companies: one(companies), users: one(users),
      signups7: one(signups7), signups30: one(signups30),
      unverified: one(unverified), quotes: one(quotes), suspended: one(suspended),
      paying: paying.length, mrrCents,
    };
  });

  /* ---------- Entreprises ---------- */
  const COMPANY_SORTS: Record<string, string> = {
    created_at: 'c.created_at DESC',
    name: 'c.name ASC',
    users: 'users_count DESC',
    quotes: 'quotes_count DESC',
    activity: 'last_activity DESC NULLS LAST',
  };
  app.get('/api/admin/companies', async (req) => {
    const q = String((req.query as any)?.search ?? '').trim();
    const order = COMPANY_SORTS[(req.query as any)?.sort] ?? COMPANY_SORTS.created_at;
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.siren, c.created_at::text,
              c.plan, c.subscription_status,
              (SELECT count(*) FROM memberships m WHERE m.company_id=c.id) AS users_count,
              (SELECT count(*) FROM quotes qt WHERE qt.company_id=c.id) AS quotes_count,
              GREATEST(
                (SELECT max(qt.updated_at) FROM quotes qt WHERE qt.company_id=c.id),
                (SELECT max(f.at) FROM followups f WHERE f.company_id=c.id)
              )::text AS last_activity
       FROM companies c
       WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR c.siren LIKE $1 || '%')
       ORDER BY ${order} LIMIT 300`, [q]);
    return { companies: rows };
  });

  /* ---------- Utilisateurs ---------- */
  app.get('/api/admin/users', async (req) => {
    const q = String((req.query as any)?.search ?? '').trim();
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u."emailVerified" AS email_verified,
              u."createdAt"::text AS created_at, u.suspended_at::text,
              c.name AS company_name,
              (SELECT max(s."updatedAt") FROM session s WHERE s."userId"=u.id)::text AS last_seen
       FROM "user" u
       LEFT JOIN memberships m ON m.user_id=u.id
       LEFT JOIN companies c ON c.id=m.company_id
       WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%')
       ORDER BY u."createdAt" DESC LIMIT 300`, [q]);
    return { users: rows };
  });

  const loadUser = async (id: string) => {
    const { rows } = await pool.query<{ id: string; email: string }>(
      'SELECT id, email FROM "user" WHERE id=$1', [id]);
    return rows[0];
  };

  /* ---------- Actions sur un utilisateur ---------- */
  app.post('/api/admin/users/:id/verify', async (req, reply) => {
    const u = await loadUser((req.params as any).id);
    if (!u) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
    await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [u.id]);
    await audit(req, 'user.verify', 'user', u.id, { email: u.email });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/resend-verification', async (req, reply) => {
    const u = await loadUser((req.params as any).id);
    if (!u) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
    try {
      await auth.api.sendVerificationEmail({ body: { email: u.email, callbackURL: config.frontUrl + '/?verifie=1' } });
    } catch (err) {
      return reply.code(502).send({ error: 'Envoi impossible (SMTP indisponible ?).' });
    }
    await audit(req, 'user.resend-verification', 'user', u.id, { email: u.email });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/suspend', async (req, reply) => {
    const u = await loadUser((req.params as any).id);
    if (!u) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
    if (u.id === req.userId) return reply.code(400).send({ error: 'Impossible de suspendre votre propre compte.' });
    const suspend = !!(req.body as any)?.suspended;
    if (suspend) {
      await pool.query('UPDATE "user" SET suspended_at=now() WHERE id=$1', [u.id]);
      // Révocation immédiate de toutes les sessions de l'utilisateur.
      await pool.query('DELETE FROM session WHERE "userId"=$1', [u.id]);
    } else {
      await pool.query('UPDATE "user" SET suspended_at=NULL WHERE id=$1', [u.id]);
    }
    await audit(req, suspend ? 'user.suspend' : 'user.reactivate', 'user', u.id, { email: u.email });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', async (req, reply) => {
    const u = await loadUser((req.params as any).id);
    if (!u) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
    const { rowCount } = await pool.query('DELETE FROM session WHERE "userId"=$1', [u.id]);
    await audit(req, 'user.revoke-sessions', 'user', u.id, { email: u.email, sessions: rowCount ?? 0 });
    return { ok: true, revoked: rowCount ?? 0 };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const u = await loadUser((req.params as any).id);
    if (!u) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
    if (u.id === req.userId) return reply.code(400).send({ error: 'Impossible de supprimer votre propre compte.' });
    // Même nettoyage que la suppression par l'utilisateur lui-même :
    // entreprises dont il est le seul membre → cascade devis/relances/réglages.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM companies c
          WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.company_id=c.id AND m.user_id=$1)
            AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.company_id=c.id AND m2.user_id<>$1)`, [u.id]);
      await client.query('DELETE FROM "user" WHERE id=$1', [u.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    await audit(req, 'user.delete', 'user', u.id, { email: u.email });
    return { ok: true };
  });

  /* ---------- Réglages d'exploitation ---------- */
  app.get('/api/admin/settings', async () => {
    const v = await settingValue<boolean>('signup_enabled');
    return { signupEnabled: v === undefined ? config.signupEnabled : !!v, overridden: v !== undefined };
  });

  app.put('/api/admin/settings', async (req, reply) => {
    const v = (req.body as any)?.signupEnabled;
    if (typeof v !== 'boolean') return reply.code(400).send({ error: 'signupEnabled booléen attendu.' });
    await setSetting('signup_enabled', v);
    await audit(req, 'settings.signup', 'setting', 'signup_enabled', { value: v });
    return { ok: true, signupEnabled: v };
  });

  /* ---------- Création manuelle d'un compte client ---------- */
  app.post('/api/admin/accounts', async (req, reply) => {
    const b = req.body as any;
    const email = String(b?.email ?? '').trim().toLowerCase();
    const name = String(b?.name ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
      return reply.code(400).send({ error: 'Email invalide.' });
    if (!name || name.length > 100)
      return reply.code(400).send({ error: 'Nom invalide (1 à 100 caractères).' });
    const { rows: exists } = await pool.query('SELECT 1 FROM "user" WHERE lower(email)=$1', [email]);
    if (exists.length) return reply.code(409).send({ error: 'Un compte existe déjà avec cet email.' });

    // Compte créé déjà vérifié via l'adaptateur interne (pas par
    // signUpEmail, qui enverrait un email de vérification en trop) :
    // le SEUL message envoyé est le lien « définir le mot de passe ».
    try {
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: 'admin' });
      const password = await ctx.password.hash(crypto.randomBytes(24).toString('base64url') + 'Aa1!');
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password });
    } catch (err) {
      req.log.warn({ err }, 'admin account creation failed');
      return reply.code(502).send({ error: 'Création impossible.' });
    }
    try {
      await auth.api.requestPasswordReset({ body: { email, redirectTo: config.frontUrl + '/reinitialiser' } });
    } catch (err) {
      req.log.warn({ err }, 'admin invitation mail failed');
      return reply.code(502).send({ error: 'Compte créé mais email d’invitation non parti (SMTP).' });
    }
    await audit(req, 'account.invite', 'user', email, { name });
    return { ok: true };
  });

  /* ---------- Journal d'audit ---------- */
  app.get('/api/admin/audit', async () => {
    const { rows } = await pool.query(
      `SELECT id, admin_email, action, target_type, target_id, detail, ip, created_at::text
       FROM audit_log ORDER BY id DESC LIMIT 200`);
    return { entries: rows };
  });
}
