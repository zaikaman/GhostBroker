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
  /**
   * The chain-rail settlement/deposit wallet for the institution.
   * This is the balance source of truth for chain-rail
   * institutions: the address settle() pays out of, distinct
   * from walletAddress (the login wallet). Only present when the
   * session was issued for a chain-rail institution with a derived
   * deposit address.
   */
  depositAddress?: string;
}

export const operatorAuthLocalKey = "operatorAuth";

function readHeader(request: Request, name: string): string | undefined {
  const value = request.header(name);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function readBearerTokenFromValue(authorization: string | undefined): string | undefined {
  const match = authorization ? /^Bearer\s+(.+)$/iu.exec(authorization) : null;
  return match?.[1]?.trim();
}

/**
 * Middleware that authenticates requests using either:
 * 1. A JWT session token (from DID challenge-response), or
 * 2. An API key (`gbk_xxx`) for persistent agent authentication.
 *
 * Pass an `apiKeyService` to enable API key authentication.
 *
 * Production-safety: `env.AUTH_SESSION_SECRET` is mandatory in every
 * runtime environment (the env schema rejects boots with a missing or
 * short secret). The middleware does not silently substitute a
 * development placeholder — a misconfigured deployment fails to issue
 * any session tokens and every Bearer-protected route returns 401.
 */
export function operatorAuthMiddleware(
  env: Pick<BackendEnv, "NODE_ENV" | "AUTH_SESSION_SECRET">,
  apiKeyService?: ApiKeyManagementService,
): RequestHandler {
  const sessionSecret = env.AUTH_SESSION_SECRET;

  if (!sessionSecret) {
    // Fail closed: refuse to mount JWT auth without a secret so a
    // missing env var cannot lead to silently issued tokens.
    throw new Error(
      "operatorAuthMiddleware requires AUTH_SESSION_SECRET; configure it in the deployment environment before starting the backend.",
    );
  }

  return async (request: Request, response: Response, next: NextFunction) => {
    const authorization = readHeader(request, "authorization");

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
    const token = readBearerTokenFromValue(authorization);

    if (!token) {
      next(new PublicError("authorization_failed", 401));
      return;
    }

    const claims = verifyOperatorSessionToken(token, sessionSecret);
    if (!claims) {
      next(new PublicError("authorization_failed", 401));
      return;
    }

    const authContext: OperatorAuthContext = {
      institutionId: claims.institutionId,
      operatorId: claims.operatorId,
      did: claims.did,
    };

    if (claims.walletAddress) {
      authContext.walletAddress = claims.walletAddress;
    }
    if (claims.depositAddress) {
      authContext.depositAddress = claims.depositAddress;
    }

    response.locals[operatorAuthLocalKey] = authContext;
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
