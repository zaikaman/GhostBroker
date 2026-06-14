import type { AuthChallenge, AuthSession, AuthVerifyRequest } from "./types.js";
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
   * Request a cryptographic challenge for DID-based authentication.
   * The agent must sign this challenge with its private key.
   */
  public async requestChallenge(did: string): Promise<AuthChallenge> {
    const response = await fetch(`${this.baseUrl}/api/auth/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ did }),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<AuthChallenge>;
  }

  /**
   * Submit a signed challenge to obtain a session token.
   * @param verifyRequest - The signed challenge data
   * @returns AuthSession with JWT token and institution info
   */
  public async verifyChallenge(verifyRequest: AuthVerifyRequest): Promise<AuthSession> {
    const response = await fetch(`${this.baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(verifyRequest),
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<AuthSession>;
  }

  /**
   * Full authentication flow: request challenge, sign it, verify.
   * @param did - The agent's DID
   * @param signer - A function that signs a challenge string and returns a signature + wallet address
   */
  public async authenticate(
    did: string,
    signer: (challenge: string) => Promise<{ signature: string; walletAddress?: string }>,
  ): Promise<AuthSession> {
    const challenge = await this.requestChallenge(did);
    const { signature, walletAddress } = await signer(challenge.challenge);

    return this.verifyChallenge({
      challengeId: challenge.challengeId,
      did,
      signature,
      walletAddress,
    });
  }

  /**
   * Exchange a persistent API key (`gbk_...`) for a session token.
   *
   * Recommended for autonomous agents. No challenge, no signer required.
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
