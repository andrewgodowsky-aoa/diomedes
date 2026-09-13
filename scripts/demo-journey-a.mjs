/**
 * Demonstration journey A (ordinary user) against a packaged candidate.
 *
 * node scripts/demo-journey-a.mjs --exe <path to Diomedes.exe> [--dry]
 *
 * --dry keeps every route on the built-in `sample` engine, so the traversal
 * costs nothing while it is being developed. Without it the journey selects a
 * real signed-in account and spends model turns; the count is in the evidence.
 *
 * This script measures. It never adds a control to make a step pass, and it
 * never calls an API to skip a UI step that exists. The API calls it does make
 * are fixture preparation and verification of what the UI claimed, and each is
 * listed under `backendPreparation` in the evidence file.
 */
import { _electron as electron } from '@playwright/test';
import { extractFile } from '@electron/asar';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const exePath = path.resolve(args[args.indexOf('--exe') + 1] ?? '');
const LOCK = 'F:/Diomedes/diomedes-wt/release-20260912/test-results/candidate/browser.lock';
const runRoot = path.resolve('test-results/journey-a');
const shots = path.resolve('evidence/demo-journeys/a');
const evidenceFile = path.join(shots, 'journey-a.json');

const steps = [];
const backendPreparation = [];
const pageErrors = [];
const limitations = [];
let liveTurns = 0;
let accountRoute = dry ? 'sample' : null;
let page = null;
let desktop = null;
let origin = '';

const record = (name, status, note) => {
  steps.push({ name, status, note });
  console.log(`${status.padEnd(14)} ${name} — ${note}`);
};

/** Step names already carry their number, so the file is `<nn>-<step>.png`. */
async function shot(name) {
  const file = path.join(shots, `${name}.png`);
  if (page) await page.screenshot({ path: file, animations: 'disabled' }).catch(() => {});
  return file;
}

/** Every step is measured, so a failure records itself and the journey continues. */
async function step(name, fn) {
  try {
    const result = await fn();
    record(name, result.status, result.note);
  } catch (error) {
    record(name, 'failed', `threw: ${String(error?.message ?? error).slice(0, 300)}`);
  }
  await shot(name);
}

async function api(route, method = 'GET', data) {
  const response = await fetch(`${origin}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The integrator's browser gate. Nothing launches while it is held. */
async function waitForLock() {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fs.access(LOCK);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error('browser.lock was still held after twenty minutes.');
}

async function launch() {
  await waitForLock();
  const env = { ...process.env };
  env.DIOMEDES_DESKTOP_PROFILE = path.join(runRoot, 'profile');
  env.DIOMEDES_DATA_DIR = path.join(runRoot, 'data');
  env.DIOMEDES_PROJECTS_DIR = path.join(runRoot, 'projects');
  delete env.ELECTRON_RUN_AS_NODE;
  // This journey is real: a test mode inherited from a parent shell would make
  // every observation below a claim about a fixture instead of the product.
  delete env.DIOMEDES_TEST_MODE;
  desktop = await electron.launch({ executablePath: exePath, env });
  page = await desktop.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForURL('http://127.0.0.1:*/');
  origin = new URL(page.url()).origin;
  return desktop.process().pid;
}

const WATCHED = /^(codex|opencode|claude|cursor|node)\.exe$/i;
/** Process names, narrowed to children of our own Electron when a pid is given,
 *  so journey B's processes are never attributed to this launch. */
function processNames(parentPid) {
  const filter = parentPid ? `| Where-Object { $_.ParentProcessId -eq ${parentPid} } ` : '';
  const script = `Get-CimInstance Win32_Process ${filter}| Select-Object -ExpandProperty Name`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
/** Children this launch owned that are still running after it closed. */
const survivors = (owned) => {
  const running = processNames();
  return owned.filter((name) => WATCHED.test(name) && running.includes(name));
};

const button = (name, exact = true) => page.getByRole('button', { name, exact });

// --- the journey ---------------------------------------------------------------

await fs.mkdir(shots, { recursive: true });
// A journey starts at first run, so the isolated profile begins empty every time.
await fs.rm(runRoot, { recursive: true, force: true });
await fs.mkdir(runRoot, { recursive: true });
const startedAt = new Date().toISOString();
const exeBytes = await fs.readFile(exePath);
const asar = path.join(path.dirname(exePath), 'resources/app.asar');
const buildInfo = JSON.parse(extractFile(asar, 'BUILD_INFO.json').toString('utf8'));

let pid = await launch();
const state = { projectId: null, orgId: null, taskId: null, briefText: '' };

await step('01-open-the-app', async () => ({
  status: 'traversed',
  note: `Portable ${path.basename(exePath)} launched with its own profile, data and projects directories. The per-user installer is the integrator's separate step and was not run here.`,
}));

