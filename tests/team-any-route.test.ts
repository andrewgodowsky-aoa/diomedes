/**
 * Team work on any route that can carry the team tools (owner request
 * 2026-09-23): Claude Code over its MCP configuration, the model-API routes
 * through host-run tools in the NativeAgent loop, "Nectovia chooses" from the
 * WorkStyle resolver, and an honest refusal where a route cannot carry them.
 * Fakes only: a scripted Claude Code process, a fake generator and a captured
 * network under the AI SDK. Nothing reaches a provider or spends money, and
 * none of this proves a live provider accepts these requests.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { NativeGenerator } from '../server/native-work';
import { EngineService } from '../server/engines/service';
import { AzureConnections } from '../server/engines/azure-openai';
import { OpenRouterConnections } from '../server/engines/openrouter';
import { AWS_LUNA_MODEL } from '../server/engines/aws-bedrock';
import { testOnlySecretBox } from '../server/connection-secrets';
import { FileModelTranscripts } from '../server/harness/model-transcripts';
import { teamWorkRunId } from '../server/harness/model-session-run';
import {
  ClaudeAdapter,
  claudeArguments,
  claudeTeamTools,
  CLAUDE_TEAM_MAX_TURNS,
} from '../server/engines/claude';
import type { TextRequest } from '../server/engines/contract';
import { openProcess, type ProcessFactory } from '../server/engines/process';
import type { Store } from '../server/store';
import type { ProjectState, TeamMember } from '../shared/types';
import type { EngineModel } from '../shared/types';
import {
  resolveTeamMemberModel,
  teamRouteRefusal,
  TEAM_TOOL_NAMES,
  type TeamRouteCandidate,
} from '../shared/team-routes';
import { chatEvents, sseResponse } from './fixtures/model-api-streams.js';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = (slug: string, name = slug): EngineModel => ({
  slug,
  name,
  description: '',
  efforts: [],
  defaultEffort: null,
});

describe('"Nectovia chooses" resolves each member from the WorkStyle resolver', () => {
  const codex: TeamRouteCandidate = {
    route: 'codex',
    models: [model('gpt-6-luna', 'Luna'), model('gpt-5.6-sol', 'Sol'), model('gpt-6-astra', 'Astra')],
    savedModel: null,
    routeDefaultAllowed: true,
  };
  const claude: TeamRouteCandidate = {
    route: 'claude-code',
    models: [model('opus', 'Opus 5.5')],
    savedModel: null,
    routeDefaultAllowed: false,
  };

  test('the lead resolves one tier above the members', () => {
    const member = resolveTeamMemberModel({ role: 'member', style: 'efficient', candidates: [codex] });
    const lead = resolveTeamMemberModel({ role: 'lead', style: 'efficient', candidates: [codex] });
    expect(member).toMatchObject({ outcome: 'run', route: 'codex', model: 'gpt-6-luna' });
    expect(lead).toMatchObject({ outcome: 'run', route: 'codex', model: 'gpt-5.6-sol' });
    if (lead.outcome !== 'run') throw new Error('expected a run');
    expect(lead.selection).toMatchObject({ by: 'nectovia', style: 'focused', substituted: false });
  });

  test('a route offering the preferred model beats an earlier route that only has a substitute', () => {
    // Thorough prefers Opus 5.5; ChatGPT only has Astra, a qualified substitute.
    const resolved = resolveTeamMemberModel({ role: 'member', style: 'thorough', candidates: [codex, claude] });
    expect(resolved).toMatchObject({ outcome: 'run', route: 'claude-code', model: 'opus' });
  });

  test('nothing qualified is a question, never a quiet downgrade; no candidates says what to connect', () => {
    const lonely: TeamRouteCandidate = { ...claude, models: [model('haiku', 'Haiku')] };
    const asked = resolveTeamMemberModel({ role: 'member', style: 'focused', candidates: [lonely] });
    expect(asked.outcome).toBe('ask');
    const none = resolveTeamMemberModel({ role: 'member', style: 'focused', candidates: [] });
    expect(none).toMatchObject({ outcome: 'ask' });
    if (none.outcome === 'ask') expect(none.reason).toMatch(/Turn on and connect ChatGPT, Claude Code/);
  });

  test('a route that cannot carry the team tools is named', () => {
    expect(teamRouteRefusal('cursor')).toBe(
      'Cursor cannot carry the Diomedes team tools yet: Diomedes does not give its sessions the team service. Choose ChatGPT, Claude Code, AWS Bedrock, Azure OpenAI or OpenRouter.',
    );
    for (const route of ['codex', 'claude-code', 'aws-bedrock', 'azure-openai', 'openrouter'])
      expect(teamRouteRefusal(route)).toBeNull();
  });
});

// --- Claude Code carries the team tools over its own MCP configuration --------

const claudeRoots: string[] = [];
afterEach(async () => {
  for (const root of claudeRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const TOKEN_ENV = 'DIOMEDES_TEAM_SLOTTEST';
const TOKEN = 'synthetic-team-token-0123456789abcdef';
const team = {
  url: 'http://127.0.0.1:4321/mcp/team/p1',
  tokenEnv: TOKEN_ENV,
  slotId: 'S-test',
  role: 'member' as const,
  roleInstructions: 'Report progress to the lead through team_send_message.',
};
const claudeRequest: TextRequest = {
  projectId: 'p1',
  threadId: 't1',
  requestId: 'r1',
  model: 'claude-test',
  accountRoute: 'claude-code:claude.ai',
  instructions: 'Return strict JSON.',
  prompt: 'Coordinate the plan.',
  documents: [],
};

async function claudeFixture(options: {
  calls: string[];
  mcpStatus?: string;
  tools?: string[];
}) {
  const engine = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude team '));
  claudeRoots.push(engine);
  const file = path.join(engine, 'fixture.mjs');
  const script = {
    tools: options.tools ?? claudeTeamTools(),
    status: options.mcpStatus ?? 'connected',
    calls: options.calls,
  };
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
const s=${JSON.stringify(script)};
const emit=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request') return emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
 if(m.type!=='user') return;
 emit({type:'system',subtype:'init',session_id:'native1',model:'claude-test',tools:s.tools,mcp_servers:[{name:'diomedes_team',status:s.status}],cwd:process.cwd()});
 s.calls.forEach((name,i)=>{
  emit({type:'assistant',parent_tool_use_id:null,message:{model:'claude-test',content:[{type:'tool_use',id:'toolu_'+i,name,input:{}}]}});
  emit({type:'user',parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_'+i,content:'ok',is_error:false}]}});
 });
 emit({type:'result',uuid:'result-1',subtype:'success',result:'{"summary":"Plan","changes":[]}',session_id:'native1',modelUsage:{'claude-test':{}}});
});`,
  );
  const launches: { args: string[]; env: NodeJS.ProcessEnv; mcpConfig: string; instructions: string }[] = [];
  const launch: ProcessFactory = (spawn) => {
    const at = (flag: string) => spawn.args[spawn.args.indexOf(flag) + 1];
    launches.push({
      args: spawn.args,
      env: spawn.env,
      // The request files exist only while the process runs; read them at launch.
      mcpConfig: fsSync.readFileSync(at('--mcp-config'), 'utf8'),
      instructions: fsSync.readFileSync(at('--system-prompt-file'), 'utf8'),
    });
    return openProcess({ ...spawn, file: process.execPath, args: [file], timeoutMs: 2500 });
  };
  const adapter = new ClaudeAdapter('claude.exe', engine, {
    launch,
    account: async () => ({ loggedIn: true, authMethod: 'claude.ai', accountId: 'a1' }),
  });
  return { adapter, launches };
}

describe('Claude Code team turns', () => {
  beforeEach(() => vi.stubEnv(TOKEN_ENV, TOKEN));
  afterEach(() => vi.unstubAllEnvs());

  test('the team service is the only MCP server and the only allowed tools; the token stays a variable', async () => {
    const args = claudeArguments(false, undefined, team);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(claudeTeamTools().join(','));
    expect(claudeTeamTools()).toHaveLength(TEAM_TOOL_NAMES.length);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--max-turns') + 1]).toBe(String(CLAUDE_TEAM_MAX_TURNS));
    expect(args).not.toContain('--restricted');
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({
      mcpServers: {
        diomedes_team: {
          type: 'http',
          url: team.url,
          headers: { Authorization: 'Bearer ${DIOMEDES_TEAM_SLOTTEST}', 'X-Slot-Id': 'S-test' },
        },
      },
    });
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(() => claudeArguments(true, undefined, team)).toThrow(/single Work turn/);
  });

  test('a team turn runs, narrates each team call and leases the token only into the process environment', async () => {
    const fake = await claudeFixture({ calls: ['mcp__diomedes_team__team_read_messages', 'mcp__diomedes_team__team_send_message'] });
    const calls: string[] = [];
    const result = await fake.adapter.generate({
      ...claudeRequest,
      team: { ...team, onToolCall: (tool) => calls.push(tool) },
    });
    expect(result.text).toBe('{"summary":"Plan","changes":[]}');
    expect(calls).toEqual(['team_read_messages', 'team_send_message']);
    const [launched] = fake.launches;
    expect(launched.env[TOKEN_ENV]).toBe(TOKEN);
    expect(launched.mcpConfig).toContain('${DIOMEDES_TEAM_SLOTTEST}');
    expect(launched.mcpConfig).not.toContain(TOKEN);
    expect(launched.instructions).toContain(team.roleInstructions);
  });

  test('a built-in tool on a team turn stops the request', async () => {
    const fake = await claudeFixture({ calls: ['Read'] });
    await expect(fake.adapter.generate({ ...claudeRequest, team })).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
    });
  });

  test('a team service that did not connect stops the request instead of answering without it', async () => {
    const fake = await claudeFixture({ calls: [], mcpStatus: 'failed' });
    await expect(fake.adapter.generate({ ...claudeRequest, team })).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
    });
  });

  test('without a leased token the turn never starts', async () => {
    vi.stubEnv(TOKEN_ENV, '');
    const fake = await claudeFixture({ calls: [] });
    await expect(fake.adapter.generate({ ...claudeRequest, team })).rejects.toMatchObject({
      code: 'POLICY_MISMATCH',
    });
    expect(fake.launches).toHaveLength(0);
  });
});

// --- The app: members on any route, Nectovia chooses, refusals ----------------

const OR_KEY = 'sk-or-test-only-0123456789abcdef-never-real';
const OR_MODEL = 'anthropic/claude-sonnet-4.5';
const AWS_KEY = 'test-only-bedrock-key-0123456789abcdef-never-real';
const rates = {
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15,
  cacheReadUsdPerMillion: null,
  cacheWriteUsdPerMillion: null,
  source: 'the provider price page, read by the test owner',
};
const PROPOSAL = JSON.stringify({
  summary: 'Add the lunch plan',
  changes: [{ path: 'plan.md', text: '# Lunch plan\n\nSoup first.\n', summary: 'A new plan' }],
});

type Item = Record<string, unknown>;
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let projectId: string;
let seen: { url: string; body: Item }[];
let generator: ReturnType<typeof vi.fn> | undefined;
let engines: EngineService;

/** OpenRouter under the SDK: a team tool call first, then the proposal once the result is back. */
const network = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body)) as Item;
  seen.push({ url, body });
  if (!url.startsWith('https://openrouter.ai/'))
    throw new Error(`A request reached a provider this test never expects: ${url}`);
  const messages = (body.messages ?? []) as Item[];
  const toolResult = messages.find((message) => message.role === 'tool');
  if (body.tools && !toolResult)
    return sseResponse(
      chatEvents({
        model: OR_MODEL,
        provider: 'Anthropic',
        toolCalls: [
          {
            id: 'call_team_1',
            name: 'team_send_message',
            arguments: JSON.stringify({ to: 'owner', message: 'Starting the lunch plan.' }),
          },
        ],
        usage: { prompt_tokens: 600, completion_tokens: 30, total_tokens: 630, is_byok: false },
      }),
    );
  return sseResponse(
    chatEvents({
      model: OR_MODEL,
      provider: 'Anthropic',
      text: PROPOSAL,
      usage: { prompt_tokens: 700, completion_tokens: 40, total_tokens: 740, is_byok: false },
    }),
  );
}) as typeof globalThis.fetch;

