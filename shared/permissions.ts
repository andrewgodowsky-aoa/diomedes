/** Version 2 adds scoped authority; exact approval protocol version 1 is unchanged. */
export interface TaskScopeGrant {
  readonly protocolVersion: 2;
  readonly id: string;
  readonly commandId: string;
  readonly payloadDigest: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly tenantId: null;
  readonly issuer: {
    readonly actor: 'local-client';
    readonly assurance: 'loopback';
    readonly authenticated: false;
    readonly deviceId: null;
    readonly sessionId: null;
  };
  readonly hostLease: string;
  readonly projectFolder: string;
  readonly roots: readonly string[];
  readonly operations: readonly ('text.create' | 'text.modify')[];
  readonly engine: 'codex';
  readonly accountRoute: 'codex:chatgpt';
  readonly review: 'human';
  readonly budget: {
    readonly maxWrites: number;
    readonly maxBytes: number;
    readonly providerInference: 'separate-consent';
  };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly eventId: string;
}
export interface ScopeGrantRecord {
  grant: TaskScopeGrant;
  generation: number;
  revokedAt: string | null;
}
export interface ScopeGrantView extends ScopeGrantRecord {
  active: boolean;
  reason: string;
}
export interface ScopeGrantCommand {
  protocolVersion: 2;
  commandId: string;
  taskId: string;
  roots: string[];
  operations: ('text.create' | 'text.modify')[];
  engine: 'codex';
  accountRoute: 'codex:chatgpt';
  maxWrites: number;
  maxBytes: number;
  ttlMinutes: number;
  review: 'human';
}
/** A deterministic authorization, never a synthetic human exact-approval receipt. */
export interface ScopedAuthorization {
  readonly protocolVersion: 2;
  readonly kind: 'scope-grant';
  readonly id: string;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly grantGeneration: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly proposalDigest: string;
  readonly actionDigest: string;
  readonly baseDigest: string;
  readonly engine: string;
  readonly accountRoute: string;
  readonly writes: number;
  readonly bytes: number;
  readonly authorizedAt: string;
  readonly eventId: string;
}
export const PERMISSION_PRESETS = [
  {
    id: 'review',
    name: 'Review changes',
    supported: true,
    detail: 'Review one related change set before it is applied.',
  },
  {
    id: 'project',
    name: 'Work in this project',
    supported: true,
    detail:
      'Codex text proposals: create and update supported project files for one task. Confirm sending separately.',
  },
  {
    id: 'auto-review',
    name: 'Approve for me',
    supported: false,
    detail: 'No separate bounded reviewer is connected. Requests require your decision.',
  },
  {
    id: 'full',
    name: 'Full access...',
    supported: false,
    detail:
      'Unrestricted execution and its revocation boundary are not supported by these adapters.',
  },
] as const;
