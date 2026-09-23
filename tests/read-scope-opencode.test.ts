import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import {
  configContent,
  OpenCodeAdapter,
  OPENCODE_ACCOUNT_ROUTE,
} from '../server/engines/opencode.js';
import type { TextRequest } from '../server/engines/contract.js';
import type { ReadScope } from '../server/engines/read-scope.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const request: TextRequest = {
  projectId: 'p1',
  threadId: 't1',
  requestId: 'r1',
  model: 'opencode-go/go-model',
  accountRoute: OPENCODE_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt: 'When does Harbor Street open?',
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
 * A loopback stand-in for `opencode serve` 1.18.4: it records what Diomedes
 * sent (headers, session body, prompt) and plays tool parts in the shape the
 * real server emits — pending with empty input, running, then completed.
 */
async function fixture(tools: (project: string) => { tool: string; input: unknown }[]) {
  const engine = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode engine '));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode project '));
  roots.push(engine, project);
  const log = path.join(engine, 'seen.jsonl');
  const file = path.join(engine, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import http from 'node:http';
import fs from 'node:fs';
const tools=${JSON.stringify(tools(project))};
const log=(x)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
let stream;
const send=(v)=>stream.write('data: '+JSON.stringify(v)+'\\n\\n');
const part=(i,status,input,extra={})=>send({type:'message.part.updated',properties:{part:{id:'p'+i,sessionID:'session-1',messageID:'assistant-1',type:'tool',callID:'call-'+i,tool:tools[i].tool,state:{status,input,...extra}}}});
http.createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;
 log({url:req.url,method:req.method,directory:req.headers['x-opencode-directory'],body});
 if(req.url==='/provider'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({connected:['opencode-go'],all:[{id:'opencode-go',models:{'go-model':{id:'go-model',name:'Go'}}}]}));}
 if(req.url==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});stream=res;return send({type:'server.connected',properties:{}});}
 if(req.url==='/session'&&req.method==='POST'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({id:'session-1'}));}
 if(req.url==='/session/session-1/prompt_async'){res.writeHead(204);res.end();setTimeout(()=>{
  send({type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:'opencode-go',modelID:'go-model',time:{created:1}}}});
  tools.forEach((t,i)=>{part(i,'pending',{});part(i,'running',t.input);part(i,'completed',t.input,{output:'ok '+i});});
  send({type:'message.part.updated',properties:{part:{id:'text-1',sessionID:'session-1',messageID:'assistant-1',type:'text',text:''}}});
  send({type:'message.part.delta',properties:{sessionID:'session-1',messageID:'assistant-1',partID:'text-1',field:'text',delta:'Opens at 11.'}});
  send({type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:'opencode-go',modelID:'go-model',time:{created:1,completed:2},finish:'stop'}}});
  send({type:'session.status',properties:{sessionID:'session-1',status:{type:'idle'}}});
 },5);return;}
 res.writeHead(200);res.end('true');
}).listen(Number(process.argv[2]),'127.0.0.1');`,
  );
  const launches: { env: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const launch = (_command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    launches.push({ env: options?.env ?? {}, cwd: options?.cwd?.toString() });
    return spawn(process.execPath, [file, args[args.indexOf('--port') + 1]], options) as ChildProcessWithoutNullStreams;
  };
  const adapter = new OpenCodeAdapter('opencode', engine, {
    spawn: launch,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
  });
  const seen = async () =>
    (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { url: string; directory: string; body: string });
  return { adapter, launches, project, engine, seen };
}
const scopeFor = (root: string, extra: Partial<ReadScope> = {}): ReadScope => ({
  root,
  web: true,
  ...extra,
});

describe('OpenCode read scope configuration', () => {
  it('keeps the text-only configuration without a scope', () => {
    const config = JSON.parse(configContent());
    expect(config.tools).toEqual({ '*': false });
    expect(config.permission).toEqual({ '*': 'deny' });
    expect(config.agent.diomedes.steps).toBe(1);
    expect(config.mcp).toEqual({});
  });
  it('turns on only web and approved MCP read tools, and denies file reads, edits and shell', () => {
    const config = JSON.parse(configContent({ root: 'C:\\p', web: true, mcp: [pos] }));
    expect(config.tools).toEqual({
      '*': false,
      webfetch: true,
      websearch: true,
      pos_list_orders: true,
    });
    expect(config.permission['*']).toBe('deny');
    expect(config.permission.read).toBeUndefined();
    expect(config.agent.diomedes.permission).toMatchObject({
      edit: 'deny',
      bash: 'deny',
      task: 'deny',
      external_directory: 'deny',
    });
    expect(config.agent.diomedes.permission.read).toBeUndefined();
    expect(config.agent.diomedes.steps).toBeGreaterThan(1);
    expect(config.mcp.pos).toEqual({
      type: 'local',
      command: ['pos-mcp.exe', '--read'],
      environment: { POS_TOKEN: '{env:POS_TOKEN}' },
      enabled: true,
    });
  });
  it('leaves the web tools off without web access', () => {
    const config = JSON.parse(configContent({ root: 'C:\\p', web: false }));
    expect(config.tools.webfetch).toBeUndefined();
    expect(config.tools.websearch).toBeUndefined();
    expect(config.agent.diomedes.permission.webfetch).toBe('deny');
  });
});

describe('OpenCode read turns', () => {
  it('works in its own folder and streams web activity once per call', async () => {
    const { adapter, project, seen, engine } = await fixture(() => [
      { tool: 'websearch', input: { query: 'Harbor Street hours' } },
    ]);
    const activity: RawToolActivity[] = [];
    const result = await adapter.generate({
      ...request,
      readScope: scopeFor(project),
      onToolActivity: (raw) => activity.push(raw),
    });
    expect(result.text).toBe('Opens at 11.');
    const requests = await seen();
    // A project's own OpenCode configuration is never loaded into a Diomedes turn.
    expect(requests.every((entry) => entry.directory !== project)).toBe(true);
    const session = JSON.parse(requests.find((entry) => entry.url === '/session')!.body);
    expect(session.permission[0]).toEqual({ permission: '*', pattern: '*', action: 'deny' });
    expect(session.permission.at(-1)).toEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'deny',
    });
    expect(session.permission.map((rule: { permission: string }) => rule.permission)).not.toContain(
      'bash',
    );
    expect(activity.map((a) => [a.phase, a.summary])).toEqual([
      ['started', 'Searching the web for Harbor Street hours'],
      ['finished', 'websearch finished'],
    ]);
    // Nothing was written into the project folder.
    expect(await fs.readdir(project)).toEqual([]);
    expect(engine).not.toBe(project);
  });
  it.each([
    ['bash', { command: 'rm -rf .' }],
    ['edit', { filePath: 'menu.md', oldString: 'a', newString: 'b' }],
    ['write', { filePath: 'menu.md', content: 'x' }],
    ['task', { prompt: 'go' }],
    ['read', { filePath: 'menu.md' }],
    ['grep', { pattern: 'pay' }],
  ])('stops the request when the model calls %s', async (tool, input) => {
    const { adapter, project } = await fixture(() => [{ tool, input }]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('stops a read outside the project folder', async () => {
    const { adapter, project } = await fixture(() => [
      { tool: 'read', input: { filePath: path.join(os.homedir(), 'secret.txt') } },
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('stops a web fetch without web access', async () => {
    const { adapter, project } = await fixture(() => [
      { tool: 'webfetch', input: { url: 'https://example.com' } },
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project, { web: false }) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('allows an approved MCP read tool and stops an unapproved one', async () => {
    const ok = await fixture(() => [{ tool: 'pos_list_orders', input: { day: 'today' } }]);
    const activity: RawToolActivity[] = [];
    await ok.adapter.generate({
      ...request,
      readScope: scopeFor(ok.project, { mcp: [pos] }),
      onToolActivity: (raw) => activity.push(raw),
    });
    expect(activity[0].summary).toBe('Reading from pos (list_orders)');
    const denied = await fixture(() => [{ tool: 'pos_refund_order', input: { id: 1 } }]);
    await expect(
      denied.adapter.generate({ ...request, readScope: scopeFor(denied.project, { mcp: [pos] }) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('keeps any tool part fatal on the text-only route', async () => {
    const { adapter, project, seen, engine } = await fixture((root) => [
      { tool: 'read', input: { filePath: path.join(root, 'menu.md') } },
    ]);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    expect((await seen()).every((entry) => entry.directory === engine)).toBe(true);
    expect(project).not.toBe(engine);
  });
});
