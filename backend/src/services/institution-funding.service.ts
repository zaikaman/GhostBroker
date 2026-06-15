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
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PublicError } from "../errors/public-error.js";
import type { InstitutionRepository } from "./institution.service.js";
import type { DepositWalletService } from "./deposit-wallet.service.js";
import { Erc20Abi } from "./settlement-rails/erc20-abi.js";

export interface InstitutionFundingRequest {
  ethAmount?: string;
  wbtcAmount?: string;
  usdcAmount?: string;
}

export interface InstitutionFundingResponse {
  depositAddress: Address;
  relayerAddress: Address;
  txHashes: {
    ethTopUp?: Hash;
    wbtcTopUp?: Hash;
    usdcTopUp?: Hash;
    wbtcApprove?: Hash;
    usdcApprove?: Hash;
  };
  balances: {
    eth: string;
    wbtc: string;
    usdc: string;
  };
}

export interface InstitutionFundingServiceDeps {
  institutionRepository: InstitutionRepository;
  depositWalletService: DepositWalletService;
  rpcUrl: string;
  chainId: number;
  faucetPrivateKey: Hex;
  relayerContractAddress: Address;
  relayerPrivateKey: Hex;
  wbtcAddress: Address;
  usdcAddress: Address;
  defaultFunding: {
    eth: string;
    wbtc: string;
    usdc: string;
  };
  publicClient?: FundingPublicClient;
  faucetWalletClient?: FundingWalletClient;
}

interface FundingPublicClient {
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
  readContract(args: {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "allowance";
    args: [Address, Address];
  }): Promise<bigint>;
}

interface FundingWalletClient {
  sendTransaction(args: {
    account: ReturnType<typeof privateKeyToAccount>;
    chain: ReturnType<typeof defineChain>;
    to: Address;
    value: bigint;
  }): Promise<Hash>;
  writeContract(args: {
    abi: typeof Erc20Abi;
    address: Address;
    functionName: "transfer" | "approve";
    args: readonly unknown[];
    chain: ReturnType<typeof defineChain>;
    account: ReturnType<typeof privateKeyToAccount>;
  }): Promise<Hash>;
}

const MAX_UINT256 = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
);

export class InstitutionFundingService {
  private readonly institutionRepository: InstitutionRepository;
  private readonly depositWalletService: DepositWalletService;
  private readonly publicClient: FundingPublicClient;
  private readonly faucetWalletClient: FundingWalletClient;
  private readonly chain: ReturnType<typeof defineChain>;
  private readonly faucetAccount: ReturnType<typeof privateKeyToAccount>;
  private readonly relayerAddress: Address;
  private readonly relayerContractAddress: Address;
  private readonly wbtcAddress: Address;
  private readonly usdcAddress: Address;
  private readonly defaultFunding: {
    eth: string;
    wbtc: string;
    usdc: string;
  };
  private readonly rpcUrl: string;

