import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { eth_get_address } from "@terminal3/t3n-sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import { readIdentity, type AgentIdentityRecord } from "./identity.js";

/**
 * W3C Verifiable Credential — ported from Ghostbroker delegation's
 * `src/auth/delegation.ts` and `src/scripts/setup-delegation.ts`.
 *
 * The Ghostbroker delegation BUIDL models the delegation as a standard W3C VC
 * with `issuer`, `credentialSubject`, and a `proof.jws` field. The
 * GhostVerifier (in t3-enclave) does not speak this shape — that
 * verifier was built for the T3 Smart VC `buildDelegationCredential`
 * format. The Ghostbroker delegation format is what the only published live
 * reference implementation actually mints, so the agent side
 * produces and consumes this shape end-to-end. The backend admit
 * path that consumes it lives in the GhostBroker backend
 * (`POST /api/agents/admit` with a `delegationCredential` field).
 */

const purchaseCategorySchema = z.enum([
  "office-supplies",
  "software",
  "hardware",
  "services",
  "travel",
]);

export const delegationSchema = z.object({
  id: z.string(),
  type: z.array(z.string()),
  issuer: z.string(),
  issuanceDate: z.string(),
  expirationDate: z.string(),
  credentialSubject: z.object({
    id: z.string(),
    agentDid: z.string(),
    maxSpendUsd: z.number().positive(),
    allowedCategories: z.array(purchaseCategorySchema).min(1),
    approverEmail: z.string().email().optional(),
    purpose: z.string(),
  }),
  proof: z
    .object({
      type: z.string(),
      created: z.string(),
      proofPurpose: z.string(),
      verificationMethod: z.string(),
      jws: z.string().optional(),
    })
    .optional(),
});

export type DelegationCredential = z.infer<typeof delegationSchema>;

const DEFAULT_DELEGATION_PATH = "output/delegations/agent_delegation.json";

function parseArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function isSandboxDid(did: string | undefined): boolean {
  return !did || did.includes("sandbox") || did.includes("REPLACE_WITH");
}

function resolveUserDidFromEnv(apiKey: string | undefined): string {
  const fromEnv = process.env.USER_DID?.trim();
  if (fromEnv && !isSandboxDid(fromEnv)) {
    return fromEnv;
  }
  if (!apiKey || apiKey.startsWith("your-")) {
    throw new Error(
      "Set USER_DID or T3N_API_KEY in .env (claim key from https://www.terminal3.io/claim-page).",
    );
  }
  const address = eth_get_address(apiKey);
  return `did:t3n:${address.slice(2).toLowerCase()}`;
}

function resetLocalSpendTracking(delegationId: string, spendDir: string): void {
  const safe = delegationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = join(spendDir, `${safe}.json`);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Deterministic JSON serialization. Object keys are sorted
 * recursively so the bytes signed by the issuer and verified
 * by `@terminal3/verify_vc` are bit-identical. Matches the
 * EIP-191 / `ethers.verifyMessage` flow:
 *
 *   h1 = keccak256(canonicalJson)
 *   digest = keccak256("\x19Ethereum Signed Message:\n32" || h1)
 *   sig = secp256k1.sign(digest, privateKey)
 *
 * The verifier (`@terminal3/verify_vc`'s `verifyEcdsaVc`) does
 * the inverse: `ethers.verifyMessage(h1, sig)` recovers the
 * address, then checks `proof.verificationMethod.includes(addr)`.
 */
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalizeJson(child)}`)
    .join(",")}}`;
}

/**
 * Strip the `proof` field for signing — `@terminal3/verify_vc`'s
 * `verifyEcdsaVc` signs the VC body without the proof and
 * verifies by recovering the address from the proofValue. The
 * rest of the canonicalization matches what `verify_vc_core`
 * re-serializes in the same way (sorted keys, no whitespace).
 */
function delegationBodyForSigning(
  credential: DelegationCredential,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
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
  return body;
}

