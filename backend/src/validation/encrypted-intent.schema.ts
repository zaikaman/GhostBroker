import { z } from "zod";
import { isForbiddenOrderField } from "../privacy/forbidden-fields.js";
import {
  hiddenIntentRequestSchema,
  type HiddenIntentRequest,
} from "../models/hidden-intent.js";

function findForbiddenKeys(value: unknown): string[] {
  const findings: string[] = [];

  function visit(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const nextPath = `${path}.${key}`;

      if (isForbiddenOrderField(key)) {
        findings.push(nextPath);
      }

      visit(child, nextPath);
    }
  }

  visit(value, "$");
  return findings;
}

export const encryptedIntentRequestSchema = z
  .unknown()
  .superRefine((value, context) => {
    for (const path of findForbiddenKeys(value)) {
      context.addIssue({
        code: "custom",
        message: `Plaintext trading field is not accepted at ${path}.`,
      });
    }
  })
  .pipe(hiddenIntentRequestSchema);

export function parseEncryptedIntentRequest(value: unknown): HiddenIntentRequest {
  return encryptedIntentRequestSchema.parse(value);
}