  public constructor(deps: InstitutionFundingServiceDeps) {
    this.institutionRepository = deps.institutionRepository;
    this.depositWalletService = deps.depositWalletService;
    this.relayerContractAddress = deps.relayerContractAddress;
    this.wbtcAddress = deps.wbtcAddress;
    this.usdcAddress = deps.usdcAddress;
    this.defaultFunding = deps.defaultFunding;
    this.faucetAccount = privateKeyToAccount(deps.faucetPrivateKey);
    this.relayerAddress = privateKeyToAccount(deps.relayerPrivateKey).address;
    this.rpcUrl = deps.rpcUrl;
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
      }) as unknown as FundingPublicClient);
    this.faucetWalletClient =
      deps.faucetWalletClient ??
      (createWalletClient({
        account: this.faucetAccount,
        chain: this.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as FundingWalletClient);
  }

  public async fundInstitution(
    institutionId: string,
    request: InstitutionFundingRequest = {},
  ): Promise<InstitutionFundingResponse> {
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

    const depositAddress = this.depositWalletService.deriveDepositAddress(
      institution.t3TenantDid,
    );
    const depositPrivateKey = this.depositWalletService.deriveDepositPrivateKey(
      institution.t3TenantDid,
    );
    const depositWallet = createWalletClient({
      account: privateKeyToAccount(depositPrivateKey),
      chain: this.chain,
      transport: http(this.rpcUrl),
    });

    const targetEth = parseEther(request.ethAmount ?? this.defaultFunding.eth);
    const targetWbtc = parseUnits(
      request.wbtcAmount ?? this.defaultFunding.wbtc,
      await this.readTokenDecimals(this.wbtcAddress),
    );
    const targetUsdc = parseUnits(
      request.usdcAmount ?? this.defaultFunding.usdc,
      await this.readTokenDecimals(this.usdcAddress),
    );

    const currentEth = await this.publicClient.getBalance({ address: depositAddress });
    const currentWbtc = await this.readTokenBalance(this.wbtcAddress, depositAddress);
    const currentUsdc = await this.readTokenBalance(this.usdcAddress, depositAddress);

    const txHashes: InstitutionFundingResponse["txHashes"] = {};

    if (currentEth < targetEth) {
      txHashes.ethTopUp = await this.faucetWalletClient.sendTransaction({
        account: this.faucetAccount,
        chain: this.chain,
        to: depositAddress,
        value: targetEth - currentEth,
      });
    }
    if (currentWbtc < targetWbtc) {
      txHashes.wbtcTopUp = await this.faucetWalletClient.writeContract({
        abi: Erc20Abi,
        address: this.wbtcAddress,
        functionName: "transfer",
        args: [depositAddress, targetWbtc - currentWbtc],
        chain: this.chain,
        account: this.faucetAccount,
      });
    }
    if (currentUsdc < targetUsdc) {
      txHashes.usdcTopUp = await this.faucetWalletClient.writeContract({
        abi: Erc20Abi,
        address: this.usdcAddress,
        functionName: "transfer",
        args: [depositAddress, targetUsdc - currentUsdc],
        chain: this.chain,
        account: this.faucetAccount,
      });
    }

    const currentWbtcAllowance = await this.readTokenAllowance(
      this.wbtcAddress,
      depositAddress,
      this.relayerContractAddress,
    );
    if (currentWbtcAllowance < MAX_UINT256 / 2n) {
      txHashes.wbtcApprove = await depositWallet.writeContract({
        abi: Erc20Abi,
        address: this.wbtcAddress,
        functionName: "approve",
        args: [this.relayerContractAddress, MAX_UINT256],
        chain: this.chain,
        account: privateKeyToAccount(depositPrivateKey),
      });
    }

    const currentUsdcAllowance = await this.readTokenAllowance(
      this.usdcAddress,
      depositAddress,
      this.relayerContractAddress,
    );
    if (currentUsdcAllowance < MAX_UINT256 / 2n) {
      txHashes.usdcApprove = await depositWallet.writeContract({
        abi: Erc20Abi,
        address: this.usdcAddress,
        functionName: "approve",
        args: [this.relayerContractAddress, MAX_UINT256],
        chain: this.chain,
        account: privateKeyToAccount(depositPrivateKey),
      });
    }

    const finalEth = await this.publicClient.getBalance({ address: depositAddress });
    const finalWbtc = await this.readTokenBalance(this.wbtcAddress, depositAddress);
    const finalUsdc = await this.readTokenBalance(this.usdcAddress, depositAddress);

    return {
      depositAddress,
      relayerAddress: this.relayerAddress,
      txHashes,
      balances: {
        eth: formatUnits(finalEth, 18),
        wbtc: formatUnits(
          finalWbtc,
          await this.readTokenDecimals(this.wbtcAddress),
        ),
        usdc: formatUnits(
          finalUsdc,
          await this.readTokenDecimals(this.usdcAddress),
        ),
      },
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

  private async readTokenAllowance(
    tokenAddress: Address,
    owner: Address,
    spender: Address,
  ): Promise<bigint> {
    return (await this.publicClient.readContract({
      abi: Erc20Abi,
      address: tokenAddress,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
  }
}
