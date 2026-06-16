import { Router } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import {
  createHostedAgentRequestSchema,
  hostedAgentIdParamsSchema,
  listHostedAgentsQuerySchema,
} from "../models/hosted-agent.js";
import type { HostedAgentManagementService } from "../services/hosted-agent.service.js";

export function createHostedAgentsRouter(
  hostedAgentService: HostedAgentManagementService,
): Router {
  const router = Router();

  router.get("/hosted-agents", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const query = listHostedAgentsQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new PublicError("validation_failed", 400, query.error);
      }
      const records = await hostedAgentService.listHostedAgents(
        operatorAuth.institutionId,
        query.data.running,
      );
      response.status(200).json(records);
    } catch (error) {
      next(error);
    }
  });

  router.post("/hosted-agents", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const body = createHostedAgentRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw new PublicError("validation_failed", 400, body.error);
      }
      assertInstitutionScope(operatorAuth, body.data.institutionId);

      const record = await hostedAgentService.createHostedAgent(body.data);
      response.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.get("/hosted-agents/:id", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = hostedAgentIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const record = await hostedAgentService.getHostedAgent(
        params.data.id,
        operatorAuth.institutionId,
      );
      response.status(200).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.post("/hosted-agents/:id/start", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = hostedAgentIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const record = await hostedAgentService.startHostedAgent(
        params.data.id,
        operatorAuth.institutionId,
      );
      response.status(200).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.post("/hosted-agents/:id/stop", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = hostedAgentIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const record = await hostedAgentService.stopHostedAgent(
        params.data.id,
        operatorAuth.institutionId,
      );
      response.status(200).json(record);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

