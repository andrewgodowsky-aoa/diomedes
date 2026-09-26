/**
 * H20: the all-route acceptance matrix, derived and never hand-written.
 *
 * Rows are every route contract this build advertises: the registry in
 * `server/harness/route-contract.ts` plus the five model-API contracts that
 * live beside their adapters. Columns are twelve capabilities. Each cell is
 * computed from two inputs only:
 *
 *   1. what the route's contract declares for that capability
 *      (`declaredCapabilities`, which reads the contract and the few
 *      declarations the contract points at — nothing else), and
 *   2. what the headless runner's scenarios actually observed
 *      (`ScenarioResult.checks`).
 *
 * A cell reads **proven** only when a scenario that ran here passed a check
 * that the route performs the capability. A declaration alone never proves
 * anything: with no passing check it reads **declared, not proven**, with the
 * reason the environment could not prove it. A capability the contract
 * declares `unsupported` reads **unsupported**. Anything a check contradicts —
 * a declared capability that failed, or an unsupported one that was performed
 * or not refused — reads **mismatch**, and a mismatch is a bug.
 */
import {
  ADAPTER_COMMANDS,
  adapterRouteContractSchema,
  type AdapterCommand,
  type AdapterRouteContract,
  type CommandSupport,
} from '../../shared/adapter-contract.js';

export const MATRIX_VERSION = 1 as const;

/** The columns, in the order the matrix prints them. */
export const MATRIX_CAPABILITIES = [
  'turn',
  'stream',
  'tool-proposal',
  'approval',
  'steer',
  'queue',
  'stop',
  'resume',
  'retry',
  'fork',
  'verification',
  'context-accounting',
] as const;
export type MatrixCapability = (typeof MATRIX_CAPABILITIES)[number];

export const CELL_STATES = ['proven', 'declared-not-proven', 'unsupported', 'mismatch'] as const;
export type CellState = (typeof CELL_STATES)[number];

export const CELL_LABELS: Record<CellState, string> = {
  proven: 'proven here',
  'declared-not-proven': 'declared, not proven here',
  unsupported: 'unsupported (declared)',
  mismatch: 'mismatch',
};

/**
 * The lifecycle command each control column reads. `queue` is `follow-up`
 * because the contract binds `follow-up` to the `follow-up.queue` command
 * family (`COMMAND_FAMILY`), and `stop` is `interrupt` because the column asks
 * whether the route can stop a turn that is running — the task-level stop
 * scopes are the host's on every route and prove nothing about one.
 */
export const COMMAND_OF: Partial<Record<MatrixCapability, AdapterCommand>> = {
  turn: 'start',
  steer: 'steer',
  queue: 'follow-up',
  stop: 'interrupt',
  resume: 'resume',
  retry: 'retry',
  fork: 'fork',
};

export interface CapabilityDeclaration {
  support: CommandSupport;
  /** Where the declaration was read: a contract field path. */
  source: string;
  note: string;
}

/** A contract is a session contract when it describes a kept conversation, not a Work route. */
const isKeptConversation = (contract: AdapterRouteContract) => contract.routeId.endsWith('-session');

/**
 * What a route's contract declares for each column. Seven columns are the
 * contract's own lifecycle commands. The other five are read from the fields
 * of the same descriptor that decide them:
 *
 * - `stream`: `streaming.transientPreview` — `text-delta` is a stream, `none`
 *   is not.
 * - `tool-proposal` and `approval`: `mode`. A harness-agent route proposes
 *   through registered tool steps that RunService gates (`native`); a
 *   single-turn text route, the staged worker and the Codex ask route answer in
 *   text that Diomedes' own recorded writer turns into a proposal a person
 *   approves (`host`). A kept conversation (`*-session`) is not a Work route and
 *   declares no proposal path; its approval is `native` only where the engine
 *   itself asks mid-turn — the ACP permission ask, which the contract's
 *   protocol names (`acp/1`).
 * - `verification`: H17 verifies a finished Work run's recorded outputs, so
 *   it is `host` on every Work route and unsupported on a kept conversation.
 * - `context-accounting`: H18 accounts for context only where Diomedes
 *   assembles it, which is a `harness-agent` route; an external engine builds
 *   its own context.
 */
