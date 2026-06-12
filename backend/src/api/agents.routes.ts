import { Router } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { admitAgentRequestSchema } from "../models/agent.js";
import { parseEncryptedIntentRequest } from "../validation/encrypted-intent.schema.js";
import type { AgentAdmissionService } from "../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../services/hidden-intent.service.js";

export function createAgentsRouter(
  agentService: AgentAdmissionService,
  hiddenIntentService?: HiddenIntentSubmissionService,
): Router {
  const router = Router();

  router.post("/agents/admit", async (request, response, next) => {
    try {
      const parsed = admitAgentRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const operatorAuth = requireOperatorAuth(response);
      assertInstitutionScope(operatorAuth, parsed.data.institutionId);

      const admission = await agentService.admitAgent(parsed.data);
      response.status(200).json(admission);
    } catch (error) {
      next(error);
    }
  });

  router.post("/agents/intents", async (request, response, next) => {
    try {
      if (!hiddenIntentService) {
        throw new PublicError("service_unavailable", 503);
      }

      const parsed = parseEncryptedIntentRequest(request.body);
      const operatorAuth = requireOperatorAuth(response);
      assertInstitutionScope(operatorAuth, parsed.institutionId);

      const accepted = await hiddenIntentService.submitIntent(parsed, {
        correlationRef: response.locals.correlationId as string,
      });
      response.status(202).json(accepted);
    } catch (error) {
      if (error instanceof PublicError) {
        next(error);
        return;
      }

      next(new PublicError("validation_failed", 400, error));
    }
  });

  return router;
}
