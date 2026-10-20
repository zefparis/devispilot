import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { config } from './config.js';
import { auth } from './auth.js';
import { nodeHeaders } from './guards.js';
import { smtpConfigured, mailDriver } from './mailer.js';
import quoteRoutes from './routes/quotes.js';
import settingsRoutes from './routes/settings.js';
import importRoutes from './routes/imports.js';
import profileRoutes from './routes/profile.js';
import adminRoutes from './routes/admin.js';
import { signupEnabledNow } from './settings.js';
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

  // CORS : origines frontend autorisées (CORS_ORIGINS). Cookies inclus
  // (sessions cross-site). Aucune origine configurée = même origine seule.
  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
    });
  }

  // CSRF : toute mutation /api exige l'en-tête applicatif, et l'Origin,
  // quand elle est présente, doit correspondre à l'hôte servi.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin) {
      const allowed = config.corsOrigins.includes(origin)
        || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (!allowed) return reply.code(403).send({ error: 'Origine refusée.' });
    }
    if (req.headers['x-devispilot-client'] !== '1')
      return reply.code(403).send({ error: 'Requête bloquée (protection CSRF).' });
  });

  // Better Auth sur /api/auth/* — débit resserré contre le force brute.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: config.rateLimitAuth, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const pathname = new URL(req.raw.url ?? '/', 'http://x').pathname;
      if (pathname === '/api/auth/sign-up/email') {
        // L'interrupteur en base (back-office) est prioritaire sur l'env.
        if (!(await signupEnabledNow()))
          return reply.code(403).send({ error: 'Les inscriptions sont fermées pour le moment.' });
        // La vérification d'email est obligatoire : sans SMTP, l'inscription
        // créerait un compte inutilisable → on la refuse explicitement.
        if (!smtpConfigured())
          return reply.code(503).send({ error: 'Inscription indisponible : envoi d’emails non configuré (SMTP).' });
      }
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

  if (!smtpConfigured())
    app.log.warn('SMTP non configuré (SMTP_HOST) : aucun email transactionnel ne pourra être envoyé. L\'inscription publique sera refusée tant que SMTP n\'est pas défini.');
  else if (mailDriver() === 'log')
    app.log.warn('SMTP_HOST=log : les emails sont journalisés, aucun envoi réel (mode test).');

  await app.register(miscRoutes);
  await app.register(quoteRoutes);
  await app.register(settingsRoutes);
  await app.register(profileRoutes);
  await app.register(importRoutes);
  await app.register(adminRoutes);

  // Frontend statique (même origine que /api) + repli mono-page.
  await app.register(fastifyStatic, { root: config.staticRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    reply.code(404).send({ error: 'Introuvable.' });
  });

  return app;
}
