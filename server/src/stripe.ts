import Stripe from 'stripe';
import { config } from './config.js';
import { pool } from './db.js';

// Client Stripe paresseux : sans STRIPE_SECRET_KEY la facturation est
// désactivée proprement (enabled:false côté API, boutons masqués côté front).
let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!config.stripe.secretKey) return null;
  client ??= new Stripe(config.stripe.secretKey, { timeout: 15000, maxNetworkRetries: 1 });
  return client;
}
export const stripeEnabled = () => !!config.stripe.secretKey;

// price_id → offre. Seuls les ids fournis par l'env sont acceptés.
const PRICE_TO_PLAN: Record<string, 'pro' | 'team'> = {};
for (const [key, id] of Object.entries(config.stripe.prices)) {
  if (!id) continue;
  PRICE_TO_PLAN[id] = key.startsWith('pro_') ? 'pro' : 'team';
}
export const planForPrice = (priceId: string) => PRICE_TO_PLAN[priceId];
// Offres souscriptibles : l'Équipe est exclue tant que TEAM_PLAN_ENABLED=false.
export const knownPriceIds = () => new Set(
  Object.keys(config.stripe.prices)
    .filter(k => config.stripe.teamPlanEnabled || !k.startsWith('team_'))
    .map(k => config.stripe.prices[k as keyof typeof config.stripe.prices])
    .filter(Boolean) as string[],
);
// Entrées de prix visibles (landing, panneau Abonnement) — mêmes exclusions.
export const visiblePriceEntries = () =>
  Object.entries(config.stripe.prices)
    .filter(([key, id]) => id && (config.stripe.teamPlanEnabled || !key.startsWith('team_')));

// Cache des montants des prix lus depuis l'API Stripe (10 min) : les montants
// affichés restent synchronisés avec le dashboard, jamais codés en dur.
type PriceInfo = { unit_amount: number | null; currency: string; interval: string | null };
const priceCache = new Map<string, { at: number; info: PriceInfo }>();
const PRICE_TTL = 10 * 60 * 1000;

export async function priceInfo(priceId: string): Promise<PriceInfo | null> {
  const hit = priceCache.get(priceId);
  if (hit && Date.now() - hit.at < PRICE_TTL) return hit.info;
  const s = stripe();
  if (!s || !priceId) return null;
  try {
    const p = await s.prices.retrieve(priceId);
    const info: PriceInfo = {
      unit_amount: p.unit_amount,
      currency: p.currency,
      interval: (p.recurring?.interval as string) ?? null,
    };
    priceCache.set(priceId, { at: Date.now(), info });
    return info;
  } catch {
    return null;
  }
}

// Offre effective : le plan payé ne vaut que pendant la vie de l'abonnement
// (Stripe gère les relances de paiement en past_due ; à la résiliation,
// customer.subscription.deleted remet plan=free). Aucune donnée supprimée.
export type CompanyBilling = {
  plan: string; subscription_status: string; stripe_customer_id: string | null;
  subscription_price_id: string | null; current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export async function companyBilling(companyId: string): Promise<CompanyBilling> {
  const { rows } = await pool.query<CompanyBilling>(
    `SELECT plan, subscription_status, stripe_customer_id, subscription_price_id,
            current_period_end::text, cancel_at_period_end
     FROM companies WHERE id=$1`, [companyId]);
  return rows[0] ?? {
    plan: 'free', subscription_status: 'none', stripe_customer_id: null,
    subscription_price_id: null, current_period_end: null, cancel_at_period_end: false,
  };
}

export const effectivePlan = (b: Pick<CompanyBilling, 'plan' | 'subscription_status'>) =>
  ['active', 'trialing', 'past_due'].includes(b.subscription_status) ? b.plan : 'free';

// Limite Gratuit : 10 devis actifs (non signés, non perdus) par entreprise.
export const FREE_ACTIVE_LIMIT = 10;

export async function activeQuoteCount(companyId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM quotes WHERE company_id=$1 AND status IN ('sent','replied')`,
    [companyId]);
  return Number(rows[0].n);
}

// Reste à insérer avant de heurter la limite (Infinity hors plan Gratuit).
export async function remainingQuoteQuota(companyId: string): Promise<number> {
  const b = await companyBilling(companyId);
  if (effectivePlan(b) !== 'free') return Number.POSITIVE_INFINITY;
  return Math.max(0, FREE_ACTIVE_LIMIT - (await activeQuoteCount(companyId)));
}
