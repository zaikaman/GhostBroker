import { createSupabaseServiceClient } from "../src/services/supabase-client.js";
import { readFileSync } from "node:fs";

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
  const supabase = createSupabaseServiceClient({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  });
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
