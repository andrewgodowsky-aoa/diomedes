# Reasoning End to End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every conversation route that can supply an engine's thinking streams it live to the Console and saves the finished thinking with the reply.

**Architecture:** A third preview channel, `reasoning-delta`, sits beside `text-delta` and `tool-activity`. An adapter calls a raw `onReasoningDelta` sink that only EngineService hands it, and only on a route whose descriptor declares `streaming.reasoning: 'reasoning-delta'`. EngineService stamps, redacts and splits frames, publishes them through the same fenced queue as text, and collects one finished `ReasoningRecord`, which it attaches to the response outside the durable run record. The host emits `engine-reasoning` on `/api/events` and saves the record on the reply's `Turn.thinking`. The Console shows a Thinking section that folds to "Thought for 14s" when the answer starts.

**Tech Stack:** TypeScript, zod 4, Express, React, AI SDK `ai` 7.0.107 with `@ai-sdk/openai` 4.0.71, `@ai-sdk/azure` 4.0.75, `@ai-sdk/google-vertex` 5.0.90 and `@openrouter/ai-sdk-provider` 3.1.0, vitest 3.2.7, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-27-engine-conversations-and-reasoning-design.md`, Part 2. Plan 2 (`docs/superpowers/plans/2026-09-27-engine-conversations.md`) covers Part 1 and the ChatGPT (Codex) thinking producer, which needs the Codex kept session.

## Global Constraints

- `ADAPTER_CONTRACT_VERSION` stays `1`. No saved record parses a route descriptor again (checked 2026-09-27), so every descriptor gains `streaming.reasoning` in one change.
- A thinking frame carries at most 64 KiB of UTF-8 text (`REASONING.maxChunkBytes`). A longer chunk is split, never refused.
- Saved thinking is redacted and holds at most 32 KiB of UTF-8 (`REASONING.maxSavedBytes`). Past that it is cut on a character boundary and marked `shortened`. Turns written before 2026-09-27 have no `thinking`.
- Thinking never fails a reply. It is never retried, and it is dropped once the request aborts.
- Saved thinking never leaves the reply. It is never in the run record, the carried history (`carriedFrom`), a model-API context, any engine or a cloud share.
- A route that declares `none` never receives `onReasoningDelta`. A caller-supplied `onReasoningDelta` is refused with `PREVIEW_CONTRACT`.
- Build and Fix (Work) runs, texting the Nectovia bot and the phone apps get no thinking.
- No version equality gate for any engine (decision of 2026-09-23).
- `server/app.ts` is an integrator-owned hot file. Check claims with `scripts/coordination.ts status` before editing it (spec section 8).
- The gateway change in `services/control-plane` deploys the Worker. Commit it locally; never deploy, push or merge it without Andrew's approval.
- Heavy commands (vitest, tsc, vite build, Playwright, npm ci) run only under the heavy slot, one at a time:
  - take: `node services/control-plane/node_modules/tsx/dist/cli.mjs scripts/coordination.ts slot --role opus --pid <claude pid> --worktree F:/Diomedes/diomedes-wt/codex-conversation-driver --purpose "<what>" --node codex-conversation-driver`
  - release: `... unslot --role opus --pid <claude pid> --worktree <same> --slot <slotId>`
  - Before the first `tsx` call in this worktree, run it from `F:/Diomedes/diomedes-wt/free-harness-paid-agent`, whose `services/control-plane/node_modules` exists.
- This worktree has no `node_modules`. Before the first test, under the slot: `npm ci` at the root, then `npm ci` in `services/control-plane`.
- Commit locally on `feature/codex-conversation-driver` after every task (Andrew, 2026-09-27: "commit locally in case it goes again"). No Co-Authored-By or AI trailer. Push and merge need Andrew's approval.
- Copy: plain words, contractions, no dashes in sentences a person reads. The fold line reads "Thought for 14s", or "Thought for a moment" under 1.5 s. A cut record ends with "Shortened to fit."
- Standing design decisions 4 and 5: the Thinking section never repeats the waiting line or the reply, and its text wraps.

## Review Focus

1. **A secret split across two thinking chunks.** Per-chunk redaction can miss it in the live frames, but the saved record must be redacted as one piece. Pinned in Task 1 ("keeps the whole text, redacted as one piece").
2. **A replayed command.** Sending the same Home message id again answers from the record: no new thinking frames, and the saved turn's thinking unchanged. Pinned in Task 2.
3. **Thinking, then a failure with no answer.** No turn carries orphan thinking, and the live section clears when the reply ends. Pinned in Task 2 (server) and Task 8 (reducer).
4. **A chunk that is a lone surrogate or only control characters.** No crash, and no empty frame. Pinned in Task 1.
5. **Thinking longer than 32 KiB.** It is saved shortened, and the Console says "Shortened to fit." Pinned in Task 1 (sink) and Task 8 (component).

## File map

| File | Responsibility | Task |
|---|---|---|
| `shared/adapter-contract.ts` | `REASONING`, `reasoningPreviewSchema`, `ReasoningRecord`, `ReasoningSink`, `reasoningSink`; `streaming.reasoning` in the descriptor schema | 1 |
| `server/engines/contract.ts` | `TextRequest.onReasoning`, `TextRequest.onReasoningDelta`, `TextResponse.reasoning` | 1 |
| `shared/types.ts` | `Turn.thinking` | 1 |
| `server/harness/route-contract.ts`, `server/harness/model-api-adapter.ts`, `server/durable-controls-fixture.ts` | every descriptor declares reasoning | 1, 3–6 |
| `server/harness/conformance.ts` | check `reasoning-needs-live-channel` | 1 |
| `server/engines/service.ts` | wraps the sink at every conversation site, attaches `reasoning` | 2 |
| `server/harness/claude-session-run.ts`, `server/harness/model-session-run.ts`, `server/engines/model-api-core.ts` | carry the raw sink to the turn | 2 |
| `server/app.ts`, `server/interaction-service.ts` | `engine-reasoning` events, `Turn.thinking` | 2 |
| `server/engines/claude.ts`, `server/engines/claude-session.ts` | Claude producer | 3 |
| `server/engines/acp-client.ts`, `server/engines/cursor.ts`, `server/engines/devin.ts` | ACP producer | 4 |
| `server/engines/opencode.ts` | OpenCode producer | 5 |
| `server/engines/model-api-core.ts`, `aws-bedrock.ts`, `azure-openai.ts`, `google-vertex.ts`, `openrouter.ts` | model-API producer and requests | 6 |
| `server/engines/nectovia.ts`, `server/accounts/client.ts`, `services/control-plane/src/managed-inference.ts`, `services/control-plane/src/commercial.ts` | Nectovia route and gateway | 7 |
| `client/console/engine-reasoning.ts`, `client/console/live-reply.ts`, `client/console/Thinking.tsx`, `client/console/console.css`, `DiomedesHome.tsx`, `Diomedes.tsx`, `Shell.tsx`, `ThreadView.tsx` | Console | 8 |
| `tests/reasoning-conformance.test.ts`, docs | conformance and records | 9 |

---

### Task 1: The thinking contract

**Files:**
- Modify: `shared/adapter-contract.ts` (new section after `activitySink`; `streaming` in `adapterRouteContractSchema`)
- Modify: `server/engines/contract.ts` (`TextRequest`, `TextResponse`)
- Modify: `shared/types.ts:486` (`Turn`)
- Modify: `server/harness/route-contract.ts` (every `streaming` literal), `server/harness/model-api-adapter.ts:61`, `server/durable-controls-fixture.ts:43`, `tests/h01-conformance.test.ts:77,114,160`
- Modify: `server/harness/conformance.ts` (after `streaming-matches-mode`)
- Test: `tests/reasoning-contract.test.ts` (new)

**Interfaces:**
- Consumes: `utf8Bytes`, `transientPreviewSchema` field shapes in `shared/adapter-contract.ts`.
- Produces:
  - `REASONING: { maxChunkBytes: 65536; maxSavedBytes: 32768 }`
  - `reasoningPreviewSchema` and `type ReasoningPreview` (`kind: 'reasoning-delta'`, the seven identity fields, `seq` positive, `text` 1 char to 64 KiB)
  - `interface ReasoningRecord { text: string; ms: number; shortened: boolean }`
  - `interface ReasoningSink { (raw: string): void; finish(): ReasoningRecord | null }`
  - `reasoningSink(options: { identity; redact?; onReasoning?: (frame: ReasoningPreview) => void; signal?: AbortSignal; now?: () => number }): ReasoningSink`
  - `AdapterRouteContract['streaming']['reasoning']: 'reasoning-delta' | 'none'`
  - `MODEL_API_STREAMING` exported from `server/harness/model-api-adapter.ts`
  - `TextRequest.onReasoning?: (frame: ReasoningPreview) => void`, `TextRequest.onReasoningDelta?: (text: string) => void`, `TextResponse.reasoning?: ReasoningRecord`
  - `Turn.thinking?: ReasoningRecord`

- [ ] **Step 1: Write the failing test**

Create `tests/reasoning-contract.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  REASONING,
  adapterRouteContractSchema,
  reasoningPreviewSchema,
  reasoningSink,
  type ReasoningPreview,
} from '../shared/adapter-contract.js';
import { contractChecks } from '../server/harness/conformance.js';
import { ROUTE_CONTRACTS, routeContractFor } from '../server/harness/route-contract.js';
import { MODEL_API_STREAMING, modelApiContract } from '../server/harness/model-api-adapter.js';

const identity = {
  projectId: 'P1',
  threadId: 'T1',
  requestId: 'R1',
  runId: 'run-1',
  stepId: 'text:dispatch',
  attempt: 1,
  fence: 1,
};
/** A clock that answers each call with the next time given, then keeps the last. */
const clock = (...times: number[]) => {
  let at = 0;
  return () => times[Math.min(at++, times.length - 1)];
};

describe('thinking frames', () => {
  test('stamp the run identity and a dense sequence from 1', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, onReasoning: (frame) => frames.push(frame) });
    sink('Weighing the menu. ');
    sink('Checking prices.');
    expect(frames.map((frame) => [frame.kind, frame.seq, frame.text])).toEqual([
      ['reasoning-delta', 1, 'Weighing the menu. '],
      ['reasoning-delta', 2, 'Checking prices.'],
    ]);
    expect(frames.every((frame) => reasoningPreviewSchema.safeParse(frame).success)).toBe(true);
    expect(frames[0]).toMatchObject(identity);
  });

  test('a chunk over the frame budget is split, never inside a character', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, onReasoning: (frame) => frames.push(frame) });
    const big = `${'a'.repeat(REASONING.maxChunkBytes - 1)}😀${'b'.repeat(10)}`;
    sink(big);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(frames.map((frame) => frame.text).join('')).toBe(big);
    expect(frames[1].text.startsWith('😀')).toBe(true);
  });

  test('each frame is redacted and stripped of control characters; an empty result sends nothing', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({
      identity,
      redact: (text) => text.replaceAll('sk-live-1', '[redacted]'),
      onReasoning: (frame) => frames.push(frame),
    });
    sink('key sk-live-1\u0007 found\u202e');
    sink('\u0001\u0002');
    sink('');
    expect(frames.map((frame) => frame.text)).toEqual(['key [redacted] found']);
  });

  test('a lone surrogate or control characters never crash the sink', () => {
    const frames: ReasoningPreview[] = [];
    const sink = reasoningSink({ identity, onReasoning: (frame) => frames.push(frame) });
    expect(() => sink('\ud83d')).not.toThrow();
    expect(() => sink('\u0000\u0008')).not.toThrow();
    expect(frames.every((frame) => frame.text.length > 0)).toBe(true);
    expect(frames.length).toBeLessThanOrEqual(1);
  });

  test('nothing is sent or kept after the request is stopped', () => {
    const frames: ReasoningPreview[] = [];
    const control = new AbortController();
    const sink = reasoningSink({ identity, signal: control.signal, onReasoning: (frame) => frames.push(frame) });
    control.abort();
    sink('late');
    expect(frames).toHaveLength(0);
    expect(sink.finish()).toBeNull();
  });

  test('a presenter that throws never fails the producer', () => {
    const sink = reasoningSink({
      identity,
      onReasoning: () => {
        throw new Error('the screen went away');
      },
    });
    expect(() => sink('still fine')).not.toThrow();
    expect(sink.finish()?.text).toBe('still fine');
  });
});

