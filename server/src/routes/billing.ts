import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { pool } from '../db.js';
import { requireCompany } from '../guards.js';
import { config } from '../config.js';
import { processStripeEvent } from '../stripe-events.js';
import {
  stripe, stripeEnabled, priceInfo, planForPrice, knownPriceIds, visiblePriceEntries,
  companyBilling, effectivePlan, activeQuoteCount, FREE_ACTIVE_LIMIT,
} from '../stripe.js';
import { cgvAccepted } from '../legal.js';

// Abonnement Perspecta via Stripe. Le webhook est la source de vérité :
// plan/statut/période sont écrits par les événements, jamais par le client.

// Erreur Stripe → 502 propre : le statusCode et les headers de la réponse
// Stripe (dont access-control-allow-origin:*) ne sont jamais propagés.
const STRIPE_DOWN = 'Le service de paiement est momentanément indisponible.';

async function companyContact(companyId: string) {
  const { rows } = await pool.query<{ name: string; siren: string | null; contact_email: string | null; email: string | null }>(
    `SELECT c.name, c.siren, c.contact_email, u.email
       FROM companies c
       LEFT JOIN memberships m ON m.company_id=c.id AND m.role='owner'
       LEFT JOIN "user" u ON u.id=m.user_id
      WHERE c.id=$1 LIMIT 1`, [companyId]);
  return rows[0];
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

      try {
        await processStripeEvent(event, req.log);
      } catch (err) {
        // Événement mal traité : on laisse l'event_id consommé pour ne pas
        // boucler indéfiniment sur une donnée invalide, mais l'échec est
        // loggué en erreur avec l'event_id → rejeu manuel possible :
        // `npm run stripe:replay -- <event_id>` (ou dist/replay-event.js).
        req.log.error(
          { err, eventId: event.id, type: event.type },
          'échec de traitement du webhook Stripe — rejeu : replay-event.js <event_id>');
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
      let customer: Stripe.Customer;
      try {
        customer = await s.customers.create({
          name: c?.name ?? undefined,
          email: c?.contact_email || c?.email || undefined,
          metadata: { company_id: req.companyId!, siren: c?.siren ?? '' },
        });
      } catch (err) {
        req.log.warn({ err }, 'stripe customers.create a échoué');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
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
    let session: Stripe.Checkout.Session;
    try {
      session = await s.checkout.sessions.create(params);
    } catch (err) {
      // Certains comptes ne permettent pas consent_collection : l'acceptation
      // reste garantie par le garde CGV en amont (dans l'app).
      if (!/terms_of_service|consent_collection|custom_text/i.test(String((err as any)?.message))) {
        req.log.warn({ err }, 'stripe checkout.sessions.create a échoué');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
      delete params.consent_collection; delete params.custom_text;
      req.log.warn('stripe: consent_collection indisponible, checkout sans case CGV');
      try {
        session = await s.checkout.sessions.create(params);
      } catch (err2) {
        req.log.warn({ err: err2 }, 'stripe checkout.sessions.create a échoué (repli)');
        return reply.code(502).send({ error: STRIPE_DOWN });
      }
    }
    return { url: session.url };
  });

  /* ---------- Portail client Stripe (changement d'offre, carte, factures) ---------- */
  app.post('/api/billing/portal', { preHandler: requireCompany }, async (req, reply) => {
    const s = stripe();
    if (!s) return reply.code(503).send({ error: 'Facturation non configurée.' });
    const b = await companyBilling(req.companyId!);
    if (!b.stripe_customer_id) return reply.code(404).send({ error: 'Aucun abonnement à gérer.' });
    let session: Stripe.BillingPortal.Session;
    try {
      session = await s.billingPortal.sessions.create({
        customer: b.stripe_customer_id,
        return_url: config.stripe.portalReturnUrl || config.frontUrl,
      });
    } catch (err) {
      req.log.warn({ err }, 'stripe billingPortal.sessions.create a échoué');
      return reply.code(502).send({ error: STRIPE_DOWN });
    }
    return { url: session.url };
  });
}