await step('02-first-run-questions', async () => {
  await button('Continue').click();
  // These radios are saved settings, so the control only reflects the answer
  // after the save returns. Click, then wait for the row to read as selected.
  const pick = async (group) => {
    const row = page.getByRole('radiogroup', { name: group }).locator('label.radio-row').first();
    await row.click();
    await row.and(page.locator('.selected')).waitFor();
  };
  await pick('Kind of work');
  await button('Continue').click();
  await pick('Detail preference');
  await button('Continue').click();
  await button('Continue').click();
  const heading = page.getByRole('heading', { name: 'Connect an AI service' });
  await heading.waitFor();
  return { status: 'traversed', note: 'Welcome, then Business, Guided detail and the default file-change answer; the AI setup screen followed.' };
});

let connections = [];
await step('03-check-this-computer', async () => {
  await button('Check this computer').click();
  await page.waitForTimeout(2000);
  await page.waitForFunction(
    () => !document.body.innerText.includes('Checking installed tools'),
    undefined,
    { timeout: 120_000 },
  );
  connections = (await api('/ai/status')).connections;
  backendPreparation.push('GET /api/ai/status — read back what the setup screen reported, for the record.');
  const line = connections
    .map((c) => `${c.engine}: ${c.installation}/${c.compatibility}/${c.authentication}`)
    .join('; ');
  return { status: 'traversed', note: `Discovery ran from the screen's own control. ${line}` };
});

const ENGINE_NAMES = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'oh-my-pi',
  cursor: 'Cursor',
};
const card = (engine) => page.getByRole('region', { name: ENGINE_NAMES[engine], exact: true });

let chosen = null;
await step('04-check-sign-in-and-known-failure', async () => {
  if (connections.length === 0)
    return { status: 'failed', note: 'The setup screen reported no connections at all, so nothing could be checked or induced.' };
  // Local checks only: sign-in state and model lists. No model prompt is sent,
  // so this costs nothing on any account.
  for (const c of connections) {
    if (c.compatibility !== 'supported') continue;
    const check = card(c.engine).getByRole('button', { name: 'Check sign-in and models' });
    await check.click().catch(() => {});
    await page
      .waitForFunction(() => !document.body.innerText.includes('Checking sign-in and models'), undefined, { timeout: 180_000 })
      .catch(() => {});
  }
  connections = (await api('/ai/status')).connections;
  const line = connections
    .map((c) => `${c.engine}: ${c.authentication}, ${c.models.length} models`)
    .join('; ');
  const signedOut = connections.find(
    (c) => c.compatibility === 'supported' && c.authentication !== 'signed-in',
  );
  const missing = connections.find((c) => c.installation === 'missing');
  const target = signedOut ?? missing;
  if (!target)
    return { status: 'not-reachable', note: `Every listed engine was installed, supported and signed in, so no failure of this kind could be induced honestly. ${line}` };
  // The offered action is the capture. Clicking Sign in would run the
  // provider's own tool against a real account, which this journey does not do.
  const recovery = signedOut
    ? await card(target.engine)
        .getByRole('button', { name: /^(Sign in with |Configure OpenAI API access)/ })
        .first()
        .textContent()
    : await card(target.engine).getByRole('button', { name: /^Install / }).first().textContent();
  return {
    status: 'traversed',
    note: `Sign-in checked per engine from the screen's own control: ${line}. Known failure: ${target.engine} is ${signedOut ? 'installed and supported but signed out' : 'not installed'}; the screen offers "${(recovery ?? '').trim()}" with the caption that sign-in runs in the provider's own tool and Diomedes never asks for provider secrets. Its detail line reads: ${String(target.detail).slice(0, 160)}`,
  };
});

