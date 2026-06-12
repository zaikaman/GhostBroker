import type { IntentAccepted, EncryptedIntentRequest } from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export class IntentClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Submit an encrypted hidden trading intent.
   *
   * @param request - The intent submission payload
   * @param token - JWT session token from authentication
   * @returns IntentAccepted with an opaque intent handle
   * @throws GhostBrokerApiError if submission fails
   */
  public async submitIntent(
    request: EncryptedIntentRequest,
    token: string,
  ): Promise<IntentAccepted> {
    const response = await fetch(`${this.baseUrl}/api/agents/intents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<IntentAccepted>;
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
