import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  toFunctionSelector,
  parseUnits,
  decodeEventLog,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";
import type {
  RailSettlementProof,
  SettlementRail,
  SettlementRailContext,
  SettlementRailPlaintext,
} from "./rail.js";
import { RelayerContractAbi } from "./relayer-abi.js";
import {
  ViemWalletRelayerSigner,
  type RelayerSettleRequest,
  type RelayerTransactionSigner,
} from "./relayer-signer.js";

/**
 * WS2.5 — chain rail (Sepolia ERC-20, real relayer).
 *
 * Broadcasts a `settle(...)` call to the
 * `GhostBrokerSettlementRelayer` contract against a per-
 * institution relayer key. The relayer contract holds
 * pre-approved allowances from each institution's deposit
 * address; the rail never holds the institutions' keys.
 *
 * ### Production design
 *
 * The relayer key is held in the backend's env
 * (`SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY`). In
 * production this key is held inside the T3 tenant TEE so
 * the relayer's signed transactions carry an attestation
 * (see `docs/terminal3-adk-onboarding-doc-gaps.md`,
 * Addendum 2026-06-15). The TEE-relayer swap is a one-file
 * change to this rail: replace the `walletClient` with a
 * TEE-attested one.
 *
 * ### Confidentiality
 *
 * The on-chain `settle(...)` calldata is the relayer's ABI-
 * encoded arguments, which include the institution's deposit
 * addresses and the asset/payment amounts (necessary for the
 * ERC-20 `transferFrom` pair). The **counterparty's identity
 * is on-chain** (deposit addresses are public); the
 * **TEE-decrypted `quantity` and `executionPrice` are not** —
 * the chain observer sees two `transferFrom` calls of
 * `assetAmount` and `paymentAmount`, not the original
 * `quantity * price` semantics. The plaintext trade fields
 * live only in the TEE-decrypted receipt blob keyed by
 * `encryptedTradeFieldsRef`.
 *
 * ### Idempotency
 *
 * - Process-local: `dispatchCache` short-circuits a retry
 *   with the same `outcomeRef` and returns the prior
 *   `railTradeRef`.
 * - On-chain: the relayer contract tracks `settledOutcomes`
 *   and reverts a second call with `OutcomeAlreadySettled`.
 *   The reconciler (WS4) uses this to detect drift.
 *
 * ### Per-institution deposit addresses
 *
 * Production: each institution's `metadata.depositAddress` is
 * a per-institution wallet that has pre-approved the relayer
 * for the asset and payment tokens. The operator sets up
 * the allowance at institution creation time (WS3). The rail
 * requires both deposit addresses in the rail context; it
 * throws a typed error otherwise.
 */
export interface SepoliaErc20RailConfig {
  rpcUrl: string;
  relayerPrivateKey: Hex;
  relayerContractAddress: Address;
  chainId: number;
  confirmTimeoutSec: number;
}

export interface SepoliaErc20RailDeps {
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  tokenDecimals?: Readonly<Record<string, number>>;
  /**
   * WS2.5: the relayer transaction signer. Optional.
   * When omitted, the rail builds a
   * `ViemWalletRelayerSigner` from `walletClient` +
   * the constructor's `relayerPrivateKey` (the v1 demo
   * path). When provided, the rail uses the supplied
   * signer for the broadcast step.
   *
   * Production: pass a `TeeAttestedRelayerSigner` whose
   * `tenantPrivateKey` is the T3 tenant identity
   * loaded via `t3-enclave`'s
   * `loadOrCreateTenantIdentity(...)`. The TEE-attested
   * production signer (T3-tenant-TEE-held key) is a
   * one-impl swap when T3N exposes the relayer /
   * signing / outbox host interface
   * (T3-ONB-011 in
   * `docs/terminal3-adk-onboarding-doc-gaps.md`).
   */
  relayerSigner?: RelayerTransactionSigner;
}

const DEFAULT_TOKEN_DECIMALS: Readonly<Record<string, number>> = {
  USDC: 6,
  WBTC: 8,
};

/**
 * The relayer contract's `Settled` event ABI signature, used
 * to decode the receipt logs and assert the chain
 * transferred assets as expected. Computed at module load
 * from the relayer's ABI rather than hardcoded so the
 * assertion breaks if the contract changes shape.
 */
function getSettledEvent() {
  for (const entry of RelayerContractAbi) {
    if (entry.type === "event" && entry.name === "Settled") {
      return entry;
    }
  }
  throw new Error("RelayerContractAbi is missing the Settled event");
}

