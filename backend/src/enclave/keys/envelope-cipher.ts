import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Wire-format version for the AEAD-sealed intent envelope.
 *
 * The previous format (`ghostbroker.envelope/1`) was a base64url-
 * encoded JSON blob that anyone with Supabase read access could
 * decode to recover the full plaintext trading parameters
 * (asset / side / quantity / price). The new format is a real
 * AEAD ciphertext: AES-256-GCM with a per-institution key
 * derived from the master envelope key via HKDF-SHA256, and a
 * domain-separated Additional Data binding the ciphertext to
 * (institution, agent, authority, schema version).
 *
 * The version prefix is the first component of the envelope so
 * any future rotation can ship a new prefix without breaking
 * the previous version's `open` path.
 */
export const AEAD_ENVELOPE_SCHEMA_VERSION = "ghostbroker.envelope.aead/v1";

const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_INFO = "ghostbroker.envelope.aead/v1";
const HKDF_SALT_DOMAIN = "ghostbroker.envelope.aead.salt/v1";

/**
 * Length of the AEAD envelope wire body (nonce || ciphertext ||
 * authTag), in bytes. Encoded envelopes are at least this many
 * bytes plus the base64url-overhead for the version prefix.
 */
const AEAD_WIRE_BODY_BYTES = GCM_NONCE_BYTES + GCM_TAG_BYTES;

function digestHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The AEAD master key material. Held only in process memory; the
 * env var that feeds it is the source of truth on disk and across
 * restarts. The 32-byte length matches the AES-256 key size.
 */
export interface EnvelopeMasterKey {
  /** Raw 32-byte key bytes. */
  readonly key: Buffer;
  /**
   * Opaque, public-safe reference for logs and audit. This is
   * a SHA-256 of the key bytes; it does not reveal the key.
   */
  readonly keyFingerprint: string;
  /**
   * Whether this key was derived from the dev fallback rather
   * than supplied via env. Surfaced so production boot paths
   * can fail closed.
   */
  readonly fromDevFallback: boolean;
}

function loadMasterKeyFromEnv(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env["ENVELOPE_ENCRYPTION_MASTER_KEY"];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    throw new Error(
      "ENVELOPE_ENCRYPTION_MASTER_KEY must be 64 hex characters (32 bytes).",
    );
  }
  return Buffer.from(trimmed, "hex");
}

/**
 * The deterministic dev fallback is derived from a fixed
 * application-domain string. It is NEVER appropriate for a
 * production deployment; the orchestrator's startup path must
 * refuse to use it. The fingerprint exposes the provenance so
 * a security review can spot it in logs.
 */
function deriveDevFallbackMasterKey(): Buffer {
  return createHash("sha256")
    .update("ghostbroker.envelope.aead.dev-master-key/v1")
    .digest();
}

const DEV_FALLBACK_FINGERPRINT = digestHex(
  "ghostbroker.envelope.aead.dev-master-key/v1",
);

/**
 * Resolve the AEAD master key for the current process. Reads
 * `ENVELOPE_ENCRYPTION_MASTER_KEY` from `process.env` (32 bytes,
 * 64 hex chars). When the env var is missing or empty the
 * loader falls back to a deterministic dev key derived from a
 * fixed application-domain string. The dev fallback is for
 * local dev and test only; production boot paths must inspect
 * {@link EnvelopeMasterKey.fromDevFallback} and refuse to start.
 */
export function loadEnvelopeMasterKey(
  env: NodeJS.ProcessEnv = process.env,
): EnvelopeMasterKey {
  const fromEnv = loadMasterKeyFromEnv(env);
  if (fromEnv) {
    return {
      key: fromEnv,
      keyFingerprint: digestHex(fromEnv.toString("hex")),
      fromDevFallback: false,
    };
  }
  const fallback = deriveDevFallbackMasterKey();
  return {
    key: fallback,
    keyFingerprint: DEV_FALLBACK_FINGERPRINT,
    fromDevFallback: true,
  };
}

/**
 * Per-institution AEAD key derivation. Uses HKDF-SHA256 with the
 * institution DID as the salt and a fixed `info` string. The
 * master key is never exposed outside the envelope cipher
 * module; callers receive only the derived 32-byte key and the
 * key version string for audit logging.
 */
