export interface OpaqueIntentHandle {
  intentHandle: string;
  state: "intent_sealed";
}
export * from "./blind-intent.js";
export * from "./match-contract-client.js";
export * from "./settlement-command.js";
