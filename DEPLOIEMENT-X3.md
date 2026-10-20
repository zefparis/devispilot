# Déploiement DevisPilot sur X3

Guide d'installation sur le serveur X3 (`192.168.1.166`, user `unipaycongo`).
Rien de ce guide n'a été exécuté sur X3 : à lancer depuis x2 via SSH ou sur X3 directement.
Les applications existantes (UniPay :3100, CongoGaming :3001, Art50 Check :3000, Hasanat :3200) ne sont pas touchées.

## Pré-requis vérifiés sur X3 (lecture seule, oct. 2026)

- Docker + Compose installés ; ~5,7 Gio RAM, ~687 Gio disque (5 % utilisé).
- `cloudflared.service` actif en systemd, tunnel `x3-unipay` géré par token
  (configuration des hostnames dans le dashboard Cloudflare Zero Trust).
- Pas de reverse proxy local ; les apps existantes écoutent sur `127.0.0.1`.
- Port choisi : **3400** (libre). Vérifier au moment du déploiement :
  `ssh unipaycongo@192.168.1.166 'ss -tln | grep 3400'`
  Si pris : choisir un autre port libre et ajuster `API_PORT` + le tunnel.

## 1. Installation

```bash
# Sur x2 (ou sur X3) — transférer le dépôt
git clone <url-du-depot> && cd devispilot
# ou rsync : rsync -a --exclude node_modules --exclude .git /home/ben/CascadeProjects/devispilot/ unipaycongo@192.168.1.166:devispilot/

cp .env.example .env
nano .env   # valeurs à renseigner (voir ci-dessous)
```

`.env` de production :

```bash
POSTGRES_PASSWORD=<généré : openssl rand -base64 24>
BETTER_AUTH_SECRET=<généré : openssl rand -base64 32>
BASE_URL=https://api.<domaine>              # origine publique de l'API
API_PORT=3400
CORS_ORIGINS=https://<domaine>,https://www.<domaine>   # frontend Vercel (apex + www)
FRONT_URL=https://<domaine>                 # liens des emails pointent ici
COOKIE_SAMESITE=lax                          # <domaine>/www + api.<domaine> = même site
COOKIE_DOMAIN=                               # vide : cookie host-only sur api.<domaine>
TRUST_PROXY=true

# Emails transactionnels — OBLIGATOIRE pour l'inscription
# (la vérification d'email est requise : sans SMTP l'inscription est refusée 503)
SMTP_HOST=<serveur-smtp>
SMTP_PORT=587
SMTP_USER=<utilisateur-smtp>
SMTP_PASS=<mot-de-passe-smtp>
MAIL_FROM=DevisPilot <noreply@<domaine>>

SIGNUP_ENABLED=true                          # inscription libre une fois SMTP actif ;
                                              # l'interrupteur du back-office est
                                              # prioritaire sur cette valeur

ADMIN_EMAILS=votre-email@<domaine>           # accès back-office /admin — liste
                                              # d'emails séparés par des virgules

# Abonnement Stripe — sk_test_* pour la préproduction, sk_live_* en prod
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...              # signing secret du webhook (étape 5)
STRIPE_PORTAL_RETURN_URL=https://<domaine>
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_TEAM_MONTHLY=price_...
STRIPE_PRICE_TEAM_YEARLY=price_...
TEAM_PLAN_ENABLED=false                    # offre Équipe masquée tant que
                                           # l'invitation de membres n'existe pas
```

`BASE_URL` en https active automatiquement les cookies `Secure`. `TRUST_PROXY=true`
requis : le trafic arrive via cloudflared (en-têtes `X-Forwarded-*`).

```bash
docker compose build
docker compose up -d          # migrations jouées automatiquement au démarrage de l'API
docker compose ps             # les deux services doivent être « healthy »
curl -s http://127.0.0.1:3400/api/health   # → {"ok":true}
```

## 2. Routage Cloudflare (à faire dans le dashboard, pas ici)

