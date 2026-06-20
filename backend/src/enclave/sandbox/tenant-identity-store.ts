import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { getAddress } from "ethers";

/**
 * File-backed tenant identity store.
 *
 * The institution's signing identity is a secp256k1 keypair. The
 * keypair's derived Ethereum address is the canonical issuer DID
 * for the delegation VCs the backend signs:
 *
 *   - the address is the value an `ethers.verifyMessage` call
 *     recovers from a signature produced with the keypair's
 *     private key (EIP-191 personal_sign), so the T3 SDK's
 *     `verifyEcdsaVcSig` matches the issuer's embedded address
 *     against the recovered signer without the multi-signer
 *     fallback path;
 *   - the T3 SDK's `verifyVc` only knows `did:ethr:` issuers
 *     (it throws `Unsupported DID method: t3n` for the
 *     `did:t3n:0x<addr>` format the T3N handshake returns), so
 *     the issuer DID must be `did:ethr:0x<signer>` for the SDK
 *     to actually verify the credential rather than always
 *     throwing and falling back to manual crypto.
 *
 * The institution's separate T3 tenant identity (the
 * `did:t3n:0x<addr>` returned by the T3N handshake) is a
 * different concern: it is the institution's *public identifier*
 * (other institutions reference it when they authorize this
 * institution's agents), not the cryptographic key that signs
 * the VCs. The T3 tenant DID is stored on the `institutions`
 * table for display and for cross-institution lookups; the
 * VC issuer DID is the keypair's derived `did:ethr:0x<addr>`.
 *
 * Why the signing keypair is **not** derived from the T3 SDK
 * API key:
 *
 *   The T3N claim-page key is the operator's bearer secret for
 *   the T3N network. It is intended to be rotated on a normal
 *   schedule by the claim-page operator (the T3 SDK authenticates
 *   REST/WS calls with it via `eth_get_address` + `metamask_sign`).
 *   It MUST NOT be conflated with the tenant's signing identity
 *   for two reasons:
 *
 *     1. Rotating the bearer secret would invalidate every VC
 *        the institution has issued (the VC's ECDSA proof is
 *        a function of the signing key, not the bearer secret).
 *
 *     2. The T3 SDK returns a `did:t3n:0x<addr>` whose embedded
 *        address is derived from the API key, but T3's host-side
 *        address derivation may not match a direct
 *        `eth_get_address(apiKey)` round-trip in every SDK
 *        version — coupling the issuer to the bearer secret
 *        would inherit that mismatch into the VC layer.
 *
 *   The signing keypair is generated independently from a CSPRNG
 *   and persisted to a file-backed identity store (or injected
 *   via the `TENANT_SIGNING_PRIVATE_KEY` env var when operators
 *   load it from a secret manager). A backend restart re-reads
 *   the same keypair so existing VCs stay valid.
 *
 * Production target: load from a secret manager (KMS, Vault,
 * etc.) and skip the on-disk write entirely. The file-backed
 * path is the dev/test fallback.
 */
export interface TenantIdentityRecord {
  version: 1;
  createdAt: string;
  did: string;
  publicKey: string;
  privateKey: string;
}

export const DEFAULT_TENANT_IDENTITY_PATH =
  "output/identities/tenant_identity.json";

function generateKeypair(): { privateKey: string; publicKey: string } {
  const privateKeyBytes = randomBytes(32);
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
  return {
    privateKey: `0x${Buffer.from(privateKeyBytes).toString("hex")}`,
    publicKey: `0x${Buffer.from(publicKeyBytes).toString("hex")}`,
  };
}

/**
 * Validate and normalize an externally-supplied secp256k1
 * signing private key. The input must be either:
 *
 *   - `0x`-prefixed 64 lowercase or uppercase hex characters
 *     (the canonical secp256k1 private-key encoding), or
 *   - an unprefixed 64-hex-character string.
 *
 * Anything else — a T3N bearer API key (which is a different
 * shape — see the T3 SDK's `metamask_sign` contract), a key
 * with the wrong length, a non-hex string, etc. — is rejected
 * with a descriptive error. This is the single chokepoint
 * that prevents the C1 dual-use path from ever being
 * reinstated: any future caller wiring `T3N_API_KEY` here
 * gets a hard failure rather than a silently-overwritten
 * identity.
 *
 * The T3 SDK's `metamask_sign` accepts a wider variety of
 * inputs (it supports both raw hex strings and a hex pair),
 * so the shape validation here is intentionally stricter than
 * the T3 SDK's — we need the canonical 32-byte private key,
 * not whatever the bearer-auth side tolerates.
 */
function normalizeSigningPrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("0x")
    ? trimmed.slice(2)
    : trimmed;
  if (!/^[0-9a-fA-F]{64}$/u.test(stripped)) {
    throw new Error(
      "Tenant signing private key must be a 32-byte secp256k1 key " +
        "(0x-prefixed or unprefixed 64 hex characters). " +
        "The T3N bearer API key MUST NOT be used as the tenant signing key — " +
        "load a dedicated signing key from a secret manager and pass it via " +
        "TENANT_SIGNING_PRIVATE_KEY, or omit the option to generate a fresh " +
        "keypair on first boot.",
    );
  }
  return `0x${stripped.toLowerCase()}` as `0x${string}`;
}

function readRecord(path: string): TenantIdentityRecord {
  return JSON.parse(readFileSync(path, "utf8")) as TenantIdentityRecord;
}

export interface LoadOrCreateTenantIdentityOptions {
  /**
   * The institution's T3 tenant identifier (the
   * `did:t3n:0x<addr>` returned by the T3N handshake at
   * backend boot). Stored on the record for display and
   * cross-institution lookups; it is NOT used as the VC
   * issuer DID (the SDK only supports `did:ethr:` for
   * cryptographic verification, so the signer mints VCs
   * with the keypair's derived `did:ethr:0x<addr>` as the
   * issuer). Optional for the dev/test flow that mints a
   * fresh keypair with no T3 tenant identity yet.
   */
  tenantDid?: string;
  /**
   * Where the tenant identity file lives. Defaults to
   * `output/identities/tenant_identity.json` relative to the
   * current working directory. The backend writes its file
   * inside the `t3-enclave/` workspace; tests pass an
   * explicit path.
   */
  path?: string;
  /**
   * Optional explicit signing private key. The production
   * path loads this from a secret manager via the
   * `TENANT_SIGNING_PRIVATE_KEY` env var and passes it
   * through `app.ts`. The dev/test path omits this option
   * and lets `loadOrCreateTenantIdentity` generate a fresh
   * CSPRNG keypair on first boot (persisted to disk so
   * subsequent boots reuse the same identity).
   *
   * When provided, this key is used as the tenant identity's
   * signing key instead of generating a random secp256k1
   * keypair. The env-supplied key is the ground truth; the
   * on-disk file is overwritten.
   *
   * SECURITY: this option MUST NOT be wired to the T3N bearer
   * API key. The API key is a separate concern (it
   * authenticates the T3 SDK to T3N REST/WS calls, and is
   * rotated on a different cadence from the institution's
   * long-lived signing identity). Conflating the two would
   * cause a normal API-key rotation to invalidate every VC
   * the institution has issued. Callers must pass a
   * dedicated secp256k1 key — typically loaded from KMS /
   * Vault via `TENANT_SIGNING_PRIVATE_KEY`.
   *
   * The VC's issuer DID is always derived from the keypair's
   * address (`did:ethr:0x<address>`) so the T3 SDK's
   * `verifyEcdsaVcSig` can match the issuer against the
   * recovered signer. The provided `tenantDid` is stored as
   * a separate display field (the institution's T3N identity)
   * but does NOT appear on the VC body.
   */
  signingPrivateKey?: string;
}

