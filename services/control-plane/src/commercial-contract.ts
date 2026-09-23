import type { EntitlementSnapshot } from '../contract/contract.js';

/**
 * The funding contract is `FundingRepository` / `FundingTransaction` in
 * ./funding.ts (NC-2026-09-22.1, migration 003). It consumes the existing
 * B00/micro-USD, reservation and credit contracts in shared/managed-usage.ts;
 * it adds no money semantics of its own.
 */
export type { FundingRepository as FundingRepositoryContract, FundingTransaction } from './funding.js';

export interface EntitlementRepositoryContract {
  current(tenantId: string, organizationId: string): Promise<EntitlementSnapshot>;
}
// Still no payment client, grant-writer route or model dispatch in this package.