await step('05-select-a-supported-account', async () => {
  if (dry) {
    return { status: 'traversed', note: 'Dry run: no engine selected, so every route falls back to the built-in sample engine and nothing is spent.' };
  }
  const usable = connections.filter(
    (c) => c.compatibility === 'supported' && c.authentication === 'signed-in',
  );
  if (usable.length === 0) return { status: 'not-reachable', note: 'No engine on this computer was both supported and signed in, so no account could be selected.' };
  chosen = usable[0].engine;
  const panel = card(chosen);
  await panel.getByRole('combobox').waitFor();
  const model = await panel.getByRole('combobox').inputValue();
  backendPreparation.push('GET /api/settings — verified the selection the screen claimed to save.');
  const settled = async (want) => {
    for (let i = 0; i < 20; i += 1) {
      const current = await api('/settings');
      if (want(current.services ?? {})) return current;
      await page.waitForTimeout(500);
    }
    return api('/settings');
  };
  // The switch is a controlled checkbox whose state only changes once the
  // settings save returns, so this clicks and then waits for the saved value.
  await panel.getByRole('checkbox').click();
  await settled((svc) => svc[chosen] === true);
  await panel.getByRole('button', { name: 'Use as default' }).click();
  let settings = await settled((svc) => svc.defaultEngine === chosen);
  let intervened = '';
  if (settings.services?.[chosen] !== true) {
    // Re-click the switch through the UI rather than writing settings behind it.
    await panel.getByRole('checkbox').click();
    settings = await settled((svc) => svc[chosen] === true);
    intervened = ' The On switch had to be set a second time: setting the default model overwrote it.';
  }
  if (settings.services?.defaultEngine !== chosen || settings.services?.[chosen] !== true)
    return { status: 'failed', note: `The screen accepted the choice but settings report defaultEngine=${settings.services?.defaultEngine}, ${chosen}=${settings.services?.[chosen]}.` };
  accountRoute = chosen;
  return {
    status: intervened ? 'intervention' : 'traversed',
    note: `${chosen} selected as the default route with model ${settings.services?.[`${chosen}Model`] ?? model}, and switched on.${intervened}`,
  };
});

await step('06-finish-setup', async () => {
  await button('Continue').click();
  const done = page.getByRole('heading', { name: 'Your workspace is ready' });
  await done.waitFor();
  const said = await page.locator('.setup .prose, .setup p').allTextContents();
  await button('Open Diomedes').click();
  await page.getByRole('heading', { name: 'Projects' }).waitFor();
  return { status: 'traversed', note: `Setup finished with Open Diomedes and landed on the Projects page. The ready screen states: ${said.join(' ').replace(/\s+/g, ' ').slice(0, 200)}` };
});

await step('07-create-a-project', async () => {
  await button('New project').click();
  await page.getByLabel('Name').fill('Ambleside Bakery operations');
  await button('Create project').click();
  await page.locator('.console').waitFor();
  const projects = await api('/projects');
  state.projectId = projects.projects.find((p) => p.name === 'Ambleside Bakery operations')?.id ?? null;
  backendPreparation.push('GET /api/projects — read the created project id for later verification.');
  return { status: 'traversed', note: `Created from the Projects page dialog; the Console opened on it (${state.projectId}).` };
});

