# @ghostbroker/agents

Two Groq-powered autonomous agents (1 buyer, 1 seller) for the GhostBroker
institutional dark pool. Each agent is a Node.js loop that:

1. Authenticates with a persistent API key (`gbk_…`) and gets a session.
2. Generates an ephemeral agent DID at process boot (no setup CLI required).
3. Admits itself via `client.admitAgent({ institutionId, agentDid })` — the
   backend looks up the persisted delegation VC and verifies it server-side.
4. On each tick, asks Groq (`qwen/qwen3-32b`) whether to submit, wait, or abort.
5. If Groq says "submit" and the LLM's choice fits the configured bounds
   and the institution's available balance, seals an intent envelope and
   submits it.
6. Listens for the `settlement_finalized` telemetry event and exits
   cleanly when a match settles the trade.

## Workspace layout

```
agents/
├── src/
│   ├── buyer-agent.ts       # the buyer entry point (preflight + run)
│   ├── seller-agent.ts      # the seller entry point (preflight + run)
│   ├── env.ts               # zod-validated env loader (no dotenv dep)
│   ├── identity.ts          # ephemeral keypair generation
│   ├── delegation.ts        # W3C VC schema + load helpers
│   ├── vc-verifier.ts       # structural + live verifier
│   ├── sealed-envelope.ts   # TEE-shaped base64url envelope
│   ├── llm-decision.ts      # Groq client + decision schema + clamps
│   ├── run-loop.ts          # shared per-tick loop
│   └── *.test.ts            # unit tests
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Prerequisites

- Node.js 20+
- A running GhostBroker backend (default: `http://localhost:3001`)
- A **GhostBroker API key** (`gbk_…`) — generate from the dashboard's Developer Keys tab
- A **Groq Cloud API key** — https://console.groq.com/keys

That's it. No T3N API key. No delegation VC. No CLI setup steps. The backend
handles all T3 onboarding and delegation signing.

## Running the buyer and seller

```bash
# 1. From the repo root, install all workspace deps
npm install

# 2. Copy and edit the env file
cp agents/.env.example agents/.env
# Set GHOSTBROKER_URL, GHOSTBROKER_API_KEY, GROQ_API_KEY, and the trading params.

# 3. Start the buyer in one terminal
npm run buyer --workspace @ghostbroker/agents

# 4. Start the seller in another terminal
npm run seller --workspace @ghostbroker/agents
```

By default the buyer and seller use the same `.env` file. For a production
deployment, give each agent its own `.env` with its own `GHOSTBROKER_API_KEY`
and trading parameters.

To run a sanity check that the LLM wiring works without submitting any
intents, set `DRY_RUN=1` in `.env`. The agent will still authenticate,
admit, call Groq on each tick, and log the decision — it just won't submit.

## How the agents decide what to trade

Every `TICK_INTERVAL_MS` the agent:

1. Reads its own completed-trade count from `/api/trades/completed`.
2. Reads its own portfolio from `client.getAgentPortfolio(...)`.
3. Sends a structured prompt to Groq. The system message forces
   JSON output (`{action, quantity, price, reasoning}`).
4. Parses the response with a tolerant JSON extractor and re-validates with zod.
5. **Clamps the decision** to the configured bounds: quantity inside
   `[min, max]`, price inside `[minPrice, maxPrice]`.
6. On `"submit"`, builds the sealed envelope and submits.
7. Waits passively for the WebSocket `settlement_finalized` event.

## Privacy boundary

- **Other agents' orders, prices, quantities, queue position.** The
  agents only see their own portfolio, their own completed trades,
  and the public reference price.
- **The T3 enclave's internal state.** The agents submit encrypted
  envelopes and read the public telemetry phases.

## Troubleshooting

### `✗ Auth failed: 401 authorization_failed`

Your `GHOSTBROKER_API_KEY` is wrong, revoked, or doesn't start with
`gbk_`. Generate a new key from the dashboard's **Developer Keys** panel.

### `✗ Admit failed: 403 authorization_failed`

The server's verifier rejected the delegation. This is most commonly:
- The backend's `T3_MODE=live` requires a real signed VC, but the
  agent's delegation hasn't been minted yet. Open the dashboard, go to
  the **Deploy Agent** guide, and click through the Configure section
  to mint the delegation server-side.

### `✗ GhostBroker API error [400 validation_failed]` (on submit)

The LLM picked a price or quantity outside the configured bounds. The
clamp handles this — you'll see a log entry. Increase `PRICE_BAND_BPS`
if the LLM consistently picks prices outside the band.

### The agent never settles

Most likely the buyer's bid and seller's ask don't overlap. Both
agents share `REFERENCE_PRICE_USDC_PER_WBTC` and `PRICE_BAND_BPS`.
Increase `PRICE_BAND_BPS` to give the LLM more room.

## Test, lint, typecheck

```bash
npm run typecheck --workspace @ghostbroker/agents
npm run lint      --workspace @ghostbroker/agents
npm test          --workspace @ghostbroker/agents
```
