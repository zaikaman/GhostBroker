import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

/**
 * W3C Verifiable Credential signing for the GhostBroker-style
 * delegation flow.
 *
 * Browser-safe: no `node:fs`, no `process.env`, no Node-specific
 * modules. Pure functions that take inputs and return outputs.
 * The CLI and disk-write wrappers live in the `agents/`
 * workspace, which imports this module to do the canonical-JSON
 * and EIP-191 signing work.
 *
 * The output is the same W3C JSON-LD VC the backend verifier
 * (`t3-enclave/src/auth/ghostbroker-delegation.ts` →
 * `@terminal3/verify_vc`'s `verifyEcdsaVc`) accepts in
 * `T3_MODE=live`. The verifier:
 *
 *   1. computes `keccak256(canonicalJson(body))` (a 32-byte
 *      digest, where `body` is the VC with `proof` stripped
 *      and `issuanceDate`/`expirationDate` renamed to
 *      `validFrom`/`validUntil`),
 *   2. calls `ethers.verifyMessage(hashHexString, signature)`
 *      where `hashHexString` is the `0x`-prefixed hex of that
 *      32-byte digest. Because `verifyMessage` always applies
 *      EIP-191 to its input as a UTF-8 message, the actual
 *      digest the SDK recovers from is
 *      `keccak256("\x19Ethereum Signed Message:\n" + "66" +
 *      "0x<64 hex>")` — NOT the canonical EIP-191 over the
 *      32-byte payload. See `sdkRecoveryDigestForHashedJson`
 *      for the full rationale.
 *   3. checks `proof.verificationMethod.includes(recoveredAddress)`.
 *
 * So we sign exactly the same digest the SDK recovers from
 * (with EIP-191 pre-applied to the hex-string hash), and emit
 * the standard 65-byte `r || s || v` blob (with `v = 27 + recid`)
 * in `proof.proofValue`.
 *
 * The proof type is `EcdsaSecp256k1Signature2019`, the
 * standard EVM-compatible W3C VC proof format that
 * `@terminal3/verify_vc` accepts via its `verifyEcdsaVc`
 * branch.
 */

/**
 * The action scope carried in the delegation VC's
 * `credentialSubject.allowedActions`.
 *
 * GhostBroker's verifier accepts the only delegation credential
 * the live T3N onboarding surface mints, which is the W3C VC the
 * dashboard (and, in the post-Phase 1 architecture, the
 * backend's own signer in
 * `t3-enclave/src/auth/tenant-delegation.ts`) produces. The
 * schema's `allowedActions` field is the agent's scope over the
 * privileged actions the runtime actually enforces.
 *
 * Earlier revisions of this schema borrowed the procurement
 * BUIDL's `purchaseCategorySchema` enum
 * (`office-supplies | software | hardware | services | travel`).
 * That enum is meaningful for a B2B-procurement delegate acting
 * against a vendor catalog, but it is the wrong shape for a
 * trading agent: none of those values map to anything the
 * GhostBroker orchestrator can gate. The live surface — the
 * dashboard, the run-loop, the orchestrator, the settlement
 * command builder — enforces its privileged action set on the
 * `RequestedAgentAction` enum documented in
 * `t3-enclave/src/auth/ghostbroker-delegation.ts`. The VC scope
 * is the same enum, so the signer, the verifier, and the
 * orchestrator speak the same language about what the agent is
 * allowed to do.
 *
 * The Terminal 3 docs do not publish a canonical "agent
 * delegation VC" schema. The shape below is the only one the
 * live onboarding surface mints; the `terminal3docs.md` reference
 * explicitly notes the agent-delegation shape is undocumented
 * and that the BUIDL reference is "not clearly documented".
 * Treat this schema as a GhostBroker-owned contract, not as a
 * T3N-mandated one.
 */
const delegationActionScopeSchema = z.enum([
  "agent.admit",
  "intent.submit",
  "settlement.execute",
  "negotiation.open",
  "negotiation.move",
  "negotiation.disclose",
  "negotiation.settle",
]);

export type DelegationActionScope = z.infer<typeof delegationActionScopeSchema>;