export function declaredCapabilities(
  contract: AdapterRouteContract,
): Record<MatrixCapability, CapabilityDeclaration> {
  const fromCommand = (command: AdapterCommand): CapabilityDeclaration => ({
    support: contract.commands[command].support,
    source: `commands.${command}`,
    note: contract.commands[command].note,
  });
  const conversation = isKeptConversation(contract);
  const harness = contract.mode === 'harness-agent';
  const acp = contract.engine.protocolVersion === 'acp/1';
  const out = {} as Record<MatrixCapability, CapabilityDeclaration>;
  for (const capability of MATRIX_CAPABILITIES) {
    const command = COMMAND_OF[capability];
    if (command) {
      out[capability] = fromCommand(command);
      continue;
    }
    switch (capability) {
      case 'stream':
        out.stream =
          contract.streaming.transientPreview === 'text-delta'
            ? { support: 'native', source: 'streaming.transientPreview', note: 'Transient text-delta preview; the durable record is the final observation.' }
            : { support: 'unsupported', source: 'streaming.transientPreview', note: 'The route declares no transient preview.' };
        break;
      case 'tool-proposal':
        out['tool-proposal'] = conversation
          ? { support: 'unsupported', source: 'routeId', note: 'A kept conversation answers in text; it is not a Work route and declares no proposal path.' }
          : harness
            ? { support: 'native', source: 'mode', note: 'Registered tool steps, dispatched and gated by RunService.' }
            : { support: 'host', source: 'mode', note: 'The route answers in text; Diomedes’ recorded writer turns it into a proposal.' };
        break;
      case 'approval':
        out.approval = conversation
          ? acp
            ? { support: 'native', source: 'engine.protocolVersion', note: 'An ACP permission ask becomes a Need a person answers.' }
            : { support: 'unsupported', source: 'routeId', note: 'A kept conversation declares no approval path of its own.' }
          : harness
            ? { support: 'native', source: 'mode', note: 'RunService refuses an approval-gated tool step until an exact approval is recorded.' }
            : { support: 'host', source: 'mode', note: 'A proposal waits on a Need; only the exact approved change is written.' };
        break;
      case 'verification':
        out.verification = conversation
          ? { support: 'unsupported', source: 'routeId', note: 'H17 verifies a finished Work run; a kept conversation is not one.' }
          : { support: 'host', source: 'mode', note: 'H17 runs the task’s declared checks against the run’s recorded output bytes.' };
        break;
      case 'context-accounting':
        out['context-accounting'] = harness
          ? { support: 'host', source: 'mode', note: 'Diomedes assembles the context, so H18 records a section account of it.' }
          : { support: 'unsupported', source: 'mode', note: 'The engine builds and manages its own context; Diomedes measures none of it.' };
        break;
    }
  }
  return out;
}

// --- what the runner observed ---------------------------------------------------------

/**
 * One assertion a scenario made about one route and one capability.
 * `performs`: the route did the thing. `refuses`: the route refused it, with
 * the contract's reason, and nothing happened.
 */
export interface ScenarioCheck {
  route: string;
  capability: MatrixCapability;
  expect: 'performs' | 'refuses';
  passed: boolean;
  /** One sentence: what was observed. */
  detail: string;
}

export interface ScenarioAssertion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  /** The fixture that stood in for the provider at the transport boundary. */
  fixture: string;
  outcome: 'passed' | 'failed';
  durationMs: number;
  checks: ScenarioCheck[];
  /**
   * What the scenario asserted that is not one route's capability: an
   * invariant such as "Retry is refused while an effect is uncertain". A
   * failed assertion fails the scenario and is listed with the mismatches.
   */
  assertions: ScenarioAssertion[];
  /** Set when the scenario threw before it finished its checks. */
  error?: string;
  /** Ids and digests from the durable records the scenario read. Never a secret or a body. */
  evidence: Record<string, unknown>;
}

