import { Router, type RequestHandler } from "express";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import {
  createInstitutionRequestSchema,
  updateInstitutionRequestSchema,
  type Institution,
} from "../models/institution.js";
import type { InstitutionManagementService } from "../services/institution.service.js";
import type { InstitutionApprovalService } from "../services/institution-approval.service.js";
import type {
  InstitutionWithdrawalRequest,
  InstitutionWithdrawalService,
} from "../services/institution-withdrawal.service.js";

export function createInstitutionsRouter(
  institutionService: InstitutionManagementService,
  authMiddleware: RequestHandler,
  deps?: {
    approvalService?: InstitutionApprovalService;
    withdrawalService?: InstitutionWithdrawalService;
  },
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
      assertInstitutionScope(operatorAuth, id);      if (!institutionService.rotateKeys) {
        throw new PublicError(
          "service_unavailable",
          503,
          "Key rotation is not supported by this institution service implementation.",
        );
      }
      const institution = await institutionService.rotateKeys(id);
      response.status(200).json(institution);
    } catch (error) {
      next(error);
    }
  });

  const approvalService = deps?.approvalService;
  if (approvalService) {
    // Read the deposit wallet's current balances + relayer
    // approval status. The institution funds this address
    // itself (Deposit flow); this route lets the dashboard
    // show whether funds arrived and whether the relayer is
    // approved.
    router.get("/institutions/:id/deposit-status", authMiddleware, async (request, response, next) => {
      try {
        const operatorAuth = requireOperatorAuth(response);
        const id = request.params.id as string;
        assertInstitutionScope(operatorAuth, id);

        const result = await approvalService.getDepositStatus(id);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    });

    // Sign the deposit wallet's ERC-20 `approve(relayer)`
    // calls. Only the backend can do this because it holds the
    // derived deposit wallet key. Without the approval,
    // on-chain settlement reverts.
    router.post("/institutions/:id/approve-relayer", authMiddleware, async (request, response, next) => {
      try {
        const operatorAuth = requireOperatorAuth(response);
        const id = request.params.id as string;
        assertInstitutionScope(operatorAuth, id);

        const result = await approvalService.approveRelayer(id);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    });
  }

  const withdrawalService = deps?.withdrawalService;
  if (withdrawalService) {
    router.post("/institutions/:id/withdrawals", authMiddleware, async (request, response, next) => {
      try {
        const operatorAuth = requireOperatorAuth(response);
        const id = request.params.id as string;
        assertInstitutionScope(operatorAuth, id);

        const body = (request.body ?? {}) as Partial<InstitutionWithdrawalRequest>;
        if (
          (body.asset !== "ETH" && body.asset !== "WBTC" && body.asset !== "USDC") ||
          typeof body.amount !== "string" ||
          typeof body.toAddress !== "string"
        ) {
          throw new PublicError(
            "validation_failed",
            400,
            "Withdrawal body requires { asset: 'ETH' | 'WBTC' | 'USDC', amount: string, toAddress: address }.",
          );
        }

        const result = await withdrawalService.withdraw(id, {
          asset: body.asset,
          amount: body.amount,
          toAddress: body.toAddress as `0x${string}`,
        });
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}

