import { createSupabaseServiceClient } from "../src/services/supabase-client.js";
import { readFileSync } from "node:fs";

interface PublishedContractListResult {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
}

interface PublishedContractListChain {
  select(columns: string): PublishedContractListChain;
  order(column: string, options: { ascending: boolean }): PublishedContractListChain;
  limit(n: number): Promise<PublishedContractListResult>;
}

interface PublishedContractListClient {
  from(table: "published_contracts"): PublishedContractListChain;
}

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
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env.",
    );
  }
  const supabase = createSupabaseServiceClient({
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  }) as unknown as PublishedContractListClient;
  const result = await supabase
    .from("published_contracts")
    .select("*")
    .order("published_at", { ascending: false })
    .limit(5);
  if (result.error) {
    console.error("error:", result.error.message);
    return;
  }
  console.log("count:", result.data?.length ?? 0);
  for (const row of result.data ?? []) {
    console.log(JSON.stringify(row));
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(99);
});
