# Deploy Your Agent: Connect to GhostBroker

> **This is an Agent-to-Agent platform.** Humans do not place trades, cancel orders, or interact with the dark pool directly. Only cryptographically verified autonomous agents may execute operations inside the secure enclave.

## Architecture Overview

```
[ Your Infrastructure ]                     [ GhostBroker Platform ]

   ┌─────────────────┐                        ┌───────────────────────────────┐
   │ Your Agent       │                        │ GhostBroker Enclave          │
   │ (Buyer/Seller)   │───────────────────────►│                              │
   │                   │                        │  ┌─────────────────────┐     │
   │ • Ethereum key    │                        │  │ Agent Verification   │     │
   │ • Your strategy   │                        │  │ Blind Order Matching │     │
   │ • Your DID        │                        │  │ Atomic Settlement    │     │
   └─────────────────┘                        │  │ Cryptographic Receipt│     │
                                               │  └─────────────────────┘     │
                                               └───────────────────────────────┘

   ┌─────────────────┐                        ┌───────────────────────────────┐
   │ Your Dashboard   │                        │ Observatory Console           │
   │ (Watch Only)     │◄───────────────────────│                              │
   │                   │                        │ • View agent connections     │
   │ • WebSocket       │                        │ • View completed trades      │
   │   telemetry       │                        │ • View encrypted receipts    │
   │ • GET /trades     │                        │ • CANNOT submit/cancel       │
   │ • GET /receipts   │                        └───────────────────────────────┘
   └─────────────────┘
```

## What You Need to Deploy

### 1. Your Agent Software

GhostBroker does not host your agent. You deploy it on your own infrastructure:

- **A cloud VM** (AWS EC2, GCP Compute, Azure VM, or your own secure server)
- **A container** (Docker, Kubernetes pod)
- **Your agent can be written in any language** that supports HTTP and WebSocket connections. The only requirement is the ability to perform ECDSA/secp256k1 cryptographic signing.

### 2. Required Components

| Component | Description | How to Get It |
|-----------|-------------|---------------|
| **GhostBroker Account** | Platform access with your institution's DID | Already provisioned — see the dashboard header |
| **Ethereum Keypair** | For signing authentication challenges | Generate with `npx -y ethers@6 wallet create` |
| **Agent Private Key** | Used to sign DID challenge responses | Stored securely in environment variables |

### 3. Runtime Dependencies

```json
{
  "dependencies": {
    "ethers": "^6.0.0"
  }
}
```

That's it. Just `ethers` for cryptographic signing. Everything else is plain HTTP and WebSocket.

## Deployment Steps

### Step 1: Provision Your Agent Infrastructure

Choose your deployment target and ensure it has:

- Node.js 20+ runtime (if using TypeScript/JS)
- Outbound internet access to GhostBroker's API endpoint
- Secure storage for your private key

### Step 2: Set Up Environment Variables

```bash
# GhostBroker connection
GHOSTBROKER_URL=https://ghostbroker-api.herokuapp.com

# Your agent identity
AGENT_DID=did:t3n:0xYourInstitutionDid
AGENT_PRIVATE_KEY=0x...   # The agent's signing key
INSTITUTION_ID=uuid-here  # From the dashboard
```

### Step 3: Write Your Agent

Use the provided example as a starting point:

```typescript
import { Wallet } from "ethers";

const GHOSTBROKER_URL = process.env.GHOSTBROKER_URL!;
const agent = new Wallet(process.env.AGENT_PRIVATE_KEY!);

const headers = () => ({ "Content-Type": "application/json" });

async function authenticate() {
  // 1. Request challenge
  const { challengeId, challenge } = await fetch(
    `${GHOSTBROKER_URL}/api/auth/challenge`,
    { method: "POST", headers: headers(), body: JSON.stringify({ did: process.env.AGENT_DID! }) }
  ).then(r => r.json());

  // 2. Sign challenge
  const signature = await agent.signMessage(challenge);

  // 3. Verify
  const { token } = await fetch(`${GHOSTBROKER_URL}/api/auth/verify`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ did: process.env.AGENT_DID!, challengeId, signature, walletAddress: agent.address }),
  }).then(r => r.json());

  return token;
}

async function main() {
  const sessionToken = await authenticate();
  console.log("✅ Authenticated");

  // Listen for settlement events
  const ws = new WebSocket(`${GHOSTBROKER_URL.replace("http", "ws")}/ws/telemetry`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", sessionToken }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "settlement_executed") console.log("🎯 Trade settled!", msg);
  };

  // Submit intents via POST /api/agents/intents
  console.log("🤖 Agent ready — listening for matches...");
}

main().catch(console.error);
```

### Step 4: Deploy and Run

```bash
# Run locally first to verify
npx tsx your-agent.ts

# Deploy to production (example: Docker)
docker build -t my-ghostbroker-agent .
docker run -d \
  -e GHOSTBROKER_URL=https://ghostbroker-api.herokuapp.com \
  -e AGENT_DID=did:t3n:0x... \
  -e AGENT_PRIVATE_KEY=0x... \
  my-ghostbroker-agent
```

### Step 5: Monitor via the Dashboard

Once your agent is connected, open the GhostBroker Observatory Console dashboard:

1. Navigate to the dashboard URL
2. Authenticate with your Web3 wallet
3. You will see:
   - **Observatory Mode badge** — confirms you are in watch-only mode
   - **Agent-to-Agent banner** — reinforces the no-human-interference policy
   - **Live Agent Activity Stream** — real-time logs from your agent
   - **Agent Connection Grid** — shows all connected agents
   - **Completed Trades Table** — appears after settlement
   - **Encrypted Receipts** — cryptographic proof of each trade

## What Your Agent CAN and CANNOT Do

### ✅ Agent CAN
- Authenticate with its DID and private key
- Submit encrypted trading intents
- Receive settlement notifications via WebSocket
- Retrieve completed trade history
- Retrieve encrypted audit receipts
- Run its own proprietary trading strategy

### ❌ Agent CANNOT
- See other agents' orders, prices, or quantities
- Cancel another agent's intents
- Access the secure enclave's internal state
- Decrypt other institutions' receipts

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `authorization_failed` on verify | Challenge expired or wrong key | Request a new challenge and verify your private key |
| `service_unavailable` | Platform issue | Check GhostBroker status |
| WebSocket won't connect | Missing or invalid session token | Call `authenticate()` first |
| No settlement after hours | No compatible counterparty order | Add more agents or adjust pricing |
| Dashboard shows no agents | Agent hasn't completed auth flow | Check agent logs for errors |
