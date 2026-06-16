import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("completed trades migration", () => {
  it("defines participant constraints and encrypted trade columns", () => {
    const sql = readFileSync(
      new URL("../../../../database/migrations/003_create_completed_trades.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toContain("create table if not exists completed_trades");
    expect(sql).toContain("asset_code_ciphertext text not null");
    expect(sql).toContain("quantity_ciphertext text not null");
    expect(sql).toContain("execution_price_ciphertext text not null");
    expect(sql).toContain("check (buy_institution_id <> sell_institution_id)");
    expect(sql).not.toMatch(/\basset_code text\b|\bquantity numeric\b|\bprice numeric\b/iu);
  });
});
