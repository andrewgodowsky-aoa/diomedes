import { afterEach, describe, expect, test } from 'vitest';
import {
  currentAuthority,
  disablePrototypeAuthority,
  enablePrototypeAuthority,
  installTrustBackend,
  isDenial,
  refOf,
  requireAssurance,
  requireCapability,
  requireGenuine,
  revoke,
  type Authority,
  type Denial,
  type Principal,
  type PrincipalRef,
  type TrustBackend,
} from '../server/trust/index.js';
import { __resetRevocationState } from '../server/trust/revocation.js';

const LABEL = 'nr03-synthetic';

function arm(capabilities: Parameters<typeof enablePrototypeAuthority>[0]['capabilities'], expiresAt?: string | null) {
  enablePrototypeAuthority({ label: LABEL, capabilities, expiresAt });
}

function granted(result: Authority | Denial): Authority {
  if (isDenial(result)) throw new Error(`expected an Authority, got ${result.code}: ${result.reason}`);
  return result;
}

function refused(result: Authority | Denial): Denial {
  if (!isDenial(result)) throw new Error('expected a Denial, got an Authority');
  return result;
}

/** A permissive backend: it echoes back whatever a reference names. */
const echoBackend: TrustBackend = {
  async lookupTeamMember() {
    return null;
  },
  async lookupPrincipalRef(ref: PrincipalRef): Promise<Principal> {
    return {
      kind: ref.kind,
      id: ref.id,
      tenantId: ref.tenantId,
      projectId: null,
      deviceId: ref.kind === 'device' ? ref.id : null,
      sessionId: null,
      slotId: null,
    };
  },
  async localOwner() {
    return null;
  },
};

afterEach(() => {
  disablePrototypeAuthority();
  __resetRevocationState();
});

describe('the bounded prototype driver', () => {
  test('is off unless armed', async () => {
    expect(refused(await currentAuthority({ via: 'prototype-driver', label: LABEL })).code).toBe(
      'synthetic-refused',
    );
  });

  test('issues a labelled, synthetic authority with only the listed capabilities', async () => {
    arm(['egress.send', 'egress.reconcile']);
    const a = granted(await currentAuthority({ via: 'prototype-driver', label: LABEL }));
    expect(a.principal.kind).toBe('prototype');
    expect(a.synthetic).toBe(true);
    expect(a.assurance).toBe('prototype');
    expect([...a.capabilities].sort()).toEqual(['egress.reconcile', 'egress.send']);
    expect(a.principal.deviceId).toBeNull();
    expect(a.principal.sessionId).toBeNull();
    expect(isDenial(requireGenuine(a))).toBe(true);
  });

  test('refuses a label that does not match the armed grant', async () => {
    arm(['egress.send']);
    expect(refused(await currentAuthority({ via: 'prototype-driver', label: 'other' })).code).toBe(
      'synthetic-refused',
    );
  });

  test('may not be armed with project.admin', () => {
    // Rejected at arming time, before assertInvariants is ever reached — the
    // grant never comes into existence, so there is nothing to resolve later.
    expect(() => arm(['project.admin'])).toThrow(/may not hold project\.admin/);
  });
});

describe('saved-reference resolution for the driver', () => {
  test('round-trips and preserves synthetic, assurance, capabilities and expiry', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    arm(['egress.send', 'egress.reconcile'], expiresAt);
    const first = granted(await currentAuthority({ via: 'prototype-driver', label: LABEL }));
    const ref = refOf(first);

    const back = granted(await currentAuthority({ via: 'stored-reference', ref }));
    expect(back.synthetic).toBe(true);
    expect(back.assurance).toBe('prototype');
    expect(back.expiresAt).toBe(expiresAt);
    expect([...back.capabilities].sort()).toEqual(['egress.reconcile', 'egress.send']);
    expect(back.principal.kind).toBe('prototype');
    expect(back.principal.id).toBe(first.principal.id);
  });

  test('resolves without a backend installed', async () => {
    arm(['egress.reconcile']);
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    expect(isDenial(await currentAuthority({ via: 'stored-reference', ref }))).toBe(false);
  });

  test('a capability withheld at arming stays withheld across the round trip', async () => {
    arm(['egress.reconcile']);
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    const back = await currentAuthority({ via: 'stored-reference', ref });
    expect(refused(requireCapability(back, 'egress.send')).code).toBe('missing-capability');
    expect(refused(requireAssurance(back, 'device-key')).code).toBe('insufficient-assurance');
  });

  test('an expired grant denies on re-resolution', async () => {
    arm(['egress.send'], new Date(Date.now() + 40).toISOString());
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(refused(await currentAuthority({ via: 'stored-reference', ref })).code).toBe('expired');
  });

  test('revoking the prototype principal denies re-resolution', async () => {
    arm(['egress.send']);
    const a = granted(await currentAuthority({ via: 'prototype-driver', label: LABEL }));
    const ref = refOf(a);
    await revoke({ kind: 'prototype', id: a.principal.id }, 'host withdrew the driver');
    expect([403, 409]).toContain(refused(await currentAuthority({ via: 'stored-reference', ref })).status);
  });
});

