// Build frontend DevisPilot : copie public/ → dist/ et génère config.js
// avec l'URL de l'API (VITE_API_URL ou API_URL). Sans dépendance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const apiUrl = (process.env.VITE_API_URL ?? process.env.API_URL ?? '').replace(/\/+$/, '');

const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
// Exclut public/dist de la copie (artefact de build précédent, cf. ci-dessous).
fs.cpSync(publicDir, out, { recursive: true, filter: src => path.basename(src) !== 'dist' });
fs.writeFileSync(
  path.join(out, 'config.js'),
  `// Généré par build.mjs — ne pas éditer.\nwindow.DP_API_URL = ${JSON.stringify(apiUrl)};\n`,
);

// Vercel cherche <entrypointDir>/dist (ou <Root Directory>/dist). Si le projet
// Vercel pointe sur public/ (ou l'entrypoint public/index.html), la sortie doit
// y exister aussi — même contenu.
const nested = path.join(publicDir, 'dist');
fs.rmSync(nested, { recursive: true, force: true });
fs.cpSync(out, nested, { recursive: true });

console.log(`dist/ généré depuis public/ (API : ${apiUrl || 'même origine'})`);
