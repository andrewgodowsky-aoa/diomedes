import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { inTransaction, type SqlClient } from '../src/postgres.js';

class EventClient extends EventEmitter implements SqlClient {
  calls: string[] = [];
  duringQuery?: (sql: string) => void;
  duringEnd?: () => void;
  async connect() { this.calls.push('connect'); }
  async query(sql: string) { this.calls.push(sql); this.duringQuery?.(sql); return { rows: [], rowCount: 0 }; }
  async end() { this.calls.push('end'); this.duringEnd?.(); }
}

describe('request-owned client error-event lifetime', () => {
  it('does not commit when an idle transaction event is observed without a rejected query promise', async () => {
    const client = new EventClient(); const failure = new Error('active transport failed');
    client.on('error', () => {}); // Independent observer, not the transaction owner.
    await expect(inTransaction(() => client, async () => { client.emit('error', failure); return 'must not succeed'; })).rejects.toBe(failure);
    expect(client.calls).not.toContain('COMMIT');
    expect(client.calls).toContain('ROLLBACK');
  });
  it('refuses a connection event before starting a transaction', async () => {
    const client = new EventClient(); const failure = new Error('connect event');
    client.on('error', () => {});
    client.connect = async () => { client.emit('error', failure); };
    const action = vi.fn(async () => true);
    await expect(inTransaction(() => client, action)).rejects.toBe(failure);
    expect(action).not.toHaveBeenCalled(); expect(client.calls).toEqual(['end']);
  });
  it('retains an event during commit and never retries or falsely rolls back an acknowledged commit', async () => {
    const client = new EventClient(); const failure = new Error('commit event');
    client.on('error', () => {});
    client.duringQuery = sql => { if (sql === 'COMMIT') client.emit('error', failure); };
    const action = vi.fn(async () => true);
    await expect(inTransaction(() => client, action)).rejects.toBe(failure);
    expect(action).toHaveBeenCalledTimes(1);
    expect(client.calls.filter(c => c === 'COMMIT')).toHaveLength(1);
    expect(client.calls).not.toContain('ROLLBACK');
  });
  it('does not swallow an error while close is still pending', async () => {
    const client = new EventClient(); const failure = new Error('close event');
    client.on('error', () => {});
    client.duringEnd = () => client.emit('error', failure);
    await expect(inTransaction(() => client, async () => true)).rejects.toBe(failure);
  });
  it('owns duplicate notifications after confirmed closure without leaking them into another request', async () => {
    const client = new EventClient();
    expect(await inTransaction(() => client, async () => 'committed')).toBe('committed');
    expect(() => client.emit('error', new Error('late closed socket notification'))).not.toThrow();
    const other = new EventClient();
    expect(await inTransaction(() => other, async () => 'separate request')).toBe('separate request');
    expect(client.calls.filter(c => c === 'COMMIT')).toHaveLength(1);
  });
});
