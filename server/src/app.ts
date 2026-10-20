import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { auth } from './auth.js';
import { nodeHeaders } from './guards.js';
import quoteRoutes from './routes/quotes.js';
import settingsRoutes from './routes/settings.js';
import importRoutes from './routes/imports.js';
import miscRoutes from './routes/misc.js';

export async function buildApp() {
  const app = Fastify({
    // Journalisation sans secrets : cookies, en-têtes d'auth et set-cookie masqués.
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
    },
    trustProxy: config.trustProxy,
  });
  (app as any).signupEnabled = config.signupEnabled;

  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // CSRF : toute mutation /api exige l'en-tête applicatif, et l'Origin,
  // quand elle est présente, doit correspondre à l'hôte servi.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host)
          return reply.code(403).send({ error: 'Origine refusée.' });
      } catch {
        return reply.code(403).send({ error: 'Origine invalide.' });
      }
    }
    if (req.headers['x-devispilot-client'] !== '1')
      return reply.code(403).send({ error: 'Requête bloquée (protection CSRF).' });
  });

  // Better Auth sur /api/auth/* — débit resserré contre le force brute.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const pathname = new URL(req.raw.url ?? '/', 'http://x').pathname;
      if (!config.signupEnabled && pathname === '/api/auth/sign-up/email')
        return reply.code(403).send({ error: 'Inscription fermée dans cette phase pilote.' });
      const url = new URL(req.raw.url ?? '/', `${req.protocol}://${req.headers.host}`);
      const headers = nodeHeaders(req);
      const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers };
      // Le flux brut est déjà consommé par le parseur Fastify : on re-sérialise le JSON.
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.body = JSON.stringify(req.body ?? {});
        headers.set('content-type', 'application/json');
      }
      const res = await auth.handler(new Request(url, init as RequestInit));
      reply.status(res.status);
      res.headers.forEach((v, k) => { if (k.toLowerCase() !== 'set-cookie') reply.header(k, v); });
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length) reply.header('set-cookie', cookies);
      reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : undefined);
    },
  });

  await app.register(miscRoutes);
  await app.register(quoteRoutes);
  await app.register(settingsRoutes);
  await app.register(importRoutes);

  // Frontend statique (même origine que /api) + repli mono-page.
  await app.register(fastifyStatic, { root: config.staticRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    reply.code(404).send({ error: 'Introuvable.' });
  });

  return app;
}
