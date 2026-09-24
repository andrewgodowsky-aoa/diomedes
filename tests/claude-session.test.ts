import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter, CLAUDE_VERSION } from '../server/engines/claude.js';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session.js';
import type { TextRequest } from '../server/engines/contract.js';
import { openProcess, type EngineProcess, type ProcessFactory } from '../server/engines/process.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes claude session '));
  roots.push(root);
  const file = path.join(root, 'fixture.mjs');
  const log = path.join(root, 'received.jsonl');
  await fs.writeFile(
    file,
    `import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
const emit=x=>console.log(JSON.stringify(x));
const mode=${JSON.stringify(mode)};
let session=process.argv[2], count=0;
const prefix=randomUUID();
const result=()=>emit({type:'result',uuid:prefix+'-'+count,subtype:'success',result:'Answer '+count,session_id:session,modelUsage:{'claude-test':{}}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
 if(m.type==='control_request') {
  emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
  if(m.request.subtype==='interrupt' && mode==='interrupt-error') setTimeout(()=>emit({type:'result',uuid:prefix+'-stopped-'+count,subtype:'error_during_execution',is_error:true,session_id:session,errors:['Request was aborted']}),20);
  else if(m.request.subtype==='interrupt' && mode!=='no-result') setTimeout(result,20);
 }
 if(m.type==='user') {
  count++;
  emit({type:'system',subtype:'init',session_id:mode==='missing'?'wrong':session,model:mode==='reroute'?'other-model':'claude-test',tools:mode==='tools'?['Bash']:[],mcp_servers:[]});
  if(mode==='hang'||mode==='no-result'||mode==='interrupt-error') return;
  if(mode==='exit') return process.exit(0);
  if(mode==='unknown') { emit({type:'future_completion',session_id:session,status:'success'}); return process.exit(0); }
  if(mode==='permission') return setTimeout(()=>emit({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo forbidden'}}}),75);
  if(mode==='child') emit({type:'assistant',parent_tool_use_id:'child-1',message:{model:'claude-test',content:[{type:'text',text:'child is not a grant'}]}});
  emit({type:'stream_event',session_id:session,event:{delta:{type:'text_delta',text:'Answer'}}});
  if(mode==='auth') return emit({type:'result',uuid:'result-'+count,subtype:'error_during_execution',is_error:true,session_id:session,errors:['authentication expired']});
  result(); if(mode==='duplicate') result();
 }
});`,
  );
  const launches: string[][] = [];
  const children: EngineProcess[] = [];
  const launch: ProcessFactory = (options) => {
    launches.push(options.args);
    const resumed = options.args[options.args.indexOf('--resume') + 1];
    const session = options.args.includes('--fork-session')
      ? randomUUID()
      : options.args.includes('--session-id')
        ? options.args[options.args.indexOf('--session-id') + 1]
        : resumed;
    const child = openProcess({
      ...options,
      file: process.execPath,
      args: [file, session],
      timeoutMs: 1500,
    });
    children.push(child);
    return child;
  };
  let identity = 'account-one';
  const adapter = new ClaudeAdapter('claude.exe', root, {
    launch,
    account: async () => ({ loggedIn: true, authMethod: 'claude.ai', email: identity }),
  });
  const checkpoints: ClaudeSessionCheckpoint[] = [];
  const options = {
    observedVersion: CLAUDE_VERSION,
    onCheckpoint: async (value: ClaudeSessionCheckpoint) => {
      checkpoints.push(value);
    },
  };
  return {
    adapter,
    launches,
    children,
    checkpoints,
    options,
    received: async () =>
      (await fs.readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    changeAccount: () => {
      identity = 'account-two';
    },
  };
}

