import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { BackendEnv } from "../config/env.js";
import { PublicError } from "../errors/public-error.js";
import { verifyOperatorSessionToken } from "./session-token.js";

export interface OperatorAuthContext {
  operatorId: string;
  institutionId: string;
  did?: string;
  walletAddress?: string;
}

export const operatorAuthLocalKey = "operatorAuth";

function readHeader(request: Request, name: string): string | undefined {
  const value = request.header(name);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function readBearerToken(request: Request): string | undefined {
  const authorization = readHeader(request, "authorization");
  const match = authorization ? /^Bearer\s+(.+)$/iu.exec(authorization) : null;
  return match?.[1]?.trim();
}

export function operatorAuthMiddleware(
  env?: Pick<BackendEnv, "NODE_ENV" | "AUTH_SESSION_SECRET">,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = readBearerToken(request);
    const sessionSecret =
      env?.AUTH_SESSION_SECRET ??
      "development-only-auth-session-secret-change-before-production";

    if (!token || !sessionSecret) {
      next(new PublicError("authorization_failed", 401));
      return;
    }

    const claims = verifyOperatorSessionToken(token, sessionSecret);
    if (!claims) {
      next(new PublicError("authorization_failed", 401));
      return;
    }

    response.locals[operatorAuthLocalKey] = {
      institutionId: claims.institutionId,
      operatorId: claims.operatorId,
      did: claims.did,
      walletAddress: claims.walletAddress,
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
