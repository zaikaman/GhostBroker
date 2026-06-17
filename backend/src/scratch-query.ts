import { createSupabaseServiceClient } from "./services/supabase-client.js";
import { loadEnv } from "./config/env.js";

async function main() {
  const env = loadEnv();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createSupabaseServiceClient(env) as any;
  const { data, error } = await supabase.from("institutions").select("*");
  if (error) {
    console.error("Error fetching institutions:", error);
    return;
  }
  console.log("Institutions:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
