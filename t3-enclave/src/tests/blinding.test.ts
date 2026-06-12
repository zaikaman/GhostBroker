import { describe, expect, it } from "vitest";
import {
  T3BlindIntentClient,
  type BlindIntentRequest,
} from "../matching/blind-intent.js";
import type {
  T3NetworkClient,
  T3NetworkRequest,
  T3NetworkResponse,
} from "../sandbox/t3n-client.js";
import type { TokenBalanceClient, TokenBalance } from "../sandbox/token-balance.js";

class CapturingNetworkClient implements T3NetworkClient {
  public requests: T3NetworkRequest[] = [];

  public async request<TBody = unknown>(
    request: T3NetworkRequest,
  ): Promise<T3NetworkResponse<TBody>> {
    this.requests.push(request);
    return {
      status: 202,
      body: {
        intent_handle: "intent_t3_opaque",
        execution_ref: "t3exec_opaque",
      } as TBody,
    };
  }
}

class ReadyTokenClient implements TokenBalanceClient {
  public checked = false;

  public async getBalance(account: string): Promise<TokenBalance> {
    return {
      account,
      available: 10n,
      minimumRequired: 0n,
    };
  }

  public async assertMinimumBalance(
    account: string,
    minimumRequired: bigint,
  ): Promise<TokenBalance> {
    this.checked = true;
    return {
      account,
      available: 10n,
      minimumRequired,
    };
  }
}

const request: BlindIntentRequest = {
  institutionId: "00000000-0000-4000-8000-000000000201",
  agentDid: "did:t3n:agent:us2-authorized",
  encryptedIntentEnvelope: "t3env.safe.ciphertext",
  authorityRef: "authority:us2:intent-submit",
  correlationRef: "corr_us2",
};

describe("blind intent client", () => {
  it("converts encrypted payloads into opaque handles only", async () => {
    const networkClient = new CapturingNetworkClient();
    const tokenClient = new ReadyTokenClient();
    const client = new T3BlindIntentClient({
      networkClient,
      tokenBalanceClient: tokenClient,
      tokenAccount: "did:t3n:institution:us2",
      minimumTokenBalance: 1n,
    });

    await expect(client.sealIntent(request)).resolves.toEqual({
      intentHandle: "intent_t3_opaque",
      state: "intent_sealed",
      executionRef: "t3exec_opaque",
      sealedAt: expect.any(String) as string,
    });
    expect(tokenClient.checked).toBe(true);
    expect(networkClient.requests[0]?.body).toEqual(request);
  });
});
