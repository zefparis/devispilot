-- DevisPilot : back-office administrateur.

-- Suspension de compte (sign-in refusé + sessions révoquées).
ALTER TABLE "user" ADD COLUMN suspended_at timestamptz;

-- Réglages applicatifs modifiables depuis le back-office
-- (ex. signup_enabled — prioritaire sur la variable d'environnement).
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Journal d'audit des actions administrateur (métadonnées uniquement,
-- jamais de contenu métier).
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  admin_user_id text,
  admin_email text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}',
  ip text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
