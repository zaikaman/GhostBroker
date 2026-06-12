import { Router } from "express";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import { receiptIdParamSchema } from "../models/audit-receipt.js";
import type { ReceiptService } from "../services/receipt.service.js";

export function createReceiptsRouter(receiptService: ReceiptService): Router {
  const router = Router();

  router.get("/receipts/:receiptId", async (request, response, next) => {
    try {
      const parsed = receiptIdParamSchema.safeParse(request.params);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      const auth = requireOperatorAuth(response);
      const receipt = await receiptService.getReceipt(
        parsed.data.receiptId,
        auth.institutionId,
      );
      response.status(200).json(receipt);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
