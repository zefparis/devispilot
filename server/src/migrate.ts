import { migrate, pool } from './db.js';

const applied = await migrate();
console.log(applied.length ? `Appliquées : ${applied.join(', ')}` : 'Aucune migration en attente.');
await pool.end();
