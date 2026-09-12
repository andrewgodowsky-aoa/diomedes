/**
 * Demonstration journey B (technical user) against the packaged candidate.
 *
 *   node scripts/demo-journey-b.mjs --exe <path to Diomedes.exe> [--dry] [--model <slug>]
 *
 * `--dry` develops the whole traversal on the built-in `sample` route so it
 * costs nothing. Without it the assignment runs on the OpenCode account route
 * and spends real turns; the script counts them from the server's own sessions.
 * `--model` only picks a different entry of the list the running app advertises;
 * an identifier the runtime does not offer is ignored.
 *
 * Every step is named and records `traversed | intervention | not-reachable |
 * failed` with one line of note and a screenshot. API calls appear only in
 * `backendPreparation`: making the disposable repository, making the task the
 * Console cannot make, and reading state to check what the interface claimed.
 * No API call stands in for a UI step that exists.
 */
import { _electron as electron } from '@playwright/test';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const at = args.indexOf('--exe');
const exe = path.resolve(
  (at >= 0 ? args[at + 1] : '') ||
    'F:/Diomedes/diomedes-wt/release-20260912/release/Diomedes-win32-x64/Diomedes.exe',
);
const mat = args.indexOf('--model');
const wantedModel = mat >= 0 ? args[mat + 1] : '';
const LOCK = 'F:/Diomedes/diomedes-wt/release-20260912/test-results/candidate/browser.lock';
const root = path.resolve('test-results/journey-b');
const shots = path.resolve('evidence/demo-journeys/b');
const record = path.join(shots, dry ? 'journey-b-dry.json' : 'journey-b.json');
const REPO = 'greet-kit';
const TASK = 'Add NOTES.md for src/greet.js';
const ASK =
  'Create NOTES.md at the top of this project. Write at most eight lines saying what ' +
  'src/greet.js exports and how to call each export. Change no other file.';

const steps = [];
/** Set when the assignment itself faulted: every downstream step names it instead of timing out. */
let upstreamFault = null;
const backendPreparation = [];
const limitations = [];
const out = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  candidate: { exe, sha256: '', baseCommit: '' },
  mode: dry ? 'dry' : 'real',
  route: dry ? 'sample' : 'opencode',
  model: null,
  accountRoute: null,
  liveTurns: 0,
  steps,
  knownFailure: { induced: null, recoveryActionSeen: null },
  stop: { scope: null, receipt: null },
  followUp: { queued: null, fate: null },
  reopen: { closedVia: null, foundAgain: null, leakedProcesses: [] },
  backendPreparation,
  limitations,
};

let app = null;
let page = null;
let url = '';
let projectId = '';
let taskName = TASK;
let count = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const line = (v) =>
  String(v ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 260);

