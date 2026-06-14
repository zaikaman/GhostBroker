# Examples

Runnable end-to-end examples for `@ghostbroker/agent-client`.

| File | What it does |
|---|---|
| [`buyer-agent.ts`](./buyer-agent.ts) | Connects, admits, submits a buy intent, listens for settlement via the telemetry WebSocket. |
| [`seller-agent.ts`](./seller-agent.ts) | Same shape, but submits a sell intent and polls for completed trades (then fetches the audit receipt). |

## Prerequisites

1. **A running GhostBroker backend.** The default is `http://localhost:3001`. Override with `GHOSTBROKER_URL`.
2. **A GhostBroker institution** (created when you first sign in to the dashboard).
3. **An API key** (from the **API Keys** panel on the dashboard).
4. **A delegation credential + admin/agent private keys** (for the admit step).
5. **An encrypted intent envelope** (produced by the TEE enclave runner — the SDK does not generate it).
6. **Node.js 20+** and **`tsx`** (`npx tsx ...` works without installing it globally).

## Setup

```bash
# From the agent-client/ folder
cp .env.example .env
# Edit .env with the real values from the dashboard.
```

Both TypeScript examples read `.env` automatically via a minimal built-in loader (no `dotenv` dependency).

## Running

### `buyer-agent.ts`

```bash
npx tsx examples/buyer-agent.ts
```

- Authenticates, admits, submits the intent, then opens the telemetry WebSocket and prints each `settlement_finalized` event.
- Stops cleanly on Ctrl+C.
- Override the default 60-second run time with `--duration=300` (seconds).

### `seller-agent.ts`

```bash
npx tsx examples/seller-agent.ts
```

- Authenticates, admits, submits the intent, then polls `/api/trades/completed` every 5 seconds (override with `POLL_INTERVAL_MS`).
- Prints the most recent trade + audit receipt, then exits.
- Same `--duration=Ns` override as the buyer.

## What "runnable" means here

The TypeScript examples read every credential from env vars (`.env` or inline) and exit with a clear error if any are missing. They do **not** stub the encrypted intent envelope — the envelope is sealed by the TEE enclave runner outside of this SDK, and the example expects you to provide one (the same way a production agent would receive it).

If you don't have a real envelope yet, the admit + telemetry steps will still work end-to-end. Skip the intent submission by leaving `ENCRYPTED_INTENT_ENVELOPE` empty, and the example will print a clear error rather than silently doing nothing.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `✗ Missing required env var: GHOSTBROKER_API_KEY` | `.env` not loaded or not in the CWD | `cp .env.example .env` and edit, or export the vars inline. |
| `✗ Expected a 32-byte hex private key…` | Wrong-length key, or `0x` prefix issue | Re-export the key from your wallet — the example accepts both `0x`-prefixed and bare hex. |
| `✗ GhostBroker API error [401 authorization_failed]` | Unknown / revoked API key | Generate a new key from the dashboard. |
| `✗ GhostBroker API error [403 authorization_failed]` (on admit) | The delegation credential doesn't match the agent key | Re-issue the credential from the dashboard, or double-check that `AGENT_PRIVATE_KEY` is the one bound to it. |
| `✗ GhostBroker API error [400 validation_failed]` (on admit) | The `authorityProof` shape is wrong | Rebuild the proof via `DelegationProofBuilder.serialize(proof)` from the SDK; don't hand-craft the JSON. |
| WebSocket never connects | Wrong `institutionId` in the WebSocket URL | Call `client.authenticateWithApiKey()` first — the SDK wires the institution ID into the telemetry client automatically. |