const negotiationUrgencySchema = z.enum(["low", "normal", "high", "critical"]);
const negotiationSideSchema = z.enum(["buy", "sell"]);
const jsonValueSchema: z.ZodType<
  string | number | boolean | null | Record<string, unknown> | unknown[]
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const negotiationMandateSchema = z.object({
  assetCode: z.string().trim().min(1).max(32),
  side: negotiationSideSchema,
  targetQuantity: z.number().positive(),
  referencePrice: z.number().positive(),
  priceBandBps: z.number().int().nonnegative().max(100000),
  deadline: z.string().datetime(),
  urgency: negotiationUrgencySchema,
  maxNotional: z.string().regex(/^\d+(?:\.\d+)?$/u),
  disclosableClaims: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  requiredCounterpartyClaims: z.record(z.string(), jsonValueSchema).default({}),
  counterpartyConstraints: z.record(z.string(), jsonValueSchema).default({}),
  operatorPrompt: z.string().trim().min(1).max(4000),
});

export type NegotiationMandate = z.infer<typeof negotiationMandateSchema>;

/**
 * Pure-JS hex helpers so this module compiles in both Node
 * and the browser (the published `agent-client` SDK is loaded
 * by the dashboard via Vite, which doesn't polyfill Node's
 * `Buffer` global).
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at byte ${i}: ${hex.slice(i * 2, i * 2 + 2)}`);
    }
    out[i] = byte;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  const hexChars = "0123456789abcdef";
  let out = "";
  for (const byte of bytes) {
    out += hexChars[(byte >> 4) & 0x0f];
    out += hexChars[byte & 0x0f];
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const delegationCredentialSchema = z.object({
  id: z.string().min(1),
  type: z.array(z.string()).min(1),
  issuer: z.string().min(1),
  issuanceDate: z.string().min(1),
  expirationDate: z.string().min(1),
  credentialSubject: z.object({
    id: z.string().min(1),
    agentDid: z.string().min(1),
    maxSpendUsd: z.number().positive(),
    allowedActions: z.array(delegationActionScopeSchema).min(1),
    approverEmail: z.string().email().optional(),
    purpose: z.string().min(1),
    mandate: negotiationMandateSchema.optional(),
  }),
  proof: z
    .object({
      type: z.string().min(1),
      created: z.string().min(1),
      proofPurpose: z.string().min(1),
      verificationMethod: z.string().min(1),
      jws: z.string().optional(),
    })
    .optional(),
});

export type DelegationCredential = z.infer<typeof delegationCredentialSchema>;

/**
 * The body that gets canonicalized and signed. Note the
 * `issuanceDate` / `expirationDate` → `validFrom` / `validUntil`
 * rename — the W3C VC v1.1 / `@terminal3/vc_core` field
 * names are `validFrom` / `validUntil`, and the verifier
 * re-serializes with those names before computing the digest.
 * We do the rename in the signing body so the bytes we sign
 * are byte-identical to the bytes the verifier hashes.
 */
export interface DelegationSigningBody {
  "@context": string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: DelegationCredential["credentialSubject"];
}

export function buildDelegationSigningBody(
  credential: DelegationCredential,
): DelegationSigningBody {
  return {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: credential.id,
    type: credential.type,
    issuer: credential.issuer,
    validFrom: credential.issuanceDate,
    validUntil: credential.expirationDate,
    credentialSubject: {
      ...credential.credentialSubject,
    },
  };
}

/**
 * Deterministic JSON serialization. Object keys are sorted
 * recursively so the bytes signed by the issuer and verified
 * by `@terminal3/verify_vc` are bit-identical. The shape
 * matches what `JSON.stringify` would produce with sorted keys
 * and no whitespace.
 */
export function canonicalizeDelegationJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeDelegationJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${canonicalizeDelegationJson(child)}`,
    )
    .join(",")}}`;
}

