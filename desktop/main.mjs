import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureNativeAuthCallbacks, createNativeAuth } from './native-auth.mjs';
import {
  applicationMenuTemplate,
  createInstallAccepted,
  isUpdateReleaseReference,
  setupReferenceLinks,
  shouldQuitWhenAllWindowsClosed,
  shouldReopenMainWindow,
  supportsTitleBarOverlay,
  titleBarWindowOptions,
  updateShellConfig,
} from './app-updates.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
/**
 * OS-protected storage for model-API credentials (server/connection-secrets.ts): DPAPI on
 * Windows, the Keychain on macOS. The same rule as the account session's storage: no
 * encryption, or Linux's plaintext backend, means no credential can be saved at all.
 */
const secretBox = {
  kind: 'electron-safe-storage',
  available: () =>
    safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text',
  seal: (plain) => safeStorage.encryptString(plain),
  open: (sealed) => safeStorage.decryptString(sealed),
};
// Only explicit setup reference links may leave the app. This does not grant
// arbitrary model output or project documents permission to open local URLs.
// The list is per platform: the pinned Windows engine artefacts are not offered
// on a platform they cannot install on, and an unlisted destination is ignored.
function openSetupReference(destination) {
  const allowed = new Set(setupReferenceLinks(process.platform));
  if (!allowed.has(destination) && !isUpdateReleaseReference(destination)) return;
  void shell
    .openExternal(destination)
    .catch((error) => dialog.showErrorBox('The reference could not open', error.message));
}
app.setName('Diomedes');
if (process.env.DIOMEDES_DESKTOP_PROFILE)
  app.setPath('userData', process.env.DIOMEDES_DESKTOP_PROFILE);
const dataDir = process.env.DIOMEDES_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
process.env.DIOMEDES_DATA_DIR = dataDir;
process.env.DIOMEDES_RUNTIME_DIR ??= path.join(process.resourcesPath, 'native-runtime');
let window;
let appUrl;
let server;
let service;
let shuttingDown = false;
let releaseLock;
let nativeAuth;

// Field colour schemes as [chrome, t1] pairs for the titlebar overlay.
// `cobalt` is retired and reads as `harbor` for saved settings.
const FIELD_TITLEBAR = {
  field: ['#121417', '#e6e9ed'],
  'deep-field': ['#0c1220', '#e8edf5'],
  graphite: ['#151515', '#ebe9e6'],
  verdigris: ['#0a1716', '#e4efeb'],
  harbor: ['#0d1020', '#e7e9f2'],
  cobalt: ['#0d1020', '#e7e9f2'],
  ember: ['#171311', '#ede7e2'],
  moss: ['#111410', '#e7eae3'],
  dusk: ['#151219', '#ebe6ef'],
  ink: ['#0a0a0b', '#f2f2f2'],
  paper: ['#f3f4f6', '#1a1d21'],
};
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function titleBarFor(packageId) {
  const id = packageId === 'cobalt' ? 'harbor' : packageId;
  const entry = FIELD_TITLEBAR[id] ?? FIELD_TITLEBAR.field;
  const [color, symbolColor] = entry;
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor))
    return { color: '#121417', symbolColor: '#e6e9ed', height: 40 };
  return { color, symbolColor, height: 40 };
}

/**
 * The folder one account's themes live in.
 *
 * Mirrored from `themeScopeKey` in server/themes.ts, which owns it. This file
 * is the Electron shell and cannot import the service's TypeScript, so the six
 * lines are duplicated rather than shared. Change one and change the other.
 */
function themeScopeKey(workspace, personId) {
  const of = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  return workspace?.kind === 'business'
    ? `business-${of(workspace.organizationId)}`
    : `personal-${of(personId)}`;
}

/**
 * The titlebar for a custom theme: its own chrome and t1 when both are plain
 * six-digit hex, and otherwise the built-in entry for the scheme it was built
 * on. Every pack names a `baseTheme`, so there is always an answer here — which
 * is exactly why `dataset.package` carries the base scheme id too.
 *
 * Nothing is trusted: the pack is read as data, two colours are taken from it,
 * and anything unreadable falls through to the scheme.
 */
