import type { AuthSession } from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export interface AuthClientConfig {
  baseUrl: string;
}

export class AuthClient {
  private readonly baseUrl: string;

  public constructor(config: AuthClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  /**
   * Exchange a persistent API key (`gbk_...`) for a session token.
   *
   * This is the only authentication path supported by the agent SDK.
   * The returned `token` is a 8-hour session Bearer; the raw API key is
   * still valid for direct use on protected routes and should be kept
   * secret in the agent's secrets store.
   */
  public async authenticateWithApiKey(apiKey: string): Promise<AuthSession> {
    const response = await fetch(`${this.baseUrl}/api/auth/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ apiKey }),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<AuthSession>;
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
