import { Router } from "express";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { createApiKeyRequestSchema, revokeApiKeyParamsSchema } from "../models/api-key.js";
import type { ApiKeyManagementService } from "../services/api-key.service.js";

export function createApiKeysRouter(
  apiKeyService: ApiKeyManagementService,
): Router {
  const router = Router();

  // POST /api/keys — Generate a new API key (returns plaintext once)
  router.post("/keys", async (request, response, next) => {
    try {
      const parsed = createApiKeyRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const operatorAuth = requireOperatorAuth(response);

      const created = await apiKeyService.createKey(
        operatorAuth.institutionId,
        parsed.data.label,
        parsed.data.scopes,
      );

      response.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/keys — List active API keys (without secret)
  router.get("/keys", async (_request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);

      const keys = await apiKeyService.listKeys(operatorAuth.institutionId);

      response.status(200).json(keys);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/keys/:id/revoke — Revoke an API key
  router.post("/keys/:id/revoke", async (request, response, next) => {
    try {
      const parsed = revokeApiKeyParamsSchema.safeParse(request.params);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const operatorAuth = requireOperatorAuth(response);

      await apiKeyService.revokeKey(parsed.data.id, operatorAuth.institutionId);

      response.status(200).json({ revoked: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