let briefPath = 'weekly-operations-brief.md';
const exports = [
  {
    path: 'bakery-weekly-sales.csv',
    text: 'day,loaves,pastries,takings_gbp\nMon,118,240,742\nTue,131,255,801\nWed,127,238,769\nThu,140,266,845\nFri,182,331,1094\nSat,205,388,1281\nSun,96,150,540\n',
  },
  {
    path: 'bakery-inventory.md',
    text: '# Ambleside Bakery inventory, week 37\n\n- Strong white flour: 14 sacks, reorder point 10\n- Rye flour: 3 sacks, below reorder point 5\n- Butter: 46 kg, reorder point 30\n- Yeast: 8 kg, reorder point 6\n- Packaging boxes: 210, reorder point 400\n',
  },
];

await step('08-attach-two-exports', async () => {
  await page.getByRole('navigation', { name: 'Threads and views' }).getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('aside.files').waitFor();
  const hasAttach = await page.getByRole('button', { name: /attach|add file|upload|import/i }).count();
  for (const file of exports) {
    await api(`/projects/${state.projectId}/documents/create`, 'POST', { path: file.path, text: file.text });
    backendPreparation.push(`POST /api/projects/:id/documents/create ${file.path} — the two fictional exports, because no attachment control exists.`);
  }
  await page.reload();
  await page.locator('.console').waitFor();
  return {
    status: 'not-reachable',
    note: `The Files pane lists and reads; it has no attach, add or import control (${hasAttach} matched). FIL-02 is not implemented, so the two fictional exports were written into the project folder as fixture preparation.`,
  };
});

await step('09-business-workspace', async () => {
  await page.getByRole('button', { name: 'Change workspace' }).click();
  await page.getByRole('dialog', { name: 'Workspaces' }).waitFor();
  await page.getByLabel('Business name').fill('Ambleside Bakery');
  await page.getByLabel('Kind of work (optional)').fill('bakery');
  await button('Create business workspace').click();
  await page.getByRole('button', { name: /^(Start setup|Resume setup)$/ }).waitFor();
  const view = await api('/workspace');
  state.orgId = view.organizations.at(-1)?.organization.id ?? null;
  backendPreparation.push('GET /api/workspace — read the organization id for later verification.');
  return { status: 'traversed', note: `Business workspace created from the Workspaces panel and made current (${state.orgId}); the panel states it as a development identity, not a verified one.` };
});

const ANSWERS = {
  name: 'Ambleside Bakery — a fictional village bakery selling bread and pastries',
  industry: 'bakery',
  job: 'recurring-report',
  result: 'A short Monday brief of what changed in last week’s sales and stock, read by the owner.',
  sources: ['files'],
  people: 'just-me',
  locations: 'one',
  'human-required': ['everything'],
  'data-leaving': 'no',
  host: 'The shop laptop, on weekday mornings.',
  'spend-cap': '20',
  'first-run': 'manual',
};

await step('10-answer-the-setup-questions', async () => {
  await page.getByRole('button', { name: /^(Start setup|Resume setup)$/ }).click();
  await button('Start').click();
  const questions = (await api('/workspace/questions')).questions;
  let asked = 0;
  for (let i = 0; i < 24; i += 1) {
    const setup = await api(`/workspace/organizations/${state.orgId}/setup`);
    if (setup.step === 'review') break;
    const question = questions.find((q) => q.id === setup.step);
    const wanted = question ? ANSWERS[question.id] : undefined;
    await page.locator('.ws-question').waitFor();
    if (!question || wanted === undefined) {
      await button("I don't know").click();
      continue;
    }
    if (question.kind === 'multi' || question.kind === 'choice') {
      for (const option of [].concat(wanted)) {
        const label = question.options.find((o) => o.id === option)?.label;
        await page
          .getByRole(question.kind === 'multi' ? 'checkbox' : 'radio', { name: label, exact: true })
          .check();
      }
    } else {
      await page.locator('.ws-input').first().fill(String(wanted));
    }
    await button('Continue').click();
    asked += 1;
    await page.waitForTimeout(250);
  }
  await page.getByRole('heading', { name: 'Here is what you told us' }).waitFor();
  backendPreparation.push('GET /api/workspace/questions and .../setup — read the question schema and the current step so the answers below could be typed into the screen’s own controls.');
  await button('Done').click();
  return { status: 'traversed', note: `${asked} questions answered through the questionnaire's own controls; the review screen listed the answers back.` };
});

