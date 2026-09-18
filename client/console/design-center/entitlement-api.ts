/**
 * What this person may do in the Design Center, as the client learns it.
 *
 * The client reflects this answer and computes none of it. There is deliberately
 * no local fallback, no cached "probably yes" and no reading of a package flag
 * or anything in browser storage: the server decides, the routes enforce the
 * same decision, and a screen that guessed would only ever guess wrong in the
 * direction of showing a control that is about to be refused.
 */
import type { CustomizationStatus } from '../../../shared/customization-entitlement';
import { api } from '../../api';

export type { CustomizationStatus };

/**
 * The conservative answer while the question is still in flight, or when it
 * could not be asked at all. Nothing premium, and every free control untouched.
 */
export const NO_CUSTOMIZATION: CustomizationStatus = {
  capability: 'customization',
  granted: false,
  via: 'none',
  authoring: false,
  entitlementState: 'unknown',
  planId: null,
  canActivateForOrganization: false,
  code: null,
  reason: '',
  freeFeatures: [],
  paidFeatures: [],
};

export const readCustomizationStatus = () =>
  api<CustomizationStatus>('/design-center/entitlement');