async function request(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const store = () => app.locals.store as Store;
const state = async (): Promise<ProjectState> => (await request(`/projects/${projectId}/state`)).data;
async function until(predicate: (value: ProjectState) => boolean, what: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await state();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
async function approve(needId: string) {
  const need = (await state()).needs.find((item) => item.id === needId)!;
  return request(`/projects/${projectId}/needs/${needId}/resolve`, 'POST', {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    resolution: 'go-ahead',
    allowForTask: false,
    proposalDigest: need.approval!.proposalDigest,
    actionDigest: need.approval!.actionDigest,
    baseDigest: need.approval!.baseDigest,
  });
}
const connectOpenRouter = async () => {
  const put = await request('/ai/model-api/openrouter', 'PUT', {
    models: [{ id: OR_MODEL, upstreams: ['anthropic'], rates }],
    apiKey: OR_KEY,
    expiresAt: null,
    consent: true,
  });
  expect(put.status).toBe(200);
  expect((await request('/ai/model-api/openrouter/spend-limit', 'PUT', { capUsd: 1, consent: true })).status).toBe(200);
};
const connectAws = async () => {
  const put = await request('/ai/model-api/aws-bedrock', 'PUT', {
    accountId: '123456789012',
    region: 'us-east-1',
    model: AWS_LUNA_MODEL,
    apiKey: AWS_KEY,
    expiresAt: null,
    consent: true,
  });
  expect(put.status).toBe(200);
};

async function open(options: { generator?: NativeGenerator } = {}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-team-any-route-'));
  seen = [];
  const service = new EngineService(path.join(root, 'engines'), { discover: async () => [] });
  engines = service;
  const dataDir = path.join(root, 'data');
  app = await createApp({
    dataDir,
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    modelApiTransport: network,
    ...(options.generator ? { nativeGenerator: options.generator } : {}),
  });
  service.modelApi!.azure = {
    connections: new AzureConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-azure-openai'), 'azure-openai'),
  };
  service.modelApi!.openrouter = {
    connections: new OpenRouterConnections(dataDir),
    transcripts: new FileModelTranscripts(path.join(dataDir, 'model-transcripts-openrouter'), 'openrouter'),
  };
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  projectId = (await request('/projects', 'POST', { name: 'Lunch service' })).data.id;
}
afterEach(async () => {
  if (!server) return;
  const closingApp = app, closingServer = server, closingRoot = root;
  server = undefined;
  generator = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(closingRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a model-API team member runs its team tools on the host', () => {
  test('an OpenRouter member wakes, calls a team tool through a RunService step, and its proposal waits for exact approval', async () => {
    await open();
    await connectOpenRouter();
    const created = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Pip',
      role: 'member',
      engine: 'openrouter',
      model: OR_MODEL,
    });
    expect(created.status).toBe(200);
    const member = created.data.member as TeamMember;
    expect(member).toMatchObject({
      engine: 'openrouter',
      model: OR_MODEL,
      selection: { by: 'person', style: null },
    });
    const thread = (await state()).conversations.find((item) => item.id === member.threadId)!;
    expect(thread).toMatchObject({ engine: 'openrouter', requested: { model: OR_MODEL } });

    expect((await request(`/projects/${projectId}/team/messages`, 'POST', { to: member.slotId, content: 'Draft the lunch plan.' })).status).toBe(200);
    const woke = await request(`/projects/${projectId}/team/members/${member.slotId}/wake`, 'POST', {});
    expect(woke.status, JSON.stringify(woke.data)).toBe(200);

    const ready = await until((value) => value.needs.some((need) => need.state === 'open'), 'the proposal');
    const session = ready.sessions.find((item) => item.id === woke.data.sessionId)!;
    expect(session.route).toBe('openrouter');
    expect(session.slotId).toBe(member.slotId);
    // The provider's own report, never the requested model standing in.
    expect(session.engine).toMatchObject({ model: OR_MODEL, verified: true });
    expect(session.log.map((line) => line.sentence)).toContain('Diomedes team tool: team_send_message.');
    expect(session.log.some((line) => /offered the Diomedes team tools only/.test(line.sentence))).toBe(true);
    // The team tool really ran as this member: the owner has its message.
    expect(ready.team?.messages.some((m) => m.from === member.slotId && m.to === 'owner' && m.content === 'Starting the lunch plan.')).toBe(true);
    // Two provider exchanges, both offered exactly the team tools, each on its own spend hold.
    expect(seen).toHaveLength(2);
    const offered = ((seen[0].body.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);
    expect(offered.sort()).toEqual([...TEAM_TOOL_NAMES].sort());
    expect(engines.modelApi!.exposure.list('openrouter-1').map((hold) => hold.state)).toEqual(['settled', 'settled']);
    // The member's own run records both model steps and the team tool step between them.
    const harnessRun = await app.locals.harness.runs.get(teamWorkRunId(projectId, session.id));
    expect(harnessRun.capabilityId).toBe('model-api-team-work');
    expect(harnessRun.state).toBe('completed');
    expect(
      harnessRun.steps
        .map((step: { intent: { kind: string; name: string } }) => [step.intent.kind, step.intent.name])
        .filter(([kind]: string[]) => kind !== 'transform'),
    ).toEqual([
      ['model', 'openrouter'],
      ['tool', 'team_send_message'],
      ['model', 'openrouter'],
    ]);
    const need = ready.needs.find((item) => item.state === 'open')!;
    expect(need.files).toEqual(['plan.md']);
    // Nothing is written before the person's exact approval.
    const folder = store().state(projectId).project.folder;
    await expect(fs.stat(path.join(folder, 'plan.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    const approved = await approve(need.id);
    expect(approved.status, JSON.stringify(approved.data)).toBe(200);
    expect(await fs.readFile(path.join(folder, 'plan.md'), 'utf8')).toBe('# Lunch plan\n\nSoup first.\n');
    const settled = await until(
      (value) => value.team?.runs.some((run) => run.sessionId === session.id && run.status === 'completed') ?? false,
      'the team run to complete',
    );
    expect(settled.team?.members.find((m) => m.slotId === member.slotId)?.status).toBe('idle');
    expect(teamWorkRunId(projectId, session.id)).toMatch(/^model-work-/);
  });

  test('Build on a model-API route without a team goes through the same guarded proposal and exact approval', async () => {
    await open();
    await connectOpenRouter();
    const taskId = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Plan lunch', description: 'Write the plan' })).data.id;
    const started = await request(`/projects/${projectId}/work/start`, 'POST', {
      taskId,
      route: 'openrouter',
      consent: true,
      sources: [],
    });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    const ready = await until((value) => value.needs.some((need) => need.state === 'open'), 'the proposal');
    // No team: one exchange, no tools offered.
    expect(seen).toHaveLength(1);
    expect(seen[0].body.tools).toBeUndefined();
    const need = ready.needs.find((item) => item.state === 'open')!;
    const folder = store().state(projectId).project.folder;
    await expect(fs.stat(path.join(folder, 'plan.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await approve(need.id)).status).toBe(200);
    expect(await fs.readFile(path.join(folder, 'plan.md'), 'utf8')).toBe('# Lunch plan\n\nSoup first.\n');
  });
});

describe('Nectovia chooses a member’s route and model from the owner’s tier map', () => {
  test('a member runs on its tier’s mapped route and model; the lead’s tier, one above, is refused by name', async () => {
    await open();
    await connectOpenRouter();
    await connectAws();
    const routes = await request(`/projects/${projectId}/team/routes`);
    expect(routes.status).toBe(200);
    const ready = (routes.data.routes as { route: string; ready: boolean }[]).filter((item) => item.ready).map((item) => item.route);
    expect(ready.sort()).toEqual(['aws-bedrock', 'openrouter']);

    // Efficient is GPT-5.6 Luna on AWS Bedrock by the owner's default map. OpenRouter is
    // connected too, and is not chosen: the map decides, not whichever route is ready.
    const member = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Pip',
      role: 'member',
      engine: 'auto',
      style: 'efficient',
    });
    expect(member.status, JSON.stringify(member.data)).toBe(200);
    expect(member.data.member).toMatchObject({
      engine: 'aws-bedrock',
      model: AWS_LUNA_MODEL,
      selection: { by: 'nectovia', style: 'efficient', substituted: false },
    });
    expect(member.data.member.selection.reason).toBe(`Efficient: ${AWS_LUNA_MODEL} on AWS Bedrock.`);

    // The lead works one tier up: Focused, Gemini 3.8 Flash on Google Vertex AI, which is not
    // connected. It is refused by name rather than moved to AWS or OpenRouter.
    const lead = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Lead',
      role: 'lead',
      engine: 'auto',
      style: 'efficient',
    });
    expect(lead.status).toBe(409);
    expect(lead.data.error).toMatch(/^Focused runs on Google Vertex AI .*Connect Google Vertex AI in AI setup/);
    expect((await state()).team?.members).toHaveLength(1);

    // The owner maps Focused to the OpenRouter model: now the lead runs there.
    const settings = await request('/settings');
    await request('/settings', 'PUT', {
      services: { ...settings.data.services, focusedRoute: 'openrouter', focusedModel: OR_MODEL },
    });
    const mapped = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Lead',
      role: 'lead',
      engine: 'auto',
      style: 'efficient',
    });
    expect(mapped.status, JSON.stringify(mapped.data)).toBe(200);
    expect(mapped.data.member).toMatchObject({ engine: 'openrouter', model: OR_MODEL, selection: { style: 'focused' } });
  });

  test('with nothing connected, Nectovia names the tier’s route to connect', async () => {
    await open();
    const refused = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Pip',
      role: 'member',
      engine: 'auto',
    });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/Connect (AWS Bedrock|Google Vertex AI) in AI setup/);
  });
});

