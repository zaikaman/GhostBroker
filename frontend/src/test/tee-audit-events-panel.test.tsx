import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeeAuditEventsPanel } from "../components/TeeAuditEventsPanel";
import type * as ApiClientModule from "../services/api-client";

vi.mock("../services/api-client", async () => {
  const actual =
    await vi.importActual<typeof ApiClientModule>("../services/api-client");
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      getAuditEvents: vi.fn(),
    },
  };
});

import { apiClient } from "../services/api-client";

const mockedGetAuditEvents = vi.mocked(apiClient.getAuditEvents);

const SAMPLE_PAGE = {
  batches: [
    {
      key: "abc123",
      committed: true,
      events: [
        {
          ts_ms: 1719000000000,
          subject: "did:t3n:0xsubject",
          actor: "did:t3n:0xactor",
          vc_id: "vc_001",
          action: "seal-intent",
          target: "blind-intent",
          outcome: "success",
          details: null,
        },
      ],
    },
    {
      key: "def456",
      committed: false,
      events: [
        {
          ts_ms: 1719000001000,
          subject: "did:t3n:0xsubject",
          actor: "did:t3n:0xactor",
          vc_id: null,
          action: "evaluate-match",
          target: "blind-intent",
          outcome: "denied",
          details: '{"reason":"no_counterparty"}',
        },
      ],
    },
  ],
  next_cursor: "deadbeef",
};

describe("TeeAuditEventsPanel", () => {
  beforeEach(() => {
    mockedGetAuditEvents.mockReset();
  });

  it("renders batch cards with committed / rolled-back badges and event rows", async () => {
    mockedGetAuditEvents.mockResolvedValue(SAMPLE_PAGE);

    render(<TeeAuditEventsPanel />);

    expect(await screen.findByTestId("tee-audit-events-panel")).toBeInTheDocument();
    expect(await screen.findByText(/Rolled back/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Committed/i).length).toBeGreaterThan(0);
    // self-call label for the null vc_id event
    expect(screen.getByText(/self-call/i)).toBeInTheDocument();
    // outcome coloring is present
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.getByText("denied")).toBeInTheDocument();
  });

  it("renders an empty state when the audit trail has no batches", async () => {
    mockedGetAuditEvents.mockResolvedValue({ batches: [], next_cursor: null });

    render(<TeeAuditEventsPanel />);

    expect(await screen.findByText(/No audit events recorded yet/i)).toBeInTheDocument();
  });

  it("surfaces a fetch error without crashing", async () => {
    mockedGetAuditEvents.mockRejectedValue(new Error("network down"));

    render(<TeeAuditEventsPanel />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/network down/i);
    });
  });

  it("hides uncommitted batches when the filter checkbox is checked", async () => {
    mockedGetAuditEvents.mockResolvedValue(SAMPLE_PAGE);
    const user = userEvent.setup();

    render(<TeeAuditEventsPanel />);

    await screen.findByText(/Rolled back/i);
    const checkbox = screen.getByRole("checkbox", {
      name: /Hide uncommitted/i,
    });
    await user.click(checkbox);

    await waitFor(() => {
      expect(screen.queryByText(/Rolled back/i)).not.toBeInTheDocument();
    });
    expect(screen.getAllByText(/Committed/i).length).toBeGreaterThan(0);
  });

  it("loads more batches via the next_cursor when Load More is clicked", async () => {
    mockedGetAuditEvents.mockResolvedValueOnce(SAMPLE_PAGE);
    mockedGetAuditEvents.mockResolvedValueOnce({
      batches: [
        {
          key: "ghi789",
          committed: true,
          events: [
            {
              ts_ms: 1719000002000,
              subject: "did:t3n:0xsubject",
              actor: "did:t3n:0xactor2",
              vc_id: "vc_002",
              action: "settlement-execute",
              target: "completed-trade",
              outcome: "success",
              details: null,
            },
          ],
        },
      ],
      next_cursor: null,
    });

    const user = userEvent.setup();
    render(<TeeAuditEventsPanel />);

    const loadMore = await screen.findByRole("button", { name: /Load More/i });
    await user.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText("settlement-execute")).toBeInTheDocument();
    });
    expect(mockedGetAuditEvents).toHaveBeenCalledTimes(2);
    expect(mockedGetAuditEvents).toHaveBeenNthCalledWith(2, {
      cursor: "deadbeef",
      limit: 20,
    });
  });

  it("expands event details when the expand toggle is clicked", async () => {
    mockedGetAuditEvents.mockResolvedValue(SAMPLE_PAGE);
    const user = userEvent.setup();

    render(<TeeAuditEventsPanel />);

    const expand = await screen.findByRole("button", { name: /Expand details/i });
    await user.click(expand);

    await waitFor(() => {
      expect(screen.getByText(/no_counterparty/i)).toBeInTheDocument();
    });
  });
});
