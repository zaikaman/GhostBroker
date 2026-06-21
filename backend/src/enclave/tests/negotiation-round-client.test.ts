import { describe, expect, it } from "vitest";
import {
  T3NegotiationRoundClient,
  distanceSignalFor,
  type EvaluateRoundRequest,
  type SealRoundProposalRequest,
} from "../negotiation/round-client.js";
import {
  loadEnvelopeMasterKey,
  sealEnvelope,
} from "../keys/envelope-cipher.js";
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
    if (path === "/contracts/negotiation/round-proposals") {
      return {
        status: 201,
        body: {
          proposal_handle: "round_capture_buy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          execution_ref: "t3exec_round_capture",
          traded_asset_code: "WBTC",
          side: "buy",
          quantity: "1",
          price: "70000",
          distance_signal: "far",
          attestation_ref:
            "roundattest_seal_capture_aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sealed_at: "2026-06-21T00:00:00.000Z",
        } as TBody,
      };
    }
    if (path === "/contracts/negotiation/round-evaluation") {
      return {
        status: 200,
        body: {
          status: "crossed",
          buyer_signal: "crossed",
          seller_signal: "crossed",
          execution_price: "70050",
          matched_quantity: "1",
          outcome_ref: "outcome_round_capture",
          execution_ref: "t3exec_round_eval",
          encrypted_trade_fields_ref: "fields_round_capture",
          expires_at: "2026-06-21T00:05:00.000Z",
          evaluated_at: "2026-06-21T00:00:00.000Z",
          round_attestation_ref:
            "roundattest_capture_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        } as TBody,
      };
    }
    throw new Error(`unexpected path ${path}`);
  }
}

class RejectingRouteNetworkClient implements T3NetworkClient {
  public requests: T3NetworkRequest[] = [];

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    this.requests.push(request);
    // Echo the path but with a body shape the client does not
    // recognize — exercises the defense-in-depth fallback path on
    // both seal and evaluate-round.
    if (request.path === "/contracts/negotiation/round-proposals") {
      return { status: 201, body: {} as TBody };
    }
    if (request.path === "/contracts/negotiation/round-evaluation") {
      return { status: 200, body: {} as TBody };
    }
    throw new Error(`unexpected path ${request.path}`);
  }
}

const sealRequest: SealRoundProposalRequest = {
  sealedEnvelope:
    "ghostbroker.envelope.aead/v1|placeholder-replaced-in-fallback-test-below",
  institutionDid: "00000000-0000-4000-8000-000000000b01",
  agentDid: "did:t3n:agent:buyer",
  authorityRef: "ghostbroker-delegation:round-test",
  assetCode: "WBTC",
  side: "buy",
  correlationRef: "round:seal:0001",
  envelopeMasterKeyHex: loadEnvelopeMasterKey().key.toString("hex"),
};

/**
 * Build a real AEAD envelope for the fallback test. The fallback
 * path uses the in-process `openEnvelope` decoder, which raises on
 * any tamper / wrong-key / AAD mismatch. A real envelope from
 * `sealEnvelope` is required so the fallback round-trip succeeds.
 */
function buildRealSealedEnvelope(): string {
  const masterKey = loadEnvelopeMasterKey();
  return sealEnvelope({
    institutionDid: "00000000-0000-4000-8000-000000000b01",
    agentDid: "did:t3n:agent:buyer",
    authorityRef: "ghostbroker-delegation:round-test",
    payload: {
      institutionId: "00000000-0000-4000-8000-000000000b01",
      agentDid: "did:t3n:agent:buyer",
      authorityRef: "ghostbroker-delegation:round-test",
      assetCode: "WBTC",
      side: "buy",
      quantity: 1,
      price: 70_000,
    },
    masterKey,
  });
}

const evaluateRequest: EvaluateRoundRequest = {
  buyProposalHandle: "round_buy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sellProposalHandle: "round_sell_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  assetCode: "WBTC",
  correlationRef: "round:eval:0001",
};

