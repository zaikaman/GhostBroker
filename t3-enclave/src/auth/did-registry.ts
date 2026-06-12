import type { T3NetworkClient } from "../sandbox/t3n-client.js";

export interface TenantDidResolutionRequest {
  legalName: string;
  displayName: string;
  settlementProfileRef: string;
}

export interface TenantDidResolution {
  tenantDid: string;
  source: "existing_session" | "registered";
}

export interface TenantDidRegistry {
  resolveOrRegisterTenantDid(
    request: TenantDidResolutionRequest,
  ): Promise<TenantDidResolution>;
}

interface TenantDidResponse {
  tenantDid?: string;
}

function readTenantDid(response: TenantDidResponse): string {
  if (!response.tenantDid || !response.tenantDid.startsWith("did:")) {
    throw new Error("Terminal 3 tenant DID resolution did not return a valid DID.");
  }

  return response.tenantDid;
}

export class AdkTenantDidRegistry implements TenantDidRegistry {
  private readonly client: T3NetworkClient;

  public constructor(client: T3NetworkClient) {
    this.client = client;
  }

  public async resolveOrRegisterTenantDid(
    request: TenantDidResolutionRequest,
  ): Promise<TenantDidResolution> {
    const sessionResponse = await this.client.request<TenantDidResponse>({
      method: "POST",
      path: "/tenant/session/resolve",
      body: {
        settlementProfileRef: request.settlementProfileRef,
      },
    });

    if (sessionResponse.status >= 200 && sessionResponse.status < 300) {
      return {
        tenantDid: readTenantDid(sessionResponse.body),
        source: "existing_session",
      };
    }

    const registrationResponse = await this.client.request<TenantDidResponse>({
      method: "POST",
      path: "/tenant/register",
      body: {
        legalName: request.legalName,
        displayName: request.displayName,
        settlementProfileRef: request.settlementProfileRef,
      },
    });

    if (registrationResponse.status < 200 || registrationResponse.status >= 300) {
      throw new Error("Terminal 3 tenant registration failed.");
    }

    return {
      tenantDid: readTenantDid(registrationResponse.body),
      source: "registered",
    };
  }
}