Le tunnel `x3-unipay` est géré côté dashboard (token). Ajouter une entrée :

- **Public hostname** : `api.<domaine>` → service `http://localhost:3400`

Le frontend est déployé séparément sur Vercel (`https://<domaine>` + `https://www.<domaine>`,
build `npm run build`, output `dist`, env `VITE_API_URL=https://api.<domaine>`).
L'API seule passe par le tunnel ; les requêtes sont cross-origin avec credentials —
`CORS_ORIGINS` doit lister les deux origines frontend exactes.

### Variables Vercel (pages légales)

Les pages `/mentions-legales`, `/cgv` et `/confidentialite` lisent leurs
valeurs depuis `config.js`, généré au build. Renseigner dans Vercel →
Settings → Environment Variables (toutes obligatoires — le build échoue sinon) :

```
LEGAL_NAME=…
LEGAL_SIREN=…
LEGAL_RCS=…
LEGAL_ADDRESS=…
LEGAL_EMAIL=…
LEGAL_VAT_MENTION=TVA non applicable, art. 293 B du CGI
LEGAL_PUBLISHER=…
```

La version des CGV (`CGV_VERSION` dans `server/src/legal.ts`) est diffusée au
front via `/api/config` — incrémenter la constante et redéployer l'API pour
exiger une ré-acceptation.

Vérifier ensuite : `curl -s https://api.<domaine>/api/health` et
`curl -s https://api.<domaine>/health`.

## 5. Configuration Stripe (dashboard)

1. **Produits** : créer 2 produits — « DevisPilot Pro » (prix mensuel + prix
   annuel, récurrents, EUR HT) et « DevisPilot Équipe » (mensuel + annuel).
   Copier les 4 `price_…` dans `.env`.