describe('the finished thinking', () => {
  test('is null when no thinking came', () => {
    expect(reasoningSink({ identity }).finish()).toBeNull();
  });

  test('keeps the whole text, redacted as one piece, with how long it ran', () => {
    const sink = reasoningSink({
      identity,
      redact: (text) => text.replaceAll('sk-live-12', '[redacted]'),
      now: clock(1_000, 1_500, 15_000),
    });
    sink('The key is sk-li');
    sink('ve-12, so ');
    expect(sink.finish()).toEqual({ text: 'The key is [redacted], so', ms: 14_000, shortened: false });
  });

  test('is cut at 32 KiB on a character boundary and marked shortened', () => {
    const sink = reasoningSink({ identity });
    sink('é'.repeat(REASONING.maxSavedBytes));
    const record = sink.finish()!;
    expect(new TextEncoder().encode(record.text).byteLength).toBeLessThanOrEqual(REASONING.maxSavedBytes);
    expect(record.text).toBe('é'.repeat(REASONING.maxSavedBytes / 2));
    expect(record.shortened).toBe(true);
  });

  test('stops keeping raw text past its bound and still says it was shortened', () => {
    const sink = reasoningSink({ identity });
    for (let index = 0; index < 10; index += 1) sink('x'.repeat(REASONING.maxSavedBytes));
    const record = sink.finish()!;
    expect(record.text).toHaveLength(REASONING.maxSavedBytes);
    expect(record.shortened).toBe(true);
  });
});

describe('route descriptors declare thinking', () => {
  test('the descriptor schema requires streaming.reasoning', () => {
    const contract = routeContractFor('claude-code');
    const { reasoning: _reasoning, ...streaming } = contract.streaming;
    expect(adapterRouteContractSchema.safeParse({ ...contract, streaming }).success).toBe(false);
    expect(adapterRouteContractSchema.safeParse(contract).success).toBe(true);
  });

  test('every registered route and every model-API route declares it', () => {
    for (const contract of Object.values(ROUTE_CONTRACTS))
      expect(['reasoning-delta', 'none']).toContain(contract.streaming.reasoning);
    const model = modelApiContract({ routeId: 'aws-bedrock', sdk: 'ai@7', protocol: 'responses', label: 'AWS Bedrock' });
    expect(model.streaming).toEqual(MODEL_API_STREAMING);
  });

  test('a route cannot stream thinking without a live text channel', () => {
    const sample = routeContractFor('sample');
    const checks = contractChecks({ ...sample, streaming: { ...sample.streaming, reasoning: 'reasoning-delta' } });
    expect(checks.find((item) => item.id === 'reasoning-needs-live-channel')?.outcome).toBe('failed');
    const passing = contractChecks(routeContractFor('claude-code'));
    expect(passing.find((item) => item.id === 'reasoning-needs-live-channel')?.outcome).toBe('passed');
  });
});
```

- [ ] **Step 2: Install, then run the test to see it fail**

Under the heavy slot (see Global Constraints), in this worktree: `npm ci`, then `npm ci --prefix services/control-plane`.
Run: `npx vitest run tests/reasoning-contract.test.ts`
Expected: FAIL. `reasoningSink` and `REASONING` are not exported.

- [ ] **Step 3: Add the thinking channel to `shared/adapter-contract.ts`**

Insert after `activitySink` (before `// --- cursor semantics`):

```ts
// --- live thinking ---------------------------------------------------------------------------

/** The thinking channel: live frames while it streams, then one finished record for the reply. */
export const REASONING = Object.freeze({
  /** One thinking frame's text budget, in UTF-8 bytes. A longer chunk is split, never refused. */
  maxChunkBytes: 64 * 1024,
  /** The most finished thinking one reply keeps, in UTF-8 bytes. Past it the text is cut and marked. */
  maxSavedBytes: 32 * 1024,
});

/** How much raw thinking a sink holds for the finished record; the saved text is cut far sooner. */
const MAX_RAW_REASONING_CHARS = 4 * REASONING.maxSavedBytes;

/**
 * One live thinking frame: a preview like `text-delta`, stamped with the same run identity and
 * its own dense sequence. Never persisted; the reply keeps one finished record instead.
 */
export const reasoningPreviewSchema = z.strictObject({
  kind: z.literal('reasoning-delta'),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  requestId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  stepId: z.string().min(1).max(200),
  attempt: z.number().int().positive(),
  fence: z.number().int().positive(),
  seq: z.number().int().positive(),
  text: z
    .string()
    .min(1)
    .refine((text) => utf8Bytes(text) <= REASONING.maxChunkBytes, {
      message: `A thinking frame may carry at most ${REASONING.maxChunkBytes} UTF-8 bytes.`,
    }),
});
export type ReasoningPreview = z.infer<typeof reasoningPreviewSchema>;

/** The finished thinking of one reply, as the reply keeps it (`Turn.thinking`). */
export interface ReasoningRecord {
  /** Redacted as one piece, at most `REASONING.maxSavedBytes` UTF-8 bytes. */
  text: string;
  /** From the attempt's start to its last thinking chunk. */
  ms: number;
  /** True when the text was cut to fit. */
  shortened: boolean;
}

/** The adapter-facing raw thinking sink, and the finished record it collected. */
export interface ReasoningSink {
  (raw: string): void;
  /** The finished thinking, or null when none came. Read it once the attempt has ended. */
  finish(): ReasoningRecord | null;
}

/** Control characters and bidirectional overrides. Line breaks and tabs stay. */
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e]/g;

/** A character's UTF-8 size. A lone surrogate is encoded as U+FFFD, three bytes. */
const charBytes = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};

/** Pieces of at most `max` UTF-8 bytes, never splitting a character. */
function splitBytes(text: string, max: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const char of text) {
    const size = charBytes(char);
    if (piece && bytes + size > max) {
      pieces.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * The producer half of the thinking channel, the sibling of `activitySink`. Each chunk becomes
 * one or more stamped frames: redacted, stripped of control characters and split to the frame
 * budget. Unlike the answer, thinking never fails anything: a frame that still does not parse is
 * dropped, a presenter that throws is ignored, and everything after the signal aborts is dropped.
 * `finish` gives the whole thinking redacted as one piece, so a secret split across two chunks is
 * still caught, cut to `REASONING.maxSavedBytes`.
 */
export function reasoningSink(options: {
  readonly identity: {
    readonly projectId: string;
    readonly threadId: string;
    readonly requestId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly attempt: number;
    readonly fence: number;
  };
  readonly redact?: (text: string) => string;
  readonly onReasoning?: (frame: ReasoningPreview) => void;
  readonly signal?: AbortSignal;
  /** The clock, replaceable in tests. */
  readonly now?: () => number;
}): ReasoningSink {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let seq = 0;
  let raw = '';
  let overflow = false;
  let lastAt: number | null = null;
  const clean = (text: string) =>
    (options.redact ? options.redact(text) : text).replace(UNSAFE_CHARACTERS, '');
  const sink = ((chunk: string) => {
    if (options.signal?.aborted || typeof chunk !== 'string' || !chunk) return;
    lastAt = now();
    const room = MAX_RAW_REASONING_CHARS - raw.length;
    if (chunk.length > room) overflow = true;
    if (room > 0) raw += chunk.slice(0, room);
    for (const text of splitBytes(clean(chunk), REASONING.maxChunkBytes)) {
      const parsed = reasoningPreviewSchema.safeParse({
        kind: 'reasoning-delta',
        ...options.identity,
        seq: seq + 1,
        text,
      });
      if (!parsed.success) continue;
      seq += 1;
      try {
        options.onReasoning?.(parsed.data);
      } catch {
        // Thinking is narration: a presenter's failure never reaches the answer.
      }
    }
  }) as ReasoningSink;
  sink.finish = () => {
    if (lastAt === null) return null;
    const whole = clean(raw).trim();
    if (!whole) return null;
    const [kept = ''] = splitBytes(whole, REASONING.maxSavedBytes);
    const text = kept.replace(/[\ud800-\udbff]$/, '');
    return {
      text,
      ms: Math.max(0, lastAt - startedAt),
      shortened: overflow || text.length < whole.length,
    };
  };
  return sink;
}
```

In `adapterRouteContractSchema`, change `streaming` to:

```ts
  streaming: z.strictObject({
    transientPreview: z.enum(['text-delta', 'none']),
    /**
     * `reasoning-delta`: the route can stream an engine's thinking as its own preview frames
     * (`reasoningSink`). `none`: it never does, and EngineService never hands it the sink.
     */
    reasoning: z.enum(['reasoning-delta', 'none']),
    /**
     * `run-record` — the run service writes the stream. `host-record` — the
     * caller persists one outcome (History, Need) with no event stream.
     * `none` — nothing durable.
     */
    durableEvents: z.enum(['run-record', 'host-record', 'none']),
  }),
```

- [ ] **Step 4: Declare `none` on every descriptor**

In `server/harness/route-contract.ts`, give every `streaming` literal a `reasoning: 'none'` key between `transientPreview` and `durableEvents`, for example `{ transientPreview: 'text-delta', reasoning: 'none', durableEvents: 'run-record' }`. That is the `ACP_SESSION_CONTRACT` literal and every entry of `ROUTE_CONTRACTS`. Do the same in `server/durable-controls-fixture.ts:43` and in the three inline descriptors of `tests/h01-conformance.test.ts` (lines 77, 114, 160).

In `server/harness/model-api-adapter.ts`, add above `modelApiContract`:

```ts
/**
 * What every model-API route streams: text previews, its model's thinking where the provider
 * returns it (model-api-core.ts), and the run record. One declaration, read by EngineService.
 */
export const MODEL_API_STREAMING: AdapterRouteContract['streaming'] = Object.freeze({
  transientPreview: 'text-delta',
  reasoning: 'none',
  durableEvents: 'run-record',
});
```

and in `modelApiContract` replace the `streaming:` line with `streaming: { ...MODEL_API_STREAMING },`.

Then find any descriptor this missed:
Run: `git grep -n "durableEvents:" -- server tests shared`
Expected: every hit is on a line that also has `reasoning:`, except the schema line in `shared/adapter-contract.ts`.

- [ ] **Step 5: Add the conformance check**

In `server/harness/conformance.ts`, after the `streaming-matches-mode` check:

```ts
  checks.push(
    check(
      'reasoning-needs-live-channel',
      contract.streaming.reasoning === 'none' || contract.streaming.transientPreview === 'text-delta',
      contract.streaming.reasoning === 'none'
        ? 'The route streams no thinking.'
        : 'Thinking streams beside a live text preview.',
    ),
  );
```

