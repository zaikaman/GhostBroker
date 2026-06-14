import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  T3nClient,
  createEthAuthInput,
  eth_get_address,
  loadWasmComponent,
  metamask_sign,
} from "@terminal3/t3n-sdk";

/**
 * Agent identity for the GhostBroker Ghostbroker-style credential flow.
 *
 * Ported from the Ghostbroker delegation/src/scripts/setup-identity.ts` and
 * `Ghostbroker delegation/src/t3/identity.ts`. The Ghostbroker delegation BUIDL was the only
 * published reference for "what Terminal 3 actually gives you" — it
 * confirmed that the T3 onboarding surface is just an `T3N_API_KEY`
 * (the claim-page key) + a derived `did:t3n`, with no dashboard.
 *
 * Two outputs:
 *   - the agent's secp256k1 keypair (private + public)
 *   - the agent's `did:t3n:0x...` identifier (assigned by the T3N
 *     network after a real handshake + auth challenge)
 *
 * The keypair is the agent's long-term identity. The DID is what
 * other institutions reference when they authorize this agent.
 * Bound the two together on disk so an agent can re-load its
 * identity across restarts without re-deriving.
 */

const DEFAULT_T3N_API_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
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

export interface AuthenticateOptions {
  apiKey: string;
  networkUrl?: string;
}

function generateKeypair(): { privateKey: string; publicKey: string } {
  const privateKeyBytes = randomBytes(32);
  const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);
  return {
    privateKey: `0x${Buffer.from(privateKeyBytes).toString("hex")}`,
    publicKey: `0x${Buffer.from(publicKeyBytes).toString("hex")}`,
  };
}

/**
 * Handshake with the T3N network and authenticate the agent DID.
 * This calls the real T3N SDK — `client.handshake()` opens the
 * authenticated encrypted session, `client.authenticate(...)` runs
 * the EIP-191 personal-sign challenge over the agent's address, and
 * the network returns a `did:t3n:<unique-id>` for the agent.
 */
export async function authenticateAgentDid(
  options: AuthenticateOptions,
): Promise<string> {
  const networkUrl = options.networkUrl ?? DEFAULT_T3N_API_URL;
  const address = eth_get_address(options.apiKey);
  const wasmComponent = await loadWasmComponent();
  const client = new T3nClient({
    baseUrl: networkUrl,
    wasmComponent,
    handlers: {
      EthSign: metamask_sign(address, undefined, options.apiKey),
    },
  });

  await client.handshake();
  const result = await client.authenticate(createEthAuthInput(address));
  // The SDK returns either a string or an object with `.value`.
  return typeof result === "object" && result !== null && "value" in result
    ? String((result as { value: unknown }).value)
    : String(result);
}

export interface SetupIdentityOptions {
  apiKey: string;
  networkUrl?: string;
  /** When provided and the file exists, re-use it instead of minting a new identity. */
  identityPath?: string;
}

export async function setupIdentity(options: SetupIdentityOptions): Promise<AgentIdentityRecord> {
  const identityPath = options.identityPath ?? DEFAULT_IDENTITY_PATH;

  if (existsSync(identityPath)) {
    const existing = readFile(identityPath);
    if (existing.privateKey && existing.did) {
      return existing;
    }
  }

  const keypair = generateKeypair();
  const did = await authenticateAgentDid({
    apiKey: options.apiKey,
    ...(options.networkUrl !== undefined ? { networkUrl: options.networkUrl } : {}),
  });
  const ethAddress = eth_get_address(options.apiKey);

  // Sanity check: the DID should be `did:t3n:0x<address>` for an
  // Ethereum-style authenticated agent. We don't fail on a different
  // shape — Ghostbroker delegation's verifier is happy with any `did:t3n:*` — but
  // we log it.
  if (!did.startsWith("did:t3n:")) {
    throw new Error(
      `T3N authentication did not return a T3N DID. Got: ${did}. Check that your T3N_API_KEY is valid.`,
    );
  }

  const record: AgentIdentityRecord = {
    version: 1,
    createdAt: new Date().toISOString(),
    did,
    ethAddress,
    networkTier: "testnet",
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    networkUrl: options.networkUrl ?? DEFAULT_T3N_API_URL,
  };

  mkdirSync(dirname(identityPath), { recursive: true });
  writeFileSync(identityPath, JSON.stringify(record, null, 2), "utf8");
  return record;
}

function readFile(path: string): AgentIdentityRecord {
  return JSON.parse(readFileSync(path, "utf8")) as AgentIdentityRecord;
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

export { DEFAULT_IDENTITY_PATH, DEFAULT_T3N_API_URL };
