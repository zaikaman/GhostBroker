# @ghostbroker/agents

Multi-provider (Gemini + OpenAI + Groq) autonomous agents (1 buyer, 1
seller) for the GhostBroker institutional dark pool. Each agent is a
Node.js loop that:

1. Authenticates with a persistent API key (`gbk_…`) and gets a session.
2. Generates an ephemeral agent DID at process boot (no setup CLI required).
3. Admits itself via `client.admitAgent({ institutionId, agentDid })` — the
   backend looks up the persisted delegation VC and verifies it server-side.
4. On each tick, asks the LLM provider chain (Gemini → OpenAI → Groq)
   whether to submit, wait, or abort.
5. If the LLM says "submit" and its choice fits the configured bounds
   and the institution's available balance, seals an intent envelope and
   submits it.
6. Listens for the `settlement_finalized` telemetry event and exits
   cleanly when a match settles the trade.

## Workspace layout

```
agents/
├── src/
│   ├── buyer-agent.ts              # the buyer entry point (preflight + run)
│   ├── seller-agent.ts             # the seller entry point (preflight + run)
│   ├── hosted-agent.ts             # the hosted-negotiator entry point
│   ├── env.ts                      # zod-validated env loader (no dotenv dep)
│   ├── identity.ts                 # ephemeral keypair generation
│   ├── delegation.ts               # W3C VC schema + load helpers
│   ├── vc-verifier.ts              # structural + live verifier
│   ├── sealed-envelope.ts          # TEE-shaped base64url envelope
│   ├── llm-decision.ts             # decision schema + clamps + LLM client
│   ├── negotiation-decision.ts     # negotiation schema + clamps + LLM client
│   ├── run-loop.ts                 # shared per-tick loop (buyer/seller)
│   ├── negotiation-loop.ts         # shared per-tick loop (hosted)
│   ├── llm/                        # multi-provider LLM chain
│   │   ├── types.ts                # provider interface + shared error type
│   │   ├── gemini-client.ts        # Gemini provider (raw fetch, v98store)
│   │   ├── openai-client.ts        # OpenAI-compatible provider (raw fetch)
│   │   ├── groq-client.ts          # Groq provider (raw fetch)
│   │   ├── fallback-chain.ts       # tries each in order on transient errors
│   │   └── index.ts                # env-driven factory + parsing helpers
│   └── *.test.ts                   # unit tests
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Prerequisites

- Node.js 20+
- A running GhostBroker backend (default: `http://localhost:3001`)
- A **GhostBroker API key** (`gbk_…`) — generate from the dashboard's Developer Keys tab
- At least **one LLM provider credential**:
  - `GEMINI_API_KEY` (primary — `gemini-3.1-flash-lite` via the v98store proxy)
  - `OPENAI_API_KEY` (fallback #1 — `gpt-5-nano` via Azure OpenAI)
  - `GROQ_API_KEY` (fallback #2 — `qwen/qwen3-32b` on Groq Cloud)

That's it. No T3N API key. No delegation VC. No CLI setup steps. The backend
handles all T3 onboarding and delegation signing.

## LLM provider chain

The agent runs each LLM call through a fallback chain:

```
Gemini (gemini-3.1-flash-lite) ──► OpenAI (gpt-5-nano) ──► Groq (qwen/qwen3-32b)
```

The chain tries providers in the order above (configurable via
`LLM_PROVIDER_CHAIN`). A failure is treated as **transient** (and the
chain falls back to the next provider) when it is:

- A 5xx server error from the provider
- A 408 / 429 rate-limit error
- A network error (timeout, DNS, TLS)
- An empty completion
- A malformed JSON body

A failure is treated as **fatal** (no fallback) when it is a 401 / 403
auth error or a 400 / 404 bad-request error — the same prompt is unlikely
to succeed on a different provider, so we surface the error to the agent
loop immediately. When every provider has failed with a transient error,
the chain throws an `AggregateLlmError` whose `.errors` array carries
each provider's `LlmProviderError`.

To override the order, set `LLM_PROVIDER_CHAIN` to a comma-separated list
of provider ids, e.g. `LLM_PROVIDER_CHAIN=groq,openai` to prefer Groq.

## Running the buyer and seller

```bash
# 1. From the repo root, install all workspace deps
npm install

# 2. Copy and edit the env file
cp agents/.env.example agents/.env
# Set GHOSTBROKER_URL, GHOSTBROKER_API_KEY, GEMINI_API_KEY (and
# optionally OPENAI_API_KEY and GROQ_API_KEY as fallbacks), and the
# trading params.

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
admit, call the LLM chain on each tick, and log the decision — it just
won't submit.

## How the agents decide what to trade

Every `TICK_INTERVAL_MS` the agent:

1. Reads its own completed-trade count from `/api/trades/completed`.
2. Reads its own portfolio from `client.getAgentPortfolio(...)`.
3. Sends a structured prompt through the LLM fallback chain. The system
   message forces JSON output (`{action, quantity, price, reasoning}`).
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
- **Provider-side state.** Gemini, OpenAI, and Groq only see the
  system prompt and the bounded user prompt — no other agents'
  data, no identifiers beyond the agent DID and institution display
  name embedded in the system prompt.

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

### `✗ Missing LLM provider credentials`

Set at least one of `GEMINI_API_KEY` (primary), `OPENAI_API_KEY`
(fallback #1), or `GROQ_API_KEY` (fallback #2). The agent will use
whichever you provide — if all three are missing, the preflight
exits before any LLM call.

### `[LLM] primary (gemini) failed (503), trying openai (1/2)`

The agent's primary provider returned a transient error (server, rate
limit, network, empty body, malformed JSON). The chain fell back to
the next provider, which served the request. No action needed —
this is the chain working as designed. If the chain exhausts every
provider, the loop logs `[LLM] all providers failed` and backs off
for `POLL_INTERVAL_MS` before retrying.

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