/**
 * Build the 32-byte digest the T3 SDK's
 * `@terminal3/verify_vc → @terminal3/ecdsa_vc → verifyEcdsaVcSig`
 * pipeline recovers from our `proof.proofValue`.
 *
 * The SDK computes:
 *   ```js
 *   const json = JSON.stringify(body);                // body = vc with proof stripped
 *   const hash = ethers.solidityPackedKeccak256(["string"], [json]);  // 0x-prefixed hex
 *   const recoveredAddress = ethers.verifyMessage(hash, signature);
 *   ```
 *
 * `ethers.verifyMessage(message, sig)` always treats `message` as a
 * generic message that needs the EIP-191 prefix applied:
 *   digest = keccak256("\x19Ethereum Signed Message:\n" +
 *                      toUtf8Bytes(String(message.length)) +
 *                      messageBytes)
 *
 * The SDK passes the HEX STRING of the keccak hash (66 chars:
 * `"0x" + 64 hex chars`). ethers then treats that hex string as
 * the message to hash — so the digest the SDK actually recovers
 * from is:
 *
 *   digest = keccak256("\x19Ethereum Signed Message:\n" +
 *                      toUtf8Bytes("66") +
 *                      toUtf8Bytes("0x<64 hex>"))
 *
 * NOT the canonical EIP-191 over the 32-byte hash:
 *   keccak256("\x19Ethereum Signed Message:\n32" || hash)
 *
 * If the signer produced the canonical digest, `verifyMessage` in
 * the SDK would still recover a valid signer address — but a
 * different one than the issuer DID's address, so the SDK's
 * `verificationMethod.includes(recoveredAddress)` substring check
 * fails with `"Signature does not correspond to verificationMethod
 * in the proof"`. We sign the same digest the SDK recovers from so
 * the recovered address matches `verificationMethod` exactly.
 *
 * This function is the no-`ethers` pure-JS equivalent of
 * `ethers.hashMessage("0x" + bytesToHex(keccakOfJson))`. The byte
 * layout must stay byte-identical to `ethers.hashMessage` — any
 * drift is a verifier regression caught by the integration test.
 */
function sdkRecoveryDigestForHashedJson(keccakOfJson: Uint8Array): Uint8Array {
  if (keccakOfJson.length !== 32) {
    throw new Error(
      `sdkRecoveryDigestForHashedJson: expected 32-byte keccak digest, got ${keccakOfJson.length} bytes.`,
    );
  }
  // ethers.hashMessage(string) builds:
  //   messagePrefix || toUtf8Bytes(String(message.length)) || messageBytes
  // For our hex-string hash (`"0x" + 64 hex chars`, 66 chars):
  //   messagePrefix = "\x19Ethereum Signed Message:\n"
  //   lengthBytes   = toUtf8Bytes("66") = [0x36, 0x36]
  //   messageBytes  = toUtf8Bytes("0x<64 hex>") = 66 ASCII bytes
  const messagePrefix = new TextEncoder().encode(
    "\x19Ethereum Signed Message:\n",
  );
  const messageHex = `0x${bytesToHex(keccakOfJson)}`;
  if (messageHex.length !== 66) {
    throw new Error(
      `sdkRecoveryDigestForHashedJson: 0x-prefixed hex string must be 66 chars, got ${messageHex.length}.`,
    );
  }
  const lengthBytes = new TextEncoder().encode(String(messageHex.length));
  const messageBytes = new TextEncoder().encode(messageHex);
  const buf = new Uint8Array(
    messagePrefix.length + lengthBytes.length + messageBytes.length,
  );
  buf.set(messagePrefix, 0);
  buf.set(lengthBytes, messagePrefix.length);
  buf.set(messageBytes, messagePrefix.length + lengthBytes.length);
  return keccak_256(buf);
}

/**
 * Sign the SDK-compatibility digest (see `sdkRecoveryDigestForHashedJson`)
 * with EIP-191 personal_sign and return the 65-byte `r || s || v`
 * blob (`v = 27 + recid`).
 *
 * The function probes both Ethereum-style parities (0, 1)
 * using `recoverPublicKey` to find the one whose recovered
 * public key matches the expected compressed pubkey, then
 * emits the matching v. This is the canonical flow for
 * recovering a recid from a `@noble/curves` v2.x signature.
 */
