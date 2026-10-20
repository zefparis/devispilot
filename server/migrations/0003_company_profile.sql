-- DevisPilot : fiche entreprise enrichie (mentions devis, contact, logo).

ALTER TABLE companies
  ADD COLUMN siren text NOT NULL DEFAULT '' CHECK (siren = '' OR siren ~ '^\d{9}$|^\d{14}$'),
  ADD COLUMN address text NOT NULL DEFAULT '' CHECK (char_length(address) <= 300),
  ADD COLUMN phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 30),
  ADD COLUMN contact_email text NOT NULL DEFAULT '' CHECK (contact_email = '' OR char_length(contact_email) <= 200),
  -- Logo facultatif, stocké en base (≤ 200 Ko) : évite un stockage disque
  -- et disparaît avec l'entreprise en cascade.
  ADD COLUMN logo_data bytea,
  ADD COLUMN logo_mime text CHECK (logo_mime IS NULL OR logo_mime IN ('image/png','image/jpeg','image/webp'));
