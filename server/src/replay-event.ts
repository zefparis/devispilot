// Rejeu manuel d'un événement Stripe (après un échec de traitement du
// webhook, visible en erreur dans les logs de l'API avec l'event_id).
// L'événement est relu depuis l'API Stripe — pas de signature requise.
// Toutes les écritures de processStripeEvent sont idempotentes.
//
//   local : npm run stripe:replay -- evt_xxxxxxxxxxxx
//   x3    : docker compose exec api node dist/replay-event.js evt_xxxxxxxxxxxx
//
// Exige DATABASE_URL + STRIPE_SECRET_KEY (déjà présents dans l'env du conteneur).

import { pool } from './db.js';
import { stripe } from './stripe.js';
import { processStripeEvent } from './stripe-events.js';

const eventId = process.argv[2];
if (!eventId) {
  console.error('usage: replay-event.js <event_id>');
  process.exit(2);
}
const s = stripe();
if (!s) {
  console.error('STRIPE_SECRET_KEY non configurée.');
  process.exit(1);
}

try {
  const event = await s.events.retrieve(eventId);
  await processStripeEvent(event, console);
  // Marque l'événement comme traité pour l'idempotence des futures livraisons.
  await pool.query(
    'INSERT INTO stripe_events (event_id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [event.id, (event as any).type ?? '']);
  console.log(`Événement ${event.id} (${event.type}) rejoué avec succès.`);
} catch (err) {
  console.error('Rejeu impossible :', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
