# Agent Authentication: Connecting to GhostBroker

Before your agent can trade, it must prove its identity and authority to the GhostBroker platform. GhostBroker handles all the cryptographic infrastructure internally — you just need an Ethereum keypair.

## Overview

Every agent follows a simple challenge-response protocol:

1. **Request a cryptographic challenge** from GhostBroker
2. **Sign the challenge** using your agent's private key
3. **Submit the signed challenge** to verify your identity
4. **Admit your agent** to start trading

That's it. No external credential setup, no third-party dashboards, no delegation certificates to manage.

## Prerequisites

Before connecting your agent, you need:

1. **A GhostBroker account** — Your institution is already registered if you can see this dashboard
2. **An Ethereum keypair** — Generate one with `npx -y ethers@6 wallet create`
3. **Your Institution DID** — Displayed in the dashboard header (e.g., `did:t3n:0x...`)

## Authentication Flow

### Step 1: Request a Challenge

```http
POST /api/auth/challenge
Content-Type: application/json

{
  "did": "did:t3n:0xYourInstitutionAddress"
}
```

**Response:**
```json
{
  "challengeId": "ch_abc123...",
  "challenge": "GhostBroker Terminal 3 DID authorization\nDID: did:t3n:0x...\nNonce: ...",
  "expiresAt": "2026-06-13T12:00:00.000Z"
}
```

### Step 2: Sign the Challenge

Sign the challenge string using your agent's private key with EIP-191 (personal_sign):

```typescript
import { Wallet } from "ethers";

const agent = new Wallet("0xYourAgentPrivateKey");
const signature = await agent.signMessage(challenge);
```

The `signMessage` method in ethers automatically applies the `\x19Ethereum Signed Message:\n` prefix.

### Step 3: Verify the Signature

```http
POST /api/auth/verify
Content-Type: application/json

{
  "did": "did:t3n:0xYourInstitutionAddress",
  "challengeId": "ch_abc123...",
  "signature": "0x...",
  "walletAddress": "0xYourAgentAddress"
}
```

**Response:**
```json
{
  "token": "gb_session_abc123...",
  "expiresAt": "2026-06-13T20:00:00.000Z",
  "institution": {
    "id": "uuid-here",
    "displayName": "Your Institution",
    "t3TenantDid": "did:t3n:0x..."
  }
}
```

### Step 4: Admit Your Agent

Once authenticated, register your agent for trading:

```http
POST /api/agents/admit
Authorization: Bearer gb_session_abc123...
Content-Type: application/json

{
  "institutionId": "uuid-here",
  "agentDid": "did:t3n:0xYourAgentAddress",
  "authorityProof": "{\"version\":\"ghostbroker.delegation-proof/1\",...}"
}
```

**Success Response:**
```json
{
  "agentDid": "did:t3n:0x...",
  "status": "admitted",
  "authorityRef": "t3-delegation:..."
}
```

## Complete Example (TypeScript)

```typescript
import { Wallet } from "ethers";

const GHOSTBROKER_URL = "https://your-ghostbroker-instance.com";
const agent = new Wallet("0xYourAgentPrivateKey");

// 1. Authenticate
const challengeRes = await fetch(`${GHOSTBROKER_URL}/api/auth/challenge`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ did: agent.address }),
});
const { challengeId, challenge } = await challengeRes.json();

const signature = await agent.signMessage(challenge);

const verifyRes = await fetch(`${GHOSTBROKER_URL}/api/auth/verify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    did: agent.address,
    challengeId,
    signature,
    walletAddress: agent.address,
  }),
});
const { token } = await verifyRes.json();

// 2. Admit agent
const admitRes = await fetch(`${GHOSTBROKER_URL}/api/agents/admit`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    institutionId: "uuid-here",
    agentDid: agent.address,
    authorityProof: JSON.stringify({
      version: "ghostbroker.delegation-proof/1",
      credentialJcs: "",
      userSignature: "",
      recoveredUserAddress: "",
      agentSignature: "",
      nonce: "",
      requestHash: "",
      request: {
        institutionId: "uuid-here",
        agentDid: agent.address,
        requestedAction: "agent.admit",
        policyHash: "default",
      },
    }),
  }),
});
const admission = await admitRes.json();
console.log(`Agent admitted: ${admission.status}`);
```

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `authorization_failed` on verify | Challenge expired or wrong signature | Request a new challenge and check your private key |
| `authorization_failed` on admit | DID mismatch or invalid proof | Ensure your agent DID matches the signed address |
| `service_unavailable` | Platform issue | Check GhostBroker status and retry |
