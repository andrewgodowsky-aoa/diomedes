import type { Turn } from '../shared/types';
import { formatOrigin as formatRecordedOrigin, type OriginSnapshot } from '../shared/attribution';

// Everything else in the shared module is used as it is; only the words shown for
// the product's own actions change here.
export * from '../shared/attribution';

/** The product's name wherever the product itself is the actor. */
export const PRODUCT_NAME = 'Nectovia';

/**
 * The name shared/attribution.ts writes for the product's own actions. It is
 * recorded, not only shown: the server stores `formatOrigin(...).primary` in
 * History sentences (server/store.ts), so the shared literal stays as it is and
 * the client maps it here, at render time.
 */
const RECORDED_NAME = 'Diomedes';

type Legacy = Parameters<typeof formatRecordedOrigin>[1];

/**
 * The attribution line as a person reads it. The application's own actions and
 * its native supervisor are the product (Decision 8), so they read as
 * Nectovia; a direct engine or model keeps exactly the name its runtime
 * reported, whatever that name is. Same shape as the shared function.
 */
export function formatOrigin(origin?: OriginSnapshot, legacy?: Legacy) {
  const recorded = formatRecordedOrigin(origin, legacy);
  const mode = origin ? origin.mode : legacy?.application ? 'application' : undefined;
  if ((mode !== 'application' && mode !== 'supervisor') || recorded.primary !== RECORDED_NAME)
    return recorded;
  const primary = PRODUCT_NAME;
  return {
    ...recorded,
    primary,
    actor: primary,
    detail: recorded.detail.replace(RECORDED_NAME, PRODUCT_NAME),
    label: `${recorded.agent ? `${recorded.agent} · ` : ''}${primary}${recorded.secondary ? ` ${recorded.secondary}` : ''}`,
  };
}

/**
 * Who is speaking in the product's own conversation: the person, or the
 * product. The screen shows the product speaking, not which engine ran (the
 * route line says that), so every turn that is not the person's is the product.
 */
export function speakerName(role: Turn['role']): string {
  return role === 'you' ? 'You' : PRODUCT_NAME;
}
