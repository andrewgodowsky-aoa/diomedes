/**
 * What each execution route can honestly promise, with the evidence for each
 * label. `enforced` means Diomedes' own code is the boundary; `observed` means
 * the engine reports it and Diomedes checks the report; `instructional` means
 * the prompt asks; `unsupported` means the route has no such thing.
 *
 * Sources: `server/integrations.ts` (Codex thread configuration, sandbox proof,
 * policy echo check), `evidence/codex-team-real-binary-2026-09-06.md` (the
 * model's own tool inventory under the team host), `server/work.ts` (sample
 * worker), `server/store.ts` (the single document writer).
 */
import type { AdapterCapabilities, Enforcement } from '../../shared/harness.js';

export const ADAPTER_CAPABILITIES = {
  'claude-code-session': {
    engineId: 'claude-code',
    engineVersion: '2.1.252',
    protocolVersion: 'stream-json',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'observed',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'observed',
    cancellability: 'observed',
    checkpointGranularity: 'step',
    notes: [
      'Explicit opt-in native session route; the default claude-code text route remains single-turn.',
      'RunService persists bounded recovery metadata before each dispatch and after a known result. Unknown outcomes refuse resume or retry.',
      'Sequential input, native interrupt, --resume and --fork-session are protocol-fixture verified for 2.1.252; no paid live acceptance is claimed.',
      'Tool restrictions remain engine-honored configuration plus fail-closed permission handling, not OS containment. Active steering is unsupported.',
      'Native transcripts stay with Claude. A portable Harness fork never inherits a provider checkpoint.',
    ],
  },
  'native-fixture': {
    engineId: 'native-fixture',
    engineVersion: '1',
    protocolVersion: 'harness-v1',
    modelCalls: 'enforced',
    toolCalls: 'enforced',
    filesystemWrites: 'enforced',
    networkEgress: 'unsupported',
    approvals: 'enforced',
    resumability: 'enforced',
    cancellability: 'enforced',
    checkpointGranularity: 'step',
    notes: [
      'Every model and tool call is a step in the Diomedes run service (server/harness/run-service.ts).',
      'The scripted provider is a test fixture, not a model. Its report write is bound to an exact Need and goes only through Store.writeRecorded; no network tool is registered.',
      'A completed step replays from its persisted observation; a run resumes at the first unresolved step.',
    ],
  },
  sample: {
    engineId: 'sample',
    engineVersion: '0.1.0',
    protocolVersion: 'in-process',
    modelCalls: 'unsupported',
    toolCalls: 'unsupported',
    filesystemWrites: 'enforced',
    networkEgress: 'unsupported',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'enforced',
    checkpointGranularity: 'task',
    notes: [
      'Deterministic staged worker (server/work.ts). No model, no tools, no network.',
      'Writes only through Store.writeRecorded after the Need is answered; a stopped run restarts from the beginning.',
    ],
  },
  codex: {
    engineId: 'codex',
    engineVersion: '0.153.4',
    protocolVersion: 'codex app-server 0.153.4',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'enforced',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      'Model calls happen inside the pinned app-server; Diomedes sees turn events and the reported model, it does not dispatch each call (server/integrations.ts askCodex).',
      "Every tool feature is switched off in the thread configuration and the model has no shell or file tool; that inventory is the model's own report, not a protocol-level proof (evidence/codex-team-real-binary-2026-09-06.md, D8).",
      'Project files cannot be written by the engine: the Windows read-only sandbox passes a write-denial probe before each run, and a proposal is applied only by Store.writeRecorded after the person says go ahead.',
      'The runtime echoes networkAccess=false in the policy check; no outbound probe has been run.',
      'There is no checkpoint inside a Codex turn. The host-only codex-report capability persists a completed outer-turn observation; unknown dispatch stays parked for reconciliation and is never automatically resent.',
      'Stopping sends an abort and ends the process; the engine reports the interruption.',
    ],
  },
  'codex-team': {
    engineId: 'codex',
    engineVersion: '0.153.4',
    protocolVersion: 'codex app-server 0.153.4 with diomedes_team MCP',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'enforced',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      "The thirteen team tools are served by Diomedes' own loopback MCP host and are mediated there (server/team/mcp.ts); the engine's other internal tools are only reported by the model.",
      "The member's bearer token is leased into one environment variable for the run and redacted from every log and proposal afterwards.",
      'Otherwise as the single Codex route.',
    ],
  },
  // The five single-turn text routes (server/engines/). One bounded prompt per
  // request over a fresh process or session; shared/engines.ts
  // TEXT_ROUTE_CONTROLS is the same evidence vocabulary for the Console.
  'claude-code': {
    engineId: 'claude-code',
    engineVersion: '2.1.252',
    protocolVersion: 'stream-json',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'observed',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      'Each generate() is one bounded prompt to a fresh `claude` process launched with the --tools restriction; a reported tool list or a tool_use frame in the stream stops the request (server/engines/claude.ts).',
      "The engine's own tool machinery is disabled by launch configuration, not by Diomedes code; that restriction is engine-honored, not a protocol proof, and no OS containment is claimed.",
      'File proposals go only through the recorded writer; a stopped request aborts and ends the owned process, which the engine reports.',
      'Every request starts a fresh native session; there is nothing to resume.',
    ],
  },
  opencode: {
    engineId: 'opencode',
    engineVersion: '1.18.4',
    protocolVersion: 'http+sse',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'observed',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      'Each request is one bounded prompt against a fresh `opencode serve --pure` session with permission denies and tool disablement in the session config (server/engines/opencode.ts).',
      'Tool denial is engine-honored configuration Diomedes writes, not a protocol proof; no OS containment is claimed.',
      'File proposals go only through the recorded writer; a stopped request aborts the request and ends the owned server process.',
      'Every request starts a fresh session; there is nothing to resume.',
    ],
  },
  'oh-my-pi': {
    engineId: 'oh-my-pi',
    engineVersion: '18.0.6',
    protocolVersion: 'stream-json',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'observed',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      'Each request is one bounded prompt to a fresh `omp` process launched with --no-tools; the flag removes the tool surface entirely (server/engines/omp.ts).',
      'Tool denial is engine-honored launch configuration, not a protocol proof; no OS containment is claimed.',
      'File proposals go only through the recorded writer; a stopped request aborts and ends the owned process.',
      'Every request starts a fresh session; there is nothing to resume.',
    ],
  },
  cursor: {
    engineId: 'cursor',
    engineVersion: '2026.08.11',
    protocolVersion: 'acp/1',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'observed',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      'Each request is one bounded session/prompt over ACP stdio to a fresh process under a fresh config dir with deny rules for Shell, Read, Write, WebFetch, WebSearch and MCP (server/engines/cursor.ts, shared transport in server/engines/acp-client.ts).',
      'Client filesystem and terminal capabilities are advertised false; a blocking client request is declined and a tool or plan update aborts the turn. Those are Diomedes-side refusals over engine-honored configuration, not a protocol proof, and no OS containment is claimed.',
      'File proposals go only through the recorded writer; a stopped request sends session/cancel and ends the owned process.',
      'Every request starts a fresh session; there is nothing to resume.',
    ],
  },
  devin: {
    engineId: 'devin',
    engineVersion: '3000.10.23',
    protocolVersion: 'acp/1',
    modelCalls: 'observed',
    toolCalls: 'observed',
    filesystemWrites: 'observed',
    networkEgress: 'observed',
    approvals: 'enforced',
    resumability: 'unsupported',
    cancellability: 'observed',
    checkpointGranularity: 'task',
    notes: [
      "Each request is one bounded session/prompt over ACP stdio to a fresh process in a fresh workspace whose .devin/config.json denies every documented tool scope including mcp__*; the session is forced to ask mode and confirmed by the agent's own echo before a prompt is sent (server/engines/devin.ts).",
      'A blocking client request is declined and a tool or plan update aborts the turn; ACP authentication is per process through the browser flow. These are Diomedes-side refusals over engine-honored configuration, not a protocol proof, and no OS containment is claimed.',
      'The session model is pinned with --model at launch; a different reported selection stops the request before any prompt is sent.',
      'File proposals go only through the recorded writer; a stopped request sends session/cancel and ends the owned process. Every request starts a fresh session; there is nothing to resume.',
    ],
  },
} as const satisfies Record<string, AdapterCapabilities>;

