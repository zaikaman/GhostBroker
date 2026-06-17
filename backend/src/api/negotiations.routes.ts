import { Router } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { revokeAgentParamsSchema } from "../models/agent.js";
import {
  createNegotiationMandateRequestSchema,
  createNegotiationTicketSchema,
  submitNegotiationMoveSchema,
  walkawayNegotiationSchema,
} from "../models/negotiation.js";
import type { NegotiationManagementService } from "../services/negotiation.service.js";

const negotiationIdParamsSchema = revokeAgentParamsSchema;

export function createNegotiationsRouter(
  negotiationService: NegotiationManagementService,
): Router {
  const router = Router();

  router.get("/negotiations", async (_request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const sessions = await negotiationService.listSessions(
        operatorAuth.institutionId,
      );
      response.status(200).json({ sessions });
    } catch (error) {
      next(error);
    }
  });

  router.get("/negotiations/:id", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = negotiationIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const session = await negotiationService.getSession(
        operatorAuth.institutionId,
        params.data.id,
      );
      response.status(200).json(session);
    } catch (error) {
      next(error);
    }
  });

  router.post("/negotiations/tickets", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const body = createNegotiationTicketSchema.safeParse(request.body);
      if (!body.success) {
        throw new PublicError("validation_failed", 400, body.error);
      }
      assertInstitutionScope(operatorAuth, operatorAuth.institutionId);

      const result = await negotiationService.submitTicket({
        institutionId: operatorAuth.institutionId,
        agentId: body.data.agentId,
        agentDid: body.data.agentDid,
        authorityRef: body.data.policyHash,
        assetCode: body.data.assetCode,
        side: body.data.side,
        compatibilityToken: body.data.compatibilityToken,
        correlationRef: `ticket:${body.data.agentId}:${Date.now()}`,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/negotiations/:id/moves", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = negotiationIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const body = submitNegotiationMoveSchema.safeParse(request.body);
      if (!body.success) {
        throw new PublicError("validation_failed", 400, body.error);
      }
      assertInstitutionScope(operatorAuth, operatorAuth.institutionId);

      const result = await negotiationService.submitMove({
        institutionId: operatorAuth.institutionId,
        sessionId: params.data.id,
        agentId: body.data.agentId,
        agentDid: body.data.agentDid,
        authorityRef: body.data.authorityRef,
        move: body.data.move,
        ...(body.data.claimCredential !== undefined
          ? { claimCredential: body.data.claimCredential }
          : {}),
        correlationRef: `move:${params.data.id}:${Date.now()}`,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/negotiations/:id/walkaway", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = negotiationIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const body = walkawayNegotiationSchema.safeParse(request.body);
      if (!body.success) {
        throw new PublicError("validation_failed", 400, body.error);
      }
      assertInstitutionScope(operatorAuth, operatorAuth.institutionId);

      const result = await negotiationService.submitMove({
        institutionId: operatorAuth.institutionId,
        sessionId: params.data.id,
        agentId: body.data.agentId,
        agentDid: body.data.agentDid,
        authorityRef: body.data.authorityRef,
        move: {
          action: "walkaway",
          reasoning: body.data.reasoning ?? "Counterparty terms cannot reach mandate.",
        },
        correlationRef: `walkaway:${params.data.id}:${Date.now()}`,
      });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function mountAgentMandateRoute(input: {
  router: Router;
  negotiationService: NegotiationManagementService;
}): void {
  input.router.post("/agents/:id/mandate", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = revokeAgentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const body = createNegotiationMandateRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw new PublicError("validation_failed", 400, body.error);
      }

      assertInstitutionScope(operatorAuth, operatorAuth.institutionId);

      const result = await input.negotiationService.createMandate({
        institutionId: operatorAuth.institutionId,
        agentId: params.data.id,
        mandate: body.data.mandate,
        ...(body.data.approverEmail
          ? { approverEmail: body.data.approverEmail }
          : {}),
        ...(body.data.purpose ? { purpose: body.data.purpose } : {}),
        ...(body.data.validityMonths
          ? { validityMonths: body.data.validityMonths }
          : {}),
      });

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });
}
