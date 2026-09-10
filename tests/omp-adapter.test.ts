import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OMP_VERSION, OmpAdapter, ompArguments } from '../server/engines/omp.js';
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
  model: 'openai/gpt-test',
  accountRoute: 'oh-my-pi:openai',
  instructions: 'Project rule',
  prompt: 'Question',
  documents: [],
};
type Mode =
  | 'ok'
  | 'no-models'
  | 'model-mismatch'
  | 'terminal-mismatch'
  | 'tool'
  | 'tool-message'
  | 'terminal-tool'
  | 'unsafe-profile'
  | 'chunk'
  | 'quota'
  | 'auth'
  | 'post-ack-error'
  | 'session-mismatch'
  | 'hang';

async function fixture(mode: Mode = 'ok') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes omp '));
  roots.push(root);
  if (mode === 'unsafe-profile') {
    await fs.mkdir(path.join(root, 'native-profile'));
    await fs.writeFile(
      path.join(root, 'native-profile', 'config.yml'),
      'auth:\n  broker: "!command"\n',
    );
  }
  const file = path.join(root, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
const mode=${JSON.stringify(mode)}; const emit=x=>console.log(JSON.stringify(x));
const ok=(id,command,data={})=>emit({type:'response',id,command,success:true,data});
const message={role:'assistant',provider:'openai',model:'gpt-test',stopReason:'stop',content:[{type:'text',text:'Answer'}],usage:{input:0,output:0}};
if(mode==='no-models') { process.stderr.write('No models available.\\n'); process.exit(1); }
emit({type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1000000,maxReassembledFrameBytes:4000000});
emit({type:'available_commands_update',commands:[]});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.type==='negotiate_protocol') return ok(m.id,'negotiate_protocol',{protocolVersion:2});
 if(m.type==='set_auto_retry'||m.type==='set_auto_compaction') return ok(m.id,m.type);
 if(m.type==='set_model') return mode==='model-mismatch' ? ok(m.id,'set_model',{provider:'openai',id:'other'}) : ok(m.id,'set_model',{provider:m.provider,id:m.modelId});
 if(m.type==='get_state') return ok(m.id,'get_state',{model:{provider:'openai',id:'gpt-test'},sessionId:'native1',isStreaming:false});
 if(m.type==='get_available_models') return ok(m.id,'get_available_models',{models:[{provider:'openai',id:'gpt-test',name:'GPT test'}]});
 if(m.type==='prompt') { if(!m.message.includes('"instructions":"Project rule"')||!m.message.includes('"request":"Question"')) return emit({type:'response',id:m.id,command:'prompt',success:false,error:'missing explicit envelope'}); if(mode==='hang') return; if(mode==='quota'||mode==='auth') return emit({type:'response',id:m.id,command:'prompt',success:false,error:mode==='quota'?'quota reached':'unauthorized'});
  if(mode==='tool') return emit({type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{}});
  if(mode==='tool-message') return emit({type:'message_update',message:{...message,content:[{type:'toolCall',id:'t1',name:'bash',arguments:{}}]},assistantMessageEvent:{type:'toolcall_end',toolCall:{id:'t1'}}});
  if(mode==='chunk') return emit({type:'rpc_chunk',chunkId:'c',index:0,count:1,byteLength:3,data:'e30='});
  if(mode==='post-ack-error') { ok(m.id,'prompt',{agentInvoked:true}); return emit({type:'response',id:m.id,command:'prompt',success:false,error:'provider exploded'}); }
  // v18.0.6 streams AgentSessionEvent objects, which can precede prompt ACK.
  emit({type:'message_update',message,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'Answer',partial:message}});
  emit({type:'agent_end',messages:[mode==='terminal-mismatch'?{...message,model:'other'}:mode==='terminal-tool'?{...message,content:[{type:'toolCall',id:'t1',name:'bash',arguments:{}}]}:message],sessionId:mode==='session-mismatch'?'other':'native1'});
  ok(m.id,'prompt',{agentInvoked:true}); return; }
 if(m.type==='get_last_assistant_text') return ok(m.id,'get_last_assistant_text',{text:'Answer'});
 if(m.type==='abort') return; });`,
  );
  const seen: { args: string[][]; envs: NodeJS.ProcessEnv[] } = { args: [], envs: [] };
  const launch: ProcessFactory = (options) => {
    seen.args.push(options.args);
    seen.envs.push(options.env);
    return openProcess({ ...options, file: process.execPath, args: [file], timeoutMs: 2500 });
  };
  return { adapter: new OmpAdapter('omp.exe', root, { launch }), seen, root };
}

describe('oh-my-pi 18.0.6 text-only RPC route', () => {
  it('uses the tagged v1-ready then v2-negotiated, isolated no-tools launch', async () => {
    const { adapter, seen, root } = await fixture();
    await adapter.inspect();
    expect(OMP_VERSION).toBe('18.0.6');
    const args = seen.args[0];
    for (const flag of [
      '--mode',
      'rpc',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--no-pty',
      '--no-title',
      '--no-session',
      '--max-time',
      '90',
      '--config',
    ])
      expect(args).toContain(flag);
    expect(args).toEqual(ompArguments(args[args.indexOf('--config') + 1]));
    expect(seen.envs[0].PI_CODING_AGENT_DIR).toBe(path.join(root, 'native-profile'));
    expect(seen.envs[0].OMP_AUTH_BROKER_URL).toBeUndefined();
    expect(await fs.readFile(path.join(root, 'omp-overlay.yml'), 'utf8')).toContain(
      'retry:\n  enabled: false\n  maxRetries: 0\n  modelFallback: false\n  usageAwareFallback: false\n  fallbackChains: {}',
    );
    expect(await fs.readFile(path.join(root, 'omp-overlay.yml'), 'utf8')).toContain(
      'compaction:\n  enabled: false\n  midTurnEnabled: false',
    );
  });

  it('uses authenticated available models, never OAuth login-provider metadata, for inspection', async () => {
    const { adapter } = await fixture();
    const status = await adapter.inspect();
    expect(status).toMatchObject({ authentication: 'signed-in', accountRoute: 'oh-my-pi:openai' });
    expect(status.models[0].slug).toBe('openai/gpt-test');
    const { adapter: empty } = await fixture('no-models');
    await expect(empty.inspect()).resolves.toMatchObject({
      authentication: 'unknown',
      accountRoute: null,
      models: [],
    });
  });

  it('carries instructions in the explicit prompt envelope, accepts pre-ACK events, and verifies terminal runtime identity', async () => {
    const { adapter } = await fixture();
    const deltas: string[] = [];
    const result = await adapter.generate({ ...request, onDelta: (text) => deltas.push(text) });
    expect(result).toMatchObject({
      text: 'Answer',
      model: 'openai/gpt-test',
      version: OMP_VERSION,
      projectId: 'p1',
      threadId: 't1',
      requestId: 'r1',
    });
    expect(deltas).toEqual(['Answer']);
  });

  it.each([
    ['model-mismatch', 'POLICY_MISMATCH'],
    ['terminal-mismatch', 'POLICY_MISMATCH'],
    ['session-mismatch', 'PROTOCOL_ERROR'],
    ['tool', 'POLICY_MISMATCH'],
    ['tool-message', 'POLICY_MISMATCH'],
    ['terminal-tool', 'POLICY_MISMATCH'],
    ['chunk', 'PROTOCOL_ERROR'],
    ['quota', 'USAGE_LIMIT'],
    ['auth', 'AUTH_REQUIRED'],
    ['post-ack-error', 'PROVIDER_ERROR'],
  ] as const)('rejects %s without retry or substitution', async (mode, code) => {
    const { adapter, seen } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject({ code });
    expect(seen.args).toHaveLength(1);
  });

  it('rejects a changed route before launching', async () => {
    const { adapter, seen } = await fixture();
    await expect(
      adapter.generate({ ...request, accountRoute: 'oh-my-pi:anthropic' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(seen.args).toHaveLength(0);
  });

  it('fails closed before launch when the app-owned profile config was changed', async () => {
    const { adapter, seen } = await fixture('unsafe-profile');
    await expect(adapter.inspect()).rejects.toMatchObject({ code: 'PROFILE_UNSAFE' });
    expect(seen.args).toHaveLength(0);
  });

  it('cancels a waiting request without returning a late answer', async () => {
    const { adapter } = await fixture('hang');
    const controller = new AbortController();
    const job = adapter.generate({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
