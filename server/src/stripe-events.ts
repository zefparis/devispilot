import { pool } from './db.js';
import { planForPrice } from './stripe.js';

// Traitement des événements Stripe — partagé entre le webhook signé
// (routes/billing.ts) et le rejeu manuel (replay-event.ts). Toutes les
// écritures sont des UPDATE idempotents : rejouer un événement est sûr.

// Logger minimal compatible FastifyBaseLogger (req.log) et console (script).
export interface EventLog {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

async function applySubscription(sub: any, log: EventLog): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  // current_period_end a migré au niveau de l'item dans les API récentes (Basil).
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const plan = priceId ? planForPrice(priceId) : undefined;
  if (priceId && !plan)
    log.warn({ priceId, subscription: sub.id }, 'stripe : price_id inconnu — plan inchangé (mettre à jour STRIPE_PRICE_* ?)');
  // Résolution : d'abord par customer id, sinon par metadata de l'abonnement.
  let companyId: string | null = null;
  if (customerId) {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM companies WHERE stripe_customer_id=$1', [customerId]);
    companyId = rows[0]?.id ?? null;
  }
  const metaId = String(sub.metadata?.company_id ?? '');
  if (!companyId && /^[0-9a-f-]{36}$/i.test(metaId)) {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM companies WHERE id=$1', [metaId]);
    companyId = rows[0]?.id ?? null;
  }
  if (!companyId) return;
  // Clause « plan » optionnelle : les placeholders sont numérotés en
  // conséquence (un trou dans la numérotation fait échouer la requête).
  const sets = [
    'stripe_customer_id = COALESCE($2, stripe_customer_id)',
    'subscription_id = $3',
    'subscription_status = $4',
  ];
  const params: unknown[] = [companyId, customerId ?? null, sub.id ?? null, sub.status ?? 'none'];
  if (plan) { params.push(plan); sets.push(`plan = $${params.length}`); }
  params.push(priceId, periodEnd ? new Date(periodEnd * 1000) : null, !!sub.cancel_at_period_end);
  sets.push(`subscription_price_id = COALESCE($${params.length - 2}, subscription_price_id)`);
  sets.push(`current_period_end = $${params.length - 1}`);
  sets.push(`cancel_at_period_end = $${params.length}`);
  await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function companyIdByCustomer(customerId: string | undefined): Promise<string | null> {
  if (!customerId) return null;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM companies WHERE stripe_customer_id=$1', [customerId]);
  return rows[0]?.id ?? null;
}

// Traite un événement Stripe déjà authentifié (signature vérifiée) ou
// récupéré depuis l'API (rejeu manuel). Levée d'erreur propagée à l'appelant.
export async function processStripeEvent(event: any, log: EventLog): Promise<void> {
  const obj = event.data?.object ?? {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const companyId = obj.client_reference_id || obj.metadata?.company_id;
      if (companyId) {
        await pool.query(
          `UPDATE companies SET stripe_customer_id=$2, subscription_id=$3 WHERE id=$1`,
          [companyId, obj.customer ?? null, obj.subscription ?? null]);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await applySubscription(obj, log);
      break;
    case 'customer.subscription.deleted': {
      const cid = await companyIdByCustomer(typeof obj.customer === 'string' ? obj.customer : obj.customer?.id)
        ?? obj.metadata?.company_id;
      if (cid) {
        await pool.query(
          `UPDATE companies SET plan='free', subscription_status='canceled',
             subscription_id=NULL, subscription_price_id=NULL,
             current_period_end=NULL, cancel_at_period_end=false WHERE id=$1`,
          [cid]);
      }
      break;
    }
    case 'invoice.paid': {
      const cid = await companyIdByCustomer(typeof obj.customer === 'string' ? obj.customer : obj.customer?.id);
      if (cid) await pool.query(`UPDATE companies SET subscription_status='active' WHERE id=$1 AND subscription_status <> 'none'`, [cid]);
      break;
    }
    case 'invoice.payment_failed': {
      // Accès conservé pendant la relance Stripe ; la résiliation éventuelle
      // arrive via customer.subscription.deleted → retour Gratuit.
      const cid = await companyIdByCustomer(typeof obj.customer === 'string' ? obj.customer : obj.customer?.id);
      if (cid) await pool.query(`UPDATE companies SET subscription_status='past_due' WHERE id=$1`, [cid]);
      break;
    }
    default:
      log.warn({ type: event.type }, 'stripe : type d\'événement non géré (ignoré)');
  }
}
