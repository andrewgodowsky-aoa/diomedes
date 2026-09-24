import { expect, test, type Locator, type Page } from '@playwright/test';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import type { Conversation, Project } from '../shared/types';
import { PDF_SMALL, PNG_1X1, buildXlsx } from './fixtures/file-drop-samples';

// P05 in the built Console against the production routes: drop and paste into
// Files, byte-sniffed previews, attaching a file to a Thread message, and
// opening the exact version that message sent after the file has changed. The
// sample route answers; no engine, provider or external request is involved.
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let url: string;
let project: Project;
let thread: Conversation;
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok, `${route}: ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}
const pane = (page: Page) => page.getByRole('complementary', { name: 'Files', exact: true });
const row = (page: Page, name: string) =>
  pane(page).getByRole('treeitem', { name, exact: true });

/** A drop from the operating system: a real DataTransfer with File objects, dispatched on the pane. */
async function dropFiles(target: Locator, files: { name: string; type: string; bytes: number[] }[]) {
  const transfer = await target.page().evaluateHandle((list) => {
    const data = new DataTransfer();
    for (const file of list) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    return data;
  }, files);
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
}

/** A paste into whatever has focus, carrying a clipboard DataTransfer. */
async function paste(page: Page, item: { text?: string; file?: { name: string; type: string; bytes: number[] } }) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    if (value.text) data.setData('text/plain', value.text);
    if (value.file)
      data.items.add(new File([new Uint8Array(value.file.bytes)], value.file.name, { type: value.file.type }));
    (document.activeElement ?? document.body).dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, item);
}

test.beforeAll(async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/p05-files-'));
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  app = await createApp({
    port,
    clientPort: port,
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    reviewerAdapter: null,
  });
  const dist = path.resolve('dist');
  const built = (await fs.stat(path.join(dist, 'index.html'))).mtimeMs;
  for (const source of [
    'client/console/FilesPane.tsx',
    'client/console/FilePreview.tsx',
    'client/console/Composer.tsx',
    'client/console/ThreadView.tsx',
    'client/console/files.css',
    'client/console/attachments.css',
    'shared/file-drops.ts',
    'client/console/file-drops-api.ts',
  ])
    expect(built, `Build first: ${source}`).toBeGreaterThan((await fs.stat(source)).mtimeMs);
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  server.on('request', app);
  project = await api<Project>('/projects', 'POST', { name: 'P05 files' });
  await fs.writeFile(path.join(project.folder, 'brief.md'), '# Brief\n\nfirst version of the brief\n');
  const rows = ['item,count,note', ...Array.from({ length: 120 }, (_, i) => `item ${i + 1},${i},"quoted, with comma"`)];
  await fs.writeFile(path.join(project.folder, 'stock.csv'), `${rows.join('\r\n')}\r\n`);
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', { mode: 'ask' });
  await api(`/projects/${project.id}/threads/${thread.id}`, 'PUT', { engine: 'sample', mode: 'ask' });
  await api('/settings', 'PUT', {
    detail: 'technical',
    openProjects: [project.id],
    onboarding: {
      work: 'business',
      detail: 'technical',
      familiarity: 'comfortable',
      resumeAt: 'done',
      completedAt: new Date().toISOString(),
    },
  });
});
test.afterAll(async () => {
  await app?.locals.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('drop, paste, previews, the attach-to-thread chip and an older version, in the built Console', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const external: string[] = [];
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.route('**/*', async (route) => {
    const requested = new URL(route.request().url());
    if (requested.protocol.startsWith('http') && requested.hostname !== '127.0.0.1') {
      external.push(requested.href);
      await route.abort();
    } else await route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('console.files.open', 'true');
    localStorage.setItem('console.files.width', '420');
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'P05 files', exact: true }).click();
  await expect(row(page, 'brief.md')).toBeVisible();

  // Drop a picture from the OS: it lands in Imports/, opens, and is shown from its bytes.
  await dropFiles(pane(page), [{ name: 'photo.png', type: 'image/png', bytes: [...PNG_1X1] }]);
  await expect(pane(page).getByRole('status').filter({ hasText: 'Added Imports/photo.png' })).toBeVisible();
  const picture = pane(page).getByRole('img', { name: 'photo.png' });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(pane(page).locator('.files-identity')).toHaveText(/^v\d{4} · [0-9a-f]{8}$/);
  await expect(pane(page).getByText('PNG · 1×1')).toBeVisible();

  // A second drop of the same name gets the next free name rather than overwriting.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dropFiles(pane(page), [{ name: 'photo.png', type: 'image/png', bytes: [...PNG_1X1] }]);
  await expect(pane(page).getByRole('status').filter({ hasText: 'Imports/photo (2).png' })).toContainText(
    'already taken',
  );

  // A name that lies about its bytes is refused before anything is written.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await dropFiles(pane(page), [{ name: 'invoice.pdf', type: 'application/pdf', bytes: [...PNG_1X1] }]);
  await expect(pane(page).getByRole('alert')).toContainText('named as a PDF but contains a PNG picture');

  // A real PDF is described, never rendered, with the truth about where to read it.
  await dropFiles(pane(page), [{ name: 'invoice.pdf', type: 'application/pdf', bytes: [...PDF_SMALL] }]);
  await expect(pane(page).getByText('PDF 1.4', { exact: true })).toBeVisible();
  await expect(pane(page).getByText(/no in-app PDF viewer/)).toBeVisible();

  // A workbook's first sheet reads as a table, from the values the workbook saved.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  const workbook = buildXlsx(
    '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>' +
      '<row><c t="inlineStr"><is><t>Tables &amp; chairs</t></is></c><c><v>7</v></c></row></sheetData></worksheet>',
    { shared: ['item', 'count'] },
  );
  await dropFiles(pane(page), [
    { name: 'stock.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: [...workbook] },
  ]);
  await expect(pane(page).getByText(/The first sheet, Stock, of 2 sheets/)).toBeVisible();
  await expect(pane(page).getByRole('cell', { name: 'Tables & chairs', exact: true })).toBeVisible();
  await expect(pane(page).getByText('Rows 1–2 of 2 · 2 columns')).toBeVisible();

  // Paste text while the pane has focus: it becomes a dated text file.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await pane(page).getByRole('button', { name: 'Import files', exact: true }).focus();
  await paste(page, { text: 'Pasted from the clipboard' });
  await expect(pane(page).getByRole('status').filter({ hasText: /Added Imports\/Pasted text .*\.txt/ })).toBeVisible();
  await expect(pane(page).locator('.files-raw')).toHaveText('Pasted from the clipboard');
  // And a pasted picture.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).focus();
  await paste(page, { file: { name: 'image.png', type: 'image/png', bytes: [...PNG_1X1] } });
  await expect(pane(page).getByRole('img', { name: /^Pasted image .*\.png$/ })).toBeVisible();

  // CSV opens as a bounded, paged table; Raw still shows the text.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await row(page, 'stock.csv').click();
  await expect(pane(page).getByText('Rows 1–100 of 121 · 3 columns')).toBeVisible();
  await expect(pane(page).getByRole('columnheader', { name: 'note' })).toBeVisible();
  await expect(pane(page).getByRole('cell', { name: 'quoted, with comma' }).first()).toBeVisible();
  await pane(page).getByRole('button', { name: 'Next rows', exact: true }).click();
  await expect(pane(page).getByText('Rows 101–121 of 121 · 3 columns')).toBeVisible();

  // Attach brief.md to the thread from Files; the chip sits in the composer and opens the file.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await row(page, 'brief.md').click();
  await pane(page).getByRole('button', { name: 'Attach to thread', exact: true }).click();
  const attached = page.getByLabel('Attached files');
  await expect(attached.getByRole('button', { name: 'brief.md', exact: true })).toBeVisible();

  // A picture cannot travel on the text source path, and the composer says so instead of sending.
  await pane(page).getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByRole('combobox', { name: 'Attach a project file' }).selectOption('Imports/photo.png');
  const composer = page.getByRole('textbox', { name: 'Message this thread', exact: true });
  await composer.fill('What does the brief say?');
  await composer.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'photo.png is not a text document' })).toBeVisible();
  await attached.getByRole('button', { name: 'Remove photo.png', exact: true }).click();

  // Send: the turn records the file it carried, with the exact version, as a chip.
  await composer.press('Enter');
  const chip = page.getByRole('group', { name: 'Files sent with this message' }).or(
    page.getByLabel('Files sent with this message'),
  );
  const reference = chip.getByRole('button', { name: /^brief\.md v\d{4} · [0-9a-f]{8}$/ });
  await expect(reference).toBeVisible();
  await expect(attached).toHaveCount(0);

  // The file changes after the message was sent.
  const current = await api<{ sha: string }>(
    `/projects/${project.id}/documents/read?path=${encodeURIComponent('brief.md')}`,
  );
  await api(`/projects/${project.id}/documents/write`, 'POST', {
    path: 'brief.md',
    text: '# Brief\n\nsecond version, written later\n',
    baseSha: current.sha,
  });

  // The chip still opens the version the message sent, from History.
  await reference.click();
  await expect(pane(page).locator('.files-identity')).toContainText('older version from History');
  await expect(pane(page).locator('.files-raw')).toContainText('first version of the brief');
  await pane(page).getByRole('button', { name: 'Open the current file', exact: true }).click();
  await expect(pane(page).locator('.files-md')).toContainText('second version, written later');

  // The file's version list opens the older one too.
  await pane(page).getByText(/^Versions \(\d+\)$/).click();
  await expect(pane(page).getByRole('button', { name: /current$/ })).toBeDisabled();

  await page.screenshot({ path: 'test-results/p05-files-attachments.png' });
  expect(external).toEqual([]);
  expect(violations).toEqual([]);
});
