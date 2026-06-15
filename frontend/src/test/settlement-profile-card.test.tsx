import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SettlementProfileCard } from "../components/SettlementProfileCard";

/**
 * WS3: SettlementProfileCard tests. The card reads
 * the institution + completed trades from the API
 * client and renders a per-rail summary with
 * Etherscan links for chain rail trade refs.
 */

vi.mock("../services/api-client", () => ({
  apiClient: {
    getInstitution: vi.fn(),
    getCompletedTrades: vi.fn(),
    getDepositStatus: vi.fn(),
  },
}));

import { apiClient } from "../services/api-client";
const mockedGetInstitution = vi.mocked(apiClient.getInstitution);
const mockedGetCompletedTrades = vi.mocked(apiClient.getCompletedTrades);
const mockedGetDepositStatus = vi.mocked(apiClient.getDepositStatus);

const INSTITUTION_ID = "00000000-0000-4000-8000-0000000000d1";

const STATUS_FIXTURE = {
  depositAddress: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  relayerContractAddress: "0x2222222222222222222222222222222222222222",
  txHashes: {},
  balances: { eth: "0", wbtc: "0", usdc: "0" },
  approved: { wbtc: false, usdc: false },
};

describe("SettlementProfileCard (WS3)", () => {
  beforeEach(() => {
    mockedGetDepositStatus.mockResolvedValue(STATUS_FIXTURE);
  });
  it("renders the institution's settlement profile ref", async () => {
    mockedGetInstitution.mockResolvedValue({
      id: INSTITUTION_ID,
      legalName: "Northstar",
      displayName: "Northstar",
      status: "active",
      t3TenantDid: "did:t3n:tenant:northstar",
      settlementProfileRef: "wallet:default",
      metadata: {},
    });
    mockedGetCompletedTrades.mockResolvedValue({ items: [] });

    render(<SettlementProfileCard institutionId={INSTITUTION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("wallet:default")).toBeInTheDocument();
    });
    expect(screen.getByText(/no rail trades yet/i)).toBeInTheDocument();
  });

  it("renders the chain-rail deposit address and per-asset token addresses", async () => {
    mockedGetInstitution.mockResolvedValue({
      id: INSTITUTION_ID,
      legalName: "Northstar",
      displayName: "Northstar",
      status: "active",
      t3TenantDid: "did:t3n:tenant:northstar",
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        depositAddress: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
        tokenAddresses: {
          WBTC: "0x1111111111111111111111111111111111111111",
          USDC: "0x2222222222222222222222222222222222222222",
        },
      },
    });
    mockedGetCompletedTrades.mockResolvedValue({ items: [] });

    render(<SettlementProfileCard institutionId={INSTITUTION_ID} />);

    await waitFor(() => {
      expect(screen.getByText("chain:sepolia:erc20")).toBeInTheDocument();
    });
    expect(
      screen.getByText("0x90f79bf6eb2c4f870365e785982e1f101e93b906"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("WBTC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
  });

  it("renders a clickable Etherscan link for chain-rail trade refs", async () => {
    mockedGetInstitution.mockResolvedValue({
      id: INSTITUTION_ID,
      legalName: "Northstar",
      displayName: "Northstar",
      status: "active",
      t3TenantDid: "did:t3n:tenant:northstar",
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {},
    });
    const txHash =
      "0x5eaaeda55b20275d76d7819dfb0a0b84e4423ab33fd0620859e90b0b2d12d186";
    mockedGetCompletedTrades.mockResolvedValue({
      items: [
        {
          id: "trade-1",
          tradeRef: "match_outcome_chain_1",
          assetCodeCiphertext: "t3cipher.asset",
          quantityCiphertext: "t3cipher.quantity",
          executionPriceCiphertext: "t3cipher.execution",
          settledAt: "2026-06-12T00:00:00.000Z",
          settlementStatus: "settled",
          receiptIds: [],
          railId: "chain:sepolia:erc20",
          railTradeRef: txHash,
          railState: "settled",
        },
      ],
    });

    render(<SettlementProfileCard institutionId={INSTITUTION_ID} />);

    // The card renders an <a> tag with the Etherscan URL.
    // We assert the href rather than the displayed text
    // (the displayed text is the shortened form).
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /0x5eaaed/i });
      expect(link).toBeInTheDocument();
      expect(link.getAttribute("href")).toBe(
        `https://sepolia.etherscan.io/tx/${txHash}`,
      );
    });
  });

  it("renders noop rail refs as plain text (no Etherscan link)", async () => {
    mockedGetInstitution.mockResolvedValue({
      id: INSTITUTION_ID,
      legalName: "Northstar",
      displayName: "Northstar",
      status: "active",
      t3TenantDid: "did:t3n:tenant:northstar",
      settlementProfileRef: "wallet:default",
      metadata: {},
    });
    const noopRef = "noop:0".padEnd(72, "0");
    mockedGetCompletedTrades.mockResolvedValue({
      items: [
        {
          id: "trade-1",
          tradeRef: "match_outcome_noop_1",
          assetCodeCiphertext: "t3cipher.asset",
          quantityCiphertext: "t3cipher.quantity",
          executionPriceCiphertext: "t3cipher.execution",
          settledAt: "2026-06-12T00:00:00.000Z",
          settlementStatus: "settled",
          receiptIds: [],
          railId: "wallet:default",
          railTradeRef: noopRef,
          railState: "settled",
        },
      ],
    });

    render(<SettlementProfileCard institutionId={INSTITUTION_ID} />);

    // The noop rail's railTradeRef is rendered as a
    // shortened <code> (not as an Etherscan link).
    await waitFor(() => {
      expect(screen.getByText(/noop:0000/)).toBeInTheDocument();
    });
    // No Etherscan link for the noop rail.
    expect(
      screen.queryByText(/sepolia\.etherscan\.io/),
    ).not.toBeInTheDocument();
  });
});