function eip191Sign(
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
  const expectedPubKey = Uint8Array.from(
    Buffer.from(expectedPublicKeyHex.slice(2), "hex"),
  );
  if (expectedPubKey.length !== 33) {
    throw new Error(
      "expected public key must decode to exactly 33 compressed secp256k1 bytes.",
    );
  }
  const privateKeyBytes = Uint8Array.from(
    Buffer.from(privateKeyHex.slice(2), "hex"),
  );
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
  // JWS blob, where recid is the LAST byte and `r || s`
  // occupies the first 64). We split the 65-byte form to
  // extract the 64-byte compact r||s, then try both
  // Ethereum-style recids 0/1 (EIP-191 parity outcomes) by
  // appending the recid to the compact r||s and asking
  // `recoverPublicKey` whether the recovered pubkey matches
  // the expected one.
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
  // v2 layout: recid at index 0, r || s at indices 1..64.
  const rBytes = sigBytes.subarray(1, 33);
  const sBytes = sigBytes.subarray(33, 65);

  // Try both Ethereum-style parities 0/1 (the only two
  // outcomes our signer could have produced for any given
  // message) and pick the one whose recovered public key
  // matches the expected compressed pubkey. We pass
  // `(sig65, msg, {prehash: false})` where sig65 is the
  // v1/v2-style 65-byte form (recid FIRST byte) because
  // that's the shape `recoverPublicKey` reads.
  for (const recid of [0, 1] as const) {
    const sig65 = new Uint8Array(65);
    sig65[0] = recid;
    sig65.set(rBytes, 1);
    sig65.set(sBytes, 33);
    const recovered = secp256k1.recoverPublicKey(sig65, digest, {
      prehash: false,
    });
    if (
      Buffer.from(recovered).toString("hex") ===
      Buffer.from(expectedPubKey).toString("hex")
    ) {
      const out = new Uint8Array(65);
      out.set(rBytes, 0);
      out.set(sBytes, 32);
      out[64] = 27 + recid;
      return `0x${Buffer.from(out).toString("hex")}`;
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

export interface SignDelegationOptions {
  /** The issuer's 0x-prefixed secp256k1 private key (66 chars). */
  privateKey: string;
  /**
   * The issuer's 0x-prefixed 33-byte compressed secp256k1
   * public key (66 chars). Used to derive the EIP-191
   * recovery byte. If you don't have the public key on hand,
   * derive it from `privateKey` via
   * `secp256k1.getPublicKey(privateKey, true)`.
   */
  publicKey: string;
  /** The issuer's `did:t3n:0x...` identifier; must include the address derived from `privateKey`. */
  issuerDid: string;
  /** Whether to write the signed VC to disk. Defaults to true. */
  writeToPath?: string;
}

/**
 * Sign an existing `DelegationCredential` with an
 * `EcdsaSecp256k1Signature2019` proof so the GhostBroker-style
 * verifier can run in `live` mode (`@terminal3/verify_vc`'s
 * `verifyEcdsaVc` path).
 *
 * The produced `proof.proofValue` is the EIP-191 personal_sign
 * signature over `keccak256(canonicalJson(credential without proof))`,
 * serialised as the standard 65-byte `r || s || v` blob. The
 * `verificationMethod` is `${issuerDid}#key-1`; the verifier
 * checks `verificationMethod.includes(recoveredAddress)`, so
 * the `issuerDid` MUST contain the address derived from
 * `privateKey` (e.g. `did:t3n:0xabc...`).
 */
export function signDelegationCredential(
  credential: DelegationCredential,
  options: SignDelegationOptions,
): DelegationCredential {
  const body = delegationBodyForSigning(credential);
  const canonicalJson = canonicalizeJson(body);
  const keccakOfJson = keccak_256(new TextEncoder().encode(canonicalJson));
  const proofValue = eip191Sign(
    keccakOfJson,
    options.privateKey,
    options.publicKey,
  );

  const signed: DelegationCredential = {
    ...credential,
    proof: {
      type: "EcdsaSecp256k1Signature2019",
      created: credential.issuanceDate,
      proofPurpose: "assertionMethod",
      verificationMethod: `${options.issuerDid}#key-1`,
      jws: proofValue,
    },
  };

  if (options.writeToPath) {
    writeFileSync(
      options.writeToPath,
      `${JSON.stringify(signed, null, 2)}\n`,
      "utf8",
    );
  }
  return signed;
}

export interface MintAndSignDelegationOptions extends MintDelegationOptions {
  /** Issuer secp256k1 private key (0x-prefixed, 32 bytes). */
  issuerPrivateKey: string;
  /** Issuer 0x-prefixed 33-byte compressed secp256k1 public key. */
  issuerPublicKey: string;
  /**
   * Optional explicit issuer DID. Defaults to the DID derived
   * from `apiKey` / `userDid` in `mintDelegationCredential`.
   * Must contain the address derived from `issuerPrivateKey`.
   */
  issuerDid?: string;
}

/**
 * Convenience: mint a fresh `DelegationCredential` and sign it
 * in one call. The on-disk VC is the *signed* one — the
 * placeholder `live-demo-unsigned` marker is never written.
 */
export function mintAndSignDelegationCredential(
  options: MintAndSignDelegationOptions,
): { path: string; credential: DelegationCredential } {
  // `mintDelegationCredential` requires a userDid; pass the
  // resolved `issuerDid` through so it doesn't fall through
  // to the env-var lookup. The signing key + issuer DID pair
  // is the source of truth here.
  const { path, credential } = mintDelegationCredential({
    ...options,
    issuerDid: options.issuerDid,
  });
  const issuerDid = options.issuerDid ?? credential.issuer;
  const signed = signDelegationCredential(credential, {
    privateKey: options.issuerPrivateKey,
    publicKey: options.issuerPublicKey,
    issuerDid,
    writeToPath: path,
  });
  return { path, credential: signed };
}

export interface MintDelegationOptions {
  apiKey?: string;
  userDid?: string;
  /**
   * Optional explicit issuer DID. When provided, this is
   * used verbatim as the credential `issuer` and the
   * `credentialSubject.id`, and `apiKey` / `userDid` are
   * ignored. The signer (`signDelegationCredential`) is
   * responsible for ensuring the issuer DID contains the
   * address derived from the signing key.
   */
  issuerDid?: string;
  agentDid: string;
  maxSpendUsd: number;
  outputPath?: string;
  spendDir?: string;
  allowedCategories?: string[];
  purpose?: string;
  approverEmail?: string;
}

export function mintDelegationCredential(options: MintDelegationOptions): {
  path: string;
  credential: DelegationCredential;
} {
  const now = new Date();
  const created = now.toISOString();
  const expiration = new Date(now);
  expiration.setUTCMonth(expiration.getUTCMonth() + 6);

  const userDid =
    options.issuerDid ?? options.userDid ?? resolveUserDidFromEnv(options.apiKey);

  const credential: DelegationCredential = {
    id: `urn:uuid:ghostbroker-delegation-${now.getTime()}`,
    type: ["VerifiableCredential", "GhostBrokerDelegation"],
    issuer: userDid,
    issuanceDate: created,
    expirationDate: expiration.toISOString(),
    credentialSubject: {
      id: userDid,
      agentDid: options.agentDid,
      maxSpendUsd: options.maxSpendUsd,
      allowedCategories: (options.allowedCategories ?? ["office-supplies", "software"]) as (
        | "office-supplies"
        | "software"
        | "hardware"
        | "services"
        | "travel"
      )[],
      approverEmail: options.approverEmail ?? "finance@acme.example",
      purpose: options.purpose ?? "Q2 office refresh and team tooling within delegated limits",
    },
    // The `proof` field is intentionally omitted. This
    // function mints the unsigned VC body; signing is done
    // by `signDelegationCredential` / `mintAndSignDelegationCredential`
    // in a follow-up call. Writing a placeholder proof (as
    // the previous implementation did) caused the live
    // verifier to reject the credential; omitting the field
    // here means the on-disk file is always the signed one
    // when produced via the standard `setup:delegation` flow.
  };

  const path = options.outputPath ?? DEFAULT_DELEGATION_PATH;
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
  if (options.spendDir) {
    resetLocalSpendTracking(credential.id, options.spendDir);
  }
  return { path, credential };
}

export function loadDelegationCredential(path: string): DelegationCredential {
  if (!existsSync(path)) {
    throw new Error(
      `Delegation credential not found at ${path}. Run setup:delegation first.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return delegationSchema.parse(raw);
}

export function isDelegationActive(
  credential: DelegationCredential,
  now = new Date(),
): boolean {
  const issued = new Date(credential.issuanceDate);
  const expires = new Date(credential.expirationDate);
  return now >= issued && now <= expires;
}

export function delegationSummary(credential: DelegationCredential): string {
  const { credentialSubject: subject } = credential;
  return [
    `Issuer: ${credential.issuer}`,
    `Agent: ${subject.agentDid}`,
    `Budget: $${subject.maxSpendUsd.toFixed(2)}`,
    `Categories: ${subject.allowedCategories.join(", ")}`,
    `Valid until: ${credential.expirationDate}`,
    `Purpose: ${subject.purpose}`,
  ].join("\n");
}

/**
 * CLI: `npm run setup:delegation -- --max-spend 50000 --output path`
 * Resolves the agent DID from the identity file, mints a fresh
 * W3C VC, and signs it with the agent's own secp256k1 key.
 *
 * For the demo / sandbox identity flow the agent itself is
 * the issuer of its own delegation VC. This is consistent with
 * the T3N-onboarding constraint: T3 gives you a developer key
 * + `did:t3n:0x...` + test tokens and that's it. There is no
 * out-of-band "data owner" to issue the delegation on the
 * operator's behalf, so the agent self-issues a single
 * bounded-credential VC that the verifier can cryptographically
 * check. The proof type is
 * `EcdsaSecp256k1Signature2019` so
 * `@terminal3/verify_vc`'s `verifyEcdsaVc` path can recover
 * the address and confirm it matches the issuer DID.
 *
 * `--issuer` is accepted for completeness (a future "real
 * data owner" flow); when omitted, the agent's own DID is
 * used.
 */
export function runSetupDelegationCli(): void {
  const identityPath =
    parseArg("--identity-path") ?? process.env.AGENT_IDENTITY_CONFIG_PATH ?? "output/identities/agent_identity.json";
  const identity: AgentIdentityRecord = readIdentity(identityPath);

  const outputPath = parseArg("--output") ?? process.env.DELEGATION_CREDENTIAL_PATH;
  const maxSpendRaw = parseArg("--max-spend");
  const maxSpendUsd = maxSpendRaw ? Number(maxSpendRaw) : 50_000;

  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) {
    throw new Error("--max-spend must be a positive number.");
  }

  const explicitIssuer = parseArg("--issuer");
  const issuerDid = explicitIssuer ?? identity.did;
  const issuerPrivateKey = identity.privateKey;
  const issuerPublicKey = identity.publicKey;

  const { path, credential } = mintAndSignDelegationCredential({
    agentDid: identity.did,
    maxSpendUsd,
    issuerPrivateKey,
    issuerPublicKey,
    issuerDid,
    ...(outputPath ? { outputPath } : {}),
    spendDir: process.env.AUDIT_OUTPUT_DIR ?? "output",
  });

  console.log("=== Delegation credential created ===");
  console.log(`Output: ${path}`);
  console.log(`Issuer (signer): ${credential.issuer}`);
  console.log(`Agent: ${credential.credentialSubject.agentDid}`);
  console.log(`Budget: $${maxSpendUsd.toFixed(2)}`);
  console.log("");
  console.log("Proof is a real EcdsaSecp256k1Signature2019 JWS over the");
  console.log("canonical credential body. The GhostBroker-side verifier");
  console.log("(@terminal3/verify_vc) can recover the issuer address and");
  console.log("confirm it matches proof.verificationMethod.");
  console.log("");
  console.log("Add to .env if not already set:");
  console.log(`USER_DID=${credential.issuer}`);
  console.log(`AGENT_DID=${credential.credentialSubject.agentDid}`);
  console.log(`DELEGATION_CREDENTIAL_PATH=${path.replace(/\\/g, "/")}`);
}