describe('a route that cannot carry the team tools is refused by name', () => {
  test('creating a Cursor member, or waking a member saved on OpenCode, names the route', async () => {
    await open();
    const cursor = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Pip',
      role: 'member',
      engine: 'cursor',
    });
    expect(cursor.status).toBe(409);
    expect(cursor.data.error).toMatch(/^Cursor cannot carry the Diomedes team tools yet/);
    expect((await request(`/projects/${projectId}/team/members`, 'POST', { name: 'X', role: 'member', engine: 'nonsense' })).data.error).toBe('Choose a valid engine.');

    // A member saved before 2026-09-23 on OpenCode: refused by name, never run on another route.
    const saved = await request(`/projects/${projectId}/team/members`, 'POST', { name: 'Old', role: 'member', engine: 'codex' });
    await store().locked(async () => {
      const current = store().state(projectId);
      current.team!.members[0].engine = 'opencode';
      await store().persist(current);
    });
    await request(`/projects/${projectId}/team/messages`, 'POST', { to: saved.data.member.slotId, content: 'Hello' });
    const woke = await request(`/projects/${projectId}/team/members/${saved.data.member.slotId}/wake`, 'POST', {});
    expect(woke.status).toBe(409);
    expect(woke.data.error).toMatch(/^OpenCode cannot carry the Diomedes team tools yet/);
    expect((await state()).sessions).toHaveLength(0);
  });
});