// --- the cells ----------------------------------------------------------------------------

export interface MatrixCell {
  state: CellState;
  declared: CapabilityDeclaration;
  /** The scenarios whose checks decided this cell. */
  scenarios: string[];
  fixtures: string[];
  /** Why the cell reads what it does, in one sentence. */
  reason: string;
}

export interface MatrixRow {
  routeId: string;
  mode: AdapterRouteContract['mode'];
  engine: AdapterRouteContract['engine'];
  authentication: AdapterRouteContract['authentication'];
  testedWith: string | null;
  cells: Record<MatrixCapability, MatrixCell>;
}

/**
 * What proving a declared capability on this route would need that this
 * environment does not have, read from the contract's authentication and
 * engine — never guessed per cell.
 */
export function provingNeeds(contract: AdapterRouteContract): string {
  switch (contract.authentication) {
    case 'native-sign-in':
      return `Needs the real ${contract.engine.id} ${contract.engine.version} binary, signed in; no fixture of it drives this capability through Core here.`;
    case 'host-credential':
      return `Needs a live ${contract.routeId} credential or a transport fixture that exercises this capability; none ran here.`;
    case 'development-fixture':
    case 'none':
      return 'No scenario in this run exercises it.';
  }
}

export function deriveCell(
  contract: AdapterRouteContract,
  capability: MatrixCapability,
  results: readonly ScenarioResult[],
  declared = declaredCapabilities(contract)[capability],
): MatrixCell {
  const relevant = results.flatMap((result) =>
    result.checks
      .filter((check) => check.route === contract.routeId && check.capability === capability)
      .map((check) => ({ result, check })),
  );
  const cell = (state: CellState, reason: string, used = relevant): MatrixCell => ({
    state,
    declared,
    scenarios: [...new Set(used.map(({ result }) => result.id))],
    fixtures: [...new Set(used.map(({ result }) => result.fixture))],
    reason,
  });
  if (declared.support === 'unsupported') {
    const contradicted = relevant.filter(
      ({ check }) => (check.expect === 'performs' && check.passed) || (check.expect === 'refuses' && !check.passed),
    );
    if (contradicted.length)
      return cell('mismatch', `Declared unsupported, yet ${contradicted[0].check.detail}`, contradicted);
    const refused = relevant.filter(({ check }) => check.expect === 'refuses' && check.passed);
    return cell(
      'unsupported',
      refused.length ? `Declared unsupported, and the refusal was observed: ${refused[0].check.detail}` : `Declared unsupported: ${declared.note}`,
      refused,
    );
  }
  const failed = relevant.filter(({ check }) => !check.passed || check.expect === 'refuses');
  if (failed.length) return cell('mismatch', `Declared ${declared.support}, but ${failed[0].check.detail}`, failed);
  const passed = relevant.filter(({ check }) => check.expect === 'performs' && check.passed);
  if (passed.length) return cell('proven', passed[0].check.detail, passed);
  return cell('declared-not-proven', `Declared ${declared.support}. ${provingNeeds(contract)}`, []);
}

export interface RouteMatrix {
  matrixVersion: typeof MATRIX_VERSION;
  generatedAt: string;
  environment: { platform: string; node: string; commit: string | null };
  capabilities: readonly MatrixCapability[];
  rows: MatrixRow[];
  scenarios: ScenarioResult[];
  /** Checks that named a route no contract advertises: evidence the runner and the registry disagree. */
  orphanChecks: ScenarioCheck[];
  counts: Record<CellState, number>;
  mismatches: { routeId: string; capability: MatrixCapability; reason: string; scenarios: string[] }[];
  /** Scenarios that threw or failed an assertion: bugs even where no cell names them. */
  failedScenarios: { id: string; error: string | null; assertions: ScenarioAssertion[] }[];
}

