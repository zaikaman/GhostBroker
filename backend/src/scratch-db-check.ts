import { createSupabaseServiceClient } from "./services/supabase-client.js";
import { loadEnv } from "./config/env.js";

async function main() {
  const env = loadEnv();
  const supabase = createSupabaseServiceClient(env) as any;
  
  const { data: insts, error: instsErr } = await supabase.from("institutions").select("*");
  if (instsErr) {
    console.error("Error fetching institutions:", instsErr);
    return;
  }
  console.log("--- Institutions ---");
  console.log(JSON.stringify(insts, null, 2));

  const { data: keys, error: keysErr } = await supabase.from("api_keys").select("*");
  if (keysErr) {
    console.error("Error fetching API keys:", keysErr);
    return;
  }
  console.log("--- API Keys ---");
  console.log(JSON.stringify(keys, null, 2));
}

main().catch(console.error);
