import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export type TenantMapTail =
  | "secrets"
  | "authority-claims"
  | "match-config"
  | "settlement-config";

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
  }
}
