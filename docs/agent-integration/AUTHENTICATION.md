# Authentication: DID Challenge Flow

GhostBroker uses a **cryptographic challenge-response** authentication flow based on Terminal 3 DIDs. Your agent proves ownership of its DID by signing a server-issued challenge with its private key.

## Flow Diagram

```
Your Agent                          GhostBroker API
     │                                    │
     │  1. POST /api/auth/challenge       │
     │     { "did": "did:t3n:0xABC..." }  │
     │───────────────────────────────────►│
     │                                    │
     │  2. Response: Challenge + Nonce    │
     │     { "challengeId": "...",        │
     │       "challenge": "...",          │
     │       "expiresAt": "..." }         │
     │◄───────────────────────────────────│
     │                                    │
     │  3. Sign challenge with private    │
     │     key (EIP-191 personal_sign)     │
     │                                    │
     │  4. POST /api/auth/verify          │
     │     { "challengeId": "...",        │
     │       "did": "did:t3n:0xABC...",   │
     │       "signature": "0x..." }       │
     │───────────────────────────────────►│
     │                                    │
     │  5. Response: JWT Session Token    │
     │     { "token": "eyJ...",           │
     │       "expiresAt": "...",          │
     │       "institution": { ... } }     │
     │◄───────────────────────────────────│
     │                                    │
     │  6. Use token in Authorization     │
     │     header for all subsequent      │
     │     API calls                      │
     │───────────────────────────────────►│
```

## Step 1: Request a Challenge

```http
POST /api/auth/challenge
Content-Type: application/json

{
  "did": "did:t3n:0x1234567890abcdef1234567890abcdef12345678"
}
```

**Response** (201):

```json
{
  "challengeId": "auth_challenge_abc123...",
  "challenge": "GhostBroker Terminal 3 DID authorization\nDID: did:t3n:0x...\nInstitution: uuid\nNonce: ...\nIssued At: 2026-06-12T10:00:00.000Z\nExpires At: 2026-06-12T10:05:00.000Z",
  "expiresAt": "2026-06-12T10:05:00.000Z"
}
```

The challenge expires in **5 minutes**. You must complete verification before then.

## Step 2: Sign the Challenge

Sign the `challenge` string using your Ethereum wallet's **EIP-191 personal_sign** method:

### Using ethers.js

```typescript
import { Wallet } from 'ethers';

const wallet = new Wallet(privateKey);
const signature = await wallet.signMessage(challenge);
// Returns "0x..." hex-encoded signature
```

### Using MetaMask (browser)

```javascript
const signature = await ethereum.request({
  method: 'personal_sign',
  params: [challenge, address],
});
```

### Using @terminal3/t3n-sdk

```typescript
import { ethSignEip191 } from '@terminal3/t3n-sdk';

const signatureBytes = ethSignEip191(
  new TextEncoder().encode(challenge),
  privateKeyBytes
);
const signature = `0x${Buffer.from(signatureBytes).toString('hex')}`;
```

## Step 3: Verify the Challenge

```http
POST /api/auth/verify
Content-Type: application/json

{
  "challengeId": "auth_challenge_abc123...",
  "did": "did:t3n:0x1234567890abcdef1234567890abcdef12345678",
  "signature": "0x...",
  "walletAddress": "0x1234567890abcdef1234567890abcdef12345678"
}
```

**Response** (200):

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": "2026-06-12T18:00:00.000Z",
  "institution": {
    "id": "uuid",
    "displayName": "Wallet 0x123456",
    "t3TenantDid": "did:t3n:0x1234567890abcdef1234567890abcdef12345678"
  }
}
```

## Step 4: Use the Session Token

Include the JWT token in all subsequent API calls:

```http
POST /api/agents/admit
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{ ... }
```

The token expires in **8 hours**. If your agent runs longer, implement token refresh by re-authenticating.

## curl Example

```bash
# Step 1: Request challenge
CHALLENGE_RESPONSE=$(curl -s -X POST http://localhost:3001/api/auth/challenge \
  -H 'Content-Type: application/json' \
  -d '{"did": "did:t3n:0x1234567890abcdef1234567890abcdef12345678"}')

CHALLENGE_ID=$(echo $CHALLENGE_RESPONSE | jq -r '.challengeId')
CHALLENGE=$(echo $CHALLENGE_RESPONSE | jq -r '.challenge')

# Step 2: Sign the challenge (using your wallet/signing tool)
# For demo purposes using a known private key:
SIGNATURE=$(node -e "
  const { Wallet } = require('ethers');
  const wallet = new Wallet('0x...');
  wallet.signMessage(process.argv[1]).then(s => console.log(s));
" "$CHALLENGE")

# Step 3: Verify
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3001/api/auth/verify \
  -H 'Content-Type: application/json' \
  -d "{\"challengeId\": \"$CHALLENGE_ID\", \"did\": \"did:t3n:0x...\", \"signature\": \"$SIGNATURE\", \"walletAddress\": \"0x...\"}")

TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.token')
echo "Session token: $TOKEN"
```

## Security Notes

- Never share your private key. Only ever hand it to your local signing tool.
- The challenge nonce prevents replay attacks — each challenge is single-use.
- Tokens expire after 8 hours. Long-running agents should re-authenticate proactively.
- If your delegation credential is revoked, re-authentication will still work but subsequent `POST /api/agents/admit` will fail.
