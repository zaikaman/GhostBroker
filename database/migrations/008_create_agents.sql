-- Track admitted agents for each institution.
-- Previously, admissions were purely in-memory and lost on restart.
-- This table provides persistent tracking, listing, and revocation.

CREATE TABLE IF NOT EXISTS public.agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  agent_did text NOT NULL CHECK (agent_did <> ''),
  status text NOT NULL DEFAULT 'admitted' CHECK (status = ANY (ARRAY['admitted'::text, 'revoked'::text])),
  authority_ref text NOT NULL CHECK (authority_ref <> ''),
  label text DEFAULT NULL CHECK (label IS NULL OR (label <> '' AND char_length(label) <= 100)),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agents_pkey PRIMARY KEY (id),
  CONSTRAINT agents_institution_agent_unique UNIQUE (institution_id, agent_did)
);

-- Index for looking up active agents for an institution
CREATE INDEX IF NOT EXISTS idx_agents_institution_active
  ON public.agents (institution_id, created_at DESC)
  WHERE status = 'admitted';

-- Index for looking up active agents by DID
CREATE INDEX IF NOT EXISTS idx_agents_did_active
  ON public.agents (agent_did)
  WHERE status = 'admitted';

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION set_agents_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agents_updated_at_trigger ON public.agents;
CREATE TRIGGER agents_updated_at_trigger
  BEFORE UPDATE ON public.agents
  FOR EACH ROW
  EXECUTE FUNCTION set_agents_updated_at();
