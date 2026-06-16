import { Router } from "express";
import { z } from "zod";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import { logger } from "../logging/logger.js";
import type { MatchingOrchestrator } from "../services/matching-orchestrator.js";
import type { PortfolioService } from "../services/portfolio.service.js";
import type { WalletPortfolioSyncService } from "../services/sepolia-portfolio-sync.service.js";
import { agentDidSchema } from "../models/agent.js";

const portfoliosQuerySchema = z.object({
  agentDid: agentDidSchema.optional(),
});

/**
 * View of a single locked reservation, returned in the agent-level
 * portfolio payload. Mirrors the orchestrator's
 * `lockDescriptorFor` calculation: a buy intent locks
 * `quantity * price` units of the settlement asset; a sell intent
 * locks `quantity` units of the traded asset.
 */
interface PendingReservationView {
  intentHandle: string;
  assetCode: string;
  amount: number;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

function reservationFor(
  intent: { intentHandle: string; assetCode: string; side: "buy" | "sell"; quantity: number; price: number },
  settlementAssetCode: string,
): PendingReservationView {
  if (intent.side === "buy") {
    return {
      intentHandle: intent.intentHandle,
      assetCode: settlementAssetCode,
      amount: intent.quantity * intent.price,
      side: intent.side,
      quantity: intent.quantity,
      price: intent.price,
    };
  }
  return {
    intentHandle: intent.intentHandle,
    assetCode: intent.assetCode,
    amount: intent.quantity,
    side: intent.side,
    quantity: intent.quantity,
    price: intent.price,
  };
}

export function createPortfoliosRouter(
  portfolioService: PortfolioService,
  walletPortfolioSyncService?: WalletPortfolioSyncService,
  matchingOrchestrator?: MatchingOrchestrator,
): Router {
  const router = Router();

  router.get("/portfolios/:institutionId", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const institutionId = request.params.institutionId;

      // Operators can only view their own institution's portfolio
      if (operatorAuth.institutionId !== institutionId) {
        response.status(403).json({
          code: "authorization_failed",
          message: "You can only view your own institution's portfolio.",
        });
        return;
      }

      // Parse the optional agentDid query parameter. When present,
      // we return an agent-level projection of the institution's
      // portfolio: DB-only (no wallet sync, since the agent does
      // not own the wallet), plus the orchestrator's pending
      // reservations for that agent.
      const queryParsed = portfoliosQuerySchema.safeParse(request.query);
      if (!queryParsed.success) {
        response.status(400).json({
          code: "validation_failed",
          message: "Invalid query parameters.",
        });
        return;
      }
      const { agentDid } = queryParsed.data;

      if (agentDid) {
        // Agent-level view: DB-only, augmented with the agent's
        // current reservations.
        const portfolio = await portfolioService.getPortfolio(institutionId);

        const pendingIntents = matchingOrchestrator
          ? matchingOrchestrator.listPendingIntents({
              institutionId,
              agentDid,
            })
          : [];

        const settlementAssetCode =
          matchingOrchestrator?.settlementAssetCode ?? "USDC";

        const reservations: PendingReservationView[] = pendingIntents.map(
          (intent) => reservationFor(intent, settlementAssetCode),
        );

        response.status(200).json({
          institutionId,
          agentDid,
          holdings: portfolio.holdings,
          pendingReservations: reservations,
        });
        return;
      }

      // Live balance fetch follows the operator's connected wallet
      // address. This is the mirrored trading inventory — the
      // wallet the operator uses for trading, distinct from the
      // settlement deposit wallet which is tracked separately in
      // the settlement profile. Deposit address is intentionally
      // NOT used here; it represents the settlement wallet.
      const walletAddress = operatorAuth.walletAddress;
      if (!walletPortfolioSyncService) {
        response.status(200).json({
          institutionId,
          holdings: [],
        });
        return;
      }
      if (!walletAddress) {
        logger.warn(
          { institutionId },
          "No connected wallet address on session; returning stored portfolio.",
        );
        const portfolio = await portfolioService.getPortfolio(institutionId);
        response.status(200).json(portfolio);
        return;
      }

      try {
        const livePortfolio = await walletPortfolioSyncService.fetchLivePortfolio({
          walletAddress,
        });
        response.status(200).json({
          institutionId,
          holdings: livePortfolio.holdings,
        });
        return;
      } catch (liveError) {
        logger.warn(
          { err: liveError, institutionId, walletAddress },
          "Live Sepolia portfolio fetch failed; returning stored portfolio.",
        );
        // Fall through to database fallback
      }

      // Fallback: return whatever is stored in the database
      const portfolio = await portfolioService.getPortfolio(institutionId);
      response.status(200).json(portfolio);
      return;
    } catch (error) {
      next(error);
    }
  });

  router.get("/portfolios/:institutionId/history", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);
      const institutionId = request.params.institutionId;

      // Operators can only view their own institution's history
      if (operatorAuth.institutionId !== institutionId) {
        response.status(403).json({
          code: "authorization_failed",
          message: "You can only view your own institution's portfolio history.",
        });
        return;
      }

      // Keep portfolio in sync with the operator's connected wallet
      // address for the mirrored trading inventory. The deposit
      // address (settlement wallet) is tracked separately via the
      // settlement profile.
      const walletAddress = operatorAuth.walletAddress;
      if (walletPortfolioSyncService && walletAddress) {
        try {
          await walletPortfolioSyncService.syncInstitutionPortfolio({
            institutionId,
            walletAddress,
          });
        } catch (error) {
          logger.warn(
            { err: error, institutionId, walletAddress },
            "Wallet portfolio sync failed; returning stored history.",
          );
        }
      } else if (walletPortfolioSyncService && !walletAddress) {
        logger.warn(
          { institutionId },
          "No connected wallet address on session; returning stored history.",
        );
      }

      const limit = Math.min(Math.abs(Number(request.query.limit) || 50), 200);
      const history = await portfolioService.getPortfolioHistory(institutionId, limit);
      response.status(200).json(history);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
