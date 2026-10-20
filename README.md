# DevisPilot

Prototype de suivi de devis et de relances pour petites entreprises de climatisation/chauffage.
Frontend HTML/CSS/JavaScript buildless (sources `public/`, build minimal `npm run build` → `dist/` pour Vercel), API Node.js/TypeScript + Fastify + PostgreSQL (`server/`), déploiement Vercel (front) + Docker Compose sur X3 (API, tunnel Cloudflare).

## Architecture

- `public/` — frontend statique. Servi par l'API en auto-hébergement (même origine, cookies HttpOnly) ou déployé sur Vercel (`dist/` généré, `config.js` injecte `VITE_API_URL` → cookies cross-site SameSite=None;Secure + CORS).
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

Mode démo : boutons « Tester la démo » — données fictives en mémoire, **aucun accès serveur**, aucune écriture dans une entreprise réelle.

## Ce qui fonctionne

Inscription/connexion (inscription désactivable via `SIGNUP_ENABLED`), création d'entreprise, sessions HttpOnly, devis CRUD, file de relances, confirmation manuelle avec prochaine date (atomique + idempotent), messages déterministes modifiables, import CSV validé (anti-doublon par empreinte), export CSV (BOM, neutralisation de formules), migration explicite des devis localStorage avec aperçu/bilan, réglages signature + Payment Link validé `buy.stripe.com`.

## Limites (affichées dans le produit)

Aucune vérification de paiement (« Paiements non connectés »), pas d'envoi automatique (copier/mailto uniquement), pas d'IA, inscription publique fermée en production tant que l'email transactionnel n'est pas configuré, pas de « mot de passe oublié », pas d'abonnement Stripe — les tarifs affichés sont des offres pilotes dont le périmètre reste à définir.

## Commercial

Offres pilotes affichées : Solo 19 € HT/mois, Équipe 39 € HT/mois, installation accompagnée facultative 99 € HT. Fonctionnalités et limites commerciales à définir. Aucun produit/abonnement Stripe créé ; la future activation reposera sur vérification serveur et webhooks signés idempotents (voir DEPLOIEMENT-X3.md §8).
