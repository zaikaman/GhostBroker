import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * File-backed tenant identity store.
 *
 * The institution's `did:t3n:0x...` (returned by the T3N
 * handshake at backend boot) is the public identifier that
 * other institutions reference when they authorize this
 * institution's agents. The institution's secp256k1 keypair
 * is the private signing material the backend uses to sign
 * W3C VC delegation credentials for the institution's own
 * agents.
 *
 * Both pieces live together on disk so a backend restart
 * re-uses the same identity (and so an operator can back
 * the file up to a secrets manager, the same way they'd
 * back up a database connection string).
 *
 * Why the keypair is **not** derived from the T3N API key:
 *
 *   The T3N claim-page key is the operator's bearer secret
 *   for the T3N network. The tenant identity is a separate
 *   long-lived signing identity — the same shape the
 *   agent-side `setup:identity` CLI mints. Deriving the
 *   signing key from the bearer secret would couple the
 *   tenant's authority to the lifetime of the claim key
 *   (claim keys can be rotated independently of the tenant
 *   DID, and rotating one should not invalidate the
 *   institution's signed VCs).
 *
 * Production target: load from a secret manager (KMS,
 * Vault, etc.) and skip the on-disk write entirely. The
 * file-backed path is the dev/test fallback.
 */
export interface TenantIdentityRecord {
  version: 1;
  createdAt: string;
  did: string;
  publicKey: string;
  privateKey: string;
}

export const DEFAULT_TENANT_IDENTITY_PATH = "output/identities/tenant_identity.json";

function generateKeypair(): { privateKey: string; publicKey: string } {
  const privateKeyBytes = randomBytes(32);
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
  return {
    privateKey: `0x${Buffer.from(privateKeyBytes).toString("hex")}`,
    publicKey: `0x${Buffer.from(publicKeyBytes).toString("hex")}`,
  };
}

function readRecord(path: string): TenantIdentityRecord {
  return JSON.parse(readFileSync(path, "utf8")) as TenantIdentityRecord;
}

export interface LoadOrCreateTenantIdentityOptions {
  /**
   * The authenticated tenant DID returned by the T3N
   * handshake at backend boot. Stored on the record so the
   * signer can include it as `issuer` on the VCs it signs.
   */
  tenantDid: string;
  /**
   * Where the tenant identity file lives. Defaults to
   * `output/identities/tenant_identity.json` relative to the
   * current working directory. The backend writes its file
   * inside the `t3-enclave/` workspace; tests pass an
   * explicit path.
   */
  path?: string;
}

export interface TenantIdentity {
  did: string;
  publicKey: string;
  privateKey: string;
  /** Resolved absolute path of the file backing the record. */
  path: string;
}

/**
 * Read the persisted tenant identity from disk, creating a
 * fresh keypair on first boot. The tenant DID is taken from
 * the caller (it is the only piece the SDK can hand us at
 * runtime — the SDK does not expose the secp256k1 private
 * key, only the authenticated address).
 *
 * Idempotent: a backend restart reads the same keypair
 * and re-uses the existing VCs. A new keypair (rotating the
 * signing identity) requires deleting the file.
 */
export function loadOrCreateTenantIdentity(
  options: LoadOrCreateTenantIdentityOptions,
): TenantIdentity {
  const path = resolve(options.path ?? DEFAULT_TENANT_IDENTITY_PATH);

  if (existsSync(path)) {
    const existing = readRecord(path);
    if (
      typeof existing.publicKey === "string" &&
      typeof existing.privateKey === "string" &&
      typeof existing.did === "string" &&
      existing.publicKey.startsWith("0x") &&
      existing.privateKey.startsWith("0x")
    ) {
      return {
        did: existing.did,
        publicKey: existing.publicKey,
        privateKey: existing.privateKey,
        path,
      };
    }
  }

  const keypair = generateKeypair();
  const record: TenantIdentityRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    did: options.tenantDid,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return {
    did: record.did,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    path,
  };
}
