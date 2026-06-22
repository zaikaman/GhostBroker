import { createHash } from "node:crypto";
import {
  mintTenantDelegation,
  type TenantDelegationPolicy,
} from "../enclave/index.js";
import type { DelegationCredential } from "../sdk/agent-client/index.js";
import type { SdkDelegationEnvelope } from "../enclave/auth/sdk-delegation-signer.js";
import { PublicError } from "../errors/public-error.js";
import type { TenantIdentity } from "../enclave/index.js";
import type { NegotiationMandateInput } from "../models/negotiation.js";

/**
 * Backend-side wrapper around the t3-enclave tenant
 * delegation signer. Lives in the backend (not the
 * t3-enclave) so the backend can hold the `TenantIdentity`
 * - the file-backed secp256k1 keypair + DID that the
 * signer uses - without having to plumb the t3-enclave
 * session around every call site.
 *
 * The signer is constructed once at backend boot, after
 * the T3N handshake + the `loadOrCreateTenantIdentity()`
 * call in `app.ts`. Routes get it through the
 * `BackendServices` bag.
 */
export interface TenantDelegationSigner {
  /**
   * Mint a fresh W3C VC delegation credential signed by
   * the institution's tenant keypair. Returns the signed
   * credential, a stable `policyHash` for downstream
   * equality checks (the `policyHash` matches the one the
   * backend's verifier produces on the same VC, so the
   * orchestrator can assert the two agree), and an optional
   * `sdkEnvelope` carrying the SDK-native delegation
   * artifact for on-chain revocation.
   */
  mint(policy: TenantDelegationPolicy & {
    mandate?: NegotiationMandateInput;
  }): Promise<{
    credential: DelegationCredential;
    policyHash: string;
    sdkEnvelope?: SdkDelegationEnvelope;
  }>;
}

export class BackendTenantDelegationSigner implements TenantDelegationSigner {
  private readonly identity: TenantIdentity;

  public constructor(identity: TenantIdentity) {
    this.identity = identity;
    if (
      !identity.did.startsWith("did:") ||
      !identity.publicKey.startsWith("0x") ||
      !identity.privateKey.startsWith("0x")
    ) {
      throw new PublicError("service_unavailable", 503);
    }
  }

  public async mint(
    policy: TenantDelegationPolicy,
  ): Promise<{ credential: DelegationCredential; policyHash: string; sdkEnvelope?: SdkDelegationEnvelope }> {
    const result = mintTenantDelegation(policy, this.identity);
    // The policy hash the backend reports to the agent
    // (and persists in `agents.policy_hash`) is the same
    // sha256-canonical-JSON fingerprint the verifier
    // computes - see
    // `t3-enclave/src/auth/ghostbroker-delegation.ts`'s
    // `policyHashFor`. We re-implement it here so we
    // don't have to round-trip through the verifier just
    // to get the hash; the bytes are byte-identical for
    // the same credential.
    const policyHash = computePolicyHash(result.credential);
    return {
      credential: result.credential,
      policyHash,
      ...(result.sdkEnvelope ? { sdkEnvelope: result.sdkEnvelope } : {}),
    };
  }
}

function computePolicyHash(credential: DelegationCredential): string {
  // Mirror of the verifier's `policyHashFor`: the same
  // canonicalize-then-sha256 of the VC body with the
  // proof stripped. The verifier will recompute this on
  // every privileged call and assert equality, so the
  // bytes we write here must match exactly. Any drift
  // between the two implementations is a verifier
  // regression and is caught by the integration test.
  const fingerprint = canonicalize({
    id: credential.id,
    type: credential.type,
    issuer: credential.issuer,
    issuanceDate: credential.issuanceDate,
    expirationDate: credential.expirationDate,
    credentialSubject: credential.credentialSubject,
  });
  return createHash("sha256").update(fingerprint).digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}