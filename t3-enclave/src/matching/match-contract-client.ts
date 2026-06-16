import { randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface MatchEvaluationRequest {
  buyIntentHandle: string;
  sellIntentHandle: string;
  correlationRef: string;
}

export interface OpaqueMatchOutcome {
  outcomeRef: string;
  executionRef: string;
  buyerInstitutionId: string;
  sellerInstitutionId: string;
  encryptedTradeFieldsRef: string;
  buyerAuthorityRef: string;
  sellerAuthorityRef: string;
  expiresAt: string;
  status: "matched" | "no_match";
}

export interface MatchContractClient {
  evaluateMatch(request: MatchEvaluationRequest): Promise<OpaqueMatchOutcome>;
}

export interface T3MatchContractClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  contractPath?: string;
}

interface T3MatchOutcomeResponse {
  outcome_ref?: string;
  execution_ref?: string;
  buyer_institution_id?: string;
  seller_institution_id?: string;
  encrypted_trade_fields_ref?: string;
  buyer_authority_ref?: string;
  seller_authority_ref?: string;
  expires_at?: string;
  status?: "matched" | "no_match";
}

function requireOpaque(value: string | undefined, field: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`T3 match response missing ${field}.`);
  }

  return value;
}

export class T3MatchContractClient implements MatchContractClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;

  public constructor(options: T3MatchContractClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/matching/evaluate";
  }

  public async evaluateMatch(
    request: MatchEvaluationRequest,
  ): Promise<OpaqueMatchOutcome> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3MatchOutcomeResponse>({
      method: "POST",
      path: this.contractPath,
      body: {
        // The TEE contract's `EvaluateMatchInput` deserializer
        // (contracts/matching-policy/src/lib.rs) expects
        // snake_case keys — `buy_intent_handle`,
        // `sell_intent_handle`, `correlation_ref`. The public
        // `MatchEvaluationRequest` is camelCase to match the
        // rest of the GhostBroker API surface, so we translate
        // at the network boundary. Posting the camelCase
        // form would produce the same T3N 400 the seal path
        // was hitting (missing field) once the contract
        // exercise path is wired up.
        buy_intent_handle: request.buyIntentHandle,
        sell_intent_handle: request.sellIntentHandle,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 match evaluation failed.");
    }

    return {
      outcomeRef: requireOpaque(response.body.outcome_ref, "outcome_ref"),
      executionRef: response.body.execution_ref ?? `t3exec_${randomUUID()}`,
      // The TEE match contract intentionally returns empty strings
      // for the buyer/seller institution ids and authority refs:
      // it does not have that context inside the enclave. The
      // orchestrator already verified both agents and stamps the
      // actual values from its pending-intent queue before
      // settlement. Requiring these to be non-empty here would make
      // every real T3-backed match evaluation fail.
      buyerInstitutionId: response.body.buyer_institution_id ?? "",
      sellerInstitutionId: response.body.seller_institution_id ?? "",
      encryptedTradeFieldsRef: requireOpaque(
        response.body.encrypted_trade_fields_ref,
        "encrypted_trade_fields_ref",
      ),
      buyerAuthorityRef: response.body.buyer_authority_ref ?? "",
      sellerAuthorityRef: response.body.seller_authority_ref ?? "",
      expiresAt: requireOpaque(response.body.expires_at, "expires_at"),
      status: response.body.status ?? "matched",
    };
  }
}
