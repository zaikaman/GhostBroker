import { afterEach, describe, expect, it, vi } from "vitest";
import { ReceiptClient } from "./receipt-client.js";
import { GhostBrokerApiError } from "./errors.js";
import type { AuditReceipt } from "./types.js";

const SAMPLE_RECEIPT: AuditReceipt = {
  id: "uuid-receipt",
  completedTradeId: "uuid-trade",
  receiptCiphertext: "t3cipher.receipt.payload",
  receiptHash: "sha256:abc",
  keyVersion: "v1",
  t3AttestationRef: "t3-attest:abc",
};

function mockJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReceiptClient", () => {
  it("GETs /api/receipts/:id with the bearer token and percent-encodes the id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(SAMPLE_RECEIPT));

    const client = new ReceiptClient("https://api.example.com");
    const result = await client.getReceipt("uuid/with spaces", "gb_session_xyz");

    expect(result).toEqual(SAMPLE_RECEIPT);
    const [url, init] = fetchSpy.mock.calls[0]!;
    // encodeURIComponent turns spaces into %20 and slashes into %2F.
    expect(url).toBe("https://api.example.com/api/receipts/uuid%2Fwith%20spaces");
    const reqInit = init as RequestInit;
    expect((reqInit.headers as Record<string, string>).Authorization).toBe("Bearer gb_session_xyz");
  });

  it("throws a GhostBrokerApiError with code 'not_found' when the receipt is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockJsonResponse(
        { code: "not_found", message: "Receipt not found." },
        { status: 404 },
      ),
    );

    const client = new ReceiptClient("https://api.example.com");
    let caught: unknown;
    try {
      await client.getReceipt("missing-id", "tok");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostBrokerApiError);
    const e = caught as GhostBrokerApiError;
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
  });
});
