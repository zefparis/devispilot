// Build frontend Perspecta : copie public/ → dist/ et génère config.js
// avec l'URL de l'API (VITE_API_URL ou API_URL). Sans dépendance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const apiUrl = (process.env.VITE_API_URL ?? process.env.API_URL ?? '').replace(/\/+$/, '');

// Informations légales injectées à la compilation (Vercel env) — aucune
// donnée en dur dans le HTML. En prod (Vercel/CI) une variable absente
// interrompt le build ; en dev local, avertissement visible sur les pages.
const LEGAL_KEYS = ['LEGAL_NAME', 'LEGAL_SIREN', 'LEGAL_RCS', 'LEGAL_ADDRESS',
  'LEGAL_EMAIL', 'LEGAL_VAT_MENTION', 'LEGAL_PUBLISHER'];
const missing = LEGAL_KEYS.filter(k => !process.env[k]);
const strict = process.env.VERCEL || process.env.CI || process.env.NODE_ENV === 'production';
if (missing.length && strict) {
  console.error(`Variables légales manquantes : ${missing.join(', ')}\nLe build est interrompu en production.`);
  process.exit(1);
}
if (missing.length) console.warn(`Variables légales non définies (dev) : ${missing.join(', ')}`);

const legal = {
  name: process.env.LEGAL_NAME ?? '',
  siren: process.env.LEGAL_SIREN ?? '',
  rcs: process.env.LEGAL_RCS ?? '',
  address: process.env.LEGAL_ADDRESS ?? '',
  email: process.env.LEGAL_EMAIL ?? '',
  vatMention: process.env.LEGAL_VAT_MENTION ?? '',
  publisher: process.env.LEGAL_PUBLISHER ?? '',
};

const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
// Exclut public/dist de la copie (artefact de build précédent, cf. ci-dessous).
fs.cpSync(publicDir, out, { recursive: true, filter: src => path.basename(src) !== 'dist' });
fs.writeFileSync(
  path.join(out, 'config.js'),
  `// Généré par build.mjs — ne pas éditer.\nwindow.DP_API_URL = ${JSON.stringify(apiUrl)};\nwindow.DP_LEGAL = ${JSON.stringify(legal)};\nwindow.DP_LEGAL_MISSING = ${JSON.stringify(missing)};\n`,
);

// Vercel cherche <entrypointDir>/dist (ou <Root Directory>/dist). Si le projet
// Vercel pointe sur public/ (ou l'entrypoint public/index.html), la sortie doit
// y exister aussi — même contenu.
const nested = path.join(publicDir, 'dist');
fs.rmSync(nested, { recursive: true, force: true });
fs.cpSync(out, nested, { recursive: true });

console.log(`dist/ généré depuis public/ (API : ${apiUrl || 'même origine'})`);
