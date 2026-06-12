export type PublicErrorCode =
  | "authorization_failed"
  | "validation_failed"
  | "service_unavailable"
  | "not_found";

const publicMessages: Readonly<Record<PublicErrorCode, string>> = {
  authorization_failed: "The requested action is not authorized.",
  validation_failed: "The request could not be accepted.",
  service_unavailable: "The service is temporarily unavailable.",
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

  public toResponse(): { code: PublicErrorCode; message: string } {
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
