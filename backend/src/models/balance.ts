export interface BalanceUpdateCommand {
  institutionId: string;
  settlementProfileRef: string;
  encryptedDeltaRef: string;
}

export interface AtomicBalanceUpdateCommand {
  executionRef: string;
  buyer: BalanceUpdateCommand;
  seller: BalanceUpdateCommand;
}
