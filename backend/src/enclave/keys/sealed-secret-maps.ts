import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export type TenantMapTail =
  | "secrets"
  | "authority-claims"
  | "match-config"
  | "settlement-config"
  | "intents"
  | "rounds";

export interface SealedSecretMapAcl {
  readers: readonly string[];
  writers: readonly string[];
}

export interface SealedSecretMapDefinition {
  tenantDid: string;
  tail: TenantMapTail;
  canonicalName: string;
  acl: SealedSecretMapAcl;
}

export interface SealedSecretMapProvisionRequest {
  tenantDid: string;
  tail: TenantMapTail;
  readers: readonly string[];
  writers: readonly string[];
}

export interface SealedSecretMapProvisionResult {
  definition: SealedSecretMapDefinition;
  status: "created" | "already_exists";
}

function tenantSuffix(tenantDid: string): string {
  const suffix = tenantDid.split(":").at(-1);

  if (!suffix || suffix.trim().length === 0) {
    throw new Error("Tenant DID cannot be converted into a T3 map namespace.");
  }

  return suffix;
}

export function createSealedSecretMapDefinition(
  request: SealedSecretMapProvisionRequest,
): SealedSecretMapDefinition {
  if (request.readers.length === 0 || request.writers.length === 0) {
    throw new Error("T3 private maps require explicit readers and writers.");
  }

  return {
    tenantDid: request.tenantDid,
    tail: request.tail,
    canonicalName: `z:${tenantSuffix(request.tenantDid)}:${request.tail}`,
    acl: {
      readers: [...new Set(request.readers)].sort(),
      writers: [...new Set(request.writers)].sort(),
    },
  };
}

export class SealedSecretMapProvisioner {
  private readonly client: T3NetworkClient;
  private readonly endpointPath: string;

  public constructor(client: T3NetworkClient, endpointPath = "/tenant/maps") {
    this.client = client;
    this.endpointPath = endpointPath;
  }

  public async provision(
    request: SealedSecretMapProvisionRequest,
  ): Promise<SealedSecretMapProvisionResult> {
    const definition = createSealedSecretMapDefinition(request);
    try {
      const response = await this.client.request<{ status?: string }>({
        method: "POST",
        path: this.endpointPath,
        body: definition,
      });
      if (response.status === 409) {
        return { definition, status: "already_exists" };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error("Unable to provision T3 sealed secret map.");
      }
      return { definition, status: "created" };
    } catch (error) {
      // T3N returns HTTP 400 with `{"detail":"map already exists"}`
      // when the map is already provisioned. The SDK throws on
      // non-2xx before a response object reaches us, so we catch
      // it here and treat it as already_exists.
      const message = error instanceof Error ? error.message : String(error);
      if (/already[_ -]exists|already[_ -]registered|conflict/i.test(message)) {
        return { definition, status: "already_exists" };
      }
      throw error;
    }
  }
}

/**
 * Idempotent ensure-step for the kv-store maps the v0.10.0
 * matching contract writes to (`intents`, `rounds`). Called at
 * backend boot after the T3N handshake authenticates. Each map
 * is created with `writers: "All"` so any published matching
 * contract version can write; `readers` is omitted (the
 * contract reads its own writes inside the same transaction —
 * cross-contract reads are not needed).
 *
 * A 409 (already_exists) is treated as success so reboots are
 * safe. Any other non-2xx is a hard failure — the backend
 * cannot accept intents without the kv-store maps.
 */
export async function ensureTenantKvMaps(
  client: T3NetworkClient,
  tenantDid: string,
): Promise<void> {
  const provisioner = new SealedSecretMapProvisioner(client);
  for (const tail of ["intents", "rounds"] as const) {
    const result = await provisioner.provision({
      tenantDid,
      tail,
      readers: [tenantDid],
      writers: [tenantDid],
    });
    if (result.status === "created") {
      console.log(`[kv-store] provisioned map "${tail}" for tenant ${tenantDid}`);
    }
  }
}
