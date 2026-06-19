import {
  createEnvelopeKeyMetadata,
  type EnvelopeKeyGenerationRequest,
  type EnvelopeKeyMetadata,
} from "./key-generation.js";

export interface KeyRotationRequest extends EnvelopeKeyGenerationRequest {
  previousKeyVersion: string;
}

export interface KeyRotationResult {
  previousKeyVersion: string;
  current: EnvelopeKeyMetadata;
  rotatedAt: string;
}

export function rotateEnvelopeKey(request: KeyRotationRequest): KeyRotationResult {
  const current = createEnvelopeKeyMetadata(request);

  if (current.keyVersion === request.previousKeyVersion) {
    throw new Error("Envelope key rotation did not produce a new key version.");
  }

  return {
    previousKeyVersion: request.previousKeyVersion,
    current,
    rotatedAt: current.createdAt,
  };
}
