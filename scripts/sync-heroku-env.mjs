#!/usr/bin/env node
/**
 * Push every non-empty key from `backend/.env` to a Heroku app via
 * `heroku config:set`. Defaults to the app named `ghostbroker`.
 *
 * Usage:
 *   node scripts/sync-heroku-env.mjs                     # push to app "ghostbroker"
 *   node scripts/sync-heroku-env.mjs --app my-app        # push to a different app
 *   node scripts/sync-heroku-env.mjs --dry-run           # print the plan, do not run
 *   node scripts/sync-heroku-env.mjs --include NODE_ENV  # force-include a denylisted key
 *   node scripts/sync-heroku-env.mjs --exclude LOG_LEVEL # skip an extra key
 *   node scripts/sync-heroku-env.mjs --file .env.production
 *
 * The script:
 *   - Skips comment lines and blank lines.
 *   - Skips keys whose value is empty (so an empty `ETHERSCAN_API_KEY=` does
 *     not clobber the Heroku config var with an empty string).
 *   - Skips a small denylist of keys that should be set explicitly for
 *     production (NODE_ENV, PORT, and CORS_ALLOWED_ORIGINS when it points
 *     to localhost). Pass --include to override.
 *   - Batches 20 vars per `heroku config:set` call to stay under the OS
 *     argv length limit on long secrets.
 *   - Echoes which keys are being set (never the values — those are
 *     secrets).
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// The Heroku CLI on Windows is shipped as a `.cmd` shim. Node's
// `spawnSync` with `shell: false` cannot execute `.cmd` files directly
// (Windows' `CreateProcess` only handles `.exe`), even when the shim is
// on PATH. PowerShell finds `heroku` because PowerShell does its own
// PATHEXT resolution; `cmd.exe` (which npm scripts spawn) does not.
// Using `shell: true` lets the platform shell resolve the shim. The
// command args are constructed locally with no user-controlled
// interpolation, so the usual shell-injection concerns do not apply.
const SPAWN_OPTIONS = { stdio: "inherit", shell: true };

const DENYLIST = new Set(["NODE_ENV", "PORT"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const appName = typeof args.app === "string" ? args.app : "ghostbroker";
const envFile = resolve(
  PROJECT_ROOT,
  typeof args.file === "string" ? args.file : "backend/.env",
);
const dryRun = Boolean(args["dry-run"]);
const includeList = new Set(
  typeof args.include === "string" ? args.include.split(",").map((s) => s.trim()).filter(Boolean) : [],
);
const extraExcludes = new Set(
  typeof args.exclude === "string" ? args.exclude.split(",").map((s) => s.trim()).filter(Boolean) : [],
);

let raw;
try {
  raw = readFileSync(envFile, "utf8");
} catch (cause) {
  console.error(`[sync-heroku-env] Cannot read ${envFile}: ${cause.message}`);
  process.exit(1);
}

const parsed = parseEnvFile(raw);

const toSet = {};
const skipped = [];
for (const [key, value] of Object.entries(parsed)) {
  const isExplicitlyIncluded = includeList.has(key);
  const isDenylisted =
    !isExplicitlyIncluded && (DENYLIST.has(key) || extraExcludes.has(key));
  const isCorsLocal =
    key === "CORS_ALLOWED_ORIGINS" && !isExplicitlyIncluded && /localhost|127\.0\.0\.1/.test(value);

  if (isDenylisted) {
    skipped.push(`${key} (denylisted — pass --include ${key}=<value> to override)`);
    continue;
  }
  if (isCorsLocal) {
    skipped.push(`${key} (points to localhost — pass --include ${key}=<value> to override)`);
    continue;
  }
  if (value === "") {
    skipped.push(`${key} (empty value)`);
    continue;
  }
  toSet[key] = value;
}

const keys = Object.keys(toSet);

console.log(`[sync-heroku-env] Heroku app: ${appName}`);
console.log(`[sync-heroku-env] Source file: ${envFile}`);
console.log(`[sync-heroku-env] Will set ${keys.length} var(s):`);
for (const k of keys) console.log(`  - ${k}`);
if (skipped.length > 0) {
  console.log(`[sync-heroku-env] Skipped ${skipped.length}:`);
  for (const s of skipped) console.log(`  - ${s}`);
}

if (keys.length === 0) {
  console.log("[sync-heroku-env] Nothing to do.");
  process.exit(0);
}

if (dryRun) {
  console.log("\n[dry-run] Would run:");
  for (const batch of chunk(keys, 20)) {
    console.log(`  heroku config:set -a ${appName} ${batch.map((k) => `${k}=…`).join(" ")}`);
  }
  process.exit(0);
}

const herokuCheck = spawnSync("heroku", ["--version"], {
  stdio: "ignore",
  shell: true,
});
if (herokuCheck.error || herokuCheck.status !== 0) {
  console.error(
    "[sync-heroku-env] The `heroku` CLI was not found on PATH. Install it from https://devcenter.heroku.com/articles/heroku-cli and run `heroku login` first.",
  );
  process.exit(1);
}

let failed = 0;
for (const batch of chunk(keys, 20)) {
  const argList = ["config:set", "-a", appName];
  for (const k of batch) {
    const v = toSet[k];
    argList.push(needsQuoting(v) ? `${k}="${escapeForDoubleQuotes(v)}"` : `${k}=${v}`);
  }
  const result = spawnSync("heroku", argList, SPAWN_OPTIONS);
  if (result.status !== 0) {
    failed += 1;
    console.error(`[sync-heroku-env] Batch failed (exit ${result.status}).`);
  }
}

if (failed > 0) {
  console.error(`[sync-heroku-env] ${failed} batch(es) failed.`);
  process.exit(1);
}

console.log(
  `\n[sync-heroku-env] Done. Verify with: heroku config -a ${appName}`,
);
console.log(
  "[sync-heroku-env] Reminder: heroku config:set does NOT restart the app. Run `heroku restart -a ${appName} web.1` if you changed PORT-bound env vars.",
);

function parseEnvFile(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let value = line.slice(eq + 1).trim();
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function needsQuoting(value) {
  return /[\s'"`$\\]/.test(value);
}

function escapeForDoubleQuotes(value) {
  return value.replace(/(["\\$`])/g, "\\$1");
}
