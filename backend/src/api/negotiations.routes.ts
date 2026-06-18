import { Router } from "express";
import { z } from "zod";
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
const agentMandateQuerySchema = z.object({
  mandateId: z.string().uuid().optional(),
});
const negotiationSessionsQuerySchema = z.object({
  agentDid: z.string().trim().min(1).optional(),
});

const escalationDecisionSchema = z.object({
  reason: z.string().trim().min(1).max(4000).optional(),
});

export function createNegotiationsRouter(
  negotiationService: NegotiationManagementService,
): Router {
  const router = Router();

  router.get("/negotiations", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const query = negotiationSessionsQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new PublicError("validation_failed", 400, query.error);
      }
      if (
        query.data.agentDid &&
        operatorAuth.did &&
        operatorAuth.did !== query.data.agentDid
      ) {
        throw new PublicError("authorization_failed", 403);
      }
      const sessions = await negotiationService.listSessions(
        operatorAuth.institutionId,
        query.data.agentDid,
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

  // Operator approves an escalation that the agent paused for. The
  // orchestrator re-evaluates the cross against the disclosure gate
  // and settles if both clear. Approval is participant-scoped.
  router.post(
    "/negotiations/:id/escalation/approve",
    async (request, response, next) => {
      try {
        const operatorAuth = requireOperatorAuth(response);
        const params = negotiationIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          throw new PublicError("validation_failed", 400, params.error);
        }
        assertInstitutionScope(operatorAuth, operatorAuth.institutionId);
        const result = await negotiationService.approveEscalation({
          institutionId: operatorAuth.institutionId,
          sessionId: params.data.id,
          correlationRef: `escalation:approve:${params.data.id}:${Date.now()}`,
        });
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // Operator declines the escalation. The session expires; no
  // settlement happens.
  router.post(
    "/negotiations/:id/escalation/decline",
    async (request, response, next) => {
      try {
        const operatorAuth = requireOperatorAuth(response);
        const params = negotiationIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          throw new PublicError("validation_failed", 400, params.error);
        }
        const body = escalationDecisionSchema.safeParse(request.body ?? {});
        if (!body.success) {
          throw new PublicError("validation_failed", 400, body.error);
        }
        assertInstitutionScope(operatorAuth, operatorAuth.institutionId);
        const result = await negotiationService.declineEscalation({
          institutionId: operatorAuth.institutionId,
          sessionId: params.data.id,
          ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
          correlationRef: `escalation:decline:${params.data.id}:${Date.now()}`,
        });
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export function mountAgentMandateRoute(input: {
  router: Router;
  negotiationService: NegotiationManagementService;
}): void {
  input.router.get("/agents/:id/mandate", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = revokeAgentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }
      const query = agentMandateQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new PublicError("validation_failed", 400, query.error);
      }

      assertInstitutionScope(operatorAuth, operatorAuth.institutionId);
      const mandate = query.data.mandateId
        ? await input.negotiationService.getMandate(
            operatorAuth.institutionId,
            query.data.mandateId,
          )
        : await input.negotiationService.getMandateByAgent(
            operatorAuth.institutionId,
            params.data.id,
          );
      if (!mandate) {
        throw new PublicError("not_found", 404);
      }
      response.status(200).json(mandate);
    } catch (error) {
      next(error);
    }
  });

  input.router.get("/agents/:id/mandates", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = revokeAgentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }

      assertInstitutionScope(operatorAuth, operatorAuth.institutionId);
      const mandates = await input.negotiationService.listMandatesByAgent(
        operatorAuth.institutionId,
        params.data.id,
      );
      response.status(200).json({ mandates });
    } catch (error) {
      next(error);
    }
  });

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
        request: body.data,
      });

      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });
}
