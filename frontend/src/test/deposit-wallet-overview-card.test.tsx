import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DepositWalletOverviewCard } from "../components/DepositWalletOverviewCard";

vi.mock("../services/api-client", () => ({
  apiClient: {
    getInstitution: vi.fn(),
    getDepositStatus: vi.fn(),
  },
}));

vi.mock("../hooks/usePortfolioTelemetry", () => ({
  usePortfolioTelemetry: () => ({
    refreshKey: 0,
    refresh: vi.fn(),
  }),
}));

import { apiClient } from "../services/api-client";

const mockedGetInstitution = vi.mocked(apiClient.getInstitution);
const mockedGetDepositStatus = vi.mocked(apiClient.getDepositStatus);

describe("DepositWalletOverviewCard", () => {
  beforeEach(() => {
    mockedGetInstitution.mockReset();
    mockedGetDepositStatus.mockReset();
  });

  it("renders deposit wallet balances and relayer approval state for chain rail institutions", async () => {
    mockedGetInstitution.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000101",
      legalName: "Northstar Capital LLC",
      displayName: "Northstar Capital",
      status: "active",
      t3TenantDid: "did:t3:0x1111111111111111111111111111111111111111",
      settlementProfileRef: "chain:sepolia:erc20",
      metadata: {
        depositAddress: "0x1111111111111111111111111111111111111111",
      },
    });
    mockedGetDepositStatus.mockResolvedValue({
      depositAddress: "0x1111111111111111111111111111111111111111",
      relayerContractAddress: "0x2222222222222222222222222222222222222222",
      txHashes: {},
      balances: { eth: "0.5", wbtc: "1.25", usdc: "12000" },
      approved: { wbtc: true, usdc: true },
    });

    render(
      <DepositWalletOverviewCard institutionId="00000000-0000-4000-8000-000000000101" />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Settlement Deposit Wallet/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/0x1111111111111111111111111111111111111111/i)).toBeInTheDocument();
    expect(screen.getByText("0.5")).toBeInTheDocument();
    expect(screen.getByText("1.25")).toBeInTheDocument();
    expect(screen.getByText("12000")).toBeInTheDocument();
    expect(screen.getByText(/Relayer approved/i)).toBeInTheDocument();
  });

  it("renders the non-chain-rail empty state", async () => {
    mockedGetInstitution.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000101",
      legalName: "Northstar Capital LLC",
      displayName: "Northstar Capital",
      status: "active",
      t3TenantDid: "did:t3:0x1111111111111111111111111111111111111111",
      settlementProfileRef: "wallet:default",
      metadata: {},
    });

    render(
      <DepositWalletOverviewCard institutionId="00000000-0000-4000-8000-000000000101" />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Settlement Wallet" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/not currently configured for the Sepolia deposit wallet rail/i),
    ).toBeInTheDocument();
  });
});