async function customTitleBar(settings) {
  const active = settings?.appearance?.activeTheme;
  if (!active || typeof active.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(active.id))
    return null;
  try {
    const identity = JSON.parse(
      await fs.readFile(path.join(dataDir, 'workspaces', 'identity.json'), 'utf8'),
    );
    // The stored workspace, not the service's demoted one: the shell cannot
    // check a membership. A revoked member's titlebar therefore keeps the old
    // colours until the service writes Personal back on the next read, which is
    // a cosmetic lag and never access — the themes themselves are served only
    // through the scope `workspaces.active()` resolves.
    const scope = themeScopeKey(settings.activeWorkspace, identity?.id);
    // A theme applied in another workspace is not this workspace's theme. The
    // service answers the built-in appearance for it, so the titlebar must too,
    // rather than reading a folder that belongs to a different scope. A pointer
    // with no scope was written before scopes were recorded; it is taken as-is.
    if (active.scope !== undefined && active.scope !== scope) return null;
    const pack = JSON.parse(
      await fs.readFile(path.join(dataDir, 'themes', scope, active.id, 'pack.json'), 'utf8'),
    );
    const chrome = pack?.tokens?.color?.chrome?.$value;
    const text = pack?.tokens?.color?.t1?.$value;
    if (HEX_COLOR.test(String(chrome)) && HEX_COLOR.test(String(text)))
      return { color: chrome, symbolColor: text, height: 40 };
    return titleBarFor(pack?.baseTheme);
  } catch {
    return null;
  }
}

// The service persists settings at settings.json in the data dir
// (see server/store.ts). Read the saved appearance once, then re-apply
// when it changes. Titlebar appearance stays in the shell.
async function applyTitleBarOverlay() {
  // macOS draws its own title bar, so there is no overlay to set there.
  if (!supportsTitleBarOverlay(process.platform)) return;
  if (!window || window.isDestroyed()) return;
  try {
    const raw = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
    const settings = JSON.parse(raw);
    const custom = await customTitleBar(settings);
    window.setTitleBarOverlay(custom ?? titleBarFor(settings?.appearance?.package));
  } catch {
    // Missing file, unparsable JSON, or unknown id: keep the default overlay.
  }
}

function watchSettingsForTitleBar() {
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void applyTitleBarOverlay();
    }, 150);
  };
  try {
    const watcher = watch(dataDir, (_event, filename) => {
      if (!filename || filename === 'settings.json') schedule();
    });
    watcher.on('error', () => {});
  } catch {
    // Watching is best-effort; the default overlay stays if it fails.
  }
}

// The persisted interface preference is the only app zoom authority. Native
// Chromium zoom would multiply it and drift from the visible Settings value.
// The menu outlives the window on macOS, so a command with no window is ignored.
function interfaceScale(command) {
  if (!window || window.isDestroyed()) return;
  void window.webContents
    .executeJavaScript(
      `window.dispatchEvent(new CustomEvent('diomedes-interface-scale', { detail: ${JSON.stringify(command)} }))`,
    )
    .catch((error) => console.error('Interface size could not change:', error));
}

/**
 * Build the main window and load the local service into it. Called once at
 * startup, and again on macOS when the Dock reopens an app whose window was
 * closed. Every navigation, window-open and permission guard is established
 * here, so a reopened window is the same guarded window as the first one.
 */
