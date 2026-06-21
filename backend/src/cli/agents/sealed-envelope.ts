import { createHash } from "node:crypto";
import {
  loadEnvelopeMasterKey,
  sealEnvelope,
  type EnvelopeMasterKey,
  type SealPayloadFields,
} from "../../enclave/keys/envelope-cipher.js";

/**
 * GhostBroker's intent route requires the `encryptedIntentEnvelope`
 * field to be a base64url string of 32-32768 characters. The
 * `assetCode` / `side` / `quantity` / `price` trading parameters
 * are sealed into this envelope; the orchestrator only sees the
 * ciphertext plus the TEE-assigned opaque handle. The envelope's
 * job is to carry the TEE-sealed commitment and be opaque on the
 * wire.
 *
 * In a production deployment the envelope is produced by the T3
 * enclave runner (see `backend/src/enclave/matching/blind-intent.ts`
 * and the `t3-enclave/src/matching/match-contract-client.ts` for the
 * live TEE flow). For loop agents that do not have a TEE in front
 * of them we still need a valid envelope: we seal the same trading
 * parameters with the institution's authority reference as a
 * deterministic key.
 *
 * The wire format is real AEAD: AES-256-GCM with a per-institution
 * key derived from `ENVELOPE_ENCRYPTION_MASTER_KEY` (loaded via
 * `loadEnvelopeMasterKey`) via HKDF-SHA256. The AEAD's Additional
 * Data binds the ciphertext to the (institutionDid, agentDid,
 * authorityRef, schema version) tuple, so a row swap between
 * institutions cannot pass tag verification. The previous version
 * (`ghostbroker.envelope/1`) was a base64url-encoded JSON blob with
 * no encryption; anyone with Supabase read access could decode it.
 *
 * The orchestrator's authority check is the GhostBroker delegation
 * VC (zod-validated on admit and re-verified at submit time); the
 * envelope's contents are not consulted for trust decisions at the
 * orchestrator layer (they would be at the TEE match contract,
 * which these loop agents do not exercise).
 */

export interface SealedEnvelopeInput {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  intentNonce?: string;
  /**
   * Override the master key resolver. Tests inject a deterministic
   * key so the AEAD round-trip is reproducible across processes.
   * Production callers leave this unset and rely on the env var
   * `ENVELOPE_ENCRYPTION_MASTER_KEY` via {@link loadEnvelopeMasterKey}.
   */
  masterKey?: EnvelopeMasterKey;
}

export interface SealedEnvelope {
  /** The base64url string the agent sends as `encryptedIntentEnvelope`. */
  envelope: string;
  /** Length of the base64url envelope (helpful for the schema's min check). */
  length: number;
  /** A short opaque handle for log correlation; not sent on the wire. */
  handle: string;
  /**
   * Key fingerprint + version stamped on the envelope for audit.
   * Not sent on the wire; surfaced to local logs and the
   * `audit_receipts.key_version` column.
   */
  keyVersion: string;
}

/**
 * Build a sealed envelope from trading parameters. The envelope is
 * an AES-256-GCM AEAD ciphertext tagged with the wire schema version
 * (`ghostbroker.envelope.aead/v1`). A fresh random GCM nonce is
 * emitted on every call, so two envelopes built from the same input
 * are still distinct on the wire; the optional caller-supplied
 * `intentNonce` is encrypted inside the payload for the orchestrator
 * to correlate.
 */
export function buildSealedEnvelope(input: SealedEnvelopeInput): SealedEnvelope {
  const masterKey = input.masterKey ?? loadEnvelopeMasterKey();
  const payload: SealPayloadFields & { nonce?: string | undefined } = {
    institutionId: input.institutionId,
    agentDid: input.agentDid,
    authorityRef: input.authorityRef,
    assetCode: input.assetCode,
    side: input.side,
    quantity: input.quantity,
    price: input.price,
    ...(input.intentNonce !== undefined ? { nonce: input.intentNonce } : {}),
  };
  const envelope = sealEnvelope({
    institutionDid: input.institutionId,
    agentDid: input.agentDid,
    authorityRef: input.authorityRef,
    payload,
    masterKey,
  });

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

  return {
    envelope,
    length: envelope.length,
    handle,
    keyVersion: `envelope-aead-v1:${masterKey.keyFingerprint.slice(0, 16)}`,
  };
}
