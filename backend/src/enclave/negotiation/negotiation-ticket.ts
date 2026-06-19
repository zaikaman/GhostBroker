import { createHash, randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface NegotiationTicketRequest {
  institutionId: string;
  agentDid: string;
  authorityRef: string;
  assetCode: string;
  side: "buy" | "sell";
  policyHash: string;
  compatibilityToken: string;
  correlationRef: string;
}

export interface NegotiationTicketResult {
  ticketHandle: string;
  executionRef: string;
  sealedAt: string;
  state: "ticket_sealed";
}

export interface NegotiationTicketClient {
  sealTicket(request: NegotiationTicketRequest): Promise<NegotiationTicketResult>;
}

export interface T3NegotiationTicketClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  contractPath?: string;
}

interface T3NegotiationTicketResponse {
  ticket_handle?: string;
  execution_ref?: string;
}

function opaqueHandle(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `ticket_${digest.slice(0, 32)}`;
}

export class T3NegotiationTicketClient implements NegotiationTicketClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;

  public constructor(options: T3NegotiationTicketClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/negotiation/tickets";
  }

  public async sealTicket(
    request: NegotiationTicketRequest,
  ): Promise<NegotiationTicketResult> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3NegotiationTicketResponse>({
      method: "POST",
      path: this.contractPath,
      body: {
        institution_id: request.institutionId,
        agent_did: request.agentDid,
        authority_ref: request.authorityRef,
        asset_code: request.assetCode,
        side: request.side,
        policy_hash: request.policyHash,
        compatibility_token: request.compatibilityToken,
        correlation_ref: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 negotiation ticket seal failed.");
    }

    const fallbackSeed = [
      request.institutionId,
      request.agentDid,
      request.authorityRef,
      request.correlationRef,
      randomUUID(),
    ].join(":");

    return {
      ticketHandle: response.body.ticket_handle ?? opaqueHandle(fallbackSeed),
      executionRef: response.body.execution_ref ?? `t3exec_${randomUUID()}`,
      sealedAt: new Date().toISOString(),
      state: "ticket_sealed",
    };
  }
}
