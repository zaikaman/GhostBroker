import { Router } from "express";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import { logger } from "../logging/logger.js";
import type { PortfolioService } from "../services/portfolio.service.js";
import type { WalletPortfolioSyncService } from "../services/sepolia-portfolio-sync.service.js";

export function createPortfoliosRouter(
  portfolioService: PortfolioService,
  walletPortfolioSyncService?: WalletPortfolioSyncService,
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

      // Query Sepolia blockchain LIVE for the wallet's balances
      const walletAddress = operatorAuth.walletAddress;
      if (walletPortfolioSyncService && walletAddress) {
        try {
          const livePortfolio = await walletPortfolioSyncService.fetchLivePortfolio({
            walletAddress,
          });
          response.status(200).json({
            institutionId,
            holdings: livePortfolio.holdings,
          });
          return;
        } catch (error) {
          logger.warn(
            { err: error, institutionId, walletAddress },
            "Live Sepolia fetch failed; falling back to stored portfolio.",
          );
        }
      }

      // Fallback: return whatever is stored in the database
      const portfolio = await portfolioService.getPortfolio(institutionId);
      response.status(200).json(portfolio);
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

      // Also keep portfolio in sync with Sepolia for history tracking
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
