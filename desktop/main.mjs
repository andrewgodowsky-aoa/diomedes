import { app, BrowserWindow, dialog, Menu } from 'electron';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
app.setName('Diomedes');
if (process.env.DIOMEDES_DESKTOP_PROFILE)
  app.setPath('userData', process.env.DIOMEDES_DESKTOP_PROFILE);
const dataDir = process.env.DIOMEDES_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
process.env.DIOMEDES_DATA_DIR = dataDir;
process.env.DIOMEDES_RUNTIME_DIR ??= path.join(process.resourcesPath, 'native-runtime');
let window;
let server;
let service;
let shuttingDown = false;
let releaseLock;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
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
      service = await createApp({
        dataDir,
        projectRoot:
          process.env.DIOMEDES_PROJECTS_DIR ?? path.join(app.getPath('documents'), 'Diomedes'),
        port,
        clientPort: port,
      });
      serveClient(service, path.join(root, 'dist'));
      server.on('request', service);
      const url = `http://127.0.0.1:${port}`;
      window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 800,
        minHeight: 600,
        title: 'Diomedes',
        backgroundColor: '#222d39',
        show: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#17212e', symbolColor: '#eaeff3', height: 46 },
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { label: 'File', submenu: [{ role: 'quit' }] },
          {
            label: 'Edit',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          {
            label: 'View',
            submenu: [
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { role: 'resetZoom' },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
        ]),
      );
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, destination) => {
        if (new URL(destination).origin !== url) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      window.once('ready-to-show', () => window.show());
      await window.loadURL(url);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(
        path.join(dataDir, 'desktop-startup.json'),
        JSON.stringify(
          {
            version: app.getVersion(),
            executable: process.execPath,
            pid: process.pid,
            url,
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
