import { randomBytes, createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  b64uDecodeStrict,
  ethRecoverEip191,
  buildInvocationPreimage,
  NONCE_LEN,
  REQUEST_HASH_LEN,
  VC_ID_LEN,
  AGENT_PUBKEY_LEN,
  buildDelegationCredential,
  canonicaliseCredential,
  validateCredentialBody,
} from "@terminal3/t3n-sdk";
import type { RequestedAction } from "./types.js";

/**
 * Options for building a delegation proof.
 */
export interface DelegationProofOptions {
  institutionId: string;
  agentDid: string;
  requestedAction: RequestedAction;
  policyHash: string;
  /** Base64url-encoded Terminal 3 delegation credential JCS bytes (exported from T3N Dashboard) */
  credentialJcsBase64: string;
  /** Admin's Ethereum private key (32 bytes) for signing the credential */
  adminPrivateKey: Uint8Array;
  /** Agent's secp256k1 private key (32 bytes) for signing the invocation */
  agentPrivateKey: Uint8Array;
  /** Optional recovered admin address. If not provided, recovered from the signature */
  recoveredUserAddress?: string;
}

/**
 * The signed delegation proof object.
 */
export interface SignedDelegationProof {
  version: "ghostbroker.delegation-proof/1";
  credentialJcs: string;
  userSignature: string;
  recoveredUserAddress: string;
  agentSignature: string;
  nonce: string;
  requestHash: string;
  request: {
    institutionId: string;
    agentDid: string;
    requestedAction: RequestedAction;
    policyHash: string;
  };
}

/** Encode bytes to base64url. */
function b64uEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode base64url and verify expected byte length. */
function decodeBase64Url(value: string, expectedLength: number): Uint8Array {
  const bytes = b64uDecodeStrict(value);
  if (bytes.byteLength !== expectedLength) {
    throw new Error(
      `Expected ${expectedLength} bytes but got ${bytes.byteLength} from base64url decode.`,
    );
  }
  return bytes;
}

/**
 * Hash a message with SHA-256 and return bytes.
 */
function sha256Bytes(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

/**
 * Canonicalize an object for deterministic hashing.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * EIP-191 personal_sign hash: keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)
 *
 * Uses keccak256 to match the @terminal3/t3n-sdk's ethRecoverEip191 which follows
 * the Ethereum convention.
 */
function personalSignHash(message: Uint8Array): Uint8Array {
  const prefix = `\x19Ethereum Signed Message:\n${message.length}`;
  const prefixed = new Uint8Array(prefix.length + message.length);
  prefixed.set(new TextEncoder().encode(prefix), 0);
  prefixed.set(message, prefix.length);

  return keccak_256(prefixed);
}

/**
 * Sign a message using EIP-191 personal_sign scheme with secp256k1.
 *
 * Produces a 65-byte signature: 32 bytes r || 32 bytes s || 1 byte v (recovery + 27).
 * Compatible with ethRecoverEip191 from @terminal3/t3n-sdk.
 */
function ethSignEip191(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const hash = personalSignHash(message);
  const sig = secp256k1.sign(hash, privateKey) as unknown as {
    r: bigint;
    s: bigint;
    recovery: number;
  };

  const signature = new Uint8Array(65);
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  signature.set(Buffer.from(rHex, "hex"), 0);
  signature.set(Buffer.from(sHex, "hex"), 32);
  signature[64] = sig.recovery + 27;

  return signature;
}

/**
 * Wire format for the delegation credential as exported by the T3N Dashboard.
 */
interface WireDelegationCredential {
  v: string;
  user_did: string;
  agent_pubkey: string;
  org_did: string;
  contract: string;
  functions: string[];
  scopes: string[];
  metadata: Record<string, string>;
  not_before_secs: string;
  not_after_secs: string;
  vc_id: string;
}

/**
 * Parse a credential JCS JSON string into a built DelegationCredential.
 * Matches the pattern in t3-enclave/src/auth/delegation-credential.ts.
 */
function parseCredential(credentialJcs: Uint8Array) {
  const text = new TextDecoder().decode(credentialJcs);
  const wire = JSON.parse(text) as WireDelegationCredential;
  return buildDelegationCredential({
    user_did: wire.user_did,
    agent_pubkey: decodeBase64Url(wire.agent_pubkey, AGENT_PUBKEY_LEN),
    org_did: wire.org_did,
    contract: wire.contract,
    functions: wire.functions,
    scopes: wire.scopes,
    metadata: wire.metadata,
    not_before_secs: BigInt(wire.not_before_secs),
    not_after_secs: BigInt(wire.not_after_secs),
    vc_id: decodeBase64Url(wire.vc_id, VC_ID_LEN),
  });
}

/**
 * Builds a signed GhostBroker delegation proof.
 *
 * This proof is used in the `authorityProof` field of `POST /api/agents/admit`.
 * The embedded signatures use EIP-191 (keccak256-based) for the user signature
 * and secp256k1 for the agent invocation signature, matching the server-side
 * verification in t3-enclave/src/auth/delegation-credential.ts.
 */
export class DelegationProofBuilder {
  /**
   * Build a complete delegation proof.
   */
  public static async build(options: DelegationProofOptions): Promise<SignedDelegationProof> {
    const request = {
      institutionId: options.institutionId,
      agentDid: options.agentDid,
      requestedAction: options.requestedAction,
      policyHash: options.policyHash,
    };

    // Hash the canonical request binding
    const requestHash = sha256Bytes(canonicalize(request));

    // Generate a nonce for replay protection
    const nonce = randomBytes(NONCE_LEN);

    // Decode and parse the credential JCS
    const credentialJcsBytes = b64uDecodeStrict(options.credentialJcsBase64);
    const credentialParsed = parseCredential(credentialJcsBytes);
    const canonicalCredential = canonicaliseCredential(credentialParsed);
    validateCredentialBody(credentialParsed);

    // Extract VC ID from parsed credential for invocation preimage
    const vcId = credentialParsed.vc_id as unknown as Uint8Array;

    // Sign credential with admin key using EIP-191 (keccak256-based)
    const userSignature = ethSignEip191(canonicalCredential, options.adminPrivateKey);

    // Recover admin address from the signature
    const recoveredBytes = ethRecoverEip191(canonicalCredential, userSignature);
    const recoveredUserAddress =
      options.recoveredUserAddress ??
      `0x${Buffer.from(recoveredBytes).toString("hex").toLowerCase()}`;

    // Build invocation preimage: SHA256(vc_id || nonce || requestHash)
    const preimage = buildInvocationPreimage(vcId, nonce, requestHash);

    // Sign with agent key (secp256k1) — 64-byte compact signature
    const agentSig = secp256k1.sign(preimage, options.agentPrivateKey) as unknown as {
      toCompactRawBytes: () => Uint8Array;
    };
    const agentSignature = agentSig.toCompactRawBytes();

    return {
      version: "ghostbroker.delegation-proof/1",
      credentialJcs: options.credentialJcsBase64,
      userSignature: b64uEncode(userSignature),
      recoveredUserAddress,
      agentSignature: b64uEncode(agentSignature),
      nonce: b64uEncode(nonce),
      requestHash: b64uEncode(requestHash),
      request,
    };
  }

  /**
   * Serialize a delegation proof to a JSON string for use in API calls.
   */
  public static serialize(proof: SignedDelegationProof): string {
    return JSON.stringify(proof);
  }
}
