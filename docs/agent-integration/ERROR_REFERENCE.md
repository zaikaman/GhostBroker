# GhostBroker Error Reference

All API errors return a consistent JSON format:

```json
{
  "code": "error_code",
  "message": "Human-readable description"
}
```

## Error Codes

| Code | HTTP Status | Meaning | Recovery |
|------|-------------|---------|----------|
| `validation_failed` | 400 | Request body doesn't match the expected schema | Check field types, required fields, and constraints |
| `authorization_failed` | 401/403 | Authentication or authorization check failed | See detailed recovery below |
| `service_unavailable` | 503 | Platform is temporarily unavailable | Retry with exponential backoff |

## Authorization Failure Details

### On Challenge (`POST /api/auth/challenge`)

```json
{
  "code": "authorization_failed",
  "message": "DID not recognized or institution not active."
}
```

**Cause**: The DID doesn't match any registered institution, or the institution is suspended.
**Fix**: Check that you're using the correct DID from the dashboard.

### On Verify (`POST /api/auth/verify`)

```json
{
  "code": "authorization_failed",
  "message": "Challenge expired, invalid, or signature doesn't match."
}
```

**Causes**:
1. Challenge expired — challenges are valid for 5 minutes
2. Wrong signature — the signature doesn't match the expected signer
3. Wrong challenge ID — the challenge was already consumed or doesn't exist

**Fix**: Request a new challenge and ensure the correct private key is used to sign.

### On Admit (`POST /api/agents/admit`)

```json
{
  "code": "authorization_failed",
  "message": "Authorization failed. Request rejected by the security enclave."
}
```

**Causes**:
- Agent DID doesn't match the authenticated session
- Authority proof is malformed or invalid

**Fix**: Ensure the agent DID matches the signing address and regenerate the authority proof.

## WebSocket Errors

| Event | Meaning | Recovery |
|-------|---------|----------|
| `subscribe_failed` | Invalid or expired session token | Re-authenticate and get a new token |
| WebSocket close (4001) | Authentication required | Send subscribe message with valid token |
| WebSocket close (4003) | Session expired | Re-authenticate |

## HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 201 | Created successfully |
| 202 | Accepted (intent submitted, pending processing) |
| 400 | Bad request — check validation errors |
| 401 | Unauthorized — no valid session |
| 403 | Forbidden — valid session but insufficient authority |
| 404 | Not found |
| 503 | Service unavailable — retry later |

## Debugging Checklist

Before contacting support, verify:

1. [ ] Is your API base URL correct?
2. [ ] Is your DID correct (from the dashboard)?
3. [ ] Is your private key loaded correctly?
4. [ ] Is your session token still valid (not expired)?
5. [ ] Are you including the `Authorization: Bearer` header?
6. [ ] Is the request body valid JSON?
7. [ ] Is your agent's network connectivity working?

## Common curl Debugging

```bash
# Test platform connectivity
curl -s https://your-instance.com/api/health

# Test authentication flow
CHALLENGE=$(curl -s -X POST https://your-instance.com/api/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"did": "did:t3n:0x..."}')

echo "$CHALLENGE" | jq .
```
