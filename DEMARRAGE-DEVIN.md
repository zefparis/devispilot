# Reprise du projet DevisPilot

## Démarrer
Application statique HTML/CSS/JavaScript sans dépendance ni compilation.
Sources dans `public/` ; `dist/` est généré par `npm run build` (copie + config API).
Depuis ce dossier : `python3 -m http.server 8080 --directory public`, puis ouvrir http://localhost:8080.
Vérification JavaScript : `node --check public/app.js`.
Pour Vercel : build `npm run build`, dossier de sortie `dist` (voir vercel.json).

## Mission initiale pour Devin
Auditer ce prototype et proposer un plan avant toute réécriture. Conserver le design et les fonctionnalités existantes sauf amélioration justifiée. Créer un dépôt Git propre à ce projet et travailler par étapes avec des previews.
1. Vérifier les parcours desktop/mobile et améliorer onboarding, navigation, ajout de devis et relances.
2. Proposer une architecture SaaS : authentification, isolation des entreprises et base serveur durable.
3. Intégrer Stripe côté serveur : abonnements, signature des webhooks, idempotence et portail client. Aucun droit d'accès ne doit dépendre du localStorage ou d'une URL de retour.
4. Ajouter sauvegarde, export/suppression, gestion des erreurs et tests critiques.
5. Configurer les envois seulement après choix du fournisseur et validation du parcours. Ne pas présenter les modèles déterministes comme de l'IA.

## État réel
Prototype privé de validation commerciale. Stockage navigateur uniquement, pas de synchronisation ni de comptes clients. Les messages sont préparés puis envoyés manuellement. Le lien Stripe est configurable mais aucun compte Stripe ni clé n'est connecté. Les signatures et relances sont déclaratives. Les tarifs sont des hypothèses commerciales.

Le code applicatif est repris à l'identique du prototype livré. Métadonnées d'hébergement ChatGPT et historique Git exclus pour faciliter la migration. Aucun secret inclus.