function eip191SignDelegation(
  keccakOfJson: Uint8Array,
  privateKeyHex: string,
  expectedPublicKeyHex: string,
): string {
  if (privateKeyHex.length !== 66 || !privateKeyHex.startsWith("0x")) {
    throw new Error(
      "signing key must be a 0x-prefixed 32-byte hex string (66 chars).",
    );
  }
  if (
    expectedPublicKeyHex.length !== 68 ||
    !expectedPublicKeyHex.startsWith("0x")
  ) {
    throw new Error(
      "expected public key must be a 0x-prefixed 33-byte compressed hex string (68 chars total).",
    );
  }
  const expectedPubKey = hexToBytes(expectedPublicKeyHex.slice(2));
  if (expectedPubKey.length !== 33) {
    throw new Error(
      "expected public key must decode to exactly 33 compressed secp256k1 bytes.",
    );
  }
  const privateKeyBytes = hexToBytes(privateKeyHex.slice(2));
  if (privateKeyBytes.length !== 32) {
    throw new Error("signing key must decode to exactly 32 bytes.");
  }

  // The digest the T3 SDK's `verifyEcdsaVcSig` will actually
  // recover from. See `sdkRecoveryDigestForHashedJson` for the
  // full rationale; the short version is that the SDK passes
  // the keccak hash as a HEX STRING to `ethers.verifyMessage`,
  // which then applies EIP-191 to that hex string's UTF-8
  // bytes (not to the raw 32-byte hash). We mirror that.
  const digest = sdkRecoveryDigestForHashedJson(keccakOfJson);

  // `@noble/curves` v2 supports a `'recovered'` sign format
  // that returns the 65-byte form. Note the v2 layout: the
  // recid byte is at INDEX 0, followed by r || s at indices
  // 1..64 (the opposite convention from EIP-191's 65-byte
  // JWS blob, where recid is the LAST byte). We split the
  // 65-byte form to extract the 64-byte compact r||s, then
  // try both Ethereum-style parities 0/1 (EIP-191 parity
  // outcomes) by building a v1/v2-style 65-byte form
  // (recid FIRST byte) and asking `recoverPublicKey`
  // whether the recovered pubkey matches the expected one.
  const sigBytes = secp256k1.sign(digest, privateKeyBytes, {
    lowS: true,
    prehash: false,
    format: "recovered",
  });
  if (sigBytes.length !== 65) {
    throw new Error(
      `secp256k1.sign with format='recovered' returned ${sigBytes.length} bytes, expected 65.`,
    );
  }
  const rBytes = sigBytes.subarray(1, 33);
  const sBytes = sigBytes.subarray(33, 65);

  for (const recid of [0, 1] as const) {
    const sig65 = new Uint8Array(65);
    sig65[0] = recid;
    sig65.set(rBytes, 1);
    sig65.set(sBytes, 33);
    const recovered = secp256k1.recoverPublicKey(sig65, digest, {
      prehash: false,
    });
    if (bytesEqual(recovered, expectedPubKey)) {
      const out = new Uint8Array(65);
      out.set(rBytes, 0);
      out.set(sBytes, 32);
      out[64] = 27 + recid;
      return `0x${bytesToHex(out)}`;
    }
  }
  // Should be unreachable: for any valid (digest, privateKey)
  // pair exactly one of the two recovery candidates recovers
  // the correct public key. If we got here something is very
  // wrong with the input — fail loud rather than ship a bad
  // signature.
  throw new Error(
    "Could not determine EIP-191 recovery byte — the signing key and the expected public key do not match.",
  );
}

export interface SignDelegationCredentialOptions {
  /**
   * The issuer's 0x-prefixed secp256k1 private key (66 chars).
   * The agent self-issues its own delegation VC in the
   * default GhostBroker flow — the issuer DID is the agent's
   * own DID, and the signing key is the agent's keypair from
   * the T3N identity file.
   */
  privateKey: string;
  /**
   * The issuer's 0x-prefixed 33-byte compressed secp256k1
   * public key (68 chars total). Used to derive the EIP-191
   * recovery byte. Derive it from `privateKey` via
   * `secp256k1.getPublicKey(privateKey, true)`.
   */
  publicKey: string;
  /** The issuer's `did:t3n:0x...` identifier. */
  issuerDid: string;
  /**
   * Optional additional signer reference. When the signing
   * keypair's address does NOT match the `issuerDid`'s
   * embedded address (e.g. when the institution uses a T3
   * SDK API key whose derived address differs from the T3
   * tenant DID's address), the verifier needs the additional
   * signer reference to find the recovered address inside
   * the `verificationMethod` field.
   *
   * Format: any DID-like string that embeds the signer's
   * Ethereum address (e.g. `did:ethr:0x<addr>#controller`).
   * The verifier extracts the 40-hex address and accepts a
   * recovered signature that matches either the issuer DID
   * address or this additional signer address.
   */
  additionalSignerVerificationMethod?: string;
}

/**
 * Sign an existing `DelegationCredential` with an
 * `EcdsaSecp256k1Signature2019` proof. Returns a new
 * `DelegationCredential` with the proof populated. Does
 * not write to disk — the caller can JSON.stringify and
 * store the result wherever they need.
 */
