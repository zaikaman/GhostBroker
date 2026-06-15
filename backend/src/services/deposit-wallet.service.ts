import { createHmac } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export interface DepositWalletService {
  deriveDepositPrivateKey(institutionSeed: string): Hex;
  deriveDepositAddress(institutionSeed: string): Address;
}

export class HmacDepositWalletService implements DepositWalletService {
  private readonly masterSeed: Buffer;

  public constructor(masterSeed: string) {
    if (!/^0x[0-9a-f]{64}$/iu.test(masterSeed)) {
      throw new Error(
        "HmacDepositWalletService: masterSeed must be a 0x-prefixed 64-hex string.",
      );
    }
    this.masterSeed = Buffer.from(masterSeed.slice(2), "hex");
  }

  public deriveDepositPrivateKey(institutionSeed: string): Hex {
    const digest = createHmac("sha256", this.masterSeed)
      .update("ghostbroker:chain-sepolia:deposit-wallet:", "utf8")
      .update(institutionSeed, "utf8")
      .digest("hex");
    return `0x${digest}` as Hex;
  }

  public deriveDepositAddress(institutionSeed: string): Address {
    return privateKeyToAccount(this.deriveDepositPrivateKey(institutionSeed)).address;
  }
}
