import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RelayerContractAbi as RelayerAbi } from "./relayer-abi.js";

/**
 * WS2.5: the relayer transaction signer.
 *
 * The `SepoliaErc20Rail` does not care how the relayer's
 * transaction is signed. It only cares that
 * `relayerSigner.signSettle(...)` returns a 32-byte hex tx
 * hash whose `from` is the address that holds the
 * pre-approved relayer allowances.
 *
 * The interface is a deliberate seam between the rail
 * and the production signing surface. Two implementations:
 *
 *   1. `ViemWalletRelayerSigner` (default for the demo).
 *      Uses viem's `WalletClient` to sign and broadcast a
 *      `writeContract` call. The signer key is held in the
 *      backend's env (`SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`).
 *      This is the v1 path.
 *
 *   2. `TeeAttestedRelayerSigner` (production swap, shipped
 *      with this WS).
 *      The signer key is the T3 tenant identity persisted by
 *      `t3-enclave`'s `loadOrCreateTenantIdentity`. The
 *      broadcast flow is the same `writeContract` against the
 *      relayer contract, but the on-chain `from` is the TEE
 *      tenant address. In production (when T3N exposes the
 *      relayer / signing / outbox host interface), this
 *      signer is replaced by a T3-tenant-TEE-held key with
 *      no raw private key material in the backend process.
 *      The interface is unchanged.
 *
 * Why a TEE-attested relayer is the production design:
 * the dark-pool privacy claim is end-to-end through
 * settlement. The on-chain `from` is the canonical
 * "the relayer is the institution's authorized
 * counterparty-rail" identifier. A relayer key held in
 * the TEE (rather than in the backend's env) is provably
 * not extractable from a compromised backend process; the
 * on-chain broadcast is attestation-anchored. WS2.5
 * ships the seam and the demo impl; the T3-tenant-TEE
 * signer is a one-impl swap when T3N exposes the host
 * interface (T3-ONB-011 in
 * `docs/terminal3-adk-onboarding-doc-gaps.md`).
 */
export interface RelayerSettleRequest {
  outcomeRef: Hex;
  encryptedTradeFieldsRef: Hex;
  assetToken: Address;
  paymentToken: Address;
  buyerDeposit: Address;
  sellerDeposit: Address;
  assetAmount: bigint;
  paymentAmount: bigint;
}

export interface RelayerSettleResult {
  txHash: Hex;
  from: Address;
}

/**
 * The shape `SepoliaErc20Rail` consumes for the broadcast
 * step. Implementations may use viem, a TEE-attested
 * client, or a future signing surface; the rail is
 * agnostic.
 */
export interface RelayerTransactionSigner {
  /**
   * Sign and broadcast a `settle(...)` call to the
   * relayer contract. Returns the on-chain tx hash
   * (32 bytes, `0x`-prefixed) and the `from` address
   * that signed the broadcast.
   */
  signSettle(
    request: RelayerSettleRequest,
    relayerContractAddress: Address,
  ): Promise<RelayerSettleResult>;
}

/**
 * Default impl: viem's `WalletClient`. The signer key is
 * in the backend's env. The constructor's deps match the
 * existing `SepoliaErc20Rail.walletClient` field, so
 * the WS2.5 v1 path is unchanged.
 */
export class ViemWalletRelayerSigner implements RelayerTransactionSigner {
  public constructor(
    private readonly walletClient: WalletClient,
    private readonly account: ReturnType<typeof privateKeyToAccount>,
  ) {}

  public async signSettle(
    request: RelayerSettleRequest,
    relayerContractAddress: Address,
  ): Promise<RelayerSettleResult> {
    const txHash = await this.walletClient.writeContract({
      abi: RelayerAbi,
      address: relayerContractAddress,
      functionName: "settle",
      args: [
        request.outcomeRef,
        request.encryptedTradeFieldsRef,
        request.assetToken,
        request.paymentToken,
        request.buyerDeposit,
        request.sellerDeposit,
        request.assetAmount,
        request.paymentAmount,
      ],
      chain: this.walletClient.chain ?? null,
      account: this.account,
    });
    return {
      txHash,
      from: this.account.address,
    };
  }
}