await step('11-turn-the-setup-on', async () => {
  const prepare = button('Prepare the setup');
  if (await prepare.isVisible().catch(() => false)) await prepare.click();
  const blocking = await page.locator('.ws-problems li').allTextContents();
  const turnOn = button('Turn it on');
  if (!(await turnOn.isEnabled().catch(() => false)))
    return { status: 'failed', note: `The prepared setup could not be turned on. Blocking: ${blocking.join(' | ') || 'no message shown'}` };
  await turnOn.click();
  await page.waitForTimeout(1000);
  const config = await api(`/workspace/organizations/${state.orgId}/configuration`);
  backendPreparation.push('GET /api/workspace/organizations/:id/configuration — verified the activation the screen claimed.');
  const selection = config.active?.proposal.contextScopes.find((s) => s.kind === 'approved-files')?.selection ?? [];
  limitations.push(`The approved-export selection is fixed by the pack variant to ${JSON.stringify(selection)}; no screen lets a person name which exports the brief reads.`);
  return { status: config.active ? 'traversed' : 'failed', note: `Setup revision ${config.active?.revision} is running. Its approved-file selection is ${JSON.stringify(selection)}${blocking.length ? `; blocking noted: ${blocking.join(' | ')}` : ''}.` };
});

await step('12-choose-where-the-business-writes', async () => {
  // Closing the setup screen returns to the Workspaces panel it opened from.
  await page.getByRole('button', { name: 'Close dialog' }).last().click();
  const panel = page.getByRole('dialog', { name: 'Workspaces' });
  await panel.waitFor();
  await panel.locator('select.ws-select').selectOption({ label: 'Ambleside Bakery operations' });
  await panel.locator('.ws-bound').waitFor();
  return { status: 'traversed', note: 'The business was bound to the project from the Workspaces panel; the panel then states where it writes.' };
});

await step('13-request-the-operations-brief', async () => {
  const said = async () => {
    const line = page.locator('.ws-brief, .ws-error');
    await line.first().waitFor({ timeout: 90_000 });
    return ((await line.first().textContent()) ?? '').trim();
  };
  await button('Prepare the weekly brief').click();
  const first = await said();
  const config = await api(`/workspace/organizations/${state.orgId}/configuration`);
  const selection = config.active?.proposal.contextScopes.find((s) => s.kind === 'approved-files')?.selection ?? [];
  briefPath = config.active?.proposal.expectedOutputs[0]?.destination ?? 'weekly-operations-brief.md';
  // The selected path is not one of the two exports, and nothing in the app can
  // change that. Writing a third fixture at exactly that path is the only way to
  // see the brief carry a claim, and it is named here rather than hidden.
  for (const selected of selection) {
    await api(`/projects/${state.projectId}/documents/create`, 'POST', {
      path: selected,
      text: `${exports[0].text}\n${exports[1].text}`,
    });
    backendPreparation.push(`POST /api/projects/:id/documents/create ${selected} — the one path the active setup names, written so the brief has something to read.`);
  }
  await button('Prepare the weekly brief').click();
  const second = await said();
  const drafted = await api(
    `/projects/${state.projectId}/documents/read?path=${encodeURIComponent(briefPath)}`,
  );
  backendPreparation.push('GET /api/projects/:id/documents/read — read the drafted brief back to check its source list.');
  state.briefText = drafted.text ?? '';
  if (/changed since you opened it/.test(second))
    limitations.push(
      'The weekly brief can be prepared once per project. WeeklyBriefService.run passes the previous file text as the recorded writer\'s `expected` value, which store.writeRecorded compares against a sha256, so every later run is refused with "This document changed since you opened it."',
    );
  return {
    status: 'intervention',
    note: `Deterministic, no model. First run: ${first} — and the draft named ${JSON.stringify(selection)} under "Sources that could not be read", because the exports a person would attach are not the path the setup selects. A fixture was then written at that path and the brief requested again: ${second}`,
  };
});