function deriveInstitutionKey(masterKey: Buffer, institutionDid: string): Buffer {
  // `hkdfSync` with a `string` info returns Buffer; we use a
  // domain-separated tuple so a different `info` in a future
  // module cannot accidentally derive the same key bytes.
  const salt = createHash("sha256")
    .update(`${HKDF_SALT_DOMAIN}\x1f${institutionDid}`)
    .digest();
  const derived = hkdfSync(
    "sha256",
    masterKey,
    salt,
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_BYTES,
  );
  return Buffer.from(derived);
}

/**
 * Construct the Additional Data string the AEAD binds the
 * ciphertext to. The AAD is domain-separated, includes the
 * schema version, and binds the institution + agent + authority
 * so a ciphertext produced for institution A cannot be replayed
 * against institution B even when both derive keys from the
 * same master.
 *
 * The wire form is:
 *
 *   `${SCHEMA_VERSION}\x1f${institutionDid}\x1f${agentDid}\x1f${authorityRef}`
 *
 * `\x1f` is the ASCII unit separator, which is invalid in a
 * DID and an authority reference so the four components can
 * not collide on a single string.
 */
export function buildEnvelopeAad(input: {
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
}): Buffer {
  const { institutionDid, agentDid, authorityRef } = input;
  if (
    institutionDid.length === 0 ||
    agentDid.length === 0 ||
    authorityRef.length === 0
  ) {
    throw new Error(
      "Envelope AAD requires non-empty institutionDid, agentDid, and authorityRef.",
    );
  }
  const joined = [
    AEAD_ENVELOPE_SCHEMA_VERSION,
    institutionDid,
    agentDid,
    authorityRef,
  ].join("\x1f");
  return Buffer.from(joined, "utf8");
}

/**
 * The structured plaintext the envelope carries. Mirrors the
 * previous `ghostbroker.envelope/1` payload so the matching
 * orchestrator's `decodeSealedEnvelope` fallback can read it
 * without code-shape changes. The schema version is bumped to
 * the AEAD version because the on-the-wire format is no longer
 * plaintext JSON.
 */
export interface AeadSealedEnvelopePayload {
  v: string;
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  nonce: string;
}

/**
 * Inputs to {@link sealEnvelope}. The `nonce` field is an
 * optional caller-supplied identifier recorded inside the
 * encrypted payload for correlation; it is NOT used as the
 * GCM nonce (which is always random). Two envelopes with the
 * same inputs but no caller nonce are still distinct because
 * each call uses a fresh random GCM nonce.
 */
/**
 * Structured plaintext the envelope carries, excluding the
 * schema version marker (added on seal) and the optional
 * caller-supplied nonce (handled by {@link sealEnvelope}). The
 * seal input uses this type so the `nonce` field is optional
 * independently of `AeadSealedEnvelopePayload`'s required
 * `nonce`.
 */
