import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { eth_get_address } from "@terminal3/t3n-sdk";
import { z } from "zod";
import { readIdentity, type AgentIdentityRecord } from "./identity.js";

/**
 * W3C Verifiable Credential — ported from Ghostbroker delegation's
 * `src/auth/delegation.ts` and `src/scripts/setup-delegation.ts`.
 *
 * The Ghostbroker delegation BUIDL models the delegation as a standard W3C VC
 * with `issuer`, `credentialSubject`, and a `proof.jws` field. The
 * GhostVerifier (in t3-enclave) does not speak this shape — that
 * verifier was built for the T3 Smart VC `buildDelegationCredential`
 * format. The Ghostbroker delegation format is what the only published live
 * reference implementation actually mints, so the agent side
 * produces and consumes this shape end-to-end. The backend admit
 * path that consumes it lives in the GhostBroker backend
 * (`POST /api/agents/admit` with a `delegationCredential` field).
 */

const purchaseCategorySchema = z.enum([
  "office-supplies",
  "software",
  "hardware",
  "services",
  "travel",
]);

export const delegationSchema = z.object({
  id: z.string(),
  type: z.array(z.string()),
  issuer: z.string(),
  issuanceDate: z.string(),
  expirationDate: z.string(),
  credentialSubject: z.object({
    id: z.string(),
    agentDid: z.string(),
    maxSpendUsd: z.number().positive(),
    allowedCategories: z.array(purchaseCategorySchema).min(1),
    approverEmail: z.string().email().optional(),
    purpose: z.string(),
  }),
  proof: z
    .object({
      type: z.string(),
      created: z.string(),
      proofPurpose: z.string(),
      verificationMethod: z.string(),
      jws: z.string().optional(),
    })
    .optional(),
});

export type DelegationCredential = z.infer<typeof delegationSchema>;

const DEFAULT_DELEGATION_PATH = "output/delegations/agent_delegation.json";
const DEMO_PROOF_MARKER = "live-demo-unsigned";

function parseArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function isSandboxDid(did: string | undefined): boolean {
  return !did || did.includes("sandbox") || did.includes("REPLACE_WITH");
}

function resolveUserDidFromEnv(apiKey: string | undefined): string {
  const fromEnv = process.env.USER_DID?.trim();
  if (fromEnv && !isSandboxDid(fromEnv)) {
    return fromEnv;
  }
  if (!apiKey || apiKey.startsWith("your-")) {
    throw new Error(
      "Set USER_DID or T3N_API_KEY in .env (claim key from https://www.terminal3.io/claim-page).",
    );
  }
  const address = eth_get_address(apiKey);
  return `did:t3n:${address.slice(2).toLowerCase()}`;
}

function resetLocalSpendTracking(delegationId: string, spendDir: string): void {
  const safe = delegationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = join(spendDir, `${safe}.json`);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export interface MintDelegationOptions {
  apiKey?: string;
  userDid?: string;
  agentDid: string;
  maxSpendUsd: number;
  outputPath?: string;
  spendDir?: string;
  allowedCategories?: string[];
  purpose?: string;
  approverEmail?: string;
}

export function mintDelegationCredential(options: MintDelegationOptions): {
  path: string;
  credential: DelegationCredential;
} {
  const now = new Date();
  const created = now.toISOString();
  const expiration = new Date(now);
  expiration.setUTCMonth(expiration.getUTCMonth() + 6);

  const userDid = options.userDid ?? resolveUserDidFromEnv(options.apiKey);

  const credential: DelegationCredential = {
    id: `urn:uuid:ghostbroker-delegation-${now.getTime()}`,
    type: ["VerifiableCredential", "GhostBrokerDelegation"],
    issuer: userDid,
    issuanceDate: created,
    expirationDate: expiration.toISOString(),
    credentialSubject: {
      id: userDid,
      agentDid: options.agentDid,
      maxSpendUsd: options.maxSpendUsd,
      allowedCategories: (options.allowedCategories ?? ["office-supplies", "software"]) as (
        | "office-supplies"
        | "software"
        | "hardware"
        | "services"
        | "travel"
      )[],
      approverEmail: options.approverEmail ?? "finance@acme.example",
      purpose: options.purpose ?? "Q2 office refresh and team tooling within delegated limits",
    },
    proof: {
      type: "JsonWebSignature2020",
      created,
      proofPurpose: "assertionMethod",
      verificationMethod: `${userDid}#key-1`,
      jws: DEMO_PROOF_MARKER,
    },
  };

  const path = options.outputPath ?? DEFAULT_DELEGATION_PATH;
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, "utf8");
  if (options.spendDir) {
    resetLocalSpendTracking(credential.id, options.spendDir);
  }
  return { path, credential };
}

