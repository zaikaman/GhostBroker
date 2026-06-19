import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import { InstitutionApprovalService } from "../../services/institution-approval.service.js";
import type { InstitutionRepository } from "../../services/institution.service.js";
import type { Institution } from "../../models/institution.js";
import type { DepositWalletService } from "../../services/deposit-wallet.service.js";

const WBTC = "0x29f2D40B0605204364af54EC677bD022dA425d03" as Address;
const USDC = "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8" as Address;
const RELAYER_CONTRACT = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as Address;
const DEPOSIT_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const DEPOSIT = "0x1111111111111111111111111111111111111111" as Address;

const MAX = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
);

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
  deriveDepositPrivateKey: () => DEPOSIT_KEY,
  deriveDepositAddress: () => DEPOSIT,
};

interface CapturedCall {
  fn: string;
  address?: Address;
  args?: readonly unknown[];
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
    readContract: async (args: { address: Address; functionName: string }) => {
      if (args.functionName === "decimals") return tokenDecimals(args.address);
      if (args.functionName === "balanceOf") return tokenBalance(args.address);
      if (args.functionName === "allowance") return tokenAllowance(args.address);
      throw new Error(`unexpected read ${args.functionName}`);
    },
  };

  const walletClient = {
    writeContract: async (args: {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    }) => {
      calls.push({ fn: args.functionName, address: args.address, args: args.args });
      return ("0x" + "b".repeat(64)) as Hash;
    },
  };

  return { publicClient, walletClient, calls };
}

function makeService(
  repository: InstitutionRepository,
  clients: ReturnType<typeof makeClients>,
): InstitutionApprovalService {
  return new InstitutionApprovalService({
    institutionRepository: repository,
    depositWalletService,
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31337,
    relayerContractAddress: RELAYER_CONTRACT,
    wbtcAddress: WBTC,
    usdcAddress: USDC,
    publicClient: clients.publicClient as never,
    makeWalletClient: () => clients.walletClient as never,
  });
}

describe("InstitutionApprovalService", () => {
  it("approves the relayer for both tokens when no allowance exists", async () => {
    const clients = makeClients({
      balances: { eth: 10n ** 17n, wbtc: 0n, usdc: 0n },
      allowances: { wbtc: 0n, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(chainInstitution()), clients);

    const result = await service.approveRelayer("00000000-0000-4000-8000-0000000000f1");

    expect(result.depositAddress).toBe(DEPOSIT);
    expect(result.relayerContractAddress).toBe(RELAYER_CONTRACT);
    expect(result.txHashes.wbtcApprove).toBeDefined();
    expect(result.txHashes.usdcApprove).toBeDefined();
    const approveCalls = clients.calls.filter((c) => c.fn === "approve");
    expect(approveCalls).toHaveLength(2);
    expect(approveCalls[0]?.args?.[0]).toBe(RELAYER_CONTRACT);
    expect(approveCalls[0]?.args?.[1]).toBe(MAX);
  });

  it("does not re-approve when allowance already exists", async () => {
    const clients = makeClients({
      balances: { eth: 10n ** 17n, wbtc: 10n ** 8n, usdc: 1000n * 10n ** 6n },
      allowances: { wbtc: MAX, usdc: MAX },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(chainInstitution()), clients);

    const result = await service.approveRelayer("00000000-0000-4000-8000-0000000000f1");

    expect(result.txHashes.wbtcApprove).toBeUndefined();
    expect(result.txHashes.usdcApprove).toBeUndefined();
    expect(clients.calls.filter((c) => c.fn === "approve")).toHaveLength(0);
    expect(result.approved.wbtc).toBe(true);
    expect(result.approved.usdc).toBe(true);
  });

  it("reports deposit status with balances and approval flags", async () => {
    const clients = makeClients({
      balances: { eth: 5n * 10n ** 17n, wbtc: 25n * 10n ** 6n, usdc: 250n * 10n ** 6n },
      allowances: { wbtc: MAX, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(chainInstitution()), clients);

    const result = await service.getDepositStatus("00000000-0000-4000-8000-0000000000f1");

    expect(result.depositAddress).toBe(DEPOSIT);
    expect(result.balances.eth).toBe("0.5");
    expect(result.balances.usdc).toBe("250");
    expect(result.approved.wbtc).toBe(true);
    expect(result.approved.usdc).toBe(false);
    expect(clients.calls.filter((c) => c.fn === "approve")).toHaveLength(0);
  });

  it("rejects an institution with a non-chain-rail settlement profile", async () => {
    // GhostBroker exposes a single settlement rail
    // (`chain:sepolia:erc20`); the approval service rejects
    // any other profile since relayer approvals only make
    // sense for the on-chain rail.
    const clients = makeClients({
      balances: { eth: 0n, wbtc: 0n, usdc: 0n },
      allowances: { wbtc: 0n, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(
      makeRepository(chainInstitution({ settlementProfileRef: "settlement-profile:legacy" })),
      clients,
    );

    await expect(
      service.approveRelayer("00000000-0000-4000-8000-0000000000f1"),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("returns a validation error when the deposit wallet lacks ETH for approval gas", async () => {
    const clients = makeClients({
      balances: { eth: 0n, wbtc: 0n, usdc: 0n },
      allowances: { wbtc: 0n, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const walletClient = {
      writeContract: async () => {
        throw new Error("insufficient funds for transfer");
      },
    };
    const service = new InstitutionApprovalService({
      institutionRepository: makeRepository(chainInstitution()),
      depositWalletService,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      relayerContractAddress: RELAYER_CONTRACT,
      wbtcAddress: WBTC,
      usdcAddress: USDC,
      publicClient: clients.publicClient as never,
      makeWalletClient: () => walletClient as never,
    });

    await expect(
      service.approveRelayer("00000000-0000-4000-8000-0000000000f1"),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "validation_failed",
      message: `Deposit wallet ${DEPOSIT} needs Sepolia ETH for gas before WBTC relayer approval can be submitted. Current ETH balance: 0.`,
    });
  });

  it("rejects an unknown institution with a 404", async () => {
    const clients = makeClients({
      balances: { eth: 0n, wbtc: 0n, usdc: 0n },
      allowances: { wbtc: 0n, usdc: 0n },
      decimals: { wbtc: 8, usdc: 6 },
    });
    const service = makeService(makeRepository(null), clients);

    await expect(
      service.getDepositStatus("00000000-0000-4000-8000-0000000000f1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
