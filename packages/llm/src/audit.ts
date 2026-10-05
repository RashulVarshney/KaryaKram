import { recordProviderCall, type ProviderCallRecord, type Queryable } from '@karyakram/db';

/** Where a provider reports every call it receives. */
export interface ProviderCallAudit {
  record(entry: ProviderCallRecord): Promise<void>;
}

/** Writes to the `provider_call_audit` table, outside the workflow event store. */
export class PgProviderCallAudit implements ProviderCallAudit {
  constructor(private readonly db: Queryable) {}

  record(entry: ProviderCallRecord): Promise<void> {
    return recordProviderCall(this.db, entry);
  }
}

export class InMemoryProviderCallAudit implements ProviderCallAudit {
  readonly entries: ProviderCallRecord[] = [];

  record(entry: ProviderCallRecord): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
