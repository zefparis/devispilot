-- DevisPilot : données métier, isolation par entreprise.

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Appartenances : un utilisateur appartient à une entreprise (extensible).
CREATE TABLE memberships (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

-- Paramètres par entreprise : signature des relances, lien de paiement affiché.
CREATE TABLE company_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  signature text NOT NULL DEFAULT 'Votre artisan' CHECK (char_length(signature) <= 100),
  stripe_link text NOT NULL DEFAULT '' CHECK (char_length(stripe_link) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Montants en centimes entiers, devise explicite, dates métier en DATE.
CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client text NOT NULL CHECK (char_length(client) BETWEEN 1 AND 100),
  email text NOT NULL DEFAULT '' CHECK (char_length(email) <= 200),
  project text NOT NULL CHECK (char_length(project) BETWEEN 1 AND 200),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 1000000000),
  currency char(3) NOT NULL DEFAULT 'EUR',
  sent date NOT NULL,
  next date NOT NULL,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','replied','won','lost')),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  -- Clé de déduplication fournie par le client (import localStorage/CSV idempotent).
  import_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quotes_company_import_key_idx ON quotes(company_id, import_key) WHERE import_key IS NOT NULL;
CREATE INDEX quotes_company_next_idx ON quotes(company_id, next);
CREATE INDEX quotes_company_status_idx ON quotes(company_id, status);

-- Historique des relances déclarées manuellement.
CREATE TABLE followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  subject text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 200),
  at timestamptz NOT NULL DEFAULT now(),
  -- Idempotence : un double clic / retry ne crée pas de doublon.
  idem_key text,
  UNIQUE (company_id, idem_key)
);
CREATE INDEX followups_quote_idx ON followups(quote_id);
