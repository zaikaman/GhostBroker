-- Persistent record of every matching TEE contract the backend has
-- successfully published to the T3N tenant via
-- `backend/scripts/publish-matching.ts`. The Settings → Enclave Connection
-- panel reads this table so operators see ground truth about what is
-- actually registered on the tenant rather than relying on the operator
-- to remember which `T3_MATCHING_CONTRACT_VERSION` was last published.
--
-- Replaces the previous `backend/output/contracts/matching.json`
-- file-based store. Heroku's dyno filesystem is ephemeral (every restart
-- wipes disk), so file-backed runtime state is unsafe for production
-- deploys. The orchestrator does NOT depend on this row to resolve
-- contracts at execution time — it still uses
-- `tenant.contracts.execute({ tail, version, functionName, input })`
-- by tail + version. The row exists so the operator UI can display
-- accurate state and so a fresh deploy shows "previously published"
-- rather than "not published (default v0.6.0)" after the first
-- successful publish.
--
-- One row per (tail, contract_version, network_env, tenant_did). Re-publishing
-- the same (tail, version) pair upserts and refreshes `published_at` and
-- `wasm_size`. Bumping `T3_MATCHING_CONTRACT_VERSION` creates a new row.

CREATE TABLE IF NOT EXISTS public.published_contracts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tail text NOT NULL
    CHECK (tail <> ''),
  contract_version text NOT NULL
    CHECK (contract_version <> ''),
  network_env text NOT NULL
    CHECK (network_env = ANY (ARRAY['testnet'::text, 'production'::text])),
  tenant_did text NOT NULL
    CHECK (tenant_did <> ''),
  wasm_size integer NOT NULL
    CHECK (wasm_size > 0),
  handle text,
  published_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT published_contracts_pkey PRIMARY KEY (id),
  CONSTRAINT published_contracts_unique UNIQUE (tail, contract_version, network_env, tenant_did)
);

-- Single canonical lookup: "what is the most recently published matching
-- contract for this tenant on this network?" The Settings panel hits this.
CREATE INDEX IF NOT EXISTS idx_published_contracts_lookup
  ON public.published_contracts (tail, network_env, tenant_did, published_at DESC);
