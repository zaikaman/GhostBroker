import { Router } from "express";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { completedTradeQuerySchema } from "../models/completed-trade.js";
import type { TradeHistoryService } from "../services/trade-history.service.js";

export function createTradesRouter(tradeHistoryService: TradeHistoryService): Router {
  const router = Router();

  router.get("/trades/completed", async (request, response, next) => {
    try {
      const parsed = completedTradeQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const auth = requireOperatorAuth(response);
      const filter: { from?: string; to?: string } = {};

      if (parsed.data.from) {
        filter.from = parsed.data.from;
      }

      if (parsed.data.to) {
        filter.to = parsed.data.to;
      }

      const result = await tradeHistoryService.listCompletedTrades(
        auth.institutionId,
        filter,
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
