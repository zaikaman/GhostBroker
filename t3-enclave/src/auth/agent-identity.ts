import { ethRecoverEip191 } from "@terminal3/t3n-sdk";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

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

export class T3AgentIdentityVerifier implements AgentIdentityVerifier {
  private readonly client: T3NetworkClient | undefined;
  private readonly verificationPath: string;

  public constructor(client?: T3NetworkClient, verificationPath = "/agent-identity/verify") {
    this.client = client;
    this.verificationPath = verificationPath;
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

    const response = await this.client.request<AgentIdentityVerificationResult>({
      method: "POST",
      path: this.verificationPath,
      body: request,
    });

    if (response.status < 200 || response.status >= 300) {
      return {
        status: "rejected",
        did: request.did,
        reason: "unverified",
      };
    }

    return response.body;
  }
}
