import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth.js';
import { pool } from './db.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    companyId?: string;
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
  req.userId = session.user.id;
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
