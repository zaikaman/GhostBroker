import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PublicError } from "../errors/public-error.js";
import type { InstitutionRepository } from "./institution.service.js";
import type { DepositWalletService } from "./deposit-wallet.service.js";
import { Erc20Abi } from "./settlement-rails/erc20-abi.js";

export interface RelayerApprovalResponse {
  depositAddress: Address;
  relayerContractAddress: Address;
  txHashes: {
    wbtcApprove?: Hash;
    usdcApprove?: Hash;
  };
  balances: {
    eth: string;
    wbtc: string;
    usdc: string;
  };
  approved: {
    wbtc: boolean;
    usdc: boolean;
  };
}

export interface InstitutionApprovalServiceDeps {
  institutionRepository: InstitutionRepository;
  depositWalletService: DepositWalletService;
  rpcUrl: string;
  chainId: number;
  relayerContractAddress: Address;
  wbtcAddress: Address;
  usdcAddress: Address;
  publicClient?: ApprovalPublicClient;
  makeWalletClient?: (
    account: ReturnType<typeof privateKeyToAccount>,
  ) => ApprovalWalletClient;
}

interface ApprovalPublicClient {
  getBalance(args: { address: Address }): Promise<bigint>;
  readContract(args: {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "decimals";
  } | {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "balanceOf";
    args: [Address];
  } | {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "allowance";
    args: [Address, Address];
  }): Promise<number | bigint>;
}

interface ApprovalWalletClient {
  writeContract(args: {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "approve";
    args: readonly unknown[];
    chain: ReturnType<typeof defineChain>;
    account: ReturnType<typeof privateKeyToAccount>;
  }): Promise<Hash>;
}

const MAX_UINT256 = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
);
const APPROVAL_THRESHOLD = MAX_UINT256 / 2n;

export class InstitutionApprovalService {
  private readonly institutionRepository: InstitutionRepository;
  private readonly depositWalletService: DepositWalletService;
  private readonly publicClient: ApprovalPublicClient;
  private readonly rpcUrl: string;
  private readonly chain: ReturnType<typeof defineChain>;
  private readonly relayerContractAddress: Address;
  private readonly wbtcAddress: Address;
  private readonly usdcAddress: Address;
  private readonly makeWalletClient:
    | ((account: ReturnType<typeof privateKeyToAccount>) => ApprovalWalletClient)
    | undefined;

