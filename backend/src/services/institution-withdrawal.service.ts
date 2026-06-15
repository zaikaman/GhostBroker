import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PublicError } from "../errors/public-error.js";
import type { InstitutionRepository } from "./institution.service.js";
import type { DepositWalletService } from "./deposit-wallet.service.js";
import { Erc20Abi } from "./settlement-rails/erc20-abi.js";

export type WithdrawalAsset = "ETH" | "WBTC" | "USDC";

export interface InstitutionWithdrawalRequest {
  asset: WithdrawalAsset;
  amount: string;
  toAddress: Address;
}

export interface InstitutionWithdrawalResponse {
  asset: WithdrawalAsset;
  amount: string;
  fromAddress: Address;
  toAddress: Address;
  txHash: Hash;
  remainingBalance: string;
}

export interface InstitutionWithdrawalServiceDeps {
  institutionRepository: InstitutionRepository;
  depositWalletService: DepositWalletService;
  rpcUrl: string;
  chainId: number;
  wbtcAddress: Address;
  usdcAddress: Address;
  publicClient?: WithdrawalPublicClient;
}

interface WithdrawalPublicClient {
  getBalance(args: { address: Address }): Promise<bigint>;
  readContract(args: {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "decimals";
  }): Promise<number>;
  readContract(args: {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "balanceOf";
    args: [Address];
  }): Promise<bigint>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

export class InstitutionWithdrawalService {
  private readonly institutionRepository: InstitutionRepository;
  private readonly depositWalletService: DepositWalletService;
  private readonly publicClient: WithdrawalPublicClient;
  private readonly rpcUrl: string;
  private readonly chain: ReturnType<typeof defineChain>;
  private readonly wbtcAddress: Address;
  private readonly usdcAddress: Address;

  public constructor(deps: InstitutionWithdrawalServiceDeps) {
    this.institutionRepository = deps.institutionRepository;
    this.depositWalletService = deps.depositWalletService;
    this.rpcUrl = deps.rpcUrl;
    this.wbtcAddress = deps.wbtcAddress;
    this.usdcAddress = deps.usdcAddress;
    this.chain = defineChain({
      id: deps.chainId,
      name: deps.chainId === 11155111 ? "Sepolia" : `chain-${deps.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [deps.rpcUrl] } },
    });
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({ chain: this.chain, transport: http(deps.rpcUrl) }) as unknown as WithdrawalPublicClient);
  }

  public async withdraw(
    institutionId: string,
    request: InstitutionWithdrawalRequest,
  ): Promise<InstitutionWithdrawalResponse> {
    if (!ADDRESS_RE.test(request.toAddress)) {
      throw new PublicError(
        "validation_failed",
        400,
        "Withdrawal destination must be a 0x-prefixed 40-hex address.",
      );
    }
    if (!/^\d+(\.\d+)?$/u.test(request.amount) || Number(request.amount) <= 0) {
      throw new PublicError(
        "validation_failed",
        400,
        "Withdrawal amount must be a positive decimal string.",
      );
    }

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

    const depositPrivateKey = this.depositWalletService.deriveDepositPrivateKey(
      institution.t3TenantDid,
    );
    const account = privateKeyToAccount(depositPrivateKey);
    const fromAddress = account.address;
    const depositWallet = createWalletClient({
      account,
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    if (request.asset === "ETH") {
      const value = parseEther(request.amount);
      const balance = await this.publicClient.getBalance({ address: fromAddress });
      if (value >= balance) {
        throw new PublicError(
          "validation_failed",
          422,
          `Withdrawal amount exceeds the deposit wallet's ETH balance (${formatUnits(balance, 18)} ETH). Leave headroom for gas.`,
        );
      }
      const txHash = await depositWallet.sendTransaction({
        account,
        chain: this.chain,
        to: request.toAddress,
        value,
      });
      const remaining = await this.publicClient.getBalance({ address: fromAddress });
      return {
        asset: "ETH",
        amount: request.amount,
        fromAddress,
        toAddress: request.toAddress,
        txHash,
        remainingBalance: formatUnits(remaining, 18),
      };
    }

    const tokenAddress = request.asset === "WBTC" ? this.wbtcAddress : this.usdcAddress;
    const decimals = await this.readTokenDecimals(tokenAddress);
    const amount = parseUnits(request.amount, decimals);
    const balance = await this.readTokenBalance(tokenAddress, fromAddress);
    if (amount > balance) {
      throw new PublicError(
        "validation_failed",
        422,
        `Withdrawal amount exceeds the deposit wallet's ${request.asset} balance (${formatUnits(balance, decimals)} ${request.asset}).`,
      );
    }
    const txHash = await depositWallet.writeContract({
      abi: Erc20Abi,
      address: tokenAddress,
      functionName: "transfer",
      args: [request.toAddress, amount],
      chain: this.chain,
      account,
    });
    const remaining = await this.readTokenBalance(tokenAddress, fromAddress);
    return {
      asset: request.asset,
      amount: request.amount,
      fromAddress,
      toAddress: request.toAddress,
      txHash,
      remainingBalance: formatUnits(remaining, decimals),
    };
  }

  private async readTokenDecimals(tokenAddress: Address): Promise<number> {
    const decimals = (await this.publicClient.readContract({
      abi: Erc20Abi,
      address: tokenAddress,
      functionName: "decimals",
    })) as number;
    return Number(decimals);
  }

  private async readTokenBalance(
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
}
