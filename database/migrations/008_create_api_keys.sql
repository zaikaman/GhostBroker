-- API Keys for persistent agent authentication
-- Agents can use these instead of re-authenticating via DID challenge every 8 hours.
--
-- Key format (plaintext):  gbk_<prefix>_<random-base64url>
-- Storage layout (per row):
--   - prefix        First 8 chars of the random segment; stored
--                   plaintext for UI display and operator identification.
--   - key_bcrypt    bcrypt(token, cost=12) of the full key. Not unique
--                   (per-call salt). Constant-time verified via
--                   bcrypt.compare at request time.
--   - lookup_key    HMAC-SHA256(AUTH_SESSION_SECRET, token), hex.
--                   Unique, indexed. The equality lookup key on the
--                   request path. The HMAC is keyed by
--                   AUTH_SESSION_SECRET (a mandatory boot-time env,
--                   ≥32 bytes), so a DB leak alone is insufficient
--                   to enumerate valid tokens.
-- Plaintext is returned only once on creation.
--
-- Usage: Authorization: Bearer gbk_<prefix>_<random>
--
-- Verification flow:
--   1. lookup_key = HMAC-SHA256(AUTH_SESSION_SECRET, token)
--   2. SELECT … WHERE lookup_key = ? AND revoked_at IS NULL  (single row)
--   3. bcrypt.compare(token, row.key_bcrypt)                  (constant time)
--
-- For environments that ran the prior SHA-256 schema, see
-- migration 019_api_keys_bcrypt_lookup.sql for the upgrade path.

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label <> '' AND char_length(label) <= 100),
  prefix text NOT NULL CHECK (prefix <> '' AND char_length(prefix) <= 16),
  key_bcrypt text NOT NULL CHECK (key_bcrypt <> '' AND key_bcrypt LIKE '$2%'),
  lookup_key text NOT NULL CHECK (lookup_key <> ''),
  scopes text NOT NULL DEFAULT 'agent:operate' CHECK (scopes <> ''),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone DEFAULT NULL,
  CONSTRAINT api_keys_pkey PRIMARY KEY (id)
);

-- Unique + index for fast equality lookup on the request path.
-- Partial index: revoked rows are not in the lookup path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_lookup_key
  ON public.api_keys (lookup_key)
  WHERE revoked_at IS NULL;

-- Index for listing keys for an institution.
CREATE INDEX IF NOT EXISTS idx_api_keys_institution
  ON public.api_keys (institution_id, created_at DESC);