  public constructor(deps: InstitutionApprovalServiceDeps) {
    this.institutionRepository = deps.institutionRepository;
    this.depositWalletService = deps.depositWalletService;
    this.relayerContractAddress = deps.relayerContractAddress;
    this.wbtcAddress = deps.wbtcAddress;
    this.usdcAddress = deps.usdcAddress;
    this.rpcUrl = deps.rpcUrl;
    this.makeWalletClient = deps.makeWalletClient;
    this.chain = defineChain({
      id: deps.chainId,
      name: deps.chainId === 11155111 ? "Sepolia" : `chain-${deps.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [deps.rpcUrl] } },
    });
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({
        chain: this.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as ApprovalPublicClient);
  }

  public async approveRelayer(
    institutionId: string,
  ): Promise<RelayerApprovalResponse> {
    const institution = await this.requireChainRailInstitution(institutionId);
    const depositAddress = this.depositWalletService.deriveDepositAddress(
      institution.t3TenantDid,
    );
    const depositPrivateKey = this.depositWalletService.deriveDepositPrivateKey(
      institution.t3TenantDid,
    );
    const account = privateKeyToAccount(depositPrivateKey);
    const walletClient =
      this.makeWalletClient?.(account) ??
      (createWalletClient({
        account,
        chain: this.chain,
        transport: http(this.rpcUrl),
      }) as unknown as ApprovalWalletClient);

    const txHashes: RelayerApprovalResponse["txHashes"] = {};

    const wbtcAllowance = await this.readAllowance(this.wbtcAddress, depositAddress);
    if (wbtcAllowance < APPROVAL_THRESHOLD) {
      txHashes.wbtcApprove = await this.writeApproval(
        walletClient,
        account,
        depositAddress,
        this.wbtcAddress,
        "WBTC",
      );
    }

    const usdcAllowance = await this.readAllowance(this.usdcAddress, depositAddress);
    if (usdcAllowance < APPROVAL_THRESHOLD) {
      txHashes.usdcApprove = await this.writeApproval(
        walletClient,
        account,
        depositAddress,
        this.usdcAddress,
        "USDC",
      );
    }

    return {
      depositAddress,
      relayerContractAddress: this.relayerContractAddress,
      txHashes,
      ...(await this.readDepositStatus(depositAddress)),
    };
  }

  public async getDepositStatus(
    institutionId: string,
  ): Promise<RelayerApprovalResponse> {
    const institution = await this.requireChainRailInstitution(institutionId);
    const depositAddress = this.depositWalletService.deriveDepositAddress(
      institution.t3TenantDid,
    );
    return {
      depositAddress,
      relayerContractAddress: this.relayerContractAddress,
      txHashes: {},
      ...(await this.readDepositStatus(depositAddress)),
    };
  }

  private async requireChainRailInstitution(institutionId: string) {
    const institution = await this.institutionRepository.findById(institutionId);
    if (!institution) {
      throw new PublicError("not_found", 404, "Institution not found");
    }
    if (institution.settlementProfileRef !== "chain:sepolia:erc20") {
      throw new PublicError(
        "validation_failed",
        422,
        "Institution is not configured for the chain rail.",
      );
    }
    return institution;
  }

  private async readDepositStatus(
    depositAddress: Address,
  ): Promise<Pick<RelayerApprovalResponse, "balances" | "approved">> {
    const [eth, wbtcDecimals, usdcDecimals] = await Promise.all([
      this.publicClient.getBalance({ address: depositAddress }),
      this.readDecimals(this.wbtcAddress),
      this.readDecimals(this.usdcAddress),
    ]);
    const [wbtcBalance, usdcBalance, wbtcAllowance, usdcAllowance] =
      await Promise.all([
        this.readBalance(this.wbtcAddress, depositAddress),
        this.readBalance(this.usdcAddress, depositAddress),
        this.readAllowance(this.wbtcAddress, depositAddress),
        this.readAllowance(this.usdcAddress, depositAddress),
      ]);
    return {
      balances: {
        eth: formatUnits(eth, 18),
        wbtc: formatUnits(wbtcBalance, wbtcDecimals),
        usdc: formatUnits(usdcBalance, usdcDecimals),
      },
      approved: {
        wbtc: wbtcAllowance >= APPROVAL_THRESHOLD,
        usdc: usdcAllowance >= APPROVAL_THRESHOLD,
      },
    };
  }

  private async readDecimals(tokenAddress: Address): Promise<number> {
    return Number(
      await this.publicClient.readContract({
        abi: Erc20Abi,
        address: tokenAddress,
        functionName: "decimals",
      }),
    );
  }

  private async readBalance(
    tokenAddress: Address,
    owner: Address,
  ): Promise<bigint> {
    return (await this.publicClient.readContract({
      abi: Erc20Abi,
      address: tokenAddress,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  }

  private async readAllowance(
    tokenAddress: Address,
    owner: Address,
  ): Promise<bigint> {
    return (await this.publicClient.readContract({
      abi: Erc20Abi,
      address: tokenAddress,
      functionName: "allowance",
      args: [owner, this.relayerContractAddress],
    })) as bigint;
  }

  private async writeApproval(
    walletClient: ApprovalWalletClient,
    account: ReturnType<typeof privateKeyToAccount>,
    depositAddress: Address,
    tokenAddress: Address,
    tokenSymbol: "WBTC" | "USDC",
  ): Promise<Hash> {
    try {
      return await walletClient.writeContract({
        abi: Erc20Abi,
        address: tokenAddress,
        functionName: "approve",
        args: [this.relayerContractAddress, MAX_UINT256],
        chain: this.chain,
        account,
      });
    } catch (error) {
      if (isInsufficientFundsForApproval(error)) {
        const ethBalance = await this.publicClient.getBalance({ address: depositAddress });
        throw new PublicError(
          "validation_failed",
          422,
          undefined,
          `Deposit wallet ${depositAddress} needs Sepolia ETH for gas before ${tokenSymbol} relayer approval can be submitted. Current ETH balance: ${formatUnits(ethBalance, 18)}.`,
        );
      }
      throw error;
    }
  }
}

function isInsufficientFundsForApproval(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("insufficient funds") ||
    message.includes("exceeds the balance of the account") ||
    message.includes("insufficient funds for transfer")
  );
}
