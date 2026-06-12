import { PublicError } from "../errors/public-error.js";
import {
  auditReceiptFromRecord,
  type AuditReceipt,
  type AuditReceiptRecord,
} from "../models/audit-receipt.js";

interface ReceiptSelectQuery {
  eq(column: string, value: string): ReceiptSelectQuery;
  single(): Promise<{ data: AuditReceiptRecord | null; error: Error | null }>;
}

interface ReceiptUpdateQuery {
  eq(column: string, value: string): ReceiptUpdateQuery;
  then<TResult1 = { error: Error | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { error: Error | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

interface ReceiptTableQuery {
  select(columns?: string): ReceiptSelectQuery;
  update(value: Record<string, unknown>): ReceiptUpdateQuery;
}

export interface ReceiptRepository {
  getAuthorizedReceipt(
    receiptId: string,
    institutionId: string,
  ): Promise<AuditReceipt | null>;
  markOpened(receiptId: string, institutionId: string, openedAt: string): Promise<void>;
}

export interface SupabaseReceiptClient {
  from(table: "audit_receipts"): ReceiptTableQuery;
}

export class SupabaseReceiptRepository implements ReceiptRepository {
  private readonly client: SupabaseReceiptClient;

  public constructor(client: SupabaseReceiptClient) {
    this.client = client;
  }

  public async getAuthorizedReceipt(
    receiptId: string,
    institutionId: string,
  ): Promise<AuditReceipt | null> {
    const { data, error } = await this.client
      .from("audit_receipts")
      .select("*")
      .eq("id", receiptId)
      .eq("institution_id", institutionId)
      .single();

    if (error || !data) {
      return null;
    }

    return auditReceiptFromRecord(data);
  }

  public async markOpened(
    receiptId: string,
    institutionId: string,
    openedAt: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("audit_receipts")
      .update({ opened_at: openedAt })
      .eq("id", receiptId)
      .eq("institution_id", institutionId);

    if (error) {
      throw new PublicError("service_unavailable", 503, error);
    }
  }
}

export class ReceiptService {
  private readonly repository: ReceiptRepository;

  public constructor(repository: ReceiptRepository) {
    this.repository = repository;
  }

  public async getReceipt(
    receiptId: string,
    institutionId: string,
  ): Promise<AuditReceipt> {
    const receipt = await this.repository.getAuthorizedReceipt(
      receiptId,
      institutionId,
    );

    if (!receipt) {
      throw new PublicError("not_found", 404);
    }

    await this.repository.markOpened(
      receiptId,
      institutionId,
      new Date().toISOString(),
    );
    return receipt;
  }
}
