-- Per-intent lock references for the orphan-lock janitor.
--
-- The matching orchestrator's pending-queue is in-memory. When a
-- reservation is acquired on submit, the orchestrator's
-- MatchingOrchestrator holds the corresponding intent in
-- `pendingIntents` and the balance lock in `portfolios.locked`.
-- On cancel / expiry / revocation, the orchestrator removes
-- the intent and releases the lock.
--
-- If the orchestrator process restarts, the in-memory queue is
-- gone, but the `portfolios.locked` amount is not. Without a
-- sweeper, those locks would be stranded until the next
-- settlement or manual adjustment.
--
-- This table gives the system a way to recover. The
-- `HiddenIntentService` writes one row per lock acquired. The
-- orchestrator deletes the row on cancel, expiry, revocation,
-- and successful settlement. A background sweeper queries
-- rows older than the intent TTL (5 minutes) and releases the
-- corresponding `locked` amount — recovering from process
-- restarts, from the rare case of a TEE-sealed-but-never-queued
-- intent, and from any other path where the in-memory record
-- of a live intent is lost.
--
-- The `intent_handle` is the TEE-assigned opaque handle. It is
-- the natural key because it is the same key the orchestrator
-- uses for its in-memory queue, so the in-memory state and
-- this table refer to the same intent unambiguously.

CREATE TABLE IF NOT EXISTS public.intent_locks (
  intent_handle text PRIMARY KEY
    CHECK (intent_handle <> ''),
  institution_id uuid NOT NULL
    REFERENCES public.institutions(id) ON DELETE CASCADE,
  asset_code text NOT NULL
    CHECK (asset_code <> ''),
  amount numeric(40, 8) NOT NULL
    CHECK (amount > 0),
  correlation_ref text,
  agent_did text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for the sweeper: "give me all locks older than X,
-- regardless of institution". The sweeper is the dominant
-- reader of this table.
CREATE INDEX IF NOT EXISTS idx_intent_locks_created_at
  ON public.intent_locks (created_at);

-- Index for diagnostics: "what locks does this institution
-- currently hold?" Used by admin tooling and the agent-level
-- portfolio view's pending reservations.
CREATE INDEX IF NOT EXISTS idx_intent_locks_institution
  ON public.intent_locks (institution_id, created_at DESC);

-- Index for cross-referencing: "what locks does this agent
-- currently hold?" Same use case as above, agent-scoped.
CREATE INDEX IF NOT EXISTS idx_intent_locks_agent
  ON public.intent_locks (agent_did)
  WHERE agent_did IS NOT NULL;
