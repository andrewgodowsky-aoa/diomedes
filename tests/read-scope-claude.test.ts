import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import {
  ClaudeAdapter,
  claudeArguments,
  claudeMcpConfig,
  CLAUDE_VERSION,
} from '../server/engines/claude.js';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { openProcess, type ProcessFactory } from '../server/engines/process.js';
import type { ReadScope } from '../server/engines/read-scope.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const base: TextRequest = {
  projectId: 'p1',
  threadId: 't1',
  requestId: 'r1',
  model: 'claude-test',
  accountRoute: 'claude-code:claude.ai',
  instructions: 'Answer the question.',
  prompt: 'What time does Harbor Street open?',
  documents: [],
};
const pos = {
  name: 'pos',
  command: 'pos-mcp.exe',
  args: ['--read'],
  envFrom: ['POS_TOKEN'],
  readTools: ['list_orders'],
};

/**
 * A stand-in for `claude --print` stream-json: it answers the initialize
 * control request, then plays one scripted turn. `calls` are the tool_use
 * blocks the model "makes"; each gets a matching tool_result.
 */
async function fixture(options: {
  tools?: string[];
  mcpServers?: string[];
  calls?: { name: string; input: unknown }[] | ((project: string) => { name: string; input: unknown }[]);
  usage?: string[];
  session?: boolean;
}) {
  const engine = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude engine '));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude project '));
  roots.push(engine, project);
  await fs.writeFile(path.join(project, 'menu.md'), '# Menu\nOpens at 11.');
  const file = path.join(engine, 'fixture.mjs');
  const script = {
    tools: options.tools ?? ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch'],
    mcp: options.mcpServers ?? [],
    calls: typeof options.calls === 'function' ? options.calls(project) : (options.calls ?? []),
    usage: options.usage ?? ['claude-test'],
  };
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
const s=${JSON.stringify(script)};
const emit=x=>console.log(JSON.stringify(x));
const session=process.argv[2]||'native1';
let n=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request') return emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
 if(m.type!=='user') return;
 n++;
 emit({type:'system',subtype:'init',session_id:session,model:'claude-test',tools:s.tools,mcp_servers:s.mcp.map(name=>({name,status:'connected'})),cwd:process.cwd()});
 s.calls.forEach((call,i)=>{
  emit({type:'assistant',parent_tool_use_id:null,message:{model:'claude-test',content:[{type:'tool_use',id:'toolu_'+i,name:call.name,input:call.input}]}});
  emit({type:'user',parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_'+i,content:'ok '+i,is_error:false}]}});
 });
 emit({type:'stream_event',session_id:session,event:{delta:{type:'text_delta',text:'Opens at 11.'}}});
 emit({type:'result',uuid:'result-'+n+'-'+session,subtype:'success',result:'Opens at 11.',session_id:session,modelUsage:Object.fromEntries(s.usage.map(u=>[u,{}]))});
});`,
  );
  const launches: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const launch: ProcessFactory = (spawn) => {
    launches.push({ args: spawn.args, cwd: spawn.cwd, env: spawn.env });
    const session = spawn.args.includes('--session-id')
      ? spawn.args[spawn.args.indexOf('--session-id') + 1]
      : 'native1';
    return openProcess({ ...spawn, file: process.execPath, args: [file, session], timeoutMs: 2500 });
  };
  const adapter = new ClaudeAdapter('claude.exe', engine, {
    launch,
    account: async () => ({ loggedIn: true, authMethod: 'claude.ai', accountId: 'a1' }),
  });
  return { adapter, launches, engine, project };
}
const scopeFor = (root: string, extra: Partial<ReadScope> = {}): ReadScope => ({
  root,
  web: true,
  ...extra,
});

describe('Claude Code read scope arguments', () => {
  it('keeps the text-only arguments byte-identical without a scope', () => {
    const args = claudeArguments();
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--restricted');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
  });
  it('names an explicit read allow-list, denies the rest and confines file tools', () => {
    const args = claudeArguments(false, { root: 'C:\\p', web: true, mcp: [pos] });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,LS,WebSearch,WebFetch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Grep,Glob,LS,WebSearch,WebFetch,mcp__pos__list_orders',
    );
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--restricted');
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(args.join(' ')).not.toMatch(/\b(Bash|Edit|Write|NotebookEdit|MultiEdit)\b/);
    expect(Number(args[args.indexOf('--max-turns') + 1])).toBeGreaterThan(1);
  });
  it('drops the web tools when the scope has no web access', () => {
    const args = claudeArguments(false, { root: 'C:\\p', web: false });
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,LS');
  });
  it('writes approved MCP servers with secrets by reference only', () => {
    const config = JSON.parse(claudeMcpConfig({ root: 'C:\\p', web: false, mcp: [pos] }));
    expect(config.mcpServers.pos).toEqual({
      type: 'stdio',
      command: 'pos-mcp.exe',
      args: ['--read'],
      env: { POS_TOKEN: '${POS_TOKEN}' },
    });
  });
});

describe('Claude Code read turns', () => {
  it('works in the project folder and streams activity for each read', async () => {
    const { adapter, launches, project, engine } = await fixture({
      calls: (project) => [
        { name: 'Read', input: { file_path: path.join(project, 'menu.md') } },
        { name: 'Grep', input: { pattern: 'Opens', path: project } },
        { name: 'WebSearch', input: { query: 'Harbor Street opening hours' } },
      ],
      usage: ['claude-test', 'claude-haiku-4-5-20251001'],
    });
    const activity: RawToolActivity[] = [];
    const result = await adapter.generate({
      ...base,
      readScope: scopeFor(project),
      onToolActivity: (raw) => activity.push(raw),
    });
    expect(result.text).toBe('Opens at 11.');
    expect(launches[0].cwd).toBe(project);
    // The request files are made in the engine's folder, never the project's.
    expect((await fs.readdir(project)).sort()).toEqual(['menu.md']);
    expect(await fs.readdir(engine)).toEqual(['fixture.mjs']);
    expect(activity.map((a) => [a.phase, a.summary])).toEqual([
      ['started', 'Reading menu.md'],
      ['finished', 'Read finished'],
      ['started', 'Searching project files for Opens'],
      ['finished', 'Grep finished'],
      ['started', 'Searching the web for Harbor Street opening hours'],
      ['finished', 'WebSearch finished'],
    ]);
    expect(activity[0].callId).toBe(activity[1].callId);
  });
  it.each([
    ['Bash', { command: 'echo hi > out.txt' }],
    ['Edit', { file_path: 'menu.md', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: 'menu.md', content: 'x' }],
    ['NotebookEdit', { notebook_path: 'n.ipynb' }],
  ])('stops the request when the model calls %s', async (name, input) => {
    const { adapter, project } = await fixture({ calls: [{ name, input }] });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('stops a read outside the project folder', async () => {
    const { adapter, project } = await fixture({
      calls: [{ name: 'Read', input: { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') } }],
    });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('stops an absolute glob pattern that names another folder', async () => {
    const { adapter, project } = await fixture({
      calls: [{ name: 'Glob', input: { pattern: path.join(os.homedir(), '**', '*.key') } }],
    });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('stops a web call when the scope has no web access', async () => {
    const { adapter, project } = await fixture({
      tools: ['Read', 'Grep', 'Glob', 'LS'],
      calls: [{ name: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' } }],
    });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project, { web: false }) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('refuses an init frame that reports a tool beyond the allow-list', async () => {
    const { adapter, project } = await fixture({ tools: ['Read', 'Bash'] });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('refuses a helper model when no web tool was used', async () => {
    const { adapter, project } = await fixture({
      usage: ['claude-test', 'claude-haiku-4-5-20251001'],
    });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('keeps a tool call on the text-only route fatal', async () => {
    const { adapter, project } = await fixture({
      tools: [],
      calls: (project) => [{ name: 'Read', input: { file_path: path.join(project, 'menu.md') } }],
    });
    await expect(adapter.generate(base)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
});

describe('Claude Code approved MCP read tools', () => {
  it('allows an approved read tool and forwards only its named secret', async () => {
    const previous = process.env.POS_TOKEN;
    process.env.POS_TOKEN = 'pos-secret';
    try {
      const { adapter, project, launches } = await fixture({
        tools: ['Read', 'mcp__pos__list_orders', 'mcp__pos__refund_order'],
        mcpServers: ['pos'],
        calls: [{ name: 'mcp__pos__list_orders', input: { day: 'today' } }],
      });
      const activity: RawToolActivity[] = [];
      await adapter.generate({
        ...base,
        readScope: scopeFor(project, { mcp: [pos] }),
        onToolActivity: (raw) => activity.push(raw),
      });
      expect(activity[0].summary).toBe('Reading from pos (list_orders)');
      expect(launches[0].env.POS_TOKEN).toBe('pos-secret');
      expect(launches[0].args.join(' ')).not.toContain('pos-secret');
    } finally {
      if (previous === undefined) delete process.env.POS_TOKEN;
      else process.env.POS_TOKEN = previous;
    }
  });
  it('stops a call to a tool the owner did not approve', async () => {
    const { adapter, project } = await fixture({
      tools: ['Read', 'mcp__pos__list_orders', 'mcp__pos__refund_order'],
      mcpServers: ['pos'],
      calls: [{ name: 'mcp__pos__refund_order', input: { id: 1 } }],
    });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project, { mcp: [pos] }) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('refuses an MCP server the owner did not approve', async () => {
    const { adapter, project } = await fixture({
      tools: ['Read', 'mcp__mail__send'],
      mcpServers: ['mail'],
    });
    await expect(
      adapter.generate({ ...base, readScope: scopeFor(project, { mcp: [pos] }) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
});

describe('Claude Code native session read scope', () => {
  const options = (saved: ClaudeSessionCheckpoint[]) => ({
    observedVersion: CLAUDE_VERSION,
    onCheckpoint: async (checkpoint: ClaudeSessionCheckpoint) => {
      saved.push(checkpoint);
    },
  });
  it('opens in the project folder, streams activity and pins the scope', async () => {
    const { adapter, project, launches } = await fixture({
      calls: (project) => [{ name: 'LS', input: { path: project } }],
    });
    const saved: ClaudeSessionCheckpoint[] = [];
    const scope = scopeFor(project);
    const session = await adapter.openSession({ ...base, readScope: scope }, options(saved));
    try {
      const activity: RawToolActivity[] = [];
      const result = await session.turn({
        ...base,
        readScope: scope,
        onToolActivity: (raw) => activity.push(raw),
      });
      expect(result.text).toBe('Opens at 11.');
      expect(launches[0].cwd).toBe(project);
      expect(launches[0].args).toContain('--restricted');
      expect(activity[0].summary).toBe('Listing files in the project folder');
      expect(session.checkpoint.cwd).toBe(path.resolve(project));
      // A turn that drops or changes the scope is not this session's turn.
      await expect(
        session.turn({ ...base, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
    } finally {
      await session.close();
    }
  });
  it('keeps a text-only session refusing tool calls', async () => {
    const { adapter, project } = await fixture({
      tools: [],
      calls: (project) => [{ name: 'Read', input: { file_path: path.join(project, 'menu.md') } }],
    });
    const saved: ClaudeSessionCheckpoint[] = [];
    const session = await adapter.openSession(base, options(saved));
    try {
      await expect(session.turn(base)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    } finally {
      await session.close();
    }
  });
});
