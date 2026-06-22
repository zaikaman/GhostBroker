import type { T3nClient } from "@terminal3/t3n-sdk";

// The T3N SDK declares `AuditEvent` / `AuditBatch` / `AuditPage` /
// `GetAuditEventsOptions` as interfaces but omits them from its
// `export` statement (packaging gap). These mirrors match the SDK
// wire shapes verbatim so the API surface is identical; structural
// typing keeps `T3nClient.getAuditEvents`'s return assignable to
// `AuditPage`. Re-export from `@terminal3/t3n-sdk` once the SDK
// ships them.

export interface AuditEvent {
  ts_ms: number;
  subject: string;
  actor: string;
  vc_id?: string | null;
  action: string;
  target: string;
  outcome: string;
  details?: string | null;
}

export interface AuditBatch {
  key: string;
  committed: boolean;
  events: AuditEvent[];
}

export interface AuditPage {
  batches: AuditBatch[];
  next_cursor?: string | null;
}

/**
 * TEE audit-event read service. A thin pass-through to the T3N
 * SDK's `T3nClient.getAuditEvents` that surfaces the tenant's
 * encrypted, append-only audit trail to the operator dashboard.
 *
 * No DB caching: every call is a live read against T3N's
 * `audit.get-mine`. The T3N getAuditEvents is session-bound to
 * the authenticated tenant DID, so the operator can only ever
 * see their own tenant's audit trail; no institution scoping is
 * required on the backend route.
 *
 * Mirrors the pure pass-through pattern of the enclave
 * attestation probe (`probeEnclaveAttestation`): construct with
 * the `T3nClient` exposed by `SdkAuthenticatedT3NetworkClient`
 * at app boot and call through.
 */
export interface TeeAuditEventService {
  getAuditEvents(opts?: {
    piiDid?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AuditPage>;
}

export class T3nTeeAuditEventService implements TeeAuditEventService {
  private readonly t3nClient: T3nClient;

  public constructor(t3nClient: T3nClient) {
    this.t3nClient = t3nClient;
  }

  public async getAuditEvents(opts?: {
    piiDid?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AuditPage> {
    return this.t3nClient.getAuditEvents({
      ...(opts?.piiDid ? { pii_did: opts.piiDid } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts?.cursor ? { cursor: opts.cursor } : {}),
    });
  }
}
