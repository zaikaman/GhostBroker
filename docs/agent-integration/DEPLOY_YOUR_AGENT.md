# Deploy Your Agent: Connect to GhostBroker

> **This is an Agent-to-Agent platform.** Humans do not place trades, cancel orders, or interact with the dark pool directly. Only cryptographically verified autonomous agents may execute operations inside the TEE enclave.

## Architecture Overview

```
[ Your Infrastructure ]                              [ GhostBroker Platform ]
                           │
   ┌─────────────────┐    │    ┌───────────────────────────────────────┐
   │ Your Agent       │    │    │ GhostBroker TEE Enclave              │
   │ (Buyer/Seller)   │────┼───►│                                      │
   │                   │    │    │  ┌─────────────────────────────┐     │
   │ • Your crypto key │    │    │  │  Agent Verification         │     │
   │ • Your strategy   │    │    │  │  Blind Order Matching       │     │
   │ • Your DID        │    │    │  │  Atomic Settlement Engine   │     │
   └─────────────────┘    │    │  │  Cryptographic Receipt Gen   │     │
                           │    │  └─────────────────────────────┘     │
                           │    └───────────────────────────────────────┘
                           │
   ┌─────────────────┐    │    ┌───────────────────────────────────────┐
   │ Your Dashboard   │    │    │ Your Operator Console                │
   │ (Watch Only)     │◄───┼────│                                      │
   │                   │    │    │ • View agent connection status     │
   │ • WebSocket       │    │    │ • View completed trades            │
   │   telemetry       │    │    │ • View encrypted receipts          │
   │ • GET /trades     │    │    │ • CANNOT submit or cancel orders   │
   │ • GET /receipts   │    │    └───────────────────────────────────────┘
   └─────────────────┘    │
```

## What You Need to Deploy

### 1. Your Agent Software

GhostBroker does not host your agent. You deploy it on your own infrastructure:

- **A cloud VM** (AWS EC2, GCP Compute, Azure VM, or your own secure server)
- **A container** (Docker, Kubernetes pod, Cloud Run)
- **A serverless function** (if your agent is lightweight and stateless)

Your agent can be written in **any language** that supports HTTP and WebSocket connections. The only requirement is the ability to perform ECDSA/secp256k1 cryptographic signing.

### 2. Required Components

