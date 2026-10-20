import { betterAuth } from 'better-auth';
import { pool } from './db.js';
import { config } from './config.js';

// Authentification gérée par Better Auth (sessions serveur révocables,
// hachage des mots de passe, cookies HttpOnly). Aucune crypto maison.
export const auth = betterAuth({
  database: pool,
  secret: config.authSecret,
  baseURL: `${config.baseUrl}/api/auth`,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14,      // 14 jours
    updateAge: 60 * 60 * 24,           // glissement quotidien
  },
  advanced: {
    useSecureCookies: config.cookieSecure || config.crossSite,
    cookiePrefix: 'dp',
    // Front sur une autre origine (ex. Vercel ↔ api.<domaine>) : SameSite=None
    // est requis pour que le cookie de session soit envoyé (HTTPS obligatoire).
    ...(config.crossSite
      ? { defaultCookieAttributes: { sameSite: 'none' as const, secure: true, httpOnly: true } }
      : {}),
    // Inscription publique bloquée aussi côté route (voir routes/auth.ts).
    disableCSRFCheck: false,
    database: {
      // Le schéma est garanti par server/migrations (jouées au démarrage) :
      // le contrôle runtime de Better Auth s'exécute avant migrate() et
      // met en cache un faux « schéma manquant » sur base fraîche.
      validateSchema: false,
    },
  },
  trustedOrigins: [config.baseUrl, ...config.corsOrigins],
  logger: { level: 'warn' },
});

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
