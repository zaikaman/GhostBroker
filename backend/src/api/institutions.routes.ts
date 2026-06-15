import { Router, type RequestHandler } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { createInstitutionRequestSchema } from "../models/institution.js";
import type { InstitutionManagementService } from "../services/institution.service.js";

export function createInstitutionsRouter(
  institutionService: InstitutionManagementService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.post("/institutions", async (request, response, next) => {
    try {
      const parsed = createInstitutionRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const institution = await institutionService.createInstitution(parsed.data);
      response.status(201).json({
        id: institution.id,
        legalName: institution.legalName,
        displayName: institution.displayName,
        status: institution.status,
        t3TenantDid: institution.t3TenantDid,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/institutions/:id", authMiddleware, async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const id = request.params.id as string;
      assertInstitutionScope(operatorAuth, id);

      const institution = await institutionService.getInstitution!(id);
      response.status(200).json(institution);
    } catch (error) {
      next(error);
    }
  });

  router.post("/institutions/:id/rotate-key", authMiddleware, async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const id = request.params.id as string;
      assertInstitutionScope(operatorAuth, id);

      const institution = await institutionService.rotateKeys!(id);
      response.status(200).json(institution);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
