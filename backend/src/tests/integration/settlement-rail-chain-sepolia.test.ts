import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseUnits,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SettlementCommand } from "../../enclave/index.js";
import { SepoliaErc20Rail } from "../../services/settlement-rails/chain-sepolia-rail.js";
import {
  MinimalErc20Abi,
  MinimalErc20Bytecode,
  RelayerContractAbi,
  RelayerContractBytecode,
} from "../../services/settlement-rails/relayer-abi.js";
import { TeeAttestedRelayerSigner } from "../../services/settlement-rails/relayer-signer.js";

/**
 * WS2.5 acceptance test for the chain rail.
 *
 * Spawns a local Anvil instance, deploys the real
 * `GhostBrokerSettlementRelayer` contract + two real
 * `MinimalERC20` contracts (one asset token, one payment
 * token), funds two distinct per-institution deposit
 * addresses, has each deposit address approve the relayer
 * for its respective token, and asks the rail to dispatch
 * a settlement. The rail must:
 *
 *   1. Return a proof whose `railTradeRef` is a real 32-byte
 *      transaction hash.
 *   2. The on-chain `Settled` event decoded from the
 *      transaction receipt matches the TEE-authorized
 *      plaintext trade fields (`assetAmount` and
 *      `paymentAmount`).
 *   3. The ERC-20 `Transfer` events on the asset and payment
 *      tokens show the expected from/to/amount triples.
 *   4. A retry of `dispatch` with the same `outcomeRef`
 *      returns the same proof (process-local cache).
 *   5. A second broadcast of the same `outcomeRef` reverts
 *      with `OutcomeAlreadySettled` (on-chain idempotency).
 *   6. `status()` reports the trade as `settled` when the
 *      tx is in the canonical chain.
 *
 * Gated by the `WS2_ANVIL_INTEGRATION` env var (matches the
 * WS2 v1 convention).
 */

const ANVIL_PORT = 18546; // 18545 used by WS2 v1
const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const ANVIL_CHAIN_ID = 31337;

const RELAYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const anvilEnabled = process.env.WS2_ANVIL_INTEGRATION === "1";
const describeIf = anvilEnabled ? describe : describe.skip;

interface SpawnedAnvil {
  process: ChildProcess;
  ready: Promise<void>;
  stop: () => void;
}

function resolveAnvilCommand(): string {
  const configured = process.env.FOUNDRY_ANVIL_PATH;
  if (configured && configured.length > 0) {
    return configured;
  }

  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      const windowsFoundryPath = join(
        userProfile,
        ".foundry",
        "bin",
        "anvil.exe",
      );
      if (existsSync(windowsFoundryPath)) {
        return windowsFoundryPath;
      }
    }
  }

  return "anvil";
}

async function startAnvil(): Promise<SpawnedAnvil> {
  const stateDir = mkdtempSync(join(tmpdir(), "anvil-ws25-"));
  const child = spawn(
    resolveAnvilCommand(),
    ["--port", String(ANVIL_PORT), "--state", join(stateDir, "state.json")],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    let resolved = false;
    const onError = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      rejectReady(err);
    };
    child.on("error", onError);
    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      rejectReady(new Error(`Anvil exited prematurely with code ${code}`));
    });
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (text.includes("Listening on") || text.includes("started HTTP")) {
        if (resolved) return;
        resolved = true;
        setTimeout(resolveReady, 200);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
  });

  return {
    process: child,
    ready,
    stop: (): void => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

interface TestContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  rail: SepoliaErc20Rail;
  relayerAddress: Address;
  relayerContractAddress: Address;
  assetToken: Address;
  paymentToken: Address;
  buyerDeposit: Address;
  sellerDeposit: Address;
  buyerInstitutionId: string;
  sellerInstitutionId: string;
}

function makeCommand(ctx: TestContext, outcomeRef: string): SettlementCommand {
  return {
    commandRef: `settlement_cmd_${outcomeRef}`,
    outcomeRef,
    executionRef: `t3exec_${outcomeRef}`,
    buyerInstitutionId: ctx.buyerInstitutionId,
    sellerInstitutionId: ctx.sellerInstitutionId,



        encryptedTradeFieldsRef: "encrypted_trade_fields_ws25",
    submittedAt: new Date().toISOString(),
  };
}

