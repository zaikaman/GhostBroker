# Delegation Proof: Authorizing Your Agent

After your agent authenticates with its API key, it must present a **delegation proof** to `POST /api/agents/admit` before it can submit intents. The proof asserts that a human operator (the institution admin) authorized this specific agent, scope, and policy — without giving the agent any signing authority beyond what was granted.

The proof is the `authorityProof` field in `AdmitAgentRequest`. The backend verifies it against the Terminal 3 delegation system before admitting the agent.

## Quick example

```typescript
import { GhostBrokerClient, DelegationProofBuilder } from "@ghostbroker/agent-client";

const client = new GhostBrokerClient({ baseUrl: process.env.GHOSTBROKER_URL! });
await client.authenticateWithApiKey(process.env.GHOSTBROKER_API_KEY!);

const adminKey = hexToBytes(process.env.ADMIN_PRIVATE_KEY!);
const agentKey = hexToBytes(process.env.AGENT_PRIVATE_KEY!);

const proof = await DelegationProofBuilder.build({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  requestedAction: "agent.admit",
  policyHash: process.env.POLICY_HASH!,  // sha256:… of your policy
  credentialJcsBase64: process.env.CREDENTIAL_JCS_BASE64!,
  adminPrivateKey: adminKey,
  agentPrivateKey: agentKey,
});

const admission = await client.admitAgent({
  institutionId: session.institution.id,
  agentDid: process.env.AGENT_DID!,
  authorityProof: DelegationProofBuilder.serialize(proof),
});
console.log("Admitted:", admission.status, "ref:", admission.authorityRef);
```

## Prerequisites

Before constructing a proof, you need:

1. **A valid session** — obtained via `client.authenticateWithApiKey(...)` or by passing a cached `(token, institutionId)` pair to the client.
2. **An admin private key** — the operator's Terminal 3 keypair. Used to sign the proof's admin portion.
3. **An agent private key** — the agent's own key. Used to sign the agent-acknowledgment portion.
4. **A delegation credential (JCS)** — a base64url-encoded JSON Canonicalization Scheme blob issued by the dashboard when the operator grants the agent. Stored in `CREDENTIAL_JCS_BASE64`.
5. **A policy hash** — the SHA-256 of the trading policy the agent is being admitted under, formatted as `sha256:…`.

## The proof blob

`DelegationProofBuilder.build(...)` returns a structured object with the following shape:

```typescript
{
  version: "ghostbroker.delegation-proof/1",
  credentialJcs: string;            // base64url
  userSignature: string;            // 0x… admin signature over the request
  recoveredUserAddress: string;     // 0x… derived from userSignature
  agentSignature: string;           // 0x… agent signature over the request
  nonce: string;
  requestHash: string;              // 0x… keccak256 of the canonical request
  request: {
    institutionId: string;
    agentDid: string;
    requestedAction: "agent.admit" | "intent.submit" | "settlement.execute";
    policyHash: string;
  };
}
```

Call `DelegationProofBuilder.serialize(proof)` to get the JSON string that goes into the `authorityProof` field of the admit request.

## The admit call

```http
POST /api/agents/admit
Authorization: Bearer ***
Content-Type: application/json

{
  "institutionId": "uuid-here",
  "agentDid": "did:t3n:0xYourAgentAddress",
  "authorityProof": "{\"version\":\"ghostbroker.delegation-proof/1\",...}"
}
```

Success response:

```json
{
  "agentDid": "did:t3n:0x...",
  "status": "admitted",
  "authorityRef": "t3-delegation:..."
}
```

Save the `authorityRef` — it is the value your agent uses in every subsequent `submitIntent(...)` call.

## Notes

- The proof is **one-time use** per admit. To rotate the agent, request a new credential from the dashboard and build a new proof.
- The proof's signatures are EIP-191 over the canonical request hash. The admin's key signs as the "delegator"; the agent's key signs as the "delegatee".
- The backend verifies the proof against the dashboard-issued credential before admitting the agent. If the credential was revoked, the admit is rejected with `authorization_failed`.

## Troubleshooting

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `validation_failed` on admit | `authorityProof` is not valid JSON, or the inner request fields are wrong shape | Re-serialize the proof; check that `version`, `credentialJcs`, and all signatures are present |
| `authorization_failed` on admit | Signature didn't recover to the expected address, or the credential was revoked | Verify the admin and agent keys match the dashboard; re-issue the credential from the dashboard if it was rotated |
| `not_found` on admit | Institution or agent DID doesn't match the session | Ensure `institutionId` matches the session's `institution.id`; ensure `agentDid` matches the value in the credential |
