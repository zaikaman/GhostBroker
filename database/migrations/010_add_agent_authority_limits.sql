-- Add authority limit columns to the agents table.
-- These store the parsed authority claim limits that were verified
-- during agent admission via the T3N delegation credential.
--
-- instrument_scope: which assets the agent is authorized to trade
-- direction_scope: whether the agent can buy, sell, or both
-- max_notional: maximum total notional value per trade (in minor units)
-- limit_reference: human-readable reference for the limit (e.g. policy ID)

ALTER TABLE IF EXISTS public.agents
  ADD COLUMN IF NOT EXISTS instrument_scope text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS direction_scope text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS max_notional numeric(78, 0) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS limit_reference text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS policy_hash text DEFAULT NULL;

-- Index for looking up agents by policy hash
CREATE INDEX IF NOT EXISTS idx_agents_policy_hash
  ON public.agents (policy_hash)
  WHERE policy_hash IS NOT NULL;