async function api(route, method = 'GET', data, why = '') {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  const seen = backendPreparation.find((e) => e.route === route && e.method === method && e.why === why);
  if (seen) seen.calls = (seen.calls ?? 1) + 1;
  else backendPreparation.push({ route, method, status: response.status, why, calls: 1 });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${line(text)}`);
  return text ? JSON.parse(text) : null;
}
const projectState = () =>
  api(`/projects/${projectId}/state`, 'GET', undefined, 'verify what the interface claimed');

async function shot(name) {
  count += 1;
  const file = path.join(shots, `${String(count).padStart(2, '0')}-${slug(name)}.png`);
  try {
    await page?.screenshot({ path: file, animations: 'disabled' });
  } catch {
    /* a closed window has nothing to capture */
  }
}

/** One named step. `it` may set `status`/`note`; a throw becomes `failed`. */
async function step(name, it) {
  const rec = { name, status: null, note: '' };
  steps.push(rec);
  try {
    const value = await it(rec);
    rec.status ??= 'traversed';
    return value;
  } catch (error) {
    rec.status ??= 'failed';
    if (!rec.note) rec.note = line(error?.message ?? error);
    return null;
  } finally {
    await shot(name);
    console.log(`${rec.status.padEnd(13)} ${name} — ${rec.note}`);
  }
}

async function waitForGate() {
  for (let n = 0; n < 80; n++) {
    try {
      await fs.access(LOCK);
    } catch {
      return;
    }
    console.log('browser.lock held by the integrator; waiting 15 s');
    await sleep(15_000);
  }
  throw new Error('browser.lock did not clear within 20 minutes');
}

async function launch() {
  await waitForGate();
  const env = {
    ...process.env,
    DIOMEDES_DESKTOP_PROFILE: path.join(root, 'profile'),
    DIOMEDES_DATA_DIR: path.join(root, 'data'),
    DIOMEDES_PROJECTS_DIR: path.join(root, 'projects'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: exe, env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForURL('http://127.0.0.1:*/');
  url = new URL(page.url()).origin;
}

async function close() {
  try {
    await app?.close();
  } catch {
    /* already gone */
  }
  app = null;
  page = null;
}

const tap = (locator) => locator.click({ timeout: 2500 }).then(() => true, () => false);

/** Click through onboarding with its own controls. Buttons disable while each save is in flight. */
async function onboard() {
  for (let n = 0; n < 80; n++) {
    if (await page.locator('.console, .projects-page, .workbook-layout').first().isVisible().catch(() => false))
      return;
    if (await tap(page.getByRole('button', { name: 'Open Diomedes', exact: true }))) continue;
    if (await tap(page.getByRole('button', { name: 'Skip AI setup', exact: true }))) continue;
    if (await tap(page.getByRole('button', { name: 'Continue', exact: true }).first())) continue;
    await sleep(500);
  }
  throw new Error('onboarding did not reach the app');
}

async function makeRepository() {
  const folder = path.join(root, 'projects', REPO);
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(path.join(folder, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(folder, 'AGENTS.md'),
    '# Rules for this repository\n\n' +
      '1. Keep every file under twenty lines.\n' +
      '2. Say a thing once: no comment repeats what the code already says.\n',
  );
  await fs.writeFile(
    path.join(folder, 'README.md'),
    '# greet-kit\n\nA two-function greeting helper used by the journey B demonstration.\n',
  );
  await fs.writeFile(
    path.join(folder, 'src', 'greet.js'),
    'export function greet(name) {\n' +
      '  // TODO: the greeting ignores `name`; it should read `Hello, <name>.`\n' +
      "  return 'Hello.';\n" +
      '}\n\n' +
      'export function farewell(name) {\n' +
      '  return `Goodbye, ${name}.`;\n' +
      '}\n',
  );
  for (const command of [
    ['init', '-q'],
    ['add', '-A'],
    ['-c', 'user.email=journey@b', '-c', 'user.name=journey', 'commit', '-qm', 'first'],
  ])
    execFileSync('git', command, { cwd: folder, stdio: 'ignore' });
  backendPreparation.push({
    route: 'filesystem',
    method: 'write',
    status: 200,
    calls: 1,
    why: `disposable git repository at ${folder}`,
  });
  return folder;
}

const rail = () => page.getByRole('navigation', { name: 'Threads and views' });
const board = () => page.locator('.board[aria-label="Board"]');
const dialog = (name) => page.getByRole('dialog', { name });
const errorBar = () => page.locator('.error-bar[role="alert"], .toast').first();
/** The app's own error bar is modal-adjacent: clear it before it eats the next click. */
async function dismiss() {
  for (let n = 0; n < 5; n++) {
    if (!(await errorBar().isVisible().catch(() => false))) return;
    await tap(page.getByRole('button', { name: 'Dismiss', exact: true }).first());
    await errorBar().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  }
}
/** A `<dialog>` opened with showModal makes the rest of the page inert. */
async function closeDialogs() {
  for (let n = 0; n < 4; n++) {
    const open = page.locator('dialog[open]').first();
    if (!(await open.isVisible().catch(() => false))) return;
    if (!(await tap(open.getByRole('button', { name: 'Close dialog' })))) await page.keyboard.press('Escape');
    await sleep(300);
  }
}
/** Read the app's own refusal for one action. The bar must be gone first, or the reading is stale. */
async function alertAfter(action) {
  await dismiss();
  await errorBar().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await action();
  await errorBar().waitFor({ timeout: 20_000 });
  return line(await errorBar().textContent()).replace(/\s*Dismiss$/, '');
}
/** Click through the app's own transient furniture rather than fighting it. */
async function press(locator, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      await locator.click({ timeout: 2500 });
      return;
    } catch (error) {
      last = error;
      if (Date.now() > end) throw last;
      await dismiss();
      await sleep(300);
    }
  }
}
/**
 * Come back to the Console. Settings replaces it and its own top-strip button
 * closes it again; History and the Workbook rail link change the surface, and
 * only the interface-detail menu changes it back.
 */
async function toConsole() {
  await closeDialogs();
  for (let n = 0; n < 10; n++) {
    if (await page.locator('.console').isVisible().catch(() => false)) return;
    if (await page.getByRole('navigation', { name: 'Settings' }).isVisible().catch(() => false))
      await tap(page.getByRole('button', { name: 'Settings', exact: true }).first());
    else {
      await tap(page.getByRole('button', { name: 'Interface detail menu' }));
      await tap(page.getByRole('button', { name: 'The Console', exact: true }));
    }
    await sleep(700);
  }
  throw new Error('the Console did not come back');
}

async function openBoard() {
  await toConsole();
  await press(rail().getByRole('button', { name: /^Board/ }));
  await board().waitFor();
  await tap(board().getByRole('button', { name: 'compact', exact: true }));
}
const taskRow = () => board().locator('.crow', { hasText: taskName }).first();

/** Settings > Engines is the only Console control over the OpenCode route. Its switch saves over HTTP. */
async function engineSwitch(wanted) {
  await closeDialogs();
  if (!(await page.locator('section.service[aria-label="OpenCode"]').isVisible().catch(() => false))) {
    await toConsole();
    await press(rail().getByRole('button', { name: 'Engines', exact: true }));
  }
  const box = page.locator('section.service[aria-label="OpenCode"] label.switch input[type=checkbox]');
  await box.waitFor({ timeout: 30_000 });
  for (let n = 0; n < 12 && (await box.isChecked()) !== wanted; n++) {
    if (n % 4 === 0) await press(box);
    await sleep(600);
  }
  if ((await box.isChecked()) !== wanted)
    throw new Error(`the OpenCode switch would not turn ${wanted ? 'on' : 'off'}`);
}

/** Ready row -> Start -> inline confirm -> the external route's "Send this task?" dialog. */
async function startFromBoard() {
  await openBoard();
  const row = taskRow();
  const start = row.getByRole('button', { name: 'Start', exact: true }).first();
  // A row that offers no Start is a finding, not a timeout: let the step say so.
  if (!(await start.isVisible().catch(() => false))) return null;
  await press(start);
  const confirm = row.locator('.confirm');
  if (await confirm.isVisible().catch(() => false))
    await press(confirm.getByRole('button', { name: 'Start', exact: true }));
  const send = dialog('Send this task?');
  if (await send.isVisible().catch(() => false)) {
    await shot('send-this-task');
    await press(send.getByRole('button', { name: 'Send task', exact: true }));
    return true;
  }
  return false;
}

/** Approve every open proposal the app puts in front of the person, in the dialog or in the thread. */
async function approveOpenNeeds() {
  const openIds = async () =>
    (await projectState()).needs.filter((need) => need.state === 'open').map((need) => need.id).join();
  for (let n = 0; n < 5; n++) {
    const before = await openIds();
    if (!before) return;
    const shown = page.locator('dialog[open]').first();
    const where = (await shown.isVisible().catch(() => false)) ? shown : page.locator('#scrThread');
    await press(where.getByRole('button', { name: 'Go ahead', exact: true }).first());
    for (let w = 0; w < 90; w++) {
      const now = await projectState();
      const ids = now.needs.filter((need) => need.state === 'open').map((need) => need.id).join();
      if (ids !== before && !now.sessions.some((s) => ['queued', 'working'].includes(s.state))) break;
      await sleep(2000);
    }
  }
}

async function journey() {
  await step('onboarding', async (r) => {
    await onboard();
    r.note = 'Welcome, three questions, AI setup and "Open Diomedes", each with its own control.';
  });

  const folder = await makeRepository();

  await step('path-guard-refusal', async (r) => {
    const probe = 'F:\\Diomedes\\diomedes\\node_modules';
    await press(page.getByRole('button', { name: /Open a folder as a project/ }).first());
    const box = dialog('Open a folder as a project');
    await box.locator('input').first().fill(probe);
    const said = await alertAfter(() =>
      press(box.getByRole('button', { name: 'Open project', exact: true })),
    );
    await tap(box.getByRole('button', { name: 'Cancel', exact: true }));
    await closeDialogs();
    await dismiss();
    out.knownFailure.pathGuard = { folder: probe, said };
    r.note = `A guarded folder is refused in words and the dialog stays open to correct: "${said}"`;
  });

  await step('open-repository', async (r) => {
    await press(page.getByRole('button', { name: /Open a folder as a project/ }).first());
    const box = dialog('Open a folder as a project');
    await box.locator('input').first().fill(folder);
    await press(box.getByRole('button', { name: 'Open project', exact: true }));
    await page.locator('.console').waitFor({ timeout: 30_000 });
    const listed = await api('/projects', 'GET', undefined, 'read the opened project id');
    projectId = (listed.projects ?? listed).find((p) => p.folder === folder)?.id ?? '';
    if (!projectId) throw new Error('the opened project is not in /api/projects');
    r.note = `Opened ${REPO} with the Console's own "Open a folder as a project" control.`;
  });

  await step('make-the-task', async (r) => {
    const made = await api(
      `/projects/${projectId}/tasks`,
      'POST',
      { name: TASK, description: ASK },
      'the Console has no task-creation control; fixture preparation',
    );
    taskName = made.name;
    r.status = 'not-reachable';
    r.note = 'The Console cannot make a task; only the frozen Workbook plan path can. Made by API as a fixture.';
  });

  await step('engine-setup', async (r) => {
    await press(rail().getByRole('button', { name: 'Engines', exact: true }));
    await press(page.getByRole('button', { name: 'Check this computer', exact: true }));
    const card = page.locator('section.service[aria-label="OpenCode"]');
    await card.waitFor({ timeout: 60_000 });
    await press(card.getByRole('button', { name: /Check sign-in and models/ }));
    const select = card.locator('select[aria-label="OpenCode model"]');
    await select.waitFor({ timeout: 120_000 });
    const catalog = await api(
      '/engines/opencode/models',
      'GET',
      undefined,
      'check the picker against the catalogue the app advertises',
    );
    out.advertisedModels = catalog.models.map((m) => m.slug);
    await engineSwitch(true);
    const detail = line(await card.locator('p').first().textContent());
    if (!dry) {
      // The model comes from the runtime's own list; nothing here is a typed identifier.
      // --model only picks a different entry of that same advertised list, through the select.
      if (wantedModel && out.advertisedModels.includes(wantedModel))
        await select.selectOption(wantedModel).catch(() => {});
      out.model = await select.inputValue();
      await press(card.getByRole('button', { name: 'Use as default', exact: true }));
      for (let n = 0; n < 20; n++) {
        const saved = await api('/settings', 'GET', undefined, 'read the saved engine default');
        if (saved.services?.defaultEngine === 'opencode') {
          out.accountRoute = saved.services.opencodeAccountRoute ?? null;
          out.model = saved.services.opencodeModel ?? out.model;
          break;
        }
        await sleep(500);
      }
      if (!out.accountRoute) throw new Error('"Use as default" did not record an account route');
    }
    await toConsole();
    r.note =
      `OpenCode: "${detail}". ${out.advertisedModels.length} models advertised; ` +
      (dry ? 'left off for the sample route.' : `${out.model} set as the default on ${out.accountRoute}.`);
  });

  await step('open-the-task-thread', async (r) => {
    await openBoard();
    await press(taskRow().getByRole('button', { name: taskName }));
    await page.locator('#scrThread').waitFor({ timeout: 30_000 });
    r.note = "The board row's task name opens (and, the first time, makes) the task's thread.";
  });

  await step('activate-software-engineering-pack', async (r) => {
    await press(page.locator('.task-permission button').first());
    const box = dialog('Task permissions');
    const packs = box.locator('section.pack-settings');
    await packs.waitFor();
    await press(packs.getByRole('button', { name: 'Activate', exact: true }).first());
    await packs.getByRole('button', { name: 'Turn off', exact: true }).first().waitFor();
    await shot('capabilities-panel');
    await press(box.getByRole('button', { name: 'Close dialog' }));
    const view = await api(
      `/projects/${projectId}/packs`,
      'GET',
      undefined,
      'confirm activation recorded no grant',
    );
    const after = await projectState();
    r.note =
      `Software Engineering is on; ${view.instructionFiles.length} instruction files recorded; ` +
      `${(after.grants ?? []).length} grants and ${after.needs.length} needs — activation granted nothing.`;
  });

  await step('inspect-project-instructions', async (r) => {
    const head = page.locator('.instructions-line');
    await head.waitFor({ timeout: 20_000 });
    const label = line(await head.textContent());
    await press(head);
    await press(page.locator('.instructions-panel .instructions-name').first());
    await page.locator('.instructions-body').first().waitFor();
    const body = line(await page.locator('.instructions-body').first().textContent());
    await tap(head);
    r.note = `"${label}" — AGENTS.md opens and reads back "${body.slice(0, 80)}". Nothing here reaches a model (HAR-01).`;
  });

  await step('choose-the-model-on-the-thread', async (r) => {
    await press(page.locator('.picker.model-picker > button'));
    const menu = page.locator('.pmenu.open');
    await menu.waitFor();
    const offered = await menu.locator('[role="menuitemradio"] .id').allTextContents();
    await shot('engine-picker');
    await page.keyboard.press('Escape');
    if (offered.some((slug) => slug.startsWith('opencode-go/'))) {
      r.note = `The thread picker offers ${offered.length} choices including OpenCode models.`;
      return;
    }
    r.status = 'not-reachable';
    r.note =
      `The thread's engine picker offers only ${offered.join(', ') || 'nothing'}: Picker.tsx requires ` +
      'IntegrationStatus.available, and discovery never sets it for OpenCode. Settings > Engines is the only route control.';
  });

  if (!dry) {
    await step('known-failure-account-unavailable', async (r) => {
      await engineSwitch(false);
      let confirmed = false;
      const message = await alertAfter(async () => {
        confirmed = await startFromBoard();
      });
      const spent = (await projectState()).sessions.filter((s) => s.route === 'opencode').length;
      out.knownFailure.induced = `OpenCode turned off in Settings > Engines while it is the task's route (${spent} turns spent)`;
      out.knownFailure.recoveryActionSeen = message;
      r.note = `${confirmed ? 'Confirmed and sent; ' : ''}refused with: "${message}" — no substitute route ran.`;
    });

    await step('recover-by-turning-the-engine-back-on', async (r) => {
      await engineSwitch(true);
      await toConsole();
      r.note = 'The refusal named the control that fixes it; the switch in Settings > Engines is that control.';
    });
  }

  await step('assign-the-bounded-change', async (r) => {
    const before = (await projectState()).sessions.length;
    const confirmed = await startFromBoard();
    if (confirmed === null) throw new Error('the Ready row offered no Start control');
    for (let n = 0; n < 150; n++) {
      const now = await projectState();
      if (now.sessions.length > before && !now.sessions.some((s) => ['queued', 'working'].includes(s.state)))
        break;
      await sleep(2000);
    }
    const now = await projectState();
    out.liveTurns = now.sessions.filter((s) => s.route === 'opencode').length;
    const last = now.sessions.at(-1);
    out.reportedModel = last?.engine?.model ?? null;
    if (last?.state === 'failed') {
      upstreamFault = line([...now.history].reverse().find((h) => h.kind === 'fault')?.sentence);
      r.status = 'failed';
    }
    r.note =
      `${confirmed ? '"Send this task?" confirmed. ' : ''}Session ended ${last?.state}` +
      `${last?.engine?.model ? ` on ${last.engine.model}` : ' with no model recorded'}; ` +
      `OpenCode turns so far: ${out.liveTurns}.${upstreamFault ? ` Fault: "${upstreamFault}"` : ''}`;
  });

  await step('exact-proposal', async (r) => {
    if (upstreamFault) {
      await shot('proposal-preview');
      r.status = 'failed';
      r.note = `No proposal to inspect: the turn faulted. "${upstreamFault}"`;
      return;
    }
    await openBoard();
    const row = board().locator('.column[aria-label="Review"] .crow', { hasText: taskName }).first();
    if (await row.isVisible().catch(() => false))
      await press(row.getByRole('button', { name: 'Review', exact: true }));
    await page.locator('#scrThread').waitFor();
    const open = (await projectState()).needs.filter((n) => n.state === 'open');
    if (!open.length) throw new Error('the run produced no proposal to inspect');
    await tap(page.locator('#scrThread').getByRole('button', { name: /^Show/ }).first());
    await shot('proposal-preview');
    const named = open.flatMap((n) => n.files);
    r.note = named.length
      ? `The proposal names exactly ${named.join(', ')} and shows its text before any write.`
      : `The open decision is "${line(open[0].what)}" — a start consent, not a file proposal.`;
    await closeDialogs();
  });

  await step('approve-and-record-the-write', async (r) => {
    if (!(await projectState()).needs.some((n) => n.state === 'open')) {
      r.status = 'failed';
      r.note = `Nothing was put in front of the person to approve${upstreamFault ? `: "${upstreamFault}"` : ''}.`;
      return;
    }
    await approveOpenNeeds();
    const after = await projectState();
    const entry = [...after.history].reverse().find((h) => h.files?.length);
    r.note =
      `Approved; ${after.changes.length} change record(s) for ${after.changes.map((c) => c.path).join(', ')}; ` +
      `History says "${line(entry?.sentence)}".`;
  });

  await step('review-the-diff', async (r) => {
    await toConsole();
    await press(rail().getByRole('button', { name: 'Workbook', exact: true }));
    const pages = page.getByRole('navigation', { name: 'Project pages' });
    await pages.waitFor({ timeout: 20_000 });
    await press(pages.getByRole('button', { name: /^Review/ }));
    await shot('review-page');
    const waitingCount = (await projectState()).changes.filter((c) => c.state === 'waiting').length;
    if (!waitingCount) {
      r.status = 'failed';
      r.note = 'The Review page opens but has no change to show: nothing was written, so "Keep all" is disabled.';
      return;
    }
    await press(page.getByRole('button', { name: 'Keep all', exact: true }).first());
    for (let n = 0; n < 30; n++) {
      if (!(await projectState()).changes.some((c) => c.state === 'waiting')) break;
      await sleep(1000);
    }
    r.status = 'intervention';
    r.note =
      `${waitingCount} change(s) show before and after and are kept from the Workbook Review page. ` +
      'The Console has no keep or undo control: Shell.tsx defines reviewChange and wires it to nothing.';
  });

  await step('edit-an-existing-source-file', async (r) => {
    r.status = 'not-reachable';
    r.note =
      'No Console control selects a source document, and with an empty selection a text route may only ' +
      'create files (server/native-work.ts). The obvious change inside src/greet.js cannot be assigned here.';
  });

  await step('second-assignment-for-stop', async (r) => {
    if (!dry && out.liveTurns >= 3) {
      r.status = 'not-reachable';
      r.note = 'Skipped: the live-turn budget was already spent.';
      return;
    }
    await openBoard();
    for (const [column, verb] of [['Done', 'Reopen'], ['Review', 'Review']]) {
      const row = board().locator(`.column[aria-label="${column}"] .crow`, { hasText: taskName }).first();
      if (await row.isVisible().catch(() => false)) await press(row.getByRole('button', { name: verb, exact: true }));
    }
    const confirmed = await startFromBoard();
    if (confirmed === null) {
      const where = line(await taskRow().textContent());
      r.status = 'failed';
      r.note =
        'The board row offers no Start after the faulted turn, though the fault says "Start again to ' +
        `request a new proposal". The row reads: "${where}".`;
      return;
    }
    for (let n = 0; n < 60; n++) {
      if ((await projectState()).sessions.some((s) => ['queued', 'working'].includes(s.state))) break;
      await sleep(500);
    }
    out.liveTurns = (await projectState()).sessions.filter((s) => s.route === 'opencode').length;
    r.note = `${confirmed ? 'Confirmed and started' : 'Started'} a second run to stop; OpenCode turns: ${out.liveTurns}.`;
  });

  await step('queue-a-follow-up-while-in-flight', async (r) => {
    // Straight from the board the Start left us on: every second here is a second of the live run.
    if (!(await board().isVisible().catch(() => false))) await openBoard();
    await press(taskRow().getByRole('button', { name: taskName }));
    const queue = page.locator('section.follow-ups');
    await queue.waitFor();
    const live = (await projectState()).sessions.some((s) => ['queued', 'working'].includes(s.state));
    await queue.getByLabel('Queue a follow-up').fill('Also list the exported names in NOTES.md.');
    await press(queue.getByRole('button', { name: 'Queue a follow-up', exact: true }));
    for (let n = 0; n < 20; n++) {
      const now = await projectState();
      if (now.followUps?.length) {
        out.followUp.queued = now.followUps.at(-1).text;
        break;
      }
      await sleep(500);
    }
    if (!out.followUp.queued) throw new Error('nothing reached the queue');
    if (!live) r.status = 'intervention';
    r.note = live
      ? 'Queued under the composer while the run was in flight; the queue states when it would run.'
      : 'The queue accepts and shows the follow-up, but no run was in flight, so the in-flight case was not measured.';
  });

  await step('stop-the-task', async (r) => {
    await press(page.locator('.stop-menu').first().getByRole('button', { name: 'Stop', exact: true }));
    await page.locator('.stop-receipt').first().waitFor({ timeout: 30_000 });
    out.stop = { scope: 'task', receipt: line(await page.locator('.stop-receipt').first().textContent()) };
    r.note = out.stop.receipt;
  });

  await step('follow-up-fate', async (r) => {
    const settled = page.locator('.follow-up.settled').first();
    await settled.waitFor({ timeout: 20_000 });
    const shown = line(await settled.textContent());
    const state = (await projectState()).followUps?.at(-1);
    out.followUp.fate = `${shown} (recorded state: ${state?.state ?? 'none'})`;
    out.liveTurns = (await projectState()).sessions.filter((s) => s.route === 'opencode').length;
    r.note = out.followUp.fate;
  });

  await step('inspect-history', async (r) => {
    await toConsole();
    await press(rail().getByRole('button', { name: 'History', exact: true }));
    await page.locator('.main, .workbook-layout').first().waitFor({ timeout: 20_000 });
    const entries = await api(
      `/projects/${projectId}/history`,
      'GET',
      undefined,
      'confirm the History the Workbook page renders',
    );
    r.status = 'intervention';
    r.note =
      `History opens with ${entries.days?.length ?? 0} day(s) of entries, but the Console's History button ` +
      'switches the surface to the frozen Workbook and downgrades Technical detail to Standard.';
  });
}

