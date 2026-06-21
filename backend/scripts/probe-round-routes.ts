import { T3nClient, TenantClient, createEthAuthInput, eth_get_address, getNodeUrl, loadWasmComponent, metamask_sign, setEnvironment } from "@terminal3/t3n-sdk";
import { readFileSync } from "node:fs";
import { sealEnvelope, loadEnvelopeMasterKey } from "../src/enclave/keys/envelope-cipher.js";

async function main(): Promise<void> {
  const env = Object.fromEntries(
    readFileSync("backend/.env", "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  const apiKey = env.T3N_API_KEY;
  if (!apiKey) throw new Error("T3N_API_KEY missing");
  const networkEnv = env.T3N_ENV ?? "testnet";
  setEnvironment(networkEnv as "testnet" | "production");
  const baseUrl = getNodeUrl();
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(apiKey);
  const t3n = new T3nClient({
    baseUrl,
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, apiKey) },
  });
  await t3n.handshake();
  const auth = await t3n.authenticate(createEthAuthInput(address));
  const tenantDid = auth.value;
  console.log("authenticated as", tenantDid);

  // Build a real envelope client-side so the TEE can unseal it.
  const masterKey = loadEnvelopeMasterKey();
  console.log("master key from dev fallback:", masterKey.fromDevFallback);
  const institutionId = "00000000-0000-4000-8000-000000000b01";
  const agentDid = "did:t3n:agent:round-probe-buyer";
  const authorityRef = "ghostbroker-delegation:round-probe";
  const envelope = sealEnvelope({
    institutionDid: institutionId,
    agentDid,
    authorityRef,
    masterKey,
    payload: {
      institutionId,
      agentDid,
      authorityRef,
      assetCode: "WBTC",
      side: "buy",
      quantity: 1,
      price: 70000,
    },
  });
  console.log("envelope bytes:", envelope.length);

  const roundSealPath = "/contracts/negotiation/round-proposals";
  const roundEvalPath = "/contracts/negotiation/round-evaluation";

  console.log("\n→ calling seal-round-proposal...");
  try {
    const sealResponse = await t3n.request({
      method: "POST",
      path: roundSealPath,
      body: {
        version: "0.9.1",
        sealed_envelope: envelope,
        envelope_master_key_hex: masterKey.key.toString("hex"),
        institution_did: institutionId,
        agent_did: agentDid,
        authority_ref: authorityRef,
        asset_code: "WBTC",
        side: "buy",
        correlation_ref: "round:probe:buyer:0001",
      },
    });
    console.log("status:", sealResponse.status);
    console.log("body:", JSON.stringify(sealResponse.body, null, 2));
  } catch (err) {
    console.log("seal-round-proposal threw:", err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(99);
});