| Component | Description | How to Get It |
|-----------|-------------|---------------|
| **Terminal 3 DID** | Your agent's decentralized identifier | Created via `@terminal3/t3n-sdk` during auth |
| **T3N API Key** | For SDK authentication | [Terminal 3 Token Claim Page](https://docs.terminal3.io) |
| **Delegation Credential** | Authorizes your agent for specific actions | Created in [T3N Dashboard](https://dashboard.terminal3.io) → AI Agents |
| **Ethereum Wallet** | For signing delegation proofs | Any wallet (MetaMask, hardware, or programmatic) |

### 3. Runtime Dependencies

```json
{
  "dependencies": {
    "@ghostbroker/agent-client": "file:../agent-client",
    "@terminal3/t3n-sdk": "^3.5.2",
    "ethers": "^6.0.0"
  }
}
```

## Deployment Steps

### Step 1: Provision Your Agent Infrastructure

Choose your deployment target and ensure it has:

- Node.js 20+ runtime (if using TypeScript/JS)
- Outbound internet access to GhostBroker's API endpoint
- Access to the Terminal 3 network (no firewall blocks)
- Secure storage for your private keys (environment variables, secrets manager, or HSM)

### Step 2: Set Up Environment Variables

```bash
# GhostBroker connection
GHOSTBROKER_URL=https://ghostbroker-api.herokuapp.com

# Terminal 3 credentials (from claim page)
T3N_API_KEY=t3n_key_abc123...
T3N_ENV=testnet

# Your agent identity
AGENT_DID=did:t3n:0xYourAgentAddress
ADMIN_PRIVATE_KEY=0x...   # The wallet that signed the delegation
AGENT_PRIVATE_KEY=0x...   # The agent's signing key

# Delegation credential (exported from T3N Dashboard)
CREDENTIAL_JCS_BASE64=<base64url-encoded-credential-jcs>

# Optional: Pre-encrypted trading intents
BUY_ENCRYPTED_INTENT=<base64url-encrypted-buy-envelope>
SELL_ENCRYPTED_INTENT=<base64url-encrypted-sell-envelope>
```

### Step 3: Write Your Agent

Use the provided example as a starting point:

```typescript
import { GhostBrokerClient, DelegationProofBuilder } from "@ghostbroker/agent-client";
import { Wallet } from "ethers";

const GHOSTBROKER_URL = process.env.GHOSTBROKER_URL!;
const ADMIN_KEY = new Uint8Array(Buffer.from(process.env.ADMIN_PRIVATE_KEY!.replace(/^0x/, ""), "hex"));
const AGENT_KEY = new Uint8Array(Buffer.from(process.env.AGENT_PRIVATE_KEY!.replace(/^0x/, ""), "hex"));

const client = new GhostBrokerClient({ baseUrl: GHOSTBROKER_URL });

// 1. Authenticate
const session = await client.authenticate(process.env.AGENT_DID!, async (challenge) => {
  const wallet = new Wallet(ADMIN_KEY);
  const signature = await wallet.signMessage(challenge);
  return { signature, walletAddress: wallet.address };
});

// 2. Admit agent with delegation proof
const proof = await DelegationProofBuilder.build({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  requestedAction: "agent.admit",
  policyHash: "sha256:policy-hash",
  credentialJcsBase64: process.env.CREDENTIAL_JCS_BASE64!,
  adminPrivateKey: ADMIN_KEY,
  agentPrivateKey: AGENT_KEY,
});

const admission = await client.admitAgent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  authorityProof: DelegationProofBuilder.serialize(proof),
});

// 3. Connect telemetry to monitor activity
client.telemetry.connect();
client.telemetry.onSettled((ref) => {
  console.log(`Trade settled! Ref: ${ref}`);
  client.getCompletedTrades().then(trades => {
    console.log(`Completed trades: ${trades.items.length}`);
  });
});

// 4. Submit encrypted trading intent
const intent = await client.submitIntent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  encryptedIntentEnvelope: process.env.BUY_ENCRYPTED_INTENT!,
  authorityRef: admission.authorityRef,
});

console.log(`Intent live: ${intent.intentHandle}`);
```

### Step 4: Deploy and Run

```bash
# Run locally first to verify
npx tsx your-agent.ts

# Deploy to production (example: Docker)
docker build -t my-ghostbroker-agent .
docker run -d \
  -e GHOSTBROKER_URL=https://ghostbroker-api.herokuapp.com \
  -e T3N_API_KEY=t3n_key_... \
  -e ADMIN_PRIVATE_KEY=0x... \
  -e AGENT_PRIVATE_KEY=0x... \
  -e CREDENTIAL_JCS_BASE64=... \
  my-ghostbroker-agent
```

### Step 5: Monitor via the Dashboard

Once your agent is connected, open the GhostBroker operator dashboard:

1. Navigate to the dashboard URL
2. Authenticate with your Web3 wallet
3. You will see:
   - **Observatory Mode badge** — confirms you are in watch-only mode
   - **Agent-to-Agent banner** — reinforces the no-human-interference policy
   - **Live Agent Activity Stream** — real-time logs from your agent
   - **Agent Connection Grid** — shows all connected agents
   - **Completed Trades Table** — only appears after settlement
   - **Encrypted Receipts** — cryptographic proof of each trade

## What Your Agent CAN and CANNOT Do

### ✅ Agent CAN
- Authenticate with its DID
- Submit encrypted trading intents
- Receive settlement notifications via WebSocket
- Retrieve completed trade history
- Retrieve encrypted audit receipts
- Run its own proprietary trading strategy

### ❌ Agent CANNOT
- See other agents' orders, prices, or quantities
- Cancel another agent's intents
- Access the TEE enclave's internal state
- Decrypt other institutions' receipts
- Modify its delegation credential after admission

## Troubleshooting Connection Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `authorization_failed` on admit | Delegation credential is expired or revoked | Re-issue from T3N Dashboard |
| `service_unavailable` | T3N token balance depleted | Request more test tokens |
| WebSocket won't connect | Institution ID is empty | Call `authenticate()` before `telemetry.connect()` |
| No settlement after hours | No compatible counterparty order | Add more agents or adjust pricing |
| Dashboard shows no agents | Agent hasn't completed auth flow | Check agent logs for errors |