- [ ] **Step 6: Add the request, response and turn fields**

In `server/engines/contract.ts`, import `ReasoningPreview` and `ReasoningRecord` from `../../shared/adapter-contract.js` beside `TransientPreview`. After `onToolActivity` in `TextRequest`:

```ts
  /**
   * Caller-facing thinking: stamped, redacted, byte-bounded frames from `reasoningSink` in
   * shared/adapter-contract.ts. A preview only; the reply keeps one finished record instead.
   */
  onReasoning?: (frame: ReasoningPreview) => void;
  /**
   * Adapter-facing raw thinking sink, set only by EngineService when it wraps `onReasoning` on a
   * route that declares `streaming.reasoning: 'reasoning-delta'`. A caller-supplied one is
   * refused, as `onDelta` is. An adapter calls it with each thinking chunk; thinking never
   * joins the answer and never fails it.
   */
  onReasoningDelta?: (text: string) => void;
```

In `TextResponse`, after `requestId`:

```ts
  /**
   * The finished thinking, set only by EngineService from what this attempt streamed. It is
   * never part of the run record, so a replayed answer has none.
   */
  reasoning?: ReasoningRecord;
```

In `shared/types.ts`, inside `Turn` after `context?`:

```ts
  /**
   * The thinking the engine showed before this reply: redacted, at most 32 KiB, cut and marked
   * when longer. Only the person reads it; it is never sent to an engine, carried into another
   * conversation or shared. Absent on turns written before 2026-09-27 and where none came.
   */
  thinking?: import('./adapter-contract.js').ReasoningRecord;
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run tests/reasoning-contract.test.ts tests/h01-conformance.test.ts tests/h01-adapter-contract.test.ts tests/h20-route-matrix.test.ts tests/tool-activity-contract.test.ts`
Expected: PASS. If `h20-route-matrix` reports that `docs/verification/2026-09-25-route-matrix.json` drifted, regenerate it with the command named in that test's failure message and include the file in the commit.

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add shared/adapter-contract.ts shared/types.ts server/engines/contract.ts server/harness/route-contract.ts server/harness/model-api-adapter.ts server/harness/conformance.ts server/durable-controls-fixture.ts tests/reasoning-contract.test.ts tests/h01-conformance.test.ts
git commit -m "Add the thinking channel to the adapter contract"
```

---

### Task 2: EngineService, both drivers and the host

**Files:**
- Modify: `server/engines/service.ts` (imports; PREVIEW_CONTRACT refusals at ~1591, 1830, 2189, 2247, 2397; `generate` text dispatch ~1694-1718; `nativeTurn` ~1814-1936; `modelSession` ~2184-2234; `fencedSinks` ~2893)
- Modify: `server/harness/claude-session-run.ts` (`preview` type at 209-217; `openNative` at 1068-1080; `turn` call at 1183-1192; every other `onPreview: undefined`)
- Modify: `server/harness/model-session-run.ts` (`activity` type at 172-175; sinks at 810-819)
- Modify: `server/engines/model-api-core.ts:574` (`StreamSinks`)
- Modify: `server/interaction-service.ts:219-222,414-419`
- Modify: `server/app.ts` (~3956 and ~4016 opt-in session route; ~4745 conversation; ~4839-4895 projection; ~5577 and ~5755 direct Ask; ~5823-5843 events)
- Test: `tests/live-reasoning-server.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `reasoningSink`, `ReasoningSink`, `ReasoningRecord`, `ReasoningPreview`, `MODEL_API_STREAMING`, `TextRequest.onReasoning`, `TextRequest.onReasoningDelta`, `TextResponse.reasoning`, `Turn.thinking`.
- Produces:
  - `ClaudeSessionTurn.preview(...)` returns `{ onDelta; onToolActivity?; onReasoningDelta?: (text: string) => void; finish }`
  - `ModelSessionTurn.activity(...)` returns `{ onDelta; onToolActivity; onReasoningDelta?(text: string): void; finish }`
  - `StreamSinks.onReasoningDelta?: (text: string) => void`
  - `InteractionHost.project(resolved, result: { runId; text; model; version; thinking?: ReasoningRecord })`
  - Store event `engine-reasoning` whose data is a `ReasoningPreview`, forwarded verbatim on `/api/events` as event `engine-reasoning`.

- [ ] **Step 1: Check the hot-file claim**

Run (from `F:/Diomedes/diomedes-wt/free-harness-paid-agent`): `node services/control-plane/node_modules/tsx/dist/cli.mjs scripts/coordination.ts status --role opus --pid <claude pid>`
Expected: no active claim lists `server/app.ts`, `server/engines/service.ts` or `server/interaction-service.ts`. If one does, stop and tell Andrew.

- [ ] **Step 2: Write the failing test**

Create `tests/live-reasoning-server.test.ts`:

```ts
/**
 * Live thinking reaches the events stream and the saved reply on both conversation surfaces.
 *
 * Real `createApp`, real `EngineService`, real RunService and Store events. Only the provider
 * transport is scripted: it reports thinking through the adapter-facing `onReasoningDelta` sink
 * that EngineService alone hands it, and only on a route whose descriptor declares thinking.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type {
  PersistentTextAdapter,
  TextEngineAdapter,
  TextRequest,
} from '../server/engines/contract.js';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { hash, type Store } from '../server/store.js';
import { reasoningPreviewSchema, type AdapterRouteContract } from '../shared/adapter-contract.js';
import type { IntegrationStatus, Turn } from '../shared/types.js';

const ENGINE = 'claude-code' as const;
const VERSION = TESTED_VERSIONS[ENGINE];
const ACCOUNT = 'claude-code:claude.ai';
const MODEL = 'sonnet';
const SECRET = 'sk-live-thinking-1234';
const THOUGHT = 'Weighing the menu. ';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

type Frame = Record<string, unknown> & { channel: 'text' | 'reasoning' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base = '';
let frames: Frame[];
let seen: TextRequest[];

const store = (): Store => app!.locals.store;

/** The same descriptor, declaring whether the route streams thinking. */
const declaring = (
  contract: AdapterRouteContract,
  reasoning: 'reasoning-delta' | 'none',
): AdapterRouteContract => ({ ...contract, streaming: { ...contract.streaming, reasoning } });

const installed: IntegrationStatus = {
  id: ENGINE,
  name: 'Claude Code',
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Found',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  installedVersion: VERSION,
  location: process.execPath,
  disclosure: [],
};
const inspect = async () => ({
  authentication: 'signed-in' as const,
  accountRoute: ACCOUNT,
  detail: 'Fixture only',
  models: [{ slug: MODEL, name: MODEL, description: '', efforts: [], defaultEffort: null }],
});

/** The provider's scripted work: two thinking chunks, one holding a secret, then the answer. */
function think(input: TextRequest) {
  input.onReasoningDelta?.(THOUGHT);
  input.onReasoningDelta?.(`The key ${SECRET} is not needed.`);
  input.onDelta?.('Soup and bread.');
}

async function open(adapter: TextEngineAdapter) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-reasoning-'));
  frames = [];
  seen = [];
  const engines = new EngineService(path.join(root, 'data', 'engines'), {
    discover: async () => [installed],
    version: async () => VERSION,
    adapter: () => adapter,
    redactFor: () => (text: string) => text.replaceAll(SECRET, '[redacted]'),
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('No native work runs in this fixture');
    },
  } as Parameters<typeof createApp>[0]);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store().on('engine-text', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'text' }),
  );
  store().on('engine-reasoning', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'reasoning' }),
  );
}

afterEach(async () => {
  if (!server) return;
  const closingApp = app!, closingServer = server, closingRoot = root;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(closingRoot, { recursive: true, force: true });
});

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

/** Files under `dir` that hold `marker` anywhere except inside a `thinking` field. */
async function leaks(dir: string, marker: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (!text.includes(marker)) continue;
    let outside = true;
    try {
      outside = JSON.stringify(
        JSON.parse(text, (key, value) => (key === 'thinking' ? undefined : value)),
      ).includes(marker);
    } catch {
      // Not one JSON document (a journal, a log): holding the thinking at all is a leak.
    }
    if (outside) found.push(path.relative(dir, file));
  }
  return found;
}

const replies = (projectId: string): Turn[] =>
  store()
    .state(projectId)
    .conversations.flatMap((conversation) => conversation.turns)
    .filter((turn) => turn.role === 'assistant');

describe('thread Ask on an external engine', () => {
  const adapter = (
    reasoning: 'reasoning-delta' | 'none',
    work: (input: TextRequest) => void = think,
  ): TextEngineAdapter => ({
    id: ENGINE,
    contract: declaring(routeContractFor(ENGINE), reasoning),
    inspect,
    generate: async (input) => {
      seen.push(input);
      work(input);
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'Soup and bread.',
      };
    },
  });

  async function ask(expectOk = true) {
    const project = await store().locked(() => store().createProject('Live thinking'));
    store().settings.services = {
      'claude-code': true,
      'claude-codeModel': MODEL,
      'claude-codeAccountRoute': ACCOUNT,
    };
    await store().saveSettings(store().settings);
    await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0,
      routes: ['claude-code'],
      documents: [],
      shareConversationHistory: false,
      shareReviewPackets: false,
    });
    const response = await fetch(`${base}/api/projects/${project.id}/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'What is on the menu?', route: ENGINE, mode: 'ask', consent: true }),
    });
    if (expectOk) expect(response.ok, await response.clone().text()).toBe(true);
    return project;
  }

  test('thinking streams as its own frames, bound to the answer run, ahead of the answer', async () => {
    await open(adapter('reasoning-delta'));
    const project = await ask();
    expect(
      frames.map((frame) =>
        frame.channel === 'text' ? `text:${String(frame.kind)}` : `think:${String(frame.seq)}`,
      ),
    ).toEqual(['text:started', 'think:1', 'think:2', 'text:delta', 'text:ended']);
    const delta = frames.find((frame) => frame.channel === 'text' && frame.kind === 'delta')!;
    for (const frame of frames.filter((item) => item.channel === 'reasoning')) {
      const { channel: _channel, ...wire } = frame;
      expect(reasoningPreviewSchema.safeParse(wire).success).toBe(true);
      expect(frame).toMatchObject({
        kind: 'reasoning-delta',
        projectId: project.id,
        runId: delta.runId,
        stepId: delta.stepId,
        attempt: delta.attempt,
        fence: delta.fence,
      });
    }
    expect(frames.filter((frame) => frame.channel === 'reasoning').map((frame) => frame.text)).toEqual([
      THOUGHT,
      'The key [redacted] is not needed.',
    ]);
    const reply = replies(project.id).at(-1)!;
    expect(reply.text).toBe('Soup and bread.');
    expect(reply.thinking).toMatchObject({
      text: 'Weighing the menu. The key [redacted] is not needed.',
      shortened: false,
    });
    expect(reply.thinking!.ms).toBeGreaterThanOrEqual(0);
    // The adapter got the raw sink and never the caller's frame channel.
    expect(typeof seen[0].onReasoningDelta).toBe('function');
    expect(seen[0].onReasoning).toBeUndefined();
  });

  test('a route that declares no thinking never gets the sink and saves none', async () => {
    await open(adapter('none'));
    const project = await ask();
    expect(frames.some((frame) => frame.channel === 'reasoning')).toBe(false);
    expect(seen[0].onReasoningDelta).toBeUndefined();
    expect(replies(project.id).at(-1)!.thinking).toBeUndefined();
  });

  test('thinking and then a failure leaves no turn holding thinking', async () => {
    await open(
      adapter('reasoning-delta', (input) => {
        input.onReasoningDelta?.(THOUGHT);
        throw Object.assign(new Error('The provider stopped.'), { code: 'PROVIDER_ERROR' });
      }),
    );
    const project = await ask(false);
    expect(replies(project.id).some((turn) => turn.thinking !== undefined)).toBe(false);
  });

  test('a caller cannot hand the adapter-facing thinking sink in directly', async () => {
    await open(adapter('reasoning-delta'));
    const service = new EngineService(path.join(root, 'data', 'engines-direct'), {
      discover: async () => [installed],
      version: async () => VERSION,
      adapter: () => adapter('reasoning-delta'),
    });
    service.dispatch = async () => {
      throw new Error('never dispatched');
    };
    await expect(
      service.generate(ENGINE, {
        projectId: 'P1',
        threadId: 'T1',
        requestId: 'R1',
        prompt: 'x',
        documents: [],
        instructions: '',
        model: MODEL,
        accountRoute: ACCOUNT,
        onReasoningDelta: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTRACT' });
    expect(seen).toHaveLength(0);
  });
});

describe('the Diomedes conversation driver', () => {
  const sessionAdapter = (): PersistentTextAdapter<ClaudeSessionCheckpoint> => ({
    id: ENGINE,
    contract: routeContractFor(ENGINE),
    sessionContract: declaring(routeContractFor('claude-code-session'), 'reasoning-delta'),
    inspect,
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = {
        version: 1,
        nativeSessionId: randomUUID(),
        lineageId: randomUUID(),
        parentSessionId: null,
        projectId: input.projectId,
        threadId: input.threadId,
        cwd: root,
        cliVersion: VERSION,
        accountDigest: hash('fixture-account')!,
        requestedModel: input.model,
        reportedModel: null,
        instructionDigest: hash(input.instructions)!,
        state: 'idle',
        requests: [],
        results: [],
      };
      const signal = new AbortController().signal;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return {
            providerId: 'claude-code' as const,
            lineageId: checkpoint.lineageId,
            opaqueRef: checkpoint.nativeSessionId!,
          };
        },
        turn: async (turn) => {
          seen.push(turn);
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          think(turn);
          const text = 'Soup and bread.';
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: MODEL,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model: MODEL,
            version: VERSION,
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      };
    },
  });

  test('a home message streams thinking and keeps it only on the saved reply', async () => {
    await open(sessionAdapter());
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: ENGINE, model: MODEL });
    const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST');
    await api(`/projects/${home.projectId}/threads/${home.threadId}`, 'PUT', { engine: ENGINE });
    const message = {
      commandId: 'm-think',
      text: 'What is on the menu?',
      mode: 'ask',
      sources: [],
      consent: true,
    };
    await api(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', message);
    const reasoning = frames.filter((frame) => frame.channel === 'reasoning');
    expect(reasoning.map((frame) => frame.text)).toEqual([THOUGHT, 'The key [redacted] is not needed.']);
    expect(reasoning[0]).toMatchObject({
      projectId: home.projectId,
      threadId: home.threadId,
      requestId: 'm-think',
    });
    const thread = () =>
      store().state(home.projectId).conversations.find((item) => item.id === home.threadId)!;
    const saved = thread().turns.at(-1)!;
    expect(saved).toMatchObject({
      role: 'assistant',
      thinking: { text: 'Weighing the menu. The key [redacted] is not needed.', shortened: false },
    });
    expect(typeof seen[0].onReasoningDelta).toBe('function');
    expect(seen[0].onReasoning).toBeUndefined();
    // The run record, the carried history and every other saved file never hold the thinking.
    expect(await leaks(path.join(root, 'data'), THOUGHT.trim())).toEqual([]);

    // The same message again is answered from the record: no new frames, nothing rewritten.
    const before = { frames: frames.length, turns: thread().turns.length };
    await api(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', message);
    expect(frames.filter((frame) => frame.channel === 'reasoning')).toHaveLength(2);
    expect(frames.length - before.frames).toBeLessThanOrEqual(2);
    expect(thread().turns).toHaveLength(before.turns);
    expect(thread().turns.at(-1)!.thinking).toEqual(saved.thinking);
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run (under the slot): `npx vitest run tests/live-reasoning-server.test.ts`
Expected: FAIL. No `engine-reasoning` frames arrive and no turn has `thinking`.

- [ ] **Step 4: Refuse a caller-supplied raw sink**

In `server/engines/service.ts`, at each of the five `PREVIEW_CONTRACT` refusals, extend the condition:

```ts
    if (input.onDelta || input.onToolActivity || input.onReasoningDelta)
```

Import from `../../shared/adapter-contract.js`: `reasoningSink`, `type AdapterRouteContract`, `type ReasoningSink`. Import `routeContractFor` from `../harness/route-contract.js` and `MODEL_API_STREAMING` from `../harness/model-api-adapter.js` if they are not imported already.

- [ ] **Step 5: Wrap the sink on the text dispatch**

In `generate`, declare before `const outcome = await dispatch<...>(`:

```ts
      // The latest attempt's thinking; a replayed outcome streams none and keeps none.
      let thinking: ReasoningSink | undefined;
```

In `send`, after `const onToolActivity = activitySink({...});`:

```ts
          // Thinking only where the route declares it, on the same ordered, fenced queue as text.
          thinking =
            input.onReasoning && adapter.contract.streaming.reasoning === 'reasoning-delta'
              ? reasoningSink({
                  identity,
                  redact: this.deps.redactFor?.(engine),
                  onReasoning: (frame) => publish(() => input.onReasoning?.(frame)),
                  signal: attemptSignal,
                })
              : undefined;
```

In the `adapter.generate({...})` call add `onReasoning: undefined, onReasoningDelta: thinking,`. Replace the return after `dispatch` with:

```ts
      const reasoning = thinking?.finish() ?? null;
      return { ...outcome.result, runId: outcome.run.id, ...(reasoning ? { reasoning } : {}) };
```

- [ ] **Step 6: Wrap the sink on kept sessions**

In `nativeTurn`, declare before `adapterAt`:

```ts
    // What the route declares, read from the adapter admission resolved for this request.
    let declared: AdapterRouteContract | undefined;
    let thinking: ReasoningSink | undefined;
```

At the end of `adapterAt`, before `return persistent;`, add `declared = persistent.sessionContract;`.

In the `preview: (context, stepId) => {...}` factory, after `onToolActivity`:

```ts
          thinking =
            input.onReasoning &&
            (declared ?? routeContractFor(route.routeId)).streaming.reasoning === 'reasoning-delta'
              ? reasoningSink({
                  identity,
                  signal,
                  redact: this.deps.redactFor?.(route.engine),
                  onReasoning: (frame) => publish(() => input.onReasoning?.(frame)),
                })
              : undefined;
```

and return `onReasoningDelta: thinking,` beside `onDelta` and `onToolActivity`. Replace `return await driver.request({...});` with:

```ts
      const result = await driver.request({ /* unchanged */ });
      const reasoning = thinking?.finish() ?? null;
      return reasoning && result.response
        ? { ...result, response: { ...result.response, reasoning } }
        : result;
```

- [ ] **Step 7: Wrap the sink on model-API conversations**

Give `fencedSinks` a fifth parameter and a third sink:

```ts
function fencedSinks(
  input: TextRequest,
  identity: { runId: string; stepId: string; attempt: number; fence: number },
  context: { publishPreview: (publish: () => void) => Promise<void> },
  signal: AbortSignal,
  /** Whether the route declares thinking (`streaming.reasoning`). Work turns pass false. */
  reasoning = false,
) {
```

After `onToolActivity`:

```ts
  const onReasoningDelta =
    reasoning && input.onReasoning
      ? reasoningSink({
          identity: stamped,
          signal,
          onReasoning: (frame) => publish(() => input.onReasoning?.(frame)),
        })
      : undefined;
```

and return `onReasoningDelta,` beside `onDelta` and `onToolActivity`.

In `modelSession`, declare `let thinking: ReasoningSink | undefined;` at the top. Change the `activity:` condition to `input.onPreview || input.onActivity || input.onReasoning`, pass `MODEL_API_STREAMING.reasoning === 'reasoning-delta'` as `fencedSinks`'s fifth argument, set `thinking = sinks.onReasoningDelta;`, and return:

```ts
                return {
                  onDelta: (text) => sinks.onDelta?.(text),
                  onToolActivity: (raw) => sinks.onToolActivity?.(raw),
                  onReasoningDelta: sinks.onReasoningDelta,
                  finish: sinks.finish,
                };
```

Replace `return await driver.request({...});` with the same `result` and `reasoning` block as Step 6. `generateModelApi` keeps calling `fencedSinks` with four arguments: Work turns get no thinking.

- [ ] **Step 8: Carry the sink through both drivers**

`server/harness/claude-session-run.ts`, in the `preview?` return type after `onToolActivity?`:

```ts
    /** The adapter-facing thinking sink, fenced to the same attempt; absent where the route declares none. */
    onReasoningDelta?: TextRequest['onReasoningDelta'];
```

In the `connection.session.turn({...})` call add `onReasoning: undefined, onReasoningDelta: preview?.onReasoningDelta,`. In `openNative`, and at every other place the file strips caller channels (`git grep -n "onPreview: undefined" -- server/harness/claude-session-run.ts`), add `onReasoning: undefined, onReasoningDelta: undefined,`.

`server/engines/model-api-core.ts`, in `StreamSinks`:

```ts
  /** Raw thinking chunks. A preview only; never the answer. */
  onReasoningDelta?: (text: string) => void;
```

`server/harness/model-session-run.ts`, in the `activity?` return type add `onReasoningDelta?(text: string): void;`, and in the `sinks` object add:

```ts
              onReasoningDelta: preview.onReasoningDelta
                ? (text) => preview.onReasoningDelta?.(text)
                : undefined,
```

- [ ] **Step 9: Emit and save in the host**

`server/interaction-service.ts`: the `project` result type gains `thinking?: ReasoningRecord` (import the type from `../shared/adapter-contract.js`), and the call becomes:

```ts
    if (result.response)
      await this.host.project(resolved, {
        runId: result.runId,
        text: result.answerText ?? result.response.text,
        model: result.response.model,
        version: result.response.version,
        ...(result.response.reasoning ? { thinking: result.response.reasoning } : {}),
      });
```

`server/app.ts` (import `ReasoningPreview` and `ReasoningRecord` types):
- Conversation input (~4745), after `onActivity`: `onReasoning: (frame: ReasoningPreview) => store.emit('engine-reasoning', frame),`
- Projection (~4890), in the assistant turn after `context`: `...(result.thinking ? { thinking: result.thinking } : {}),`
- Opt-in session route (~3956), after `onActivity`: `onReasoning: (frame) => store.emit('engine-reasoning', frame),`; and in its assistant turn (~4016) after `helper`: `...(response.reasoning ? { thinking: response.reasoning } : {}),`
- Direct Ask (~5577): declare `let thinking: ReasoningRecord | undefined;` beside `answer` and `helper`, add `onReasoning: (frame) => store.emit('engine-reasoning', frame),` after `onActivity`, set `thinking = result.reasoning;` after `answer = result.text;`, and in the turn (~5755) after `helper,` add `...(thinking ? { thinking } : {}),`
- Events (~5823-5843): add `const reasoningListener = (data: unknown) => send('engine-reasoning', data);`, `store.on('engine-reasoning', reasoningListener);` and `store.off('engine-reasoning', reasoningListener);` beside the activity listener.

- [ ] **Step 10: Run the tests to see them pass**

Run: `npx vitest run tests/live-reasoning-server.test.ts tests/live-activity-server.test.ts tests/model-session-activity.test.ts tests/h03-thread-session-routes.test.ts tests/h04-opencode-session-routes.test.ts tests/h05-acp-session-routes.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add server/engines/service.ts server/engines/model-api-core.ts server/harness/claude-session-run.ts server/harness/model-session-run.ts server/interaction-service.ts server/app.ts tests/live-reasoning-server.test.ts
git commit -m "Stream thinking through EngineService and save it on the reply"
```

---

### Task 3: Claude Code thinking

**Files:**
- Modify: `server/engines/claude.ts:~955-960`, `server/engines/claude-session.ts:~415-418`
- Modify: `server/harness/route-contract.ts` (`claude-code`, `claude-code-session`)
- Modify: `tests/fixtures/claude-stream-json.mjs` (a `[think]` marker, for the H20 runner and route tests)
- Test: `tests/claude-adapter.test.ts`, `tests/claude-session.test.ts`

**Interfaces:**
- Consumes: `TextRequest.onReasoningDelta` (Task 1).
- Produces: Claude Code's stream-json `thinking_delta` chunks reach `onReasoningDelta`. `claude-code` and `claude-code-session` declare `reasoning: 'reasoning-delta'`.

- [ ] **Step 1: Write the failing tests**

In `tests/claude-adapter.test.ts`'s inline fixture, before the unconditional `emit({type:'stream_event',...text_delta...})` line, add:

```js
  if(mode==='thinking') { emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'Weighing '}}}); emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'the menu.'}}}); emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'signature_delta',signature:'sig'}}}); }
```

and the test:

```ts
  it('streams thinking to its own sink and never into the answer', async () => {
    const { adapter } = await fixture('thinking');
    const deltas: string[] = [];
    const thoughts: string[] = [];
    const result = await adapter.generate({
      ...request,
      onDelta: (text) => deltas.push(text),
      onReasoningDelta: (text) => thoughts.push(text),
    });
    expect(thoughts).toEqual(['Weighing ', 'the menu.']);
    expect(deltas).toEqual(['Answer']);
    expect(result.text).toBe('Answer');
  });
```

In `tests/claude-session.test.ts`'s inline script, before `emit({type:'stream_event',session_id:session,event:{delta:{type:'text_delta',text:'Answer'}}});`, add:

```js
  if(mode==='thinking') { emit({type:'stream_event',session_id:session,event:{delta:{type:'thinking_delta',thinking:'Weighing '}}}); emit({type:'stream_event',session_id:session,event:{delta:{type:'thinking_delta',thinking:'the menu.'}}}); }
```

and the test inside `describe('Claude persistent native transport', ...)`:

```ts
  it('streams thinking to its own sink and keeps it out of the answer', async () => {
    const f = await fixture('thinking');
    const session = await f.adapter.openSession(request, f.options);
    try {
      const deltas: string[] = [];
      const thoughts: string[] = [];
      const result = await session.turn({
        ...request,
        onDelta: (text) => deltas.push(text),
        onReasoningDelta: (text) => thoughts.push(text),
      });
      expect(thoughts).toEqual(['Weighing ', 'the menu.']);
      expect(deltas).toEqual(['Answer']);
      expect(result.text).toBe('Answer 1');
    } finally {
      await session.close();
    }
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/claude-adapter.test.ts tests/claude-session.test.ts -t thinking`
Expected: FAIL. `thoughts` is empty.

- [ ] **Step 3: Map `thinking_delta`**

`server/engines/claude-session.ts`, in the `stream_event` branch:

```ts
          const delta = record(record(frame.event).delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string')
            input.onDelta?.(delta.text);
          // Thinking has its own channel and never joins the answer.
          else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string')
            input.onReasoningDelta?.(delta.thinking);
```

`server/engines/claude.ts`, in the `stream_event` branch:

```ts
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              phase = 'stream';
              input.onDelta?.(delta.text);
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string')
              input.onReasoningDelta?.(delta.thinking);
```

In `server/harness/route-contract.ts`, set `reasoning: 'reasoning-delta'` in the `claude-code-session` and `claude-code` streaming literals.

In `tests/fixtures/claude-stream-json.mjs`, before `result('Answer to ' + words);` add:

```js
  if (words.includes('[think]'))
    for (const thinking of ['Weighing the menu. ', 'Checking prices.'])
      emit({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } });
```

and add "`[think]` streams two thinking chunks first" to the header comment.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/claude-adapter.test.ts tests/claude-session.test.ts tests/reasoning-contract.test.ts tests/h01-conformance.test.ts tests/h03-thread-session-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/engines/claude.ts server/engines/claude-session.ts server/harness/route-contract.ts tests/fixtures/claude-stream-json.mjs tests/claude-adapter.test.ts tests/claude-session.test.ts
git commit -m "Stream Claude Code's thinking"
```

---

### Task 4: Cursor and Devin thinking (ACP)

**Files:**
- Modify: `server/engines/acp-client.ts` (`AcpTurn` at 779-784; `acpSessionUpdate` at 835-893)
- Modify: `server/engines/cursor.ts:~433`, `server/engines/devin.ts:~414`
- Modify: `server/harness/route-contract.ts` (`ACP_SESSION_CONTRACT`, `cursor`, `devin`)
- Modify: `tests/fixtures/acp-agent.mjs` (a `think` request marker)
- Test: `tests/acp-session.test.ts`, `tests/acp-thought-chunks.test.ts` (new)

**Interfaces:**
- Consumes: `TextRequest.onReasoningDelta`.
- Produces: `AcpTurn.onReasoningDelta?: TextRequest['onReasoningDelta']`. ACP `agent_thought_chunk` text inside a prompted turn reaches it. The four ACP descriptors declare `reasoning: 'reasoning-delta'`.

- [ ] **Step 1: Write the failing tests**

Create `tests/acp-thought-chunks.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { acpSessionUpdate, type AcpTurn } from '../server/engines/acp-client.js';

const profile = { name: 'Cursor' } as Parameters<typeof acpSessionUpdate>[0];
const rpc = { replaying: false, sessionId: 's-1' } as Parameters<typeof acpSessionUpdate>[1];
const thought = (content: unknown) => ({
  sessionId: 's-1',
  update: { sessionUpdate: 'agent_thought_chunk', content },
});

describe('ACP thought chunks', () => {
  test('text thought inside the prompted turn reaches the thinking sink, never the answer', () => {
    const thoughts: string[] = [];
    const turn: AcpTurn = { text: '', model: 'm', prompting: true, onReasoningDelta: (text) => thoughts.push(text) };
    acpSessionUpdate(profile, rpc, thought({ type: 'text', text: 'Weighing the menu.' }), turn, {});
    expect(thoughts).toEqual(['Weighing the menu.']);
    expect(turn.text).toBe('');
  });

  test('thought outside a turn, or not text, is dropped without stopping anything', () => {
    const thoughts: string[] = [];
    const idle: AcpTurn = { text: '', model: 'm', prompting: false, onReasoningDelta: (text) => thoughts.push(text) };
    expect(() => acpSessionUpdate(profile, rpc, thought({ type: 'text', text: 'late' }), idle, {})).not.toThrow();
    const busy: AcpTurn = { ...idle, prompting: true };
    expect(() => acpSessionUpdate(profile, rpc, thought({ type: 'image', data: '' }), busy, {})).not.toThrow();
    expect(() => acpSessionUpdate(profile, rpc, thought(null), busy, {})).not.toThrow();
    expect(thoughts).toEqual([]);
  });
});
```

In `tests/fixtures/acp-agent.mjs`, inside `prompt`, before the final `finish(\`answer after ...\`)`:

```js
  if (request.includes('think')) {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Weighing the menu. ' } });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'image', data: '', mimeType: 'image/png' } });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking prices.' } });
  }
```

and add "`think` streams thought chunks before the answer" to the header comment. In `tests/acp-session.test.ts`, inside `describe.each(['cursor', 'devin'] ...)`:

```ts
  it('streams thought chunks to the thinking sink and keeps them out of the answer', async () => {
    const f = await fixture(engine);
    const session = await f.open();
    const thoughts: string[] = [];
    const answer = await session.turn({
      ...input(engine, 'r1', 'think it over'),
      onReasoningDelta: (text) => thoughts.push(text),
    });
    expect(thoughts).toEqual(['Weighing the menu. ', 'Checking prices.']);
    expect(answer.text).toBe('answer after 0 earlier turns');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/acp-thought-chunks.test.ts tests/acp-session.test.ts -t thought`
Expected: FAIL (a type error on `onReasoningDelta` in `AcpTurn`, then an empty `thoughts`).

- [ ] **Step 3: Map `agent_thought_chunk`**

`server/engines/acp-client.ts`, in `AcpTurn` after `onDelta?`:

```ts
  /** Thinking chunks of the prompted turn; they never join `text`. */
  onReasoningDelta?: TextRequest['onReasoningDelta'];
```

In `acpSessionUpdate`, directly before `if (kind === 'agent_message_chunk') {`:

```ts
  if (kind === 'agent_thought_chunk') {
    // Thinking is narration: text inside the prompted turn goes to its own channel and anything
    // else is dropped. It never joins the answer and never stops the turn.
    const content = record(update.content);
    if (turn?.prompting && content.type === 'text' && typeof content.text === 'string' && content.text)
      turn.onReasoningDelta?.(content.text);
  }
```

(`agent_thought_chunk` stays in `ACP_IDLE_UPDATES`, so the `else if` after `agent_message_chunk` still tolerates it.)

In `server/engines/cursor.ts` and `server/engines/devin.ts`, where the turn is built with `onDelta: input.onDelta,`, add `onReasoningDelta: input.onReasoningDelta,`.

In `server/harness/route-contract.ts`, set `reasoning: 'reasoning-delta'` in the `ACP_SESSION_CONTRACT` literal and in the `cursor` and `devin` entries.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/acp-thought-chunks.test.ts tests/acp-session.test.ts tests/acp-session-runtime.test.ts tests/h05-acp-session-routes.test.ts tests/h01-conformance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/engines/acp-client.ts server/engines/cursor.ts server/engines/devin.ts server/harness/route-contract.ts tests/fixtures/acp-agent.mjs tests/acp-thought-chunks.test.ts tests/acp-session.test.ts
git commit -m "Stream Cursor's and Devin's thinking over ACP"
```

---

### Task 5: OpenCode thinking

**Files:**
- Modify: `server/engines/opencode.ts` (`readTurn`, ~930-1090)
- Modify: `server/harness/route-contract.ts` (`opencode`, `opencode-session`)
- Modify: `tests/fixtures/opencode-session-server.mjs` (mode `think`)
- Test: `tests/opencode-session.test.ts`

**Interfaces:**
- Consumes: `TextRequest.onReasoningDelta`.
- Produces: OpenCode reasoning parts of this turn's assistant message reach `onReasoningDelta`. Both OpenCode descriptors declare `reasoning: 'reasoning-delta'`.

- [ ] **Step 1: Write the failing test**

In `tests/fixtures/opencode-session-server.mjs`, add `think` to the mode list in the header ("streams a reasoning part before the answer, with the same `field: "text"` deltas"), and directly after `send(info());` in the prompt handler:

```js
    if (mode === 'think') {
      const reason = `reason_${id}`;
      send({ type: 'message.part.updated', properties: { part: { id: reason, sessionID, messageID: id, type: 'reasoning', text: '' } } });
      send({ type: 'message.part.delta', properties: { sessionID, messageID: id, partID: reason, field: 'text', delta: 'Weighing the menu. ' } });
      send({ type: 'message.part.updated', properties: { part: { id: reason, sessionID, messageID: id, type: 'reasoning', text: 'Weighing the menu. Checking prices.' } } });
    }
```

In `tests/opencode-session.test.ts`, inside `describe('kept OpenCode session transport', ...)`:

```ts
  it('streams reasoning parts to the thinking sink and keeps them out of the answer', async () => {
    const f = await fixture();
    f.state.mode = 'think';
    const session = await f.openSession(request('first'));
    const thoughts: string[] = [];
    const deltas: string[] = [];
    const result = await session.turn({
      ...request('first'),
      onDelta: (text) => deltas.push(text),
      onReasoningDelta: (text) => thoughts.push(text),
    });
    expect(thoughts).toEqual(['Weighing the menu. ', 'Checking prices.']);
    expect(result.text.startsWith('answer:first')).toBe(true);
    expect(result.text).not.toContain('Weighing');
    expect(deltas.join('')).toBe(result.text);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/opencode-session.test.ts -t reasoning`
Expected: FAIL. `thoughts` is empty.

- [ ] **Step 3: Map reasoning parts**

In `readTurn`, beside `const textParts = new Map<string, string>();`:

```ts
    // Reasoning parts, tracked the same way: a delta counts only for a part already announced as
    // reasoning, and an update without a delta gives what that part has that was not streamed.
    const reasoningParts = new Map<string, string>();
```

In the `message.part.updated` block for this assistant message, replace `if (partType !== 'text') continue;` with:

```ts
            if (partType === 'reasoning') {
              const partId = text(partValue.id);
              if (!partId) continue;
              const prior = reasoningParts.get(partId) ?? '';
              const delta = text(props.delta);
              let next = delta;
              if (!delta) {
                const full = text(partValue.text);
                next = full.startsWith(prior) ? full.slice(prior.length) : '';
              }
              reasoningParts.set(partId, prior + next);
              if (next) input.onReasoningDelta?.(next);
              continue;
            }
            if (partType !== 'text') continue;
```

After the `message.part.delta` block for text parts, add:

```ts
          if (
            kind === 'message.part.delta' &&
            assistantMessageId &&
            text(props.messageID) === assistantMessageId &&
            text(props.field) === 'text' &&
            reasoningParts.has(text(props.partID))
          ) {
            const delta = text(props.delta);
            if (delta) {
              reasoningParts.set(text(props.partID), (reasoningParts.get(text(props.partID)) ?? '') + delta);
              input.onReasoningDelta?.(delta);
            }
          }
```

In `server/harness/route-contract.ts`, set `reasoning: 'reasoning-delta'` for `opencode-session` and `opencode`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/opencode-session.test.ts tests/opencode-session-runtime.test.ts tests/h04-opencode-session-routes.test.ts tests/h01-conformance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/engines/opencode.ts server/harness/route-contract.ts tests/fixtures/opencode-session-server.mjs tests/opencode-session.test.ts
git commit -m "Stream OpenCode's thinking"
```

---

### Task 6: Model-API thinking (Bedrock, Azure, Vertex, OpenRouter)

**Files:**
- Modify: `server/engines/model-api-core.ts` (the `fullStream` loop at 847-866)
- Modify: `server/engines/aws-bedrock.ts` (`awsBinding` at 248, `respondOnce` at ~316)
- Modify: `server/engines/azure-openai.ts` (`azureBinding` at 180, its caller at ~253)
- Modify: `server/engines/google-vertex.ts` (`inspectVertexBody` at ~645, `vertexBinding` at 662, its caller at ~737)
- Modify: `server/engines/openrouter.ts` (no request change; see Step 4)
- Modify: `server/harness/model-api-adapter.ts` (`MODEL_API_STREAMING.reasoning`)
- Modify: `tests/fixtures/model-api-streams.ts` (`responsesEvents` streams reasoning summaries)
- Test: `tests/aws-bedrock-transport.test.ts`, `tests/azure-openai-model-api.test.ts`, `tests/google-vertex-model-api.test.ts`, `tests/openrouter-model-api.test.ts`

**Interfaces:**
- Consumes: `StreamSinks.onReasoningDelta` (Task 2).
- Produces: AI SDK `reasoning-delta` stream parts reach `onReasoningDelta`. Summaries are requested only when a caller supplied `onReasoningDelta`:
  - `awsBinding(connection, effort, summaries: boolean)`
  - `azureBinding(connection, entry, effort, summaries: boolean)`
  - `vertexBinding(connection, effort, callIdBase, summaries: boolean)`
  - `MODEL_API_STREAMING.reasoning` becomes `'reasoning-delta'`.

The request options, per provider:

| Route | With a thinking sink | Without |
|---|---|---|
| AWS Bedrock | `reasoningSummary: 'auto'` | `reasoningSummary: null` (today) |
| Azure OpenAI, `entry.reasoning` | `reasoningSummary: 'auto'` | `reasoningSummary: null` (today) |
| Google Vertex AI | `includeThoughts: true` | `includeThoughts: false` (today) |
| OpenRouter | unchanged | unchanged |

**Why OpenRouter requests nothing new.** Every OpenRouter request pins `require_parameters: true` (`openRouterPreferences`), and `inspectOpenRouterBody` refuses any other body shape. With that pin, a `reasoning` parameter restricts routing to endpoints that support it, so a model whose allowed endpoints don't would fail the whole reply. OpenRouter models declare no reasoning support today, and adding a declaration would change AI setup, which Andrew asked to keep as it is. So the route maps the reasoning its models already return. A per-model reasoning request is a follow-up. Tell Andrew about this deviation from the spec's table in the Task 9 report.

- [ ] **Step 1: Stream reasoning summaries in the fixture**

In `tests/fixtures/model-api-streams.ts`, `responsesEvents`, add a branch before the final `else`:

```ts
    } else if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? (item.summary as Item[]) : [];
      out += frame({
        type: 'response.output_item.added',
        sequence_number: next(),
        output_index: index,
        item: { ...item, summary: [] },
      });
      summary.forEach((part, summaryIndex) => {
        const text = typeof part.text === 'string' ? part.text : '';
        out += frame({
          type: 'response.reasoning_summary_part.added',
          sequence_number: next(),
          item_id: id,
          output_index: index,
          summary_index: summaryIndex,
          part: { type: 'summary_text', text: '' },
        });
        const size = options.split ?? 4;
        for (let at = 0; at < text.length; at += size)
          out += frame({
            type: 'response.reasoning_summary_text.delta',
            sequence_number: next(),
            item_id: id,
            output_index: index,
            summary_index: summaryIndex,
            delta: text.slice(at, at + size),
          });
        out += frame({
          type: 'response.reasoning_summary_part.done',
          sequence_number: next(),
          item_id: id,
          output_index: index,
          summary_index: summaryIndex,
          part: { type: 'summary_text', text },
        });
      });
      out += frame({ type: 'response.output_item.done', sequence_number: next(), output_index: index, item });
```

A reasoning item with an empty `summary` streams exactly what it streams today.

- [ ] **Step 2: Write the failing tests**

In `tests/aws-bedrock-transport.test.ts`, `describe('the streamed exchange', ...)`:

```ts
  test('with a thinking sink, summaries are asked for and stream apart from the answer', async () => {
    const summarized: Item = {
      ...reasoning(),
      summary: [{ type: 'summary_text', text: 'Counting the delivery lines.' }],
    };
    const net = transport([() => json(envelope([summarized, message('Six napkins were short.')]))]);
    const thoughts: string[] = [];
    const deltas: string[] = [];
    const result = await call(net.fetch, {
      onDelta: (text) => deltas.push(text),
      onReasoningDelta: (text) => thoughts.push(text),
    });
    expect((net.sent[0].body.reasoning as Record<string, unknown>).summary).toBe('auto');
    expect(thoughts.join('')).toBe('Counting the delivery lines.');
    expect(deltas.join('')).toBe('Six napkins were short.');
    expect(result.outcome).toEqual({ kind: 'final', text: 'Six napkins were short.' });
  });

  test('without a thinking sink, no summary is asked for', async () => {
    const net = transport([() => json(envelope([reasoning(), message('Six napkins were short.')]))]);
    await call(net.fetch);
    expect((net.sent[0].body.reasoning as Record<string, unknown>).summary ?? null).toBeNull();
  });
```

Add the same pair to `tests/azure-openai-model-api.test.ts` for a deployment with `reasoning: true` (reusing that file's `transport`, `call` and envelope helpers), plus a check that a deployment with `reasoning: false` sends no `reasoning` object even with a thinking sink.

In `tests/google-vertex-model-api.test.ts`, using that file's stream helpers:
- A thinking sink sends `generationConfig.thinkingConfig.includeThoughts === true`.
- Parts `{ text: 'Checking the menu.', thought: true }` reach the sink and never the answer.
- Without a sink, `includeThoughts` is `false`.
- `inspectVertexBody` still refuses a body with `cachedContent`, a Google-run tool or `candidateCount: 2`, each with its existing sentence.

In `tests/openrouter-model-api.test.ts`, stream a chat chunk whose delta carries `reasoning: 'Weighing it.'` before the content, and assert that it reaches the sink, that the answer excludes it, and that the request body has no `reasoning` key.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/aws-bedrock-transport.test.ts tests/azure-openai-model-api.test.ts tests/google-vertex-model-api.test.ts tests/openrouter-model-api.test.ts -t "thinking|summary|thought"`
Expected: FAIL.

- [ ] **Step 4: Map reasoning parts and ask for summaries**

`server/engines/model-api-core.ts`, in the `fullStream` loop after the `text-delta` branch:

```ts
      } else if (part.type === 'reasoning-delta') {
        // Thinking is a preview only: never the answer, never a failure.
        if (part.text && !signal.aborted)
          try {
            input.onReasoningDelta?.(part.text);
          } catch {
            // The thinking sink drops what it cannot carry.
          }
```

`server/engines/aws-bedrock.ts`: `awsBinding(connection, effort, summaries: boolean)` sets `reasoningSummary: summaries ? 'auto' : null`, and `respondOnce` passes `Boolean(rest.onReasoningDelta)`.

`server/engines/azure-openai.ts`: `azureBinding(connection, entry, effort, summaries: boolean)` sets `reasoningSummary: summaries ? 'auto' : null` inside the `entry.reasoning` branch, and its caller passes `Boolean(rest.onReasoningDelta)`.

`server/engines/google-vertex.ts`:
- `vertexBinding(connection, effort, callIdBase, summaries: boolean)` sets `thinkingConfig: { thinkingLevel: THINKING[effort], includeThoughts: summaries }`, and its caller passes `Boolean(rest.onReasoningDelta)`.
- In `inspectVertexBody`, delete the two lines that read `thinkingConfig` and refuse `includeThoughts`, and put this comment in their place:

```ts
  // Visible thinking is allowed: thought parts stream to their own channel and classifyVertex keeps
  // them out of the answer. Every other refusal stands.
```

`server/engines/openrouter.ts`: no request change. `@openrouter/ai-sdk-provider` already turns a model's returned reasoning into `reasoning-delta` parts, and the loop above maps them.

`server/harness/model-api-adapter.ts`: set `MODEL_API_STREAMING.reasoning` to `'reasoning-delta'`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run tests/aws-bedrock-transport.test.ts tests/azure-openai-model-api.test.ts tests/google-vertex-model-api.test.ts tests/google-vertex-conversation.test.ts tests/openrouter-model-api.test.ts tests/model-session-activity.test.ts tests/reasoning-contract.test.ts tests/live-reasoning-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/engines/model-api-core.ts server/engines/aws-bedrock.ts server/engines/azure-openai.ts server/engines/google-vertex.ts server/harness/model-api-adapter.ts tests/fixtures/model-api-streams.ts tests/aws-bedrock-transport.test.ts tests/azure-openai-model-api.test.ts tests/google-vertex-model-api.test.ts tests/openrouter-model-api.test.ts
git commit -m "Stream model-API thinking and ask for reasoning summaries"
```

---

### Task 7: The Nectovia route and the gateway

**Files:**
- Modify: `server/accounts/client.ts:63-67` (`RoutingPolicyAnswer`)
- Modify: `server/engines/nectovia.ts` (`NectoviaPolicy` at 54-57; `nectoviaBinding` at 258; its caller at ~377)
- Modify: `services/control-plane/src/managed-inference.ts:249-253` (request validator)
- Modify: `services/control-plane/src/commercial.ts:470-477` (`routingPolicy`)
- Test: `tests/nectovia-route.test.ts` (find the existing Nectovia binding test with `git grep -ln "nectoviaBinding" tests`; add there if one exists), `services/control-plane/test/managed-inference.test.ts` (find with `git grep -ln "reasoning.summary" services/control-plane`)

**Interfaces:**
- Consumes: `StreamSinks.onReasoningDelta`, the routing policy the session already reads (`GET /account/routing-policy`).
- Produces:
  - `RoutingPolicyAnswer.reasoningSummaries?: boolean` and `NectoviaPolicy.reasoningSummaries?: boolean`. Absent means the gateway doesn't accept summaries.
  - `nectoviaBinding({ ..., summaries: boolean })`
  - The gateway accepts `reasoning.summary` of `'auto' | 'concise' | 'detailed' | null` and publishes `reasoningSummaries: true`.

- [ ] **Step 1: Write the failing tests**

Desktop: with a policy that has `reasoningSummaries: true` and a thinking sink, the body sent to the gateway has `reasoning.summary === 'auto'`. With the field absent, or with no sink, the body has no summary. Reuse the file's gateway transport stand-in.

Gateway, in the managed-inference test file:
- `reasoning: { effort: 'high', summary: 'auto' }` is accepted.
- `summary: 'everything'` is refused as unsupported.
- A streamed response with reasoning-summary events reaches the client byte for byte.
- `routingPolicy` answers `reasoningSummaries: true`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run <the desktop test file> -t summar`, and in `services/control-plane`: `npx vitest run <the gateway test file> -t summar`
Expected: FAIL.

- [ ] **Step 3: Implement**

`services/control-plane/src/managed-inference.ts`, replace the `summary` refusal:

```ts
    if ('summary' in reasoning && reasoning.summary !== null && !['auto', 'concise', 'detailed'].includes(reasoning.summary as string))
      unsupported('reasoning.summary', 'reasoning.summary may be auto, concise, detailed or null.');
```

`services/control-plane/src/commercial.ts`, in `routingPolicy`, add `reasoningSummaries: true` to both answers, with the comment "This gateway accepts reasoning summaries (managed-inference.ts); a desktop asks for them only when this says so."

`server/accounts/client.ts`: add `reasoningSummaries?: boolean;` to `RoutingPolicyAnswer`. `server/engines/nectovia.ts`: add the same field to `NectoviaPolicy`. `nectoviaBinding`'s input gains `summaries: boolean`, and it sets `reasoningSummary: input.summaries ? 'auto' : null`. Its caller passes:

```ts
      // Ask for summaries only from a gateway that says it accepts them.
      summaries: Boolean(rest.onReasoningDelta) && input.account.policy()?.reasoningSummaries === true,
```

Adapt `input.account` to whatever the caller already uses to read the policy (`git grep -n "policy()" server/engines/nectovia.ts`).

- [ ] **Step 4: Run the tests to see them pass**

Run the two commands from Step 2.
Expected: PASS. Then run the control-plane suite under the slot: `npm test --prefix services/control-plane`. Expected: PASS (a main merge deploys the Worker, so this suite gates it).

- [ ] **Step 5: Commit, without deploying**

```bash
git add server/accounts/client.ts server/engines/nectovia.ts services/control-plane/src/managed-inference.ts services/control-plane/src/commercial.ts <the two test files>
git commit -m "Let the managed gateway carry reasoning summaries"
```

The Worker deploys only with Andrew's approval, through the next approved merge to main.

---

### Task 8: The Console

**Files:**
- Create: `client/console/engine-reasoning.ts`, `client/console/Thinking.tsx`
- Modify: `client/console/live-reply.ts`, `client/console/console.css`
- Modify: `client/console/DiomedesHome.tsx:~250-265`, `client/console/Diomedes.tsx:~223,~297,~327-335`
- Modify: `client/console/Shell.tsx:~366,~594,~609-617,~628-663`, `client/console/ThreadView.tsx:~326,~416,~756-759`
- Test: `tests/engine-reasoning-client.test.ts` (new), `tests/reasoning-ui.spec.ts` (new)

**Interfaces:**
- Consumes: `reasoningPreviewSchema`, `ReasoningRecord`, `Turn.thinking`, the `engine-reasoning` event.
- Produces:
  - `interface LiveThinking { text: string; position: PreviewPosition; since: number; endedAt: number | null }`
  - `acceptReasoning(position: PreviewPosition, frame: unknown)`, same decisions as `acceptPreview`
  - `stepThinking(state: LiveThinking | null, frame: unknown, since: number): LiveThinking | null`
  - `endThinking(state: LiveThinking | null, now: number): LiveThinking | null`
  - `thoughtFor(ms: number): string`
  - `LiveReply.thinking: LiveThinking | null` and `LiveReply.startedAt: number`
  - `stepLiveReply(state, binding, event, now = Date.now())`, which takes `{ type: 'engine-reasoning'; data }`
  - `<Thinking text ms live? shortened? />`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-reasoning-client.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { acceptReasoning, endThinking, stepThinking, thoughtFor } from '../client/console/engine-reasoning';
import { stepLiveReply, type LiveBinding } from '../client/console/live-reply';

const id = { projectId: 'P1', threadId: 'T1', requestId: 'R1', runId: 'run-1', stepId: 's', attempt: 1, fence: 1 };
const frame = (seq: number, text: string) => ({ kind: 'reasoning-delta', ...id, seq, text });
const binding: LiveBinding = { projectId: 'P1', threadId: 'T1', requestId: 'R1' };

describe('live thinking', () => {
  test('appends in order, ignores a repeat and loses itself on a gap', () => {
    let state = stepThinking(null, frame(1, 'Weighing '), 1_000);
    state = stepThinking(state, frame(2, 'the menu.'), 1_000);
    state = stepThinking(state, frame(2, 'the menu.'), 1_000);
    expect(state).toMatchObject({ text: 'Weighing the menu.', since: 1_000, endedAt: null });
    expect(stepThinking(state, frame(4, 'late'), 1_000)).toMatchObject({ position: 'lost', text: '' });
    expect(acceptReasoning(null, { ...frame(1, 'x'), kind: 'text-delta' }).kind).toBe('discard');
  });

  test('ends once, at the first answer text', () => {
    const state = stepThinking(null, frame(1, 'Weighing'), 1_000);
    const ended = endThinking(state, 15_000);
    expect(ended?.endedAt).toBe(15_000);
    expect(endThinking(ended, 20_000)?.endedAt).toBe(15_000);
    expect(endThinking(null, 20_000)).toBeNull();
  });

  test('reads its duration plainly', () => {
    expect(thoughtFor(900)).toBe('Thought for a moment');
    expect(thoughtFor(14_200)).toBe('Thought for 14s');
  });
});

describe('the live reply', () => {
  const started = { type: 'engine-text' as const, data: { ...binding, runId: 'run-1', kind: 'started' } };
  test('carries thinking, folds it at the first answer text, and drops foreign runs', () => {
    let state = stepLiveReply(null, binding, started, 1_000);
    state = stepLiveReply(state, binding, { type: 'engine-reasoning', data: frame(1, 'Weighing') }, 2_000);
    state = stepLiveReply(state, binding, { type: 'engine-reasoning', data: { ...frame(2, 'x'), runId: 'other' } }, 2_500);
    expect(state?.thinking).toMatchObject({ text: 'Weighing', since: 1_000, endedAt: null });
    state = stepLiveReply(
      state,
      binding,
      { type: 'engine-text', data: { ...id, kind: 'delta', seq: 1, text: 'Soup.' } },
      9_000,
    );
    expect(state?.thinking?.endedAt).toBe(9_000);
    expect(state?.text).toBe('Soup.');
  });

  test('a lost stream loses the live thinking too', () => {
    let state = stepLiveReply(null, binding, started, 1_000);
    state = stepLiveReply(state, binding, { type: 'engine-reasoning', data: frame(1, 'Weighing') }, 2_000);
    state = stepLiveReply(state, binding, { type: 'lost' }, 3_000);
    expect(state?.thinking).toMatchObject({ position: 'lost', text: '' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/engine-reasoning-client.test.ts`
Expected: FAIL. The module is missing.

- [ ] **Step 3: Write `client/console/engine-reasoning.ts`**

```ts
import { reasoningPreviewSchema } from '../../shared/adapter-contract';
import type { PreviewCursor, PreviewPosition } from './engine-text-preview';

/** The thinking shown while a reply is on its way. Display state only; never saved. */
export interface LiveThinking {
  text: string;
  position: PreviewPosition;
  /** When the reply started, for "Thought for 14s". */
  since: number;
  /** When the first answer text arrived, or null while thinking continues. */
  endedAt: number | null;
}

/** The longest live thinking a page keeps; the saved record is the authority. */
export const MAX_LIVE_THINKING_CHARS = 64 * 1024;

type Decision =
  | { kind: 'append'; cursor: PreviewCursor; text: string }
  | { kind: 'ignore' }
  | { kind: 'discard' };

/** The same attribution and gap rules as `acceptPreview`, for `reasoning-delta` frames. */
export function acceptReasoning(position: PreviewPosition, frame: unknown): Decision {
  if (position === 'lost') return { kind: 'ignore' };
  const parsed = reasoningPreviewSchema.safeParse(frame);
  if (!parsed.success) return { kind: 'discard' };
  const { stepId, attempt, fence, seq, text } = parsed.data;
  if (position) {
    if (stepId !== position.stepId || attempt !== position.attempt || fence !== position.fence)
      return { kind: 'discard' };
    if (seq <= position.seq) return { kind: 'ignore' };
  }
  if (seq !== (position?.seq ?? 0) + 1) return { kind: 'discard' };
  return { kind: 'append', cursor: { stepId, attempt, fence, seq }, text };
}

/** One thinking frame applied. A gap loses the live thinking; the saved record replaces it. */
export function stepThinking(state: LiveThinking | null, frame: unknown, since: number): LiveThinking | null {
  const accepted = acceptReasoning(state?.position ?? null, frame);
  if (accepted.kind === 'ignore') return state;
  if (accepted.kind === 'discard')
    return { text: '', position: 'lost', since: state?.since ?? since, endedAt: state?.endedAt ?? null };
  return {
    text: ((state?.text ?? '') + accepted.text).slice(0, MAX_LIVE_THINKING_CHARS),
    position: accepted.cursor,
    since: state?.since ?? since,
    endedAt: state?.endedAt ?? null,
  };
}

/** The answer started: thinking folds. Only the first call counts. */
export function endThinking(state: LiveThinking | null, now: number): LiveThinking | null {
  return state && state.endedAt === null ? { ...state, endedAt: now } : state;
}

/** The fold line a person reads. */
export function thoughtFor(ms: number): string {
  return ms < 1_500 ? 'Thought for a moment' : `Thought for ${Math.round(ms / 1_000)}s`;
}
```

- [ ] **Step 4: Extend `client/console/live-reply.ts`**

- Import `endThinking`, `stepThinking` and `type LiveThinking` from `./engine-reasoning`.
- `LiveReply` gains `startedAt: number;` and `thinking: LiveThinking | null;`.
- `LiveEvent`'s first member becomes `{ type: 'engine-text' | 'engine-activity' | 'engine-reasoning'; data: unknown }`.
- The signature becomes `stepLiveReply(state, binding, event, now: number = Date.now())`.
- On `lost`: `{ ...current, position: 'lost', text: '', thinking: current.thinking ? { ...current.thinking, position: 'lost', text: '' } : null }`.
- After the `engine-activity` branch:

```ts
  if (event.type === 'engine-reasoning') {
    if (!current || data.runId !== current.runId) return current;
    const thinking = stepThinking(current.thinking, data, current.startedAt);
    return thinking === current.thinking ? current : { ...current, thinking };
  }
```

- The `started` branch adds `startedAt: now, thinking: null`.
- The `delta` append path returns `{ ...current, position: accepted.cursor, text, thinking: endThinking(current.thinking, now) }`.

- [ ] **Step 5: Write `client/console/Thinking.tsx` and its styles**

```tsx
import { useState } from 'react';
import { thoughtFor } from './engine-reasoning';

/**
 * An engine's thinking, above its reply. While it streams and no answer has started, it is open
 * and muted. Once the answer starts, and on a saved reply, it folds to one line that opens on
 * click. Nothing shows when there is no thinking.
 */
export function Thinking({
  text,
  ms,
  live = false,
  shortened = false,
}: {
  text: string;
  /** How long it ran, or null while it is still running. */
  ms: number | null;
  live?: boolean;
  shortened?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  if (live && ms === null)
    return (
      <div className="thinking thinking-live" role="status" aria-live="polite">
        <span className="thinking-label">Thinking</span>
        <p className="thinking-text">{text}</p>
      </div>
    );
  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {thoughtFor(ms ?? 0)}
      </button>
      {open && (
        <p className="thinking-text">
          {text}
          {shortened ? <span className="thinking-note"> Shortened to fit.</span> : null}
        </p>
      )}
    </div>
  );
}
```

In `client/console/console.css`, beside `.tool-activity`, using the same muted text colour and font tokens `.tool-activity` uses (read them there first):

```css
.thinking { margin: 0 0 8px; font-size: 0.92em; }
.thinking, .thinking-toggle { color: /* the muted token .tool-activity uses */; }
.thinking-label { display: block; margin-bottom: 4px; }
.thinking-text { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.thinking-toggle { padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
.thinking-toggle:hover, .thinking-toggle:focus-visible { text-decoration: underline; }
```

- [ ] **Step 6: Wire Home and project threads**

- **`DiomedesHome.tsx`:** add `'engine-reasoning'` to the `frame(...)` type union, create `const onReasoning = frame('engine-reasoning');`, and add and remove its listener beside `engine-activity`. Pass `live={live ? { text: live.text, activity: live.activity?.lines ?? [], thinking: live.thinking } : null}`.
- **`Diomedes.tsx`:**
  - The `live` prop type gains `thinking: LiveThinking | null`.
  - `waiting` also requires `!streamed?.thinking?.text`.
  - The streamed block renders `<Thinking text={streamed.thinking.text} ms={streamed.thinking.endedAt === null ? null : streamed.thinking.endedAt - streamed.thinking.since} live />` above `<TurnBody text={streamed.text} preview />` when `streamed.thinking && streamed.thinking.position !== 'lost'`.
  - The saved-turn map renders `{turn.thinking && <Thinking text={turn.thinking.text} ms={turn.thinking.ms} shortened={turn.thinking.shortened} />}` above its `TurnBody`.
- **`Shell.tsx`:**
  - The `streaming` state type gains `thinking: LiveThinking | null` and `startedAt: number`. `setStreaming({...})` in the `started` branch adds `thinking: null, startedAt: Date.now()`.
  - The delta append adds `thinking: endThinking(prev.thinking, Date.now())`.
  - Add an `engine-reasoning` listener beside `onEngineActivity`. It parses the event and requires `data.projectId === currentId.current`, `data.requestId === streamingId.current`, `data.runId === streamingRunId.current` and `data.threadId === askThreadId.current`, then runs `setStreaming((prev) => prev && prev.requestId === data.requestId ? { ...prev, thinking: stepThinking(prev.thinking, data, prev.startedAt) } : prev)`. Register and remove it with the others.
  - Pass `thinking: streaming.thinking` where `streaming` is handed to `ThreadView` (~894).
- **`ThreadView.tsx`:** the waiting condition (~326) also requires `!streaming.thinking?.text`. Render `<Thinking ... live />` above the streaming `TurnBody` (~759), and saved `turn.thinking` above the saved `TurnBody` (~416), exactly as in `Diomedes.tsx`.

- [ ] **Step 7: Run the unit tests to see them pass**

Run: `npx vitest run tests/engine-reasoning-client.test.ts tests/live-activity-client.test.ts tests/thread-preview.test.ts tests/console-activity.test.ts`
Expected: PASS. Then `npx tsc --noEmit`: exit 0.

- [ ] **Step 8: Write the browser test**

Create `tests/reasoning-ui.spec.ts`, modelled on `tests/h01-preview-repair.spec.ts`: the actual app, host, SSE and built Console, with only the engine scripted. The scripted `claude-code` adapter uses a contract that declares `reasoning: 'reasoning-delta'`. It calls `input.onReasoningDelta?.('Weighing the menu.')`, waits on a release promise, then calls `input.onDelta?.('Soup and bread.')` and returns that text. The steps:
1. Send an Ask on a project thread. Expect `Thinking` and "Weighing the menu." to be visible, and no waiting line.
2. Release the promise. Expect the answer, and a button matching `/^Thought for/` with `aria-expanded="false"`, with the thinking text hidden.
3. Click the button. The thinking text is visible.
4. Reload the page. The saved reply still shows the fold line, which opens on click.
5. A second test uses the same adapter with `reasoning: 'none'`: no `Thinking` text and no fold line appear anywhere.

- [ ] **Step 9: Run the browser test**

Under the slot: `npx vite build`, then `npx playwright test tests/reasoning-ui.spec.ts`.
Expected: 2 passed.

- [ ] **Step 10: Commit**

```bash
git add client/console/engine-reasoning.ts client/console/Thinking.tsx client/console/live-reply.ts client/console/console.css client/console/DiomedesHome.tsx client/console/Diomedes.tsx client/console/Shell.tsx client/console/ThreadView.tsx tests/engine-reasoning-client.test.ts tests/reasoning-ui.spec.ts
git commit -m "Show an engine's thinking above its reply"
```

---

### Task 9: Conformance, records and the full gates

**Files:**
- Create: `tests/reasoning-conformance.test.ts`
- Modify: `docs/harness/CHANGES.md`, `docs/DIOMEDES_LIVE_ROADMAP.md` (runtime-seam section: thinking on every conversation route)

- [ ] **Step 1: Write the conformance test**

```ts
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { ROUTE_CONTRACTS } from '../server/harness/route-contract.js';
import { MODEL_API_STREAMING } from '../server/harness/model-api-adapter.js';

/**
 * Every route that declares thinking has a producer test that drives it from recorded frames.
 * A route that flips to `reasoning-delta` without one fails here; one that produces thinking while
 * declaring `none` never receives the sink (EngineService, tests/live-reasoning-server.test.ts).
 */
const PRODUCERS: Record<string, string> = {
  'claude-code': 'tests/claude-adapter.test.ts',
  'claude-code-session': 'tests/claude-session.test.ts',
  cursor: 'tests/acp-thought-chunks.test.ts',
  devin: 'tests/acp-thought-chunks.test.ts',
  'cursor-session': 'tests/acp-session.test.ts',
  'devin-session': 'tests/acp-session.test.ts',
  opencode: 'tests/opencode-session.test.ts',
  'opencode-session': 'tests/opencode-session.test.ts',
};

describe('thinking conformance', () => {
  test('the routes that declare thinking are exactly the ones with a producer test', () => {
    const declaring = Object.values(ROUTE_CONTRACTS)
      .filter((contract) => contract.streaming.reasoning === 'reasoning-delta')
      .map((contract) => contract.routeId)
      .sort();
    expect(declaring).toEqual(Object.keys(PRODUCERS).sort());
    for (const file of new Set(Object.values(PRODUCERS)))
      expect(fs.readFileSync(file, 'utf8')).toMatch(/onReasoningDelta/);
  });

  test('model-API routes declare thinking and their shared producer is tested', () => {
    expect(MODEL_API_STREAMING.reasoning).toBe('reasoning-delta');
    expect(fs.readFileSync('tests/aws-bedrock-transport.test.ts', 'utf8')).toMatch(/onReasoningDelta/);
  });
});
```

Plan 2 adds `codex-session` to `PRODUCERS` when it lands the ChatGPT producer.

- [ ] **Step 2: Run the full gates, one at a time, under the slot**

```bash
npx tsc --noEmit
npx vitest run
npx vite build
npx playwright test tests/ui.spec.ts tests/native-ui.spec.ts tests/field.spec.ts tests/reasoning-ui.spec.ts
npm test --prefix services/control-plane
```

Expected: all pass. Record the actual counts from this run. If a failure looks like contention flakiness, rerun that file alone before diagnosing.

- [ ] **Step 3: Update the records**

`docs/harness/CHANGES.md` gets an entry: the thinking channel (contract v1, `streaming.reasoning`), the producers by route, OpenRouter mapping only what its models return, the gateway change waiting on a Worker deploy, and saved thinking kept on the reply only.

In `docs/DIOMEDES_LIVE_ROADMAP.md`'s runtime-seam section: thinking streams on every conversation route that can supply it. ChatGPT (Codex) follows with Plan 2.

- [ ] **Step 4: Commit**

```bash
git add tests/reasoning-conformance.test.ts docs/harness/CHANGES.md docs/DIOMEDES_LIVE_ROADMAP.md
git commit -m "Pin thinking conformance and record the thinking channel"
```

- [ ] **Step 5: Report to Andrew**

Report:
- PILLAR IMPACT and ROADMAP IMPACT.
- The gate counts.
- What is committed but not pushed.
- That the Worker change waits for his approval to deploy.
- The OpenRouter deviation (Task 6).
- That the live proofs (a Claude Code conversation showing thinking, and a small paid Luna reply, the latter only with his approval) are still to run.