/**
 * Build the whole matrix. Every contract is validated first: a descriptor
 * that does not parse is not a contract, and the matrix refuses it rather than
 * printing a row nobody declared.
 */
export function deriveMatrix(input: {
  contracts: readonly AdapterRouteContract[];
  results: readonly ScenarioResult[];
  generatedAt: string;
  environment: RouteMatrix['environment'];
}): RouteMatrix {
  const seen = new Set<string>();
  for (const contract of input.contracts) {
    const parsed = adapterRouteContractSchema.safeParse(contract);
    if (!parsed.success) throw new Error(`The contract for ${JSON.stringify(contract?.routeId)} is not a valid adapter contract.`);
    if (seen.has(contract.routeId)) throw new Error(`Route ${contract.routeId} is advertised twice.`);
    seen.add(contract.routeId);
    for (const command of ADAPTER_COMMANDS) void contract.commands[command];
  }
  const rows = input.contracts.map((contract): MatrixRow => {
    const declared = declaredCapabilities(contract);
    return {
      routeId: contract.routeId,
      mode: contract.mode,
      engine: contract.engine,
      authentication: contract.authentication,
      testedWith: contract.testedWith,
      cells: Object.fromEntries(
        MATRIX_CAPABILITIES.map((capability) => [
          capability,
          deriveCell(contract, capability, input.results, declared[capability]),
        ]),
      ) as Record<MatrixCapability, MatrixCell>,
    };
  });
  const counts = Object.fromEntries(CELL_STATES.map((state) => [state, 0])) as Record<CellState, number>;
  const mismatches: RouteMatrix['mismatches'] = [];
  for (const row of rows)
    for (const capability of MATRIX_CAPABILITIES) {
      const cell = row.cells[capability];
      counts[cell.state]++;
      if (cell.state === 'mismatch')
        mismatches.push({ routeId: row.routeId, capability, reason: cell.reason, scenarios: cell.scenarios });
    }
  return {
    matrixVersion: MATRIX_VERSION,
    generatedAt: input.generatedAt,
    environment: input.environment,
    capabilities: MATRIX_CAPABILITIES,
    rows,
    scenarios: [...input.results],
    orphanChecks: input.results.flatMap((result) => result.checks.filter((check) => !seen.has(check.route))),
    counts,
    mismatches,
    failedScenarios: input.results
      .filter((result) => result.outcome === 'failed')
      .map((result) => ({
        id: result.id,
        error: result.error ?? null,
        assertions: result.assertions.filter((assertion) => !assertion.passed),
      })),
  };
}

// --- the readable summary ---------------------------------------------------------------

const SHORT: Record<CellState, string> = {
  proven: 'proven',
  'declared-not-proven': 'declared',
  unsupported: 'unsupported',
  mismatch: '**MISMATCH**',
};

