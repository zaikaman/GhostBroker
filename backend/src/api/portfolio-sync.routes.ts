import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { BackendEnv } from "../config/env.js";
import { PublicError } from "../errors/public-error.js";
import { portfolioSnapshotSyncRequestSchema } from "../models/portfolio.js";
import type { PortfolioService } from "../services/portfolio.service.js";

function tokenMatches(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function requireSyncToken(env: BackendEnv, request: Request): void {
  if (!env.PORTFOLIO_SYNC_TOKEN) {
    throw new PublicError("service_unavailable", 503);
  }

  const presentedToken = request.header("x-ghostbroker-sync-token")?.trim();
  if (!presentedToken || !tokenMatches(env.PORTFOLIO_SYNC_TOKEN, presentedToken)) {
    throw new PublicError("authorization_failed", 401);
  }
}

export function createPortfolioSyncRouter(
  env: BackendEnv,
  portfolioService: PortfolioService,
): Router {
  const router = Router();

  router.post(
    "/portfolio-snapshots/:institutionId",
    async (request, response, next) => {
      try {
        requireSyncToken(env, request);

        const institutionId = request.params.institutionId;
        const parsed = portfolioSnapshotSyncRequestSchema.safeParse(request.body);

        if (!parsed.success) {
          throw new PublicError("validation_failed", 400, parsed.error);
        }

        const snapshotSyncRequest: {
          institutionId: string;
          holdings: typeof parsed.data.holdings;
          sourceRef?: string;
          observedAt?: string;
        } = {
          institutionId,
          holdings: parsed.data.holdings,
        };

        if (parsed.data.sourceRef !== undefined) {
          snapshotSyncRequest.sourceRef = parsed.data.sourceRef;
        }

        if (parsed.data.observedAt !== undefined) {
          snapshotSyncRequest.observedAt = parsed.data.observedAt;
        }

        const portfolio = await portfolioService.syncPortfolioSnapshot(snapshotSyncRequest);

        response.status(200).json({
          institutionId,
          sourceRef: parsed.data.sourceRef ?? null,
          observedAt: parsed.data.observedAt ?? null,
          portfolio,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
