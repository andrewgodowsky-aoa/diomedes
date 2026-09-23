import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexArtifacts, savedDocument, type ArtifactRecord } from '../client/console/artifacts';
import { saveArtifact } from '../client/console/artifact-save';

// Save to Files against an in-memory copy of the three document routes it uses
// (server/app.ts: documents/create refuses a name that exists with 409, and
// documents/write refuses a stale base hash with 409). The real client `api`
// and `readDocument` run; only fetch is replaced.

const PROJECT = 'project-1';
const SAVED = 'Saved artifacts/Delivery check.md';
const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const said = (id: string, text: string) => ({ id, role: 'diomedes', text });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const flow = (steps: string) =>
  fence('mermaid', `%% artifact: id=delivery-flow title="Delivery check"\ngraph TD\n  ${steps}`);

function versions(): [ArtifactRecord, ArtifactRecord] {
  const index = indexArtifacts('thread-1', [said('t1', flow('A-->B')), said('t2', flow('A-->B-->C'))]);
  const [one, two] = index.list;
  return [one, two];
}

interface Call {
  method: string;
  route: string;
  body: Record<string, unknown> | undefined;
}

let files: Map<string, string>;
let calls: Call[];
let afterRead: ((path: string) => void) | null;
let failCreate: { status: number; message: string } | null;

const reply = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const routes = () => calls.map((call) => `${call.method} ${call.route}`);

beforeEach(() => {
  files = new Map();
  calls = [];
  afterRead = null;
  failCreate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://127.0.0.1');
      const prefix = `/api/projects/${PROJECT}/documents/`;
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, route, body });
      if (route === 'create' && method === 'POST') {
        if (failCreate) return reply(failCreate.status, { error: { message: failCreate.message } });
        const path = String(body?.path);
        if (files.has(path)) return reply(409, { error: { message: 'A document with this name exists.' } });
        files.set(path, String(body?.text));
        return reply(200, { id: `E${calls.length}` });
      }
      if (route === 'read' && method === 'GET') {
        const path = url.searchParams.get('path') ?? '';
        const text = files.get(path);
        if (text === undefined) return reply(404, { error: { message: 'No such document.' } });
        const response = reply(200, { path, text, sha: sha(text) });
        afterRead?.(path);
        return response;
      }
      if (route === 'write' && method === 'POST') {
        const path = String(body?.path);
        if (sha(files.get(path) ?? '') !== body?.baseSha)
          return reply(409, { error: { message: 'This document changed since you opened it.' } });
        files.set(path, String(body?.text));
        return reply(200, { sha: sha(String(body?.text)), entryId: `E${calls.length}` });
      }
      return reply(404, { error: { message: `No route for ${method} ${route}.` } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Save to Files', () => {
  it('creates the first save under Saved artifacts, through documents/create only', async () => {
    const [one] = versions();
    expect(await saveArtifact(PROJECT, one)).toEqual({
      ok: true,
      path: SAVED,
      created: true,
      sentence: `Saved to Files as ${SAVED}.`,
    });
    expect(routes()).toEqual(['POST create']);
    expect(files.get(SAVED)).toBe(savedDocument(one, one.title));
  });

  it('says the same version is already saved, and writes nothing', async () => {
    const [one] = versions();
    await saveArtifact(PROJECT, one);
    calls = [];
    expect(await saveArtifact(PROJECT, one)).toMatchObject({
      ok: true,
      created: false,
      sentence: `Already saved as ${SAVED}.`,
    });
    expect(routes()).toEqual(['POST create', 'GET read']);
  });

  it('writes a later version over its own file, based on the version it read', async () => {
    const [one, two] = versions();
    await saveArtifact(PROJECT, one);
    const before = files.get(SAVED)!;
    calls = [];
    expect(await saveArtifact(PROJECT, two)).toMatchObject({
      ok: true,
      created: false,
      sentence: `Saved this version over ${SAVED}.`,
    });
    expect(routes()).toEqual(['POST create', 'GET read', 'POST write']);
    // merge: false keeps this version its own History entry, however soon after the last it comes.
    expect(calls[2].body).toEqual({
      path: SAVED,
      text: savedDocument(two, two.title),
      baseSha: sha(before),
      merge: false,
    });
    expect([...files.keys()]).toEqual([SAVED]);
    expect(files.get(SAVED)).toBe(savedDocument(two, two.title));
  });

  it('never writes over a file of the same name that is not this artifact', async () => {
    const [one] = versions();
    const mine = '# Delivery check\n\nMy own notes.\n';
    files.set(SAVED, mine);
    expect(await saveArtifact(PROJECT, one)).toMatchObject({
      ok: true,
      created: true,
      path: 'Saved artifacts/Delivery check 2.md',
    });
    expect(files.get(SAVED)).toBe(mine);
    expect(routes()).not.toContain('POST write');
  });

  it('refuses to save over a file that changed after it was read', async () => {
    const [one, two] = versions();
    await saveArtifact(PROJECT, one);
    afterRead = (path) => files.set(path, `${files.get(path)}\nEdited in the meantime.\n`);
    expect(await saveArtifact(PROJECT, two)).toEqual({
      ok: false,
      sentence: `Not saved. ${SAVED} changed while this was saving; save again.`,
    });
    expect(files.get(SAVED)).toContain('Edited in the meantime.');
  });

  it('says what the service said when a save fails, and leaves Files as it was', async () => {
    const [one] = versions();
    failCreate = { status: 500, message: 'The disk is full.' };
    expect(await saveArtifact(PROJECT, one)).toEqual({ ok: false, sentence: 'Not saved. The disk is full.' });
    expect(files.size).toBe(0);
  });

  it('saves a design as its own page', async () => {
    const index = indexArtifacts('thread-1', [
      said('t1', fence('html', '<!-- artifact: id=home-mock title="Home mock" -->\n<h1>Hello</h1>')),
    ]);
    expect(await saveArtifact(PROJECT, index.list[0])).toMatchObject({
      ok: true,
      created: true,
      path: 'Saved artifacts/Home mock.html',
    });
  });
});
