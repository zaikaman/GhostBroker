import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGhostbrokerDelegationCredential } from "./src/enclave/auth/ghostbroker-delegation.js";
import { mintTenantDelegation } from "./src/enclave/auth/tenant-delegation.js";
import { loadOrCreateTenantIdentity } from "./src/enclave/sandbox/tenant-identity-store.js";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "gb-debug-"));
  try {
    const identity = loadOrCreateTenantIdentity({
      tenantDid: "did:t3n:0x00000000000000000000000000000000000000aa",
      path: join(tmp, "tenant.json"),
    });
    console.log("identity.did:", identity.did);
    console.log("identity.address:", identity.address);

    const { credential } = mintTenantDelegation(
      {
        agentDid: "did:t3n:0xagent",
        institutionId: "00000000-4000-8000-000000000101",
        maxSpendUsd: 1000,
        allowedActions: ["agent.admit"],
        purpose: "test",
        validityMonths: 12,
      },
      identity,
    );
    console.log("\ncredential.issuer:", credential.issuer);
    console.log("credential.proof.verificationMethod:", credential.proof?.verificationMethod);

    const result = await verifyGhostbrokerDelegationCredential({
      credential,
      institutionId: "00000000-4000-8000-000000000101",
      agentDid: "did:t3n:0xagent",
      requestedAction: "agent.admit",
    });
    console.log("\nVerifier result:", JSON.stringify(result, null, 2));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
