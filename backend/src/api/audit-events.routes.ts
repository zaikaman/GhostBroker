import { Router } from "express";
import { z } from "zod";
import { requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import type { TeeAuditEventService } from "../services/tee-audit-event.service.js";

// Cursor is a hex archive key from T3N; limit clamps the page size.
// Both are optional — omitting cursor starts a fresh scan from the
// newest batch; omitting limit lets the SDK pick its default page size.
const auditEventsQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[0-9a-fA-F]+$/u, "cursor must be a hex archive key")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  pii_did: z.string().optional(),
});

export function createAuditEventsRouter(
  auditEventService: TeeAuditEventService,
): Router {
  const router = Router();

  router.get("/audit-events", async (request, response, next) => {
    try {
      const parsed = auditEventsQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }

      // requireOperatorAuth enforces operator-auth scoping. The T3N
      // getAuditEvents call is session-bound to the authenticated
      // tenant DID, so the operator can only ever read their own
      // tenant's audit trail; no institution scoping is needed here.
      requireOperatorAuth(response);

      const page = await auditEventService.getAuditEvents({
        ...(parsed.data.pii_did ? { piiDid: parsed.data.pii_did } : {}),
        ...(parsed.data.limit !== undefined
          ? { limit: parsed.data.limit }
          : {}),
        ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
      });

      response.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
