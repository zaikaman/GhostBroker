import { describe, expect, it } from "vitest";
import type { Address, PublicClient, WalletClient } from "viem";
import type { SettlementCommand } from "@ghostbroker/t3-enclave";
import { SepoliaErc20Rail } from "../../services/settlement-rails/chain-sepolia-rail.js";
import type { SettlementRailContext, SettlementRailPlaintext } from "../../services/settlement-rails/rail.js";

/**
 * WS2 unit tests for the chain rail. These run in-process
 * with mocked viem clients (no Anvil). They cover:
 *   1. Proof shape and asset-movement totals.
 *   2. Idempotency on retry.
 *   3. Failure modes (missing deposit / token addresses).
 *   4. Constructor argument validation.
 *
 * For the end-to-end "real tx hash on a real chain" test, see
 * `settlement-rail-chain-sepolia.test.ts` (gated by the
 * `WS2_ANVIL_INTEGRATION` env var).
 */

const RELAYER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address; // anvil acct 1
const BUYER_DEPOSIT = "0x90f79bf6eb2c4f870365e785982e1f101e93b906" as Address; // anvil acct 2
const SELLER_DEPOSIT = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as Address; // anvil acct 3

function makeFakeClients(overrides?: {
  txHash?: Address;
  receipt?: { blockNumber: bigint | null };
}): { publicClient: PublicClient; walletClient: WalletClient } {
  const txHash = (overrides?.txHash ?? "0xfeed00000000000000000000000000000000000000000000000000000000beef") as `0x${string}`;
  const receipt = overrides?.receipt ?? { blockNumber: 1n };

  // Minimal PublicClient surface used by the rail.
  const publicClient = {
    getTransactionReceipt: async () => receipt,
  } as unknown as PublicClient;

  const walletClient = {
    account: { address: RELAYER_ADDRESS },
    chain: null,
    sendTransaction: async () => txHash,
    // WS2.5: the rail uses `writeContract` for the real
    // relayer call. The unit test stubs it to return the
    // same `txHash` as `sendTransaction` (the WS2 v1
    // contract test had sendTransaction only; the WS2.5
    // rail uses writeContract).
    writeContract: async () => txHash,
  } as unknown as WalletClient;

  return { publicClient, walletClient };
}

function makeCommand(outcomeRef = "ws2-unit-1"): SettlementCommand {
  return {
    commandRef: `settlement_cmd_${outcomeRef}`,
    outcomeRef,
    executionRef: `t3exec_${outcomeRef}`,
    buyerInstitutionId: "00000000-0000-4000-8000-0000000000b1",
    sellerInstitutionId: "00000000-0000-4000-8000-0000000000b2",
    encryptedTradeFieldsRef: "encrypted_trade_fields_ws2_unit",
    submittedAt: new Date().toISOString(),
  };
}

function makeContext(overrides?: Partial<SettlementRailContext>): SettlementRailContext {
  return {
    depositAddresses: {
      "00000000-0000-4000-8000-0000000000b1": BUYER_DEPOSIT,
      "00000000-0000-4000-8000-0000000000b2": SELLER_DEPOSIT,
    },
    tokenAddresses: {
      WBTC: "0x1111111111111111111111111111111111111111",
      USDC: "0x2222222222222222222222222222222222222222",
    },
    buyerProfileRef: "chain:sepolia:erc20",
    sellerProfileRef: "chain:sepolia:erc20",
    ...overrides,
  };
}

function makeRail(opts?: {
  txHash?: Address;
  receipt?: { blockNumber: bigint | null };
}): SepoliaErc20Rail {
  const { publicClient, walletClient } = makeFakeClients(opts);
  return new SepoliaErc20Rail(
    {
      rpcUrl: "http://127.0.0.1:8545",
      relayerPrivateKey:
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      relayerContractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
      chainId: 31337,
      confirmTimeoutSec: 5,
    },
    { publicClient, walletClient },
  );
}

