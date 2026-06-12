import { createRequire } from "node:module";
import { loadEnv, type BackendEnv } from "../config/env.js";

export interface SupabaseServiceClient {
  from(table: string): unknown;
  rpc(functionName: string, parameters?: Record<string, unknown>): unknown;
}

interface SupabaseModule {
  createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options: {
      auth: {
        autoRefreshToken: false;
        persistSession: false;
      };
    },
  ): SupabaseServiceClient;
}

const require = createRequire(import.meta.url);

export function createSupabaseServiceClient(
  env: Pick<BackendEnv, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"> = loadEnv(),
): SupabaseServiceClient {
  const supabase = require("@supabase/supabase-js") as SupabaseModule;

  return supabase.createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
