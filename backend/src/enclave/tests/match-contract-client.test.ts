import { describe, expect, it } from "vitest";
import {
  T3MatchContractClient,
  type MatchEvaluationRequest,
} from "../matching/match-contract-client.js";
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
    return {
      status: 202,
      body: {
        outcome_ref: "match_outcome_us3",
        execution_ref: "t3exec_us3",
        buyer_institution_id: "00000000-0000-4000-8000-000000000301",
        seller_institution_id: "00000000-0000-4000-8000-000000000302",
        encrypted_trade_fields_ref: "encrypted_trade_fields_us3",
        buyer_authority_ref: "authority:buyer:settle",
        seller_authority_ref: "authority:seller:settle",
        match_attestation_ref: "match_attest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expires_at: "2026-06-13T00:00:00.000Z",
        status: "matched",
        matched_quantity: "4",
        execution_price: "50000",
        buyer_locked_amount: "200000",
        seller_locked_amount: "4",
        asset_code_ciphertext: "aead.v1:abcdef:123456",
        quantity_ciphertext: "aead.v1:fedcba:654321",
        execution_price_ciphertext: "aead.v1:deadbeef:cafebabe",
      } as TBody,
    };
  }
}

const request: MatchEvaluationRequest = {
  buyIntentHandle: "intent_buy_opaque",
  sellIntentHandle: "intent_sell_opaque",
  correlationRef: "corr_us3",
  // v0.10.0: the TEE recovers price/quantity from its kv-store
  // by handle — the orchestrator no longer forwards per-side
  // trading parameters on the evaluate-match wire.
  assetCode: "WBTC",
  // v0.8.0: per-side identity is now required on every
  // `evaluate-match` call so the TEE can echo the values back
  // and bind them to a match attestation. The orchestrator's
  // pending-intent queue already holds these (verified at seal
  // time) and forwards them verbatim.
  buyInstitutionId: "00000000-0000-4000-8000-000000000301",
  sellInstitutionId: "00000000-0000-4000-8000-000000000302",
  buyAuthorityRef: "authority:buyer:settle",
  sellAuthorityRef: "authority:seller:settle",
  envelopeMasterKeyHex: "8e4e3b54069440b0486c7af2755799367ae6f21b512b62b5837003f374884739",
};

