export type PublicErrorCode =
  | "authorization_failed"
  | "validation_failed"
  | "service_unavailable"
  | "sealing_failed"
  | "not_found";

const publicMessages: Readonly<Record<PublicErrorCode, string>> = {
  authorization_failed: "The requested action is not authorized.",
  validation_failed: "The request could not be accepted.",
  service_unavailable: "The service is temporarily unavailable.",
  sealing_failed: "The intent could not be sealed by the T3 enclave.",
  not_found: "The requested resource was not found.",
};

export class PublicError extends Error {
  public readonly code: PublicErrorCode;
  public readonly statusCode: number;
  public readonly expose = true;

  public constructor(code: PublicErrorCode, statusCode: number, cause?: unknown) {
    super(publicMessages[code], { cause });
    this.name = "PublicError";
    this.code = code;
    this.statusCode = statusCode;
  }

  public toResponse(): { code: PublicErrorCode; message: string; cause?: string } {
    // The cause of a PublicError can be useful diagnostic context
    // — e.g. "T3N tenant contract 'matching' is not registered
    // for this tenant" — that the static public message does not
    // convey. We surface a redacted `cause` field for codes that
    // are already operator-actionable (service_unavailable and
    // sealing_failed) so the client log shows the real reason
    // without needing to scrape the backend stderr. Auth and
    // validation codes do NOT expose the cause to avoid leaking
    // internal schema or trust-bundle detail to a probing client.
    if (this.code === "service_unavailable" || this.code === "sealing_failed") {
      const causeMessage =
        this.cause instanceof Error ? this.cause.message : undefined;
      return causeMessage !== undefined
        ? { code: this.code, message: this.message, cause: causeMessage }
        : { code: this.code, message: this.message };
    }
    return {
      code: this.code,
      message: this.message,
    };
  }
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof PublicError) {
    return error;
  }

  return new PublicError("service_unavailable", 500, error);
}
