import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  b64uEncodeBytes,
  buildDelegationCredential,
  buildInvocationPreimage,
  canonicaliseCredential,
  signAgentInvocation,
  signCredential,
} from "@terminal3/t3n-sdk";
import {
  createDelegationRequestHash,
  ghostBrokerDelegationProofVersion,
  verifySignedDelegationProof,
} from "../auth/delegation-credential.js";

const institutionId = "00000000-0000-4000-8000-000000000101";
const agentDid = "did:t3n:agent:us1-authorized";
const userDid = `did:t3n:${"a".repeat(40)}`;
const orgDid = `did:t3n:${"b".repeat(40)}`;
const policyHash = "policy:ghostbroker:us1";
const userPrivateKey = new Uint8Array(32).fill(0x11);
const agentPrivateKey = new Uint8Array(32).fill(0x22);

function hexLower(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function buildSignedAuthorityProof(
  overrides: {
    functions?: string[];
    notBeforeSecs?: bigint;
    notAfterSecs?: bigint;
    institutionId?: string;
    agentDid?: string;
    requestedAction?: "agent.admit" | "intent.submit" | "settlement.execute";
    policyHash?: string;
  } = {},
): string {
  const request = {
    institutionId: overrides.institutionId ?? institutionId,
    agentDid: overrides.agentDid ?? agentDid,
    requestedAction: overrides.requestedAction ?? "agent.admit",
    policyHash: overrides.policyHash ?? policyHash,
  };
  const vcId = new Uint8Array(16).fill(1);
  const nonce = new Uint8Array(16).fill(2);
  const credential = buildDelegationCredential({
    user_did: userDid,
    agent_pubkey: secp256k1.getPublicKey(agentPrivateKey, true),
    org_did: orgDid,
    contract: "ghostbroker.darkpool",
    functions: overrides.functions ?? ["agent.admit"],
    scopes: [],
    metadata: {
      institution_id: request.institutionId,
      agent_did: request.agentDid,
      policy_hash: request.policyHash,
    },
    not_before_secs: overrides.notBeforeSecs ?? 1n,
    not_after_secs: overrides.notAfterSecs ?? 4_102_444_800n,
    vc_id: vcId,
  });
  const credentialJcs = canonicaliseCredential(credential);
  const userSignature = signCredential(credentialJcs, userPrivateKey);
  const requestHash = createDelegationRequestHash(request);
  const preimage = buildInvocationPreimage(vcId, nonce, requestHash);
  const agentSignature = signAgentInvocation(
    preimage,
    agentPrivateKey,
  );

  return JSON.stringify({
    version: ghostBrokerDelegationProofVersion,
    credentialJcs: b64uEncodeBytes(credentialJcs),
    userSignature: b64uEncodeBytes(userSignature.sig),
    recoveredUserAddress: hexLower(userSignature.addr),
    agentSignature: b64uEncodeBytes(agentSignature),
    nonce: b64uEncodeBytes(nonce),
    requestHash: b64uEncodeBytes(requestHash),
    request,
  });
}

describe("signed delegation proof verification", () => {
  it("verifies a signed GhostBroker agent admission delegation proof", () => {
    const result = verifySignedDelegationProof({
      authorityProof: buildSignedAuthorityProof(),
      institutionId,
      agentDid,
      requestedAction: "agent.admit",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "verified",
      agentDid,
      authorityRef: "t3-delegation:AQEBAQEBAQEBAQEBAQEBAQ",
      policyHash,
    });
  });

  it("rejects proofs scoped to a different action", () => {
    const result = verifySignedDelegationProof({
      authorityProof: buildSignedAuthorityProof({
        functions: ["intent.submit"],
        requestedAction: "intent.submit",
      }),
      institutionId,
      agentDid,
      requestedAction: "agent.admit",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "rejected",
      agentDid,
      reason: "over_scoped",
    });
  });

  it("rejects expired delegation proofs", () => {
    const result = verifySignedDelegationProof({
      authorityProof: buildSignedAuthorityProof({
        notBeforeSecs: 1n,
        notAfterSecs: 2n,
      }),
      institutionId,
      agentDid,
      requestedAction: "agent.admit",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "rejected",
      agentDid,
      reason: "expired",
    });
  });

  it("rejects tampered request hashes", () => {
    const proof = JSON.parse(buildSignedAuthorityProof()) as {
      requestHash: string;
    };
    proof.requestHash = b64uEncodeBytes(new Uint8Array(32).fill(9));

    const result = verifySignedDelegationProof({
      authorityProof: JSON.stringify(proof),
      institutionId,
      agentDid,
      requestedAction: "agent.admit",
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "rejected",
      agentDid,
      reason: "unverified",
    });
  });

  it("rejects explicitly revoked authority references", () => {
    const result = verifySignedDelegationProof({
      authorityProof: buildSignedAuthorityProof(),
      institutionId,
      agentDid,
      requestedAction: "agent.admit",
      now: new Date("2026-06-12T00:00:00.000Z"),
      revokedAuthorityRefs: new Set([
        "t3-delegation:AQEBAQEBAQEBAQEBAQEBAQ",
      ]),
    });

    expect(result).toEqual({
      status: "rejected",
      agentDid,
      reason: "revoked",
    });
  });
});
