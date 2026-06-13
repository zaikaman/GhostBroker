import type { ApiKeyManagementService } from "../services/api-key.service.js";
import { PublicError } from "../errors/public-error.js";
import type { OperatorAuthContext } from "./operator-auth.js";

export const API_KEY_PREFIX = "gbk";

function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  return match?.[1]?.trim();
}

/**
 * Try to authenticate a request using an API key in the Authorization header.
 * Returns an OperatorAuthContext if the key is valid, or throws a PublicError.
 */
export async function authenticateWithApiKey(
  authorizationHeader: string | undefined,
  keyService: ApiKeyManagementService,
): Promise<OperatorAuthContext> {
  const token = readBearerToken(authorizationHeader);

  if (!token) {
    throw new PublicError("authorization_failed", 401);
  }

  // Only handle our key format
  if (!token.startsWith(`${API_KEY_PREFIX}_`)) {
    throw new PublicError("authorization_failed", 401);
  }

  const apiKey = await keyService.findKeyByToken(token);

  if (!apiKey) {
    throw new PublicError("authorization_failed", 401);
  }

  return {
    operatorId: `apikey:${apiKey.id}`,
    institutionId: apiKey.institutionId,
  } satisfies OperatorAuthContext;
}

/**
 * Check if the Authorization header contains an API key.
 */
export function isApiKeyToken(authorizationHeader: string | undefined): boolean {
  const token = readBearerToken(authorizationHeader);
  if (!token) return false;
  return token.startsWith(`${API_KEY_PREFIX}_`);
}
