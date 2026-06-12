import type { T3NetworkClient } from "./t3n-client.js";

export interface TokenBalance {
  account: string;
  available: bigint;
  minimumRequired: bigint;
}

export interface TokenBalanceClient {
  getBalance(account: string): Promise<TokenBalance>;
  assertMinimumBalance(account: string, minimumRequired: bigint): Promise<TokenBalance>;
}

interface TokenBalanceResponse {
  account: string;
  available: string;
}

export class InsufficientT3TokenBalanceError extends Error {
  public readonly balance: TokenBalance;

  public constructor(balance: TokenBalance) {
    super("T3 token balance is below the required execution minimum.");
    this.name = "InsufficientT3TokenBalanceError";
    this.balance = balance;
  }
}

export class SandboxTokenBalanceClient implements TokenBalanceClient {
  private readonly networkClient: T3NetworkClient;
  private readonly endpointPath: string;

  public constructor(networkClient: T3NetworkClient, endpointPath = "/tokens/balance") {
    this.networkClient = networkClient;
    this.endpointPath = endpointPath;
  }

  public async getBalance(account: string): Promise<TokenBalance> {
    const response = await this.networkClient.request<TokenBalanceResponse>({
      method: "POST",
      path: this.endpointPath,
      body: { account },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error("Unable to read T3 sandbox token balance.");
    }

    return {
      account: response.body.account,
      available: BigInt(response.body.available),
      minimumRequired: 0n,
    };
  }

  public async assertMinimumBalance(
    account: string,
    minimumRequired: bigint,
  ): Promise<TokenBalance> {
    const balance = await this.getBalance(account);
    const checkedBalance = {
      ...balance,
      minimumRequired,
    };

    if (checkedBalance.available < minimumRequired) {
      throw new InsufficientT3TokenBalanceError(checkedBalance);
    }

    return checkedBalance;
  }
}
