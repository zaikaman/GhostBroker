# Security

Thank you for taking the time to responsibly disclose a security issue. The GhostBroker team takes all reports seriously.

## Supported versions

The `@ghostbroker/agent-client` SDK is currently published at `0.1.x`. Security fixes are released for the latest minor and applied to the `main` branch of the monorepo.

| Version | Supported |
|---|---|
| `0.2.x` | ✅ |
| `0.1.x` | ⚠️ Best effort — please upgrade to `0.2.x` if possible. |
| `< 0.1` | ❌ |

## Reporting a vulnerability

**Please do not file a public GitHub issue for security reports.**

Email **security@ghostbroker.io** with:

1. A short description of the vulnerability and its impact.
2. A reproducer (proof of concept, cURL commands, screenshot, or test code).
3. The affected component (SDK, backend, dashboard, TEE enclave, etc.) and version.
4. Your name / handle for the credit line in the advisory, if you'd like one.

We will:

- **Acknowledge** within 2 business days.
- **Triage** within 5 business days, and tell you whether the issue is accepted and the planned fix window.
- **Coordinate disclosure** with you — we'll agree on a release date before publishing.

## Credential handling — what to do if a key leaks

| Credential | What it allows | What to do |
|---|---|---|
| `GHOSTBROKER_API_KEY` (`gbk_…`) | Submit intents + admit agents on behalf of your institution | Revoke from the **API Keys** panel on the dashboard. Generate a new key and update your agent's secrets store. |
| Dashboard operator session token | Read-only dashboard access (no trading authority) | Sign out of the dashboard; sign back in to invalidate active sessions. |
| Delegation credential JCS | One-time admission of a specific agent under a specific policy | Re-issue the credential from the dashboard; admit again. |
| `ADMIN_PRIVATE_KEY` / `AGENT_PRIVATE_KEY` | Signing the delegation proof (admission) | Rotate the affected key. If the admin key leaks, treat all delegated credentials as compromised — re-issue from the dashboard. |

**There is no self-service key rotation in the SDK.** Key rotation is a dashboard operation, by design.

## Hardening checklist for production agents

- [ ] Store `GHOSTBROKER_API_KEY` in a secrets manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, or an environment-injected secret). Do not bake it into a container image.
- [ ] Run the agent under a dedicated service account with no shell access if your platform supports it.
- [ ] Set process-level log filters to redact the key, the session token, and any `authorityProof` value. All three are bearer-class credentials.
- [ ] Pin the SDK to an exact version (`"@ghostbroker/agent-client": "0.2.0"`, not `^0.2.0`) so a compromised intermediate release cannot silently land in your build.
- [ ] Subscribe to GitHub security advisories on the [GhostBroker monorepo](https://github.com/zaikaman/GhostBroker/security/advisories) to get notified of new SDK releases that fix a security issue.
- [ ] Treat the telemetry WebSocket as untrusted input. The events are typed and validated, but a malformed event should not crash the agent.

## Cryptographic notes

- API keys are stored hashed (SHA-256) in the backend. The plaintext key is shown exactly once on creation and is unrecoverable from the backend.
- Session tokens are HMAC-SHA-256 over a compact JWS-style payload (`base64url(header).base64url(payload).signature`). The signing secret is server-side; agents never see it.
- The delegation proof uses EIP-191 (keccak256) for the admin signature and a 64-byte compact secp256k1 signature for the agent invocation — see [`docs/agent-integration/DELEGATION_PROOF.md`](https://github.com/zaikaman/GhostBroker/blob/main/docs/agent-integration/DELEGATION_PROOF.md) for the full wire format.
- The matching engine runs inside a Terminal 3 hardware enclave. The SDK never touches enclave keys, the receipt key, or the match contract.

## Acknowledgements

We are grateful to the security researchers and community members who have helped improve GhostBroker. Reporters who follow this policy and consent to a public advisory are credited in the release notes for the fix.
