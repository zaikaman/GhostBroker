import { describe, expect, it } from "vitest";
import {
  T3NegotiationTicketClient,
  type NegotiationPairVerificationRequest,
  type NegotiationTicketRequest,
} from "../negotiation/negotiation-ticket.js";
import type {
  T3NetworkClient,
  T3NetworkRequest,
  T3NetworkResponse,
} from "../sandbox/t3n-client.js";

class CapturingNetworkClient implements T3NetworkClient {
  public requests: T3NetworkRequest[] = [];

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    this.requests.push(request);
    const path = request.path;
    if (path === "/contracts/negotiation/tickets") {
      return {
        status: 201,
        body: {
          ticket_handle: "ticket_capture_buy_32chars_hex_string_x",
          execution_ref: "t3exec_capture_buy",
        } as TBody,
      };
    }
    if (path === "/contracts/negotiation/pairs") {
      return {
        status: 200,
        body: {
          pair_ref: "pair_capture_compat_32chars_hex_string_x",
          execution_ref: "t3exec_capture_pair",
          status: "compatible",
          reason: "",
          reason_code: "",
          buy_ticket_handle: (request.body as Record<string, unknown>)
            ?.buy_ticket_handle,
          sell_ticket_handle: (request.body as Record<string, unknown>)
            ?.sell_ticket_handle,
          buy_institution_id: "buy-inst",
          sell_institution_id: "sell-inst",
          asset_code: "WBTC",
          expires_at: "2026-06-19T12:34:56.000Z",
        } as TBody,
      };
    }
    throw new Error(`unexpected path ${path}`);
  }
}

class RejectingPairNetworkClient implements T3NetworkClient {
  public requests: T3NetworkRequest[] = [];

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    this.requests.push(request);
    if (request.path === "/contracts/negotiation/tickets") {
      return {
        status: 201,
        body: {
          ticket_handle: "ticket_reject_path_32chars_hex_string_x",
          execution_ref: "t3exec_reject_path",
        } as TBody,
      };
    }
    if (request.path === "/contracts/negotiation/pairs") {
      return {
        status: 200,
        body: {
          // Body is missing the trio the client expects; the
          // client must fall back to the local structural
          // check rather than approve the pair.
          pair_ref: undefined,
          execution_ref: undefined,
          status: undefined,
        } as TBody,
      };
    }
    throw new Error(`unexpected path ${request.path}`);
  }
}

const ticketRequest: NegotiationTicketRequest = {
  institutionId: "00000000-0000-4000-8000-00000000b001",
  agentDid: "did:t3n:agent:buyer",
  authorityRef: "ghostbroker-delegation:verify-test",
  assetCode: "WBTC",
  side: "buy",
  policyHash: "policy-hash-stub",
  compatibilityToken: "WBTC:buy:00000000-0000-4000-8000-00000000b001",
  correlationRef: "ticket:buyer:0001",
};

const pairRequest: NegotiationPairVerificationRequest = {
  // The Rust contract enforces `^ticket_[0-9a-f]{32}$` on
  // every pair call. Test fixtures use real-shaped 32-char
  // hex handles so the well-formedness check actually runs
  // and so a malformed-handle rejection can be distinguished
  // from a same-institution rejection in the negative tests.
  buyTicketHandle: "ticket_0123456789abcdef0123456789abcdef",
  sellTicketHandle: "ticket_fedcba9876543210fedcba9876543210",
  buyCompatibilityToken: "WBTC:buy:00000000-0000-4000-8000-00000000b001",
  sellCompatibilityToken: "WBTC:sell:00000000-0000-4000-8000-00000000b002",
  assetCode: "WBTC",
  correlationRef: "pair:verify:0001",
};

describe("T3NegotiationTicketClient — contract version", () => {
  it("pins the default contract version to 0.7.0 (the v0.7.0 audit-trail build)", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    await client.sealTicket(ticketRequest);
    expect(networkClient.requests[0]?.body).toMatchObject({
      version: "0.7.0",
    });
  });

  it("pins the contract version on the verifyPair body too", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    await client.verifyPair(pairRequest);
    expect(networkClient.requests[0]?.body).toMatchObject({
      version: "0.7.0",
    });
  });

  it("honours an explicit contractVersion override on both methods", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationTicketClient({
      networkClient,
      contractVersion: "0.7.0-canary",
    });
    await client.sealTicket(ticketRequest);
    await client.verifyPair(pairRequest);
    expect(networkClient.requests[0]?.body).toMatchObject({
      version: "0.7.0-canary",
    });
    expect(networkClient.requests[1]?.body).toMatchObject({
      version: "0.7.0-canary",
    });
  });
});

