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
        expires_at: "2026-06-13T00:00:00.000Z",
        status: "matched",
      } as TBody,
    };
  }
}

const request: MatchEvaluationRequest = {
  buyIntentHandle: "intent_buy_opaque",
  sellIntentHandle: "intent_sell_opaque",
  correlationRef: "corr_us3",
};

describe("match contract client", () => {
  it("returns opaque match outcomes only", async () => {
    const networkClient = new CapturingNetworkClient();
    const client = new T3MatchContractClient({ networkClient });

    await expect(client.evaluateMatch(request)).resolves.toMatchObject({
      outcomeRef: "match_outcome_us3",
      executionRef: "t3exec_us3",
      encryptedTradeFieldsRef: "encrypted_trade_fields_us3",
      status: "matched",
    });
    // The on-the-wire body is snake_case to match the TEE
    // contract's `EvaluateMatchInput` deserializer in
    // contracts/matching-policy/src/lib.rs. The public
    // `MatchEvaluationRequest` is camelCase; the translation
    // lives in `T3MatchContractClient.evaluateMatch`.
    expect(networkClient.requests[0]?.body).toEqual({
      buy_intent_handle: request.buyIntentHandle,
      sell_intent_handle: request.sellIntentHandle,
      correlation_ref: request.correlationRef,
    });
  });

  it("accepts a matched outcome whose institution/authority fields are empty", async () => {
    // The TEE matching contract cannot see the buyer/seller
    // institution ids or authority refs, so it returns empty
    // strings for them (contracts/matching-policy/src/matching.rs).
    // The client must NOT reject this — the orchestrator stamps the
    // canonical values from its verified pending-intent queue before
    // settlement. Requiring them here made every real match throw.
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
            expires_at: "2026-06-13T00:00:00.000Z",
            status: "matched",
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
      status: "matched",
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
          } as TBody,
        };
      }
    }

    const client = new T3MatchContractClient({
      networkClient: new MissingOutcomeRefNetworkClient(),
    });

    await expect(client.evaluateMatch(request)).rejects.toThrow(/outcome_ref/);
  });
});
