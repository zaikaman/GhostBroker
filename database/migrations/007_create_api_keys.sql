-- API Keys for persistent agent authentication
-- Agents can use these instead of re-authenticating via DID challenge every 8 hours.
--
-- Key format (plaintext):  gbk_<prefix>_<random-base64url>
-- Stored in DB as SHA-256 hash. Plaintext is returned only once on creation.
-- Prefix (first 8 chars of random segment) is stored separately for UI display.
--
-- Usage: Authorization: Bearer gbk_<prefix>_<random>

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (label <> '' AND char_length(label) <= 100),
  prefix text NOT NULL CHECK (prefix <> '' AND char_length(prefix) <= 16),
  key_hash text NOT NULL UNIQUE CHECK (key_hash <> ''),
  scopes text NOT NULL DEFAULT 'agent:operate' CHECK (scopes <> ''),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone DEFAULT NULL,
  CONSTRAINT api_keys_pkey PRIMARY KEY (id)
);

-- Index for fast lookup by key_hash during authentication
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON public.api_keys (key_hash)
  WHERE revoked_at IS NULL;

-- Index for listing keys for an institution
CREATE INDEX IF NOT EXISTS idx_api_keys_institution
  ON public.api_keys (institution_id, created_at DESC);
