import type { RedactedErrorCode } from "./types.js";

export class GhostBrokerApiError extends Error {
  public readonly status: number;
  public readonly code: RedactedErrorCode | "request_failed";

  public constructor(
    status: number,
    code: RedactedErrorCode | "request_failed",
    message: string,
  ) {
    super(message);
    this.name = "GhostBrokerApiError";
    this.status = status;
    this.code = code;
  }

  public get isRetryable(): boolean {
    return this.status === 503 || this.status >= 500;
  }

  public get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}
