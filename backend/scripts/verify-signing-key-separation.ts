import { loadEnv } from "../src/config/env.js";
import { loadOrCreateTenantIdentity } from "../src/enclave/sandbox/tenant-identity-store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = loadEnv();
if (!env.TENANT_SIGNING_PRIVATE_KEY) {
  console.error("TENANT_SIGNING_PRIVATE_KEY is missing from .env");
  process.exit(1);
}
if (env.TENANT_SIGNING_PRIVATE_KEY === env.T3N_API_KEY) {
  console.error(
    "TENANT_SIGNING_PRIVATE_KEY still equals T3N_API_KEY — the C1 bug is back!",
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-boot-smoke-"));
const path = join(tmp, "tenant_identity.json");

const identity = loadOrCreateTenantIdentity({
  tenantDid: env.T3_TENANT_DID ?? "did:t3n:default",
  path,
  signingPrivateKey: env.TENANT_SIGNING_PRIVATE_KEY,
});

console.log("=== Boot smoke DEBUG ===");
console.log(`Issuer DID:         ${identity.did}`);
console.log(`Address:            ${identity.address}`);
console.log(`T3N_API_KEY:        ${env.T3N_API_KEY.slice(0, 8)}...${env.T3N_API_KEY.slice(-6)}`);
console.log(`SigningKey(env):    ${env.TENANT_SIGNING_PRIVATE_KEY}`);
console.log(`SigningKey(loaded): ${identity.privateKey}`);
console.log(`Match:              ${identity.privateKey === env.TENANT_SIGNING_PRIVATE_KEY}`);

if (identity.privateKey !== env.TENANT_SIGNING_PRIVATE_KEY) {
  console.error("Loaded key does not match env var");
  process.exit(1);
}

console.log("=== Boot smoke OK ===");
console.log(`Different keys:   ${env.T3N_API_KEY !== env.TENANT_SIGNING_PRIVATE_KEY}`);