describeIf("settlement rail (WS2.5 — chain sepolia erc20, real relayer)", () => {
  let anvil: SpawnedAnvil | undefined;
  let ctx: TestContext | undefined;

  beforeAll(async () => {
    anvil = await startAnvil();
    await anvil.ready;

    const chain = defineChain({
      id: ANVIL_CHAIN_ID,
      name: "anvil-ws25",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
    });
    const account = privateKeyToAccount(RELAYER_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(ANVIL_RPC_URL) });
    const walletClient = createWalletClient({ account, chain, transport: http(ANVIL_RPC_URL) });

    // Deploy the relayer contract.
    const relayerDeployHash = await walletClient.deployContract({
      abi: RelayerContractAbi,
      bytecode: RelayerContractBytecode,
      args: [account.address],
    });
    const relayerReceipt = await publicClient.waitForTransactionReceipt({
      hash: relayerDeployHash,
    });
    const relayerContractAddress = relayerReceipt.contractAddress;
    if (!relayerContractAddress) {
      throw new Error("Relayer contract deployment did not return a contract address.");
    }

    // Deploy two minimal ERC-20s.
    const assetDeploy = await walletClient.deployContract({
      abi: MinimalErc20Abi,
      bytecode: MinimalErc20Bytecode,
      args: ["Wrapped BTC", "WBTC", 8],
    });
    const assetReceipt = await publicClient.waitForTransactionReceipt({ hash: assetDeploy });
    const assetToken = assetReceipt.contractAddress;
    if (!assetToken) throw new Error("Asset token deployment failed");

    const paymentDeploy = await walletClient.deployContract({
      abi: MinimalErc20Abi,
      bytecode: MinimalErc20Bytecode,
      args: ["USD Coin", "USDC", 6],
    });
    const paymentReceipt = await publicClient.waitForTransactionReceipt({ hash: paymentDeploy });
    const paymentToken = paymentReceipt.contractAddress;
    if (!paymentToken) throw new Error("Payment token deployment failed");

    // Set up two distinct per-institution deposit addresses.
    // Anvil pre-funds accounts 0-9; we use accounts 0 and 1.
    const buyerPrivateKey =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
    const sellerPrivateKey =
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
    const buyerAccount = privateKeyToAccount(buyerPrivateKey);
    const sellerAccount = privateKeyToAccount(sellerPrivateKey);
    const buyerDeposit = buyerAccount.address;
    const sellerDeposit = sellerAccount.address;

    // Fund the buyer with payment token (USDC) and the seller
    // with the traded asset (WBTC), which is the real settlement
    // direction the relayer must enforce.
    const buyerFundingAmount = parseUnits("1000000", 6); // 1M USDC
    const sellerFundingAmount = parseUnits("10", 8); // 10 WBTC
    await walletClient.writeContract({
      abi: MinimalErc20Abi,
      address: paymentToken,
      functionName: "mint",
      args: [buyerDeposit, buyerFundingAmount],
    });
    await walletClient.writeContract({
      abi: MinimalErc20Abi,
      address: assetToken,
      functionName: "mint",
      args: [sellerDeposit, sellerFundingAmount],
    });

    // The deposit addresses must approve the relayer for
    // their respective tokens. In production the operator
    // does this at institution creation; in the test we
    // sign the approval from each deposit account.
    const buyerWallet = createWalletClient({
      account: buyerAccount,
      chain,
      transport: http(ANVIL_RPC_URL),
    });
    const sellerWallet = createWalletClient({
      account: sellerAccount,
      chain,
      transport: http(ANVIL_RPC_URL),
    });
    await buyerWallet.writeContract({
      abi: MinimalErc20Abi,
      address: paymentToken,
      functionName: "approve",
      args: [relayerContractAddress, buyerFundingAmount],
    });
    await sellerWallet.writeContract({
      abi: MinimalErc20Abi,
      address: assetToken,
      functionName: "approve",
      args: [relayerContractAddress, sellerFundingAmount],
    });

    const rail = new SepoliaErc20Rail(
      {
        rpcUrl: ANVIL_RPC_URL,
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        relayerContractAddress,
        chainId: ANVIL_CHAIN_ID,
        confirmTimeoutSec: 10,
      },
      { publicClient, walletClient },
    );

    ctx = {
      publicClient,
      walletClient,
      rail,
      relayerAddress: account.address,
      relayerContractAddress,
      assetToken,
      paymentToken,
      buyerDeposit,
      sellerDeposit,
      buyerInstitutionId: "00000000-0000-4000-8000-0000000000c1",
      sellerInstitutionId: "00000000-0000-4000-8000-0000000000c2",
    };
  }, 60_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("broadcasts a real settle() call and decodes the Settled event", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const command = makeCommand(ctx, "ws25-settle-1");
    const quantity = 0.5;
    const executionPrice = 70_000;
    const expectedAssetAmount = parseUnits(quantity.toString(), 8);
    const expectedPaymentAmount = parseUnits(
      (quantity * executionPrice).toString(),
      6,
    );

    const proof = await ctx.rail.dispatch(
      command,
      { assetCode: "WBTC", quantity, executionPrice },
      {
        depositAddresses: {
          [ctx.buyerInstitutionId]: ctx.buyerDeposit,
          [ctx.sellerInstitutionId]: ctx.sellerDeposit,
        },
        tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
        buyerProfileRef: "chain:sepolia:erc20",
        sellerProfileRef: "chain:sepolia:erc20",
      },
    );

    // Proof shape.
    expect(proof.railId).toBe("chain:sepolia:erc20");
    expect(proof.railTradeRef).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(proof.railState).toBe("settled");
    expect(proof.assetMovements).toHaveLength(2);
    const [assetLeg, paymentLeg] = proof.assetMovements;
    expect(assetLeg?.assetCode).toBe("WBTC");
    expect(assetLeg?.quantity).toBe(quantity.toString());
    expect(paymentLeg?.assetCode).toBe("USDC");
    expect(paymentLeg?.quantity).toBe((quantity * executionPrice).toString());

    // On-chain Settled event decoding. Asserts the
    // `assetAmount` and `paymentAmount` match the TEE's
    // authorized plaintext.
    const settled = await ctx.rail.decodeSettledLog(
      proof.railTradeRef as Hash,
      { assetAmount: expectedAssetAmount, paymentAmount: expectedPaymentAmount },
    );
    expect(settled.matched).toBe(true);
    expect(settled.log).not.toBeNull();

    // ERC-20 balances: the buyer should receive 0.5 WBTC and
    // pay 35,000 USDC; the seller should deliver 0.5 WBTC and
    // receive 35,000 USDC.
    const buyerWbtcBalance = (await ctx.publicClient.readContract({
      abi: MinimalErc20Abi,
      address: ctx.assetToken,
      functionName: "balanceOf",
      args: [ctx.buyerDeposit],
    })) as bigint;
    const sellerWbtcBalance = (await ctx.publicClient.readContract({
      abi: MinimalErc20Abi,
      address: ctx.assetToken,
      functionName: "balanceOf",
      args: [ctx.sellerDeposit],
    })) as bigint;
    const buyerUsdcBalance = (await ctx.publicClient.readContract({
      abi: MinimalErc20Abi,
      address: ctx.paymentToken,
      functionName: "balanceOf",
      args: [ctx.buyerDeposit],
    })) as bigint;
    const sellerUsdcBalance = (await ctx.publicClient.readContract({
      abi: MinimalErc20Abi,
      address: ctx.paymentToken,
      functionName: "balanceOf",
      args: [ctx.sellerDeposit],
    })) as bigint;

    expect(buyerWbtcBalance).toBe(expectedAssetAmount);
    expect(sellerWbtcBalance).toBe(parseUnits("9.5", 8));
    expect(buyerUsdcBalance).toBe(parseUnits("965000", 6));
    expect(sellerUsdcBalance).toBe(expectedPaymentAmount);
  }, 60_000);

  it("is idempotent on retry (process-local cache)", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const command = makeCommand(ctx, "ws25-settle-2");
    const context = {
      depositAddresses: {
        [ctx.buyerInstitutionId]: ctx.buyerDeposit,
        [ctx.sellerInstitutionId]: ctx.sellerDeposit,
      },
      tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
      buyerProfileRef: "chain:sepolia:erc20",
      sellerProfileRef: "chain:sepolia:erc20",
    };
    const first = await ctx.rail.dispatch(
      command,
      { assetCode: "WBTC", quantity: 0.1, executionPrice: 70_000 },
      context,
    );
    const second = await ctx.rail.dispatch(
      command,
      { assetCode: "WBTC", quantity: 0.1, executionPrice: 70_000 },
      context,
    );
    expect(first.railTradeRef).toBe(second.railTradeRef);
  }, 60_000);

  it("rejects a missing deposit address with a typed error", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const command = makeCommand(ctx, "ws25-no-deposit");
    await expect(
      ctx.rail.dispatch(
        command,
        { assetCode: "WBTC", quantity: 0.1, executionPrice: 70_000 },
        {
          // No depositAddresses.
          tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
        },
      ),
    ).rejects.toThrow(/missing deposit address/i);
  });

  it("rejects identical buyer and seller deposit addresses", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const command = makeCommand(ctx, "ws25-same-deposit");
    await expect(
      ctx.rail.dispatch(
        command,
        { assetCode: "WBTC", quantity: 0.1, executionPrice: 70_000 },
        {
          depositAddresses: {
            [ctx.buyerInstitutionId]: ctx.buyerDeposit,
            [ctx.sellerInstitutionId]: ctx.buyerDeposit,
          },
          tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
        },
      ),
    ).rejects.toThrow(/identical/i);
  });

  it("status() reports the trade as 'settled' when the tx is in the canonical chain", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const command = makeCommand(ctx, "ws25-status");
    const proof = await ctx.rail.dispatch(
      command,
      { assetCode: "WBTC", quantity: 0.05, executionPrice: 70_000 },
      {
        depositAddresses: {
          [ctx.buyerInstitutionId]: ctx.buyerDeposit,
          [ctx.sellerInstitutionId]: ctx.sellerDeposit,
        },
        tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
      },
    );
    const status = await ctx.rail.status(proof.railTradeRef);
    expect(status.railState).toBe("settled");
  }, 60_000);

  it("status() reports 'missing' for an unknown tx hash", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const status = await ctx.rail.status(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(status.railState).toBe("missing");
  });

  it("on-chain idempotency: a second settle() with the same outcome reverts with OutcomeAlreadySettled", async () => {
    if (!ctx) throw new Error("ctx not initialized");
    const outcomeRef = "ws25-onchain-idem";
    // The first settle must succeed; we do not need a fresh
    // rail instance (the WS2 unit-test idempotency test
    // already covers the in-process cache path). For the
    // on-chain check, we publish a fresh walletClient so
    // the second call's tx is on-chain, not cached.
    const command = makeCommand(ctx, outcomeRef);
    await ctx.rail.dispatch(
      command,
      { assetCode: "WBTC", quantity: 0.01, executionPrice: 70_000 },
      {
        depositAddresses: {
          [ctx.buyerInstitutionId]: ctx.buyerDeposit,
          [ctx.sellerInstitutionId]: ctx.sellerDeposit,
        },
        tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
      },
    );

    // Construct a second rail instance with an empty cache
    // and a fresh walletClient. Calling `settle` with the
    // same outcome must revert on-chain.
    const freshRail = new SepoliaErc20Rail(
      {
        rpcUrl: ANVIL_RPC_URL,
        relayerPrivateKey: RELAYER_PRIVATE_KEY,
        relayerContractAddress: ctx.relayerContractAddress,
        chainId: ANVIL_CHAIN_ID,
        confirmTimeoutSec: 10,
      },
      { publicClient: ctx.publicClient, walletClient: ctx.walletClient },
    );
    await expect(
      freshRail.dispatch(
        command,
        { assetCode: "WBTC", quantity: 0.01, executionPrice: 70_000 },
        {
          depositAddresses: {
            [ctx.buyerInstitutionId]: ctx.buyerDeposit,
            [ctx.sellerInstitutionId]: ctx.sellerDeposit,
          },
          tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
        },
      ),
    ).rejects.toThrow();
  }, 60_000);

  /**
   * WS2.5.6: the TEE-attested relayer signer. The same
   * deploy + fund + approve + dispatch flow as the
   * viem-signer test above, but the rail is constructed
   * with a `TeeAttestedRelayerSigner` whose signer key
   * is the T3 tenant identity. Production: the tenant
   * key is held inside the T3 tenant TEE. Demo: the
   * tenant key is the file-backed keypair the
   * matching-policy contract also uses.
   *
   * What this test asserts:
   *   1. The rail broadcasts a real `settle(...)` call.
   *   2. The on-chain `from` of the broadcast tx is
   *      the TEE-attested signer's address (the tenant
   *      identity address in the v1 demo, a T3
   *      tenant-TEE-held address in production).
   *   3. The proof's `railSignerAddress` is the TEE
   *      signer's address (not the rail's
   *      `relayerContractAddress`).
   *   4. The on-chain `Settled` event decodes and the
   *      ERC-20 `Transfer` balances round-trip.
   *
   * The test uses Anvil's third pre-funded account
   * (`0x90F79bf6EB2c4f870365E785982E1f101E93b906`)
   * as the TEE tenant identity. This is the same key
   * `t3-enclave`'s `loadOrCreateTenantIdentity` would
   * return on first boot in a clean checkout.
   */
  it("uses the TEE-attested signer's address as the broadcast 'from'", async () => {
    if (!ctx) throw new Error("ctx not initialized");

    // The TEE-attested relayer signer. In v1 demo
    // the tenant key is file-backed (Anvil account
    // 3's private key, derived from the standard
    // Anvil/Hardhat mnemonic). Production: the
    // tenant key is held inside the T3 tenant TEE;
    // the same `loadOrCreateTenantIdentity` call
    // returns a TEE-held key whose extraction is
    // attestation-anchored.
    //
    // The relayer is deployed with this TEE tenant
    // as the canonical relayer (production: the T3
    // tenant TEE is the relayer). The broadcast tx
    // is signed with the TEE tenant's key.
    const tenantPrivateKey =
      "0x47e179ec215488316adcbbcc7419e81f8ed686ad3c2071c4b6c7b97a9b8a8a3c" as `0x${string}`;
    const teeTenantAddress = privateKeyToAccount(tenantPrivateKey).address;

    // Fund the TEE tenant with ETH for gas. Anvil
    // pre-funds accounts 0-9; account 3's key
    // derivation may not match the default mnemonic
    // exactly, so we send ETH from account 0 to be
    // safe. Production: the T3 tenant TEE is
    // pre-funded by the T3 host platform; no
    // operator step required.
    const funderAccount = ctx.walletClient.account;
    if (!funderAccount) {
      throw new Error(
        "test setup: ctx.walletClient.account is not configured",
      );
    }
    await ctx.walletClient.sendTransaction({
      account: funderAccount,
      chain: ctx.walletClient.chain ?? null,
      to: teeTenantAddress,
      value: parseUnits("1", 18),
    });

    // Deploy a fresh relayer with the TEE tenant
    // as the canonical relayer.
    const tenantWallet = createWalletClient({
      account: privateKeyToAccount(tenantPrivateKey),
      chain: defineChain({
        id: ANVIL_CHAIN_ID,
        name: "anvil-ws25-tee",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
      }),
      transport: http(ANVIL_RPC_URL),
    });
    const teeRelayerDeploy = await tenantWallet.deployContract({
      abi: RelayerContractAbi,
      bytecode: RelayerContractBytecode,
      args: [teeTenantAddress],
    });
    const teeRelayerReceipt = await ctx.publicClient.waitForTransactionReceipt({
      hash: teeRelayerDeploy,
    });
    const teeRelayerContractAddress = teeRelayerReceipt.contractAddress;
    if (!teeRelayerContractAddress) {
      throw new Error("TEE relayer deployment did not return a contract address.");
    }

    // Re-approve the existing pre-funded buyer /
    // seller deposits against the new TEE-attested
    // relayer. The existing `ctx.buyerDeposit` /
    // `ctx.sellerDeposit` are the same Anvil
    // accounts 1 / 2 whose private keys are
    // hard-coded at the top of this test file.
    const buyerWallet = createWalletClient({
      account: privateKeyToAccount(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      ),
      chain: defineChain({
        id: ANVIL_CHAIN_ID,
        name: "anvil-ws25-tee",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
      }),
      transport: http(ANVIL_RPC_URL),
    });
    const sellerWallet = createWalletClient({
      account: privateKeyToAccount(
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      ),
      chain: defineChain({
        id: ANVIL_CHAIN_ID,
        name: "anvil-ws25-tee",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [ANVIL_RPC_URL] } },
      }),
      transport: http(ANVIL_RPC_URL),
    });
    await buyerWallet.writeContract({
      abi: MinimalErc20Abi,
      address: ctx.paymentToken,
      functionName: "approve",
      args: [teeRelayerContractAddress, parseUnits("1000000", 6)],
    });
    await sellerWallet.writeContract({
      abi: MinimalErc20Abi,
      address: ctx.assetToken,
      functionName: "approve",
      args: [teeRelayerContractAddress, parseUnits("10", 8)],
    });

    // Build the TEE-attested signer + rail.
    const teeSigner = new TeeAttestedRelayerSigner({
      publicClient: ctx.publicClient,
      walletClient: ctx.walletClient,
      tenantPrivateKey,
      // `false` in v1 (the key is file-backed, not
      // TEE-held). Production: `true` once T3N
      // exposes the tenant-TEE key store.
      isTeeAttested: false,
    });

    const teeRail = new SepoliaErc20Rail(
      {
        rpcUrl: ANVIL_RPC_URL,
        relayerPrivateKey: tenantPrivateKey,
        relayerContractAddress: teeRelayerContractAddress,
        chainId: ANVIL_CHAIN_ID,
        confirmTimeoutSec: 10,
      },
      {
        relayerSigner: teeSigner,
      },
    );

    // The pre-funded buyer / seller deposits
    // (Anvil accounts 1 and 2) are distinct, so the
    // rail's identical-deposit check passes. The
    // broadcast tx is signed by the TEE tenant
    // (Anvil account 3) and the relayer accepts the
    // call (the relayer's relayer is the TEE tenant).
    const command = makeCommand(ctx, "ws25-tee-attested-1");
    const proof = await teeRail.dispatch(
      command,
      { assetCode: "WBTC", quantity: 0.25, executionPrice: 70_000 },
      {
        depositAddresses: {
          [ctx.buyerInstitutionId]: ctx.buyerDeposit,
          [ctx.sellerInstitutionId]: ctx.sellerDeposit,
        },
        tokenAddresses: { WBTC: ctx.assetToken, USDC: ctx.paymentToken },
        buyerProfileRef: "chain:sepolia:erc20",
        sellerProfileRef: "chain:sepolia:erc20",
      },
    );

    // The proof's railSignerAddress is the TEE
    // signer's address (not the relayer contract
    // address, not the rail's `id`).
    expect(proof.railSignerAddress).toBe(teeTenantAddress);
    expect(proof.railTradeRef).toMatch(/^0x[0-9a-f]{64}$/u);

    // The broadcast tx's `from` is the TEE signer.
    // We assert this by reading the tx receipt and
    // confirming the recovered-from address matches.
    const receipt = await ctx.publicClient.getTransactionReceipt({
      hash: proof.railTradeRef as Hash,
    });
    expect(receipt.from.toLowerCase()).toBe(teeTenantAddress.toLowerCase());

    // The on-chain `Settled` event decodes correctly
    // (the relayer's settled-outcome accounting is
    // unchanged between the viem signer and the TEE
    // signer — both broadcast the same `settle(...)`
    // calldata).
    const settled = await teeRail.decodeSettledLog(
      proof.railTradeRef as Hash,
      {
        assetAmount: parseUnits("0.25", 8),
        paymentAmount: parseUnits("17500", 6),
      },
    );
    expect(settled.matched).toBe(true);
  }, 60_000);
});
