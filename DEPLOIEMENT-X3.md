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
BASE_URL=https://<hostname-du-tunnel>      # ex. https://devispilot.example.fr
API_PORT=3400
SIGNUP_ENABLED=false                        # tant que l'email de vérification n'est pas branché
```

`BASE_URL` en https active automatiquement les cookies `Secure`.

```bash
docker compose build
docker compose up -d          # migrations jouées automatiquement au démarrage de l'API
docker compose ps             # les deux services doivent être « healthy »
curl -s http://127.0.0.1:3400/api/health   # → {"ok":true}
```

## 2. Routage Cloudflare (à faire dans le dashboard, pas ici)

Le tunnel `x3-unipay` est géré côté dashboard (token). Ajouter une entrée :

- **Public hostname** : `devispilot.<domaine>` → service `http://localhost:3400`

L'API et le frontend sont servis par le même service (`/` → statique, `/api/*` → API) :
une seule entrée suffit, sessions et CSRF simplifiés. Ne pas activer de redirection
TLS côté Cloudflare autre que le mode habituel ; `TRUST_PROXY=false` est correct
car cloudflared contacte directement `127.0.0.1:3400`.

Vérifier ensuite : `curl -s https://devispilot.<domaine>/api/health`

## 3. Création des premiers comptes

`SIGNUP_ENABLED=false` bloque `/api/auth/sign-up/email`. Pour créer un compte pilote :

```bash
# Option A — ouverture ponctuelle (recommandée, simple)
docker compose stop api
SIGNUP_ENABLED=true docker compose up -d api   # ou éditer .env puis up -d
# → créer le compte depuis l'interface, puis remettre SIGNUP_ENABLED=false
docker compose up -d api
```

Option B (sans rouvrir l'inscription) : insérer via `psql` dans `user` + `account`
(hash du mot de passe attendu par Better Auth) — déconseillée, préférer A.

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

## 9. Emails transactionnels (non configurés)

Réinitialisation de mot de passe et vérification d'email nécessitent un
transport SMTP. Prévu dans Better Auth (`sendResetPassword` / `sendVerificationEmail`)
— variables à prévoir : `SMTP_URL` ou équivalent, `EMAIL_FROM`. Tant que ce n'est
pas câblé : pas de lien « mot de passe oublié » dans l'UI (volontaire).

## Limites connues

- Sessions en base PostgreSQL, 14 jours, révocables (suppression de la ligne `session`).
- Rate-limit en mémoire (par processus) — suffisant pour un conteneur unique.
- Un seul utilisateur/entreprise aujourd'hui ; rôles `owner`/`member` prêts pour la suite.
- Pas de multi-instance : une API = une base.
