import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';
const baseUrl = process.env.BASE_URL ?? 'http://localhost:3400';

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3400),
  // Dans le conteneur l'API écoute sur 0.0.0.0 ; en local sur loopback.
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: req('DATABASE_URL', 'postgres://devispilot:devispilot@127.0.0.1:5432/devispilot'),
  baseUrl,
  // Inscription publique : activée en dev, à garder désactivée en production
  // tant que la vérification d'email n'est pas opérationnelle.
  signupEnabled: process.env.SIGNUP_ENABLED ? process.env.SIGNUP_ENABLED === 'true' : !isProd,
  authSecret: req('BETTER_AUTH_SECRET', 'dev-only-secret-change-me-0123456789abcdef'),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : baseUrl.startsWith('https:'),
  // Cookie SameSite=Lax : navigation normale OK, POST inter-sites bloqué (avec garde CSRF en plus).
  staticRoot: process.env.STATIC_ROOT ?? path.resolve(__dirname, '../../dist'),
  trustProxy: process.env.TRUST_PROXY === 'true',
};