export interface SealPayloadFields {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

export interface SealEnvelopeInput {
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
  /**
   * The structured plaintext payload. `nonce` is optional
   * (and not the AEAD nonce -- see {@link sealEnvelope} for
   * the random GCM nonce behaviour); when omitted the seal
   * records a fresh random 128-bit identifier inside the
   * encrypted payload.
   */
  payload: SealPayloadFields & {
    nonce?: string | undefined;
  };
  masterKey: EnvelopeMasterKey;
}

/**
 * Seal a structured payload into an AEAD envelope. Returns a
 * self-describing base64url string of the form
 *
 *   `<version>.<base64url(nonce || ciphertext_with_tag)>`
 *
 * The 96-bit GCM nonce is fresh per call. The AEAD's Additional
 * Data binds the ciphertext to (institution, agent, authority,
 * schema version) so a row swap between institutions cannot
 * pass tag verification.
 */
export function sealEnvelope(input: SealEnvelopeInput): string {
  const { institutionDid, agentDid, authorityRef, payload, masterKey } = input;
  if (payload.side !== "buy" && payload.side !== "sell") {
    throw new Error("Envelope payload side must be 'buy' or 'sell'.");
  }
  if (!Number.isFinite(payload.quantity) || payload.quantity <= 0) {
    throw new Error("Envelope payload quantity must be a positive number.");
  }
  if (!Number.isFinite(payload.price) || payload.price <= 0) {
    throw new Error("Envelope payload price must be a positive number.");
  }
  const nonce =
    typeof payload.nonce === "string" && payload.nonce.length > 0
      ? payload.nonce
      : randomBytes(16).toString("hex");

  const structuredPayload: AeadSealedEnvelopePayload = {
    v: AEAD_ENVELOPE_SCHEMA_VERSION,
    institutionId: payload.institutionId,
    agentDid: payload.agentDid,
    authorityRef: payload.authorityRef,
    assetCode: payload.assetCode,
    side: payload.side,
    quantity: payload.quantity,
    price: payload.price,
    nonce,
  };

  const plaintext = Buffer.from(JSON.stringify(structuredPayload), "utf8");
  const aad = buildEnvelopeAad({ institutionDid, agentDid, authorityRef });
  const perInstitutionKey = deriveInstitutionKey(masterKey.key, institutionDid);
  const gcmNonce = randomBytes(GCM_NONCE_BYTES);

  const cipher = createCipheriv("aes-256-gcm", perInstitutionKey, gcmNonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const body = Buffer.concat([gcmNonce, ciphertext, authTag]);
  const envelope = `${AEAD_ENVELOPE_SCHEMA_VERSION}|${body.toString("base64url")}`;
  return envelope;
}

export interface OpenEnvelopeInput {
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
  envelope: string;
  masterKey: EnvelopeMasterKey;
}

/**
 * Open an AEAD envelope produced by {@link sealEnvelope}.
 * Verifies the AES-256-GCM tag (so any tamper or wrong-key
 * attempt raises) and returns the structured plaintext. Throws
 * on any mismatch -- the caller must fail closed, never attempt
 * to interpret partial / corrupt output.
 */
export function openEnvelope(input: OpenEnvelopeInput): AeadSealedEnvelopePayload {
  const { institutionDid, agentDid, authorityRef, envelope, masterKey } = input;
  // The wire format is `<version>|<body>`. We use `|` (rather
  // than `.`) as the separator so the version prefix can carry
  // dots without ambiguity (e.g.
  // `ghostbroker.envelope.aead/v1|<base64>`).
  const sep = envelope.indexOf("|");
  if (sep <= 0) {
    throw new Error("Sealed envelope is missing the version separator.");
  }
  const version = envelope.slice(0, sep);
  if (version !== AEAD_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `Sealed envelope schema version mismatch (expected ${AEAD_ENVELOPE_SCHEMA_VERSION}, got ${version}).`,
    );
  }
  const bodyB64 = envelope.slice(sep + 1);
  const body = Buffer.from(bodyB64, "base64url");
  if (body.length < AEAD_WIRE_BODY_BYTES) {
    throw new Error(
      `Sealed envelope is shorter than the AEAD nonce+tag minimum (got ${body.length} bytes, expected at least ${AEAD_WIRE_BODY_BYTES}).`,
    );
  }

  const gcmNonce = body.subarray(0, GCM_NONCE_BYTES);
  const authTag = body.subarray(body.length - GCM_TAG_BYTES);
  const ciphertext = body.subarray(GCM_NONCE_BYTES, body.length - GCM_TAG_BYTES);

  const aad = buildEnvelopeAad({ institutionDid, agentDid, authorityRef });
  const perInstitutionKey = deriveInstitutionKey(masterKey.key, institutionDid);

  const decipher = createDecipheriv(
    "aes-256-gcm",
    perInstitutionKey,
    gcmNonce,
    { authTagLength: GCM_TAG_BYTES },
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new Error(
      "Sealed envelope failed AEAD tag verification (tampered, wrong key, or AAD mismatch).",
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch (cause) {
    throw new Error("Sealed envelope decrypted payload is not valid JSON.", {
      cause,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Sealed envelope decrypted payload is not a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== AEAD_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `Sealed envelope plaintext schema version mismatch (expected ${AEAD_ENVELOPE_SCHEMA_VERSION}).`,
    );
  }
  const side = record["side"];
  if (side !== "buy" && side !== "sell") {
    throw new Error("Sealed envelope side is not 'buy' or 'sell'.");
  }
  const quantity = record["quantity"];
  const price = record["price"];
  if (typeof quantity !== "number" || typeof price !== "number") {
    throw new Error("Sealed envelope quantity/price are not numbers.");
  }

  return {
    v: String(record["v"]),
    institutionId: String(record["institutionId"] ?? ""),
    agentDid: String(record["agentDid"] ?? ""),
    authorityRef: String(record["authorityRef"] ?? ""),
    assetCode: String(record["assetCode"] ?? ""),
    side,
    quantity,
    price,
    nonce: String(record["nonce"] ?? ""),
  };
}

/**
 * The same fingerprint string the audit log / DB row carries,
 * so callers can stamp a `key_version` next to the envelope
 * without re-deriving it. The current implementation emits a
 * single version (`envelope-aead-v1`); future rotations add
 * `envelope-aead-v2`, etc.
 */
export function envelopeCipherKeyVersion(): string {
  return "envelope-aead-v1";
}