2. **Portail client** : Paramètres → Billing → Customer portal → activer
   (changement d'offre, moyen de paiement, factures, résiliation).
3. **Webhook** : Développeurs → Webhooks → ajouter un endpoint
   `https://api.<domaine>/api/stripe/webhook` avec les événements :
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`. Copier le *signing secret*
   (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`, puis `docker compose up -d api`.
4. Vérifier : `POST /api/billing/checkout` depuis l'espace client renvoie une
   URL `checkout.stripe.com`; l'événement test du dashboard apparaît traité
   (200) côté API.
5. **Conformité factures** (micro-entreprise, franchise de TVA) — Paramètres :
   - *Business* : nom légal, adresse et SIREN de l'entrepreneur.
   - *Customer portal → Factures* ou *Billing* : pied de facture avec
     « TVA non applicable, art. 293 B du CGI ».
   - *Public details* : descripteur de relevé `DEVISPILOT`, URL des CGV
     `https://<domaine>/cgv` et politique de confidentialité
     `https://<domaine>/confidentialite` (elles s'affichent aussi en bas de
     Checkout si renseignées dans les paramètres du compte).
   - Stripe Tax : ne pas activer (aucune TVA collectée ; `automatic_tax`
     n'est pas activé dans Checkout).

## 3. Création des premiers comptes

L'inscription publique (`SIGNUP_ENABLED=true`) exige un SMTP fonctionnel : la
vérification d'email est obligatoire, donc une inscription sans envoi d'email
est refusée (503) plutôt que de créer un compte bloqué.

- `SIGNUP_ENABLED=true` : les clients s'inscrivent seuls (email de vérification,
  24 h ; mot de passe ≥ 12 caractères ; nom + nom d'entreprise demandés au signup,
  entreprise créée à la première connexion).
- `SIGNUP_ENABLED=false` : créer les comptes depuis le back-office `/admin`
  (formulaire « Créer un compte client » — le client reçoit un email pour
  définir son mot de passe). L'interrupteur d'inscription du back-office,
  stocké en base, est prioritaire sur `SIGNUP_ENABLED` : il se règle aussi
  depuis `/admin`.

## Back-office administrateur

Accessible sur `https://<domaine>/admin` pour les comptes dont l'email figure
dans `ADMIN_EMAILS` (email vérifié requis). Fonctions : tableau de bord
(entrprises, utilisateurs, inscriptions 7/30 j, non vérifiés, devis), liste des
entreprises et des utilisateurs (recherche/tri), suspension/réactivation,
révocation de sessions, suppression de compte, interrupteur d'inscription,
création de compte par invitation et journal d'audit. L'administrateur ne voit
que des métadonnées — jamais le contenu des devis ni des clients finaux.

## 4. Sauvegardes

```bash
./scripts/backup.sh                    # → dumps/devispilot-<date>.dump
```

Copie hors X3 (manuel, non planifié) :

```bash
rsync -a unipaycongo@192.168.1.166:devispilot/dumps/ ~/sauvegardes/devispilot/
# ou : scp 'unipaycongo@192.168.1.166:devispilot/dumps/*.dump' ~/sauvegardes/devispilot/
```

Pour une sauvegarde planifiée : cron sur X3, ex. `0 3 * * * /home/unipaycongo/devispilot/scripts/backup.sh`
+ rétention (`find dumps -mtime +14 -delete`). À mettre en place explicitement —
rien n'est configuré par défaut.

## 5. Restauration (testée localement)

```bash
./scripts/restore.sh dumps/devispilot-<date>.dump
# confirmation « restaure » demandée ; arrête l'API, restaure, redémarre.
curl -s http://127.0.0.1:3400/api/health
```

La restauration remplace toutes les données (`pg_restore --clean --if-exists`).

## 6. Mises à jour et rollback

```bash
git pull                      # ou rsync de la nouvelle version
docker compose build api
./scripts/backup.sh           # toujours sauvegarder avant migration de schéma
docker compose up -d api      # les migrations SQL s'appliquent au démarrage
docker logs devispilot-api --tail 50
```

**Rollback** : les migrations sont additives-only dans cette phase
(pas de DROP). Revenir au commit précédent, `docker compose build api && up -d api`.
Si une migration future est incompatible : restaurer la sauvegarde d'avant
mise à jour (§5) puis redéployer l'ancienne image.
`docker image ls | grep devispilot` — garder le tag de l'image précédente.

## 7. Logs et exploitation

```bash
docker logs -f devispilot-api        # cookies, tokens et secrets masqués (pino redact)
docker logs -f devispilot-db
docker compose ps
```

## 8. Variables Stripe (préparation — rien d'actif)

L'abonnement DevisPilot (artisan → nous) n'est **pas** branché : pas de clé
secrète côté frontend, aucun droit accordé par un lien de retour.
Quand la phase suivante l'activera : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_SOLO`, `STRIPE_PRICE_TEAM` — vérification serveur + webhooks signés
idempotents. Le « lien de paiement » des réglages concerne les clients de
l'artisan (hors périmètre).

## 9. Emails transactionnels

Vérification d'email (obligatoire, lien 24 h), mot de passe oublié (lien 1 h,
usage unique) et changement d'email passent par le SMTP configuré
(`SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`). Les liens pointent vers `FRONT_URL`
(le front Vercel), pas vers l'API. Au démarrage, un warning est loggé si SMTP
est absent ; l'inscription publique est alors refusée (503 explicite).
`SMTP_HOST=log` = mode test : emails journalisés, aucun envoi réel.

## Limites connues

- Sessions en base PostgreSQL, 14 jours, révocables (liste + révocation dans
  l'onglet Compte, ou suppression de la ligne `session`).
- Rate-limit en mémoire (par processus) — suffisant pour un conteneur unique.
- Un seul utilisateur/entreprise aujourd'hui ; rôles `owner`/`member` prêts pour la suite.
- Pas de multi-instance : une API = une base.
- Changement d'email : le lien de confirmation part vers la nouvelle adresse ;
  l'ancienne reste l'identifiant jusqu'à validation.
