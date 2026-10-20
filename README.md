# DevisPilot

Prototype de suivi de devis et de relances pour petites entreprises de climatisation/chauffage.
Frontend HTML/CSS/JavaScript buildless (sources `public/`, build minimal `npm run build` → `dist/` pour Vercel), API Node.js/TypeScript + Fastify + PostgreSQL (`server/`), déploiement Vercel (front) + Docker Compose sur X3 (API, tunnel Cloudflare).

## Architecture

- `public/` — frontend statique. Servi par l'API en auto-hébergement (même origine, cookies HttpOnly) ou déployé sur Vercel (`dist/` généré, `config.js` injecte `VITE_API_URL` → CORS avec credentials + cookie `SameSite=Lax` : le front sur `<domaine>`/`www.<domaine>` et l'API sur `api.<domaine>` forment le **même site**, donc `Lax` suffit et n'est pas bloqué par Safari/Firefox. `COOKIE_SAMESITE=none` n'est utile que pour tester depuis une origine d'un autre site (`*.vercel.app`) — peut échouer sur Safari. Cookie host-only : pas d'attribut `Domain` sauf `COOKIE_DOMAIN` explicite).
- `server/` — API Fastify : Better Auth (sessions serveur en base, révocables), isolation par entreprise via `memberships`, protection CSRF (en-tête `x-devispilot-client` + contrôle d'origine), rate-limit, montants en centimes, relances atomiques et idempotentes.
- `server/migrations/` — schéma versionné, appliqué automatiquement au démarrage.
- `docker-compose.yml` — PostgreSQL privé (aucun port publié) + API publiée sur `127.0.0.1:${API_PORT}` pour cloudflared hôte.
- `scripts/backup.sh`, `scripts/restore.sh` — sauvegarde/restauration PostgreSQL.
- `DEPLOIEMENT-X3.md` — guide complet de déploiement sur le serveur X3.

## Développement local

```bash
# PostgreSQL de dev
docker run -d --name dp-pg -e POSTGRES_USER=devispilot -e POSTGRES_PASSWORD=devispilot -e POSTGRES_DB=devispilot -p 127.0.0.1:5444:5432 postgres:17-alpine

cd server
npm ci
DATABASE_URL=postgres://devispilot:devispilot@127.0.0.1:5444/devispilot \
PORT=3410 BASE_URL=http://localhost:3410 BETTER_AUTH_SECRET=<32+ chars> \
npm run dev          # migrations auto + API+front sur http://localhost:3410

npm test             # suite d'intégration (12 tests, base dédiée jetable)
npm run typecheck
node --check public/app.js
```

## Ce qui fonctionne

Comptes réels : inscription (email + mot de passe ≥ 12 caractères, `SIGNUP_ENABLED`), **vérification d'email obligatoire** (lien valable 24 h), connexion/déconnexion (erreur générique anti-énumération), **mot de passe oublié** (lien 1 h, usage unique), changement d'email avec re-vérification, changement de mot de passe, sessions listables/révocables, export RGPD en JSON, suppression de compte (confirmation par mot de passe, données liées effacées en cascade). Emails transactionnels via SMTP (`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `FRONT_URL` pour les liens) — sans SMTP configuré l'inscription publique est refusée (log clair au démarrage).

**Back-office exploitant** sur `/admin` : réservé aux emails de `ADMIN_EMAILS` (vérifiés côté serveur à chaque requête, aucun rôle à cocher dans l'UI). Statistiques d'ensemble (dont abonnés payants et MRR), listes d'entreprises (dont offre et statut d'abonnement) et d'utilisateurs (recherche/tri, métadonnées uniquement — jamais de contenu de devis), suspension/réactivation avec révocation des sessions, suppression de compte, interrupteur d'inscription stocké en base (prioritaire sur `SIGNUP_ENABLED`), création de compte par invitation par email, journal d'audit de chaque action administrateur.

**Abonnement Stripe** : Gratuit (10 devis actifs, sans carte) / Pro (illimité) / Équipe, en mensuel et annuel — souscription via Stripe Checkout (code promo accepté), gestion via le portail client Stripe, webhooks signés et idempotents comme source de vérité (`stripe_secret_key`, `stripe_webhook_secret`, `stripe_portal_return_url`, `stripe_price_*`). Les montants affichés sont relus depuis l'API Stripe, la limite Gratuit est appliquée côté serveur. Sans clé, la facturation est désactivée proprement.

Métier : création d'entreprise, sessions HttpOnly, devis CRUD, file de relances, confirmation manuelle avec prochaine date (atomique + idempotent), messages déterministes modifiables, import CSV validé (anti-doublon par empreinte), export CSV (BOM, neutralisation de formules), réglages signature + Payment Link validé `buy.stripe.com`, fiche entreprise (raison sociale, SIREN/SIRET, adresse, téléphone, email de contact, logo ≤ 200 Ko). Aucune donnée fictive.

**Conformité** : pages `/mentions-legales`, `/cgv` (acceptation versionnée obligatoire à l'inscription et à la souscription, `cgv_acceptances` en base, ré-acceptation exigée au changement de `CGV_VERSION` dans `server/src/legal.ts`) et `/confidentialite` (avec accord de sous-traitance art. 28 RGPD). Valeurs injectées au build via les variables `LEGAL_*` — le build échoue en production si l'une manque.

## Limites (affichées dans le produit)

Pas d'envoi automatique de relances (copier/mailto uniquement), pas d'IA, offre Équipe masquée (`TEAM_PLAN_ENABLED=false`) tant que l'invitation de membres n'existe pas.

## Commercial

Offres Gratuit / Pro en mensuel et annuel, prix relus depuis l'API Stripe (aucun montant codé en dur), affichés sans TVA avec la mention de franchise. Souscription via Stripe Checkout, gestion via le portail client, webhooks signés et idempotents (voir DEPLOIEMENT-X3.md §5).
