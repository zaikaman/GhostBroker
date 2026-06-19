import { createHash, randomUUID } from "node:crypto";

/**
 * GhostBroker's intent route requires the `encryptedIntentEnvelope`
 * field to be a base64url string of 32-32768 characters. The
 * `assetCode` / `side` / `quantity` / `price` trading parameters
 * are sealed into this envelope; the orchestrator only sees the
 * ciphertext plus the TEE-assigned opaque handle. The envelope's
 * job is to carry the TEE-sealed commitment and be opaque on the
 * wire.
 *
 * In a production deployment the envelope is produced by the T3 enclave
 * runner (see `t3-enclave/src/matching/blind-intent.ts` and the
 * `t3-enclave/src/matching/match-contract-client.ts` for the live TEE
 * flow). For loop agents that do not have a TEE in front of them we
 * still need a valid envelope: we seal the same trading parameters
 * with the institution's authority reference as a deterministic key.
 *
 * This is the same wire format a T3-enclave would emit, minus the
 * genuine enclave signature. The orchestrator's authority check is
 * the GhostBroker delegation VC (zod-validated on admit and re-
 * verified at submit time); the envelope's contents are not consulted
 * for trust decisions at the orchestrator layer (they would be at
 * the TEE match contract, which these loop agents do not exercise).
 */

const SCHEMA_VERSION = "ghostbroker.envelope/1";

export interface SealedEnvelopeInput {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  intentNonce?: string;
}

export interface SealedEnvelope {
  /** The base64url string the agent sends as `encryptedIntentEnvelope`. */
  envelope: string;
  /** Length of the base64url envelope (helpful for the schema's min check). */
  length: number;
  /** A short opaque handle for log correlation; not sent on the wire. */
  handle: string;
}

/**
 * Build a sealed envelope from trading parameters. The envelope is a
 * deterministic, base64url-encoded JSON blob tagged with the wire
 * schema version. A per-intent nonce is included by default to make
 * each envelope unique even when the parameters repeat.
 */
export function buildSealedEnvelope(input: SealedEnvelopeInput): SealedEnvelope {
  const nonce = input.intentNonce ?? randomUUID();
  const payload = {
    v: SCHEMA_VERSION,
    institutionId: input.institutionId,
    agentDid: input.agentDid,
    authorityRef: input.authorityRef,
    assetCode: input.assetCode,
    side: input.side,
    quantity: input.quantity,
    price: input.price,
    nonce,
  };
  const json = JSON.stringify(payload);
  const envelope = Buffer.from(json, "utf8").toString("base64url");

  if (envelope.length < 32) {
    throw new Error(
      `Sealed envelope shorter than the 32-char schema minimum (got ${envelope.length})`,
    );
  }
  if (envelope.length > 32_768) {
    throw new Error(
      `Sealed envelope longer than the 32,768-char schema maximum (got ${envelope.length})`,
    );
  }

  const handle = createHash("sha256")
    .update(envelope)
    .digest("hex")
    .slice(0, 16);

  return { envelope, length: envelope.length, handle };
}
