import type { CompletedTrade } from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export interface CompletedTradesFilter {
  from?: string;
  to?: string;
}

export interface CompletedTradesResponse {
  items: CompletedTrade[];
}

export class TradesClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Get completed trades for the authenticated institution.
   *
   * @param token - JWT session token
   * @param filter - Optional date range filter
   * @returns List of completed trades (fields are ciphertext/encrypted)
   */
  public async getCompletedTrades(
    token: string,
    filter?: CompletedTradesFilter,
  ): Promise<CompletedTradesResponse> {
    const url = new URL(`${this.baseUrl}/api/trades/completed`);

    if (filter?.from) url.searchParams.set("from", filter.from);
    if (filter?.to) url.searchParams.set("to", filter.to);

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

    return response.json() as Promise<CompletedTradesResponse>;
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