describe("T3NegotiationRoundClient — contract version pinning", () => {
  it("pins the default contract version to 0.9.1 on seal-round-proposal", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationRoundClient({ networkClient });
    await client.sealRoundProposal(sealRequest);
    expect(networkClient.requests[0]?.body).toMatchObject({ version: "0.9.1" });
  });

  it("pins the default contract version to 0.9.1 on evaluate-round", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationRoundClient({ networkClient });
    await client.evaluateRound(evaluateRequest);
    expect(networkClient.requests[0]?.body).toMatchObject({ version: "0.9.1" });
  });

  it("honours an explicit contractVersion override on both methods", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationRoundClient({
      networkClient,
      contractVersion: "0.8.0-round-canary",
    });
    await client.sealRoundProposal(sealRequest);
    await client.evaluateRound(evaluateRequest);
    expect(networkClient.requests[0]?.body).toMatchObject({
      version: "0.8.0-round-canary",
    });
    expect(networkClient.requests[1]?.body).toMatchObject({
      version: "0.8.0-round-canary",
    });
  });
});

describe("T3NegotiationRoundClient — seal-round-proposal wire shape", () => {
  it("posts the seal-round-proposal body in snake_case to match the Rust contract's deserializer", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationRoundClient({ networkClient });
    const result = await client.sealRoundProposal(sealRequest);
    expect(result.proposalHandle).toBe(
      "round_capture_buy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(networkClient.requests[0]?.path).toBe(
      "/contracts/negotiation/round-proposals",
    );
    expect(networkClient.requests[0]?.method).toBe("POST");
    expect(networkClient.requests[0]?.body).toEqual({
      version: "0.9.1",
      sealed_envelope: sealRequest.sealedEnvelope,
      envelope_master_key_hex: sealRequest.envelopeMasterKeyHex,
      institution_did: sealRequest.institutionDid,
      agent_did: sealRequest.agentDid,
      authority_ref: sealRequest.authorityRef,
      asset_code: sealRequest.assetCode,
      side: sealRequest.side,
      correlation_ref: sealRequest.correlationRef,
    });
  });
});

describe("T3NegotiationRoundClient — evaluate-round wire shape", () => {
  it("posts the evaluate-round body in snake_case to match the Rust contract's deserializer", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3NegotiationRoundClient({ networkClient });
    const result = await client.evaluateRound(evaluateRequest);
    expect(result.status).toBe("crossed");
    expect(result.executionPrice).toBe(70_050);
    expect(result.matchedQuantity).toBe(1);
    expect(result.roundAttestationRef).toBe(
      "roundattest_capture_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(networkClient.requests[0]?.path).toBe(
      "/contracts/negotiation/round-evaluation",
    );
    expect(networkClient.requests[0]?.body).toEqual({
      version: "0.9.1",
      buy_proposal_handle: evaluateRequest.buyProposalHandle,
      sell_proposal_handle: evaluateRequest.sellProposalHandle,
      asset_code: evaluateRequest.assetCode,
      correlation_ref: evaluateRequest.correlationRef,
    });
  });
});

