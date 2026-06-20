import type { IntentAccepted, EncryptedIntentRequest } from "./types.js";
import { GhostBrokerApiError } from "./errors.js";
import { logger } from "../../logging/logger.js";

export class IntentClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Submit an encrypted hidden trading intent.
   *
   * The wire format is the TEE-sealed envelope plus an opaque handle.
   * The agent is REQUIRED to seal `assetCode` / `side` / `quantity` /
   * `price` into the envelope before calling this method (see
   * `buildSealedEnvelope` in `backend/src/cli/agents/sealed-envelope.ts` for a reference
   * implementation, or the T3 runner for the production path). The
   * orchestrator never receives plaintext trading parameters; the
   * T3 enclave is the single authority on those values and returns
   * a TEE-attested lock descriptor on the seal path.
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
    return this.submitEncryptedIntent(request, token);
  }

  public async submitEncryptedIntent(
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
    } catch (err) {
      logger.debug(
        {
          err,
          event: "sdk.parse_error_fallback",
          url: response.url,
          status: response.status,
        },
        "SDK failed to parse error response body; falling back to request_failed.",
      );
      return new GhostBrokerApiError(response.status, "request_failed", `HTTP ${response.status}`);
    }
  }
}