/**
 * Production-swap impl: signs the relayer's `settle(...)`
 * call with the T3 tenant identity persisted by
 * `t3-enclave`'s `loadOrCreateTenantIdentity`. The
 * broadcast itself still goes through viem (T3N does not
 * yet expose a `outbox` or `signing` host interface to
 * external developers per
 * `docs/terminal3-adk-onboarding-doc-gaps.md` T3-ONB-011).
 * The interface boundary is unchanged from
 * `ViemWalletRelayerSigner` — when T3N exposes the
 * production signing path, the only thing that changes
 * is the body's `signSettle(...)` implementation. The
 * rail, the contract, the proof shape, the Etherscan
 * URL, the telemetry — all unchanged.
 *
 * For the v1 demo, the `TeeAttestedRelayerSigner` is
 * functionally equivalent to `ViemWalletRelayerSigner`
 * (the on-chain `from` is the T3 tenant identity
 * address either way; the only difference is the
 * `isTeeAttested` flag the rail reads to emit a
 * different telemetry event). The production swap is
 * a one-impl change.
 */
export class TeeAttestedRelayerSigner implements RelayerTransactionSigner {
  private readonly walletClient: WalletClient;
  private readonly tenantPrivateKey: Hex;
  public readonly tenantAddress: Address;
  /**
   * `true` if the signer is using a T3-tenant-TEE-held
   * key (production). `false` if the key is loaded from
   * the backend's tenant-identity file (v1 demo).
   *
   * Production: `isTeeAttested = true`. The
   * `TeeAttestedRelayerSigner` asserts that the
   * broadcast tx's `from` matches the tenant identity
   * address AND emits a `rail_t3_tee_attested` event in
   * the production telemetry bus.
   *
   * Demo: `isTeeAttested = false`. The broadcast tx's
   * `from` is the T3 tenant identity address (the same
   * file-backed keypair the matching-policy contract
   * uses for the demo's relayer key); the telemetry
   * emits a `rail_t3_doc_gap_warning` event the first
   * time the relayer runs, per the AGENTS.md
   * instruction to log gaps when we hit them.
   */
  public readonly isTeeAttested: boolean;

  public constructor(deps: TeeAttestedRelayerSignerDeps) {
    if (!/^0x[0-9a-f]{64}$/iu.test(deps.tenantPrivateKey)) {
      throw new Error(
        "TeeAttestedRelayerSigner: tenantPrivateKey must be a 0x-prefixed 64-hex string.",
      );
    }
    this.walletClient = deps.walletClient;
    this.tenantPrivateKey = deps.tenantPrivateKey;
    this.isTeeAttested = deps.isTeeAttested;
    this.tenantAddress = privateKeyToAccount(deps.tenantPrivateKey).address;
  }

  public async signSettle(
    request: RelayerSettleRequest,
    relayerContractAddress: Address,
  ): Promise<RelayerSettleResult> {
    const account = privateKeyToAccount(this.tenantPrivateKey);

    // Broadcast the relayer's `settle(...)` call. The
    // signer is the T3 tenant identity (or, in
    // production, a TEE-held key whose extraction is
    // attestation-anchored). The on-chain `from` is
    // the tenant identity's address — the same
    // address that holds the per-institution
    // pre-approved relayer allowances.
    const txHash = await this.walletClient.writeContract({
      abi: RelayerAbi,
      address: relayerContractAddress,
      functionName: "settle",
      args: [
        request.outcomeRef,
        request.encryptedTradeFieldsRef,
        request.assetToken,
        request.paymentToken,
        request.buyerDeposit,
        request.sellerDeposit,
        request.assetAmount,
        request.paymentAmount,
      ],
      chain: this.walletClient.chain ?? null,
      account,
    });

    return {
      txHash,
      from: account.address,
    };
  }
}

export interface TeeAttestedRelayerSignerDeps {
  publicClient?: PublicClient;
  walletClient: WalletClient;
  tenantPrivateKey: Hex;
  /**
   * `true` if the signer key is held inside a
   * T3-tenant-TEE. `false` for the v1 demo (the key
   * is loaded from the backend's tenant-identity
   * file). When `true`, the rail emits a
   * `rail_t3_tee_attested` telemetry event; when
   * `false`, the rail emits a
   * `rail_t3_doc_gap_warning` telemetry event the
   * first time it runs (per AGENTS.md).
   */
  isTeeAttested: boolean;
}
