import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import type { HarnessHost } from '../server/harness/host.js';

// Deliberately host-only. No HTTP request can arm Trust or create this grant.
// Each NEW proof directory admits at most one real generation; never retry an
// uncertain result by rerunning this driver against its saved directory.
assert.equal(process.argv[2], '--send-synthetic', 'Explicit --send-synthetic is required.');
assert.ok(process.argv[3], 'Supply a new, independent proof directory.');
const root = path.resolve(process.argv[3]);
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root);
process.env.DIOMEDES_DATA_DIR = path.join(root, 'data');
process.env.DIOMEDES_RUNTIME_DIR = fileURLToPath(new URL('../.data/native-runtime', import.meta.url));
// CODEX_HOME is deliberately unchanged. Native account/read uses the existing
// permitted sign-in. No credentials are read, copied or written by this driver.
const { Store, hash } = await import('../server/store.js');
const { createHarnessHost } = await import('../server/harness/host.js');
const { askCodex } = await import('../server/integrations.js');
const { parseApprovalCommand, validateApprovalReceipts } = await import('../server/approval-admission.js');
const trust = await import('../server/trust/index.js');
const expected = '# Synthetic report\n\n- North: 3\n- South: 2\n- Total: 5\n';
const proof: Record<string, unknown> = {
  startedAt: new Date().toISOString(), root, passed: false, providerEntryCalls: 0,
  route: 'existing native ChatGPT sign-in; no API fallback',
  assurance: 'synthetic prototype; no authenticated human or device claim',
  expectedReport: expected,
};
let host: HarnessHost | undefined;
let entries = 0;
try {
  trust.enablePrototypeAuthority({ label: 'codex-report-driver',
    capabilities: ['work.submit', 'work.cancel', 'egress.send', 'egress.reconcile',
      'approval.decide', 'write.apply', 'project.read'],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  const authority = await trust.currentAuthority({ via: 'prototype-driver', label: 'codex-report-driver' });
  assert.ok(!trust.isDenial(authority));
  const ref = trust.refOf(authority);
  const resolved = await trust.currentAuthority({ via: 'stored-reference', ref });
  assert.ok(!trust.isDenial(resolved), 'Trust must resolve its bounded prototype reference before provider access.');
  assert.equal(resolved.synthetic, true);
  assert.equal(resolved.assurance, 'prototype');
  assert.deepEqual([...resolved.capabilities].sort(), [...authority.capabilities].sort());
  assert.equal(resolved.expiresAt, authority.expiresAt);
  const store = new Store(path.join(root, 'data'), path.join(root, 'projects'));
  await store.init();
  const open = async () => {
    const next = createHarnessHost({ store, dataDir: store.dataDir,
      codexGenerator: async input => {
        assert.equal(entries, 0, 'This proof permits one provider entry only.');
        entries++;
        proof.providerEntryCalls = entries;
        return askCodex(input);
      } });
    await next.init();
    return next;
  };
  host = await open();
  const project = await store.locked(() => store.createProject('Synthetic harness proof'));
  const state = () => store.state(project.id);
  await fs.writeFile(path.join(project.folder, 'Synthetic.txt'), 'Synthetic counts: North=3, South=2.\n');
  store.settings.services = { codex: true };
  store.settings.permissions.sending = true;
  await store.saveSettings(store.settings);
  const task = await store.locked(async () => {
    const result = store.createTask(state(), { name: 'Synthetic count report',
      description: 'Bounded native provider proof', owner: 'diomedes-with-ok' });
    await store.persist(state());
    return result;
  });
  const command = { protocolVersion: 1, commandId: 'nr03-single-synthetic-command',
    taskId: task.id, route: 'codex', capabilityId: 'codex-report',
    instruction: `Use the supplied synthetic counts. Propose exactly this complete file text, including its final newline: ${JSON.stringify(expected)}. Return the required JSON proposal.`,
    sources: ['Synthetic.txt'], consent: true };
  const selection = { model: 'gpt-5.6-luna', effort: 'low' };
  const session = await host.startCodexReport(project.id, command, selection);
  assert.ok(session.receipt);
  assert.deepEqual((await host.startCodexReport(project.id, command, selection)).receipt, session.receipt);
  proof.startReceipt = session.receipt;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const current = state().sessions.find(s => s.id === session.id)!;
    if (current.state === 'waiting' || current.state === 'failed' || current.state === 'stopped') break;
    await pause(250);
  }
  const run = (await host.list(project.id)).find(r => r.sessionId === session.id)!;
  proof.beforeDecisionRun = run;
  const need = state().needs.find(n => n.sessionId === session.id && n.state === 'open');
  assert.ok(need?.harness && need.approval, 'The real result must reach an exact Need; an unknown result stays parked.');
  assert.equal(run.state, 'waiting');
  assert.equal(run.steps.filter(s => s.intent.kind === 'model').length, 1);
  assert.equal(run.steps[0].attempt, 1);
  assert.equal(entries, 1);
  assert.ok(run.transcripts.codex?.opaqueRef);
  assert.equal(await store.current(project.id, 'Harness report.md'), null);
  const input = need.harness.intent.input;
  assert.ok(input && typeof input === 'object' && !Array.isArray(input));
  assert.equal(input.text, expected, 'Only the exact predeclared synthetic report may be approved automatically.');
  await fs.writeFile(path.join(root, 'exact-proposal.md'), expected);
  proof.need = structuredClone(need);
  // Recreate the host without its egress grant, while the independently armed
  // Trust authority is still alive. Cached observation replay must not dispatch.
  await host.close();
  host = await open();
  const saved = state().needs.find(n => n.id === need.id)!;
  const approval = parseApprovalCommand(project.id, saved.id, {
    protocolVersion: 1, commandId: 'nr03-exact-synthetic-decision', resolution: 'go-ahead',
    proposalDigest: saved.approval!.proposalDigest, actionDigest: saved.approval!.actionDigest,
    baseDigest: saved.approval!.baseDigest,
  })!;
  await store.locked(() => host!.bridge.resolve(project.id, saved.id, 'go-ahead', false, approval));
  await store.locked(() => host!.bridge.resolve(project.id, saved.id, 'go-ahead', false, approval));
  const completionDeadline = Date.now() + 10_000;
  while ((await host.get(project.id, run.id)).state !== 'completed' && Date.now() < completionDeadline) await pause(100);
  const completed = await host.get(project.id, run.id);
  assert.equal(completed.state, 'completed');
  assert.equal(entries, 1);
  assert.equal(await store.current(project.id, 'Harness report.md'), expected);
  assert.equal(state().history.filter(h => h.approvalId === saved.id && h.files.length).length, 1);
  validateApprovalReceipts(state());
  proof.finalRun = completed;
  proof.appliedNeed = state().needs.find(n => n.id === saved.id);
  proof.history = state().history;
  proof.reportSha256 = hash(expected);
  trust.disablePrototypeAuthority();
  assert.ok(trust.isDenial(await trust.currentAuthority({ via: 'stored-reference', ref })));
  proof.disabledReferenceDenied = true;
  proof.passed = true;
  console.log('PASS: one native Codex turn, durable start, exact proposal, host recovery without egress grant, one recorded write, replay, and authority disable.');
} catch (error) {
  proof.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(proof.error);
} finally {
  if (host) await host.close();
  trust.disablePrototypeAuthority();
  proof.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'proof.json'), JSON.stringify(proof, null, 2));
}
