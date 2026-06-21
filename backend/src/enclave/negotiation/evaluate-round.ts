import type {
  EvaluateRoundRequest,
  NegotiationDistanceSignal,
  NegotiationRoundClient,
  RoundEvaluationResult,
  RoundProposalDescriptor,
  SealRoundProposalRequest,
} from "./round-client.js";

export type {
  EvaluateRoundRequest,
  NegotiationDistanceSignal,
  RoundEvaluationResult,
  RoundProposalDescriptor,
  SealRoundProposalRequest,
} from "./round-client.js";

/**
 * Re-export the canonical types from the TEE-backed round client.
 *
 * The historical entry point — `evaluate-round.ts` — defined the
 * inline plaintext round math; that implementation computed the
 * cross outside the TEE and violated the SUBMISSION.md privacy
 * claim ("matched and settled inside a Terminal 3 Trusted Execution
 * Environment without any counterparty ever seeing another
 * counterparty's parameters"). The implementation now lives in
 * {@link ./round-client.ts}. This module re-exports the canonical
 * shapes so existing importers (the orchestrator, the app
 * composition site, the test doubles) keep resolving without churn.
 */

export interface SealRoundProposalInput {
  sessionId: string;
  roundNumber: number;
  correlationRef: string;
  sealedEnvelope: string;
  institutionDid: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  /**
   * Hex-encoded AEAD master key the TEE uses to decrypt the
   * sealed envelope inside the enclave. Forwarded from
   * `loadEnvelopeMasterKey().key.toString("hex")` by the
   * orchestrator.
   */
  envelopeMasterKeyHex: string;
}

export interface EvaluateRoundOutput {
  status: "crossed" | "open";
  buyerSignal: NegotiationDistanceSignal;
  sellerSignal: NegotiationDistanceSignal;
  executionPrice: number;
  matchedQuantity: number;
  outcomeRef: string;
  executionRef: string;
  encryptedTradeFieldsRef: string;
  expiresAt: string;
  evaluatedAt: string;
  /**
   * TEE-attested cross attestation reference. Mirrors the
   * `match_attestation_ref` returned by `evaluate-match` so the
   * settlement service can verify the cross was bound to the exact
   * proposal handles the TEE unsealed.
   */
  roundAttestationRef: string;
  /** v0.13.0: AES-256-GCM ciphertext of asset code. */
  assetCodeCiphertext: string;
  /** v0.13.0: AES-256-GCM ciphertext of matched quantity. */
  quantityCiphertext: string;
  /** v0.13.0: AES-256-GCM ciphertext of execution price. */
  executionPriceCiphertext: string;
}

export interface NegotiationRoundEvaluator {
  sealRoundProposal(
    input: SealRoundProposalInput,
  ): Promise<RoundProposalDescriptor>;
  evaluateRound(request: EvaluateRoundRequest): Promise<EvaluateRoundOutput>;
}

/**
 * TEE-backed round evaluator. The previous `T3NegotiationRoundEvaluator`
 * computed the cross inline; the new implementation routes both the
 * seal step and the cross step through the T3 negotiation round
 * contract so the orchestrator never sees plaintext price / quantity
 * on the cross-evaluation path. The constructor accepts a
 * `roundClient` so test doubles can inject a stub; production callers
 * (the `app.ts` composition site) wire up a real
 * `T3NegotiationRoundClient` at boot.
 */
export class T3NegotiationRoundEvaluator implements NegotiationRoundEvaluator {
  private readonly roundClient: NegotiationRoundClient;

  public constructor(roundClient: NegotiationRoundClient) {
    this.roundClient = roundClient;
  }

  public async sealRoundProposal(
    input: SealRoundProposalInput,
  ): Promise<RoundProposalDescriptor> {
    const request: SealRoundProposalRequest = {
      sealedEnvelope: input.sealedEnvelope,
      envelopeMasterKeyHex: input.envelopeMasterKeyHex,
      institutionDid: input.institutionDid,
      agentDid: input.agentDid,
      authorityRef: input.authorityRef,
      assetCode: input.assetCode,
      side: input.side,
      correlationRef: `${input.sessionId}:${input.roundNumber}:${input.correlationRef}`,
    };
    return this.roundClient.sealRoundProposal(request);
  }

  public async evaluateRound(
    request: EvaluateRoundRequest,
  ): Promise<EvaluateRoundOutput> {
    const result = await this.roundClient.evaluateRound(request);
    return adaptRoundEvaluation(result);
  }
}

function adaptRoundEvaluation(
  result: RoundEvaluationResult,
): EvaluateRoundOutput {
  return {
    status: result.status,
    buyerSignal: result.buyerSignal,
    sellerSignal: result.sellerSignal,
    executionPrice: result.executionPrice,
    matchedQuantity: result.matchedQuantity,
    outcomeRef: result.outcomeRef,
    executionRef: result.executionRef,
    encryptedTradeFieldsRef: result.encryptedTradeFieldsRef,
    expiresAt: result.expiresAt,
    evaluatedAt: result.evaluatedAt,
    roundAttestationRef: result.roundAttestationRef,
    assetCodeCiphertext: result.assetCodeCiphertext,
    quantityCiphertext: result.quantityCiphertext,
    executionPriceCiphertext: result.executionPriceCiphertext,
  };
}

export { distanceSignalFor, T3NegotiationRoundClient } from "./round-client.js";
