import type { FastifyInstance } from 'fastify';
import { requireSession } from '../guards.js';
import { CGV_VERSION, recordCgvAcceptance } from '../legal.js';

export default async function legalRoutes(app: FastifyInstance) {
  // Acceptation de la version courante des CGV (re-acceptation après
  // changement de version, ou première acceptation d'un compte invité).
  app.post('/api/legal/accept', { preHandler: requireSession }, async (req, reply) => {
    const v = String((req.body as any)?.version ?? '');
    if (v !== CGV_VERSION)
      return reply.code(400).send({ error: 'Version des CGV inattendue.', code: 'CGV_VERSION' });
    await recordCgvAcceptance(req.userId!, req.ip ?? '');
    return { ok: true, version: CGV_VERSION };
  });
}
