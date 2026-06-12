import { createHash, timingSafeEqual } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { z } from "zod";
import {
  AGENT_PUBKEY_LEN,
  ETH_SIG_LEN,
  NONCE_LEN,
  REQUEST_HASH_LEN,
  VC_ID_LEN,
  b64uDecodeStrict,
  buildDelegationCredential,
  buildInvocationPreimage,
  canonicaliseCredential,
  ethRecoverEip191,
  validateCredentialBody,
  type DelegationCredential,
} from "@terminal3/t3n-sdk";
import type { RequestedAgentAction } from "./agent-auth-client.js";

export const ghostBrokerDelegationProofVersion =
  "ghostbroker.delegation-proof/1";

const delegatedActionSchema = z.enum([
  "agent.admit",
  "intent.submit",
  "settlement.execute",
]);

const proofRequestSchema = z.object({
  institutionId: z.string().uuid(),
  agentDid: z.string().min(1),
  requestedAction: delegatedActionSchema,
  policyHash: z.string().min(1),
});

const signedDelegationProofSchema = z.object({
  version: z.literal(ghostBrokerDelegationProofVersion),
  credentialJcs: z.string().min(1),
  userSignature: z.string().min(1),
  agentSignature: z.string().min(1),
  nonce: z.string().min(1),
  requestHash: z.string().min(1),
  request: proofRequestSchema,
  recoveredUserAddress: z.string().regex(/^0x[0-9a-f]{40}$/iu).optional(),
});

export type SignedDelegationProof = z.infer<typeof signedDelegationProofSchema>;

export type DelegationProofFailure =
  | "expired"
  | "revoked"
  | "over_scoped"
  | "unverified";

export interface DelegationProofVerificationRequest {
  authorityProof: string;
  institutionId: string;
  agentDid: string;
  requestedAction: RequestedAgentAction;
  now?: Date;
  revokedAuthorityRefs?: ReadonlySet<string>;
}

export interface VerifiedDelegationProof {
  status: "verified";
  agentDid: string;
  authorityRef: string;
  policyHash: string;
}

export interface RejectedDelegationProof {
  status: "rejected";
  agentDid: string;
  reason: DelegationProofFailure;
}

export type DelegationProofVerificationResult =
  | VerifiedDelegationProof
  | RejectedDelegationProof;

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

function sha256Bytes(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function decodeBase64Url(value: string, expectedLength: number): Uint8Array {
  const bytes = b64uDecodeStrict(value);

  if (bytes.byteLength !== expectedLength) {
    throw new Error("Encoded delegation field had an unexpected length.");
  }

  return bytes;
}

function parseCredential(credentialJcs: Uint8Array): DelegationCredential {
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

function authorityRefFor(credential: DelegationCredential): string {
  return `t3-delegation:${Buffer.from(credential.vc_id).toString("base64url")}`;
}

function rejection(
  request: Pick<DelegationProofVerificationRequest, "agentDid">,
  reason: DelegationProofFailure,
): RejectedDelegationProof {
  return {
    status: "rejected",
    agentDid: request.agentDid,
    reason,
  };
}

function verifyCredentialScope(
  credential: DelegationCredential,
  proof: SignedDelegationProof,
  request: DelegationProofVerificationRequest,
): DelegationProofFailure | undefined {
  if (
    proof.request.institutionId !== request.institutionId ||
    proof.request.agentDid !== request.agentDid ||
    proof.request.requestedAction !== request.requestedAction
  ) {
    return "over_scoped";
  }

  if (!credential.functions.includes(request.requestedAction)) {
    return "over_scoped";
  }

  if (
    credential.metadata.institution_id !== request.institutionId ||
    credential.metadata.agent_did !== request.agentDid ||
    credential.metadata.policy_hash !== proof.request.policyHash
  ) {
    return "over_scoped";
  }

  return undefined;
}

function verifyCredentialWindow(
  credential: DelegationCredential,
  now: Date,
): DelegationProofFailure | undefined {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));

  if (nowSeconds < credential.not_before_secs) {
    return "expired";
  }

  if (nowSeconds > credential.not_after_secs) {
    return "expired";
  }

  return undefined;
}

function verifySignatures(
  credential: DelegationCredential,
  credentialJcs: Uint8Array,
  proof: SignedDelegationProof,
): boolean {
  const userSignature = decodeBase64Url(proof.userSignature, ETH_SIG_LEN);
  const recoveredUserAddress = ethRecoverEip191(credentialJcs, userSignature);
  const expectedUserAddress =
    proof.recoveredUserAddress ?? credential.metadata.user_eth_address;

  if (!expectedUserAddress) {
    return false;
  }

  const expected = Buffer.from(expectedUserAddress.replace(/^0x/iu, ""), "hex");

  if (!equalBytes(recoveredUserAddress, expected)) {
    return false;
  }

  const nonce = decodeBase64Url(proof.nonce, NONCE_LEN);
  const requestHash = decodeBase64Url(proof.requestHash, REQUEST_HASH_LEN);
  const agentSignature = decodeBase64Url(proof.agentSignature, 64);
  const preimage = buildInvocationPreimage(
    credential.vc_id,
    nonce,
    requestHash,
  );

  return secp256k1.verify(agentSignature, preimage, credential.agent_pubkey);
}

export function createDelegationRequestHash(
  request: SignedDelegationProof["request"],
): Uint8Array {
  return sha256Bytes(canonicalize(request));
}

export function verifySignedDelegationProof(
  request: DelegationProofVerificationRequest,
): DelegationProofVerificationResult {
  try {
    const proof = signedDelegationProofSchema.parse(
      JSON.parse(request.authorityProof),
    );
    const credentialJcs = b64uDecodeStrict(proof.credentialJcs);
    const credential = parseCredential(credentialJcs);
    const canonicalCredential = canonicaliseCredential(credential);
    const expectedRequestHash = createDelegationRequestHash(proof.request);
    const suppliedRequestHash = decodeBase64Url(
      proof.requestHash,
      REQUEST_HASH_LEN,
    );
    const authorityRef = authorityRefFor(credential);

    validateCredentialBody(credential);

    if (!equalBytes(canonicalCredential, credentialJcs)) {
      return rejection(request, "unverified");
    }

    if (!equalBytes(expectedRequestHash, suppliedRequestHash)) {
      return rejection(request, "unverified");
    }

    const scopeFailure = verifyCredentialScope(credential, proof, request);
    if (scopeFailure) {
      return rejection(request, scopeFailure);
    }

    const windowFailure = verifyCredentialWindow(
      credential,
      request.now ?? new Date(),
    );
    if (windowFailure) {
      return rejection(request, windowFailure);
    }

    if (request.revokedAuthorityRefs?.has(authorityRef)) {
      return rejection(request, "revoked");
    }

    if (!verifySignatures(credential, credentialJcs, proof)) {
      return rejection(request, "unverified");
    }

    return {
      status: "verified",
      agentDid: request.agentDid,
      authorityRef,
      policyHash: proof.request.policyHash,
    };
  } catch {
    return rejection(request, "unverified");
  }
}