await step('14-open-the-brief-and-its-sources', async () => {
  for (const close of await page.getByRole('button', { name: 'Close dialog' }).all())
    await close.click().catch(() => {});
  await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {});
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  if (!(await page.locator('aside.files').isVisible().catch(() => false)))
    await rail.getByRole('button', { name: 'Files', exact: true }).click();
  const row = page.locator('aside.files .files-name', { hasText: /brief\.md$/ }).first();
  await row.click();
  await page.locator('.files-md, .files-raw').first().waitFor({ timeout: 30_000 });
  const text = (await page.locator('.files-doc').innerText()) ?? '';
  const hasSources = /Sources/.test(text);
  const hasClaims = /\[[a-z0-9-]+\]/.test(text);
  return {
    status: hasSources ? 'traversed' : 'intervention',
    note: `The brief opens in the Files pane from its own row. Source section present: ${hasSources}. Bracketed source markers on claims: ${hasClaims}. What it says about its sources: ${(state.briefText ?? text).replace(/\s+/g, ' ').slice(0, 320)}`,
  };
});

await step('15-make-a-task-and-find-it-in-Ready', async () => {
  const name = 'Add a stock-to-watch section to the weekly brief';
  const description =
    'Read weekly-operations-brief.md and bakery-inventory.md in this project, and propose adding a short "Stock to watch" section to weekly-operations-brief.md listing only the items already below their stated reorder point. Change nothing else.';
  await page.reload();
  await page.locator('.console').waitFor();
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: /^Board/ }).click();
  const board = page.locator('.board[aria-label="Board"]');
  await board.waitFor();
  const control = board.getByRole('button', { name: 'New task', exact: true });
  if ((await control.count()) === 0) {
    const created = await api(`/projects/${state.projectId}/tasks`, 'POST', { name, description, owner: 'you' });
    state.taskId = created.id ?? created.task?.id ?? null;
    backendPreparation.push('POST /api/projects/:id/tasks - created the task, because this build has no Console control for it.');
    return { status: 'not-reachable', note: 'No Console control creates a task in this build; the task was created through the API.' };
  }
  // The Board's own control: New task opens a form, Create adds the task.
  await control.click();
  const form = board.getByRole('form', { name: 'New task' });
  await form.waitFor();
  await form.getByLabel('Task name').fill(name);
  await form.getByLabel('What should happen (optional)').fill(description);
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  const ready = page.locator('.column[aria-label="Ready"]');
  const row = ready.locator('.crow', { hasText: 'Add a stock-to-watch section' });
  await row.first().waitFor({ timeout: 15_000 });
  const live = await api(`/projects/${state.projectId}/state`);
  const task = live.tasks.find((item) => item.name === name);
  state.taskId = task?.id ?? null;
  await board.getByRole('button', { name: 'compact', exact: true }).click().catch(() => {});
  return {
    status: 'traversed',
    note: `Made from the Board's New task control (name and description typed, Create pressed); the row appears in Ready${task ? ` as task ${task.id}` : ''}. Nothing moves a task between columns by hand; a task with no run is Ready by projection.`,
  };
});

