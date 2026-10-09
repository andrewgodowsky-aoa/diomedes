/**
 * NC-TS TS00 (DIO-227), TS-004: run a check with the network refused and no account credentials.
 * Test-only. Refuses fetch and the socket, TLS, DNS, HTTP and HTTPS entry points and records each
 * attempt, so a check can show that nothing tried. Native code that opens its own sockets is not
 * covered. The one network call these checks have seen, sync's bootstrap pull, went through fetch.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export interface NetworkRefusal { attempts: string[]; restore(): void }

export function refuseNetwork(): NetworkRefusal {
  const attempts: string[] = [];
  const saved: Array<[Record<string, unknown>, string, unknown]> = [];
  const replace = (target: object, key: string, value: unknown) => {
    const record = target as Record<string, unknown>;
    saved.push([record, key, record[key]]);
    record[key] = value;
  };
  replace(globalThis, 'fetch', async (input: unknown) => {
    attempts.push(`fetch ${String(input)}`);
    throw new TypeError('fetch failed: the network is refused for this check');
  });
  const entryPoints: Array<[string, object, string[]]> = [
    ['net', net, ['connect', 'createConnection']],
    ['tls', tls, ['connect']],
    ['http', http, ['request', 'get']],
    ['https', https, ['request', 'get']],
    ['dns', dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  ];
  for (const [name, target, keys] of entryPoints)
    for (const key of keys)
      replace(target, key, () => {
        attempts.push(`${name}.${key}`);
        throw new Error(`${name}.${key} is refused for this check`);
      });
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const [target, key, value] of saved.reverse()) target[key] = value;
      syncBuiltinESMExports();
    },
  };
}

/** Account and hosted-service credentials a free local start must not need. */
export const CREDENTIAL_VARIABLES = /^(NECTOVIA|DIOMEDES|WORKOS|TURSO|AGENTFS)_/i;

/** Removes matching variables from the environment; the returned function puts them back. */
export function withoutCredentials(pattern = CREDENTIAL_VARIABLES): () => void {
  const removed = Object.entries(process.env).filter(([key]) => pattern.test(key));
  for (const [key] of removed) delete process.env[key];
  return () => { for (const [key, value] of removed) process.env[key] = value; };
}
