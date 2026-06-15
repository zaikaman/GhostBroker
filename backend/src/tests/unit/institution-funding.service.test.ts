import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import { InstitutionFundingService } from "../../services/institution-funding.service.js";
import type { InstitutionRepository } from "../../services/institution.service.js";
import type { Institution } from "../../models/institution.js";
import type { DepositWalletService } from "../../services/deposit-wallet.service.js";

const WBTC = "0x29f2D40B0605204364af54EC677bD022dA425d03" as Address;
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as Address;
const RELAYER_CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Address;
const FAUCET_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAYER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const DEPOSIT =
  "0x1111111111111111111111111111111111111111" as Address;

function chainInstitution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    legalName: "Northstar",
    displayName: "Northstar",
    status: "active",
    t3TenantDid: "did:t3n:tenant:northstar",
    settlementProfileRef: "chain:sepolia:erc20",
    metadata: { depositAddress: DEPOSIT, tokenAddresses: { WBTC, USDC } },
    ...overrides,
  };
}

function makeRepository(institution: Institution | null): InstitutionRepository {
  return {
    createInstitution: async () => {
      throw new Error("not used");
    },
    findByTenantDid: async () => null,
    findById: async () => institution,
  };
}

const depositWalletService: DepositWalletService = {
  deriveDepositPrivateKey: () => RELAYER_KEY,
  deriveDepositAddress: () => DEPOSIT,
};

interface CapturedCall {
  fn: string;
  args?: readonly unknown[];
  to?: Address;
  value?: bigint;
  address?: Address;
}

function makeClients(opts: {
  balances: { eth: bigint; wbtc: bigint; usdc: bigint };
  allowances: { wbtc: bigint; usdc: bigint };
  decimals: { wbtc: number; usdc: number };
}) {
  const calls: CapturedCall[] = [];
  const tokenBalance = (address: Address): bigint =>
    address.toLowerCase() === WBTC.toLowerCase() ? opts.balances.wbtc : opts.balances.usdc;
  const tokenDecimals = (address: Address): number =>
    address.toLowerCase() === WBTC.toLowerCase() ? opts.decimals.wbtc : opts.decimals.usdc;
  const tokenAllowance = (address: Address): bigint =>
    address.toLowerCase() === WBTC.toLowerCase() ? opts.allowances.wbtc : opts.allowances.usdc;

  const publicClient = {
    getBalance: async () => opts.balances.eth,
    readContract: async (args: {
      address: Address;
      functionName: string;
    }) => {
      if (args.functionName === "decimals") return tokenDecimals(args.address);
      if (args.functionName === "balanceOf") return tokenBalance(args.address);
      if (args.functionName === "allowance") return tokenAllowance(args.address);
      throw new Error(`unexpected read ${args.functionName}`);
    },
  };

  const faucetWalletClient = {
    sendTransaction: async (args: { to: Address; value: bigint }) => {
      calls.push({ fn: "sendTransaction", to: args.to, value: args.value });
      return ("0x" + "a".repeat(64)) as Hash;
    },
    writeContract: async (args: {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    }) => {
      calls.push({ fn: args.functionName, address: args.address, args: args.args });
      return ("0x" + "b".repeat(64)) as Hash;
    },
  };

  return { publicClient, faucetWalletClient, calls };
}

function makeService(
  repository: InstitutionRepository,
  clients: ReturnType<typeof makeClients>,
): InstitutionFundingService {
  return new InstitutionFundingService({
    institutionRepository: repository,
    depositWalletService,
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31337,
    faucetPrivateKey: FAUCET_KEY,
    relayerContractAddress: RELAYER_CONTRACT,
    relayerPrivateKey: RELAYER_KEY,
    wbtcAddress: WBTC,
    usdcAddress: USDC,
    defaultFunding: { eth: "0.5", wbtc: "0.1", usdc: "1000" },
    publicClient: clients.publicClient as never,
    faucetWalletClient: clients.faucetWalletClient as never,
  });
}

describe("InstitutionFundingService", () => {
  it("tops up assets when balances are empty", async () => {
    const clients = makeClients({
      balances: { eth: 0n, wbtc: 0n, usdc: 0n },
      allowances: {
        wbtc: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        usdc: BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
      },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(chainInstitution()), clients);

    const result = await service.fundInstitution("00000000-0000-4000-8000-0000000000f1");

    expect(result.depositAddress).toBe(DEPOSIT);
    expect(result.txHashes.ethTopUp).toBeDefined();
    expect(result.txHashes.wbtcTopUp).toBeDefined();
    expect(result.txHashes.usdcTopUp).toBeDefined();
    expect(result.txHashes.wbtcApprove).toBeUndefined();
    expect(result.txHashes.usdcApprove).toBeUndefined();
  });

  it("does not top up when balances already meet the target and approvals exist", async () => {
    const MAX = BigInt(
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    const clients = makeClients({
      balances: {
        eth: 10n ** 18n, // 1 ETH > 0.5 target
        wbtc: 10n ** 8n, // 1 WBTC > 0.1 target
        usdc: 10_000n * 10n ** 6n, // 10000 USDC > 1000 target
      },
      allowances: { wbtc: MAX, usdc: MAX },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(chainInstitution()), clients);

    const result = await service.fundInstitution("00000000-0000-4000-8000-0000000000f1");

    expect(result.txHashes.ethTopUp).toBeUndefined();
    expect(result.txHashes.wbtcTopUp).toBeUndefined();
    expect(result.txHashes.usdcTopUp).toBeUndefined();
    expect(result.txHashes.wbtcApprove).toBeUndefined();
    expect(result.txHashes.usdcApprove).toBeUndefined();
    expect(clients.calls).toHaveLength(0);
  });

  it("rejects an institution that is not on the chain rail", async () => {
    const clients = makeClients({
      balances: { eth: 0n, wbtc: 0n, usdc: 0n },
      allowances: { wbtc: 0n, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(
      makeRepository(chainInstitution({ settlementProfileRef: "wallet:default" })),
      clients,
    );

    await expect(
      service.fundInstitution("00000000-0000-4000-8000-0000000000f1"),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an unknown institution with a 404", async () => {
    const clients = makeClients({
      balances: { eth: 0n, wbtc: 0n, usdc: 0n },
      allowances: { wbtc: 0n, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(null), clients);

    await expect(
      service.fundInstitution("00000000-0000-4000-8000-0000000000f1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
