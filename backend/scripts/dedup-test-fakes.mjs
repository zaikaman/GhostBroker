#!/usr/bin/env node
// One-shot dedup: when the patch script ran twice,
// some files have two `configureAgent: ...` keys
// back-to-back. The second key is syntactically at the
// wrong indent. Detect the broken pattern and emit a
// single correctly-indented key.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TARGETS = ["src/tests/contracts", "src/tests/integration", "src/tests/unit"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

const BROKEN = /(loadDelegationCredential: async \(\) => null,)\s*\n(\s+)configureAgent: async \(\) => \{ throw new Error\("not used"\); \},\s*\n(\s+)([a-zA-Z]+:) /g;

let patched = 0;
for (const dir of TARGETS) {
  for (const file of walk(dir)) {
    const t = readFileSync(file, "utf8");
    // First collapse the broken fragment: a
    // `loadDelegationCredential` line followed by a
    // mis-indented `configureAgent` followed by a
    // normally-indented key. Replace the whole
    // 3-line fragment with a clean 3-line block.
    const out = t.replace(
      BROKEN,
      (_match, ldcLine, badIndent, goodIndent, nextKey) => {
        return `${ldcLine}\n${goodIndent}configureAgent: async () => {\n${goodIndent}  throw new Error("not used");\n${goodIndent}},\n${goodIndent}${nextKey} `;
      },
    );
    if (out !== t) {
      writeFileSync(file, out, "utf8");
      patched += 1;
      console.log(`patched ${file}`);
    }
  }
}
console.log(`total: ${patched}`);
