/**
 * OA2: the host side of an outside agent's tools.
 *
 * An outside agent runs with its own tools switched off and inside a box that
 * refuses its files and network. What it can still do, it does by asking this
 * host: each call arrives in-band (a Codex `item/tool/call` server request, or
 * an MCP `tools/call` inside a Claude Code `mcp_message`), and lands here.
 *
 * Every call goes through one H12 `ToolRegistry` and `RunService` step, so an
 * outside agent's work is recorded, budgeted, approved and reconciled exactly
 * like the Nectovia Agent's own. The registry is the caller's choice; for
 * project work it is a sandbox copy's (`SandboxStore.registry`), so writes
 * land in the copy and come back as a change set for a person to apply.
 *
 * Paid only. The work is admitted once, before the agent starts, through the
 * same Agent gate as every other paid route (`routeKind: 'external-engine'`,
 * as a worker under a lead is). The gate's rule is that admission runs before
 * work and never inside a step, so a call here checks the carried admission's
 * `validUntil` instead of asking the account service again; past it, the call
 * is refused and the host admits again before the next turn.
 *
 * What the agent reads back is plain text: the tool's JSON result, or the
 * refusal's message and code. Nothing else of a failure (no stack, no path the
 * agent did not name) is returned.
 */
import { createHash } from 'node:crypto';
import type { HarnessPrincipal, Json } from '../../shared/harness.js';
import type { AgentGatePort, AdmittedAgentWork } from '../accounts/agent-gate.js';
import type { AgentSurface } from '../accounts/session.js';
import { HarnessError } from '../harness/policy.js';
import { Suspended, type RunService } from '../harness/run-service.js';
import type { ToolRegistry } from '../harness/tools.js';
import { refuseOutside } from './container-request.js';

/** What an outside agent is told about one tool. */
export interface OutsideTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments, always an object. */
  readonly inputSchema: Record<string, Json>;
}

/** One call's answer, as both in-band channels carry it. */
export interface ToolAnswer {
  readonly ok: boolean;
  readonly text: string;
}

export interface ToolHostOptions {
  readonly registry: ToolRegistry;
  readonly runs: RunService;
  readonly runId: string;
  /** The lease owner the host claimed the run as. */
  readonly owner: string;
  readonly principal: HarnessPrincipal;
  readonly admission: Pick<AdmittedAgentWork, 'admissionId' | 'validUntil'>;
  readonly clock?: () => number;
  /** Longest result text handed back, in characters. */
  readonly maxResultChars?: number;
}

const MAX_RESULT = 512 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Admit outside-agent work once, before its agent starts. Throws the gate's own refusal; nothing is sent. */
export function admitOutsideAgent(
  gate: AgentGatePort,
  work: { readonly surface: AgentSurface; readonly projectId: string | null; readonly rootJobId: string },
): Promise<AdmittedAgentWork> {
  return gate.check({ phase: 'admit', surface: work.surface, projectId: work.projectId, rootJobId: work.rootJobId, routeKind: 'external-engine' });
}

export class OutsideToolHost {
  private readonly clock: () => number;
  private readonly max: number;

  constructor(private readonly options: ToolHostOptions) {
    this.clock = options.clock ?? Date.now;
    this.max = options.maxResultChars ?? MAX_RESULT;
  }

  /** The tools as the agent sees them: name, description and argument schema. No handlers, no authority. */
  tools(): OutsideTool[] {
    return this.options.registry.describe().map((tool) => {
      const { $schema: _schema, ...schema } = (tool.inputSchema ?? {}) as Record<string, Json>;
      return { name: tool.name, description: tool.description, inputSchema: { type: 'object', ...schema } };
    });
  }

  has(name: string): boolean {
    return TOOL_NAME.test(name) && this.options.registry.has(name);
  }

  /**
   * Run one call. `callId` is the agent's own id for it; the same id is the same
   * step, so a repeated call is answered from the record rather than run twice.
   */
  async call(name: string, args: unknown, callId: string): Promise<ToolAnswer> {
    const { registry, runs, runId, owner, principal, admission } = this.options;
    const until = Date.parse(admission.validUntil);
    if (!(until > this.clock())) {
      const refusal = refuseOutside('admission_expired', 'This run’s paid admission has ended, so the tool did not run.');
      return { ok: false, text: `${refusal.message} (${refusal.code})` };
    }
    if (!this.has(name)) return { ok: false, text: `There is no tool called ${JSON.stringify(String(name).slice(0, 64))}. (tool_unknown)` };
    const stepId = `oa:${createHash('sha256').update(String(callId)).digest('hex').slice(0, 32)}`;
    try {
      const result = await registry.dispatch<Json>(runs, { runId, owner, principal, stepId, name, input: (args ?? {}) as Json });
      return { ok: true, text: this.bound(JSON.stringify(result ?? null)) };
    } catch (error) {
      if (error instanceof Suspended) return { ok: false, text: 'This step waits for a person to approve it. Nothing was done yet. (approval_required)' };
      if (error instanceof HarnessError) return { ok: false, text: this.bound(`${error.message} (${error.code})`) };
      return { ok: false, text: 'The tool failed. Nothing more is known about why. (tool_failed)' };
    }
  }

  private bound(text: string): string {
    return text.length <= this.max ? text : `${text.slice(0, this.max)}\n[cut at ${this.max} characters]`;
  }
}
