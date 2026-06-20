-- Migration 019: API key storage upgraded from SHA-256 to bcrypt
-- + HMAC-SHA256 lookup key.
--
-- The previous schema stored `key_hash` as a plain SHA-256 of the
-- plaintext API key. Two issues with that design:
--
--   1. SHA-256 is a fast hash, not a password hash. A database
--      breach that exfiltrates `key_hash` is recoverable: the
--      attacker can mount a dictionary / rainbow-table attack on
--      the 256-bit preimage space and recover many active tokens.
--      The README at HEAD claims "bcrypt" but the column stored
--      SHA-256.
--   2. The API key auth flow did a `WHERE key_hash = ?` equality
--      lookup on every request. That lookup only works because
--      SHA-256 is deterministic: same input always produces the
--      same digest. bcrypt embeds a per-call random salt, so the
--      same plaintext produces a different hash on every call —
--      direct equality lookup is impossible.
--
-- The new design splits the storage into two columns:
--
--   - `key_bcrypt`  bcrypt(token, cost=12). NOT unique. Used
--                   for constant-time verification via
--                   `bcrypt.compare`. Plaintext cannot be
--                   recovered from this hash within the threat
--                   model's lifetime.
--
--   - `lookup_key`  HMAC-SHA256(AUTH_SESSION_SECRET, token),
--                   hex-encoded. UNIQUE and indexed. Used as
--                   the equality lookup key. The HMAC is keyed
--                   by `AUTH_SESSION_SECRET` (a mandatory
--                   boot-time env var, ≥32 bytes) so a DB
--                   breach alone is insufficient to enumerate
--                   valid tokens; the attacker also needs the
--                   server secret.
--
-- Verification flow on every request:
--
--   1. Derive `lookup_key` from the bearer token + server secret.
--   2. Equality-select the row by `lookup_key`. Yields at most
--      one active row.
--   3. `bcrypt.compare(token, row.key_bcrypt)`. Constant time.
--
-- ─── Idempotency ───────────────────────────────────────────────────────
--
-- This migration is safe to run in three states:
--
--   (a) Fresh DB where the updated migration 008 created the
--       bcrypt schema directly: `key_hash` does not exist,
--       `lookup_key` already exists. 019 is a no-op.
--   (b) Existing DB that ran the original 008 with `key_hash`:
--       019 renames, adds new columns, deletes legacy rows.
--   (c) Existing DB that already ran a prior copy of this 019:
--       `key_bcrypt_old` does not exist, `lookup_key` already
--       exists. 019 is a no-op.
--
-- The DO blocks below branch on `information_schema.columns` to
-- select the right path.

DO $$
DECLARE
  has_old_hash boolean;
  has_new_lookup boolean;
  legacy_count integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'key_hash'
  ) INTO has_old_hash;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'lookup_key'
  ) INTO has_new_lookup;

  -- ─── Path (c): already migrated ────────────────────────────────────
  IF has_new_lookup AND NOT has_old_hash THEN
    RAISE NOTICE 'api_keys migration 019: schema already at bcrypt+lookup_key, nothing to do.';
    RETURN;
  END IF;

  -- ─── Path (a): 008 was the updated bcrypt schema, but for some
  --     reason `lookup_key` is missing (e.g. partial apply). Add it
  --     and finish the job.
  IF has_new_lookup AND has_old_hash THEN
    RAISE NOTICE 'api_keys migration 019: unexpected state — both key_hash and lookup_key present; aborting.';
    RETURN;
  END IF;

  IF NOT has_new_lookup THEN
    -- ─── Path (b): legacy SHA-256 schema. Do the rename. ───────────
    ALTER TABLE public.api_keys
      RENAME COLUMN key_hash TO key_bcrypt_old;

    ALTER TABLE public.api_keys
      ADD COLUMN IF NOT EXISTS key_bcrypt text;

    ALTER TABLE public.api_keys
      ADD COLUMN IF NOT EXISTS lookup_key text;

    -- Drop the legacy SHA-256 index; the new `lookup_key` carries
    -- the uniqueness.
    DROP INDEX IF EXISTS idx_api_keys_key_hash;

    SELECT count(*) INTO legacy_count FROM public.api_keys
      WHERE key_bcrypt IS NULL OR lookup_key IS NULL;
    IF legacy_count > 0 THEN
      RAISE NOTICE 'api_keys migration 019: deleting % legacy SHA-256 row(s); operators must re-issue.', legacy_count;
      DELETE FROM public.api_keys
        WHERE key_bcrypt IS NULL OR lookup_key IS NULL;
    END IF;

    ALTER TABLE public.api_keys
      DROP COLUMN IF EXISTS key_bcrypt_old;

    ALTER TABLE public.api_keys
      ALTER COLUMN key_bcrypt SET NOT NULL;

    ALTER TABLE public.api_keys
      ALTER COLUMN lookup_key SET NOT NULL;

    -- Defensive: enforce bcrypt format on the column so a stray
    -- non-bcrypt string can never be inserted.
    ALTER TABLE public.api_keys
      DROP CONSTRAINT IF EXISTS api_keys_key_bcrypt_format_check;
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_key_bcrypt_format_check
      CHECK (key_bcrypt LIKE '$2%');
  END IF;
END $$;

-- Unique + index on the new lookup column. Idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_lookup_key
  ON public.api_keys (lookup_key)
  WHERE revoked_at IS NULL;

-- Index retained for "list keys for institution" — unchanged.
CREATE INDEX IF NOT EXISTS idx_api_keys_institution
  ON public.api_keys (institution_id, created_at DESC);

COMMENT ON COLUMN public.api_keys.key_bcrypt IS
  'bcrypt(token, cost=12) of the full API key. Not unique (per-call salt). Constant-time verified via bcrypt.compare. Plaintext cannot be recovered within the threat model.';
COMMENT ON COLUMN public.api_keys.lookup_key IS
  'HMAC-SHA256(AUTH_SESSION_SECRET, token), hex. Stable equality lookup key; unique while active. Keyed by AUTH_SESSION_SECRET (mandatory boot-time env, ≥32 bytes), so DB leak alone does not enable enumeration.';
COMMENT ON TABLE public.api_keys IS
  'Persistent agent API keys. bcrypt-verified at request time via a server-HMAC lookup index. Plaintext is returned to the operator exactly once on creation and never persisted.';
