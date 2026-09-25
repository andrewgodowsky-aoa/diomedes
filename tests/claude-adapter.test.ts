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
async function fixture(
  mode = 'ok',
  deps: { account?: () => Promise<Record<string, unknown>>; missing?: boolean; models?: Record<string, unknown>[]; reportedModel?: string } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude '));
  roots.push(root);
  const file = path.join(root, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
import fs from 'node:fs';
const mode=${JSON.stringify(mode)}; const emit=x=>console.log(JSON.stringify(x));
const models=${JSON.stringify(deps.models ?? [{ value: 'claude-test', displayName: 'Claude test', description: 'Fixture' }])};
const reportedModel=${JSON.stringify(deps.reportedModel ?? 'claude-test')};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request') {
  if(mode==='handshake') return console.log('{broken');
  if(mode==='init-auth') return emit({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'unauthorized'}});
  return emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models}}});
 }
 if(m.type==='user') {
  // Nothing at all comes back, so the turn is waiting at dispatch when the marker appears.
  if(mode==='dispatched') return fs.writeFileSync(${JSON.stringify(path.join(root, 'dispatched'))},'1');
  emit({type:'system',subtype:'init',session_id:'native1',model:mode==='model'?'other':reportedModel,tools:mode==='tools'?['Bash']:[],mcp_servers:[]});
  if(mode==='hang') return;
  if(mode==='streamed') return emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Answer'}}});
  if(mode==='early-limit') return emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',errors:['rate_limit_error'],session_id:'native1',modelUsage:{}});
  if(mode==='disk-quota') return emit({type:'result',subtype:'error_during_execution',is_error:true,result:'',errors:{message:'the temporary directory is over its disk quota'},session_id:'native1',modelUsage:{}});
  emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Answer'}}});
  emit({type:'result',subtype:mode==='limit'?'error_during_execution':'success',is_error:mode==='limit',result:'Answer',errors:mode==='limit'?['rate_limit_error']:[],session_id:'native1',modelUsage:{[reportedModel]:{}}});
 }
});`,
  );
  const launches: string[][] = [];
  const launch: ProcessFactory = (options) => {
    launches.push(options.args);
    return openProcess({
      ...options,
      file: deps.missing ? path.join(root, 'absent.exe') : process.execPath,
      args: deps.missing ? [] : [file],
      timeoutMs: 2500,
    });
  };
  const adapter = new ClaudeAdapter('claude.exe', root, {
    launch,
    account: deps.account ?? (async () => ({ loggedIn: true, authMethod: 'claude.ai' })),
  });
  return { adapter, launches, root };
}
const exists = (file: string) => fs.access(file).then(() => true).catch(() => false);
describe('Claude Code structured text route', () => {
  it('keeps the native Opus and Fable context choices alongside Sonnet and Haiku', async () => {
    const slugs = ['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku', 'opus[bad]', '--model=x', 'opus[1m];shell'];
    const { adapter } = await fixture('ok', { models: slugs.map((value) => ({ value, displayName: value })) });
    expect((await adapter.inspect()).models.map((model) => model.slug)).toEqual(['opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']);
  });
  it.each([
    ['opus[1m]', 'claude-opus-5-5'],
    ['claude-fable-5-1[1m]', 'claude-fable-5-1'],
  ])('accepts %s when the runtime reports its underlying model', async (model, reportedModel) => {
    const { adapter, launches } = await fixture('ok', { reportedModel });
    expect((await adapter.generate({ ...request, model })).model).toBe(reportedModel);
    expect(launches[0]).toContain(model);
  });
  it('still rejects another model for a context-qualified choice', async () => {
    const { adapter } = await fixture('ok', { reportedModel: 'claude-sonnet-5' });
    await expect(adapter.generate({ ...request, model: 'opus[1m]' })).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
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
  it('does not read a local disk quota as the account running out of allowance', async () => {
    // "quota" matched anywhere in the serialised frame, so a machine fault that
    // has nothing to do with the account was reported as a service limit.
    const { adapter } = await fixture('disk-quota');
    const failure = await adapter.generate(request).then(
      () => undefined,
      (error: { code: string; message: string }) => error,
    );
    expect(failure?.code).toBe('PROVIDER_ERROR');
    expect(failure?.message).not.toMatch(/limit/i);
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
describe('Claude Code failure stages', () => {
  it.each([
    ['handshake', 'PROTOCOL_ERROR', 'local-handshake'],
    ['init-auth', 'AUTH_REQUIRED', 'provider-auth'],
    ['model', 'POLICY_MISMATCH', 'stream'],
    ['tools', 'POLICY_MISMATCH', 'stream'],
    ['limit', 'USAGE_LIMIT', 'stream'],
    ['early-limit', 'USAGE_LIMIT', 'dispatch'],
  ] as const)('reports %s as %s at the %s stage', async (mode, code, stage) => {
    const { adapter } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code, stage });
  });
  it('keeps a cancelled request at the stage it reached, never at the account', async () => {
    const { adapter, root } = await fixture('dispatched');
    const controller = new AbortController();
    const job = adapter.generate({ ...request, signal: controller.signal });
    const dispatched = expect(job).rejects.toMatchObject({
      code: 'CANCELLED',
      stage: 'dispatch',
      ambiguous: true,
    });
    await expect
      .poll(() => exists(path.join(root, 'dispatched')), { timeout: 5000 })
      .toBe(true);
    controller.abort();
    await dispatched;
    const { adapter: streaming } = await fixture('streamed');
    const stopping = new AbortController();
    await expect(
      streaming.generate({
        ...request,
        signal: stopping.signal,
        onDelta: () => stopping.abort(),
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED', stage: 'stream', ambiguous: true });
  });
  it('separates a signed-out account from a tool that could not start', async () => {
    const { adapter: signedOut } = await fixture('ok', {
      account: async () => ({ loggedIn: false }),
    });
    await expect(signedOut.inspect()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      stage: 'provider-auth',
    });
    const { adapter } = await fixture('ok', { missing: true });
    await expect(adapter.inspect()).rejects.toMatchObject({ stage: 'launch' });
  });
  it('does not present an unstartable account probe as a sign-in problem', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude '));
    roots.push(root);
    const adapter = new ClaudeAdapter(path.join(root, 'absent.exe'), root);
    await expect(adapter.inspect()).rejects.toMatchObject({ stage: 'launch' });
  });
  it('explains a different account kind rather than reporting a sign-out', async () => {
    const { adapter, launches } = await fixture('ok', {
      account: async () => ({ loggedIn: true, authMethod: 'api_key' }),
    });
    await expect(adapter.inspect()).resolves.toEqual({
      authentication: 'unknown',
      accountRoute: null,
      models: [],
      routeIssue: { required: 'claude-code:claude.ai', connected: ['api_key'] },
      detail: expect.stringContaining('does not accept'),
    });
    expect(launches).toHaveLength(0);
  });
  it('names no account when the reported sign-in method is not one this route knows', async () => {
    // Identifier shape is not a guarantee: an organisation name satisfies it,
    // and this list is rendered in the setup sentence and copied into the
    // support bundle a person sends to someone else. The vocabulary is closed.
    const { adapter } = await fixture('ok', {
      account: async () => ({ loggedIn: true, authMethod: 'acme-holdings-inc' }),
    });
    await expect(adapter.inspect()).resolves.toMatchObject({
      routeIssue: { required: 'claude-code:claude.ai', connected: [] },
    });
  });
  it('names no account when the reported sign-in method is not an identifier', async () => {
    const { adapter } = await fixture('ok', {
      account: async () => ({ loggedIn: true, authMethod: 'someone@example.com (token abc)' }),
    });
    await expect(adapter.inspect()).resolves.toMatchObject({
      routeIssue: { required: 'claude-code:claude.ai', connected: [] },
    });
  });
});
