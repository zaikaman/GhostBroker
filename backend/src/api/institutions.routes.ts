import { Router } from "express";
import { PublicError } from "../errors/public-error.js";
import { createInstitutionRequestSchema } from "../models/institution.js";
import type { InstitutionManagementService } from "../services/institution.service.js";

export function createInstitutionsRouter(
  institutionService: InstitutionManagementService,
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

  return router;
}
