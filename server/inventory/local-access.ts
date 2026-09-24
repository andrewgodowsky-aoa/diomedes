/**
 * Local-principal inventory access (DIO-95).
 *
 * This pulls MI01's authorization *check* forward without MI01's device
 * pairing or verified web identity. A caller is admitted only when all of these
 * hold, re-checked from current state at every phase:
 *
 * - the request arrived on loopback, addressed to a loopback Host, with no proxy
 *   forwarding headers (no inventory listener is reachable beyond loopback until
 *   MI01 ships);
 * - it carries this launch's desktop session token, the same credential the
 *   local server's global gate checks;
 * - the acting principal is this installation's local person, the identity the
 *   rest of the local server attributes work to, never an identity named in a
 *   header or body;
 * - that person is an active member of the organization that owns the project,
 *   and an access profile assigned to them grants the inventory permission.
 *
 * This is local-principal authorization, not device identity. It does not
 * authenticate a phone, a tablet, a shared login or a second person on another
 * machine; those remain MI01 (with B02/B03).
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { BusinessPermission } from '../../shared/business-access.js';
import { inventoryScopeSchema, type InventoryCommand } from '../../shared/inventory.js';
import type { Organization } from '../../shared/workspaces.js';
import { ApiError } from '../paths.js';
import { denial, type Capability } from '../trust/index.js';
import type { WorkspaceService } from '../workspaces.js';
import type {
  InventoryStockAuthorization,
  InventoryStockAuthorizer,
  InventoryStockPermission,
} from './stock-service.js';

/** Stable refusal codes. Tests and clients match these, not the sentences. */
export const INVENTORY_REFUSAL = Object.freeze({
  loopbackOnly: 'inventory_loopback_only',
  unauthenticated: 'inventory_unauthenticated',
  notFound: 'inventory_not_found',
  forbidden: 'inventory_forbidden',
} as const);

/** One sentence for an absent project, another tenant's project and a lost membership. */
export const INVENTORY_UNAVAILABLE = 'Inventory is unavailable.';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'];
const SESSION_TOKEN = /^[0-9a-f]{64}$/;

export interface InventoryIngress {
  readonly socket: { readonly remoteAddress?: string; readonly localAddress?: string };
  readonly headers: IncomingHttpHeaders;
}

/**
 * The explicit MI01 ingress guard. Returns a refusal for anything that did not
 * arrive over loopback, whatever address the listener happens to be bound to.
 * A local proxy relaying another machine's request is refused by its forwarding
 * headers; one that strips them is out of scope and is why this is not device
 * identity.
 */
export function inventoryIngressRefusal(request: InventoryIngress): ApiError | null {
  const remote = request.socket.remoteAddress ?? '';
  const local = request.socket.localAddress ?? '';
  const host = request.headers.host ?? '';
  if (
    !LOOPBACK_ADDRESSES.has(remote) ||
    !LOOPBACK_ADDRESSES.has(local) ||
    !LOOPBACK_HOST.test(host) ||
    FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined)
  )
    return new ApiError(
      403,
      'Inventory accepts this computer only until device access is available.',
      { code: INVENTORY_REFUSAL.loopbackOnly },
    );
  return null;
}

/** What the route is about to do. The claim is resolved for exactly this. */
export type InventoryRouteNeed =
  | { readonly projectId: string; readonly action: 'read' }
  | { readonly projectId: string; readonly action: 'command'; readonly command: InventoryCommand };

/**
 * Proposed default mapping from stock commands onto the existing access-profile
 * permissions. Corrections additionally need `inventory:adjust`.
 */
export const INVENTORY_COMMAND_PERMISSION: Readonly<
  Record<InventoryCommand['kind'], BusinessPermission>
> = Object.freeze({
  receive: 'inventory:record',
  use: 'inventory:record',
  transfer: 'inventory:record',
  adjust: 'inventory:adjust',
  'record-count': 'inventory:count',
});
const CORRECTION_PERMISSION: BusinessPermission = 'inventory:adjust';
const READ_PERMISSION: BusinessPermission = 'inventory:view';

function required(need: InventoryRouteNeed): BusinessPermission[] {
  if (need.action === 'read') return [READ_PERMISSION];
  return [
    INVENTORY_COMMAND_PERMISSION[need.command.kind],
    ...(need.command.correctsReceiptId ? [CORRECTION_PERMISSION] : []),
  ];
}

/** Opaque to callers. Only claim() mints one; a look-alike object is refused. */
export interface LocalInventoryClaim {
  readonly personId: string;
  readonly organizationId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly resourceId: string;
}

/**
 * The tenant label an inventory scope carries for a workspace organization.
 * Inventory IDs admit no ':', while a local organization's tenant is
 * `org:<organization id>`. That exact local form maps to `org.<organization id>`
 * (organization ids never contain '.', so the mapping is one-to-one); any other
 * tenant that is not already a valid inventory ID is unsupported (null), never
 * guessed. The organization id is checked separately, so a label can never
 * stand in for membership.
 */
export function inventoryTenantId(
  organization: Pick<Organization, 'id' | 'tenantId'>,
): string | null {
  const valid = (value: string) => inventoryScopeSchema.shape.tenantId.safeParse(value).success;
  if (valid(organization.tenantId)) return organization.tenantId;
  if (organization.tenantId === `org:${organization.id}` && !organization.id.includes('.')) {
    const mapped = `org.${organization.id}`;
    if (valid(mapped)) return mapped;
  }
  return null;
}