export interface TenantIdentity {
  /**
   * The signing identity's DID, used as the `issuer` on every
   * VC the backend signs. Format: `did:ethr:0x<address>`,
   * where the address is the Ethereum address derived from
   * the keypair's public key (EIP-191 recoverable). The T3
   * SDK's `verifyEcdsaVcSig` accepts this format and matches
   * the issuer's embedded address against the recovered
   * signer; a `did:t3n:0x<addr>` issuer would make the SDK
   * throw `Unsupported DID method: t3n` and the verifier
   * would fail closed with reason `unverified` (no multi-
   * signer fallback path).
   */
  did: string;
  publicKey: string;
  privateKey: string;
  /**
   * The Ethereum address derived from `privateKey`. This is
   * the address an ECDSA signature produced with `privateKey`
   * will recover to via EIP-191. The verifier uses it to
   * confirm that the recovered signature corresponds to the
   * institution's signing identity.
   */
  address: string;
  /**
   * Resolved absolute path of the file backing the record.
   */
  path: string;
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
 * Build the `did:ethr:0x<address>` form of a verifier DID from
 * a secp256k1 private key. The address is the Ethereum
 * address derived from the private key's uncompressed public
 * key (keccak256 of the X||Y bytes, last 20 bytes), normalized
 * to the EIP-55 checksum-cased form. This is the format the T3
 * SDK's `verifyEcdsaVcSig` accepts; a `did:t3n:0x<addr>` issuer
 * would make the SDK throw `Unsupported DID method: t3n` and
 * the verifier would fail closed.
 *
 * The same address is produced by `addressFromPrivateKey` —
 * the VC's issuer DID and the signer-derived address are
 * always equal so the SDK can match the issuer against the
 * recovered signer directly (the SDK is the only crypto path).
 *
 * The EIP-55 casing matters: `verifyEcdsaVcSig` compares
 * `getWalletAddress(issuer) === recoveredAddress` with a
 * case-sensitive string check. `ethers.verifyMessage` always
 * returns the recovered address in EIP-55 form, but
 * `getWalletAddress` returns whatever case the DID carries.
 * A lowercase DID therefore mismatches the EIP-55 recovered
 * address and the SDK reports `"Signature mismatch"`. Using
 * EIP-55 here makes the byte-equality check succeed.
 */
function didForKeypairFromPrivateKey(privateKey: `0x${string}`): string {
  const address = addressFromPrivateKey(privateKey);
  return `did:ethr:${getAddress(address)}`;
}

/**
 * Read the persisted tenant identity from disk, creating a
 * fresh keypair on first boot.
 *
 * The VC issuer DID is always derived from the keypair's
 * address as `did:ethr:0x<address>`. The provided `tenantDid`
 * (the institution's T3N identity) is stored as a separate
 * display field on the record but does NOT appear on the VC
 * body — the VC body uses the keypair's `did:ethr:` so the T3
 * SDK's `verifyEcdsaVcSig` can match the issuer against the
 * recovered signer.
 *
 * When `signingPrivateKey` is provided (production: loaded from
 * a secret manager via `TENANT_SIGNING_PRIVATE_KEY`; the value
 * MUST be a dedicated secp256k1 signing key — NOT the T3N bearer
 * API key), it is used as the signing key instead of generating
 * a random keypair. The env-supplied key is the ground truth;
 * the on-disk file is overwritten.
 *
 * Idempotent: a backend restart reads the same keypair and
 * re-uses the existing VCs. A new keypair (rotating the
 * signing identity) requires deleting the file.
 */
export function loadOrCreateTenantIdentity(
  options: LoadOrCreateTenantIdentityOptions,
): TenantIdentity {
  const path = resolve(options.path ?? DEFAULT_TENANT_IDENTITY_PATH);

  // When an explicit signing key is provided (production: a
  // dedicated secp256k1 key loaded from a secret manager via
  // `TENANT_SIGNING_PRIVATE_KEY`; never the T3N bearer API key —
  // see the SECURITY note on `LoadOrCreateTenantIdentityOptions`),
  // always use it. The env-supplied key is the ground truth
  // for the tenant identity; it overwrites any stale file
  // from a previous run that may have had a random keypair.
  if (options.signingPrivateKey) {
    const normalizedKey = normalizeSigningPrivateKey(
      options.signingPrivateKey,
    );

    const keyBytes = new Uint8Array(Buffer.from(normalizedKey.slice(2), "hex"));
    const pubKeyBytes = secp256k1.getPublicKey(keyBytes, true);
    const publicKey = `0x${Buffer.from(pubKeyBytes).toString("hex")}`;
    const address = addressFromPrivateKey(normalizedKey);
    // The VC issuer DID is the keypair's `did:ethr:` form so
    // the T3 SDK's `verifyEcdsaVcSig` can match the issuer
    // against the recovered signer. The provided `tenantDid`
    // (the T3N identity) is recorded separately for display.
    const did = didForKeypairFromPrivateKey(normalizedKey);
    const record: TenantIdentityRecord = {
      version: 1,
      createdAt: new Date().toISOString(),
      did,
      publicKey,
      privateKey: normalizedKey,
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    return {
      did: record.did,
      publicKey: record.publicKey,
      privateKey: record.privateKey,
      address,
      path,
    };
  }

  // No explicit signing key: read existing or generate fresh.
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

  // Generate a fresh keypair. The VC issuer DID is derived
  // from the keypair's address as `did:ethr:0x<address>` so
  // the T3 SDK's `verifyEcdsaVcSig` can match the issuer
  // against the recovered signer. The provided `tenantDid`
  // (the T3N identity) is recorded separately for display
  // when the caller wants to thread it through; the VC body
  // does NOT carry it.
  const keypair = generateKeypair();
  const did = didForKeypairFromPrivateKey(
    keypair.privateKey as `0x${string}`,
  );
  const record: TenantIdentityRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    did,
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
