import { issueOperatorSessionToken } from "./auth/session-token.js";
import { loadEnv } from "./config/env.js";

async function main() {
  const env = loadEnv();
  const institutionId = "ec27760a-bec2-4924-b7c3-7e358547bf83";
  const token = issueOperatorSessionToken({
    secret: env.AUTH_SESSION_SECRET ?? "",
    did: "did:t3n:operator:dev",
    institutionId,
  });

  console.log("Starting demo...");
  const startRes = await fetch("http://localhost:3001/api/demo/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ institutionId }),
  });

  if (!startRes.ok) {
    const text = await startRes.text();
    console.error(`Failed to start demo: ${startRes.status} ${text}`);
    return;
  }

  const startData = await startRes.json();
  console.log("Demo started:", startData);

  console.log("Waiting 15 seconds for agents to run and log their activity...");
  await new Promise((r) => setTimeout(r, 15000));

  console.log("Querying demo status...");
  const statusRes = await fetch("http://localhost:3001/api/demo/status", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!statusRes.ok) {
    console.error("Failed to get demo status");
  } else {
    const statusData = (await statusRes.json()) as any;
    console.log("Demo status:", JSON.stringify(statusData, null, 2));
    console.log("=== BUYER LOGS ===");
    console.log(statusData.buyerLogTail);
    console.log("=== SELLER LOGS ===");
    console.log(statusData.sellerLogTail);
  }

  console.log("Stopping demo...");
  const stopRes = await fetch("http://localhost:3001/api/demo/stop", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  });
  console.log("Demo stopped:", await stopRes.json());
}

main().catch(console.error);
