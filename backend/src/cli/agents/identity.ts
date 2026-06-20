import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/**
 * Agent identity for the GhostBroker Ghostbroker-style credential flow.
 *
 * Post-Phase 1: the agent no longer needs a T3N handshake or a long-lived
 * keypair. The backend derives the tenant signing identity from
 * `TENANT_SIGNING_PRIVATE_KEY` (production: loaded from a secret manager)
 * or generates a fresh CSPRNG keypair on first boot (dev/test: persisted
 * to `output/identities/tenant_identity.json`). The agent process only
 * needs a unique DID for admission — it generates an ephemeral keypair at
 * process boot and derives a synthetic `did:t3n:demo-<pubkey>` from it.
 * The private key never leaves the process.
 *
 * The T3N bearer API key (`T3N_API_KEY`) is a SEPARATE concern that
 * authenticates the T3 SDK to T3N REST/WS calls; it is NOT used as the
 * tenant signing key (see `tenant-identity-store.ts` for the C1 fix).
 */

const DEFAULT_IDENTITY_PATH = "output/identities/agent_identity.json";

export interface AgentIdentityRecord {
  version: 1;
  createdAt: string;
  did: string;
  ethAddress: string;
  networkTier: "testnet";
  publicKey: string;
  privateKey: string;
  networkUrl: string;
}

function generateKeypair(): { privateKey: string; publicKey: string } {
  const privateKeyBytes = randomBytes(32);
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
  return {
    privateKey: `0x${Buffer.from(privateKeyBytes).toString("hex")}`,
    publicKey: `0x${Buffer.from(publicKeyBytes).toString("hex")}`,
  };
}

export function readIdentity(path: string = DEFAULT_IDENTITY_PATH): AgentIdentityRecord {
  if (!existsSync(path)) {
    throw new Error(
      `Agent identity file not found at ${path}. Run setup:identity first.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentIdentityRecord>;
  if (!raw.did || !raw.privateKey) {
    throw new Error(
      `Identity file at ${path} is missing required fields (did, privateKey). Re-run setup:identity.`,
    );
  }
  return raw as AgentIdentityRecord;
}

/**
 * Load the agent identity from disk when a path is
 * supplied; otherwise mint a fresh ephemeral keypair at
 * process boot. The demo orchestrator spawns the agent
 * with no `AGENT_IDENTITY_CONFIG_PATH` set; this path
 * mints a one-shot keypair the process uses for the
 * duration of the run. The private key never leaves the
 * process — the backend only sees the public DID, and the
 * delegation VC is owned server-side.
 *
 * When the `AGENT_IDENTITY_DID` env var is set (Phase 2.5
 * demo orchestrator path), the process uses that DID
 * directly instead of generating a random keypair. This
 * ensures the agent admits with the same DID the backend
 * configured and minted a VC for.
 */
export function loadOrGenerateIdentity(
  path: string | undefined,
): AgentIdentityRecord {
  if (path && existsSync(path)) {
    return readIdentity(path);
  }

  // Phase 2.5: accept a pre-assigned DID from the demo
  // orchestrator. No keypair is needed because the backend
  // owns the delegation VC and the agent only uses the DID
  // as an identifier on admit / submit calls.
  const forcedDid = process.env.AGENT_IDENTITY_DID;
  if (forcedDid) {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      did: forcedDid,
      ethAddress: forcedDid,
      networkTier: "testnet",
      publicKey: "",
      privateKey: "",
      networkUrl: "",
    };
  }

  const keypair = generateKeypair();
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    did: `did:t3n:demo-${keypair.publicKey.slice(2, 14)}`,
    ethAddress: keypair.publicKey,
    networkTier: "testnet",
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    networkUrl: "",
  };
}

export { DEFAULT_IDENTITY_PATH };