await step('16-start-the-task-and-watch-progress', async () => {
  const ready = page.locator('.column[aria-label="Ready"]');
  const row = ready.locator('.crow', { hasText: 'Add a stock-to-watch section' }).first();
  await row.getByRole('button', { name: 'Start', exact: true }).first().click();
  const confirm = row.locator('.confirm');
  const sendModal = page.getByRole('dialog', { name: 'Send this task?' });
  let dialogSeen = '';
  if (await confirm.isVisible().catch(() => false)) {
    dialogSeen = (await confirm.textContent()) ?? '';
    await confirm.getByRole('button', { name: 'Start', exact: true }).click();
  }
  if (await sendModal.isVisible().catch(() => false)) {
    dialogSeen += ` | ${(await sendModal.innerText()).slice(0, 160)}`;
    await sendModal.getByRole('button', { name: 'Send task' }).click();
  }
  await page.waitForTimeout(4000);
  const working = await page.locator('.column[aria-label="Working"] .crow').count();
  let live = await api(`/projects/${state.projectId}/state`);
  for (let i = 0; i < 150 && live.sessions.some((s) => ['queued', 'working'].includes(s.state)); i += 1) {
    await page.waitForTimeout(5000);
    live = await api(`/projects/${state.projectId}/state`);
  }
  backendPreparation.push('GET /api/projects/:id/state — read sessions and History to check what the Board showed.');
  const session = live.sessions.at(-1);
  const landed = await Promise.all(
    ['Ready', 'Queued', 'Working', 'Review', 'Blocked', 'Done'].map(async (c) => [
      c,
      await page.locator(`.column[aria-label="${c}"] .crow`).count(),
    ]),
  );
  const last = live.history.at(-1);
  const seconds = session?.endedAt
    ? Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000)
    : null;
  // A turn is counted when the route was actually reached: a request refused
  // before it left the machine spends nothing and is not counted as spend.
  if (!dry && session && accountRoute && accountRoute !== 'sample') liveTurns += 1;
  return {
    status: session ? 'traversed' : 'failed',
    note: `Confirmation shown before anything ran (${dialogSeen.replace(/\s+/g, ' ').trim().slice(0, 160)}). ${working} row in Working while it ran; session ${session?.id} on route ${session?.route ?? 'unknown'}, model ${session?.engine?.model ?? 'not recorded'}, ended ${session?.state} after ${seconds ?? '?'} s. Board after: ${landed.filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(', ')}. ${live.history.length} History entries, last: ${String(last?.sentence ?? '').slice(0, 160)}`,
  };
});

await step('17-ask-for-one-revision', async () => {
  const rail = page.getByRole('navigation', { name: 'Threads and views' });
  await rail.getByRole('button', { name: 'Thread', exact: true }).click();
  const composer = page.getByLabel('Message this thread');
  if (!(await composer.isVisible().catch(() => false))) {
    const listed = rail.locator('.console-thread');
    if (await listed.count()) await listed.first().click();
    else await rail.getByRole('button', { name: 'New', exact: true }).click();
    await composer.waitFor({ timeout: 20_000 }).catch(() => {});
  }
  if (!(await composer.isVisible().catch(() => false)))
    return { status: 'not-reachable', note: 'No thread was open and none could be opened from the rail, so the composer was not reachable.' };
  await page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', { name: 'ask' }).click().catch(() => {});
  const instruction = 'Shorten the brief to the three things that changed most, and keep the source markers.';
  const sentAt = new Date().toISOString();
  const settings = await api('/settings');
  const needsConfirmation = accountRoute && accountRoute !== 'sample' &&
    (accountRoute !== 'codex' || settings.permissions.sending);
  await composer.fill(instruction);
  await composer.press('Enter');
  if (needsConfirmation) {
    const confirmation = page.getByRole('dialog', { name: 'Send this message?' });
    await confirmation.waitFor({ timeout: 20_000 });
    await confirmation.getByRole('button', { name: 'Send message', exact: true }).click();
  }
  // Count dispatch only after the send decision, whether or not a reply arrives.
  if (!dry && accountRoute && accountRoute !== 'sample') liveTurns += 1;
  // An ask is not a session, so waiting on `sessions` would return at once.
  // Wait on the thread's own turns instead.
  let reply = null;
  let sentSources = [];
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(4000);
    const s = await api(`/projects/${state.projectId}/state`);
    const thread = s.conversations.find((c) => (c.turns ?? []).some((t) =>
      t.role === 'you' && t.text === instruction && t.at >= sentAt));
    const sent = thread?.turns?.findLast((t) => t.role === 'you' && t.text === instruction && t.at >= sentAt);
    sentSources = sent?.sources ?? [];
    const last = thread?.turns?.at(-1);
    if (last && last.role !== 'you') {
      reply = last;
      break;
    }
  }
  const waiting = await page.getByRole('button', { name: 'Stop', exact: true }).count();
  const said = String(reply?.text ?? '').replace(/\s+/g, ' ').slice(0, 220);
  return {
    status: reply ? 'traversed' : 'intervention',
    note: `Revision sent from the thread composer on the ${accountRoute} route. ${needsConfirmation ? 'The send confirmation was shown and accepted.' : 'This route and sending preference did not require a separate confirmation.'} Recorded source documents: ${sentSources.length ? sentSources.join(', ') : 'none'}. ${reply ? `Reply recorded from ${reply.role} via ${reply.route ?? 'unrecorded route'}, model ${reply.model ?? 'not recorded'}: "${said}"` : `No reply was recorded within six minutes; the thread still showed ${waiting ? 'a Stop control, so the turn was still in flight' : 'no reply and no running turn'}.`} The brief itself is deterministic, so a revision of it is a model turn about a document no model wrote.`,
  };
});