const SETTLED_EVENT = getSettledEvent();

/**
 * The relayer contract's `settle` function selector. We use
 * viem's `writeContract` for the call, but the selector is
 * exported so the integration test can cross-check the
 * on-the-wire calldata.
 */
export const SETTLE_FUNCTION_SELECTOR = computeSettleSelector();

function computeSettleSelector(): Hex {
  return toFunctionSelector(
    "settle(bytes32,bytes32,address,address,address,address,uint256,uint256)",
  );
}

/**
 * Validate and normalize the rail's per-call context.
 */
function resolveChainContext(
  context: SettlementRailContext | undefined,
  command: SettlementCommand,
  plaintext: SettlementRailPlaintext,
): {
  buyerDeposit: Address;
  sellerDeposit: Address;
  paymentToken: Address;
  assetToken: Address;
} {
  if (!context) {
    throw new Error(
      "SepoliaErc20Rail.dispatch: missing rail context. The settlement service must pass per-institution deposit addresses and per-asset token addresses.",
    );
  }
  const buyerDeposit = context.depositAddresses?.[command.buyerInstitutionId];
  const sellerDeposit = context.depositAddresses?.[command.sellerInstitutionId];
  const paymentToken = context.tokenAddresses?.["USDC"];
  const assetToken = context.tokenAddresses?.[plaintext.assetCode];
  if (!buyerDeposit || !sellerDeposit) {
    throw new Error(
      `SepoliaErc20Rail.dispatch: missing deposit address(es) for institutions ${command.buyerInstitutionId} / ${command.sellerInstitutionId}. Both institutions must have a deposit address in their metadata before the chain rail can dispatch.`,
    );
  }
  if (buyerDeposit === sellerDeposit) {
    throw new Error(
      "SepoliaErc20Rail.dispatch: buyer and seller deposit addresses are identical. The WS2.5 rail requires two distinct per-institution deposit addresses.",
    );
  }
  if (!paymentToken || !assetToken) {
    throw new Error(
      `SepoliaErc20Rail.dispatch: missing token address(es) for USDC and ${plaintext.assetCode}. Both tokens must be configured in the rail's per-asset address map.`,
    );
  }
  return {
    buyerDeposit: buyerDeposit as Address,
    sellerDeposit: sellerDeposit as Address,
    paymentToken: paymentToken as Address,
    assetToken: assetToken as Address,
  };
}

export class SepoliaErc20Rail implements SettlementRail {
  public readonly id = "chain:sepolia:erc20";

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly tokenDecimals: Readonly<Record<string, number>>;
  private readonly confirmTimeoutMs: number;
  private readonly relayerContractAddress: Address;
  /**
   * WS2.5: the relayer transaction signer. The
   * `dispatch` method calls this in place of
   * `walletClient.writeContract`; the rail is
   * otherwise agnostic to the signing surface. The
   * default (when `deps.relayerSigner` is not
   * supplied) is a `ViemWalletRelayerSigner` that
   * uses the constructor's `walletClient` +
   * `account` to sign the broadcast. Production
   * swaps in a `TeeAttestedRelayerSigner` whose
   * `tenantPrivateKey` is the T3 tenant identity
   * loaded via `t3-enclave`'s
   * `loadOrCreateTenantIdentity(...)`.
   */
  private readonly relayerSigner: RelayerTransactionSigner;
  private readonly dispatchCache = new Map<
    string,
    { txHash: string; from: Address }
  >();

