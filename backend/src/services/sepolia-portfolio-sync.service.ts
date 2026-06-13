import { PublicError } from "../errors/public-error.js";
import type { Portfolio } from "../models/portfolio.js";
import type { PortfolioService } from "./portfolio.service.js";

interface EtherscanFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type EtherscanFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Readonly<Record<string, string>>;
  },
) => Promise<EtherscanFetchResponse>;

export interface WalletPortfolioSyncService {
  syncInstitutionPortfolio(params: {
    institutionId: string;
    walletAddress: string;
  }): Promise<Portfolio>;

  fetchLivePortfolio(params: {
    walletAddress: string;
  }): Promise<{
    institutionId: string;
    holdings: {
      assetCode: string;
      balance: number;
      locked: number;
    }[];
  }>;
}

interface SepoliaEtherscanPortfolioSyncConfig {
  apiKey: string;
  wbtcContractAddress: string;
  usdcContractAddress: string;
  fetchImpl?: EtherscanFetch;
}

interface EtherscanApiResponse {
  status?: string;
  message?: string;
  result?: unknown;
}

const ETHERSCAN_API_V2_URL = "https://api.etherscan.io/v2/api";
const SEPOLIA_CHAIN_ID = "11155111";
const SEPOLIA_NATIVE_ASSET_CODE = "SEPOLIAETH";
const WBTC_DECIMALS = 8;
const USDC_DECIMALS = 6;

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function formatUnits(value: string, decimals: number): number {
  const normalized = BigInt(value);
  const divisor = 10n ** BigInt(decimals);
  const whole = normalized / divisor;
  const remainder = normalized % divisor;

  if (remainder === 0n) {
    return Number(whole);
  }

  const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/u, "");
  return Number(`${whole.toString()}.${fraction}`);
}

function assertNumericResult(payload: EtherscanApiResponse, context: string): string {
  if (typeof payload.result === "string" && /^\d+$/u.test(payload.result)) {
    return payload.result;
  }

  const detail = typeof payload.result === "string" ? payload.result : payload.message;
  throw new PublicError(
    "service_unavailable",
    503,
    new Error(`${context} returned an unexpected response${detail ? `: ${detail}` : ""}`),
  );
}

export class SepoliaEtherscanPortfolioSyncService implements WalletPortfolioSyncService {
  private readonly portfolioService: PortfolioService;
  private readonly apiKey: string;
  private readonly wbtcContractAddress: string;
  private readonly usdcContractAddress: string;
  private readonly fetchImpl: EtherscanFetch;

  public constructor(
    portfolioService: PortfolioService,
    config: SepoliaEtherscanPortfolioSyncConfig,
  ) {
    this.portfolioService = portfolioService;
    this.apiKey = config.apiKey;
    this.wbtcContractAddress = normalizeAddress(config.wbtcContractAddress);
    this.usdcContractAddress = normalizeAddress(config.usdcContractAddress);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Queries Sepolia for the wallet's balances and syncs them into the database.
   */
  public async syncInstitutionPortfolio(params: {
    institutionId: string;
    walletAddress: string;
  }): Promise<Portfolio> {
    const liveBalances = await this.fetchLiveBalances(params.walletAddress);

    return this.portfolioService.syncPortfolioSnapshot({
      institutionId: params.institutionId,
      sourceRef: `etherscan:sepolia:${normalizeAddress(params.walletAddress)}`,
      observedAt: new Date().toISOString(),
      holdings: liveBalances,
    });
  }

  /**
   * Queries Sepolia for the wallet's current balances and returns them as a
   * portfolio structure WITHOUT writing to the database. Always returns live
   * on-chain data.
   */
  public async fetchLivePortfolio(params: {
    walletAddress: string;
  }): Promise<{
    institutionId: string;
    holdings: {
      assetCode: string;
      balance: number;
      locked: number;
    }[];
  }> {
    const liveBalances = await this.fetchLiveBalances(params.walletAddress);

    return {
      institutionId: "",
      holdings: liveBalances.map((h) => ({
        assetCode: h.assetCode,
        balance: h.balance,
        locked: 0,
      })),
    };
  }

  /**
   * Fetches current Sepolia balances for the given wallet address.
   * Returns WBTC, SepoliaETH, and USDC balances.
   */
  private async fetchLiveBalances(
    walletAddress: string,
  ): Promise<Array<{ assetCode: string; balance: number }>> {
    const addr = normalizeAddress(walletAddress);

    const [nativeBalance, wbtcBalance, usdcBalance] = await Promise.all([
      this.fetchNativeEthBalance(addr),
      this.fetchTokenBalance(addr, this.wbtcContractAddress, WBTC_DECIMALS),
      this.fetchTokenBalance(addr, this.usdcContractAddress, USDC_DECIMALS),
    ]);

    return [
      { assetCode: SEPOLIA_NATIVE_ASSET_CODE, balance: nativeBalance },
      { assetCode: "WBTC", balance: wbtcBalance },
      { assetCode: "USDC", balance: usdcBalance },
    ];
  }

  private async fetchNativeEthBalance(walletAddress: string): Promise<number> {
    const payload = await this.requestEtherscanJson({
      action: "balance",
      walletAddress,
      context: `native balance for ${walletAddress}`,
    });

    return formatUnits(
      assertNumericResult(payload, `native balance for ${walletAddress}`),
      18,
    );
  }

  private async fetchTokenBalance(
    walletAddress: string,
    contractAddress: string,
    decimals: number,
  ): Promise<number> {
    const payload = await this.requestEtherscanJson({
      action: "tokenbalance",
      walletAddress,
      contractAddress,
      context: `token balance for ${contractAddress}`,
    });

    return formatUnits(
      assertNumericResult(payload, `token balance for ${contractAddress}`),
      decimals,
    );
  }

  private async requestEtherscanJson(params: {
    action: "balance" | "tokenbalance";
    walletAddress: string;
    contractAddress?: string;
    context: string;
  }): Promise<EtherscanApiResponse> {
    const url = new URL(ETHERSCAN_API_V2_URL);
    url.searchParams.set("module", "account");
    url.searchParams.set("action", params.action);
    url.searchParams.set("address", params.walletAddress);
    url.searchParams.set("chainid", SEPOLIA_CHAIN_ID);
    url.searchParams.set("tag", "latest");
    url.searchParams.set("apikey", this.apiKey);

    if (params.contractAddress) {
      url.searchParams.set("contractaddress", params.contractAddress);
    }

    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new PublicError(
        "service_unavailable",
        503,
        new Error(`${params.context} request failed with HTTP ${response.status}`),
      );
    }

    const payload = (await response.json()) as EtherscanApiResponse;
    if (typeof payload !== "object" || payload === null) {
      throw new PublicError(
        "service_unavailable",
        503,
        new Error(`${params.context} returned an invalid payload`),
      );
    }

    return payload;
  }
}
