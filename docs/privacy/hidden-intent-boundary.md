# Hidden Intent Privacy Boundary

GhostBroker accepts active trading intent only as an encrypted envelope sent to `POST /api/agents/intents`.

The backend validates the operator institution, verifies the submitting agent has `intent.submit` authority, and forwards the encrypted envelope to `t3-enclave/`. It must not parse, persist, log, return, or broadcast active order parameters.

## Allowed Outside T3

- `institutionId`
- `agentDid`
- `authorityRef`
- `encryptedIntentEnvelope`
- `intentHandle`
- redacted lifecycle phases: `intent_received`, `intent_sealed`, `encrypted_evaluation`
- correlation references

## Forbidden Outside T3

- asset identifiers
- side or direction
- quantity
- price, bid, ask, or execution price plaintext
- queue position, queue depth, active order counts, or match score
- active counterparty identity
- raw contract arguments
- private keys, secrets, or decrypted payloads

## Service Boundary

`backend/src/services/hidden-intent.service.ts` is the only backend service that coordinates hidden intent submission. It returns only `intentHandle` and `state`.

`t3-enclave/src/matching/blind-intent.ts` owns T3 confidential execution calls and token preflight. Callers receive opaque references only.