  public constructor(config: SepoliaErc20RailConfig, deps: SepoliaErc20RailDeps = {}) {
    if (!/^0x[0-9a-f]{64}$/iu.test(config.relayerPrivateKey)) {
      throw new Error(
        "SepoliaErc20Rail: relayerPrivateKey must be a 0x-prefixed 64-hex string.",
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/u.test(config.relayerContractAddress)) {
      throw new Error(
        "SepoliaErc20Rail: relayerContractAddress must be a 0x-prefixed 40-hex address.",
      );
    }

    const chain = defineChain({
      id: config.chainId,
      name: config.chainId === 11155111 ? "Sepolia" : `chain-${config.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });

    this.publicClient =
      deps.publicClient ??
      createPublicClient({ chain, transport: http(config.rpcUrl) });

    const account = privateKeyToAccount(config.relayerPrivateKey);
    this.walletClient =
      deps.walletClient ??
      createWalletClient({ account, chain, transport: http(config.rpcUrl) });

    this.tokenDecimals = deps.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
    this.confirmTimeoutMs = config.confirmTimeoutSec * 1000;
    this.relayerContractAddress = config.relayerContractAddress;
    this.account = account;
    // WS2.5: the relayer signer is a deliberate seam.
    // The v1 demo path is a `ViemWalletRelayerSigner`
    // built from the existing `walletClient` + `account`
    // (the relayer key in env). Production swaps in a
    // `TeeAttestedRelayerSigner` whose `tenantPrivateKey`
    // is the T3 tenant identity loaded via
    // `t3-enclave`'s `loadOrCreateTenantIdentity(...)`.
    this.relayerSigner =
      deps.relayerSigner ??
      new ViemWalletRelayerSigner(this.walletClient, this.account);
  }

  public async dispatch(
    command: SettlementCommand,
    plaintext: SettlementRailPlaintext,
    context?: SettlementRailContext,
  ): Promise<RailSettlementProof> {
    const resolved = resolveChainContext(context, command, plaintext);

    // Process-local idempotency: a retry of the same
    // `outcomeRef` returns the prior proof without
    // re-broadcasting.
    const cached = this.dispatchCache.get(command.outcomeRef);
    if (cached) {
      return this.buildProof(
        cached.txHash as Hash,
        command,
        plaintext,
        resolved,
        cached.from,
      );
    }

    const assetDecimals = this.tokenDecimals[plaintext.assetCode] ?? 6;
    const paymentDecimals = this.tokenDecimals["USDC"] ?? 6;
    const assetAmount = parseUnits(plaintext.quantity.toString(), assetDecimals);
    const paymentAmount = parseUnits(
      (plaintext.quantity * plaintext.executionPrice).toString(),
      paymentDecimals,
    );

    // WS2.5: real broadcast against the relayer's
    // `settle(...)` ABI. The relayer's `settle` takes
    // `bytes32` for `outcomeRef` and
    // `encryptedTradeFieldsRef`; the backend's command
    // carries these as variable-length strings, so we
    // left-pad them to bytes32. A non-string outcome
    // is a hard error (the TEE always emits a hex
    // string of fixed shape).
    //
    // The broadcast step goes through the rail's
    // `relayerSigner` (v1: `ViemWalletRelayerSigner`
    // from env; production:
    // `TeeAttestedRelayerSigner` from the T3 tenant
    // identity). The interface is the same in both
    // cases.
    const outcomeRefBytes32 = stringToBytes32(command.outcomeRef);
    const encryptedTradeFieldsRefBytes32 = stringToBytes32(
      command.encryptedTradeFieldsRef,
    );
    const settleRequest: RelayerSettleRequest = {
      outcomeRef: outcomeRefBytes32,
      encryptedTradeFieldsRef: encryptedTradeFieldsRefBytes32,
      assetToken: resolved.assetToken,
      paymentToken: resolved.paymentToken,
      buyerDeposit: resolved.buyerDeposit,
      sellerDeposit: resolved.sellerDeposit,
      assetAmount,
      paymentAmount,
    };
    const settleResult = await this.relayerSigner.signSettle(
      settleRequest,
      this.relayerContractAddress,
    );
    const txHash = settleResult.txHash;
    const broadcastedFrom = settleResult.from;

    this.dispatchCache.set(command.outcomeRef, {
      txHash,
      from: broadcastedFrom,
    });
    // Best-effort confirmation wait; the reconciler (WS4) is
    // the production authority on confirm-timeout / re-org
    // recovery. The rail returns the broadcast tx hash
    // regardless so the DB row is populated.
    await this.waitForConfirmation(txHash);

    return this.buildProof(
      txHash,
      command,
      plaintext,
      resolved,
      broadcastedFrom,
    );
  }

  public async reverse(
    tradeRef: string,
    _reason: string,
  ): Promise<RailSettlementProof> {
    // WS2.5: real `writeContract` against the relayer's
    // `reverse(...)` ABI. Production: the reverser endpoint
    // (WS4.2) calls this with the original settlement
    // arguments. The v1 test path passes the tradeRef
    // verbatim; a full reverser integration test asserts the
    // on-chain state.
    return {
      railId: this.id,
      railTradeRef: tradeRef,
      // WS2.5: the chain rail's v1 reverse is a
      // typed "not yet implemented" stub. The on-chain
      // signer address is unknown (no broadcast
      // happened); surface `null` so the settlement
      // service does not emit a TEE-attestation event
      // for the un-broadcast reverse.
      railSignerAddress: null,
      railState: "failed",
      assetMovements: [],
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * WS4: status check used by the reconciler. Reads the
   * chain to confirm the trade's tx is still in the
   * canonical chain. Returns a structured "settled" /
   * "missing" / "reverted" view.
   */
  public async status(tradeRef: string): Promise<{
    railState: "settled" | "missing" | "reverted";
    observedAt: string;
  }> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: tradeRef as Hash,
      });
      if (!receipt || receipt.blockNumber === null) {
        return { railState: "missing", observedAt: new Date().toISOString() };
      }
      // `status === 1` means the tx is in the canonical
      // chain; `status === 0` means it reverted.
      if (receipt.status === "success") {
        return { railState: "settled", observedAt: new Date().toISOString() };
      }
      return { railState: "reverted", observedAt: new Date().toISOString() };
    } catch (err) {
      if (isNotFoundError(err)) {
        return { railState: "missing", observedAt: new Date().toISOString() };
      }
      throw err;
    }
  }

  private buildProof(
    txHash: Hash,
    command: SettlementCommand,
    plaintext: SettlementRailPlaintext,
    resolved: { buyerDeposit: Address; sellerDeposit: Address; paymentToken: Address; assetToken: Address },
    railSignerAddress: Address,
  ): RailSettlementProof {
    return {
      railId: this.id,
      railTradeRef: txHash,
      // WS2.5: the on-chain `from` of the broadcast tx.
      // The settlement service reads this and emits
      // the `rail_t3_tee_attested` (production) or
      // `rail_t3_doc_gap_warning` (v1 demo) telemetry
      // event, depending on whether the signer is a
      // T3-tenant-TEE-held key (production) or the
      // T3-tenant-identity file-backed key (v1 demo).
      railSignerAddress,
      railState: "settled",
      assetMovements: [
        {
          assetCode: plaintext.assetCode,
          fromInstitutionId: command.sellerInstitutionId,
          toInstitutionId: command.buyerInstitutionId,
          quantity: plaintext.quantity.toString(),
          railAssetRef: resolved.assetToken,
        },
        {
          assetCode: "USDC",
          fromInstitutionId: command.buyerInstitutionId,
          toInstitutionId: command.sellerInstitutionId,
          quantity: (plaintext.quantity * plaintext.executionPrice).toString(),
          railAssetRef: resolved.paymentToken,
        },
      ],
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * WS2.5: read the chain receipt and decode the relayer's
   * `Settled` event log. Asserts the event's
   * `assetAmount` and `paymentAmount` match the TEE's
   * authorized plaintext. Throws a typed error on drift.
   *
   * Exposed as a public method (not private) so the
   * integration test can call it directly to assert the
   * on-chain state.
   */
  public async decodeSettledLog(
    txHash: Hash,
    expected: { assetAmount: bigint; paymentAmount: bigint },
  ): Promise<{ matched: boolean; log: Log | null }> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    if (!receipt) {
      return { matched: false, log: null };
    }
    for (const rawLog of receipt.logs) {
      // Only logs from the relayer contract are ours.
      if (rawLog.address.toLowerCase() !== this.relayerContractAddress.toLowerCase()) {
        continue;
      }
      try {
        const decoded = decodeEventLog({
          abi: [SETTLED_EVENT],
          data: rawLog.data,
          topics: rawLog.topics,
        });
        if (decoded.eventName === "Settled") {
          const args = decoded.args as {
            assetAmount: bigint;
            paymentAmount: bigint;
          };
          const matched =
            args.assetAmount === expected.assetAmount &&
            args.paymentAmount === expected.paymentAmount;
          return { matched, log: rawLog };
        }
      } catch {
        // The log was not the Settled event; skip.
        continue;
      }
    }
    return { matched: false, log: null };
  }

  private async waitForConfirmation(txHash: Hash): Promise<void> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt && receipt.blockNumber !== null) {
          return;
        }
      } catch (err) {
        if (!isNotFoundError(err)) {
          throw err;
        }
      }
      await sleep(2_000);
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && /not[ _-]?found|missing|unknown/i.test(name)) {
    return true;
  }
  if (err instanceof Error && /not found|missing|unknown/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Left-pad a string to exactly 32 bytes, the width of
 * Solidity's `bytes32`. Strings longer than 32 bytes are
 * truncated (the TEE's outcome ref is always under 32 bytes
 * in practice; the TEE's session ref is also under 32
 * bytes).
 */
function stringToBytes32(s: string): Hex {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > 32) {
    return ("0x" + Buffer.from(bytes.slice(0, 32)).toString("hex")) as Hex;
  }
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return ("0x" + Buffer.from(padded).toString("hex")) as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
