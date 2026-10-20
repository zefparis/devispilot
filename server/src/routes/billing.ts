import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { config } from '../config.js';
import {
  stripe, stripeEnabled, priceInfo, planForPrice, knownPriceIds, visiblePriceEntries,
  companyBilling, effectivePlan, activeQuoteCount, FREE_ACTIVE_LIMIT,
} from '../stripe.js';
import { cgvAccepted } from '../legal.js';

// Abonnement DevisPilot via Stripe. Le webhook est la source de vérité :
// plan/statut/période sont écrits par les événements, jamais par le client.

async function companyContact(companyId: string) {
  const { rows } = await pool.query<{ name: string; siren: string | null; contact_email: string | null; email: string | null }>(
    `SELECT c.name, c.siren, c.contact_email, u.email
       FROM companies c
       LEFT JOIN memberships m ON m.company_id=c.id AND m.role='owner'
       LEFT JOIN "user" u ON u.id=m.user_id
      WHERE c.id=$1 LIMIT 1`, [companyId]);
  return rows[0];
}

async function applySubscription(sub: any): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  // current_period_end a migré au niveau de l'item dans les API récentes (Basil).
  const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
  const plan = priceId ? planForPrice(priceId) : undefined;
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
  await pool.query(
    `UPDATE companies SET
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       subscription_id = $3,
       subscription_status = $4,
       ${plan ? 'plan = $5,' : ''}
       subscription_price_id = COALESCE($6, subscription_price_id),
       current_period_end = $7,
       cancel_at_period_end = $8
     WHERE id = $1`,
    [companyId, customerId ?? null, sub.id ?? null, sub.status ?? 'none',
     ...(plan ? [plan] : []), priceId,
     periodEnd ? new Date(periodEnd * 1000) : null,
     !!sub.cancel_at_period_end]);
}

async function companyIdByCustomer(customerId: string | undefined): Promise<string | null> {
  if (!customerId) return null;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM companies WHERE stripe_customer_id=$1', [customerId]);
  return rows[0]?.id ?? null;
}

