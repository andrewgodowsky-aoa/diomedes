/**
 * H12 — the typed tool contract. Every harness tool declares its input and
 * output schemas, its effect class, the permission it needs and its approval
 * policy; a tool missing any of them is refused at registration, and every
 * registry Diomedes builds in production passes that check.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Json } from '../shared/harness.js';
import { ToolRegistry, type ToolDefinition } from '../server/harness/tools.js';
import { sourceTools } from '../server/harness/capabilities/conversation-sources.js';
import { readScopeTools } from '../server/harness/capabilities/read-scope-tools.js';
import { containedFileTools } from '../server/harness/capabilities/contained-file-tools.js';
import { TEAM_TOOLS, teamToolRegistry } from '../server/team/tools.js';

const complete = (): ToolDefinition<{ a?: number }, Json> => ({
  name: 'sum',
  version: '1',
  description: 'Adds.',
  effect: 'pure',
  effectClass: 'pure',
  permission: null,
  approval: false,
  destination: 'local',
  trustedInputRequired: false,
  cost: 0,
  schema: z.strictObject({ a: z.number().optional() }),
  outputSchema: z.strictObject({ total: z.number() }),
  execute: () => ({ total: 1 }),
});

const without = (key: keyof ToolDefinition) => {
  const tool = complete() as unknown as Record<string, unknown>;
  delete tool[key];
  return tool as unknown as ToolDefinition<unknown, Json>;
};

describe('registration refuses an incomplete or inconsistent declaration', () => {
  test.each([
    ['outputSchema', 'tool_contract_incomplete'],
    ['effectClass', 'tool_contract_incomplete'],
    ['permission', 'tool_contract_incomplete'],
    ['approval', 'tool_contract_incomplete'],
    ['trustedInputRequired', 'tool_contract_incomplete'],
    ['description', 'tool_contract_incomplete'],
    ['schema', 'invalid_tool'],
    ['execute', 'invalid_tool'],
  ] as const)('missing %s is refused with %s', (key, code) => {
    expect(() => new ToolRegistry().register(without(key))).toThrow(expect.objectContaining({ code }));
  });

  test.each([
    ['a write declared pure', { effect: 'idempotent', effectClass: 'pure' }],
    ['a read declared as a write', { effect: 'read', effectClass: 'idempotent-write' }],
    ['an external send to a local destination', { effect: 'non-idempotent', effectClass: 'external-send', destination: 'local' }],
    ['a local effect to an external destination', { effect: 'non-idempotent', effectClass: 'non-idempotent-effect', destination: 'external' }],
  ] as const)('%s is a contract mismatch', (_what, overrides) => {
    expect(() =>
      new ToolRegistry().register({ ...complete(), permission: 'x', targets: () => ['a'], ...overrides } as never),
    ).toThrow(expect.objectContaining({ code: 'tool_contract_mismatch' }));
  });

  test('a tool that changes the world must declare its targets, and an external send its permission', () => {
    const write = { ...complete(), effect: 'idempotent', effectClass: 'idempotent-write', permission: 'w' } as const;
    expect(() => new ToolRegistry().register(write as never)).toThrow(
      expect.objectContaining({ code: 'tool_contract_incomplete', message: expect.stringMatching(/targets/) }),
    );
    new ToolRegistry().register({ ...write, targets: () => ['a.md'] } as never);
    const send = {
      ...complete(),
      effect: 'non-idempotent',
      effectClass: 'external-send',
      destination: 'external',
      permission: null,
      targets: () => ['mail'],
    } as const;
    expect(() => new ToolRegistry().register(send as never)).toThrow(
      expect.objectContaining({ code: 'tool_contract_incomplete', message: expect.stringMatching(/permission/) }),
    );
  });

  test('a permission of undefined or an empty name is not a declaration', () => {
    expect(() => new ToolRegistry().register({ ...complete(), permission: undefined } as never)).toThrow(
      expect.objectContaining({ code: 'tool_contract_incomplete' }),
    );
    expect(() => new ToolRegistry().register({ ...complete(), permission: '' } as never)).toThrow(
      expect.objectContaining({ code: 'tool_contract_incomplete' }),
    );
  });

  test('limits outside the hard caps are refused', () => {
    expect(() => new ToolRegistry().register({ ...complete(), limits: { timeoutMs: 0 } })).toThrow(
      expect.objectContaining({ code: 'tool_contract_incomplete' }),
    );
    expect(() => new ToolRegistry().register({ ...complete(), limits: { maxOutputBytes: 1e12 } })).toThrow(
      expect.objectContaining({ code: 'tool_contract_incomplete' }),
    );
  });
});

describe('the declared schemas bind at run time', () => {
  const context = () => ({
    input: {},
    idempotencyKey: 'k',
    attempt: 1,
    fence: 1,
    signal: new AbortController().signal,
    publishPreview: async () => {},
  });

  test('an output that does not match its schema is refused', async () => {
    const tools = new ToolRegistry();
    tools.register({ ...complete(), execute: () => ({ total: 'many' }) as never });
    await expect(tools.get('sum').execute(context())).rejects.toMatchObject({ code: 'tool_output_rejected' });
  });

  test('the model-facing descriptor is unchanged: no handler, no output schema, no targets', () => {
    const tools = new ToolRegistry();
    tools.register(complete());
    expect(Object.keys(tools.describe()[0]).sort()).toEqual(
      ['approval', 'cost', 'description', 'destination', 'effect', 'inputSchema', 'name', 'permission', 'trustedInputRequired', 'version'],
    );
  });
});

describe('every production registry passes the contract', () => {
  test('attached-source, read-scope, contained-file and team tools all declare a complete contract', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'h12-contract-')));
    try {
      const stop = new AbortController();
      const reads = readScopeTools(
        {
          root,
          access: 'project',
          web: true,
          mcp: [{ name: 'pos', command: 'node', args: [], readTools: ['list'] }],
        } as never,
        { stop: stop.signal },
      );
      const registries = [
        sourceTools([{ path: 'a.md', text: 'a' }]),
        teamToolRegistry({} as never),
        containedFileTools(root),
      ];
      const fromReads = new ToolRegistry();
      for (const tool of reads.tools) fromReads.register(tool);
      registries.push(fromReads);
      const names = registries.flatMap((registry) => registry.describe().map((tool) => tool.name));
      expect(names).toEqual(expect.arrayContaining(['list_sources', 'read_source', 'list_files', 'read_file', 'search_files', 'fetch_page', 'connector_read', 'write_file', ...TEAM_TOOLS.map((tool) => tool.name)]));
      for (const registry of registries)
        for (const { name } of registry.describe()) {
          const tool = registry.get(name);
          expect(tool.outputSchema, name).toBeDefined();
          expect(tool.effectClass, name).toBeDefined();
        }
      await reads.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
