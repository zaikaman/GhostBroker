import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { BackendEnv } from "../config/env.js";
import { PublicError } from "../errors/public-error.js";
import { verifyOperatorSessionToken } from "./session-token.js";
import type { ApiKeyManagementService } from "../services/api-key.service.js";
import { authenticateWithApiKey, isApiKeyToken } from "./api-key-auth.js";

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

/**
 * Middleware that authenticates requests using either:
 * 1. A JWT session token (from DID challenge-response), or
 * 2. An API key (`gbk_xxx`) for persistent agent authentication.
 *
 * Pass an `apiKeyService` to enable API key authentication.
 */
export function operatorAuthMiddleware(
  env?: Pick<BackendEnv, "NODE_ENV" | "AUTH_SESSION_SECRET">,
  apiKeyService?: ApiKeyManagementService,
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const authorization = readHeader(request, "authorization");
    const sessionSecret =
      env?.AUTH_SESSION_SECRET ??
      "development-only-auth-session-secret-change-before-production";

    if (!authorization) {
      next(new PublicError("authorization_failed", 401));
      return;
    }

    // Check if this is an API key token (starts with gbk_)
    if (apiKeyService && isApiKeyToken(authorization)) {
      try {
        const authContext = await authenticateWithApiKey(authorization, apiKeyService);
        response.locals[operatorAuthLocalKey] = authContext;
        next();
        return;
      } catch (error) {
        next(error);
        return;
      }
    }

    // Fall through to JWT session authentication
    const token = readBearerToken(request);

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
