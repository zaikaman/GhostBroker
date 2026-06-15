#!/usr/bin/env node
// One-shot patcher: insert `persistDelegation` +
// `loadDelegationCredential` stubs into every ad-hoc
// `AgentManagementService` literal in the backend
// test suite. The new methods are no-ops that throw
// "not used" — the test fakes for `loadAndVerify`
// tests will override.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  "src/tests/contracts",
  "src/tests/integration",
  "src/tests/unit",
];

const REPLACEMENT_VARIANT_1 =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n        };";

const REPLACEMENT_VARIANT_1_NEW =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n        persistDelegation: async () => { throw new Error(\"not used\"); },\n        loadDelegationCredential: async () => null,\n      };";

const REPLACEMENT_VARIANT_2 =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n      }),";

const REPLACEMENT_VARIANT_2_NEW =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n        persistDelegation: async () => { throw new Error(\"not used\"); },\n        loadDelegationCredential: async () => null,\n      }),";

const REPLACEMENT_VARIANT_3 =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n    } as AgentManagementService,";

const REPLACEMENT_VARIANT_3_NEW =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n      persistDelegation: async () => { throw new Error(\"not used\"); },\n      loadDelegationCredential: async () => null,\n    } as AgentManagementService,";

const REPLACEMENT_VARIANT_4 =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n  },";

const REPLACEMENT_VARIANT_4_NEW =
  "revokeAgent: async () => { throw new Error(\"not used\"); },\n    persistDelegation: async () => { throw new Error(\"not used\"); },\n    loadDelegationCredential: async () => null,\n  },";

const REPLACEMENT_VARIANT_5 =
  "revokeAgent: async () => {\n        throw new Error(\"not used\");\n      },";

const REPLACEMENT_VARIANT_5_NEW =
  "revokeAgent: async () => {\n        throw new Error(\"not used\");\n      },\n      persistDelegation: async () => {\n        throw new Error(\"not used\");\n      },\n      loadDelegationCredential: async () => null,";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (path.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

let patched = 0;
for (const dir of TARGETS) {
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    let next = text;
    next = next.split(REPLACEMENT_VARIANT_1).join(REPLACEMENT_VARIANT_1_NEW);
    next = next.split(REPLACEMENT_VARIANT_2).join(REPLACEMENT_VARIANT_2_NEW);
    next = next.split(REPLACEMENT_VARIANT_3).join(REPLACEMENT_VARIANT_3_NEW);
    next = next.split(REPLACEMENT_VARIANT_4).join(REPLACEMENT_VARIANT_4_NEW);
    next = next.split(REPLACEMENT_VARIANT_5).join(REPLACEMENT_VARIANT_5_NEW);

    // Phase 1 step 4 / Phase 2.5: add the
    // `configureAgent` stub to the ad-hoc fakes. The
    // stub throws "not used" — any test that exercises
    // "Configure Agent" overrides it.
    const FAKE_CONFIGURE = "configureAgent: async () => { throw new Error(\"not used\"); },";
    next = next.replace(
      /(loadDelegationCredential: async \(\) => null,)/g,
      `$1\n        ${FAKE_CONFIGURE}`,
    );
    if (next !== text) {
      writeFileSync(file, next, "utf8");
      patched += 1;
      console.log(`patched ${file}`);
    }
  }
}
console.log(`total files patched: ${patched}`);
