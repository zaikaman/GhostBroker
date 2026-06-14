# @ghostbroker/agents

Two Groq-powered autonomous agents (1 buyer, 1 seller) for the GhostBroker
institutional dark pool. Each agent is a Node.js loop that:

1. Authenticates with a persistent API key (`gbk_…`) and gets a session.
2. Boots from an on-disk **agent identity** (DID + secp256k1 keypair, produced
   by `npm run setup:identity`) and an on-disk **delegation credential**
   (a W3C Verifiable Credential on disk, produced by
   `npm run setup:delegation`).
3. Adapts via the new `client.admitAgentWithDelegationCredential()` method
   on the `@ghostbroker/agent-client` SDK, which routes through
   `t3-enclave/src/auth/boundbuyer-delegation.ts` on the server.
4. On each tick, asks Groq (`qwen/qwen3-32b`) whether to submit, wait, or abort.
5. If Groq says "submit" and the LLM's choice fits the configured bounds
   and the institution's available balance, seals an intent envelope and
   submits it. The orchestrator locks the agent's USDC or WBTC balance
   inside the TEE.
6. Listens for the `settlement_finalized` telemetry event and exits
   cleanly when a match settles the trade.

## Workspace layout

```
agents/
├── src/
│   ├── buyer-agent.ts       # the buyer entry point (preflight + run)
│   ├── seller-agent.ts      # the seller entry point (preflight + run)
│   ├── env.ts               # zod-validated env loader (no dotenv dep)
│   ├── identity.ts          # boundbuyer T3 identity: keypair + T3N DID
│   ├── delegation.ts        # boundbuyer W3C VC mint/load/validate
│   ├── vc-verifier.ts       # structural + live verifier, sandbox/live/structural modes
│   ├── sealed-envelope.ts   # TEE-shaped base64url envelope
│   ├── llm-decision.ts      # Groq client + decision schema + clamps
│   ├── run-loop.ts          # shared per-tick loop
│   ├── scripts/
│   │   ├── setup-identity.ts    # CLI: T3N handshake → DID
│   │   └── setup-delegation.ts  # CLI: mint W3C VC to disk
│   └── *.test.ts            # 33 unit tests
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Prerequisites

- Node.js 20+
- A running GhostBroker backend (default: `http://localhost:3001`)
- A **Terminal 3 claim-page key** (`T3N_API_KEY`) — the only T3 secret
  the agent needs. Get one at [terminal3.io/claim-page](https://www.terminal3.io/claim-page)
- Two **GhostBroker API keys** (`gbk_…`), one per institution
- A **Groq Cloud API key** — https://console.groq.com/keys

There is **no Terminal 3 dashboard**. T3 onboarding is just the
`T3N_API_KEY` + a derived `did:t3n`. This is a real difference from what
the T3 public docs imply; it's the part the boundbuyer BUIDL
(ghostbroker/boundbuyer) confirmed by working code.

## Running the buyer and seller

```bash
# 1. From the repo root, install all workspace deps
npm install

# 2. Build the SDK + t3-enclave (so the agents' imports resolve)
npm run build --workspaces

# 3. Set up the env file
cp agents/.env.example agents/.env
# Edit agents/.env with your real values.

# 4. Run setup:identity once per agent (one terminal per agent)
#    This calls the live T3N network and writes the agent DID +
#    secp256k1 keypair to output/identities/agent_identity.json.
GHOSTBROKER_API_KEY=*** buyer
T3N_API_KEY=*** npm run setup:identity --workspace @ghostbroker/agents

# 5. Run setup:delegation once per agent.
#    Mints a W3C Verifiable Credential on disk. The user's DID is
#    derived from the T3N_API_KEY via eth_get_address; the agent's
#    DID comes from the identity file.
T3N_API_KEY=*** npm run setup:delegation --workspace @ghostbroker/agents

# 6. Start the buyer in one terminal
npm run buyer --workspace @ghostbroker/agents

# 7. Start the seller in another terminal
npm run seller --workspace @ghostbroker/agents
```

By default the buyer and seller use the **same `.env` file**. For a
production deployment, give each agent its own `.env` with its own
`GHOSTBROKER_API_KEY`. The two agents will use the **same T3N_API_KEY**
because T3 ties identity to a single tenant, but each will mint its
own agent DID and its own delegation credential during setup.

To run a sanity check that the LLM wiring works without submitting any
intents, set `DRY_RUN=1` in `.env`. The agent will still authenticate,
admit, call Groq on each tick, and log the decision — it just won't
submit.

## The boundbuyer credential flow

The boundbuyer BUIDL (read-only reference in `../boundbuyer/`) is the
canonical live T3 integration reference. It defines:

- `npm run setup:identity` — generates a secp256k1 keypair and calls
  `T3nClient.handshake()` + `client.authenticate(createEthAuthInput(...))`
  against the T3N network. The result is a real `did:t3n:0x<eth-address>`
  persisted to `output/identities/agent_identity.json`.
- `npm run setup:delegation` — mints a W3C Verifiable Credential
  (W3C JSON-LD shape: `issuer`, `credentialSubject`, `proof.jws`)
  binding the user (derived from `T3N_API_KEY`) to the agent
  (`did:t3n`) for a budget + category set. Persisted to
  `output/delegations/agent_delegation.json`.
- The verifier (`t3-enclave/src/auth/boundbuyer-delegation.ts`) is a
  port of `boundbuyer/src/auth/vc-verifier.ts`. It supports three
  modes, controlled by the `VC_VERIFY_MODE` env var:
  - **`sandbox`** (default) — structural checks only. The demo `jws`
    marker is accepted. This is the boundbuyer BUIDL's "production
    gate" for smoke testing.
  - **`structural`** — same as sandbox but explicit. Used when you
    want the boundbuyer demo `jws` to pass in live mode.
  - **`live`** — real cryptographic verification via
    `@terminal3/verify_vc` (dynamically imported at runtime; the
    package is optional). Refuses demo `jws` markers.

The `setup:delegation` script writes a `proof.jws` of
`"live-demo-unsigned"`. In `sandbox` / `structural` mode the verifier
accepts this and the admit call returns 200. In `live` mode the admit
returns 403 unless you provide a real signed VC from a T3 issuer.

## How the agents decide what to trade

Every `TICK_INTERVAL_MS` the agent:

1. Reads its own completed-trade count from `/api/trades/completed`.
2. Reads its own portfolio from `client.getAgentPortfolio(...)`
   (`GET /api/portfolios/{institutionId}?agentDid=...`). The
   response includes `holdings` (per-asset `balance` and `locked`)
   and `pendingReservations` (the agent's own in-flight locks).
   Available USDC / WBTC is computed as
   `holdings[i].balance - holdings[i].locked`. The LLM prompt is
   fed these live numbers on every tick.
3. Sends a structured prompt to Groq. The system message forces
   JSON output (`{action, quantity, price, reasoning}`). The user
   message contains the agent's current context (side, reference
   price, band, available balance, tick number, last outcome).
4. Parses the response with a tolerant JSON extractor (the model may
   emit ```json fences or wrap in prose) and re-validates with zod.
5. **Clamps the decision** to the configured bounds: quantity stays
   inside `[min, max]`, price stays inside `[minPrice, maxPrice]`,
   and the implied notional never exceeds the available USDC.
6. On `"submit"`, builds the sealed envelope and submits via
   `client.submitEncryptedIntent(...)` (the typed method that passes
   the `settlementMetadata` block the backend's route requires).
7. Waits passively for the WebSocket `settlement_finalized` event.
   Falls back to polling `/api/trades/completed` if the WebSocket
   doesn't fire within one tick.

The agent exits cleanly on settlement, on `MAX_TICKS`, on SIGINT, or
on the LLM choosing `"abort"`.

### Portfolio read fallback

The portfolio read is the agent's **primary** balance source, but
it's a network call and can fail (transient 503, session timeout,
backend down). The run loop handles this in three layers:

1. **Live read succeeds** — the LLM sees the freshest
   `balance - locked` for each holding.
2. **Live read fails, env vars are set** (`AGENT_AVAILABLE_USDC` /
   `AGENT_AVAILABLE_WBTC`) — the loop logs a warning and falls back
   to the env values so the agent can keep running with a stale
   hint. **The orchestrator's balance-lock check is still the real
   authority on whether a submit will succeed.**
3. **Live read fails, env vars are unset** — the loop logs a warning
   and feeds `0` available to the LLM. The agent waits until the
   SDK recovers. This is the safe default; the env vars are an
   opt-in for operators who explicitly want the agent to keep
   trading during backend hiccups.

## Privacy boundary

This is the privacy boundary, called out for completeness so a reader
of the agent code knows what's intentionally missing:

- **Other agents' orders, prices, quantities, queue position.** The
  agents only see their own portfolio, their own completed trades,
  and the public reference price.
- **The T3 enclave's internal state.** The agents submit encrypted
  envelopes and read the public telemetry phases.
- **Operator dashboard data.** The agent-client SDK only exposes
  `getAgentPortfolio` to the agent's own institution; the operator
  dashboard surfaces (full portfolio history, wallet-synced
  balances) are not part of the agent's read surface.

## Troubleshooting

### `✗ Agent identity not found at …`

You didn't run `setup:identity` first. See the "Running" section.

### `✗ Delegation credential not found at …`

You didn't run `setup:delegation` first. See the "Running" section.

### `✗ Local VC verification failed: …`

The on-disk VC is malformed, expired, or bound to a different agent
DID than the identity file claims. Re-run `setup:delegation` (which
re-mints the VC from the current identity file).

### `✗ Auth failed: 401 authorization_failed`

Your `GHOSTBROKER_API_KEY` is wrong, revoked, or doesn't start with
`gbk_`. Generate a new key from the dashboard's **API Keys** panel.

### `✗ Admit failed: 403 authorization_failed`

The server's boundbuyer verifier rejected the VC. Most common
causes:
- `VC_VERIFY_MODE=live` on the server, but the on-disk VC has a
  `proof.jws` of `"live-demo-unsigned"`. Either set
  `VC_VERIFY_MODE=sandbox` (default) or `structural` for the demo
  `jws` to pass, or obtain a real signed VC from a T3 issuer.
- The agent DID in the VC's `credentialSubject.agentDid` doesn't match
  the agent DID in the identity file. Re-run `setup:identity` and
  then `setup:delegation`.
- The `did-registry` Host API rejected the agent DID. This is a
  documented Terminal 3 limitation — see
  [`docs/terminal3-adk-onboarding-doc-gaps.md`](../terminal3-adk-onboarding-doc-gaps.md).

### `✗ Admit failed: 503 service_unavailable`

The backend doesn't have the boundbuyer verifier wired in (it should
be — the production `T3AgentAuthorizationFacade` implements
`verifyBoundbuyerAuthority`). If you see this in a fresh checkout,
rebuild the t3-enclave (`npm run build --workspace @ghostbroker/t3-enclave`)
and restart the backend.

### `✗ GhostBroker API error [400 validation_failed]` (on submit)

The LLM picked a price or quantity outside the configured bounds and
the clamp downgraded the decision — that path is normal and the
agent will wait and retry next tick. If the LLM consistently emits
malformed JSON, the parser will throw and you'll see a log like
`⚠ LLM call failed: …`. Re-check the system prompt; the LLM may
need a higher `max_tokens` to emit the JSON cleanly.

### The agent never settles

Most likely the buyer's bid and the seller's ask don't overlap. Both
agents share `REFERENCE_PRICE_USDC_PER_WBTC` and `PRICE_BAND_BPS`.
The buyer's bid lands somewhere in the band; the seller's ask lands
somewhere in the band. The match will only happen if the buyer's
chosen price is **above** the seller's chosen price. If the LLM
gets conservative on both sides, increase `PRICE_BAND_BPS` to give
it more room.

### The agent prints `403` on every submit

The orchestrator rejected the submit because the institution's
available USDC or WBTC is below the implied notional. The LLM
prompt gets the available balance from `client.getAgentPortfolio(...)`
each tick, but if the SDK call is failing the loop falls back to
the env-var values. Update `AGENT_AVAILABLE_USDC` / `AGENT_AVAILABLE_WBTC`
to the institution's actual balance, or set the institution's
actual portfolio in the database so the live read returns the
correct numbers. The orchestrator's balance-lock check is the real
authority on whether a submit will succeed.

## Test, lint, typecheck

```bash
npm run typecheck --workspace @ghostbroker/agents
npm run lint      --workspace @ghostbroker/agents
npm test          --workspace @ghostbroker/agents
```

The unit test suite covers the LLM-decision parser, the price/quantity
clamp, the sealed-envelope format, the boundbuyer VC mint/load
flow, and the verifier's three modes (sandbox accepts, sandbox rejects
expired, sandbox rejects agent-mismatch, live rejects demo proof,
structural accepts demo proof).
