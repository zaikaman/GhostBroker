/**
 * Shared helper for the setup / watch scripts. Hits the local
 * GhostBroker backend and returns an AuthSession.
 */
export interface AuthSession {
  token: string;
  expiresAt: string;
  institution: { id: string; displayName: string; t3TenantDid: string };
}

const BACKEND = process.env.GHOSTBROKER_URL ?? "http://localhost:3001";

export async function authenticate(apiKey: string): Promise<AuthSession> {
  const response = await fetch(`${BACKEND}/api/auth/api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`auth failed (${response.status}): ${text}`);
  }
  return (await response.json()) as AuthSession;
}
