import { Router } from "express";
import { z } from "zod";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import {
  admitAgentRequestSchema,
  listAgentsQuerySchema,
  mintDelegationParamsSchema,
  mintDelegationPolicySchema,
  revokeAgentParamsSchema,
  updateAgentLabelSchema,
} from "../models/agent.js";
import { agentDidSchema } from "../models/agent.js";
import { cancelIntentRequestSchema, type PendingIntent } from "../models/hidden-intent.js";
import { parseEncryptedIntentRequest } from "../validation/encrypted-intent.schema.js";
import type { AgentManagementService } from "../services/agent.service.js";
import type { HiddenIntentSubmissionService } from "../services/hidden-intent.service.js";
import { InsufficientBalanceError } from "../services/portfolio.service.js";
import type { TenantDelegationSigner } from "../services/tenant-delegation-signer.js";

const listIntentsQuerySchema = z.object({
  agentDid: agentDidSchema.optional(),
});

/**
 * Public-safe view of a pending intent. Strips fields that should
 * not be exposed through the API (encrypted envelope, authority
 * reference, authority limits) and returns only what an operator or
 * agent needs to monitor their queue.
 */
interface PendingIntentView {
  intentHandle: string;
  correlationRef: string;
  agentDid: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  sealedAt: string;
}

function toPendingIntentView(intent: PendingIntent): PendingIntentView {
  return {
    intentHandle: intent.intentHandle,
    correlationRef: intent.correlationRef,
    agentDid: intent.agentDid,
    assetCode: intent.assetCode,
    side: intent.side,
    quantity: intent.quantity,
    price: intent.price,
    sealedAt: intent.sealedAt,
  };
}

export function createAgentsRouter(
  agentService: AgentManagementService,
  hiddenIntentService?: HiddenIntentSubmissionService,
  tenantSigner?: TenantDelegationSigner,
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

  router.get("/agents", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);

      const query = listAgentsQuerySchema.safeParse(request.query);
      const status = query.success ? query.data.status : undefined;

      const agents = await agentService.listAgents(
        operatorAuth.institutionId,
        status,
      );
      response.status(200).json(agents);
    } catch (error) {
      next(error);
    }
  });

  // IMPORTANT: declare /agents/intents BEFORE /agents/:id so that
  // Express does not treat the literal "intents" as a UUID-shaped
  // path parameter and reject it with 400.
  router.get("/agents/intents", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);

      const query = listIntentsQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw new PublicError("validation_failed", 400, query.error);
      }

      const intents = hiddenIntentService
        ? hiddenIntentService.listPendingIntents({
            institutionId: operatorAuth.institutionId,
            ...(query.data.agentDid
              ? { agentDid: query.data.agentDid }
              : {}),
          })
        : [];

      response.status(200).json({
        intents: intents.map(toPendingIntentView),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents/:id", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = revokeAgentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }

      const agent = await agentService.getAgent(
        params.data.id,
        operatorAuth.institutionId,
      );
      response.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/agents/:id", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const params = revokeAgentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }

      const body = updateAgentLabelSchema.safeParse(request.body);
      if (!body.success) {
        throw new PublicError("validation_failed", 400, body.error);
      }

      const agent = await agentService.updateAgentLabel(
        params.data.id,
        operatorAuth.institutionId,
        body.data.label,
      );
      response.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/agents/:id/revoke", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);

      const params = revokeAgentParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }

      await agentService.revokeAgent(
        params.data.id,
        operatorAuth.institutionId,
      );
      response.status(200).json({ status: "revoked" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Phase 1: server-minted delegation VC re-mint.
   *
   * The dashboard calls this on the "Regenerate Delegation"
   * button (and implicitly, on the new "Configure Agent"
   * flow). The backend signs a fresh VC with the
   * institution's tenant keypair and persists it on the
   * agent record. The agent process never sees the VC; the
   * `loadAndVerify` facade looks it up on every privileged
   * call.
   */
  router.post("/agents/:id/delegation", async (request, response, next) => {
    try {
      if (!tenantSigner) {
        throw new PublicError("service_unavailable", 503);
      }
      const operatorAuth = requireOperatorAuth(response);

      const params = mintDelegationParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PublicError("validation_failed", 400, params.error);
      }

      const policy = mintDelegationPolicySchema.safeParse(request.body);
      if (!policy.success) {
        throw new PublicError("validation_failed", 400, policy.error);
      }

      const agent = await agentService.getAgent(
        params.data.id,
        operatorAuth.institutionId,
      );

      const { credential, policyHash } = await tenantSigner.mint({
        agentDid: agent.agentDid,
        institutionId: agent.institutionId,
        maxSpendUsd: policy.data.maxSpendUsd,
        allowedCategories: [...policy.data.allowedCategories],
        ...(policy.data.approverEmail
          ? { approverEmail: policy.data.approverEmail }
          : {}),
        ...(policy.data.purpose ? { purpose: policy.data.purpose } : {}),
        ...(policy.data.validityMonths
          ? { validityMonths: policy.data.validityMonths }
          : {}),
      });

      const updated = await agentService.persistDelegation({
        agentId: agent.id,
        institutionId: agent.institutionId,
        credential,
        policyHash,
      });

      response.status(200).json({
        authorityRef: updated.authorityRef,
        policyHash: updated.policyHash ?? policyHash,
      });
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

      if (error instanceof InsufficientBalanceError) {
        // The orchestrator refused to queue the intent because
        // the institution's available balance is insufficient.
        // Map to a redacted 403 — the agent should not learn the
        // institution's exact balance.
        next(new PublicError("authorization_failed", 403));
        return;
      }

      next(new PublicError("validation_failed", 400, error));
    }
  });

  router.post("/agents/intents/cancel", async (request, response, next) => {
    try {
      if (!hiddenIntentService) {
        throw new PublicError("service_unavailable", 503);
      }

      const parsed = cancelIntentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const operatorAuth = requireOperatorAuth(response);
      assertInstitutionScope(operatorAuth, parsed.data.institutionId);

      const result = await hiddenIntentService.cancelIntent(parsed.data);
      if (!result) {
        throw new PublicError("not_found", 404);
      }
      response.status(200).json(result);
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
