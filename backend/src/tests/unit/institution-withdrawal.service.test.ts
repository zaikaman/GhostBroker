import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { InstitutionWithdrawalService } from "../../services/institution-withdrawal.service.js";
import type { InstitutionRepository } from "../../services/institution.service.js";
import type { Institution } from "../../models/institution.js";
import type { DepositWalletService } from "../../services/deposit-wallet.service.js";

const WBTC = "0x29f2D40B0605204364af54EC677bD022dA425d03" as Address;
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as Address;
// A real Sepolia funded test key (anvil acct 1). The derived
// address is deterministic; the withdrawal service signs with it.
const DEPOSIT_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const DEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;

function chainInstitution(overrides: Partial<Institution> = {}): Institution {
  return {
    id: "00000000-0000-4000-8000-0000000000f2",
    legalName: "Northstar",
    displayName: "Northstar",
    status: "active",
    t3TenantDid: "did:t3n:tenant:northstar",
    settlementProfileRef: "chain:sepolia:erc20",
    metadata: {},
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
  deriveDepositPrivateKey: () => DEPOSIT_KEY,
  deriveDepositAddress: () => DEST,
};

function makeClients(opts: {
  ethBalance: bigint;
  tokenBalance: bigint;
  decimals: number;
}) {
  const calls: { fn: string; args?: readonly unknown[] }[] = [];
  const publicClient = {
    getBalance: async () => opts.ethBalance,
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === "decimals") return opts.decimals;
      if (args.functionName === "balanceOf") return opts.tokenBalance;
      throw new Error(`unexpected read ${args.functionName}`);
    },
  };
  return { publicClient, calls };
}

function makeService(
  repository: InstitutionRepository,
  clients: ReturnType<typeof makeClients>,
): InstitutionWithdrawalService {
  return new InstitutionWithdrawalService({
    institutionRepository: repository,
    depositWalletService,
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31337,
    wbtcAddress: WBTC,
    usdcAddress: USDC,
    publicClient: clients.publicClient as never,
  });
}

describe("InstitutionWithdrawalService", () => {
  it("rejects a malformed destination address", async () => {
    const clients = makeClients({ ethBalance: 10n ** 18n, tokenBalance: 0n, decimals: 8 });
    const service = makeService(makeRepository(chainInstitution()), clients);

    await expect(
      service.withdraw("00000000-0000-4000-8000-0000000000f2", {
        asset: "ETH",
        amount: "0.1",
        toAddress: "0xnot-an-address" as Address,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a non-positive amount", async () => {
    const clients = makeClients({ ethBalance: 10n ** 18n, tokenBalance: 0n, decimals: 8 });
    const service = makeService(makeRepository(chainInstitution()), clients);

    await expect(
      service.withdraw("00000000-0000-4000-8000-0000000000f2", {
        asset: "ETH",
        amount: "0",
        toAddress: DEST,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a token withdrawal exceeding the deposit-wallet balance", async () => {
    const clients = makeClients({
      ethBalance: 10n ** 18n,
      tokenBalance: 5n * 10n ** 7n, // 0.5 WBTC
      decimals: 8,
    });
    const service = makeService(makeRepository(chainInstitution()), clients);

    await expect(
      service.withdraw("00000000-0000-4000-8000-0000000000f2", {
        asset: "WBTC",
        amount: "1", // 1 WBTC > 0.5 balance
        toAddress: DEST,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an ETH withdrawal at or above the full balance (no gas headroom)", async () => {
    const clients = makeClients({ ethBalance: 10n ** 18n, tokenBalance: 0n, decimals: 8 });
    const service = makeService(makeRepository(chainInstitution()), clients);

    await expect(
      service.withdraw("00000000-0000-4000-8000-0000000000f2", {
        asset: "ETH",
        amount: "1", // == balance
        toAddress: DEST,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects an institution that is not on the chain rail", async () => {
    const clients = makeClients({ ethBalance: 10n ** 18n, tokenBalance: 0n, decimals: 8 });
    const service = makeService(
      makeRepository(chainInstitution({ settlementProfileRef: "wallet:default" })),
      clients,
    );

    await expect(
      service.withdraw("00000000-0000-4000-8000-0000000000f2", {
        asset: "ETH",
        amount: "0.1",
        toAddress: DEST,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