const notFound = () =>
  new ApiError(404, INVENTORY_UNAVAILABLE, { code: INVENTORY_REFUSAL.notFound });

export function createLocalInventoryAccess(options: {
  readonly workspaces: WorkspaceService;
  /** This launch's desktop session token. There is no unauthenticated mode. */
  readonly sessionToken: string;
}) {
  if (!SESSION_TOKEN.test(options.sessionToken))
    throw new Error('Inventory access needs the desktop session token.');
  const token = Buffer.from(options.sessionToken, 'hex');
  const { workspaces } = options;
  const minted = new WeakSet<object>();

  /** Owner organization and resource, or null when absent or not this person's. */
  const target = (projectId: string) => {
    const owner = workspaces.projectOwner(projectId);
    if (!owner) return null;
    const organization = workspaces.organization(owner.organizationId);
    if (!organization) return null;
    const tenantId = inventoryTenantId(organization);
    if (tenantId === null) return null;
    try {
      workspaces.assertMine(owner.organizationId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    return { ...owner, tenantId };
  };
  const allows = (
    owner: { organizationId: string; resourceId: string },
    permission: BusinessPermission,
  ) => workspaces.accessDecision(owner.organizationId, permission, owner.resourceId).allowed;

  /** Resolve the acting principal for one route call from server-side facts only. */
  function claim(request: InventoryIngress, need: InventoryRouteNeed): LocalInventoryClaim {
    const refusal = inventoryIngressRefusal(request);
    if (refusal) throw refusal;
    const supplied = request.headers['x-diomedes-session'];
    if (
      typeof supplied !== 'string' ||
      !SESSION_TOKEN.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied, 'hex'), token)
    )
      throw new ApiError(401, 'Inventory needs this computer’s Diomedes session.', {
        code: INVENTORY_REFUSAL.unauthenticated,
      });
    const person = workspaces.currentPerson();
    const owner = target(need.projectId);
    if (!owner) throw notFound();
    if (!required(need).every((permission) => allows(owner, permission)))
      throw new ApiError(
        403,
        'Your access in this business does not include this inventory action.',
        {
          code: INVENTORY_REFUSAL.forbidden,
        },
      );
    const resolved: LocalInventoryClaim = Object.freeze({
      personId: person.id,
      organizationId: owner.organizationId,
      tenantId: owner.tenantId,
      projectId: need.projectId,
      resourceId: owner.resourceId,
    });
    minted.add(resolved);
    return resolved;
  }

  /**
   * The stock service's authorizer. Called at admission, immediately before the
   * effect and for every read, so a membership or profile change between claim
   * and write is seen. The claim is a pointer; nothing in it is trusted without
   * re-reading current state.
   */
  const authorize: InventoryStockAuthorizer<LocalInventoryClaim> = async (current, request) => {
    if (!current || typeof current !== 'object' || !minted.has(current))
      return denial(401, 'no-claim', 'Inventory access needs a principal resolved by this host.');
    const person = workspaces.currentPerson();
    if (person.id !== current.personId)
      return denial(401, 'unknown-principal', 'The local person changed; resolve access again.');
    const owner = target(request.projectId);
    if (
      request.projectId !== current.projectId ||
      !owner ||
      owner.organizationId !== current.organizationId ||
      owner.resourceId !== current.resourceId ||
      owner.tenantId !== current.tenantId
    )
      return denial(403, 'revoked', INVENTORY_UNAVAILABLE);
    const view = workspaces.accessDecision(owner.organizationId, READ_PERMISSION, owner.resourceId);
    const kinds = Object.keys(INVENTORY_COMMAND_PERMISSION) as InventoryCommand['kind'][];
    const permissions: InventoryStockPermission[] = kinds.filter((kind) =>
      allows(owner, INVENTORY_COMMAND_PERMISSION[kind]),
    );
    if (allows(owner, CORRECTION_PERMISSION)) permissions.push('correct');
    const capabilities = new Set<Capability>();
    if (view.allowed) capabilities.add('project.read');
    if (kinds.some((kind) => permissions.includes(kind))) capabilities.add('write.apply');
    const authorization: InventoryStockAuthorization = {
      scope: {
        organizationId: owner.organizationId,
        tenantId: owner.tenantId,
        projectId: request.projectId,
      },
      // The receipt's actor is the resolved local person, never a request field.
      actorPersonId: person.id,
      permissions,
      authority: {
        principal: {
          kind: 'local-owner',
          id: person.id,
          tenantId: owner.tenantId,
          projectId: request.projectId,
          deviceId: null,
          sessionId: null,
          slotId: null,
        },
        // Workspace access generations advance on membership revocation and on
        // every profile or assignment change, so the service's effect-time
        // comparison refuses a write whose access changed after admission.
        generation: { identity: view.organizationGeneration, principal: view.principalGeneration },
        assurance: 'loopback',
        capabilities,
        synthetic: false,
        expiresAt: null,
        resolvedAt: new Date().toISOString(),
      },
    };
    return authorization;
  };

  return { claim, authorize };
}

export type LocalInventoryAccess = ReturnType<typeof createLocalInventoryAccess>;