export function signDelegationCredential(
  credential: DelegationCredential,
  options: SignDelegationCredentialOptions,
): DelegationCredential {
  const body = buildDelegationSigningBody(credential);
  // IMPORTANT: use standard JSON.stringify (insertion order) NOT
  // canonicalizeDelegationJson (sorted keys). The verifier —
  // @terminal3/verify_vc → @terminal3/ecdsa_vc → verifyEcdsaVcSig —
  // uses JSON.stringify to serialize the proof-stripped VC before
  // hashing. If the signer used a different serialization (sorted
  // keys via canonicalizeDelegationJson) the byte-level JSON would
  // differ, the keccak256 hashes would differ, and the ECDSA
  // signature verification in T3_MODE=live would fail with
  // "unverified". The two serializations must produce byte-identical
  // output for the same logical payload.
  const serializedJson = JSON.stringify(body);
  const keccakOfJson = keccak_256(new TextEncoder().encode(serializedJson));
  const proofValue = eip191SignDelegation(
    keccakOfJson,
    options.privateKey,
    options.publicKey,
  );

  const primaryMethod = `${options.issuerDid}#key-1`;
  const verificationMethod = options.additionalSignerVerificationMethod
    ? `${primaryMethod} ${options.additionalSignerVerificationMethod}`
    : primaryMethod;

  return {
    ...credential,
    proof: {
      type: "EcdsaSecp256k1Signature2019",
      created: credential.issuanceDate,
      proofPurpose: "assertionMethod",
      verificationMethod,
      jws: proofValue,
    },
  };
}

export interface MintDelegationCredentialBody {
  /** Agent DID — the credentialSubject's identity. */
  agentDid: string;
  /** Maximum spend (USD) the delegation authorizes. */
  maxSpendUsd: number;
  /** Issuer DID. Defaults to the agent's own DID. */
  issuerDid?: string;
  /**
   * The trading-agent action scope the delegation authorizes.
   * Defaults to a conservative `agent.admit` + `intent.submit`
   * scope so a fresh VC never inherits a stale broad grant.
   */
  allowedActions?: DelegationActionScope[];
  /** Approver email (human-readable audit trail). */
  approverEmail?: string;
  /** Purpose string (human-readable audit trail). */
  purpose?: string;
  /** Optional negotiation mandate bound into the VC policy hash. */
  mandate?: NegotiationMandate;
  /** Validity period in months. Defaults to 6. */
  validityMonths?: number;
  /** Optional explicit credential ID. Defaults to `urn:uuid:ghostbroker-delegation-<ms>`. */
  id?: string;
}

export interface MintAndSignDelegationOptions
  extends MintDelegationCredentialBody {
  /** Issuer secp256k1 private key (0x-prefixed, 32 bytes). */
  issuerPrivateKey: string;
  /** Issuer 0x-prefixed 33-byte compressed secp256k1 public key. */
  issuerPublicKey: string;
}

/**
 * Convenience: build a fresh unsigned `DelegationCredential`
 * from a flat options bag. The `proof` field is omitted; call
 * `signDelegationCredential` (or `mintAndSignDelegationCredential`)
 * to populate it.
 */
export function mintDelegationCredentialBody(
  options: MintDelegationCredentialBody,
): DelegationCredential {
  const now = new Date();
  const created = now.toISOString();
  const expiration = new Date(now);
  expiration.setUTCMonth(
    expiration.getUTCMonth() + (options.validityMonths ?? 6),
  );

  const issuerDid = options.issuerDid ?? options.agentDid;
  return {
    id:
      options.id ??
      `urn:uuid:ghostbroker-delegation-${now.getTime()}`,
    type: ["VerifiableCredential", "GhostBrokerDelegation"],
    issuer: issuerDid,
    issuanceDate: created,
    expirationDate: expiration.toISOString(),
    credentialSubject: {
      id: issuerDid,
      agentDid: options.agentDid,
      maxSpendUsd: options.maxSpendUsd,
      allowedActions: options.allowedActions ?? ["agent.admit", "intent.submit"],
      approverEmail: options.approverEmail ?? "finance@acme.example",
      purpose:
        options.purpose ??
        "Q2 office refresh and team tooling within delegated limits",
      ...(options.mandate ? { mandate: options.mandate } : {}),
    },
  };
}

/**
 * Convenience: build a fresh W3C VC and sign it in one call.
 * Returns the signed `DelegationCredential`. Pure function —
 * no disk I/O. The caller can JSON.stringify the result and
 * hand it to the agent process, store it in a secrets manager,
 * or paste it into the `DELEGATION_CREDENTIAL` env var.
 */
export function mintAndSignDelegationCredential(
  options: MintAndSignDelegationOptions,
): DelegationCredential {
  const credential = mintDelegationCredentialBody(options);
  return signDelegationCredential(credential, {
    privateKey: options.issuerPrivateKey,
    publicKey: options.issuerPublicKey,
    issuerDid: options.issuerDid ?? options.agentDid,
  });
}

