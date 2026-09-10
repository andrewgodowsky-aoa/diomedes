import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter, claudeArguments } from '../server/engines/claude.js';
import { openProcess, type ProcessFactory } from '../server/engines/process.js';
import type { TextRequest } from '../server/engines/contract.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const request: TextRequest = {
  projectId: 'p1',
  threadId: 't1',
  requestId: 'r1',
  model: 'claude-test',
  accountRoute: 'claude-code:claude.ai',
  instructions: 'Project rule',
  prompt: 'Question',
  documents: [],
};
async function fixture(mode = 'ok') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude '));
  roots.push(root);
  const file = path.join(root, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
const emit=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request') emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'claude-test',displayName:'Claude test',description:'Fixture'}]}}});
 if(m.type==='user') {
  emit({type:'system',subtype:'init',session_id:'native1',model:${JSON.stringify(mode === 'model' ? 'other' : 'claude-test')},tools:${mode === 'tools' ? "['Bash']" : '[]'},mcp_servers:[]});
  if(${JSON.stringify(mode)}==='hang') return;
  emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Answer'}}});
  emit({type:'result',subtype:${JSON.stringify(mode === 'limit' ? 'error_during_execution' : 'success')},is_error:${mode === 'limit'},result:'Answer',errors:${mode === 'limit' ? "['rate_limit_error']" : '[]'},session_id:'native1',modelUsage:{'claude-test':{}}});
 }
});`,
  );
  const launches: string[][] = [];
  const launch: ProcessFactory = (options) => {
    launches.push(options.args);
    return openProcess({ ...options, file: process.execPath, args: [file], timeoutMs: 2500 });
  };
  const adapter = new ClaudeAdapter('claude.exe', root, {
    launch,
    account: async () => ({ loggedIn: true, authMethod: 'claude.ai' }),
  });
  return { adapter, launches };
}
describe('Claude Code structured text route', () => {
  it('retains subscription auth and disables customizations and tools without bare mode', () => {
    const args = claudeArguments();
    expect(args).toContain('--safe-mode');
    expect(args).not.toContain('--bare');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
  });
  it('inspects native account and model catalogue without sending a user prompt', async () => {
    const { adapter } = await fixture();
    const status = await adapter.inspect();
    expect(status.authentication).toBe('signed-in');
    expect(status.models[0].slug).toBe('claude-test');
  });
  it('streams and returns the exact project/thread identity from a bounded turn', async () => {
    const { adapter } = await fixture();
    const deltas: string[] = [];
    const result = await adapter.generate({ ...request, onDelta: (text) => deltas.push(text) });
    expect(result).toMatchObject({
      text: 'Answer',
      model: 'claude-test',
      projectId: 'p1',
      threadId: 't1',
      requestId: 'r1',
    });
    expect(deltas).toEqual(['Answer']);
  });
  it.each(['model', 'tools'])('rejects a %s mismatch before accepting output', async (mode) => {
    const { adapter } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('reports usage exhaustion without selecting another model or retrying', async () => {
    const { adapter, launches } = await fixture('limit');
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'USAGE_LIMIT' });
    expect(launches).toHaveLength(1);
  });
  it('does not substitute an API account for the chosen subscription', async () => {
    const adapter = new ClaudeAdapter('unused', '.', {
      account: async () => ({ loggedIn: true, authMethod: 'api_key' }),
    });
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('cancels a waiting request and returns no late result', async () => {
    const { adapter } = await fixture('hang');
    const controller = new AbortController();
    const job = adapter.generate({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