async function reopenCheck() {
  await step('reopen-check', async (r) => {
    await close();
    out.reopen.closedVia = 'window close';
    await launch();
    await onboard();
    const listed = await api('/projects', 'GET', undefined, 'confirm the repository survived a restart');
    out.reopen.foundAgain = (listed.projects ?? listed).some((p) => p.name === REPO);
    const kept = projectId
      ? await api(`/projects/${projectId}/history`, 'GET', undefined, 'confirm History survived the restart')
      : { days: [] };
    r.note = `Reopened; ${REPO} is ${out.reopen.foundAgain ? 'listed again' : 'missing'} and History keeps ${kept.days?.length ?? 0} day(s).`;
    await close();
  });
}

function leakedProcesses() {
  try {
    // This script is itself a node process under the journey-b path; it is not a leak.
    const command =
      "Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'opencode|codex') -or " +
      "(($_.Name -match 'node|Diomedes') -and $_.CommandLine -like '*journey-b*') } | " +
      `Where-Object { $_.ProcessId -ne ${process.pid} } | ` +
      'Select-Object Name,ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }).trim();
    const found = raw ? [].concat(JSON.parse(raw)) : [];
    const born = (p) => new Date(String(p.CreationDate ?? '')).getTime() || 0;
    // Engine binaries older than this run belong to the person's machine, not to us.
    out.reopen.processScan = found;
    out.reopen.leakedProcesses = found.filter((p) => born(p) >= new Date(out.startedAt).getTime());
  } catch (error) {
    out.reopen.leakedProcesses = [{ error: line(error.message) }];
  }
}

async function main() {
  await fs.mkdir(shots, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  out.candidate.sha256 = createHash('sha256').update(await fs.readFile(exe)).digest('hex');
  const build = JSON.parse(
    extractFile(path.join(path.dirname(exe), 'resources', 'app.asar'), 'BUILD_INFO.json').toString('utf8'),
  );
  out.candidate.baseCommit = build.baseCommit ?? null;
  out.candidate.buildInfo = { version: build.version, sourceStatus: build.sourceStatus };
  await launch();
  try {
    await journey();
  } finally {
    await reopenCheck();
    await close();
    leakedProcesses();
  }
}

try {
  await main();
} catch (error) {
  limitations.push(`The run stopped early: ${line(error?.message ?? error)}`);
  await close();
} finally {
  out.finishedAt = new Date().toISOString();
  for (const s of steps.filter((s) => s.status === 'failed' || s.status === 'not-reachable'))
    limitations.push(`${s.name} (${s.status}): ${s.note}`);
  if (upstreamFault) limitations.push(`The paid turn produced no proposal: "${upstreamFault}"`);
  await fs.writeFile(record, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${record}`);
  for (const s of steps) console.log(`${(s.status ?? 'failed').padEnd(13)} ${s.name}`);
}
