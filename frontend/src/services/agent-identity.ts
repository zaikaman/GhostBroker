import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * Browser-safe agent identity generator.
 *
 * Mirrors `agents/src/identity.ts`'s Node-side `generateKeypair` +
 * Ethereum-address derivation so the dashboard and the agent process
 * speak the same identity shape:
 *
 *   - secp256k1 keypair (compressed pubkey, 0x-prefixed hex)
 *   - Ethereum address (keccak256 of uncompressed pubkey, last 20
 *     bytes, lowercased and 0x-prefixed)
 *   - `did:t3n:0x<address>` — the W3C DID the Ghostbroker delegation
 *     verifier binds the VC to (`credentialSubject.agentDid`).
 *
 * The keypair is generated in the browser via `@noble/curves`
 * (audited constant-time implementation); the private key never
 * leaves the browser tab. The DID is sent to the backend during
 * `provisionAgent`; the backend's tenant signer signs a W3C VC
 * that names this DID as the credentialSubject, so the agent is
 * cryptographically bound to the dashboard's keypair even though
 * only the public DID ever crosses the wire.
 */
export interface AgentIdentity {
  /** `did:t3n:0x<eth-address>` — the agent's public DID. */
  agentDid: string;
  /** 0x-prefixed compressed secp256k1 public key (33 bytes). */
  publicKey: string;
  /** 0x-prefixed 32-byte secp256k1 private key (66 chars). */
  privateKey: string;
  /** 0x-prefixed Ethereum address (20 bytes, lowercased). */
  ethAddress: string;
}

function bytesToHex(bytes: Uint8Array): string {
  const hexChars = "0123456789abcdef";
  let out = "";
  for (const byte of bytes) {
    out += hexChars[byte >> 4];
    out += hexChars[byte & 0x0f];
  }
  return out;
}

function randomPrivateKey(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // secp256k1 scalar field boundary check: any value in [1, n-1] is
  // valid; this ensures we never hand `@noble/curves` the zero or
  // the curve order by accident.
  const SUBTRACT_ONE = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
  let view = 0n;
  for (let i = 0; i < 32; i += 1) {
    view = (view << 8n) | BigInt(bytes[i] ?? 0);
  }
  if (view === 0n || view >= SUBTRACT_ONE) {
    bytes[0] = (bytes[0] ?? 0) | 0x01;
    bytes[31] = (bytes[31] ?? 0) & 0x7f;
  }
  return bytes;
}

/**
 * Derive an Ethereum address from a 65-byte uncompressed
 * secp256k1 public key (`04 || X || Y`).
 *
 *   1. Drop the leading `04` byte (just X || Y, 64 bytes).
 *   2. keccak256 the X || Y bytes.
 *   3. Take the last 20 bytes as the address; lowercase.
 *
 * Matches `ethers.computeAddress` / `viem`'s `publicKeyToAddress`
 * byte-for-byte.
 */
function ethAddressFromUncompressedPublicKey(uncompressedPublicKey: Uint8Array): string {
  if (
    uncompressedPublicKey.length !== 65 ||
    uncompressedPublicKey[0] !== 0x04
  ) {
    throw new Error(
      "ethAddressFromUncompressedPublicKey: expected a 65-byte uncompressed secp256k1 public key (04 || X || Y).",
    );
  }
  const digest = keccak_256(uncompressedPublicKey.slice(1));
  return "0x" + bytesToHex(digest.slice(-20));
}

/**
 * Generate a fresh secp256k1 keypair + DID for a new agent.
 *
 * Call once per provisioning flow. The returned `privateKey` stays
 * in memory only (caller is responsible for holding or discarding
 * it); the `agentDid` is the only field sent to the backend.
 */
export function generateAgentIdentity(): AgentIdentity {
  const privateKeyBytes = randomPrivateKey();
  // `@noble/curves` v2 returns the compressed (33-byte) or
  // uncompressed (65-byte) public key from a private key in one
  // call. We carry both forms so the helper never has to
  // decompress a public key — that path is fragile across curve
  // library versions and we already have the private key in hand.
  const compressedPublicKey = secp256k1.getPublicKey(privateKeyBytes, true);
  const uncompressedPublicKey = secp256k1.getPublicKey(privateKeyBytes, false);
  const ethAddress = ethAddressFromUncompressedPublicKey(uncompressedPublicKey);
  return {
    agentDid: `did:t3n:${ethAddress}`,
    publicKey: `0x${bytesToHex(compressedPublicKey)}`,
    privateKey: `0x${bytesToHex(privateKeyBytes)}`,
    ethAddress,
  };
}
