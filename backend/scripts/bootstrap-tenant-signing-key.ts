import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateTenantIdentity } from "../src/enclave/sandbox/tenant-identity-store.js";

/**
 * One-off generator for a fresh tenant signing keypair.
 *
 * This is the bootstrap path for production: it mints a fresh
 * secp256k1 keypair (separate from the T3N bearer API key),
 * persists it to a tmp file, prints the private key, and lets
 * the operator copy it into `backend/.env` as
 * `TENANT_SIGNING_PRIVATE_KEY=...`.
 *
 * Use the tmp path so we don't accidentally clobber a
 * previously-bootstrapped production identity. The on-disk
 * record is otherwise the dev/test fallback.
 */

const tmp = mkdtempSync(join(tmpdir(), "ghostbroker-bootstrap-signing-"));
const path = join(tmp, "tenant_identity.json");

const identity = loadOrCreateTenantIdentity({
  tenantDid: "did:t3n:a07f5f528c01e22dfd229a027c4b4afa4514e952",
  path,
});

console.log("=== Fresh tenant signing keypair generated ===");
console.log(`Record file:  ${identity.path}`);
console.log(`Issuer DID:   ${identity.did}`);
console.log(`Public key:   ${identity.publicKey}`);
console.log("");
console.log("Add this to backend/.env (one line, no extra whitespace):");
console.log(`TENANT_SIGNING_PRIVATE_KEY=${identity.privateKey}`);
console.log("");
console.log("IMPORTANT: this is a SEPARATE secret from T3N_API_KEY.");
console.log("Rotating the T3N bearer API key will NOT invalidate");
console.log("the VCs signed with this key.");