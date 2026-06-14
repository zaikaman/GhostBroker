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

### On API Key Exchange (`POST /api/auth/api-key`)

```json
{
  "code": "authorization_failed",
  "message": "The requested action is not authorized."
}
```

**Causes**:
1. The API key is unknown (typo or stale)
2. The API key was revoked from the dashboard
3. The key is malformed (e.g. missing the `gbk_` prefix)

**Fix**: Generate a new API key from the **API Keys** panel on the dashboard and update your agent's secrets store.

### On Admit (`POST /api/agents/admit`)

```json
{
  "code": "authorization_failed",
  "message": "Authorization failed. Request rejected by the security enclave."
}
```

**Causes**:
- Agent DID doesn't match the authenticated session
- Authority proof is malformed, expired, or the underlying credential was revoked

**Fix**: Ensure the agent DID matches the session, and re-issue the delegation credential from the dashboard if it was rotated. See [Delegation Proof](./DELEGATION_PROOF.md) for the proof shape.

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
2. [ ] Is your API key loaded correctly from your secrets store?
3. [ ] Is your session token still valid (not expired — 8 hour TTL)?
4. [ ] Are you including the `Authorization: Bearer` header?
5. [ ] Is the request body valid JSON?
6. [ ] Is your agent's network connectivity working?

## Common curl Debugging

```bash
# Test platform connectivity
curl -s https://your-instance.com/api/health

# Test API key exchange
curl -s -X POST https://your-instance.com/api/auth/api-key \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "gbk_..."}'
```
