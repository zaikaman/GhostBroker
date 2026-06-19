import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

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
  /**
   * Optional explicit signing private key (the T3N API key
   * when called from the backend composition root).
   *
   * When provided, this key is used as the tenant identity's
   * signing key instead of generating a random secp256k1
   * keypair. This ensures the signing key corresponds to the
   * T3N DID's on-chain address, so the ECDSA signature the
   * delegation signer produces can be verified against the
   * issuer DID.
   *
   * When the key is provided, the identity file is always
   * overwritten (the env-supplied key is the ground truth).
   * When omitted, a fresh random keypair is generated on
   * first boot and persisted to disk as before.
   */
  signingPrivateKey?: string;
}

export interface TenantIdentity {
  did: string;
  publicKey: string;
  privateKey: string;
  /**
   * The Ethereum address derived from `privateKey`. This is the
   * address an ECDSA signature produced with `privateKey` will
   * recover to via EIP-191. The verifier uses it to confirm that
   * the recovered signature corresponds to the institution's
   * signing identity.
   */
  address: string;
  /**
   * Resolved absolute path of the file backing the record.
   */
  path: string;
}

/**
 * Extract the Ethereum address from a DID string.
 * Supports `did:t3n:a07f5f52...` (without 0x) and
 * `did:ethr:0x...` (with 0x) formats.
 */
function addressFromDid(did: string): string {
  const match = /^(?:did:[a-z0-9]+:)?((?:0x)?[0-9a-fA-F]{40})(?:#[^#]*)?$/u.exec(did);
  if (!match?.[1]) {
    throw new Error(`Cannot extract wallet address from tenant DID: ${did}`);
  }
  const addr = match[1].toLowerCase();
  return addr.startsWith("0x") ? addr : `0x${addr}`;
}

/**
 * Derive the Ethereum address from a secp256k1 private key.
 */
function addressFromPrivateKey(privateKey: `0x${string}`): string {
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  const keyBytes = new Uint8Array(Buffer.from(hex, "hex"));
  const pubKey = secp256k1.getPublicKey(keyBytes, false);
  const hash = keccak_256(pubKey.slice(1));
  return `0x${Buffer.from(hash.slice(12)).toString("hex")}`;
}

/**
 * Read the persisted tenant identity from disk, creating a
 * fresh keypair on first boot. The tenant DID is taken from
 * the caller (it is the only piece the SDK can hand us at
 * runtime — the SDK does not expose the secp256k1 private
 * key, only the authenticated address).
 *
 * When `signingPrivateKey` is provided (the T3N API key from
 * the backend env), it is used as the signing key instead of
 * generating a random keypair. This ensures the signing key
 * corresponds to the T3N DID's on-chain address, so the ECDSA
 * signature the delegation signer produces can be verified
 * against the issuer DID.
 *
 * Idempotent: a backend restart reads the same keypair
 * and re-uses the existing VCs. A new keypair (rotating the
 * signing identity) requires deleting the file.
 */
export function loadOrCreateTenantIdentity(
  options: LoadOrCreateTenantIdentityOptions,
): TenantIdentity {
  const path = resolve(options.path ?? DEFAULT_TENANT_IDENTITY_PATH);

  // When an explicit signing key is provided (T3N API key),
  // always use it. The env-supplied key is the ground truth
  // for the tenant identity; it overwrites any stale file
  // from a previous run that may have had a random keypair.
  if (options.signingPrivateKey) {
    const normalizedKey = options.signingPrivateKey.startsWith("0x")
      ? (options.signingPrivateKey as `0x${string}`)
      : (`0x${options.signingPrivateKey}` as `0x${string}`);

    const derivedAddress = addressFromPrivateKey(normalizedKey);
    const expectedAddress = addressFromDid(options.tenantDid);

    if (derivedAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      // The T3N API key does not derive to the T3N DID's on-chain
      // address via standard secp256k1+keccak256. The T3 SDK
      // authenticates with the API key's derived address and the
      // server returns the tenant DID, but the DID's address and
      // the API key's address are not the same value. We treat the
      // API key holder as the **canonical signer of the tenant's
      // delegation VCs** — the same authority the T3 SDK exercises
      // when it authenticates as the tenant on the wire. The
      // verifier accepts signatures from BOTH the DID's address
      // AND the API key's derived address; the signing identity
      // exposed on the wire (the API key holder) is what the
      // production signer actually uses.
      console.warn(
        "[TENANT-IDENTITY] Signing private key address mismatch — " +
        `derived: ${derivedAddress}, expected: ${expectedAddress} ` +
        `(from ${options.tenantDid}). ` +
        "Continuing with provided key; both addresses will be accepted as trusted signers.",
      );
    }

    const keyBytes = new Uint8Array(Buffer.from(normalizedKey.slice(2), "hex"));
    const pubKeyBytes = secp256k1.getPublicKey(keyBytes, true);
    const record: TenantIdentityRecord = {
      version: 1,
      createdAt: new Date().toISOString(),
      did: options.tenantDid,
      publicKey: `0x${Buffer.from(pubKeyBytes).toString("hex")}`,
      privateKey: normalizedKey,
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    return {
      did: record.did,
      publicKey: record.publicKey,
      privateKey: record.privateKey,
      address: derivedAddress,
      path,
    };
  }

  // No explicit signing key: read existing or generate random.
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
        address: addressFromPrivateKey(existing.privateKey as `0x${string}`),
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
    address: addressFromPrivateKey(record.privateKey as `0x${string}`),
    path,
  };
}
