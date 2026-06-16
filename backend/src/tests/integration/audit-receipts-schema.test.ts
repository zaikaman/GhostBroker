import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("audit receipts migration", () => {
  it("stores encrypted receipts and exposes an atomic persistence function", () => {
    const sql = readFileSync(
      new URL("../../../../database/migrations/004_create_audit_receipts.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists audit_receipts");
    expect(sql).toContain("receipt_ciphertext text not null");
    expect(sql).toContain("t3_attestation_ref text not null");
    expect(sql).toContain("create or replace function persist_completed_settlement");
    expect(sql).not.toMatch(/\breceipt_plaintext\b|\braw_payload\b/iu);
  });
});
