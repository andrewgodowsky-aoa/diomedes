import type { AuditEvent, CommercialTransaction } from './commercial.js';
import type { FundingTransaction } from './funding.js';

/** One database transaction owns the credit and its immutable staff receipt. */
export interface StaffFundingTransaction extends Pick<CommercialTransaction,
  'lockStaff' | 'operator' | 'lockOrganization' | 'organizationRecord' | 'grants' | 'audit'> {
  readonly funding: FundingTransaction;
  auditById(id: string): Promise<AuditEvent | undefined>;
}
export interface StaffFundingRepository {
  transaction<T>(action: (tx: StaffFundingTransaction) => Promise<T>): Promise<T>;
}

/** Length-safe identity from authenticated scope, never from a supplied actor. */
export async function staffFundingId(scope: readonly string[]): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(scope)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
