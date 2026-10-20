// Build frontend DevisPilot : copie public/ → dist/ et génère config.js
// avec l'URL de l'API (VITE_API_URL ou API_URL). Sans dépendance.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiUrl = (process.env.VITE_API_URL ?? process.env.API_URL ?? '').replace(/\/+$/, '');

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'dist', 'config.js'),
  `// Généré par build.mjs — ne pas éditer.\nwindow.DP_API_URL = ${JSON.stringify(apiUrl)};\n`,
);

console.log(`dist/ généré depuis public/ (API : ${apiUrl || 'même origine'})`);
