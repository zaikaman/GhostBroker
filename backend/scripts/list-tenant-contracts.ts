import { T3nClient, TenantClient, createEthAuthInput, eth_get_address, getNodeUrl, loadWasmComponent, metamask_sign, setEnvironment } from "@terminal3/t3n-sdk";
import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const env = Object.fromEntries(
    readFileSync("backend/.env", "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
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
  const tenant = new TenantClient({
    environment: networkEnv as "testnet" | "production",
    endpoint: baseUrl,
    baseUrl,
    tenantDid,
    t3n,
  });
  console.log("tenantDid:", tenantDid);
  const me = await tenant.tenant.me();
  console.log("tenant.me:", JSON.stringify(me));
  // The T3N SDK's TenantContractsNamespace exposes publish, register,
  // disable, enable, unregister, logs, and execute — but no list/enumerate
  // call. GhostBroker tracks published contracts in the Supabase
  // `published_contracts` table (the source of truth the Settings panel
  // reads). Use `list-published-contracts.ts` for the durable record, or
  // `tenant.contracts.logs(tail)` to inspect a specific contract's debug log.
  console.log(
    "The T3N SDK does not expose a contract enumeration API. " +
      "Run `npx tsx backend/scripts/list-published-contracts.ts` for the " +
      "GhostBroker published-contract records, or " +
      "`tenant.contracts.logs(\"matching\")` for a specific contract's log.",
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(99);
});
