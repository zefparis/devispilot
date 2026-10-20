import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth.js';
import { pool } from './db.js';
import { config } from './config.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    companyId?: string;
    sessionId?: string;
  }
}

export function nodeHeaders(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(', '));
  }
  return h;
}

// Résolution de la session serveur (Better Auth) — aucun jeton côté client.
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: nodeHeaders(req) }).catch(() => null);
  if (!session?.user?.id) {
    await reply.code(401).send({ error: 'Session requise.' });
    return;
  }
  // Un compte suspendu ne peut plus agir même s'il détient encore une session.
  const { rows } = await pool.query<{ suspended_at: string | null }>(
    'SELECT suspended_at FROM "user" WHERE id=$1', [session.user.id]);
  if (rows[0]?.suspended_at) {
    await reply.code(403).send({ error: 'Compte suspendu. Contactez le support.', code: 'SUSPENDED' });
    return;
  }
  req.userId = session.user.id;
  req.sessionId = session.session.id;
}

// Garde du back-office : session valide + email vérifié + présence dans
// ADMIN_EMAILS (env). Aucune confiance au front : tout est vérifié ici.
// ── Point d'extension 2FA ──
// Lorsque le plugin twoFactor de Better Auth sera activé, vérifier ici que
// la session de l'administrateur a passé le second facteur avant d'autoriser.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireSession(req, reply);
  if (reply.sent || !req.userId) return;
  const { rows } = await pool.query<{ email: string; verified: boolean }>(
    'SELECT email, "emailVerified" AS verified FROM "user" WHERE id=$1', [req.userId]);
  const u = rows[0];
  if (!u || !config.adminEmails.has(u.email.toLowerCase())) {
    await reply.code(403).send({ error: 'Accès réservé à l’exploitant.' });
    return;
  }
  if (!u.verified) {
    await reply.code(403).send({ error: 'Email administrateur non vérifié.' });
    return;
  }
}

// L'entreprise autorisée est déterminée côté serveur depuis la session.
// Jamais depuis un identifiant fourni par le client.
export async function requireCompany(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireSession(req, reply);
  if (reply.sent || !req.userId) return;
  const { rows } = await pool.query<{ company_id: string }>(
    'SELECT company_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1',
    [req.userId],
  );
  if (!rows.length) {
    await reply.code(409).send({ error: 'Aucune entreprise associée à ce compte.', code: 'NO_COMPANY' });
    return;
  }
  req.companyId = rows[0].company_id;
}