describe("SepoliaErc20Rail (WS2 unit)", () => {
  it("exposes the chain-rail id", () => {
    const rail = makeRail();
    expect(rail.id).toBe("chain:sepolia:erc20");
  });

  it("broadcasts a transaction and returns a 32-byte hex tx hash proof", async () => {
    const rail = makeRail();
    const proof = await rail.dispatch(
      makeCommand("unit-hash"),
      { assetCode: "WBTC", quantity: 0.25, executionPrice: 70_000 } as SettlementRailPlaintext,
      makeContext(),
    );
    expect(proof.railId).toBe("chain:sepolia:erc20");
    expect(proof.railTradeRef).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(proof.railState).toBe("settled");
    expect(proof.assetMovements).toHaveLength(2);
    const [assetLeg, paymentLeg] = proof.assetMovements;
    expect(assetLeg).toBeDefined();
    expect(paymentLeg).toBeDefined();
    expect(assetLeg?.quantity).toBe("0.25");
    expect(paymentLeg?.quantity).toBe((0.25 * 70_000).toString());
    expect(paymentLeg?.assetCode).toBe("USDC");
  });

  it("is idempotent: a retry with the same outcome returns the same proof", async () => {
    const rail = makeRail();
    const command = makeCommand("unit-idempotency");
    const plaintext: SettlementRailPlaintext = { assetCode: "WBTC", quantity: 0.1, executionPrice: 70_000 };
    const ctx = makeContext();
    const first = await rail.dispatch(command, plaintext, ctx);
    const second = await rail.dispatch(command, plaintext, ctx);
    expect(first.railTradeRef).toBe(second.railTradeRef);
    expect(first.assetMovements).toEqual(second.assetMovements);
  });

  it("rejects a missing deposit address with a typed error", async () => {
    const rail = makeRail();
    await expect(
      rail.dispatch(
        makeCommand("unit-no-deposit"),
        { assetCode: "WBTC", quantity: 1, executionPrice: 70_000 },
        // No depositAddresses.
        {
          tokenAddresses: {
            WBTC: "0x1111111111111111111111111111111111111111",
            USDC: "0x2222222222222222222222222222222222222222",
          },
        },
      ),
    ).rejects.toThrow(/missing deposit address/i);
  });

  it("rejects a missing token address with a typed error", async () => {
    const rail = makeRail();
    await expect(
      rail.dispatch(
        makeCommand("unit-no-token"),
        { assetCode: "WBTC", quantity: 1, executionPrice: 70_000 },
        {
          depositAddresses: {
            "00000000-0000-4000-8000-0000000000b1": BUYER_DEPOSIT,
            "00000000-0000-4000-8000-0000000000b2": SELLER_DEPOSIT,
          },
          // No tokenAddresses.
        },
      ),
    ).rejects.toThrow(/missing token address/i);
  });

  it("rejects identical buyer and seller deposit addresses with a typed error", async () => {
    const rail = makeRail();
    await expect(
      rail.dispatch(
        makeCommand("unit-same-deposit"),
        { assetCode: "WBTC", quantity: 1, executionPrice: 70_000 },
        {
          depositAddresses: {
            "00000000-0000-4000-8000-0000000000b1": BUYER_DEPOSIT,
            "00000000-0000-4000-8000-0000000000b2": BUYER_DEPOSIT,
          },
          tokenAddresses: {
            WBTC: "0x1111111111111111111111111111111111111111",
            USDC: "0x2222222222222222222222222222222222222222",
          },
        },
      ),
    ).rejects.toThrow(/identical/i);
  });

  it("reverse() returns a typed 'failed' state (WS2 v1 has no reversal path)", async () => {
    const rail = makeRail();
    const result = await rail.reverse("0xabc", "test reason");
    expect(result.railId).toBe("chain:sepolia:erc20");
    expect(result.railState).toBe("failed");
    expect(result.assetMovements).toEqual([]);
  });
});
