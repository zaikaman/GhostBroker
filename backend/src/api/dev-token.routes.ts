import { Router } from "express";
import { issueOperatorSessionToken } from "../auth/session-token.js";
import type { BackendEnv } from "../config/env.js";

export function createDevTokenRouter(env: BackendEnv): Router {
  const router = Router();

  router.post("/dev/token", (request, response, next) => {
    try {
      const { institutionId, did } = request.body as {
        institutionId?: string;
        did?: string;
      };

      if (!institutionId) {
        response.status(400).json({
          code: "validation_failed",
          message: "institutionId is required.",
        });
        return;
      }

      const token = issueOperatorSessionToken({
        secret:
          env.AUTH_SESSION_SECRET ??
          "development-only-auth-session-secret-change-before-production",
        did: did ?? `did:t3n:e2e:${institutionId}`,
        institutionId,
        walletAddress:
          did?.startsWith("did:t3:") || did?.startsWith("did:t3n:")
            ? extractWalletAddressFromDid(did)
            : undefined,
      });

      response.status(200).json({ token });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function extractWalletAddressFromDid(did: string): string | undefined {
  const addressMatch = did.match(/:(0x[0-9a-fA-F]{40})$/u);
  return addressMatch?.[1]?.toLowerCase();
}
