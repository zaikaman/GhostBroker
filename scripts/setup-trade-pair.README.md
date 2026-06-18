# GhostBroker Trade Pair

A complete end-to-end smoke test for the buyer/seller trade flow.

## What it does

1. Provisions a fresh **buyer agent** and a fresh **seller agent** under
   the two E2E test institutions (`00000000-0000-4000-8000-0000000007a1`
   and `...7a2`).
2. Mints a fresh server-side delegation VC for each agent via the
   backend's `POST /api/agents/configure` endpoint.
3. Creates a fresh negotiation mandate on each agent with parameters
   that are designed to converge end-to-end:
   - `executionStyle: "balanced"` (no `trust_first` disclosure deadlock)
   - `requiredClaims: []` and `disclosableClaims: []` (no disclosure gate)
   - `approvalPolicy: auto_settle` (no escalation stalls)
   - `targetQuantity: 1` WBTC (whole-unit; the T3 match contract on the
     testnet sandbox only accepts integer quantities — anything below 1
     rounds to 0 and the orchestrator returns `no_match`)
   - `referencePrice: 70000` USDC per WBTC (matches the `.env`)
4. Attaches a hosted-agent config to each agent.
5. Spawns the agent processes via the backend's `POST /api/hosted-agents/{id}/start`
   endpoint. Each agent then:
   - Authenticates against the backend using its operator session token.
   - Admits itself with its persisted VC.
   - Submits a negotiation ticket (which the orchestrator pairs).
   - Calls Groq (`qwen/qwen3-32b`) on each tick to decide a move.
   - Submits priced moves and accepts when the cross is feasible.
6. The orchestrator detects the cross via the T3 match contract, runs
   the disclosure gate (which is satisfied), and settles the trade.
7. The session transitions to `status: "settled"` with a `tradeRef`
   recorded in `completed_trades`.

## Run

```bash
# Make sure the backend is up on http://localhost:3001
npx tsx scripts/setup-trade-pair.ts
```

You should see something like:

```
[setup] buyer hosted: running=true pid=...
[setup] seller hosted: running=true pid=...

[setup] === SETUP COMPLETE ===
{ "buyer": { "agentId": "..." }, "seller": { "agentId": "..." } }
```

Within ~30 seconds the session will show up in
`GET /api/negotiations/{sessionId}` as `status: "settled"` with a
`tradeRef` linking the completed trade.

## Why a script and not `npm run buyer` / `npm run seller`?

The legacy `run-loop.ts` (`npm run buyer` / `npm run seller`) uses the
**hidden-intent** flow (`POST /api/agents/intents`) and the T3
**enclave match contract** for cross evaluation. It is functionally
equivalent to a single-tick dark-pool submission rather than a
multi-round negotiation.

The **hosted-mandate** flow (`npm run hosted`, `scripts/setup-trade-pair.ts`)
uses the **negotiation-orchestrator** flow with the new
`/api/negotiations/{id}/moves` endpoint and a multi-round
LLM-driven dialogue. Both flows settle on the same trade-history
table; the negotiation flow is what the dashboard's hosted
negotiators exercise.

## Reused fixes

- `agents/src/negotiation-loop.ts` `pickLiveSession` — the legacy
  fallback that picked `sessions[0]` when `sessionId` was unknown
  has been replaced with a `currentTurn === side` filter so the
  agent never adopts a stale `active` session from a previous run
  (which the orchestrator was bouncing with 403 on
  `resolveActorSide`).
- `agents/src/negotiation-loop.ts` `profileFromRuntimeMandate` —
  the legacy-mandate synthesis path now correctly extracts the
  required-claims list from the `Record<claim, jsonValue>` shape
  stored in `requiredCounterpartyClaims`, instead of passing the
  record through to a validator that expected `string[]` (this
  was crashing the legacy mandate path with
  `TypeError: requiredClaims.every is not a function`).
- `agents/src/run-loop.ts` — the legacy buyer/seller scripts now
  default to whole-unit quantities so the testnet match contract
  accepts them.
