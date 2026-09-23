import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RawToolActivity } from '../shared/adapter-contract.js';
import { OmpAdapter, ompArguments } from '../server/engines/omp.js';
import { openProcess, type ProcessFactory } from '../server/engines/process.js';
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
  model: 'openai/gpt-test',
  accountRoute: 'oh-my-pi:openai',
  instructions: 'Project rule',
  prompt: 'Question',
  documents: [],
};

/**
 * oh-my-pi 18.0.6 RPC as the agent loop emits it: each tool call surfaces as
 * a toolCall message part, then tool_execution_start with its arguments, then
 * tool_execution_end, then a toolResult message.
 */
async function fixture(calls: (project: string) => { name: string; args: unknown }[]) {
  const engine = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes omp engine '));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes omp project '));
  roots.push(engine, project);
  const file = path.join(engine, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
const calls=${JSON.stringify(calls(project))};
const emit=x=>console.log(JSON.stringify(x));
const ok=(id,command,data={})=>emit({type:'response',id,command,success:true,data});
const message={role:'assistant',provider:'openai',model:'gpt-test',stopReason:'stop',content:[{type:'text',text:'Answer'}]};
emit({type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2]});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.type==='negotiate_protocol') return ok(m.id,'negotiate_protocol',{protocolVersion:2});
 if(m.type==='set_auto_retry'||m.type==='set_auto_compaction') return ok(m.id,m.type);
 if(m.type==='set_model') return ok(m.id,'set_model',{provider:m.provider,id:m.modelId});
 if(m.type==='get_state') return ok(m.id,'get_state',{model:{provider:'openai',id:'gpt-test'},sessionId:'native1'});
 if(m.type==='prompt') {
  calls.forEach((c,i)=>{
   const id='call-'+i;
   emit({type:'message_update',message:{...message,content:[{type:'toolCall',id,name:c.name,arguments:c.args}]},assistantMessageEvent:{type:'toolcall_end',toolCall:{id}}});
   emit({type:'tool_execution_start',toolCallId:id,toolName:c.name,args:c.args});
   emit({type:'tool_execution_end',toolCallId:id,toolName:c.name,result:{content:[{type:'text',text:'ok'}]},isError:false});
   emit({type:'message_end',message:{role:'toolResult',toolCallId:id,toolName:c.name,content:[{type:'text',text:'ok'}]}});
  });
  emit({type:'message_update',message,assistantMessageEvent:{type:'text_delta',delta:'Answer'}});
  emit({type:'agent_end',messages:[message],sessionId:'native1'});
  return ok(m.id,'prompt',{agentInvoked:true});
 }
 if(m.type==='get_last_assistant_text') return ok(m.id,'get_last_assistant_text',{text:'Answer'});
});`,
  );
  const launches: { args: string[]; cwd: string }[] = [];
  const launch: ProcessFactory = (options) => {
    launches.push({ args: options.args, cwd: options.cwd });
    return openProcess({ ...options, file: process.execPath, args: [file], timeoutMs: 2500 });
  };
  return { adapter: new OmpAdapter('omp.exe', engine, { launch }), launches, project, engine };
}
const scopeFor = (root: string, extra: Partial<ReadScope> = {}): ReadScope => ({
  root,
  web: true,
  ...extra,
});

describe('oh-my-pi read scope', () => {
  it('names only web search, never a file tool', () => {
    const text = ompArguments('overlay.yml');
    expect(text).toContain('--no-tools');
    expect(text.some((arg) => arg.startsWith('--tools'))).toBe(false);
    const read = ompArguments('overlay.yml', { root: 'C:\\p', web: true });
    expect(read).not.toContain('--no-tools');
    expect(read).toContain('--tools=web_search');
    for (const flag of ['--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-pty'])
      expect(read).toContain(flag);
    // Without web access there is nothing left to load.
    expect(ompArguments('overlay.yml', { root: 'C:\\p', web: false })).toContain('--no-tools');
  });
  it('starts in its own folder and streams web activity', async () => {
    const { adapter, launches, project } = await fixture(() => [
      { name: 'web_search', args: { query: 'Harbor Street hours' } },
    ]);
    const activity: RawToolActivity[] = [];
    const result = await adapter.generate({
      ...request,
      readScope: scopeFor(project),
      onToolActivity: (raw) => activity.push(raw),
    });
    expect(result.text).toBe('Answer');
    expect(launches[0].cwd).not.toBe(project);
    expect(activity.filter((a) => a.phase === 'started').map((a) => a.summary)).toEqual([
      'Searching the web for Harbor Street hours',
    ]);
    expect(activity.filter((a) => a.phase === 'finished')).toHaveLength(1);
  });
  it.each([
    ['bash', { command: 'echo hi' }],
    ['edit', { path: 'menu.md' }],
    ['write', { path: 'menu.md', content: 'x' }],
    ['eval', { code: '1' }],
    ['browser', { url: 'https://example.com' }],
  ])('stops the request when the model calls %s', async (name, args) => {
    const { adapter, project } = await fixture(() => [{ name, args }]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it.each([
    ['a read outside the project folder', { path: path.join(os.homedir(), 'secret.txt') }],
    ['an internal URI', { path: 'memory://root' }],
    ['a climb out of the folder', { path: '../outside.txt' }],
    ['a read inside the project folder', { path: 'menu.md' }],
    ['a URL read, since the read tool is never loaded', { path: 'https://example.com' }],
  ])('stops %s', async (_label, args) => {
    const { adapter, project } = await fixture(() => [{ name: 'read', args }]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('stops a URL read without web access', async () => {
    const { adapter, project } = await fixture(() => [
      { name: 'read', args: { path: 'https://example.com' } },
    ]);
    await expect(
      adapter.generate({ ...request, readScope: scopeFor(project, { web: false }) }),
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('keeps any tool fatal on the text-only route', async () => {
    const { adapter, project, launches, engine } = await fixture((root) => [
      { name: 'read', args: { path: path.join(root, 'menu.md') } },
    ]);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    expect(launches[0].cwd).toBe(engine);
    expect(launches[0].args).toContain('--no-tools');
    expect(project).not.toBe(engine);
  });
});
