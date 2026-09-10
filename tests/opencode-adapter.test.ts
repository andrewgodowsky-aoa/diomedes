import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
const cleanup = vi.hoisted(() => ({ fail: false }));
vi.mock('../server/integrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/integrations.js')>();
  return {
    ...actual,
    killOwnedProcess: async (...args: Parameters<typeof actual.killOwnedProcess>) => {
      await actual.killOwnedProcess(...args);
      if (cleanup.fail) throw new Error('raw native cleanup diagnostic');
    },
  };
});
import {
  OpenCodeAdapter,
  OPENCODE_ACCOUNT_ROUTE,
  OPENCODE_VERSION,
  opencodeArguments,
} from '../server/engines/opencode.js';
import type { TextRequest } from '../server/engines/contract.js';

const roots: string[] = [];
afterEach(async () => {
  cleanup.fail = false;
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const request: TextRequest = {
  projectId: 'p1',
  threadId: 't1',
  requestId: 'r1',
  model: 'opencode-go/go-model',
  accountRoute: OPENCODE_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.',
  prompt: 'Question',
  documents: [],
};

async function fixture(mode = 'ok') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode '));
  roots.push(root);
  const file = path.join(root, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import http from 'node:http';
const mode=${JSON.stringify(mode)}; let stream;
const send=(res,value)=>{res.write('data: '+JSON.stringify(value)+'\\n\\n')};
const server=http.createServer(async(req,res)=>{
 const auth=req.headers.authorization||''; if(!auth.startsWith('Basic ')){res.writeHead(401);return res.end();}
 if(req.url==='/provider'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(mode==='zen'?{connected:['opencode'],all:[{id:'opencode',models:{'zen-model':{id:'zen-model',name:'Zen model'}}}]}:{connected:['opencode-go'],all:[{id:'opencode-go',models:{'go-model':{id:'go-model',name:'Go model',description:'fixture'}}}]}));}
 if(req.url==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});stream=res;send(res,{type:'server.connected',properties:{}});return;}
 if(req.url==='/session'&&req.method==='POST'){let b='';for await(const c of req)b+=c;res.setHeader('content-type','application/json');return res.end(JSON.stringify({id:'session-1'}));}
 if(req.url==='/session/session-1/prompt_async'){res.writeHead(204);res.end(); if(mode==='hang')return; setTimeout(()=>{if(!stream)return; if(mode==='malformed'){stream.write('data: {bad\\n\\n');return;} if(mode==='retry'){send(stream,{type:'session.status',properties:{sessionID:'session-1',status:{type:'retry',attempt:1,message:'retry',next:1}}});return;} if(mode==='tools'){send(stream,{type:'message.part.updated',properties:{part:{sessionID:'session-1',messageID:'assistant-1',type:'tool',text:''}}});return;} if(mode==='noise'){send(stream,{type:'message.updated',properties:{info:{id:'noise',sessionID:'other-session',role:'assistant',providerID:'other',modelID:'other'}}});} const provider=mode==='mismatch'?'other':'opencode-go'; send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:provider,modelID:'go-model',time:{created:1}}}}); send(stream,{type:'message.part.delta',properties:{sessionID:'session-1',messageID:'assistant-1',partID:'part-1',field:'text',delta:'Answer'}}); send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:provider,modelID:'go-model',time:{created:1,completed:2},finish:'stop'}}}); send(stream,{type:'session.status',properties:{sessionID:'session-1',status:{type:'idle'}}});},5);return;}
 if(req.url==='/session/session-1/abort'||req.url==='/session/session-1'){res.writeHead(200);return res.end('true');}
 res.writeHead(404);res.end();
}); server.listen(Number(process.argv[2]),'127.0.0.1');`,
  );
  const launches: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const launch = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    launches.push({ args, env: options?.env ?? {} });
    return spawn(
      process.execPath,
      [file, args[args.indexOf('--port') + 1]],
      options,
    ) as ChildProcessWithoutNullStreams;
  };
  const adapter = new OpenCodeAdapter('opencode', root, {
    spawn: launch,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: mode === 'hang' ? 30 : 1_000,
  });
  return { adapter, launches };
}

describe('OpenCode 1.18.4 authenticated text route', () => {
  it('uses pure loopback serving and preserves the native data root', () => {
    expect(opencodeArguments(43210)).toEqual([
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '43210',
      '--pure',
    ]);
  });
  it('inspects only a connected native OpenCode Go catalogue', async () => {
    const { adapter, launches } = await fixture();
    const status = await adapter.inspect();
    expect(status).toMatchObject({
      authentication: 'signed-in',
      accountRoute: OPENCODE_ACCOUNT_ROUTE,
    });
    expect(status.models[0].slug).toBe('opencode-go/go-model');
    expect(launches[0].env.XDG_CONFIG_HOME).toContain('.opencode-config-');
    expect(launches[0].env.XDG_DATA_HOME).toBe(
      process.env.XDG_DATA_HOME ??
        path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.local', 'share'),
    );
    expect(launches[0].env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBeUndefined();
    expect(launches[0].env.OPENCODE_AUTH_CONTENT).toBeUndefined();
  });
  it('streams text and returns the logical request identity', async () => {
    const { adapter } = await fixture();
    const deltas: string[] = [];
    const result = await adapter.generate({ ...request, onDelta: (value) => deltas.push(value) });
    expect(result).toMatchObject({
      text: 'Answer',
      model: request.model,
      version: OPENCODE_VERSION,
      projectId: 'p1',
      threadId: 't1',
      requestId: 'r1',
    });
    expect(deltas).toEqual(['Answer']);
  });
  it('ignores events belonging to another session', async () => {
    const { adapter } = await fixture('noise');
    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'Answer' });
  });
  it.each(['retry', 'tools', 'mismatch', 'malformed'])(
    'rejects %s without accepting output',
    async (mode) => {
      const { adapter } = await fixture(mode);
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code:
          mode === 'tools' || mode === 'mismatch'
            ? 'POLICY_MISMATCH'
            : mode === 'retry'
              ? 'PROVIDER_ERROR'
              : 'PROTOCOL_ERROR',
      });
    },
  );
  it('rejects cancellation and aborts the remote session', async () => {
    const { adapter } = await fixture('hang');
    const controller = new AbortController();
    const job = adapter.generate({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(job).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('reports a bounded server timeout separately from cancellation', async () => {
    const { adapter } = await fixture('hang');
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('preserves the request failure and reports uncertain process cleanup safely', async () => {
    const { adapter } = await fixture('malformed');
    cleanup.fail = true;
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      ambiguous: true,
      message: expect.stringContaining('could not be confirmed stopped'),
    });
  });
  it('rejects a non-Go account route before starting a paid request', async () => {
    const { adapter, launches } = await fixture();
    await expect(
      adapter.generate({ ...request, accountRoute: 'opencode:other' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(launches).toHaveLength(0);
  });
  it('does not treat the separate OpenCode Zen provider as native Go sign-in', async () => {
    const { adapter } = await fixture('zen');
    await expect(adapter.inspect()).resolves.toMatchObject({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
    });
  });
});
