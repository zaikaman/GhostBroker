import { Router } from "express";
import { z } from "zod";
import { assertInstitutionScope, requireOperatorAuth } from "../auth/operator-auth.js";
import { PublicError } from "../errors/public-error.js";
import type { ApiKeyManagementService } from "../services/api-key.service.js";
import type {
  DemoAgentOrchestrator,
  DemoStatus,
} from "../services/demo-orchestrator.js";

/**
 * Demo Mode HTTP surface.
 *
 * The dashboard's Observatory tab calls these three
 * endpoints to drive the one-click "Spin up demo agents"
 * flow:
 *
 *   - `POST /api/demo/start` — mints a per-institution
 *     demo API key (via the existing `apiKeyService`) and
 *     spawns the buyer + seller agent child processes.
 *     Returns the running status (PIDs, startedAt).
 *   - `POST /api/demo/stop`  — kills both children and
 *     revokes the demo API key. Idempotent: a stop with
 *     nothing running is a 200 with `running: false`.
 *   - `GET  /api/demo/status` — current state, including
 *     the most recent stdout/stderr tail from each
 *     child (the UI shows a "view logs" affordance on
 *     hover).
 *
 * All three are operator-scoped. The start route asserts
 * the operator's session matches the institution the demo
 * runs under — the dashboard's session is the authority
 * here, and the demo API key is scoped to the same
 * institution.
 *
 * Wiring lives in `app.ts` (mount) and `BackendServices`
 * (the orchestrator bag).
 */
export function createDemoRouter(options: {
  orchestrator: DemoAgentOrchestrator;
  apiKeyService: ApiKeyManagementService;
}): Router {
  const router = Router();
  const { orchestrator, apiKeyService } = options;

  const startSchema = z.object({
    institutionId: z.string().uuid(),
  });

  router.post("/demo/start", async (request, response, next) => {
    try {
      const operatorAuth = requireOperatorAuth(response);

      const parsed = startSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new PublicError("validation_failed", 400, parsed.error);
      }
      assertInstitutionScope(operatorAuth, parsed.data.institutionId);

      // The demo API key is a fresh key minted for the
      // demo run. We mint it through the same service the
      // dashboard uses, so the audit log + label match
      // production keys. The key is short-lived: the
      // orchestrator revokes it on stop; a backend
      // crash leaves the key in the DB but the demo is
      // already gone (no spawned child to use it), and
      // the operator can sweep via the API Keys panel.
      const apiKey = await apiKeyService.createKey(
        parsed.data.institutionId,
        `demo-${new Date().toISOString().slice(11, 19)}`,
        ["agent:operate"],
      );

      try {
        const status = await orchestrator.startDemo({
          institutionId: parsed.data.institutionId,
          demoApiKey: apiKey.key,
        });
        response.status(200).json(status);
      } catch (err) {
        // If the orchestrator refused to start (e.g. one
        // already running), roll back the freshly-minted
        // key so we don't leak an unused bearer.
        try {
          await apiKeyService.revokeKey(apiKey.id, parsed.data.institutionId);
        } catch {
          // best-effort
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/demo/stop", async (_request, response, next) => {
    try {
      const status: DemoStatus = await orchestrator.stopDemo();
      response.status(200).json(status);
    } catch (error) {
      next(error);
    }
  });

  router.get("/demo/status", async (_request, response, next) => {
    try {
      const status: DemoStatus = orchestrator.getStatus();
      response.status(200).json(status);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
