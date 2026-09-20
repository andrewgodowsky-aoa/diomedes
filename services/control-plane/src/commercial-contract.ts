import type { MicroUsd, SettledCharge, Reservation } from '../../../shared/managed-usage.js';
import type { EntitlementSnapshot } from '../contract/contract.js';

/** Future adapters consume the existing B00/micro-USD contracts, not new money semantics. */
export interface FundingRepositoryContract {
  available(tenantId: string, accountId: string): Promise<MicroUsd>;
  reservation(tenantId: string, reservationId: string): Promise<Reservation | undefined>;
  settlement(tenantId: string, reservationId: string): Promise<SettledCharge | undefined>;
}
export interface EntitlementRepositoryContract {
  current(tenantId: string, organizationId: string): Promise<EntitlementSnapshot>;
}
// Deliberately no implementation, payment client, grant writer or model dispatch.
