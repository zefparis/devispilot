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
// Origines frontend autorisées (déploiement séparé, ex. Vercel → api.<domaine>).
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);
// Origine du frontend pour les liens envoyés par email (vérification, reset).
const frontUrl = (process.env.FRONT_URL ?? corsOrigins[0] ?? baseUrl).replace(/\/$/, '');

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3400),
  // Dans le conteneur l'API écoute sur 0.0.0.0 ; en local sur loopback.
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: req('DATABASE_URL', 'postgres://devispilot:devispilot@127.0.0.1:5432/devispilot'),
  baseUrl,
  corsOrigins,
  frontUrl,
  // SameSite=Lax par défaut : front sur <domaine>/www + API sur api.<domaine>
  // sont le MÊME site (même domaine enregistrable) → Lax suffit et n'est pas
  // bloqué comme cookie tiers par Safari/Firefox. 'none' uniquement pour les
  // tests sur des origines d'un autre site (ex. *.vercel.app).
  cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'lax') === 'none' ? 'none' as const : 'lax' as const,
  // Pas d'attribut Domain par défaut : cookie host-only sur api.<domaine>.
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  // Inscription publique : activée en dev, à garder désactivée en production
  // tant que la vérification d'email n'est pas opérationnelle.
  signupEnabled: process.env.SIGNUP_ENABLED ? process.env.SIGNUP_ENABLED === 'true' : !isProd,
  authSecret: req('BETTER_AUTH_SECRET', 'dev-only-secret-change-me-0123456789abcdef'),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : baseUrl.startsWith('https:'),
  // Cookie SameSite=Lax : navigation normale OK, POST inter-sites bloqué (avec garde CSRF en plus).
  staticRoot: process.env.STATIC_ROOT ?? path.resolve(__dirname, '../../public'),
  // cloudflared (tunnel sur l'hôte) relaie X-Forwarded-* : trustProxy actif par défaut.
  trustProxy: process.env.TRUST_PROXY !== 'false',
  // Débit /api/auth/* par IP (anti force brute). Surchargeable en test.
  rateLimitAuth: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30),
  // Emails autorisés à administrer (back-office /api/admin/*). Env seule,
  // jamais exposée côté front ni via l'API.
  adminEmails: new Set(
    (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  ),
  // SMTP pour les emails transactionnels (vérification, reset). Sans SMTP,
  // l'inscription publique est refusée (cf. garde dans app.ts).
  // SMTP_HOST=log → driver de test : emails capturés en mémoire, aucun réseau.
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'DevisPilot <noreply@localhost>',
  },
  // Abonnement Stripe (mode test ou live selon la clé). Sans clé, la
  // facturation est désactivée et /api/billing renvoie enabled:false.
  // Les montants affichés sont relus depuis l'API Stripe — jamais codés en dur.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL ?? '',
    prices: {
      pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? '',
      pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY ?? '',
      team_monthly: process.env.STRIPE_PRICE_TEAM_MONTHLY ?? '',
      team_yearly: process.env.STRIPE_PRICE_TEAM_YEARLY ?? '',
    },
    // L'offre Équipe est masquée (landing, abonnement, Checkout refusé) tant
    // que l'invitation de membres n'existe pas. Le code et les price IDs restent.
    teamPlanEnabled: process.env.TEAM_PLAN_ENABLED === 'true',
  },
};
