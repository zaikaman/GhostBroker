import { ethRecoverEip191 } from "@terminal3/t3n-sdk";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

/**
 * Default network-call timeout (milliseconds) for the
 * best-effort live identity fallback below. The fallback is
 * not the production authority gate — it is a non-authoritative
 * secondary check for DIDs that do not have a recognizable
 * Ethereum-address form, and a hung SDK request must not stall
 * the dashboard login round-trip.
 */
const DEFAULT_IDENTITY_NETWORK_TIMEOUT_MS = 2_000;

/**
 * DID-challenge verifier for the dashboard login flow.
 *
 * This is **not** the production authority gate for
 * agent-permissioned actions. The per-action authority gate is
 * the Ghostbroker delegation VC verifier in
 * `t3-enclave/src/auth/ghostbroker-delegation.ts`, which runs
 * on every privileged call (`submitIntent`, `cancelIntent`,
 * `settlement.execute`, `negotiation.*`). The verifier in this
 * file answers a strictly narrower question: "does the wallet
 * presenting this DID actually control it?" It is used to mint
 * an operator session token at `/api/auth/verify`; it is not
 * used to admit a trading agent or to authorize any
 * action-on-orders path.
 *
 * Two paths:
 *
 *   1. **Local EIP-191 recovery** (the primary path). When the
 *      request carries a `walletAddress` or the DID embeds an
 *      Ethereum address (`did:t3n:0x<addr>` /
 *      `did:t3n:wallet:0x<addr>`), the verifier
 *      keccak256-recover's the challenge signature and checks
 *      it against the expected address. No network call.
 *
 *   2. **Best-effort live fallback.** When the DID has no
 *      recognizable address form, the verifier MAY call the
 *      T3 network at the configured `verificationPath` (default
 *      `/agent-identity/verify`). That endpoint is **not
 *      documented** in the Terminal 3 public docs
 *      (see `terminal3docs.md:836-841` — the
 *      `agent-identity/verify` and `agent-delegations/verify`
 *      surfaces are explicitly flagged as "not clearly
 *      documented"). The fallback exists only so the verifier
 *      does not immediately fail when the dashboard presents
 *      a non-Ethereum DID; it is a secondary check, not a
 *      primary authority gate. Any non-2xx response, network
 *      timeout, or thrown error is converted to
 *      `unverified` — a best-effort network call is never
 *      allowed to mint a session token on its own.
 *
 * Callers MUST treat the `verified` result as a "DID signature
 * recovered" signal, not as "this DID is authorized to trade."
 * The delegation VC verifier is the only thing that produces
 * a trading-authority signal, and it runs separately on every
 * privileged backend action.
 */

export interface AgentIdentityVerificationRequest {
  did: string;
  challenge: string;
  signature: string;
  walletAddress?: string;
}

export interface VerifiedAgentIdentity {
  status: "verified";
  did: string;
  walletAddress?: string;
}

export interface RejectedAgentIdentity {
  status: "rejected";
  did: string;
  reason: "invalid_signature" | "unverified";
}

export type AgentIdentityVerificationResult =
  | VerifiedAgentIdentity
  | RejectedAgentIdentity;

export interface AgentIdentityVerifier {
  verifyAgentIdentity(
    request: AgentIdentityVerificationRequest,
  ): Promise<AgentIdentityVerificationResult>;
}

function normalizeAddress(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/u.test(normalized) ? normalized : undefined;
}

function addressFromDid(did: string): string | undefined {
  const match = /^did:t3n?:((?:wallet:)?0x[0-9a-f]{40})$/iu.exec(did.trim());
  if (!match || !match[1]) {
    return undefined;
  }

  return normalizeAddress(match[1].replace(/^wallet:/iu, ""));
}

function decodeSignature(signature: string): Uint8Array | undefined {
  const value = signature.trim();
  const hex = value.startsWith("0x") ? value.slice(2) : value;

  if (!/^[0-9a-f]{130}$/iu.test(hex)) {
    return undefined;
  }

  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function recoverWalletAddress(challenge: string, signature: string): string | undefined {
  const signatureBytes = decodeSignature(signature);

  if (!signatureBytes) {
    return undefined;
  }

  const recovered = ethRecoverEip191(
    new TextEncoder().encode(challenge),
    signatureBytes,
  );

  return `0x${Buffer.from(recovered).toString("hex")}`;
}

export interface T3AgentIdentityVerifierOptions {
  /**
   * Hard timeout (milliseconds) for the best-effort live
   * fallback below. Defaults to
   * `DEFAULT_IDENTITY_NETWORK_TIMEOUT_MS` (2s). The fallback
   * is non-authoritative, so a hung SDK request must not stall
   * the dashboard login round-trip; on timeout the verifier
   * returns `unverified`.
   */
  networkTimeoutMs?: number;
}

/**
 * Default constructor. The optional `T3NetworkClient` is the
 * best-effort live fallback described in the file-level
 * docstring; the optional `verificationPath` defaults to
 * `/agent-identity/verify` (an undocumented T3 surface — see
 * the file-level docstring). The `options` bag carries
 * runtime knobs (currently the network timeout).
 */
export class T3AgentIdentityVerifier implements AgentIdentityVerifier {
  private readonly client: T3NetworkClient | undefined;
  private readonly verificationPath: string;
  private readonly networkTimeoutMs: number;

  public constructor(
    client?: T3NetworkClient,
    verificationPath = "/agent-identity/verify",
    options: T3AgentIdentityVerifierOptions = {},
  ) {
    this.client = client;
    this.verificationPath = verificationPath;
    this.networkTimeoutMs =
      options.networkTimeoutMs ?? DEFAULT_IDENTITY_NETWORK_TIMEOUT_MS;
  }

  public async verifyAgentIdentity(
    request: AgentIdentityVerificationRequest,
  ): Promise<AgentIdentityVerificationResult> {
    const expectedAddress =
      request.walletAddress ? normalizeAddress(request.walletAddress) : addressFromDid(request.did);

    if (expectedAddress) {
      try {
        const recovered = recoverWalletAddress(request.challenge, request.signature);

        if (recovered === expectedAddress) {
          return {
            status: "verified",
            did: request.did,
            walletAddress: expectedAddress,
          };
        }
      } catch {
        return {
          status: "rejected",
          did: request.did,
          reason: "invalid_signature",
        };
      }
    }

    if (!this.client) {
      return {
        status: "rejected",
        did: request.did,
        reason: "unverified",
      };
    }

    // Best-effort fallback. Wrapped in a `Promise.race`
    // against a hard timeout so a hung SDK call cannot stall
    // the dashboard login round-trip; the verifier returns
    // `unverified` on timeout, network error, non-2xx
    // response, or any SDK throw. The fallback is not an
    // authority gate — see the file-level docstring.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"__timeout__">((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve("__timeout__"),
        this.networkTimeoutMs,
      );
    });

    try {
      const response = await Promise.race([
        this.client.request<AgentIdentityVerificationResult>({
          method: "POST",
          path: this.verificationPath,
          body: request,
        }),
        timeoutPromise,
      ]);

      if (response === "__timeout__") {
        return {
          status: "rejected",
          did: request.did,
          reason: "unverified",
        };
      }

      if (response.status < 200 || response.status >= 300) {
        return {
          status: "rejected",
          did: request.did,
          reason: "unverified",
        };
      }

      return response.body;
    } catch {
      return {
        status: "rejected",
        did: request.did,
        reason: "unverified",
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