describe('a Claude Code member runs through Native Work with its token leased for the run', () => {
  test('the generator receives the member’s team options on the member’s route and the proposal waits for approval', async () => {
    let observed: { team?: unknown; engine?: string; token?: string } = {};
    generator = vi.fn(async (input: Parameters<NativeGenerator>[0]) => {
      const tokenEnv = (input.team as { tokenEnv: string } | undefined)?.tokenEnv;
      observed = { team: input.team, engine: input.engine, token: tokenEnv ? process.env[tokenEnv] : undefined };
      input.onTeamToolCall?.('team_task_list');
      return { text: PROPOSAL, model: 'claude-test' };
    });
    await open({ generator: generator as unknown as NativeGenerator });
    await request('/settings', 'PUT', {
      services: { 'claude-code': true, 'claude-codeAccountRoute': 'claude-code:claude.ai' },
    });
    const created = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Opal',
      role: 'lead',
      engine: 'claude-code',
      model: 'claude-test',
    });
    expect(created.status).toBe(200);
    const member = created.data.member as TeamMember;
    const tokenEnv = `DIOMEDES_TEAM_${member.slotId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
    await request(`/projects/${projectId}/team/messages`, 'POST', { to: member.slotId, content: 'Plan lunch.' });
    const woke = await request(`/projects/${projectId}/team/members/${member.slotId}/wake`, 'POST', {});
    expect(woke.status, JSON.stringify(woke.data)).toBe(200);
    const ready = await until((value) => value.needs.some((need) => need.state === 'open'), 'the proposal');
    expect(observed.engine).toBe('claude-code');
    expect(observed.team).toMatchObject({ slotId: member.slotId, role: 'lead', tokenEnv });
    expect(observed.token).toBe(created.data.token);
    const session = ready.sessions.find((item) => item.id === woke.data.sessionId)!;
    expect(session.route).toBe('claude-code');
    expect(session.log.map((line) => line.sentence)).toContain('Diomedes team tool: team_task_list.');
    expect(session.log.some((line) => /Claude Code's own file, shell and web tools stay off/.test(line.sentence))).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(created.data.token);
    const need = ready.needs.find((item) => item.state === 'open')!;
    expect((await approve(need.id)).status).toBe(200);
    // The lease ends with the run.
    expect(process.env[tokenEnv]).toBeUndefined();
  });

  test('the same member thread sent to another route runs as ordinary work with no team service', async () => {
    generator = vi.fn(async (input: Parameters<NativeGenerator>[0]) => {
      expect(input).not.toHaveProperty('team');
      return { text: PROPOSAL, model: 'gpt-test' };
    });
    await open({ generator: generator as unknown as NativeGenerator });
    await request('/settings', 'PUT', { services: { codex: true, 'claude-code': true } });
    const created = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Opal',
      role: 'member',
      engine: 'claude-code',
    });
    const taskId = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Plan', description: 'Plan lunch' })).data.id;
    const started = await request(`/projects/${projectId}/work/start`, 'POST', {
      taskId,
      threadId: created.data.member.threadId,
      route: 'codex',
      consent: true,
      sources: [],
    });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    await until((value) => value.needs.some((need) => need.state === 'open'), 'the proposal');
    expect(generator).toHaveBeenCalledOnce();
  });
});

describe('a wake runs the member as recorded', () => {
  test('after its thread ran on another route, a wake still asks for the member’s own route and model', async () => {
    const seenRuns: { engine?: string; model?: string; team: boolean }[] = [];
    generator = vi.fn(async (input: Parameters<NativeGenerator>[0]) => {
      seenRuns.push({ engine: input.engine, model: input.model, team: Boolean(input.team) });
      return { text: JSON.stringify({ summary: 'Nothing to change', changes: [] }), model: input.model ?? 'm' };
    });
    await open({ generator: generator as unknown as NativeGenerator });
    await request('/settings', 'PUT', {
      services: { codex: true, 'claude-code': true, 'claude-codeAccountRoute': 'claude-code:claude.ai' },
    });
    const created = await request(`/projects/${projectId}/team/members`, 'POST', {
      name: 'Opal',
      role: 'member',
      engine: 'claude-code',
      model: 'claude-test',
    });
    const member = created.data.member as TeamMember;
    // The person clears the pick and sends the member's thread to ChatGPT once.
    await store().locked(async () => {
      const current = store().state(projectId);
      current.conversations.find((item) => item.id === member.threadId)!.requested = null;
      await store().persist(current);
    });
    const taskId = (await request(`/projects/${projectId}/tasks`, 'POST', { name: 'Plan', description: 'Plan lunch' })).data.id;
    expect((await request(`/projects/${projectId}/work/start`, 'POST', { taskId, threadId: member.threadId, route: 'codex', consent: true, sources: [] })).status).toBe(200);
    await until((value) => value.sessions.length === 1 && value.sessions[0].state === 'done', 'the ChatGPT run');
    await request(`/projects/${projectId}/team/messages`, 'POST', { to: member.slotId, content: 'Plan lunch.' });
    const woke = await request(`/projects/${projectId}/team/members/${member.slotId}/wake`, 'POST', {});
    expect(woke.status, JSON.stringify(woke.data)).toBe(200);
    await until((value) => value.sessions.length === 2 && value.sessions[1].state === 'done', 'the wake');
    expect(seenRuns[0]).toMatchObject({ engine: 'codex', team: false });
    expect(seenRuns[1]).toEqual({ engine: 'claude-code', model: 'claude-test', team: true });
  });
});

describe('capability commands keep the route their driver needs', () => {
  test('codex-report is refused on another route with a message that names why', async () => {
    const { parseWorkCommand } = await import('../server/work-admission');
    expect(() =>
      parseWorkCommand({
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        taskId: 'T1',
        route: 'openrouter',
        capabilityId: 'codex-report',
        sources: [],
      }),
    ).toThrow('The codex-report capability runs only on ChatGPT (Codex). Choose that route for it, or start ordinary Work on this route.');
  });
});

describe('the add-member form offers connected routes and "Nectovia chooses"', () => {
  test('only ready routes are offered beside "Nectovia chooses", with the styles to choose from', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { AddMember } = await import('../client/console/TeamView');
    const html = renderToStaticMarkup(
      createElement(AddMember, {
        routes: {
          routes: [
            { route: 'codex', name: 'ChatGPT', ready: false, models: [], savedModel: null, reason: 'Turn ChatGPT on.' },
            { route: 'claude-code', name: 'Claude Code', ready: true, models: [{ slug: 'opus', name: 'Opus 5.5' }], savedModel: null },
            { route: 'openrouter', name: 'OpenRouter', ready: true, models: [], savedModel: OR_MODEL },
          ],
          styles: [
            { style: 'efficient', label: 'Efficient' },
            { style: 'focused', label: 'Focused' },
            { style: 'thorough', label: 'Thorough' },
          ],
        },
        firstIsLead: true,
        busy: false,
        onAdd: async () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(html).toContain('<option value="auto" selected="">Nectovia chooses</option>');
    expect(html).toContain('>Claude Code</option>');
    expect(html).toContain('>OpenRouter</option>');
    expect(html).not.toContain('>ChatGPT</option>');
    expect(html).toContain('>Thorough</option>');
    expect(html).toContain('a leader works one step above it');
  });
});
