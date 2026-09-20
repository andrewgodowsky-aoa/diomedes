import { describe, expect, it } from 'vitest';
import { inTransaction, type SqlClient } from '../src/postgres.js';

function recording(fail?: string) {
  const calls: string[] = [];
  const client: SqlClient = {
    async connect() { calls.push('connect'); },
    async query(text, _values) {
      calls.push(text);
      if (text === fail) throw Object.assign(new Error('private driver detail'), { code: '53300' });
      return { rows: [], rowCount: 0 };
    },
    async end() { calls.push('end'); },
  };
  return { client, calls };
}

describe('one actual driver-session transaction protocol', () => {
  it('connects, begins, commits and closes the same client', async () => {
    const { client, calls } = recording();
    expect(await inTransaction(() => client, async (tx) => { await tx.query('SELECT $1', ['value']); return 7; })).toBe(7);
    expect(calls[0]).toBe('connect');
    expect(calls.indexOf('BEGIN')).toBeLessThan(calls.indexOf('SELECT $1'));
    expect(calls.slice(-2)).toEqual(['COMMIT', 'end']);
  });
  it('rolls back before closing and preserves domain failures', async () => {
    const { client, calls } = recording();
    const rejection = new Error('domain refusal');
    await expect(inTransaction(() => client, async () => { throw rejection; })).rejects.toBe(rejection);
    expect(calls.slice(-2)).toEqual(['ROLLBACK', 'end']);
    expect(calls).not.toContain('COMMIT');
  });
  it('refuses a quota failure and never retries an uncertain commit', async () => {
    const { client, calls } = recording('COMMIT');
    await expect(inTransaction(() => client, async () => true)).rejects.toThrow('private driver detail');
    expect(calls.filter((call) => call === 'COMMIT')).toHaveLength(1);
    expect(calls.at(-1)).toBe('end');
  });
  it('closes on connection failure and does not claim a rollback that could not run', async () => {
    const { client, calls } = recording();
    client.connect = async () => { throw new Error('database unavailable'); };
    await expect(inTransaction(() => client, async () => true)).rejects.toThrow('database unavailable');
    expect(calls).toEqual(['end']);
  });
  it('retains rollback failure and never turns it into success', async () => {
    const { client, calls } = recording('ROLLBACK');
    await expect(inTransaction(() => client, async () => { throw new Error('mutation failed'); })).rejects.toMatchObject({ failures: expect.any(Array) });
    expect(calls.at(-1)).toBe('end');
  });
});
