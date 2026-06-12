import { createHash, randomUUID } from "node:crypto";
import type { TokenBalanceClient } from "../sandbox/token-balance.js";
import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface BlindIntentRequest {
  institutionId: string;
  agentDid: string;
  encryptedIntentEnvelope: string;
  authorityRef: string;
  correlationRef: string;
}

export interface BlindIntentResult {
  intentHandle: string;
  state: "intent_sealed";
  executionRef: string;
  sealedAt: string;
}

export interface BlindIntentClient {
  sealIntent(request: BlindIntentRequest): Promise<BlindIntentResult>;
}

export interface T3BlindIntentClientOptions {
  networkClient: T3NetworkClient;
  tokenBalanceClient?: TokenBalanceClient;
  tokenAccount?: string;
  minimumTokenBalance?: bigint;
  contractPath?: string;
}

interface T3BlindIntentResponse {
  intent_handle?: string;
  execution_ref?: string;
}

function opaqueHandle(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `intent_${digest.slice(0, 32)}`;
}

export class T3BlindIntentClient implements BlindIntentClient {
  private readonly networkClient: T3NetworkClient;
  private readonly tokenBalanceClient: TokenBalanceClient | undefined;
  private readonly tokenAccount: string | undefined;
  private readonly minimumTokenBalance: bigint;
  private readonly contractPath: string;

  public constructor(options: T3BlindIntentClientOptions) {
    this.networkClient = options.networkClient;
    this.tokenBalanceClient = options.tokenBalanceClient;
    this.tokenAccount = options.tokenAccount;
    this.minimumTokenBalance = options.minimumTokenBalance ?? 1n;
    this.contractPath = options.contractPath ?? "/contracts/matching/blind-intents";
  }

  public async sealIntent(request: BlindIntentRequest): Promise<BlindIntentResult> {
    if (this.tokenBalanceClient && this.tokenAccount) {
      await this.tokenBalanceClient.assertMinimumBalance(
        this.tokenAccount,
        this.minimumTokenBalance,
      );
    }

    const response = await this.networkClient.request<T3BlindIntentResponse>({
      method: "POST",
      path: this.contractPath,
      body: {
        institutionId: request.institutionId,
        agentDid: request.agentDid,
        encryptedIntentEnvelope: request.encryptedIntentEnvelope,
        authorityRef: request.authorityRef,
        correlationRef: request.correlationRef,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("T3 hidden intent sealing failed.");
    }

    const fallbackSeed = [
      request.institutionId,
      request.agentDid,
      request.authorityRef,
      request.correlationRef,
      randomUUID(),
    ].join(":");

    return {
      intentHandle: response.body.intent_handle ?? opaqueHandle(fallbackSeed),
      executionRef: response.body.execution_ref ?? `t3exec_${randomUUID()}`,
      state: "intent_sealed",
      sealedAt: new Date().toISOString(),
    };
  }
}
