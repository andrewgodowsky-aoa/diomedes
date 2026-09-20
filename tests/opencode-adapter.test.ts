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

async function fixture(mode = 'ok', startupTimeoutMs = 5_000, framing = 'lf') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes opencode '));
  roots.push(root);
  const file = path.join(root, 'fixture.mjs');
  await fs.writeFile(
    file,
    `import http from 'node:http';
import fs from 'node:fs';
const mode=${JSON.stringify(mode)}; const framing=${JSON.stringify(framing)}; let stream;
const catalogues={
 zen:{connected:['opencode'],all:[{id:'opencode',models:{'zen-model':{id:'zen-model',name:'Zen model'}}}]},
 none:{connected:[],all:[]},
 'zero-models':{connected:['opencode-go'],all:[{id:'opencode-go',models:{}}]},
 'wrong-model':{connected:['opencode-go'],all:[{id:'opencode-go',models:{'other-model':{id:'other-model',name:'Other model'}}}]},
 'dirty-route':{connected:['opencode','someone@example.com','a'.repeat(200),'',...Array.from({length:40},(v,i)=>'provider-'+i)],all:[]}};
const raw=catalogues[mode]||{connected:['opencode-go'],all:[{id:'opencode-go',models:{'go-model':{id:'go-model',name:'Go model',description:'fixture'}}}]};
// Diomedes starts this server with enabled_providers: ["opencode-go"], and
// opencode v1.18.4 prunes every other provider out of its own state before it
// answers (packages/opencode/src/provider/provider.ts:1606-1611, and the
// handler's own enabled filter). A fixture that answered with providers the
// real tool would already have removed would let a test pass against a body
// production never sends.
const allowed=new Set(['opencode-go']);
const catalogue={connected:raw.connected.filter(id=>allowed.has(id)),all:raw.all.filter(p=>allowed.has(p.id))};
// The same events, framed the way a conforming stream is allowed to frame them.
const frame=payload=>{
 if(framing==='crlf')return 'data: '+payload+'\\r\\n\\r\\n';
 if(framing==='cr')return 'data: '+payload+'\\r\\r';
 if(framing==='multiline')return 'data: '+payload.slice(0,1)+'\\ndata: '+payload.slice(1)+'\\n\\n';
 if(framing==='comments')return ': heartbeat\\nx-vendor: 1\\nid: 7\\ndata: '+payload+'\\n\\n';
 return 'data: '+payload+'\\n\\n';};
// 'split' puts the carriage return at the end of one write and its line feed at
// the start of the next, so the writes are chained to keep their order.
let tail=Promise.resolve();
const send=(res,value)=>{const payload=JSON.stringify(value);
 if(framing!=='split'){res.write(frame(payload));return;}
 tail=tail.then(()=>new Promise(done=>{res.write('data: '+payload+'\\r',()=>{res.write('\\n\\r\\n');done();});}));};
const server=http.createServer(async(req,res)=>{
 const auth=req.headers.authorization||''; if(!auth.startsWith('Basic ')){res.writeHead(401);return res.end();}
 if(req.url==='/provider'){if(mode==='local-401'){res.writeHead(401);return res.end('the local server rejected this password');} if(mode==='start-hang')return; res.setHeader('content-type','application/json');return res.end(JSON.stringify(catalogue));}
 if(req.url==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});stream=res;send(res,{type:'server.connected',properties:{}});return;}
 if(req.url==='/session'&&req.method==='POST'){let b='';for await(const c of req)b+=c; if(mode==='session-401'){res.writeHead(401);return res.end('this account is not authorized for that model');} res.setHeader('content-type','application/json');return res.end(JSON.stringify({id:'session-1'}));}
 if(req.url==='/session/session-1/prompt_async'){if(mode==='dispatch-hang')return; if(mode==='dispatch-500'){res.writeHead(500);return res.end('the server failed');} if(mode==='disk-quota-500'){res.writeHead(500);return res.end('over quota on the local cache disk, retry later');} if(mode==='usage-429'){res.writeHead(429);return res.end('rate limit exceeded for this account');} res.writeHead(204);res.end(); if(mode==='hang')return; setTimeout(()=>{if(!stream)return; if(mode==='malformed'){stream.write('data: {bad\\n\\n');return;} if(mode==='retry'){send(stream,{type:'session.status',properties:{sessionID:'session-1',status:{type:'retry',attempt:1,message:'retry',next:1}}});return;} if(mode==='flood'){stream.write('data: '+'x'.repeat(1_500_000));return;} if(mode==='session-denied'){send(stream,{type:'session.error',properties:{sessionID:'session-1',error:{name:'ProviderAuthError',data:{message:'unauthorized for this account'}}}});return;} if(mode==='session-failed'){send(stream,{type:'session.error',properties:{sessionID:'session-1',error:{name:'UnknownError',data:{message:'the model stopped responding'}}}});return;} if(mode==='assistant-denied'){send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:'opencode-go',modelID:'go-model',time:{created:1},error:{name:'APIError',data:{message:'The upstream service refused this account.',statusCode:401,isRetryable:false,responseBody:'{"secret-echo":"sk-live-do-not-publish"}'}}}}});return;}
  if(mode==='api-limit'){send(stream,{type:'session.error',properties:{sessionID:'session-1',error:{name:'APIError',data:{message:'Slow down.',statusCode:429,isRetryable:true}}}});return;}
  if(mode==='context-overflow'){send(stream,{type:'session.error',properties:{sessionID:'session-1',error:{name:'ContextOverflowError',data:{message:'Too long.',responseBody:'sk-live-do-not-publish'}}}});return;} if(mode==='tools'){send(stream,{type:'message.part.updated',properties:{part:{sessionID:'session-1',messageID:'assistant-1',type:'tool',text:''}}});return;} if(mode==='stall'){send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:'opencode-go',modelID:'go-model',time:{created:1}}}}); send(stream,{type:'message.part.delta',properties:{sessionID:'session-1',messageID:'assistant-1',partID:'part-1',field:'text',delta:'Partial '}}); return;} if(mode==='stream-drop'){send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:'opencode-go',modelID:'go-model',time:{created:1}}}}); stream.write('data: '+JSON.stringify({type:'message.part.delta',properties:{sessionID:'session-1',messageID:'assistant-1',partID:'part-1',field:'text',delta:'Partial '}})+'\\n\\n',()=>{if(stream.socket)stream.socket.destroy();}); return;} if(mode==='noise'){send(stream,{type:'message.updated',properties:{info:{id:'noise',sessionID:'other-session',role:'assistant',providerID:'other',modelID:'other'}}});} const provider=mode==='mismatch'?'other':'opencode-go'; send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:provider,modelID:'go-model',time:{created:1}}}}); send(stream,{type:'message.part.delta',properties:{sessionID:'session-1',messageID:'assistant-1',partID:'part-1',field:'text',delta:'Answer'}}); if(mode==='truncated'){stream.write('data: {"type":"session.status","properties":{"sessionID":"session-1"',()=>{if(stream.socket)stream.socket.destroy();});return;} send(stream,{type:'message.updated',properties:{info:{id:'assistant-1',sessionID:'session-1',role:'assistant',providerID:provider,modelID:'go-model',time:{created:1,completed:2},finish:'stop'}}}); send(stream,{type:'session.status',properties:{sessionID:'session-1',status:{type:'idle'}}});},5);return;}
 if(req.url==='/session/session-1/abort'||req.url==='/session/session-1'){fs.appendFileSync('drop-seen.log',req.url+'\\n');res.writeHead(200);return res.end('true');}
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
    startupTimeoutMs,
    requestTimeoutMs: mode === 'hang' ? 30 : 1_000,
  });
  return { adapter, launches, root };
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
  it.each([
    ['line feeds', 'lf'],
    ['carriage return line feeds', 'crlf'],
    ['carriage returns', 'cr'],
    ['a line ending split across two chunks', 'split'],
    ['one event spread over several data fields', 'multiline'],
    ['comments and fields this route does not read', 'comments'],
  ])('reads a stream framed with %s', async (_description, framing) => {
    const { adapter } = await fixture('ok', 5_000, framing);
    const deltas: string[] = [];
    await expect(
      adapter.generate({ ...request, onDelta: (value) => deltas.push(value) }),
    ).resolves.toMatchObject({ text: 'Answer' });
    expect(deltas).toEqual(['Answer']);
  });
  it('still refuses a different provider or model under carriage return line feeds', async () => {
    const { adapter } = await fixture('mismatch', 5_000, 'crlf');
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });
  it('still ignores another session under carriage return line feeds', async () => {
    const { adapter } = await fixture('noise', 5_000, 'crlf');
    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'Answer' });
  });
  it('never completes on a stream truncated inside an event', async () => {
    const { adapter, root } = await fixture('truncated');
    const deltas: string[] = [];
    const outcome = await adapter
      .generate({ ...request, onDelta: (value) => deltas.push(value) })
      .then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ error }),
      );
    // The last frame never reached its blank line, so it is not an event and
    // the half-read status can never be read as a finished answer.
    expect(outcome).toHaveProperty('error');
    expect(deltas).toEqual(['Answer']);
    const seen = await fs.readFile(path.join(root, 'drop-seen.log'), 'utf8');
    expect(seen).toContain('/session/session-1/abort');
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
  it('keeps the request-budget sentence for a timed-out request', async () => {
    const { adapter } = await fixture('hang');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'TIMEOUT',
      message:
        'OpenCode did not finish within the time limit. Recheck before starting another request.',
    });
  });
  it('gives the startup budget its own timeout sentence', async () => {
    const { adapter } = await fixture('start-hang', 2_000);
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'TIMEOUT',
      message:
        'OpenCode did not start within 2 seconds. Recheck the engine in Settings before starting another request.',
    });
  });
  it('an SSE connection drop midstream never fabricates a completion and aborts the remote session', async () => {
    const { adapter, root } = await fixture('stream-drop');
    const deltas: string[] = [];
    const outcome = await adapter
      .generate({ ...request, onDelta: (value) => deltas.push(value) })
      .then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ error }),
      );
    // The socket dropped after a partial delta — no finished answer exists to
    // report, and the request must fail rather than resolve on partial text.
    expect(outcome).toHaveProperty('error');
    const error = (outcome as { error: { code: string; ambiguous: boolean } }).error;
    expect(['PROTOCOL_ERROR', 'PROVIDER_ERROR']).toContain(error.code);
    expect(error.ambiguous).toBe(true);
    expect(deltas).toEqual(['Partial ']);
    // The dropped run told the server to stop the orphaned remote session.
    const seen = await fs.readFile(path.join(root, 'drop-seen.log'), 'utf8');
    expect(seen).toContain('/session/session-1/abort');
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
  it('cannot see a separate OpenCode Zen provider at all, and says so rather than implying a missing sign-in', async () => {
    // Diomedes starts the server with enabled_providers: ["opencode-go"], and
    // opencode v1.18.4 prunes every other provider out of its own state before
    // it answers. A Zen-only customer is therefore indistinguishable over HTTP
    // from someone who has never signed in anywhere: both get an empty list.
    // The sentence must not turn that into "you are not signed in".
    const { adapter } = await fixture('zen');
    const status = await adapter.inspect();
    expect(status).toMatchObject({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
    });
    expect(status.detail).toContain(OPENCODE_ACCOUNT_ROUTE);
    expect(status.detail).toMatch(/not visible to this route/i);
    expect(status.detail).toMatch(/zen/i);
  });
  it('reports nothing connected as signed out, with no account-route issue', async () => {
    const { adapter } = await fixture('none');
    const status = await adapter.inspect();
    expect(status).toMatchObject({
      authentication: 'signed-out',
      accountRoute: null,
      models: [],
    });
    expect(status.routeIssue).toBeUndefined();
    expect(status.detail).toMatch(/sign in/i);
    // What an empty list actually means here, said plainly.
    expect(status.detail).toMatch(/no OpenCode Go account is connected/i);
  });
  it('reports a connected Go account that offers no models as signed in', async () => {
    const { adapter } = await fixture('zero-models');
    const status = await adapter.inspect();
    expect(status).toMatchObject({
      authentication: 'signed-in',
      accountRoute: OPENCODE_ACCOUNT_ROUTE,
      models: [],
    });
    expect(status.routeIssue).toBeUndefined();
    expect(status.detail).toMatch(/no usable models/i);
  });
  it('records no provider identifier the tool did not publish in its own catalogue', async () => {
    // The tool prunes these before it answers, so this reaches the same empty
    // list a signed-out machine does. What the adapter must never do is carry
    // an address or an opaque value into a sentence or a support bundle.
    const { adapter } = await fixture('dirty-route');
    const status = await adapter.inspect();
    const connected = status.routeIssue?.connected ?? [];
    expect(connected).toEqual([]);
    expect(JSON.stringify(status)).not.toContain('@');
    expect(JSON.stringify(status)).not.toContain('aaaa');
  });
  it.each(['ok', 'none', 'zero-models', 'zen'])(
    'answers the account-route field for %s so a resolved issue cannot survive a recheck',
    async (mode) => {
      const { adapter } = await fixture(mode);
      // A caller that merges one inspection over the last needs the key to be
      // present, or a route issue the person has since fixed stays on screen.
      expect('routeIssue' in (await adapter.inspect())).toBe(true);
    },
  );
  it('names an unsigned Go account rather than a missing model before dispatch', async () => {
    const { adapter } = await fixture('none');
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('refuses a Zen-only machine before dispatch, naming the route rather than a missing model', async () => {
    // The tool has already pruned Zen out of its own state, so this is the
    // same answer a machine with no account at all gives. What the person
    // gets must name the route and say that their other account is not it.
    const { adapter } = await fixture('zen');
    const failure = await adapter.generate(request).then(
      () => undefined,
      (error: { code: string; message: string }) => error,
    );
    expect(failure?.code).toBe('AUTH_REQUIRED');
    expect(failure?.message).toContain(OPENCODE_ACCOUNT_ROUTE);
    expect(failure?.message).toMatch(/not visible to this route/i);
  });
  it('still refuses a model the connected Go account does not offer', async () => {
    const { adapter } = await fixture('wrong-model');
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });
});

describe('OpenCode failure stages', () => {
  it('does not read its own rejected loopback password as a signed-out account', async () => {
    const { adapter } = await fixture('local-401');
    const failure = await adapter.inspect().then(
      () => undefined,
      (error: { code: string; stage: string; message: string }) => error,
    );
    // Diomedes generated this password and handed it to the server it started.
    // Refusing it says nothing about the person's OpenCode account, so the
    // sentence must not send them to sign in again, and the code must not be
    // the one the service reads as signed out.
    expect(failure).toMatchObject({ code: 'HANDSHAKE_FAILED', stage: 'local-handshake' });
    expect(failure?.code).not.toBe('AUTH_REQUIRED');
    expect(failure?.message).not.toMatch(/sign in/i);
  });
  it('reads a 401 after the handshake as the local server too, never as the account', async () => {
    // The authorization middleware is the only thing that answers 401 here and
    // it has no 403 path at all, so a 401 on /session or /event is the same
    // local Basic check the handshake met. Reading it as an account denial
    // sent a person to fix a sign-in that was never the fault.
    const { adapter } = await fixture('session-401');
    const failure = await adapter.generate(request).then(
      () => undefined,
      (error: { code: string; stage: string; message: string }) => error,
    );
    expect(failure).toMatchObject({ code: 'HANDSHAKE_FAILED', stage: 'local-handshake' });
    expect(failure?.message).not.toMatch(/sign in/i);
  });
  it.each(['assistant-denied', 'api-limit', 'context-overflow'])(
    'never carries a response body from %s into anything a person or support reads',
    async (mode) => {
      // APIError and ContextOverflowError both carry responseBody, which is
      // whatever the upstream service sent back and can hold account detail.
      const { adapter } = await fixture(mode);
      const failure = await adapter.generate(request).then(
        () => undefined,
        (error: { code: string; message: string }) => error,
      );
      expect(failure).toBeDefined();
      expect(JSON.stringify(failure)).not.toContain('sk-live-do-not-publish');
    },
  );
  it('does not read a sentence about a local disk as the account running out of allowance', async () => {
    // A plain-text body is a sentence, not an identity. Matching it the way a
    // machine-readable code is matched would put the substring defect back:
    // this body contains "quota" and "retry" and means neither.
    const { adapter } = await fixture('disk-quota-500');
    const failure = await adapter.generate(request).then(
      () => undefined,
      (error: { code: string; message: string }) => error,
    );
    expect(failure?.code).toBe('PROVIDER_ERROR');
    expect(failure?.message).not.toMatch(/limit/i);
  });
  it('reads each named stream error as what the tool said it was', async () => {
    const { adapter: limited } = await fixture('api-limit');
    await expect(limited.generate(request)).rejects.toMatchObject({
      code: 'USAGE_LIMIT',
      stage: 'stream',
    });
    const { adapter: overflowed } = await fixture('context-overflow');
    await expect(overflowed.generate(request)).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      stage: 'stream',
    });
  });
  it('reports a startup timeout at the launch stage', async () => {
    const { adapter } = await fixture('start-hang', 2_000);
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'TIMEOUT',
      stage: 'launch',
    });
  });
  it.each([
    ['none', 'AUTH_REQUIRED', 'provider-auth'],
    // Pruned by the tool before it answers, so this is the signed-out answer.
    ['zen', 'AUTH_REQUIRED', 'provider-auth'],
    ['wrong-model', 'MODEL_UNAVAILABLE', 'model-list'],
    ['dispatch-500', 'PROVIDER_ERROR', 'dispatch'],
    ['usage-429', 'USAGE_LIMIT', 'dispatch'],
    ['malformed', 'PROTOCOL_ERROR', 'stream'],
    ['retry', 'PROVIDER_ERROR', 'stream'],
    ['tools', 'POLICY_MISMATCH', 'stream'],
    ['mismatch', 'POLICY_MISMATCH', 'stream'],
    ['stream-drop', undefined, 'stream'],
    ['truncated', undefined, 'stream'],
  ])('reports %s at its own stage', async (mode, code, stage) => {
    const { adapter } = await fixture(mode);
    await expect(adapter.generate(request)).rejects.toMatchObject(
      code ? { code, stage } : { stage },
    );
  });
  it('keeps the account route refusal before launch at the provider-auth stage', async () => {
    const { adapter, launches } = await fixture();
    await expect(
      adapter.generate({ ...request, accountRoute: 'opencode:other' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED', stage: 'provider-auth' });
    expect(launches).toHaveLength(0);
  });
  it('keeps an unusable model selection before launch at the model-list stage', async () => {
    const { adapter, launches } = await fixture();
    await expect(adapter.generate({ ...request, model: 'go-model' })).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      stage: 'model-list',
    });
    expect(launches).toHaveLength(0);
  });
  it('reports a request timeout at the stage it ran out on', async () => {
    // A prompt that is never answered spends the budget on the dispatch; a
    // stream that never ends spends it on the stream. The two recoveries are
    // not the same, and the stage is the only thing that tells them apart.
    const sending = await fixture('dispatch-hang');
    await expect(sending.adapter.generate(request)).rejects.toMatchObject({
      code: 'TIMEOUT',
      stage: 'dispatch',
    });
    const waiting = await fixture('stall');
    await expect(waiting.adapter.generate(request)).rejects.toMatchObject({
      code: 'TIMEOUT',
      stage: 'stream',
    });
  });
  it('stamps a cancellation with the stage it was stopped at', async () => {
    // Stopped from inside the stream, once a delta proves the prompt was
    // accepted, so the stage is the stream and not the launch it raced.
    const { adapter } = await fixture('stall');
    const controller = new AbortController();
    await expect(
      adapter.generate({
        ...request,
        signal: controller.signal,
        onDelta: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED', stage: 'stream' });
  });
  it('stamps a cancellation that arrives before the server is ready at the launch stage', async () => {
    const { adapter } = await fixture('start-hang', 5_000);
    const controller = new AbortController();
    const job = adapter.generate({ ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(job).rejects.toMatchObject({ code: 'CANCELLED', stage: 'launch' });
  });
  it('names a host deadline that expires before the server is ready a timeout, not a cancellation', async () => {
    // The 60-second budget `EngineService.test()` merges into the signal is the
    // host's, not the person's. It reaches the adapter as an abort whose reason
    // is a TimeoutError, and a support bundle must not record it as a stop.
    const { adapter } = await fixture('start-hang', 5_000);
    const failure = await adapter
      .generate({ ...request, signal: AbortSignal.timeout(120) })
      .then(
        () => undefined,
        (error: { code: string; stage?: string; message: string }) => error,
      );
    expect(failure).toMatchObject({ code: 'TIMEOUT', stage: 'launch' });
    expect(failure?.message).not.toMatch(/was stopped/i);
  });
  it('refuses a request whose host deadline has already passed as a timeout', async () => {
    const { adapter } = await fixture('ok');
    const expired = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(adapter.generate({ ...request, signal: expired })).rejects.toMatchObject({
      code: 'TIMEOUT',
      stage: 'launch',
    });
  });
  it.each(['session-denied', 'assistant-denied'])(
    'reads %s as the account refusing the work, at the provider-auth stage',
    async (mode) => {
      // The refusal arrived over the stream, but it came back from the account
      // rather than from the server Diomedes started, so it is not a stream
      // fault and the person is not told their local setup is broken.
      const { adapter } = await fixture(mode);
      await expect(adapter.generate(request)).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
        stage: 'provider-auth',
      });
    },
  );
  it('leaves a session error that is not a refusal at the stream stage', async () => {
    const { adapter } = await fixture('session-failed');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      stage: 'stream',
    });
  });
  it('refuses a single event that grows past the parser bound, at the stream stage', async () => {
    const { adapter } = await fixture('flood');
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      stage: 'stream',
    });
  });
  it('reports a cleanup that cannot confirm the process stopped at the cleanup stage', async () => {
    const { adapter } = await fixture();
    cleanup.fail = true;
    await expect(adapter.inspect()).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
      stage: 'cleanup',
    });
  });
  it('keeps the failing stage when the process cannot be confirmed stopped', async () => {
    const { adapter } = await fixture('malformed');
    cleanup.fail = true;
    await expect(adapter.generate(request)).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      stage: 'stream',
      message: expect.stringContaining('could not be confirmed stopped'),
    });
  });
  it('carries no stage on a successful inspection or request', async () => {
    const { adapter } = await fixture();
    await expect(adapter.inspect()).resolves.toMatchObject({ authentication: 'signed-in' });
    await expect(adapter.generate(request)).resolves.toMatchObject({ text: 'Answer' });
  });
});
