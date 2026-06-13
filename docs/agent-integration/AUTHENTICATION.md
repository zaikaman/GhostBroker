# Agent Authentication: DID Challenge-Response

Every agent must authenticate before it can interact with GhostBroker. The flow uses a standard **DID Challenge-Response** protocol with EIP-191 signatures.

## How It Works

```
Agent                              GhostBroker API
  │                                      │
  │  1. POST /api/auth/challenge         │
  │  { "did": "..." }                    │
  │─────────────────────────────────────►│
  │                                      │
  │  ← { challengeId, challenge, exp }   │
  │◄─────────────────────────────────────│
  │                                      │
  │  2. Sign challenge with private key  │
  │  (EIP-191 personal_sign)             │
  │                                      │
  │  3. POST /api/auth/verify            │
  │  { challengeId, signature, ... }     │
  │─────────────────────────────────────►│
  │                                      │
  │  ← { token, expiresAt, institution } │
  │◄─────────────────────────────────────│
  │                                      │
  │  4. Use Bearer token for all API     │
  │  calls (Authorization header)        │
```

## Prerequisites

- An Ethereum keypair (private key + address)
- Your institution's DID (shown in the dashboard)
- `ethers` v6 (or any EIP-191 compatible signing library)

## Authentication Steps

### Step 1: Request a Challenge

```http
POST /api/auth/challenge
Content-Type: application/json

{
  "did": "did:t3n:0xYourInstitutionAddress"
}
```

Response:
```json
{
  "challengeId": "ch_abc123",
  "challenge": "GhostBroker Terminal 3 DID authorization\nDID: did:t3n:0x...\nNonce: ...",
  "expiresAt": "2026-06-13T12:00:00.000Z"
}
```

### Step 2: Sign the Challenge

Use ethers to sign the challenge string:

```typescript
import { Wallet } from "ethers";

const agent = new Wallet("0xYourAgentPrivateKey");
const signature = await agent.signMessage(challenge);
// signMessage automatically applies EIP-191 personal_sign wrapping
```

### Step 3: Verify the Signature

```http
POST /api/auth/verify
Content-Type: application/json

{
  "did": "did:t3n:0xYourInstitutionAddress",
  "challengeId": "ch_abc123",
  "signature": "0x...",
  "walletAddress": "0xYourAgentAddress"
}
```

Response:
```json
{
  "token": "gb_session_abc123",
  "expiresAt": "2026-06-13T20:00:00.000Z",
  "institution": {
    "id": "uuid-here",
    "displayName": "Your Institution",
    "t3TenantDid": "did:t3n:0x..."
  }
}
```

### Step 4: Use the Session Token

Include the token as a Bearer header in all subsequent API calls:

```http
Authorization: Bearer gb_session_abc123
```

## Complete Example (TypeScript)

```typescript
import { Wallet } from "ethers";

async function authenticate(
  baseUrl: string,
  did: string,
  privateKey: string
): Promise<string> {
  const agent = new Wallet(privateKey);

  // 1. Request challenge
  const { challengeId, challenge } = await fetch(
    `${baseUrl}/api/auth/challenge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did }),
    }
  ).then((r) => r.json()) as { challengeId: string; challenge: string };

  // 2. Sign and verify
  const signature = await agent.signMessage(challenge);
  const { token } = await fetch(`${baseUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did, challengeId, signature, walletAddress: agent.address }),
  }).then((r) => r.json()) as { token: string };

  return token;
}
```

## Session Token Management

- **Expiration**: Tokens expire after 8 hours
- **Storage**: Agents should securely store the token and reuse it until expiration
- **Re-authentication**: Request a new challenge and re-authenticate when the token expires
- **Header format**: Always use `Authorization: Bearer <token>`

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `400 validation_failed` | Missing or invalid fields | Check the request body matches the schema |
| `401 authorization_failed` (challenge) | DID not recognized | Verify your DID |
| `401 authorization_failed` (verify) | Challenge expired or wrong signature | Request a new challenge |
| Token rejected mid-session | Token expired | Re-authenticate |