describe("match contract client", () => {
  it("returns opaque match outcomes with enclave-decided fill terms", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3MatchContractClient({ networkClient });

    await expect(client.evaluateMatch(request)).resolves.toMatchObject({
      outcomeRef: "match_outcome_us3",
      executionRef: "t3exec_us3",
      encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
      assetCodeCiphertext: "aead.v1:abcdef:123456",
      quantityCiphertext: "aead.v1:fedcba:654321",
      executionPriceCiphertext: "aead.v1:deadbeef:cafebabe",
      status: "matched",
      matchedQuantity: 4,
      executionPrice: 50000,
    });
    // The on-the-wire body is snake_case to match the TEE
    // contract's `EvaluateMatchInput` deserializer in
    // contracts/matching-policy/src/lib.rs, and carries the
    // explicit contract version so the T3N adapter routes to
    // the v0.11.0 build (kv-store-backed state). The per-side
    // institution IDs and authority refs are forwarded to the
    // TEE so it can echo them back on the outcome and bind them
    // to the match attestation ref.
    expect(networkClient.requests[0]?.body).toEqual({
      version: "0.15.1",
      buy_intent_handle: request.buyIntentHandle,
      sell_intent_handle: request.sellIntentHandle,
      correlation_ref: request.correlationRef,
      asset_code: request.assetCode,
      buy_institution_id: request.buyInstitutionId,
      sell_institution_id: request.sellInstitutionId,
      buy_authority_ref: request.buyAuthorityRef,
      sell_authority_ref: request.sellAuthorityRef,
      envelope_master_key_hex: request.envelopeMasterKeyHex,
    });
  });

  it("surfaces the TEE-echoed institution ids and authority refs on a matched outcome", async () => {
    // v0.8.0 audit-trail fix: the TEE echoes the per-side
    // identity on the match outcome and binds them to a match
    // attestation ref. The client surfaces them on the
    // `OpaqueMatchOutcome` so the orchestrator can assert the
    // echo matches the queue values it submitted and use the
    // TEE-attested values for settlement (not the in-memory
    // queue values).
    const client = new T3MatchContractClient({
      networkClient: new CapturingNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).resolves.toMatchObject({
      status: "matched",
      buyerInstitutionId: "00000000-0000-4000-8000-000000000301",
      sellerInstitutionId: "00000000-0000-4000-8000-000000000302",
      buyerAuthorityRef: "authority:buyer:settle",
      sellerAuthorityRef: "authority:seller:settle",
      matchAttestationRef:
        "match_attest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("accepts a matched outcome with empty identity for backwards compatibility", async () => {
    // v0.8.0: an empty identity on a matched outcome is no
    // longer a happy path (the TEE refuses to fill without
    // non-empty identity). But the client still surfaces the
    // empty strings it received so a pre-v0.8.0 host that
    // returns the legacy shape doesn't crash the orchestrator
    // — the orchestrator's `detectIdentityMismatch` check
    // catches the mismatch and refuses the settlement. See the
    // matching-orchestrator tests for the fail-closed path.
    class EmptyFieldsNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            outcome_ref: "match_outcome_empty",
            execution_ref: "t3exec_empty",
            buyer_institution_id: "",
            seller_institution_id: "",
            encrypted_trade_fields_ref: "encrypted_trade_fields_empty",
            buyer_authority_ref: "",
            seller_authority_ref: "",
            match_attestation_ref: "",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
            matched_quantity: "4",
            execution_price: "50000",
            buyer_locked_amount: "200000",
            seller_locked_amount: "4",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new EmptyFieldsNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).resolves.toMatchObject({
      outcomeRef: "match_outcome_empty",
      buyerInstitutionId: "",
      sellerInstitutionId: "",
      buyerAuthorityRef: "",
      sellerAuthorityRef: "",
      matchAttestationRef: "",
      status: "matched",
      matchedQuantity: 4,
      executionPrice: 50000,
    });
  });

  it("accepts a no_match outcome without per-side identity fields", async () => {
    // `no_match` is a non-fill. The TEE still echoes the
    // identity on the rejection so the orchestrator's audit log
    // records which institution pair was rejected, but a
    // legacy pre-v0.8.0 host that returns empty strings on a
    // no_match does not block the orchestrator (the
    // orchestrator only enforces identity on a matched outcome;
    // a no_match is a benign rejection).
    class NoMatchNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            outcome_ref: "match_outcome_nomatch",
            execution_ref: "t3exec_nomatch",
            buyer_institution_id: "",
            seller_institution_id: "",
            encrypted_trade_fields_ref: "fields_nomatch",
            buyer_authority_ref: "",
            seller_authority_ref: "",
            match_attestation_ref: "",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "no_match",
            matched_quantity: "",
            execution_price: "",
            buyer_locked_amount: "",
            seller_locked_amount: "",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new NoMatchNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).resolves.toMatchObject({
      status: "no_match",
      matchedQuantity: 0,
      executionPrice: 0,
      matchAttestationRef: "",
    });
  });

  it("still rejects a response missing the opaque outcome ref", async () => {
    // The genuinely-required opaque fields (outcome_ref,
    // encrypted_trade_fields_ref, expires_at) must still throw when
    // absent — relaxing the institution/authority fields must not
    // weaken these.
    class MissingOutcomeRefNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            execution_ref: "t3exec_x",
            encrypted_trade_fields_ref: "fields_x",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
            matched_quantity: "4",
            execution_price: "50000",
            buyer_locked_amount: "200000",
            seller_locked_amount: "4",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new MissingOutcomeRefNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).rejects.toThrow(/outcome_ref/);
  });

  it("rejects a matched response whose matched_quantity is missing", async () => {
    // A `matched` outcome without a positive fill quantity is
    // malformed and must not be trusted for settlement — the
    // client rejects rather than letting the backend fall back
    // to a local recomputation, which would silently
    // re-centralize match authority.
    class MissingQuantityNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            outcome_ref: "match_outcome_no_qty",
            execution_ref: "t3exec_no_qty",
            encrypted_trade_fields_ref: "fields_no_qty",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
            matched_price: "50000",
            execution_price: "50000",
            buyer_locked_amount: "200000",
            seller_locked_amount: "4",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new MissingQuantityNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).rejects.toThrow(
      /matched_quantity/,
    );
  });

  it("rejects a matched response whose execution_price is non-positive", async () => {
    class ZeroPriceNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            outcome_ref: "match_outcome_zero_price",
            execution_ref: "t3exec_zero_price",
            encrypted_trade_fields_ref: "fields_zero_price",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
            matched_quantity: "4",
            execution_price: "0",
            buyer_locked_amount: "200000",
            seller_locked_amount: "4",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new ZeroPriceNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).rejects.toThrow(
      /execution_price/,
    );
  });

  it("honours an explicit contractVersion override", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3MatchContractClient({
      networkClient,
      contractVersion: "0.7.1",
    });

    await client.evaluateMatch(request);

    const body = networkClient.requests[0]?.body as Record<string, unknown>;
    expect(body.version).toBe("0.7.1");
  });

  it("decodes fractional-decimal fill fields from the v0.4.0 wire form", async () => {
    // v0.4.0 of the matching contract accepts and emits fractional
    // decimal strings (e.g. `"0.0001"` for 0.0001 WBTC). The
    // client must surface them as JS numbers without rounding
    // them back to integers — the settlement rail takes those
    // numbers and applies the per-asset decimals via
    // `parseUnits(quantity.toString(), decimals)`.
    class FractionalFillNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            outcome_ref: "match_outcome_fractional",
            execution_ref: "t3exec_fractional",
            buyer_institution_id: "00000000-4000-8000-000000000301", // padded
            seller_institution_id: "00000000-4000-8000-000000000302", // padded
            encrypted_trade_fields_ref: "fields_fractional",
            buyer_authority_ref: "authority:buyer:settle",
            seller_authority_ref: "authority:seller:settle",
            match_attestation_ref: "match_attest_fractional",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
            matched_quantity: "0.0001",
            execution_price: "50000",
            buyer_locked_amount: "0.005",
            seller_locked_amount: "0.0001",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new FractionalFillNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).resolves.toMatchObject({
      status: "matched",
      matchedQuantity: 0.0001,
      executionPrice: 50000,
    });
  });

  it("rejects a matched response whose matched_quantity is a malformed decimal", async () => {
    // Anything that isn't a plain non-negative decimal (signs,
    // exponents, underscores, embedded whitespace, multiple
    // dots, etc.) is malformed and must not be trusted for
    // settlement — the client rejects rather than letting
    // `Number(...)` silently round through.
    class MalformedFillNetworkClient implements T3NetworkClient {
      public async request<TBody = unknown>(): Promise<T3NetworkResponse<TBody>> {
        return {
          status: 202,
          body: {
            outcome_ref: "match_outcome_malformed",
            execution_ref: "t3exec_malformed",
            encrypted_trade_fields_ref: "fields_malformed",
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
            matched_quantity: "1e-4",
            execution_price: "50000",
            buyer_locked_amount: "0.05",
            seller_locked_amount: "0.0001",
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new MalformedFillNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).rejects.toThrow(
      /matched_quantity/,
    );
  });
});
