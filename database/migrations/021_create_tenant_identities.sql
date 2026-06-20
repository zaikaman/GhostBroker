-- Persistent tenant signing identity store.
--
-- Holds the institution's dedicated secp256k1 signing keypair. The
-- keypair's derived Ethereum address is the canonical issuer DID for
-- every delegation VC the backend signs (`did:ethr:0x<address>` form),
-- which is the only issuer format the T3 SDK's `verifyEcdsaVcSig`
-- actually verifies (audit findings T3-ONB-014, T3-ONB-019).
--
-- Replaces the previous `backend/output/identities/tenant_identity.json`
-- file-based store. Heroku's dyno filesystem is ephemeral (every
-- restart wipes disk), so a file-backed signing key would force a
-- fresh CSPRNG keypair on every restart — silently invalidating
-- every previously issued delegation VC and breaking every admitted
-- agent's authority chain. Putting the row in Supabase makes the
-- identity survive restarts and Heroku dyno cycling.
--
-- The `signing_private_key` column carries the same sensitivity as a
-- KMS-held secret. It is held only behind the service_role JWT, RLS is
-- locked to service_role, and the operator dashboard NEVER receives
-- this column over the wire (the Settings panel exposes the derived
-- `signing_address` and `issuer_did`, never the key itself).
--
-- Production target: in a Heroku deploy this row should be replaced
-- by a KMS/HSM-backed key with the same shape, populated via the
-- `TENANT_SIGNING_PRIVATE_KEY` env var at boot (which takes
-- precedence over the row). The row is the fallback for environments
-- where no env-supplied key is configured.

CREATE TABLE IF NOT EXISTS public.tenant_identities (
  tenant_did text PRIMARY KEY
    CHECK (tenant_did <> ''),
  signing_private_key text NOT NULL
    CHECK (signing_private_key ~ '^0x[0-9a-fA-F]{64}$'),
  signing_public_key text NOT NULL
    CHECK (signing_public_key ~ '^0x[0-9a-fA-F]{66}$'),
  signing_address text NOT NULL
    CHECK (signing_address ~ '^0x[0-9a-fA-F]{40}$'),
  issuer_did text NOT NULL
    CHECK (issuer_did LIKE 'did:ethr:0x%'),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Auto-bump updated_at on UPDATE so callers can tell when the row was
-- last regenerated (keypair rotation).
CREATE OR REPLACE FUNCTION public.tenant_identities_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_identities_updated_at ON public.tenant_identities;
CREATE TRIGGER tenant_identities_updated_at
  BEFORE UPDATE ON public.tenant_identities
  FOR EACH ROW
  EXECUTE FUNCTION public.tenant_identities_touch_updated_at();