async function createMainWindow() {
  if (!appUrl) return;
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    title: 'Diomedes',
    backgroundColor: '#16191d',
    show: false,
    ...titleBarWindowOptions(process.platform),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(root, 'native-auth-preload.cjs'),
    },
  });
  const win = window;
  win.webContents.setZoomFactor(1);
  void win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const command =
      input.key === '+' || input.key === '='
        ? 'increase'
        : input.key === '-'
          ? 'decrease'
          : input.key === '0'
            ? 'reset'
            : null;
    if (!command) return;
    event.preventDefault();
    interfaceScale(command);
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(applicationMenuTemplate(process.platform, { interfaceScale })),
  );
  win.webContents.setWindowOpenHandler(({ url: destination }) => {
    openSetupReference(destination);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, destination) => {
    if (new URL(destination).origin !== appUrl) {
      event.preventDefault();
      openSetupReference(destination);
    }
  });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  win.once('ready-to-show', () => win.show());
  await win.loadURL(appUrl);
  await applyTitleBarOverlay();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Capture callbacks before ready; main retains single-instance ownership.
  const nativeCallbacks = captureNativeAuthCallbacks(app, process.argv);
  app.on('will-quit', () => { nativeCallbacks.dispose(); nativeAuth?.dispose(); });
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  // Closing the last window quits Diomedes on Windows and Linux. On macOS the
  // app stays in the Dock, which is the platform's own convention; the local
  // service stays up only so the same app can reopen its window, and Quit below
  // still closes it. A windowless Diomedes is not running automation.
  app.on('window-all-closed', () => {
    if (shouldQuitWhenAllWindowsClosed(process.platform)) app.quit();
  });
  // A Dock activation reopens the window on macOS. Never while quitting, and
  // never before the local service has an address to load.
  app.on('activate', () => {
    if (shuttingDown || !appUrl) return;
    if (!shouldReopenMainWindow(process.platform, BrowserWindow.getAllWindows().length)) return;
    void createMainWindow().catch((error) =>
      dialog.showErrorBox('Diomedes could not reopen its window', error.message),
    );
  });
  app.on('before-quit', (event) => {
    if (shuttingDown || !service) return;
    event.preventDefault();
    shuttingDown = true;
    void service.locals
      .close()
      .then(() => {
        server.closeAllConnections();
        server.close(() => {
          void Promise.resolve(releaseLock?.())
            .then(() => app.quit())
            .catch((error) => {
              dialog.showErrorBox('Diomedes could not release its data folder', error.message);
              app.exit(1);
            });
        });
      })
      .catch((error) => {
        dialog.showErrorBox('Diomedes could not close cleanly', error.message);
        app.exit(1);
      });
  });
  void app
    .whenReady()
    .then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const { claimDataFolder, createApp, serveClient } = await import('./server/app.mjs');
      // Bind an available loopback port before configuring the origin checks.
      server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      // Claim the folder once the port is known: a recorded start time and port
      // let a later start tell a live Diomedes from a pid the system reused.
      ({ release: releaseLock } = await claimDataFolder(dataDir, { port }));
      // Update shell facts and the owned close-and-install handoff live in
      // desktop/app-updates.mjs and desktop/update-helper.mjs, staged next to
      // main.mjs by scripts/package-desktop.mjs. The install callback is the
      // existing graceful quit: the app closes so the installer can replace it.
      const updateShell = await updateShellConfig({
        platform: process.platform,
        packaged: app.isPackaged,
        execPath: process.execPath,
        dataDir,
      });
      const updates = {
        ...updateShell,
        onInstallAccepted: createInstallAccepted(() => app.quit(), {
          onError: (error) =>
            dialog.showErrorBox('Diomedes could not close for the update', error.message),
        }),
      };
      service = await createApp({
        dataDir,
        projectRoot:
          process.env.DIOMEDES_PROJECTS_DIR ?? path.join(app.getPath('documents'), 'Diomedes'),
        port,
        clientPort: port,
        updateOverrides: updates,
        secretBox,
      });
      serveClient(service, path.join(root, 'dist'));
      server.on('request', service);
      appUrl = `http://127.0.0.1:${port}`;
      nativeAuth = createNativeAuth({
        clientId: process.env.DIOMEDES_WORKOS_CLIENT_ID,
        tokenIssuer: process.env.DIOMEDES_WORKOS_TOKEN_ISSUER,
        origin: appUrl,
        getWindow: () => window,
      });
      nativeCallbacks.connect((callback) => nativeAuth.handleCallback(callback));
      await createMainWindow();
      if (supportsTitleBarOverlay(process.platform)) watchSettingsForTitleBar();
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(
        path.join(dataDir, 'desktop-startup.json'),
        JSON.stringify(
          {
            version: app.getVersion(),
            executable: process.execPath,
            pid: process.pid,
            url: appUrl,
            startedAt: new Date().toISOString(),
            packaged: app.isPackaged,
          },
          null,
          2,
        ),
      );
    })
    .catch((error) => {
      dialog.showErrorBox('Diomedes could not start', error.message);
      app.exit(1);
    });
}