describe("T3NegotiationRoundClient — defense-in-depth local fallback", () => {
  it("falls back to an in-process envelope decode when the host omits the new seal route", async () => {
    const networkClient = new RejectingRouteNetworkClient();
    const client = new T3NegotiationRoundClient({ networkClient });
    // Use a real AEAD envelope so the fallback's `openEnvelope`
    // call passes the GCM tag verification. The descriptor the
    // client returns in this branch is keyed off the envelope
    // bytes via the in-process fallback path.
    const realEnvelope = buildRealSealedEnvelope();
    const result = await client.sealRoundProposal({
      ...sealRequest,
      sealedEnvelope: realEnvelope,
    });
    // The fallback should still produce a usable descriptor with
    // a `round_<32-hex>` handle. The exact handle depends on a
    // random seed, so we only assert the shape.
    expect(result.proposalHandle).toMatch(/^round_[0-9a-f]{32}$/u);
    expect(result.attestationRef).toMatch(/^roundattest_seal_/u);
    expect(result.sealedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("returns an `open` verdict on a missing evaluate-round route so the orchestrator falls back to active", async () => {
    const networkClient = new RejectingRouteNetworkClient();
    const client = new T3NegotiationRoundClient({ networkClient });
    const result = await client.evaluateRound(evaluateRequest);
    expect(result.status).toBe("open");
    expect(result.executionPrice).toBe(0);
    expect(result.matchedQuantity).toBe(0);
    // The fallback still mints a round attestation reference so
    // downstream audit consumers see a stable identifier (even
    // though the cross itself did not happen inside the TEE).
    expect(result.roundAttestationRef).toMatch(/^roundattest_/u);
  });
});

describe("T3NegotiationRoundClient — evaluate-round cross validation", () => {
  it("rejects a non-positive matched_quantity on a crossed outcome", async () => {
    class CrossedZeroClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 200,
          body: {
            status: "crossed",
            buyer_signal: "crossed",
            seller_signal: "crossed",
            execution_price: "70000",
            matched_quantity: "0",
            outcome_ref: "outcome_zero",
            execution_ref: "exec_zero",
            encrypted_trade_fields_ref: "fields_zero",
            expires_at: "2026-06-21T00:05:00.000Z",
          } as TBody,
        };
      }
    }
    const client = new T3NegotiationRoundClient({
      networkClient: new CrossedZeroClient(),
    });
    await expect(client.evaluateRound(evaluateRequest)).rejects.toThrow(
      /matched_quantity/,
    );
  });

  it("rejects a non-positive execution_price on a crossed outcome", async () => {
    class CrossedZeroPriceClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 200,
          body: {
            status: "crossed",
            buyer_signal: "crossed",
            seller_signal: "crossed",
            execution_price: "0",
            matched_quantity: "1",
            outcome_ref: "outcome_zero_price",
            execution_ref: "exec_zero_price",
            encrypted_trade_fields_ref: "fields_zero_price",
            expires_at: "2026-06-21T00:05:00.000Z",
          } as TBody,
        };
      }
    }
    const client = new T3NegotiationRoundClient({
      networkClient: new CrossedZeroPriceClient(),
    });
    await expect(client.evaluateRound(evaluateRequest)).rejects.toThrow(
      /execution_price/,
    );
  });
});

describe("distanceSignalFor — coarse bucketing", () => {
  it("returns `crossed` when bid is at or above ask", () => {
    expect(distanceSignalFor(70_050, 70_050)).toBe("crossed");
    expect(distanceSignalFor(70_100, 70_000)).toBe("crossed");
  });

  it("returns `near` for ≤1% gap normalized to ask", () => {
    expect(distanceSignalFor(70_000, 70_001)).toBe("near");
    expect(distanceSignalFor(69_500, 70_000)).toBe("near");
  });

  it("returns `moderate` for >1% and ≤5% gap normalized to ask", () => {
    // Gap (70_500 - 70_000) / 70_500 ≈ 0.0071 ≈ 0.71% → near
    // Gap (75_000 - 70_000) / 75_000 ≈ 0.0667 ≈ 6.67% → far (above 5%)
    // Gap (72_000 - 70_000) / 72_000 ≈ 0.0278 ≈ 2.78% → moderate
    expect(distanceSignalFor(70_000, 72_000)).toBe("moderate");
    expect(distanceSignalFor(68_500, 70_000)).toBe("moderate");
  });

  it("returns `far` for >5% gap normalized to ask", () => {
    expect(distanceSignalFor(60_000, 70_000)).toBe("far");
  });

  it("returns `far` for non-finite inputs", () => {
    expect(distanceSignalFor(Number.NaN, 70_000)).toBe("far");
    expect(distanceSignalFor(70_000, Number.NaN)).toBe("far");
  });
});
