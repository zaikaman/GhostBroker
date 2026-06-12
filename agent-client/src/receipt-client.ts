import type { AuditReceipt } from "./types.js";
import { GhostBrokerApiError } from "./errors.js";

export class ReceiptClient {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Retrieve an encrypted audit receipt.
   *
   * @param receiptId - UUID of the receipt to retrieve
   * @param token - JWT session token
   * @returns Encrypted receipt data
   * @throws GhostBrokerApiError with code "not_found" if receipt doesn't exist or isn't accessible
   */
  public async getReceipt(receiptId: string, token: string): Promise<AuditReceipt> {
    const response = await fetch(`${this.baseUrl}/api/receipts/${encodeURIComponent(receiptId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw await this.parseError(response);
    }

    return response.json() as Promise<AuditReceipt>;
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