describe("T3NegotiationTicketClient — seal-ticket wire shape", () => {
  it("posts the seal-ticket body in snake_case to match the Rust contract's deserializer", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    const result = await client.sealTicket(ticketRequest);
    expect(result.ticketHandle).toBe(
      "ticket_capture_buy_32chars_hex_string_x",
    );
    expect(networkClient.requests[0]?.path).toBe(
      "/contracts/negotiation/tickets",
    );
    expect(networkClient.requests[0]?.method).toBe("POST");
    expect(networkClient.requests[0]?.body).toEqual({
      version: "0.7.0",
      institution_id: ticketRequest.institutionId,
      agent_did: ticketRequest.agentDid,
      authority_ref: ticketRequest.authorityRef,
      asset_code: ticketRequest.assetCode,
      side: ticketRequest.side,
      policy_hash: ticketRequest.policyHash,
      compatibility_token: ticketRequest.compatibilityToken,
      correlation_ref: ticketRequest.correlationRef,
    });
  });

  it("falls back to a local handle seed when the host omits ticket_handle", async () => {
    class NoTicketHandleNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return { status: 201, body: {} as TBody };
      }
    }
    const client = new T3NegotiationTicketClient({
      networkClient: new NoTicketHandleNetworkClient(),
    });
    const result = await client.sealTicket(ticketRequest);
    // SHA-256 over the fallback seed → first 32 hex chars →
    // `ticket_<32-hex>`. We don't pin the exact handle, just
    // the shape.
    expect(result.ticketHandle).toMatch(/^ticket_[0-9a-f]{32}$/u);
  });
});

describe("T3NegotiationTicketClient — evaluate-pair wire shape", () => {
  it("posts the evaluate-pair body in snake_case to match the Rust contract's deserializer", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    const result = await client.verifyPair(pairRequest);
    expect(result.status).toBe("compatible");
    expect(networkClient.requests[0]?.path).toBe(
      "/contracts/negotiation/pairs",
    );
    expect(networkClient.requests[0]?.method).toBe("POST");
    expect(networkClient.requests[0]?.body).toEqual({
      version: "0.7.0",
      buy_ticket_handle: pairRequest.buyTicketHandle,
      sell_ticket_handle: pairRequest.sellTicketHandle,
      buy_compatibility_token: pairRequest.buyCompatibilityToken,
      sell_compatibility_token: pairRequest.sellCompatibilityToken,
      asset_code: pairRequest.assetCode,
      correlation_ref: pairRequest.correlationRef,
    });
  });

  it("falls back to a local structural check when the host omits the new route", async () => {
    const networkClient = new RejectingPairNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    // A well-formed pair still passes because the local
    // fallback re-applies the same rules the Rust contract
    // enforces. This is a defense-in-depth path so a host
    // that hasn't been upgraded can't silently approve a
    // malformed pair.
    const compat = await client.verifyPair(pairRequest);
    expect(compat.status).toBe("compatible");
    expect(compat.reason).toBe("");
  });

  it("falls back to `incompatible` for a structurally-broken pair even when the host is missing the route", async () => {
    const networkClient = new RejectingPairNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    // A well-formed sell-side token that still references the
    // buyer's institution. The Rust contract checks the
    // `side` field before the institution id, so we can't
    // simply reuse the buy token — the contract would reject
    // it as `sell_token_wrong_side` first. To land on the
    // `same_institution` reason code the test asserts, both
    // tokens must be structurally valid AND point at the
    // same institution.
    const sharedInstitution = "00000000-0000-4000-8000-00000000b001";
    const malformed: NegotiationPairVerificationRequest = {
      ...pairRequest,
      buyCompatibilityToken: `WBTC:buy:${sharedInstitution}`,
      sellCompatibilityToken: `WBTC:sell:${sharedInstitution}`,
    };
    const result = await client.verifyPair(malformed);
    expect(result.status).toBe("incompatible");
    expect(result.reasonCode).toBe("same_institution");
  });

  it("falls back to `incompatible` for a malformed handle even when the host is missing the route", async () => {
    const networkClient = new RejectingPairNetworkClient();
    const client = new T3NegotiationTicketClient({ networkClient });
    const malformed: NegotiationPairVerificationRequest = {
      ...pairRequest,
      buyTicketHandle: "not-a-handle",
    };
    const result = await client.verifyPair(malformed);
    expect(result.status).toBe("incompatible");
    expect(result.reasonCode).toBe("malformed_buy_ticket_handle");
  });
});
