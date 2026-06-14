import { Router } from "express";
import { PublicError } from "../errors/public-error.js";
import {
  authApiKeyRequestSchema,
  authChallengeRequestSchema,
  authVerifyRequestSchema,
} from "../models/auth.js";
import type { AuthSessionService } from "../services/auth.service.js";

export function createAuthRouter(authService: AuthSessionService): Router {
  const router = Router();

  router.post("/auth/challenge", async (request, response, next) => {
    try {
      const parsed = authChallengeRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      response.status(201).json(await authService.createChallenge(parsed.data.did));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/verify", async (request, response, next) => {
    try {
      const parsed = authVerifyRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      response.status(200).json(await authService.verifyChallenge(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/api-key", async (request, response, next) => {
    try {
      const parsed = authApiKeyRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      response.status(200).json(await authService.authenticateWithApiKey(parsed.data.apiKey));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
