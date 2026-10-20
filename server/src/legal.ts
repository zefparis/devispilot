import { pool } from './db.js';

// Version des CGV — à incrémenter à chaque modification du texte : les
// utilisateurs connectés devront ré-accepter (bandeau dans l'app).
export const CGV_VERSION = '2026-10-20';

export async function cgvAccepted(userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM cgv_acceptances WHERE user_id=$1 AND version=$2',
    [userId, CGV_VERSION]);
  return rows.length > 0;
}

export async function recordCgvAcceptance(userId: string, ip: string): Promise<void> {
  await pool.query(
    `INSERT INTO cgv_acceptances (user_id, version, ip) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, version) DO NOTHING`,
    [userId, CGV_VERSION, ip]);
}

// L'en-tête applicatif CSRF distingue l'inscription publique des créations
// internes (invitation admin via auth.api) : seule la voie publique exige
// l'acceptation interactive des CGV.
export const isPublicAuthCall = (headers: Headers | undefined) =>
  headers?.get('x-devispilot-client') === '1';
