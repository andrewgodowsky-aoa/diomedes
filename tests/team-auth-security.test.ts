import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.js';
import { TeamService } from '../server/team/service.js';

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

test('stopping a helper immediately denies its existing team credential', async () => {
  await fs.mkdir(path.join(process.cwd(), 'test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'team-auth-'));
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  close = async () => {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    await fs.rm(root, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
  const projectResponse = await fetch(`${base}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Team auth' }),
  });
  expect(projectResponse.status).toBe(200);
  const project = await projectResponse.json() as { id: string };
  const memberResponse = await fetch(`${base}/api/projects/${project.id}/team/members`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'Helper', role: 'member', engine: 'probe' }),
  });
  expect(memberResponse.status).toBe(200);
  const { member, token } = await memberResponse.json() as {
    member: { slotId: string }; token: string;
  };
  const mcp = () => fetch(`${base}/mcp/team/${project.id}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'X-Slot-Id': member.slotId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect((await mcp()).status).toBe(200);
  const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const unknown = await fetch(`${base}/mcp/team/nonexistent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Slot-Id': member.slotId },
    body: requestBody,
  });
  const missingToken = await fetch(`${base}/mcp/team/${project.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Slot-Id': member.slotId },
    body: requestBody,
  });
  expect(unknown.status).toBe(401);
  expect(await unknown.text()).toBe(await missingToken.text());
  // fetch normalizes Host; use a raw HTTP client to exercise the Host gate.
  const badHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${base}/mcp/team/${project.id}`, {
      method: 'POST', headers: { Host: 'attacker.invalid', 'Content-Type': 'application/json' },
    }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on('error', reject);
    request.end(requestBody);
  });
  expect(badHost).toBe(403);
  const badOrigin = await fetch(`${base}/mcp/team/${project.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
    body: requestBody,
  });
  expect(badOrigin.status).toBe(403);

  const store = app.locals.store;
  const originalRead = store.readTeamSecrets.bind(store);
  let entered!: () => void;
  let releaseRead!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const pause = new Promise<void>((resolve) => { releaseRead = resolve; });
  store.readTeamSecrets = async (id: string) => {
    entered();
    await pause;
    return originalRead(id);
  };
  const inFlight = mcp();
  await reading;
  const stop = await fetch(`${base}/api/projects/${project.id}/team/members/${member.slotId}/stop`, {
    method: 'POST', headers, body: '{}',
  });
  expect(stop.status).toBe(200);
  const wake = await fetch(`${base}/api/projects/${project.id}/team/members/${member.slotId}/wake`, {
    method: 'POST', headers, body: '{}',
  });
  expect(wake.status).toBe(401);
  releaseRead();
  expect((await inFlight).status).toBe(401);
  store.readTeamSecrets = originalRead;
  expect((await mcp()).status).toBe(401);
  // A delayed native run result must not make the stopped credential valid again.
  await store.locked(async () => {
    new TeamService(store).setMemberStatus(project.id, member.slotId, 'waiting');
    await store.persist(store.state(project.id));
  });
  const team = await fetch(`${base}/api/projects/${project.id}/team`);
  expect((await team.json()).members[0].status).toBe('stopped');
  expect((await mcp()).status).toBe(401);
});