const ownedChildren = processNames(pid);
let reopen = { closedVia: '', foundAgain: false, leakedProcesses: [] };

await step('18-close-and-reopen', async () => {
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.close());
  });
  await desktop.waitForEvent('close', { timeout: 60_000 }).catch(() => {});
  reopen.closedVia = 'the window close the app itself handles (window-all-closed quits); no process was killed';
  await new Promise((r) => setTimeout(r, 4000));
  reopen.leakedProcesses = survivors(ownedChildren);
  page = null;
  pid = await launch();
  await page.locator('.console, .projects-page, main').first().waitFor();
  const projects = await api('/projects');
  const same = projects.projects.find((p) => p.id === state.projectId);
  const s = same ? await api(`/projects/${state.projectId}/state`) : null;
  reopen.foundAgain = Boolean(
    same && s && s.tasks.length > 0 && s.history.length > 0,
  );
  const docs = s ? (await api(`/projects/${state.projectId}/documents`)).documents.length : 0;
  backendPreparation.push('GET /api/projects, /state and /documents after the relaunch — verified the work the reopened window showed.');
  return {
    status: reopen.foundAgain ? 'traversed' : 'failed',
    note: `Reopened on the same profile, data and projects directories. Project ${same ? 'found' : 'missing'}; ${s?.tasks.length ?? 0} tasks, ${docs} documents, ${s?.history.length ?? 0} History entries. Processes left behind by this launch: ${reopen.leakedProcesses.join(', ') || 'none'}.`,
  };
});

await shot('19-reopened');
await desktop.close().catch(() => {});

const knownFailure = steps.find((s) => s.name.includes('known-failure'));
const evidence = {
  startedAt,
  finishedAt: new Date().toISOString(),
  candidate: {
    exe: exePath,
    sha256: createHash('sha256').update(exeBytes).digest('hex'),
    baseCommit: buildInfo.baseCommit,
    version: buildInfo.version,
    sourceStatus: buildInfo.sourceStatus,
  },
  mode: dry ? 'dry' : 'real',
  accountRoute,
  liveTurns,
  steps,
  knownFailure: {
    induced: knownFailure?.status === 'traversed' ? knownFailure.note : 'not induced',
    recoveryActionSeen: knownFailure?.note ?? '',
  },
  reopen,
  pageErrors: [...new Set(pageErrors)],
  backendPreparation: [...new Set(backendPreparation)],
  limitations,
};
await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nWrote ${evidenceFile}. Live turns: ${liveTurns} on ${accountRoute}.`);
