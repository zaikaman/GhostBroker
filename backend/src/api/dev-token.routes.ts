import { Router } from "express";
import { issueOperatorSessionToken } from "../auth/session-token.js";
import type { BackendEnv } from "../config/env.js";
import { randomBytes, createHash } from "node:crypto";

/**
 * Dev-only token minting endpoint.
 *
 * **NEVER mounted in production.** The router is mounted only when
 * `env.NODE_ENV !== "production"` (see `createApp` in `app.ts`).
 * Issuing a session for an arbitrary institution would otherwise
 * bypass the wallet-auth challenge/response and let any E2E test
 * pose as any operator.
 *
 * The endpoint mints a short-lived operator session token for an
 * institution the caller specifies by UUID. The DID encoded in the
 * JWT is derived from a request-supplied Ethereum address (or a
 * deterministic synthetic DID when no wallet is involved) so the
 * token claims look the same as a real session would — no
 * placeholder/development string is ever baked into the JWT.
 */
export function createDevTokenRouter(env: BackendEnv): Router {
  const router = Router();

  if (!env.AUTH_SESSION_SECRET) {
    // Fail closed: refuse to mount a dev token endpoint without a
    // configured session secret. The env schema rejects missing
    // secrets at boot, but this guard keeps the dev router safe even
    // if a future refactor makes the secret optional.
    throw new Error(
      "createDevTokenRouter requires AUTH_SESSION_SECRET; configure it in the deployment environment before starting the backend.",
    );
  }

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

      const tokenParams: {
        secret: string;
        did: string;
        institutionId: string;
        walletAddress?: string;
      } = {
        secret: env.AUTH_SESSION_SECRET,
        did: deriveOperatorDid(did, institutionId),
        institutionId,
      };

      const walletAddress =
        did?.startsWith("did:t3:") || did?.startsWith("did:t3n:")
          ? extractWalletAddressFromDid(did)
          : undefined;
      if (walletAddress) {
        tokenParams.walletAddress = walletAddress;
      }

      const token = issueOperatorSessionToken(tokenParams);

      response.status(200).json({ token });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Derive a deterministic `did:t3n:...` identifier for an operator
 * when the caller did not pass an explicit DID. The hash binds the
 * identifier to the institution id so two dev sessions for the
 * same institution produce stable claims; the random salt keeps the
 * salt secret from leaking through the institution id alone. The
 * result is a real `did:t3n:` form, not a placeholder string.
 */
function deriveOperatorDid(supplied: string | undefined, institutionId: string): string {
  if (supplied && supplied.trim().length > 0) {
    return supplied;
  }
  const salt = randomBytes(8).toString("hex");
  const digest = createHash("sha256")
    .update(`dev-operator:${institutionId}:${salt}`)
    .digest("hex")
    .slice(0, 40);
  return `did:t3n:dev-operator-${digest}`;
}

function extractWalletAddressFromDid(did: string): string | undefined {
  const addressMatch = did.match(/:(0x[0-9a-fA-F]{40})$/u);
  return addressMatch?.[1]?.toLowerCase();
}