describe('Claude persistent native transport', () => {
  it('keeps one process and correlates two turns without replaying duplicate results', async () => {
    const f = await fixture('duplicate');
    const session = await f.adapter.openSession(request, f.options);
    try {
      expect((await session.turn(request)).text).toBe('Answer 1');
      expect((await session.turn({ ...request, requestId: 'r2' })).text).toBe('Answer 2');
      expect(f.launches).toHaveLength(1);
      expect(f.launches[0]).not.toContain('--no-session-persistence');
      expect(f.checkpoints.at(-1)?.state).toBe('idle');
    } finally {
      await session.close();
    }
  });
  it('resumes exact native identity after transport restart and refuses previously sent requests', async () => {
    const f = await fixture();
    const first = await f.adapter.openSession(request, f.options);
    await first.turn(request);
    const checkpoint = first.checkpoint;
    await first.close();
    const second = await f.adapter.openSession(request, { ...f.options, restore: checkpoint });
    try {
      await expect(second.turn(request)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
      await second.turn({ ...request, requestId: 'r2' });
      expect(second.checkpoint.nativeSessionId).toBe(checkpoint.nativeSessionId);
      expect(f.launches[1]).toContain('--resume');
    } finally {
      await second.close();
    }
  });
  it('resumes a saved session after Claude Code updates itself', async () => {
    const f = await fixture();
    const first = await f.adapter.openSession(request, f.options);
    await first.turn(request);
    const checkpoint = first.checkpoint;
    await first.close();
    const second = await f.adapter.openSession(request, {
      ...f.options,
      observedVersion: '2.9.0',
      restore: checkpoint,
    });
    try {
      expect(second.checkpoint.nativeSessionId).toBe(checkpoint.nativeSessionId);
      expect(second.checkpoint.cliVersion).toBe('2.9.0');
      expect(f.launches[1]).toContain('--resume');
    } finally {
      await second.close();
    }
  });
  it.each(['instructions', 'model', 'account', 'uncertain'])(
    'refuses %s drift before starting a restored process',
    async (drift) => {
      const f = await fixture();
      const first = await f.adapter.openSession(request, f.options);
      await first.turn(request);
      const restore = first.checkpoint;
      await first.close();
      if (drift === 'account') f.changeAccount();
      await expect(
        f.adapter.openSession(
          {
            ...request,
            ...(drift === 'instructions' ? { instructions: 'changed' } : {}),
            ...(drift === 'model' ? { model: 'other' } : {}),
          },
          {
            ...f.options,
            observedVersion: CLAUDE_VERSION,
            restore: drift === 'uncertain' ? { ...restore, state: 'uncertain' } : restore,
          },
        ),
      ).rejects.toBeDefined();
      expect(f.launches).toHaveLength(1);
    },
  );
  it.each(['exit', 'unknown', 'missing', 'tools', 'reroute', 'permission', 'child', 'auth'])(
    'fails closed for %s with no successful observation',
    async (mode) => {
      const f = await fixture(mode);
      const session = await f.adapter.openSession(request, f.options);
      await expect(session.turn(request)).rejects.toBeDefined();
      expect(session.checkpoint.state).toBe('uncertain');
      await session.close();
    },
  );
  it('interrupts through native control and waits for the final boundary before another turn', async () => {
    const f = await fixture('hang');
    const session = await f.adapter.openSession(request, f.options);
    const turn = session.turn(request);
    const rejection = expect(turn).rejects.toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.interrupt();
    await rejection;
    expect(session.checkpoint.state).toBe('idle');
    await session.close();
  });
  it('does not mistake an interrupt acknowledgment for a final result; close unblocks both callers', async () => {
    const f = await fixture('no-result');
    const session = await f.adapter.openSession(request, f.options);
    const turn = session.turn(request);
    const rejection = expect(turn).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.interrupt();
    expect(session.checkpoint.state).toBe('busy');
    await session.close();
    await rejection;
    expect(session.checkpoint.state).toBe('uncertain');
  });
  it('stops a running turn gracefully and keeps the same live process for the next turn (H03)', async () => {
    const f = await fixture('hang');
    const session = await f.adapter.openSession(request, f.options);
    try {
      const turn = session.turn(request);
      const rejection = expect(turn).rejects.toMatchObject({ code: 'CANCELLED' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await session.stop(1000)).toBe('interrupted');
      await rejection;
      expect(session.checkpoint.state).toBe('idle');
      expect(f.launches).toHaveLength(1);
      expect((await f.received()).some((line) => line.request?.subtype === 'interrupt')).toBe(true);
    } finally {
      await session.close();
    }
  });
  it('takes an error-shaped result after an acknowledged interrupt as the stopped turn (H03)', async () => {
    const f = await fixture('interrupt-error');
    const session = await f.adapter.openSession(request, f.options);
    try {
      const turn = session.turn({ ...request });
      const rejection = expect(turn).rejects.toMatchObject({ code: 'CANCELLED' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await session.stop(1000)).toBe('interrupted');
      await rejection;
      expect(session.checkpoint.state).toBe('idle');
    } finally {
      await session.close();
    }
  });
  it('ends the process when a stopped turn does not finish within the grace, and says so (H03)', async () => {
    const f = await fixture('no-result');
    const session = await f.adapter.openSession(request, f.options);
    const turn = session.turn(request);
    const rejection = expect(turn).rejects.toMatchObject({ code: 'STOP_FORCED' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    expect(await session.stop(150)).toBe('killed');
    expect(Date.now() - started).toBeLessThan(1400);
    await rejection;
    // A turn ended by killing its process has an unknown outcome and is never resumed.
    expect(session.checkpoint.state).toBe('uncertain');
    expect(f.children[0].closed).toBe(true);
    await session.close();
  });
  it('refuses a stop when no turn is running (H03)', async () => {
    const f = await fixture();
    const session = await f.adapter.openSession(request, f.options);
    try {
      await expect(session.stop(100)).rejects.toMatchObject({ code: 'SESSION_IDLE' });
    } finally {
      await session.close();
    }
  });
  it('persists a busy checkpoint before dispatch and refuses recovery from that durable checkpoint', async () => {
    const f = await fixture();
    let release!: () => void;
    let saving!: () => void;
    const entered = new Promise<void>((resolve) => {
      saving = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let durable: ClaudeSessionCheckpoint | undefined;
    const session = await f.adapter.openSession(request, {
      ...f.options,
      onCheckpoint: async (value) => {
        durable = value;
        if (value.state === 'busy') {
          saving();
          await gate;
        }
      },
    });
    const turn = session.turn(request);
    await entered;
    expect((await f.received()).filter((frame) => frame.type === 'user')).toHaveLength(0);
    await expect(
      f.adapter.openSession(request, { ...f.options, restore: durable }),
    ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    release();
    await turn;
    expect(durable?.state).toBe('idle');
    await session.close();
    expect(f.children.every((child) => child.closed)).toBe(true);
  });
  it('rejects a failed checkpoint write without sending input or orphaning the child', async () => {
    const f = await fixture();
    const session = await f.adapter.openSession(request, {
      ...f.options,
      onCheckpoint: async () => {
        throw new Error('disk full');
      },
    });
    await expect(session.turn(request)).rejects.toMatchObject({ code: 'CHECKPOINT_FAILED' });
    expect((await f.received()).filter((frame) => frame.type === 'user')).toHaveLength(0);
    expect(f.children.every((child) => child.closed)).toBe(true);
  });
  it('unblocks a stalled checkpoint callback on shutdown and never sends its input later', async () => {
    const f = await fixture();
    let saving!: () => void;
    const entered = new Promise<void>((resolve) => {
      saving = resolve;
    });
    const session = await f.adapter.openSession(request, {
      ...f.options,
      onCheckpoint: async () => {
        saving();
        await new Promise(() => undefined);
      },
    });
    const turn = session.turn(request);
    const rejected = expect(turn).rejects.toBeDefined();
    await entered;
    await session.close();
    await rejected;
    expect((await f.received()).filter((frame) => frame.type === 'user')).toHaveLength(0);
    expect(f.children.every((child) => child.closed)).toBe(true);
  });
  it('forks into a distinct native ID while preserving the source lineage', async () => {
    const f = await fixture();
    const first = await f.adapter.openSession(request, f.options);
    await first.turn(request);
    const restore = first.checkpoint;
    await first.close();
    const input = { ...request, threadId: 'fork-thread', requestId: 'fork-request' };
    const fork = await f.adapter.openSession(input, { ...f.options, restore, fork: true });
    try {
      await fork.turn(input);
      expect(fork.nativeSession?.opaqueRef).not.toBe(restore.nativeSessionId);
      expect(fork.nativeSession?.lineageId).toBe(restore.lineageId);
      expect(fork.checkpoint.parentSessionId).toBe(restore.nativeSessionId);
      expect(f.launches[1]).toContain('--fork-session');
    } finally {
      await fork.close();
    }
  });
  it('deduplicates in-flight requests, rejects conflicting reuse, and keeps follow-up queueing with the runtime', async () => {
    const f = await fixture('hang');
    const session = await f.adapter.openSession(request, f.options);
    const first = session.turn(request);
    const second = session.turn(request);
    const rejected = Promise.all([
      expect(first).rejects.toBeDefined(),
      expect(second).rejects.toBeDefined(),
    ]);
    await expect(session.turn({ ...request, prompt: 'different' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(session.turn({ ...request, requestId: 'r2' })).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.close();
    await rejected;
    expect((await f.received()).filter((frame) => frame.type === 'user')).toHaveLength(1);
  });
  it('rechecks the same account before each turn and denies delayed permissions without granting a tool', async () => {
    const f = await fixture('permission');
    const session = await f.adapter.openSession(request, f.options);
    await expect(session.turn(request)).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
    expect(f.children.every((child) => child.closed)).toBe(true);
    const second = await f.adapter.openSession(request, f.options);
    f.changeAccount();
    await expect(second.turn(request)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(f.children.every((child) => child.closed)).toBe(true);
  });
  it('refuses corrupt session metadata before launch', async () => {
    const f = await fixture();
    await expect(
      f.adapter.openSession(request, {
        ...f.options,
        restore: { nativeSessionId: 'corrupt' } as ClaudeSessionCheckpoint,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(f.launches).toHaveLength(0);
  });
});
