export interface SettlementReference {
  executionRef: string;
  settlementStatus: "settled" | "failed" | "reversed";
}
