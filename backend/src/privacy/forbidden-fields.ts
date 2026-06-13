export const forbiddenOrderFieldNames = [
  "asset",
  "assetCode",
  "asset_code",
  "side",
  "quantity",
  "qty",
  "price",
  "bid",
  "ask",
  "bidPrice",
  "askPrice",
  "executionPrice",
  "execution_price_plaintext",
  "counterparty",
  "counterpartyId",
  "activeOrderCount",
  "active_order_count",
  "queue",
  "queueDepth",
  "queueRank",
  "rank",
  "matchScore",
  "rawPayload",
  "raw_payload",
  "plaintext",
  "encrypted_payload_plaintext",
  "contractArgs",
  "contract_args",
  "secret",
  "secrets",
  "privateKey",
  "private_key",
] as const;

const forbiddenFieldSet = new Set<string>(
  forbiddenOrderFieldNames.map((field) => field.toLowerCase()),
);

export interface ForbiddenFieldFinding {
  path: string;
  field: string;
}

export function isForbiddenOrderField(field: string): boolean {
  return forbiddenFieldSet.has(field.toLowerCase());
}

/** Fields that are exempt from the forbidden-fields scan.
 * These are platform-level metadata fields, not encrypted intent params.
 */
const exemptPaths = new Set<string>(["$.settlementMetadata"]);

export function scanForbiddenFields(
  value: unknown,
  path = "$",
): readonly ForbiddenFieldFinding[] {
  const findings: ForbiddenFieldFinding[] = [];

  function visit(node: unknown, currentPath: string): void {
    // Skip entire subtrees that are exempt
    if (exemptPaths.has(currentPath)) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const nextPath = `${currentPath}.${key}`;

      if (isForbiddenOrderField(key)) {
        findings.push({ path: nextPath, field: key });
      }

      visit(child, nextPath);
    }
  }

  visit(value, path);
  return findings;
}

export function assertNoForbiddenFields(value: unknown): void {
  const findings = scanForbiddenFields(value);

  if (findings.length > 0) {
    const paths = findings.map((finding) => finding.path).join(", ");
    throw new Error(`Forbidden order fields detected: ${paths}`);
  }
}