export default async function billingRoutes(app: FastifyInstance) {

  /* ---------- Webhook Stripe (corps brut, signature obligatoire) ---------- */
  await app.register(async (wh) => {
    // Parseur dédié : la signature Stripe porte sur le corps BRUT.
    wh.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, JSON.parse(body as string)); }
      catch (err) { done(err as Error); }
    });

    wh.post('/api/stripe/webhook', async (req: FastifyRequest, reply) => {
      const s = stripe();
      const secret = config.stripe.webhookSecret;
      if (!s || !secret) return reply.code(503).send({ error: 'Facturation non configurée.' });
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') return reply.code(400).send({ error: 'Signature manquante.' });

      let event: any;
      try {
        event = s.webhooks.constructEvent((req as any).rawBody, sig, secret);
      } catch {
        return reply.code(400).send({ error: 'Signature invalide.' });
      }

      // Idempotence : Stripe rejoue les événements ; un event_id = un traitement.
      const { rowCount } = await pool.query(
        'INSERT INTO stripe_events (event_id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [event.id, event.type ?? '']);
      if (!rowCount) return { received: true, duplicate: true };

      const obj = event.data?.object ?? {};
      try {
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
            await applySubscription(obj);
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
        }
      } catch (err) {
        // Événement mal traité : Stripe réessaiera ; on laisse l'event_id
        // consommé pour ne pas boucler indéfiniment sur une donnée invalide.
        req.log.warn({ err, type: event.type }, 'stripe webhook handler failed');
      }
      return { received: true };
    });
  });

  /* ---------- Prix publics (montants relus depuis Stripe, en cache) ---------- */
  app.get('/api/billing/prices', async () => {
    const entries = visiblePriceEntries();
    const infos = await Promise.all(entries.map(([, id]) => priceInfo(id)));
    const out = entries.map(([key, id], i) => ({
      key, id,
      plan: planForPrice(id) ?? 'pro',
      interval: key.endsWith('_yearly') ? 'year' : 'month',
      amount_cents: infos[i]?.unit_amount ?? null,
      currency: infos[i]?.currency ?? 'eur',
    }));
    return { enabled: stripeEnabled(), prices: out };
  });

  /* ---------- État d'abonnement de l'entreprise courante ---------- */
  app.get('/api/billing', { preHandler: requireCompany }, async (req) => {
    const b = await companyBilling(req.companyId!);
    const active = await activeQuoteCount(req.companyId!);
    const eff = effectivePlan(b);
    const priceEntries = eff === 'free' ? visiblePriceEntries() : [];
    const infos = await Promise.all(priceEntries.map(([, id]) => priceInfo(id)));
    const prices = priceEntries.map(([key, id], i) => ({
      key, id, plan: planForPrice(id), interval: key.endsWith('_yearly') ? 'year' : 'month',
      amount_cents: infos[i]?.unit_amount ?? null, currency: infos[i]?.currency ?? 'eur',
    }));
    return {
      enabled: stripeEnabled(),
      plan: eff, rawPlan: b.plan, status: b.subscription_status,
      currentPeriodEnd: b.current_period_end, cancelAtPeriodEnd: b.cancel_at_period_end,
      hasCustomer: !!b.stripe_customer_id,
      usage: { active, limit: eff === 'free' ? FREE_ACTIVE_LIMIT : null },
      prices,
    };
  });

  /* ---------- Stripe Checkout (souscription) ---------- */
  app.post('/api/billing/checkout', { preHandler: requireCompany }, async (req, reply) => {
    const s = stripe();
    if (!s) return reply.code(503).send({ error: 'Facturation non configurée.' });
    const priceId = String((req.body as any)?.priceId ?? '');
    if (!knownPriceIds().has(priceId))
      return reply.code(400).send({ error: 'Offre inconnue.' });
    // Souscription = acceptation des CGV de la version courante (app, avant
    // redirection vers Checkout ; le portail Stripe affiche en plus le lien).
    if (!(await cgvAccepted(req.userId!)))
      return reply.code(428).send({ error: 'Acceptez les conditions générales de vente pour souscrire.', code: 'CGV_REQUIRED' });

    const b = await companyBilling(req.companyId!);
    let customerId = b.stripe_customer_id;
    if (!customerId) {
      const c = await companyContact(req.companyId!);
      const customer = await s.customers.create({
        name: c?.name ?? undefined,
        email: c?.contact_email || c?.email || undefined,
        metadata: { company_id: req.companyId!, siren: c?.siren ?? '' },
      });
      customerId = customer.id;
      await pool.query('UPDATE companies SET stripe_customer_id=$2 WHERE id=$1', [req.companyId, customerId]);
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      // Aucune TVA collectée (franchise, art. 293 B CGI) : pas d'automatic_tax.
      client_reference_id: req.companyId,
      metadata: { company_id: req.companyId! },
      subscription_data: { metadata: { company_id: req.companyId! } },
      // Case « j'accepte les CGV » sur la page Checkout (si le compte Stripe l'autorise).
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message: `En souscrivant, j'accepte les conditions générales de vente : ${config.frontUrl}/cgv`,
        },
      },
      success_url: `${config.frontUrl}/?billing=success`,
      cancel_url: `${config.frontUrl}/?billing=cancel`,
    };
    let session;
    try {
      session = await s.checkout.sessions.create(params);
    } catch (err) {
      // Certains comptes ne permettent pas consent_collection : l'acceptation
      // reste garantie par le garde CGV en amont (dans l'app).
      if (!/terms_of_service|consent_collection|custom_text/i.test(String((err as any)?.message))) throw err;
      delete params.consent_collection; delete params.custom_text;
      req.log.warn('stripe: consent_collection indisponible, checkout sans case CGV');
      session = await s.checkout.sessions.create(params);
    }
    return { url: session.url };
  });

  /* ---------- Portail client Stripe (changement d'offre, carte, factures) ---------- */
  app.post('/api/billing/portal', { preHandler: requireCompany }, async (req, reply) => {
    const s = stripe();
    if (!s) return reply.code(503).send({ error: 'Facturation non configurée.' });
    const b = await companyBilling(req.companyId!);
    if (!b.stripe_customer_id) return reply.code(404).send({ error: 'Aucun abonnement à gérer.' });
    const session = await s.billingPortal.sessions.create({
      customer: b.stripe_customer_id,
      return_url: config.stripe.portalReturnUrl || config.frontUrl,
    });
    return { url: session.url };
  });
}
