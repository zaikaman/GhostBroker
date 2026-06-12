import { AuthClient } from "./auth-client.js";
import { IntentClient } from "./intent-client.js";
import { TradesClient } from "./trades-client.js";
import { ReceiptClient } from "./receipt-client.js";
import { TelemetryClient } from "./websocket-client.js";
import type {
  AuthSession,
  AdmitAgentRequest,
  AgentAdmission,
  EncryptedIntentRequest,
  IntentAccepted,
  CompletedTrade,
  AuditReceipt,
} from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export interface GhostBrokerClientConfig {
  baseUrl: string;
  token?: string;
}

/**
 * Unified client for the GhostBroker dark pool API.
 *
 * Provides a single entry point for all agent operations:
 * authentication, admission, intent submission, trade history,
 * receipts, and telemetry.
 *
 * @example
 * ```typescript
 * const client = new GhostBrokerClient({ baseUrl: 'https://ghostbroker-api.herokuapp.com' });
 *
 * // Authenticate
 * const session = await client.authenticate(did, signer);
 *
 * // Admit agent
 * const admission = await client.admitAgent({ ... });
 *
 * // Submit intent
 * const intent = await client.intents.submitIntent({ ... }, session.token);
 *
 * // Listen for settlement
 * const unsub = client.telemetry.onSettled((ref) => console.log('Settled:', ref));
 * client.telemetry.connect();
 * ```
 */
export class GhostBrokerClient {
  public readonly auth: AuthClient;
  public readonly intents: IntentClient;
  public readonly trades: TradesClient;
  public readonly receipts: ReceiptClient;
  public readonly telemetry: TelemetryClient;
  public token: string | undefined;
  private readonly baseUrl: string;
  private institutionId: string | undefined;

  public constructor(config: GhostBrokerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.auth = new AuthClient({ baseUrl: this.baseUrl });
    this.intents = new IntentClient(this.baseUrl);
    this.trades = new TradesClient(this.baseUrl);
    this.receipts = new ReceiptClient(this.baseUrl);
    this.telemetry = new TelemetryClient(this.baseUrl, "");
    this.token = config.token;
  }

  /**
   * Authenticate with the GhostBroker API.
   * Stores the token and updates the telemetry client with the institution ID.
   */
  public async authenticate(
    did: string,
    signer: (challenge: string) => Promise<{ signature: string; walletAddress?: string }>,
  ): Promise<AuthSession> {
    const session = await this.auth.authenticate(did, signer);
    this.token = session.token;
    this.institutionId = session.institution.id;
    // Recreate telemetry client with proper institution ID
    Object.assign(this, {
      telemetry: new TelemetryClient(this.baseUrl, this.institutionId!),
    });
    return session;
  }

  /**
   * Admit an autonomous agent after verifying delegation proof.
   */
  public async admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission> {
    if (!this.token) throw new GhostBrokerApiError(401, "authorization_failed", "Not authenticated. Call authenticate() first.");

    const response = await fetch(`${this.baseUrl}/api/agents/admit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = (await response.json()) as { code?: string; message?: string };
      throw new GhostBrokerApiError(
        response.status,
        (body.code as GhostBrokerApiError["code"]) || "request_failed",
        body.message || `HTTP ${response.status}`,
      );
    }

    return response.json() as Promise<AgentAdmission>;
  }

  /**
   * Submit an encrypted hidden trading intent.
   */
  public async submitIntent(request: EncryptedIntentRequest): Promise<IntentAccepted> {
    return this.intents.submitIntent(request, this.token ?? "");
  }

  /**
   * Get completed trades for the authenticated institution.
   */
  public async getCompletedTrades(filter?: {
    from?: string;
    to?: string;
  }): Promise<{ items: CompletedTrade[] }> {
    return this.trades.getCompletedTrades(this.token ?? "", filter);
  }

  /**
   * Retrieve an encrypted audit receipt.
   */
  public async getReceipt(receiptId: string): Promise<AuditReceipt> {
    return this.receipts.getReceipt(receiptId, this.token ?? "");
  }
}
