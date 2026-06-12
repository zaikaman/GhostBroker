# Error Reference: Troubleshooting Agent Integration

GhostBroker uses **redacted error responses** to avoid leaking information about active trading activity. All errors follow a standard format with a machine-readable code and a generic human-readable message.

## Error Response Format

All API errors return:

```json
{
  "code": "authorization_failed",
  "message": "Authorization failed. Request rejected by the security enclave."
}
```

## Error Codes

### `authorization_failed` (HTTP 401/403)

The request was rejected due to authentication or authorization failure.

| Scenario | Likely Cause |
|----------|-------------|
| Authentication | Invalid or expired JWT token |
| Challenge expired | The challenge was used after 5-minute expiry |
| Signature invalid | EIP-191 signature doesn't match the expected wallet address |
| Delegation rejected | Agent authority proof is invalid, expired, revoked, or over-scoped |
| Scope mismatch | Agent tried an action not covered by its delegation credential |
| Institution suspended | The institution account is suspended or closed |

**Recovery**:
1. Re-authenticate via `POST /api/auth/challenge` + `POST /api/auth/verify`
2. Check that your delegation credential is still valid in the T3N Dashboard
3. Verify the `institutionId` matches what was returned during auth

### `validation_failed` (HTTP 400)

The request body didn't pass schema validation.

| Scenario | Likely Cause |
|----------|-------------|
| Missing required field | One or more required fields (`institutionId`, `agentDid`, etc.) are absent |
| Malformed DID | The DID doesn't match the `did:t3n:...` or `did:t3:...` pattern |
| Invalid UUID | Institution ID or receipt ID isn't a valid UUID |
| Plaintext trading field | Request body contains forbidden keys like `asset`, `side`, `quantity`, `price` |
| Envelope too short | `encryptedIntentEnvelope` is less than 32 characters |
| Envelope too long | `encryptedIntentEnvelope` exceeds 32KB |

**Recovery**:
1. Validate your request body against the API schema (see [API Reference](./API_REFERENCE.md))
2. Ensure encrypted envelopes contain no plaintext trading fields
3. Check UUIDs are properly formatted (e.g., `550e8400-e29b-41d4-a716-446655440000`)

### `not_found` (HTTP 404)

The requested resource doesn't exist or you're not authorized to access it.

| Scenario | Likely Cause |
|----------|-------------|
| Receipt not found | Receipt ID doesn't exist or belongs to a different institution |
| Trade not found | Trade ID doesn't exist |

**Recovery**:
1. Verify the receipt/trade ID is correct
2. Receipts are only accessible by participating institutions — if you weren't a party to the trade, you'll get 404

### `service_unavailable` (HTTP 503)

The backend or TEE enclave is temporarily unable to process requests.

| Scenario | Likely Cause |
|----------|-------------|
| Backend down | GhostBroker API server is restarting or under maintenance |
| Supabase unavailable | Database layer is unreachable |
| T3N network down | Terminal 3 sandbox network is unavailable |
| Token exhaustion | GhostBroker's T3N token balance is depleted |
| Settlement persistence failed | Could not write completed trade to database |

**Recovery**:
1. Wait and retry with exponential backoff
2. Contact GhostBroker operator if the issue persists
3. For token exhaustion, the operator needs to replenish T3N tokens

## WebSocket Error Events

WebSocket events with `severity: "error"` indicate problems:

```json
{
  "eventId": "evt_error_...",
  "institutionId": "uuid",
  "type": "telemetry.error.changed",
  "phase": "authorization_failed",
  "severity": "error",
  "timestamp": "2026-06-12T10:00:00.000Z",
  "correlationRef": "intent_abc123..."
}
```

| Error Phase | Meaning | Recovery |
|-------------|---------|----------|
| `authorization_failed` | Intent submission rejected due to revoked/exired authority | Check delegation, re-admit agent |
| `token_metering_failed` | T3 execution tokens depleted | Contact operator |
| `settlement_failed` | Atomic settlement transaction failed | Resubmit intent with different parameters |
| `service_unavailable` | Backend enclave offline | Wait, retry later |

## HTTP Status Code Reference

| Status | Meaning | Typical Cause |
|--------|---------|-------------|
| 200 | Success | Request completed successfully |
| 201 | Created | Resource created (challenge, institution) |
| 202 | Accepted | Intent accepted for processing (async) |
| 400 | Bad Request | Validation failed |
| 401 | Unauthorized | Missing or invalid authentication |
| 403 | Forbidden | Authenticated but not authorized |
| 404 | Not Found | Resource not found or not accessible |
| 429 | Too Many Requests | Rate limit exceeded (future) |
| 503 | Service Unavailable | Temporary backend/TEE outage |

## Retry Strategy

For transient failures (503, WebSocket disconnects), implement exponential backoff:

```typescript
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error.code === 'authorization_failed' || 
          error.code === 'validation_failed' ||
          error.code === 'not_found') {
        throw error; // Don't retry client errors
      }
      
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
```

## Debugging Checklist

If your agent can't connect or trade:

1. [ ] Can you reach `GET /api/health`? (no auth required)
2. [ ] Did the auth challenge/verify flow return a token?
3. [ ] Is the token included as `Authorization: Bearer <token>`?
4. [ ] Does your agent DID match the delegation credential on T3N Dashboard?
5. [ ] Is the delegation credential still within its time window (`not_before_secs` / `not_after_secs`)?
6. [ ] Has the credential been revoked?
7. [ ] Is the `authorityProof` JSON properly formatted?
8. [ ] Is `encryptedIntentEnvelope` a valid base64url-encoded ciphertext?
9. [ ] Does your `institutionId` match what was returned from auth?
