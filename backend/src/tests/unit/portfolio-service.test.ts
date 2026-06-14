import { describe, expect, it } from "vitest";
import {
  InsufficientBalanceError,
  PortfolioService,
} from "../../services/portfolio.service.js";
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

  describe("lockBalance / releaseBalance", () => {
    const lockInstitutionId = "00000000-0000-4000-8000-000000000501";

    it("locks available balance and exposes it in getPortfolio", async () => {
      const client = new InMemoryPortfolioClient([
        makePortfolioRecord({
          institutionId: lockInstitutionId,
          assetCode: "USDC",
          balance: 1000,
        }),
      ]);
      const service = new PortfolioService(client as never, "USDC");

      await service.lockBalance(lockInstitutionId, "USDC", 400);

      const portfolio = await service.getPortfolio(lockInstitutionId);
      expect(portfolio.holdings).toEqual([
        { assetCode: "USDC", balance: 1000, locked: 400 },
      ]);
    });

    it("rejects a lock that exceeds available balance", async () => {
      const client = new InMemoryPortfolioClient([
        makePortfolioRecord({
          institutionId: lockInstitutionId,
          assetCode: "USDC",
          balance: 100,
          locked: 0,
        }),
      ]);
      const service = new PortfolioService(client as never, "USDC");

      await expect(
        service.lockBalance(lockInstitutionId, "USDC", 200),
      ).rejects.toBeInstanceOf(InsufficientBalanceError);
    });

    it("accumulates locks (second lock sees the first)", async () => {
      const client = new InMemoryPortfolioClient([
        makePortfolioRecord({
          institutionId: lockInstitutionId,
          assetCode: "USDC",
          balance: 1000,
        }),
      ]);
      const service = new PortfolioService(client as never, "USDC");

      await service.lockBalance(lockInstitutionId, "USDC", 300);
      await service.lockBalance(lockInstitutionId, "USDC", 400);

      // Available balance is now 1000 - 700 = 300, so a third lock
      // for 500 must be rejected.
      await expect(
        service.lockBalance(lockInstitutionId, "USDC", 500),
      ).rejects.toBeInstanceOf(InsufficientBalanceError);

      const portfolio = await service.getPortfolio(lockInstitutionId);
      expect(portfolio.holdings[0]).toEqual({
        assetCode: "USDC",
        balance: 1000,
        locked: 700,
      });
    });

    it("releases locks and restores available balance", async () => {
      const client = new InMemoryPortfolioClient([
        makePortfolioRecord({
          institutionId: lockInstitutionId,
          assetCode: "USDC",
          balance: 1000,
        }),
      ]);
      const service = new PortfolioService(client as never, "USDC");

      await service.lockBalance(lockInstitutionId, "USDC", 600);
      await service.releaseBalance(lockInstitutionId, "USDC", 200);

      const portfolio = await service.getPortfolio(lockInstitutionId);
      expect(portfolio.holdings[0]).toEqual({
        assetCode: "USDC",
        balance: 1000,
        locked: 400,
      });
    });

    it("clamps release at zero (no negative locks)", async () => {
      const client = new InMemoryPortfolioClient([
        makePortfolioRecord({
          institutionId: lockInstitutionId,
          assetCode: "USDC",
          balance: 1000,
        }),
      ]);
      const service = new PortfolioService(client as never, "USDC");

      // Release more than was locked — should clamp at zero.
      await service.releaseBalance(lockInstitutionId, "USDC", 5000);

      const portfolio = await service.getPortfolio(lockInstitutionId);
      expect(portfolio.holdings[0]).toEqual({
        assetCode: "USDC",
        balance: 1000,
        locked: 0,
      });
    });

    it("is a no-op on a portfolio row that does not exist", async () => {
      const client = new InMemoryPortfolioClient();
      const service = new PortfolioService(client as never, "USDC");

      // Should not throw.
      await service.releaseBalance(lockInstitutionId, "USDC", 100);
    });
  });
});
