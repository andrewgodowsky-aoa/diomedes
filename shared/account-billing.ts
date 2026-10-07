import { z } from 'zod';

export const billingPlanIds = ['individual', 'business', 'workflow-starter', 'managed-small', 'managed-standard', 'managed-plus'] as const;
export const billingPlanId = z.enum(billingPlanIds);
export const billingTarget = z.strictObject({ organizationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).nullable() });
export const subscriptionInput = billingTarget.extend({ planId: billingPlanId, individualEligible: z.boolean() });
export const developerKeyInput = billingTarget.extend({ name: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f<>]+$/), expiresInDays: z.number().int().min(1).max(365) });
export const billingActionInput = z.discriminatedUnion('action', [
  billingTarget.extend({ action: z.literal('read') }), subscriptionInput.extend({ action: z.literal('checkout') }),
  billingTarget.extend({ action: z.literal('portal') }), z.strictObject({ action: z.literal('keys') }),
  developerKeyInput.extend({ action: z.literal('create-key') }), z.strictObject({ action: z.literal('revoke-key'), id: z.string().regex(/^developer_key_[a-f0-9-]{36}$/) }),
]);
export type BillingAction = z.infer<typeof billingActionInput>;
export const developerKeyView = z.object({ id: z.string(), name: z.string(), prefix: z.string(), scope: z.object({ kind: z.enum(['individual', 'organization']), id: z.string() }), createdAt: z.string(), expiresAt: z.string(), revokedAt: z.string().nullable() });
export type DeveloperKeyView = z.infer<typeof developerKeyView>;
export const billingView = z.object({ mode: z.enum(['test', 'live']), portalAvailable: z.boolean(), plans: z.array(z.object({ id: billingPlanId, available: z.boolean() })), subscriptions: z.array(z.object({ id: z.string(), planId: billingPlanId, status: z.string(), validUntil: z.string().nullable() })) });
export type BillingView = z.infer<typeof billingView>;
export function allowedBillingUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname); } catch { return false; }
}
