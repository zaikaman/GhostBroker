export interface AgentAuthorityReference {
  agentDid: string;
  authorityRef: string;
  policyHash: string;
}

export * from "./agent-auth-client.js";
export * from "./agent-identity.js";
export * from "./authority-claims.js";
export * from "./boundbuyer-delegation.js";
export * from "./delegation-credential.js";
export * from "./did-registry.js";
