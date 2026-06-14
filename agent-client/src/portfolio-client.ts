import type { AgentPortfolio } from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export interface AgentPortfolioRequest {
  /**
   * The institution ID. Must match the institution on the session
   * token; the backend returns 403 otherwise.
   */
  institutionId: string;
  /**
   * The agent's DID. The backend filters `pendingReservations` to
   * intents owned by this agent, so the response shape is the
   * agent's slice of the institution's portfolio, not the
   * institution's full view.
   */
  agentDid: string;
}

/**
 * Read-only access to the authenticated institution's portfolio.
 *
 * Backed by `GET /api/portfolios/:institutionId?agentDid=...` on
 * the GhostBroker backend. The route is agent-accessible (mounts
 * under `operatorAuthMiddleware(env, apiKeyService)` in `app.ts`),
 * so an agent session token from `authenticateWithApiKey(...)` is
 * enough to call it.
 *
 * The portfolio read is **informational** — the orchestrator's
 * balance-lock check at submit time is the real authority. Use
 * `holdings[i].balance - holdings[i].locked` to compute available
 * balance for sizing intents, and use `pendingReservations` to
 * avoid double-counting the agent's own in-flight intents.
 */
export class PortfolioClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Fetch the agent's portfolio view for an institution.
   *
   * The session token comes from `client.authenticateWithApiKey(...)`
   * or the constructor's `token` field. The agent DID is the DID
   * minted by `setup:identity` (or supplied to the admit step).
   *
   * @throws GhostBrokerApiError with code `authorization_failed` on
   *   401/403 (missing or wrong-institution session).
   * @throws GhostBrokerApiError with code `validation_failed` on
   *   400 (malformed `agentDid`).
   */
  public async getPortfolio(
    request: AgentPortfolioRequest,
    token: string,
  ): Promise<AgentPortfolio> {
    const url = new URL(
      `${this.baseUrl}/api/portfolios/${encodeURIComponent(request.institutionId)}`,
    );
    url.searchParams.set("agentDid", request.agentDid);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<AgentPortfolio>;
  }

  private async parseError(response: Response): Promise<GhostBrokerApiError> {
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      return new GhostBrokerApiError(
        response.status,
        (body.code as GhostBrokerApiError["code"]) || "request_failed",
        body.message || `HTTP ${response.status}`,
      );
    } catch {
      return new GhostBrokerApiError(response.status, "request_failed", `HTTP ${response.status}`);
    }
  }
}
