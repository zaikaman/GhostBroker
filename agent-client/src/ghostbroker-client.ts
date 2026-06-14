import { AuthClient } from "./auth-client.js";
import { IntentClient } from "./intent-client.js";
import { TradesClient } from "./trades-client.js";
import { ReceiptClient } from "./receipt-client.js";
import { TelemetryClient } from "./websocket-client.js";
import { PortfolioClient } from "./portfolio-client.js";
import type {
  AuthSession,
  AdmitAgentRequest,
  AgentAdmission,
  EncryptedIntentRequest,
  IntentAccepted,
  CompletedTrade,
  AuditReceipt,
  AgentPortfolio,
} from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export interface GhostBrokerClientConfig {
  baseUrl: string;
  /**
   * Pre-existing session token. If supplied you should also supply
   * `institutionId` so the telemetry WebSocket can be filtered server-side.
   * For new agents, prefer `await client.authenticateWithApiKey(...)` which
   * fills in both fields in a single call.
   */
  token?: string;
  institutionId?: string;
}

/**
 * Unified client for the GhostBroker dark pool API.
 *
 * Provides a single entry point for all agent operations:
 * authentication, admission, intent submission, trade history,
 * receipts, and telemetry.
 *
 * @example Recommended: API key exchange
 * ```typescript
 * const client = new GhostBrokerClient({ baseUrl: 'https://api.ghostbroker.io' });
 * const session = await client.authenticateWithApiKey(process.env.GHOSTBROKER_API_KEY!);
 * // client.token and client.telemetry are now wired automatically
 * ```
 *
 * @example Pre-existing session
 * ```typescript
 * const client = new GhostBrokerClient({
 *   baseUrl: 'https://api.ghostbroker.io',
 *   token: cachedSessionToken,
 *   institutionId: cachedInstitutionId,
 * });
 * ```
 */
export class GhostBrokerClient {
  public readonly auth: AuthClient;
  public readonly intents: IntentClient;
  public readonly trades: TradesClient;
  public readonly receipts: ReceiptClient;
  public readonly portfolio: PortfolioClient;
  public readonly telemetry: TelemetryClient;
  public token: string | undefined;
  private institutionId: string | undefined;
  private readonly baseUrl: string;

  public constructor(config: GhostBrokerClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.auth = new AuthClient({ baseUrl: this.baseUrl });
    this.intents = new IntentClient(this.baseUrl);
    this.trades = new TradesClient(this.baseUrl);
    this.receipts = new ReceiptClient(this.baseUrl);
    this.portfolio = new PortfolioClient(this.baseUrl);
    this.telemetry = new TelemetryClient(this.baseUrl, config.institutionId ?? "");
    this.token = config.token;
    this.institutionId = config.institutionId;
  }

  /**
   * Authenticate with the GhostBroker API by exchanging a persistent API
   * key for an 8-hour session token. The returned institution info is
   * wired into the telemetry client so the WebSocket stream is filtered
   * correctly. The raw API key is never stored on the client.
   */
  public async authenticateWithApiKey(apiKey: string): Promise<AuthSession> {
    const session = await this.auth.authenticateWithApiKey(apiKey);
    this.applySession(session);
    return session;
  }

  private applySession(session: AuthSession): void {
    this.token = session.token;
    this.institutionId = session.institution.id;
    this.telemetry.setInstitutionId(session.institution.id);
  }

  /**
   * Admit an autonomous agent after verifying delegation proof.
   */
  public async admitAgent(request: AdmitAgentRequest): Promise<AgentAdmission> {
    if (!this.token) throw new GhostBrokerApiError(401, "authorization_failed", "Not authenticated. Call authenticate() or authenticateWithApiKey() first.");

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
   * Submit an encrypted hidden trading intent, including the optional
   * plaintext settlement metadata block. Prefer this in agent code that
   * does not have a T3 enclave runner in front of it: the orchestrator
   * reads `assetCode`/`side`/`quantity`/`price` from the metadata block
   * and the encrypted envelope carries the sealed commitment.
   */
  public async submitEncryptedIntent(
    request: EncryptedIntentRequest,
  ): Promise<IntentAccepted> {
    return this.intents.submitEncryptedIntent(request, this.token ?? "");
  }

  /**
   * Admit the agent using a boundbuyer-style W3C Verifiable Credential
   * instead of a JCS `authorityProof`. The credential is the JSON
   * object that the boundbuyer BUIDL's `setup-delegation.ts` script
   * mints; the server runs it through the boundbuyer verifier
   * (`t3-enclave/src/auth/boundbuyer-delegation.ts`).
   *
   * This is the recommended admit path for agents using the
   * boundbuyer T3 onboarding flow. Returns the same
   * `AgentAdmission` shape as `admitAgent`.
   */
  public async admitAgentWithDelegationCredential(
    request: Omit<AdmitAgentRequest, "authorityProof"> & {
      delegationCredential: unknown;
    },
  ): Promise<AgentAdmission> {
    if (!this.token) {
      throw new GhostBrokerApiError(
        401,
        "authorization_failed",
        "Not authenticated. Call authenticate() or authenticateWithApiKey() first.",
      );
    }
    const response = await fetch(`${this.baseUrl}/api/agents/admit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        ...request,
        // The server requires `authorityProof` to be a non-empty
        // string. The boundbuyer path ignores its contents; we send
        // a short marker so the schema accepts the body.
        authorityProof: `boundbuyer-delegation:${(request.delegationCredential as { id?: string }).id ?? "unknown"}`,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new GhostBrokerApiError(
        response.status,
        (body.code as GhostBrokerApiError["code"]) || "request_failed",
        body.message || `HTTP ${response.status}`,
      );
    }
    return response.json() as Promise<AgentAdmission>;
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

  /**
   * Read the authenticated institution's portfolio, filtered to a
   * single agent's pending reservations.
   *
   * The session token is the one obtained from
   * `authenticateWithApiKey(...)` (or supplied at construction
   * time). The agent DID is the DID minted by the identity-setup
   * step on the agent side. The backend enforces 403 when the
   * institution on the path does not match the session's
   * institution.
   *
   * The returned view is informational: the orchestrator's
   * balance-lock check at submit time is the real authority on
   * whether an intent will be accepted. Use
   * `holding.balance - holding.locked` to compute available
   * balance for sizing the LLM's decision.
   */
  public async getAgentPortfolio(request: {
    institutionId: string;
    agentDid: string;
  }): Promise<AgentPortfolio> {
    if (!this.token) {
      throw new GhostBrokerApiError(
        401,
        "authorization_failed",
        "Not authenticated. Call authenticate() or authenticateWithApiKey() first.",
      );
    }
    return this.portfolio.getPortfolio(request, this.token);
  }
}
