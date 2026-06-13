import { Router } from "express";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import type { PortfolioService } from "../services/portfolio.service.js";

export function createPortfoliosRouter(
  portfolioService: PortfolioService,
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

      const limit = Math.min(Math.abs(Number(request.query.limit) || 50), 200);
      const history = await portfolioService.getPortfolioHistory(institutionId, limit);
      response.status(200).json(history);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
