import { Router, type RequestHandler } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import {
  createInstitutionRequestSchema,
  updateInstitutionRequestSchema,
  type Institution,
} from "../models/institution.js";
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

      const institution = await (
        institutionService as InstitutionManagementService & {
          getInstitution: (id: string) => Promise<Institution>;
        }
      ).getInstitution(id);
      response.status(200).json(institution);
    } catch (error) {
      next(error);
    }
  });

  // WS3: PATCH /api/institutions/:id. Updates the
  // settlement profile and/or the chain-rail metadata.
  // Both fields are optional in the body; if neither is
  // supplied the call is a no-op (and the route returns
  // 400 validation_failed). The metadata-only path is
  // fully supported in v1; the profile-change path is a
  // 503 stub pending WS3.5.
  router.patch("/institutions/:id", authMiddleware, async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const id = request.params.id as string;
      assertInstitutionScope(operatorAuth, id);

      const parsed = updateInstitutionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }
      if (
        parsed.data.settlementProfileRef === undefined &&
        parsed.data.metadata === undefined
      ) {
        throw new PublicError(
          "validation_failed",
          400,
          "PATCH /institutions/:id requires at least one of `settlementProfileRef` or `metadata`.",
        );
      }

      const institution = await (
        institutionService as InstitutionManagementService & {
          updateInstitution: (
            id: string,
            request: { settlementProfileRef?: string; metadata?: Readonly<Record<string, unknown>> },
          ) => Promise<Institution>;
        }
      ).updateInstitution(id, {
        ...(parsed.data.settlementProfileRef !== undefined
          ? { settlementProfileRef: parsed.data.settlementProfileRef }
          : {}),
        ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
      });
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