const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The Markdown summary: the grid, the counts, the mismatches, then every cell's reason. */
export function renderMatrixMarkdown(matrix: RouteMatrix): string {
  const lines: string[] = [];
  lines.push(`# Route acceptance matrix — ${matrix.generatedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(
    'Generated by `npm run eval:matrix` (H20). Every cell is derived from the route contracts and the headless runner’s results; nothing below was written by hand.',
  );
  lines.push('');
  lines.push(
    `Environment: ${matrix.environment.platform}, Node ${matrix.environment.node}, commit ${matrix.environment.commit ?? 'unknown'}.`,
  );
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| State | Cells |');
  lines.push('|---|---|');
  for (const state of CELL_STATES) lines.push(`| ${CELL_LABELS[state]} | ${matrix.counts[state]} |`);
  lines.push('');
  lines.push('## Matrix');
  lines.push('');
  lines.push(`| Route | ${matrix.capabilities.join(' | ')} |`);
  lines.push(`|---|${matrix.capabilities.map(() => '---').join('|')}|`);
  for (const row of matrix.rows)
    lines.push(`| \`${row.routeId}\` | ${matrix.capabilities.map((capability) => SHORT[row.cells[capability].state]).join(' | ')} |`);
  lines.push('');
  lines.push('## Mismatches');
  lines.push('');
  if (!matrix.mismatches.length && !matrix.failedScenarios.length)
    lines.push('None. No declared capability failed a check and no scenario failed in this run.');
  for (const item of matrix.mismatches)
    lines.push(`- \`${item.routeId}\` · ${item.capability}: ${item.reason} (scenario ${item.scenarios.join(', ')})`);
  if (matrix.failedScenarios.length) {
    lines.push('');
    lines.push('Scenarios that failed:');
    for (const item of matrix.failedScenarios)
      lines.push(
        `- \`${item.id}\`: ${
          item.error ??
          (item.assertions.length
            ? item.assertions.map((assertion) => `${assertion.name} — ${assertion.detail}`).join('; ')
            : 'its failed checks are the mismatches above.')
        }`,
      );
  }
  if (matrix.orphanChecks.length) {
    lines.push('');
    lines.push('Checks naming a route no contract advertises:');
    for (const check of matrix.orphanChecks) lines.push(`- \`${check.route}\` · ${check.capability}: ${check.detail}`);
  }
  lines.push('');
  lines.push('## What the cells not proven here need');
  lines.push('');
  const needs = new Map<string, string[]>();
  for (const row of matrix.rows)
    for (const capability of matrix.capabilities)
      if (row.cells[capability].state === 'declared-not-proven') {
        const need = row.cells[capability].reason.replace(/^Declared (native|host)\. /, '');
        needs.set(need, [...(needs.get(need) ?? []), `\`${row.routeId}\` ${capability}`]);
      }
  if (!needs.size) lines.push('Every declared cell was proven in this run.');
  for (const [need, cells] of needs) lines.push(`- ${need} (${cells.length}): ${cells.join(', ')}`);
  lines.push('');
  lines.push(
    `This run was on ${matrix.environment.platform}. No route contract declares a capability as specific to one operating system, so no cell is derived as needing Windows; a platform difference would show here as a mismatch on the platform where it happens.`,
  );
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  lines.push('| Scenario | Fixture | Outcome | Checks | Assertions |');
  lines.push('|---|---|---|---|---|');
  for (const result of matrix.scenarios)
    lines.push(
      `| ${escapeCell(result.title)} (\`${result.id}\`) | ${escapeCell(result.fixture)} | ${result.outcome}${result.error ? `: ${escapeCell(result.error)}` : ''} | ${result.checks.filter((c) => c.passed).length}/${result.checks.length} | ${result.assertions.filter((a) => a.passed).length}/${result.assertions.length} |`,
    );
  lines.push('');
  for (const result of matrix.scenarios) {
    lines.push(`- \`${result.id}\``);
    for (const check of result.checks)
      lines.push(`  - ${check.passed ? 'pass' : 'FAIL'} · \`${check.route}\` ${check.capability} ${check.expect}: ${escapeCell(check.detail)}`);
    for (const assertion of result.assertions)
      lines.push(`  - ${assertion.passed ? 'pass' : 'FAIL'} · ${escapeCell(assertion.name)}: ${escapeCell(assertion.detail)}`);
  }
  lines.push('');
  lines.push('## Every cell');
  lines.push('');
  for (const row of matrix.rows) {
    lines.push(`### \`${row.routeId}\``);
    lines.push('');
    lines.push(
      `${row.mode}, engine \`${row.engine.id}\` ${row.engine.version}, authentication ${row.authentication}, tested with ${row.testedWith ?? 'nothing external'}.`,
    );
    lines.push('');
    lines.push('| Capability | State | Declared | Why |');
    lines.push('|---|---|---|---|');
    for (const capability of matrix.capabilities) {
      const cell = row.cells[capability];
      lines.push(
        `| ${capability} | ${CELL_LABELS[cell.state]} | ${cell.declared.support} (\`${cell.declared.source}\`) | ${escapeCell(cell.reason)}${cell.fixtures.length ? ` Fixture: ${escapeCell(cell.fixtures.join('; '))}.` : ''} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
