import { pool } from './db.js';
import { config } from './config.js';

// Réglages applicatifs en base (table app_settings) — prioritaires sur les
// variables d'environnement, modifiables depuis le back-office admin.

export async function settingValue<T>(key: string): Promise<T | undefined> {
  const { rows } = await pool.query<{ value: T }>(
    'SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0]?.value;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
    [key, JSON.stringify(value)]);
}

// Inscription publique : la valeur en base (interrupteur admin) est prioritaire
// sur SIGNUP_ENABLED. Sans ligne en base, l'env décide.
export async function signupEnabledNow(): Promise<boolean> {
  const v = await settingValue<boolean>('signup_enabled');
  return v === undefined ? config.signupEnabled : !!v;
}
