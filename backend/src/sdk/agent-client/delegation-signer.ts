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
 *   2. calls `ethers.verifyMessage(digest, signature)`,
 *      which applies the EIP-191 personal_sign prefix
 *      internally, keccak256s the result, and recovers an
 *      Ethereum address,
 *   3. checks `proof.verificationMethod.includes(recoveredAddress)`.
 *
 * So we sign exactly the same digest with the EIP-191 prefix
 * pre-applied, and emit the standard 65-byte `r || s || v` blob
 * (with `v = 27 + recid`) in `proof.proofValue`.
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
 * Sign a 32-byte keccak256 hash with EIP-191 personal_sign
 * and return the 65-byte `r || s || v` blob (`v = 27 + recid`).
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

  // EIP-191 personal_sign over a 32-byte payload:
  //   digest = keccak256("\x19Ethereum Signed Message:\n32" || payload)
  const prefix = new TextEncoder().encode(
    "\x19Ethereum Signed Message:\n32",
  );
  const prefixed = new Uint8Array(prefix.length + keccakOfJson.length);
  prefixed.set(prefix, 0);
  prefixed.set(keccakOfJson, prefix.length);
  const digest = keccak_256(prefixed);

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

  return {
    ...credential,
    proof: {
      type: "EcdsaSecp256k1Signature2019",
      created: credential.issuanceDate,
      proofPurpose: "assertionMethod",
      verificationMethod: `${options.issuerDid}#key-1`,
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

