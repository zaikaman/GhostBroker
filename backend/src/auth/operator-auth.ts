import type { NextFunction, Request, RequestHandler, Response } from "express";
import { PublicError } from "../errors/public-error.js";

export interface OperatorAuthContext {
  operatorId: string;
  institutionId: string;
}

export const operatorAuthLocalKey = "operatorAuth";

function readHeader(request: Request, name: string): string | undefined {
  const value = request.header(name);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export function operatorAuthMiddleware(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const institutionId = readHeader(request, "x-operator-institution-id");

    if (!institutionId || !isUuid(institutionId)) {
      next(new PublicError("authorization_failed", 401));
      return;
    }

    response.locals[operatorAuthLocalKey] = {
      institutionId,
      operatorId: readHeader(request, "x-operator-id") ?? "operator:unattributed",
    } satisfies OperatorAuthContext;
    next();
  };
}

export function requireOperatorAuth(response: Response): OperatorAuthContext {
  const value = response.locals[operatorAuthLocalKey] as
    | OperatorAuthContext
    | undefined;

  if (!value) {
    throw new PublicError("authorization_failed", 401);
  }

  return value;
}

export function assertInstitutionScope(
  auth: OperatorAuthContext,
  requestedInstitutionId: string,
): void {
  if (auth.institutionId !== requestedInstitutionId) {
    throw new PublicError("authorization_failed", 403);
  }
}
