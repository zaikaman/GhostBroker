/**
 * Vite env helpers.
 *
 * Reads `VITE_*` build-time variables. Unlike the backend (which has a
 * `loadEnv()` validator), the frontend has no runtime env to validate
 * against — the env vars are baked into the bundle at build time, so
 * a missing or empty value is a build-time / first-paint failure
 * rather than a per-request one. The helper throws a clear,
 * actionable error so the operator sees the problem in the browser
 * console instead of a silent fallback to a wrong host.
 *
 * Local dev: copy `frontend/.env.example` to `frontend/.env` (the
 * values in the example match the backend's dev defaults).
 *
 * Vercel: set the same keys in Project Settings → Environment
 * Variables. Vite bakes the values at build time, so changing them
 * requires a redeploy.
 */

function readRequiredEnv(key: string): string {
  const raw = import.meta.env[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      `[env] Missing required environment variable: ${key}. ` +
        "Set it in frontend/.env (copy from frontend/.env.example) for local dev, " +
        "or in Vercel Project Settings → Environment Variables for production, " +
        "then rebuild.",
    );
  }
  return raw.replace(/\/+$/, "");
}

export const API_BASE_URL: string = readRequiredEnv("VITE_API_BASE_URL");
export const WS_TELEMETRY_URL: string = readRequiredEnv("VITE_WS_TELEMETRY_URL");
