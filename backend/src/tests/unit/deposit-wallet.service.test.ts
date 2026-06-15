import { describe, expect, it } from "vitest";
import { HmacDepositWalletService } from "../../services/deposit-wallet.service.js";

describe("HmacDepositWalletService", () => {
  it("derives a stable private key and address for the same institution seed", () => {
    const service = new HmacDepositWalletService(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );

    const privateKeyA = service.deriveDepositPrivateKey("did:t3n:tenant:northstar");
    const privateKeyB = service.deriveDepositPrivateKey("did:t3n:tenant:northstar");
    const addressA = service.deriveDepositAddress("did:t3n:tenant:northstar");
    const addressB = service.deriveDepositAddress("did:t3n:tenant:northstar");

    expect(privateKeyA).toBe(privateKeyB);
    expect(addressA).toBe(addressB);
    expect(privateKeyA).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(addressA).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  });

  it("derives distinct wallets for distinct institution seeds", () => {
    const service = new HmacDepositWalletService(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );

    const addressA = service.deriveDepositAddress("did:t3n:tenant:northstar");
    const addressB = service.deriveDepositAddress("did:t3n:tenant:southstar");

    expect(addressA).not.toBe(addressB);
  });
});
