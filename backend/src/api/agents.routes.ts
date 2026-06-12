import { Router } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { admitAgentRequestSchema } from "../models/agent.js";
import type { AgentAdmissionService } from "../services/agent.service.js";

export function createAgentsRouter(agentService: AgentAdmissionService): Router {
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

  return router;
}