export function loadDelegationCredential(path: string): DelegationCredential {
  if (!existsSync(path)) {
    throw new Error(
      `Delegation credential not found at ${path}. Run setup:delegation first.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return delegationSchema.parse(raw);
}

export function isDelegationActive(
  credential: DelegationCredential,
  now = new Date(),
): boolean {
  const issued = new Date(credential.issuanceDate);
  const expires = new Date(credential.expirationDate);
  return now >= issued && now <= expires;
}

export function delegationSummary(credential: DelegationCredential): string {
  const { credentialSubject: subject } = credential;
  return [
    `Issuer: ${credential.issuer}`,
    `Agent: ${subject.agentDid}`,
    `Budget: $${subject.maxSpendUsd.toFixed(2)}`,
    `Categories: ${subject.allowedCategories.join(", ")}`,
    `Valid until: ${credential.expirationDate}`,
    `Purpose: ${subject.purpose}`,
  ].join("\n");
}

/**
 * CLI: `npm run setup:delegation -- --max-spend 50000 --output path`
 * Resolves the agent DID from the identity file, the user DID from
 * the T3N_API_KEY, and mints a delegation credential to disk.
 */
export function runSetupDelegationCli(): void {
  const identityPath =
    parseArg("--identity-path") ?? process.env.AGENT_IDENTITY_CONFIG_PATH ?? "output/identities/agent_identity.json";
  const identity: AgentIdentityRecord = readIdentity(identityPath);

  const outputPath = parseArg("--output") ?? process.env.DELEGATION_CREDENTIAL_PATH;
  const maxSpendRaw = parseArg("--max-spend");
  const maxSpendUsd = maxSpendRaw ? Number(maxSpendRaw) : 50_000;

  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) {
    throw new Error("--max-spend must be a positive number.");
  }

  const userDid = process.env.USER_DID?.trim();
  const apiKey = process.env.T3N_API_KEY;

  const { path, credential } = mintDelegationCredential({
    ...(userDid ? { userDid } : {}),
    ...(apiKey ? { apiKey } : {}),
    agentDid: identity.did,
    maxSpendUsd,
    ...(outputPath ? { outputPath } : {}),
    spendDir: process.env.AUDIT_OUTPUT_DIR ?? "output",
  });

  console.log("=== Delegation credential created ===");
  console.log(`Output: ${path}`);
  console.log(`User (issuer): ${credential.issuer}`);
  console.log(`Agent: ${credential.credentialSubject.agentDid}`);
  console.log(`Budget: $${maxSpendUsd.toFixed(2)}`);
  console.log("");
  console.log("Proof uses a demo marker (not a cryptographic signature).");
  console.log("The Ghostbroker-style verifier accepts this via structural fallback in sandbox mode.");
  console.log("Set VC_VERIFY_MODE=live only when using a real signed VC.");
  console.log("");
  console.log("Add to .env if not already set:");
  console.log(`USER_DID=${credential.issuer}`);
  console.log(`AGENT_DID=${credential.credentialSubject.agentDid}`);
  console.log(`DELEGATION_CREDENTIAL_PATH=${path.replace(/\\/g, "/")}`);
}
