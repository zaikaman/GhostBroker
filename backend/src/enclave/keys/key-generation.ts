import { createHash, randomBytes } from "node:crypto";

export interface EnvelopeKeyGenerationRequest {
  institutionDid: string;
  purpose: "hidden_intent" | "receipt";
  createdAt?: Date;
}

export interface EnvelopeKeyMetadata {
  institutionDid: string;
  keyVersion: string;
  publicKeyRef: string;
  purpose: "hidden_intent" | "receipt";
  createdAt: string;
}

function digestRef(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function createEnvelopeKeyMetadata(
  request: EnvelopeKeyGenerationRequest,
): EnvelopeKeyMetadata {
  const createdAt = request.createdAt ?? new Date();
  const entropy = randomBytes(16).toString("hex");
  const keyDigest = digestRef(
    request.institutionDid,
    request.purpose,
    createdAt.toISOString(),
    entropy,
  );

  return {
    institutionDid: request.institutionDid,
    keyVersion: `${request.purpose}:${createdAt.toISOString()}:${keyDigest.slice(0, 16)}`,
    publicKeyRef: `t3-key:${keyDigest}`,
    purpose: request.purpose,
    createdAt: createdAt.toISOString(),
  };
}
