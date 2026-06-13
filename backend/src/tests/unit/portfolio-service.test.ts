import { describe, expect, it } from "vitest";
import { PortfolioService } from "../../services/portfolio.service.js";
import {
  InMemoryPortfolioClient,
  makePortfolioRecord,
} from "../support/in-memory-portfolio-client.js";

const buyerInstitutionId = "00000000-0000-4000-8000-000000000401";
const sellerInstitutionId = "00000000-0000-4000-8000-000000000402";
const snapshotInstitutionId = "00000000-0000-4000-8000-000000000403";

describe("portfolio service", () => {
  it("syncs exact balances from an external snapshot", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: snapshotInstitutionId,
        assetCode: "WBTC",
        balance: 1,
      }),
      makePortfolioRecord({
        institutionId: snapshotInstitutionId,
        assetCode: "SEPOLIAETH",
        balance: 4,
      }),
      makePortfolioRecord({
        institutionId: snapshotInstitutionId,
        assetCode: "USDC",
        balance: 10,
      }),
    ]);
    const service = new PortfolioService(client as never, "USDC");

    const portfolio = await service.syncPortfolioSnapshot({
      institutionId: snapshotInstitutionId,
      sourceRef: "custody:snapshot:001",
      holdings: [
        { assetCode: "WBTC", balance: 2 },
        { assetCode: "USDC", balance: 5 },
      ],
    });

    expect(portfolio.holdings).toEqual([
      { assetCode: "SEPOLIAETH", balance: 0, locked: 0 },
      { assetCode: "USDC", balance: 5, locked: 0 },
      { assetCode: "WBTC", balance: 2, locked: 0 },
    ]);
    expect(client.rpcCalls.map((call) => call.functionName)).toEqual([
      "portfolio_sync_balance",
      "portfolio_sync_balance",
      "portfolio_sync_balance",
    ]);
    expect(
      client.rpcCalls.map((call) => String(call.parameters.p_asset_code)),
    ).toEqual(["SEPOLIAETH", "USDC", "WBTC"]);
    expect(
      client.historyInserts.map((entry) => entry.change_type),
    ).toEqual(["import", "import", "import"]);
    expect(client.historyInserts.map((entry) => entry.delta)).toEqual([
      "-4",
      "-5",
      "1",
    ]);
    expect(
      client.historyInserts.map((entry) => entry.reference_type),
    ).toEqual(["portfolio_snapshot", "portfolio_snapshot", "portfolio_snapshot"]);
    expect(
      client.historyInserts.map((entry) => entry.reference_id),
    ).toEqual(["custody:snapshot:001", "custody:snapshot:001", "custody:snapshot:001"]);
  });

  it("uses the configured settlement asset when applying trades", async () => {
    const client = new InMemoryPortfolioClient([
      makePortfolioRecord({
        institutionId: buyerInstitutionId,
        assetCode: "USDC",
        balance: 1000,
      }),
      makePortfolioRecord({
        institutionId: sellerInstitutionId,
        assetCode: "WBTC",
        balance: 5,
      }),
      makePortfolioRecord({
        institutionId: sellerInstitutionId,
        assetCode: "USDC",
        balance: 0,
      }),
    ]);
    const service = new PortfolioService(client as never, "USDC");

    await service.applySettlement({
      buyerInstitutionId,
      sellerInstitutionId,
      assetCode: "WBTC",
      quantity: 2,
      price: 100,
    });

    expect(
      client.rpcCalls
        .filter((call) => call.functionName === "portfolio_update_balance")
        .map((call) => String(call.parameters.p_asset_code)),
    ).toEqual(["USDC", "WBTC", "WBTC", "USDC"]);

    expect(await service.getPortfolio(buyerInstitutionId)).toEqual({
      institutionId: buyerInstitutionId,
      holdings: [
        { assetCode: "USDC", balance: 800, locked: 0 },
        { assetCode: "WBTC", balance: 2, locked: 0 },
      ],
    });

    expect(await service.getPortfolio(sellerInstitutionId)).toEqual({
      institutionId: sellerInstitutionId,
      holdings: [
        { assetCode: "USDC", balance: 200, locked: 0 },
        { assetCode: "WBTC", balance: 3, locked: 0 },
      ],
    });
  });
});
