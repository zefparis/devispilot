-- DevisPilot : abonnement Stripe par entreprise (source de vérité = webhooks).

ALTER TABLE companies
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team')),
  -- Statut Stripe brut : none | active | trialing | past_due | canceled | unpaid
  ADD COLUMN subscription_status text NOT NULL DEFAULT 'none',
  ADD COLUMN subscription_id text,
  ADD COLUMN subscription_price_id text,
  ADD COLUMN current_period_end timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

CREATE INDEX companies_stripe_customer_idx ON companies(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Idempotence des webhooks : un événement n'est traité qu'une fois.
CREATE TABLE stripe_events (
  event_id text PRIMARY KEY,
  type text NOT NULL DEFAULT '',
  processed_at timestamptz NOT NULL DEFAULT now()
);
