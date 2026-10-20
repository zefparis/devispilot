-- DevisPilot : acceptation des CGV versionnée (obligatoire à l'inscription
-- et à la souscription ; ré-acceptation demandée quand la version change).

CREATE TABLE cgv_acceptances (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, version)
);
