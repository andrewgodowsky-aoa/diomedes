import { describe, expect, it, vi } from 'vitest';
import { AccountAgentGate, AGENT_NOT_INCLUDED, AGENT_PROJECT_UNLINKED } from '../server/accounts/agent-gate.js';
import { EngineError } from '../server/engines/process.js';

describe('Agent project attribution', () => {
  const business = 'org_active';
  const owner = 'org_owner';

  function gate(
    projectOwner: (id: string) => { organizationId: string; resourceId: string } | null,
  ) {
    const admitAgent = vi.fn();
    const workspaces = {
      projectOwner,
      active: () => ({ kind: 'business', organizationId: business }),
    };
    return { gate: new AccountAgentGate({ admitAgent } as never, workspaces as never), admitAgent };
  }

  it('uses the recorded project owner even when another business is active', () => {
    const { gate: subject } = gate((id) => id === 'project_owned' ? { organizationId: owner, resourceId: 'resource_1' } : null);
    expect(subject.organizationFor('project_owned')).toBe(owner);
  });

  it('refuses an unbound or ambiguous project before asking the account service', async () => {
    const { gate: subject, admitAgent } = gate(() => null);
    expect(subject.organizationFor('project_personal')).toBeNull();
    expect(subject.organizationFor('')).toBeNull();
    await expect(subject.check({ phase: 'admit', surface: 'conversation', projectId: 'project_personal', rootJobId: 'job_1' }))
      .rejects.toMatchObject({ code: AGENT_NOT_INCLUDED, message: AGENT_PROJECT_UNLINKED } satisfies Partial<EngineError>);
    expect(admitAgent).not.toHaveBeenCalled();
  });

  it('refuses an unbound Home project as well', () => {
    const { gate: subject } = gate(() => null);
    expect(subject.organizationFor('project_home')).toBeNull();
  });

  it('uses the active business only for projectless work', () => {
    const { gate: subject } = gate(() => null);
    expect(subject.organizationFor(null)).toBe(business);
  });
});
