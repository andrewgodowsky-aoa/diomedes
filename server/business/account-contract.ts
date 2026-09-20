import type { AccountState } from '../../services/control-plane/src/domain.js';
export {
  ACCOUNT_FOUNDATION_VERSION, accountId, verifiedIdentitySchema, accountStateSchema, emptyAccountState,
  type VerifiedIdentity, type IdentityVerifier, type AccountState, type AccountSession, type AccountMembershipSnapshot,
} from '../../services/control-plane/src/domain.js';

/** Local Store owns persistence and the complete callback lock. Async steps are
 * limited to the portable state adapter; identity/provider calls precede it. */
export interface AccountRepository {
  readonly scope: string;
  read<T>(action: (state: AccountState) => T | Promise<T>): Promise<T>;
  transact<T>(action: (state: AccountState) => T | Promise<T>): Promise<T>;
}