export type AdapterId = keyof typeof ADAPTER_CAPABILITIES;

const GUARANTEES: {
  key: keyof Pick<
    AdapterCapabilities,
    | 'modelCalls'
    | 'toolCalls'
    | 'filesystemWrites'
    | 'networkEgress'
    | 'approvals'
    | 'resumability'
    | 'cancellability'
  >;
  subject: string;
}[] = [
  { key: 'modelCalls', subject: 'Each call to the service' },
  { key: 'toolCalls', subject: 'Each tool the helper uses' },
  { key: 'filesystemWrites', subject: 'Writing project files' },
  { key: 'networkEgress', subject: 'Reaching the internet' },
  { key: 'approvals', subject: 'Waiting for your OK' },
  { key: 'resumability', subject: 'Picking up where it left off' },
  { key: 'cancellability', subject: 'Stopping when you say stop' },
];

function sentence(subject: string, label: Enforcement): string {
  switch (label) {
    case 'enforced':
      return `${subject}: Diomedes enforces this itself.`;
    case 'observed':
      return `${subject}: reported by the helper and checked by Diomedes, not enforced by it.`;
    case 'instructional':
      return `${subject}: asked for in the instructions only.`;
    case 'unsupported':
      return `${subject}: not available on this route.`;
  }
}

/** Plain sentences for the Console's engine details. The Workbook's copy rules ban technical words, so these stay on the Console. */
export function guaranteeSentences(capabilities: AdapterCapabilities): string[] {
  return GUARANTEES.map(({ key, subject }) => sentence(subject, capabilities[key]));
}

/** The weakest label across the guarantees, for a one-word summary. */
export function weakestGuarantee(capabilities: AdapterCapabilities): Enforcement {
  const order: Enforcement[] = ['unsupported', 'instructional', 'observed', 'enforced'];
  return GUARANTEES.map(({ key }) => capabilities[key]).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  )[0];
}
