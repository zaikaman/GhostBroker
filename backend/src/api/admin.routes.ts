import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { PublicError } from "../errors/public-error.js";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import type { SettlementRailDispatcher } from "../services/settlement-rails/dispatcher.js";
import { RailDispatchError } from "../services/settlement-rails/rail-dispatch-error.js";
import type { TradeHistoryService } from "../services/trade-history.service.js";
import type { TelemetryBus } from "../services/telemetry-bus.js";

/**
 * WS4.2: the admin reverser. A privileged
 * `POST /api/admin/trades/:tradeRef/reverse` endpoint
 * that:
 *   1. Looks up the original trade.
 *   2. Asserts the operator's `institutionId` matches the
 *      trade's `buyInstitutionId` or `sellInstitutionId`
 *      (the same institution-scope rule as the other
 *      operator-scoped routes).
 *   3. Calls `rail.reverse(tradeRef, reason)` on the
 *      settlement rail that produced the original
 *      settlement.
 *   4. Emits a `rail_reversed` telemetry event so ops
 *      can graph reversal frequency per rail.
 *
 * The reverser is the **only** path that can flip a
 * `completed_trades` row's `settlement_status` to
 * `reversed`; the reconciler (WS4.1) is read-only.
 *
 * For the noop rail, `reverse` is a typed "no-op" that
 * flips the row's status to `reversed` (no external
 * transport to reverse). For the chain rail, the
 * production v1 `reverse` broadcasts a real on-chain
 * reversal transaction against the relayer contract
 * (per the relayer's `reverse` function we shipped in
 * WS2.5). The endpoint's behaviour is identical
 * regardless of which rail the trade was on.
 */
const reverseBodySchema = z.object({
  reason: z.string().trim().min(1).max(1024),
});

export interface AdminRouterDeps {
  railDispatcher: SettlementRailDispatcher;
  tradeHistoryService: TradeHistoryService;
  telemetryBus: TelemetryBus;
}

export function createAdminRouter(
  deps: AdminRouterDeps,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  router.post(
    "/admin/trades/:tradeRef/reverse",
    authMiddleware,
    async (request, response, next) => {
      try {
        const operatorAuth = requireOperatorAuth(response);
        const tradeRef = request.params.tradeRef as string;
        if (!tradeRef || tradeRef.trim().length === 0) {
          throw new PublicError("validation_failed", 400, "tradeRef is required");
        }

        const parsed = reverseBodySchema.safeParse(request.body);
        if (!parsed.success) {
          throw new PublicError("validation_failed", 400, parsed.error);
        }
        const reason = parsed.data.reason;

        // The trade must belong to the operator's
        // institution. We fetch the trade via the
        // trade-history service (the same path the rest
        // of the system uses) and assert institution
        // scope.
        const trade = await deps.tradeHistoryService.getCompletedTradeByRef(
          operatorAuth.institutionId,
          tradeRef,
        );
        if (!trade) {
          throw new PublicError("not_found", 404, "Trade not found");
        }
        if (trade.settlementStatus === "reversed") {
          throw new PublicError(
            "validation_failed",
            409,
            "Trade is already reversed",
          );
        }

        // Resolve the rail via the trade's
        // `settlement_profile_ref`. For WS4 v1 the trade
        // record does not carry the profile ref
        // directly; the trade-history service maps
        // `rail_id` to the canonical profile ref via
        // the rail registry's resolve map. (For the
        // demo, every `wallet:default` rail maps to
        // the noop rail; the chain rail maps to
        // `chain:sepolia:erc20`.)
        const settlementProfileRef = trade.railId ?? "wallet:default";

        let proof;
        try {
          proof = await deps.railDispatcher.resolve(
            settlementProfileRef,
          ).reverse(tradeRef, reason);
        } catch (cause) {
          if (cause instanceof RailDispatchError) {
            throw new PublicError(
              "service_unavailable",
              503,
              `Rail reverser failed: ${cause.message}`,
            );
          }
          throw cause;
        }

        // Emit a `rail_reversed` telemetry event so
        // ops can graph reversal frequency per rail.
        // The operator is the institution the
        // reversal was actioned against (the trade's
        // buyer side by convention — the reverser
        // endpoint is institution-scoped).
        deps.telemetryBus.publish({
          institutionId: operatorAuth.institutionId,
          type: "telemetry.processing.changed",
          phase: "rail_reversed",
          severity: "info",
          correlationRef: tradeRef,
          railProofRef: {
            railId: proof.railId,
            railTradeRef: proof.railTradeRef,
          },
        });

        response.status(200).json({
          tradeRef,
          reason,
          reversedAt: proof.observedAt,
          railState: proof.railState,
          railId: proof.railId,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
