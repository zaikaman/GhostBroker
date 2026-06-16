import { describe, expect, it, vi } from "vitest";
import { PortfolioService } from "../../services/portfolio.service.js";
import {
  SepoliaEtherscanPortfolioSyncService,
  type EtherscanFetch,
} from "../../services/sepolia-portfolio-sync.service.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";

const INSTITUTION_ID = "00000000-0000-4000-8000-000000000701";
const WALLET_ADDRESS = "0x46cc04de981e603958e4612f877d72427c5b6544";
const WBTC_ADDRESS = "0x29f2d40b0605204364af54ec677bd022da425d03";
const USDC_ADDRESS = "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8";

function createResponse(payload: unknown): Awaited<ReturnType<EtherscanFetch>> {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createService(fetchImpl: EtherscanFetch, portfolioClient = new InMemoryPortfolioClient()) {
  const portfolioService = new PortfolioService(portfolioClient as never, "USDC");
  const service = new SepoliaEtherscanPortfolioSyncService(portfolioService, {
    apiKey: "etherscan-test-key",
    wbtcContractAddress: WBTC_ADDRESS,
    usdcContractAddress: USDC_ADDRESS,
    fetchImpl,
    maxRequestsPerSecond: 1000,
    cacheTtlMs: 30_000,
    maxRateLimitRetries: 2,
  });

  return { service, portfolioClient };
}

describe("SepoliaEtherscanPortfolioSyncService", () => {
  it("retries an Etherscan rate-limit envelope and still returns the live portfolio", async () => {
    const seenUrls: string[] = [];
    const nativeRateLimited = createResponse({
      status: "0",
      message: "NOTOK",
      result: "Max calls per sec rate limit reached (3/sec)",
    });
    const nativeOk = createResponse({
      status: "1",
      message: "OK",
      result: "1000000000000000000",
    });
    const wbtcOk = createResponse({
      status: "1",
      message: "OK",
      result: "250000000",
    });
    const usdcOk = createResponse({
      status: "1",
      message: "OK",
      result: "5000000",
    });

    let nativeAttempts = 0;
    const fetchImpl: EtherscanFetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);

      if (url.includes("action=balance")) {
        nativeAttempts += 1;
        return nativeAttempts === 1 ? nativeRateLimited : nativeOk;
      }

      if (url.includes(`contractaddress=${WBTC_ADDRESS}`)) {
        return wbtcOk;
      }

      if (url.includes(`contractaddress=${USDC_ADDRESS}`)) {
        return usdcOk;
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const { service } = createService(fetchImpl);
    const portfolio = await service.fetchLivePortfolio({
      walletAddress: WALLET_ADDRESS,
    });

    expect(portfolio.holdings).toEqual([
      { assetCode: "SEPOLIAETH", balance: 1, locked: 0 },
      { assetCode: "WBTC", balance: 2.5, locked: 0 },
      { assetCode: "USDC", balance: 5, locked: 0 },
    ]);
    expect(nativeAttempts).toBe(2);
    expect(seenUrls).toHaveLength(4);
  });

  it("shares one upstream fetch across concurrent same-wallet consumers", async () => {
    const fetchCounts = {
      native: 0,
      wbtc: 0,
      usdc: 0,
    };
    const fetchImpl: EtherscanFetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("action=balance")) {
        fetchCounts.native += 1;
        return createResponse({
          status: "1",
          message: "OK",
          result: "2000000000000000000",
        });
      }

      if (url.includes(`contractaddress=${WBTC_ADDRESS}`)) {
        fetchCounts.wbtc += 1;
        return createResponse({
          status: "1",
          message: "OK",
          result: "100000000",
        });
      }

      if (url.includes(`contractaddress=${USDC_ADDRESS}`)) {
        fetchCounts.usdc += 1;
        return createResponse({
          status: "1",
          message: "OK",
          result: "3000000",
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const portfolioClient = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: INSTITUTION_ID,
        assetCode: "SEPOLIAETH",
        balance: 0,
      }),
      makePortfolioRecord({
        institutionId: INSTITUTION_ID,
        assetCode: "WBTC",
        balance: 0,
      }),
      makePortfolioRecord({
        institutionId: INSTITUTION_ID,
        assetCode: "USDC",
        balance: 0,
      }),
    ]);
    const { service } = createService(fetchImpl, portfolioClient);

    const [livePortfolio, syncedPortfolio] = await Promise.all([
      service.fetchLivePortfolio({
        walletAddress: WALLET_ADDRESS,
      }),
      service.syncInstitutionPortfolio({
        institutionId: INSTITUTION_ID,
        walletAddress: WALLET_ADDRESS,
      }),
    ]);

    expect(livePortfolio.holdings).toEqual([
      { assetCode: "SEPOLIAETH", balance: 2, locked: 0 },
      { assetCode: "WBTC", balance: 1, locked: 0 },
      { assetCode: "USDC", balance: 3, locked: 0 },
    ]);
    expect(syncedPortfolio.holdings).toEqual([
      { assetCode: "SEPOLIAETH", balance: 2, locked: 0 },
      { assetCode: "USDC", balance: 3, locked: 0 },
      { assetCode: "WBTC", balance: 1, locked: 0 },
    ]);
    expect(fetchCounts).toEqual({
      native: 1,
      wbtc: 1,
      usdc: 1,
    });
  });
});
