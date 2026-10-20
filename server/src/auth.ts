import { betterAuth } from 'better-auth';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { pool } from './db.js';
import { config } from './config.js';
import { sendMail, EMAIL_TEMPLATES } from './mailer.js';

// Authentification gérée par Better Auth (sessions serveur révocables,
// hachage des mots de passe, cookies HttpOnly). Aucune crypto maison.
export const auth = betterAuth({
  database: pool,
  secret: config.authSecret,
  baseURL: `${config.baseUrl}/api/auth`,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: true,
    // Connexion bloquée tant que l'email n'est pas vérifié.
    requireEmailVerification: true,
    sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
      // Le lien pointe vers le FRONT (SPA), qui poste ensuite le nouveau mot de passe.
      const url = `${config.frontUrl}/reinitialiser?token=${encodeURIComponent(token)}`;
      await sendMail({ to: user.email, subject: 'DevisPilot — réinitialisation du mot de passe', text: EMAIL_TEMPLATES.resetPassword(url) });
    },
    resetPasswordTokenExpiresIn: 60 * 60, // 1 h, usage unique géré par Better Auth
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24, // lien de vérification valable 24 h
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
      // url pointe sur l'API (vérification serveur) ; la redirection finale
      // renvoie vers le front après succès.
      const u = new URL(url);
      u.searchParams.set('callbackURL', config.frontUrl + '/?verifie=1');
      await sendMail({ to: user.email, subject: 'DevisPilot — confirmez votre email', text: EMAIL_TEMPLATES.verify(u.toString()) });
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailVerification: async ({ newEmail, url }: { newEmail: string; url: string }) => {
        const u = new URL(url);
        u.searchParams.set('callbackURL', config.frontUrl + '/?verifie=1');
        await sendMail({ to: newEmail, subject: 'DevisPilot — confirmez votre nouvelle adresse', text: EMAIL_TEMPLATES.changeEmail(u.toString()) });
      },
    },
    deleteUser: {
      enabled: true,
      // Avant de supprimer l'utilisateur : supprimer les entreprises dont il
      // est le seul membre (les devis/relances/réglages partent en CASCADE).
      beforeDelete: async (user: { id: string }) => {
        await pool.query(
          `DELETE FROM companies c
            WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = c.id AND m.user_id = $1)
              AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.company_id = c.id AND m2.user_id <> $1)`,
          [user.id],
        );
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14,      // 14 jours
    updateAge: 60 * 60 * 24,           // glissement quotidien
  },
  advanced: {
    useSecureCookies: config.cookieSecure || config.cookieSameSite === 'none',
    cookiePrefix: 'dp',
    // Lax en prod (même site, sous-domaines), None seulement via COOKIE_SAMESITE.
    // Aucun Domain sans COOKIE_DOMAIN : cookie host-only sur l'API.
    defaultCookieAttributes: {
      sameSite: config.cookieSameSite,
      secure: config.cookieSecure || config.cookieSameSite === 'none',
      httpOnly: true,
      ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    },
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
  // Un compte suspendu ne peut plus se connecter.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String(ctx.body?.email ?? '').toLowerCase();
      if (!email) return;
      const { rows } = await pool.query<{ suspended_at: string | null }>(
        'SELECT suspended_at FROM "user" WHERE lower(email)=$1', [email]);
      if (rows[0]?.suspended_at)
        throw new APIError('FORBIDDEN', { message: 'Compte suspendu. Contactez le support.' });
    }),
  },
  logger: { level: 'warn' },
});

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