describe('old references are invalidated', () => {
  test('after disable', async () => {
    arm(['egress.send']);
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    disablePrototypeAuthority();
    expect(refused(await currentAuthority({ via: 'stored-reference', ref })).code).toBe(
      'synthetic-refused',
    );
  });

  test('after re-arm with the same label and capabilities', async () => {
    arm(['egress.send']);
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    arm(['egress.send']);
    const denied = refused(await currentAuthority({ via: 'stored-reference', ref }));
    expect(denied.status).toBe(409);
    expect(denied.code).toBe('generation-advanced');
  });

  test('after a re-arm that widens capabilities, the old reference cannot claim them', async () => {
    arm(['egress.reconcile']);
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    arm(['egress.send', 'egress.reconcile', 'write.apply']);
    expect(refused(await currentAuthority({ via: 'stored-reference', ref })).code).toBe(
      'generation-advanced',
    );
  });

  test('a restart is a fresh instance: a reference minted before it does not resolve', async () => {
    arm(['egress.send']);
    const ref = refOf(granted(await currentAuthority({ via: 'prototype-driver', label: LABEL })));
    // A restart loses the in-memory grant, then the host arms identically again.
    disablePrototypeAuthority();
    arm(['egress.send']);
    expect(refused(await currentAuthority({ via: 'stored-reference', ref })).status).toBe(409);
  });
});

describe('a prototype reference cannot launder itself into genuine authority', () => {
  test('even with a permissive backend installed', async () => {
    installTrustBackend(echoBackend);
    arm(['egress.reconcile']);
    const a = granted(await currentAuthority({ via: 'prototype-driver', label: LABEL }));
    const back = granted(await currentAuthority({ via: 'stored-reference', ref: refOf(a) }));

    // The regression this suite exists for: these three were false, 'owner-local'
    // and all nine capabilities when a prototype principal carried kind 'local-owner'.
    expect(back.synthetic).toBe(true);
    expect(back.assurance).toBe('prototype');
    expect(back.capabilities.has('project.admin')).toBe(false);
    expect(back.capabilities.has('approval.decide')).toBe(false);
    expect([...back.capabilities]).toEqual(['egress.reconcile']);
  });

  test('a hand-forged reference naming a local owner is refused a prototype grant', async () => {
    installTrustBackend(echoBackend);
    arm(['egress.send']);
    const forged: PrincipalRef = {
      kind: 'local-owner',
      id: 'prototype:nr03-synthetic:forged',
      tenantId: null,
      mintedAt: { identity: 0, principal: 0 },
    };
    const back = granted(await currentAuthority({ via: 'stored-reference', ref: forged }));
    // It resolves as what it claims to be, and gets NO prototype treatment.
    expect(back.principal.kind).toBe('local-owner');
    expect(back.synthetic).toBe(false);
  });

  test('a backend may not change the identity class a reference names', async () => {
    installTrustBackend({
      ...echoBackend,
      async lookupPrincipalRef(ref) {
        return {
          kind: 'local-owner',
          id: ref.id,
          tenantId: null,
          projectId: null,
          deviceId: null,
          sessionId: null,
          slotId: null,
        };
      },
    });
    const ref: PrincipalRef = {
      kind: 'device',
      id: 'd-1',
      tenantId: null,
      mintedAt: { identity: 0, principal: 0 },
    };
    expect(refused(await currentAuthority({ via: 'stored-reference', ref })).code).toBe(
      'unknown-principal',
    );
  });
});

describe('invariants that hold regardless of the driver', () => {
  test('a team member never receives egress.send', async () => {
    const member: Principal = {
      kind: 'team-member',
      id: 'm-1',
      tenantId: null,
      projectId: 'p1',
      deviceId: null,
      sessionId: null,
      slotId: 'a1',
    };
    installTrustBackend({
      async lookupTeamMember(_p, slotId, token) {
        return slotId === 'a1' && token === 't' ? member : null;
      },
      async lookupPrincipalRef() {
        return null;
      },
      async localOwner() {
        return null;
      },
    });
    const a = granted(
      await currentAuthority({
        via: 'loopback-http',
        remoteAddress: '127.0.0.1',
        projectId: 'p1',
        headers: { authorization: 'Bearer t', 'x-slot-id': 'a1' },
      }),
    );
    expect(a.capabilities.has('egress.send')).toBe(false);
    expect(a.capabilities.has('approval.decide')).toBe(false);
    expect(a.capabilities.has('team.call')).toBe(true);
  });

  test('non-loopback is refused before any lookup', async () => {
    const denied = refused(
      await currentAuthority({
        via: 'loopback-http',
        remoteAddress: '10.0.0.5',
        projectId: 'p1',
        headers: { authorization: 'Bearer t', 'x-slot-id': 'a1' },
      }),
    );
    expect(denied.status).toBe(403);
  });
});
