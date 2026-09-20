import { WorkOSIdentityVerifier as PortableVerifier, type WorkOSIdentityConfiguration } from '../../services/control-plane/src/identity-workos.js';
import { AccountError } from '../../services/control-plane/src/errors.js';
import { ApiError } from '../paths.js';
export type { WorkOSIdentityConfiguration };

export class WorkOSIdentityVerifier extends PortableVerifier {
  override async verify(token: string) {
    try { return await super.verify(token); }
    catch (error) { if (error instanceof AccountError) throw new ApiError(error.status, error.message); throw error; }
  }
}
