# Diomedes

A local working book for projects, documents, plans, tasks, approvals, and reversible file history. The interface follows the live v5 Diomedes artifacts under `../planning/2026-09-05-v5-diomedes-design/design/`.

## Run

### Windows desktop

Open `release/Diomedes-win32-x64/Diomedes.exe`. Keep the entire release folder together.
This is a portable Windows x64 desktop application with its own window and bundled
runtime. Node, npm, and a browser are not needed to run it. It starts its own service
on an available loopback port and closes that service when you exit the application.
Use View > Zoom In/Out or Settings > Appearance > Interface size to adjust readability.

Desktop state is stored in `%APPDATA%/Diomedes/data`; new projects default to
`Documents/Diomedes`. The browser prototype's `.data` is preserved and is not
automatically imported. The desktop starts with its own setup and project list.
The included, hash-checked native Codex runtime still requires your existing ChatGPT
sign-in; no credentials or project data are packaged. Subscription-backed generation
was not rerun for this desktop release.

This local release is unsigned and has no installer or automatic updater.
To build and verify it from source:

```powershell
npm ci
node node_modules/electron/install.js
npm run prepare-native
npm run package:desktop
npm run test:desktop
```

### Browser development

Node 22.12 or later is required. Run commands from this directory:

```powershell
npm ci
npm run prepare-native
npm run dev
```

Open **http://127.0.0.1:5173**. The local file service listens only on **127.0.0.1:47631**. Ctrl+C stops both processes. No startup entry, remote listener, tunnel, or global package is installed.

For a single production listener:

```powershell
npm run build
npm start
```

Then open **http://127.0.0.1:47631**. Stop a development service before starting production on the same port.

For a background Windows launch after building, run `./Start-Diomedes.ps1`. Use `./Stop-Diomedes.ps1` to stop that recorded process and its children. The stop script checks the process identity before acting. Stop active tasks in the interface first when practical; interrupted writes are recovered on the next launch.

On this Windows machine, Node needs its system certificate store for package downloads. If npm reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, run with `NODE_USE_SYSTEM_CA=1` using the installed Node 24 runtime. Keep TLS verification enabled. The build has no external font requests.

## First use

Complete the three setup questions, then create a project or choose **Open sample project**. The sample creates three text documents in a new folder. No sample is created during onboarding itself.

1. Open **Plan**, edit the document, and save changes.
2. Choose **Make tasks from this plan**, review the proposed tasks, and add them.
3. Start a task. **Sample work** is a scripted local demonstration, labeled throughout the interface.
4. Respond to **Needs your OK**, then inspect **Review**. Keep accepts the current file; Undo records and applies its previous contents.
5. Open **History** to inspect changes, save named versions, or restore. A restore is itself reversible. Newer content produces explicit conflict choices.

Change Guided, Standard, or Technical in Settings or the top-right detail menu. Presentation changes do not grant permissions. Unsaved text is backed up in this browser and recovered when reopening the document.

## Integrations

**Codex with native ChatGPT:** `prepare-native` copies a matching, already-installed Codex 0.153.4 runtime into this app's data directory and records its hashes. It does not change the installed Codex application or copy credentials. Existing native ChatGPT sign-in is required. Enable the service in Settings, then choose the online service in the composer or task details.

The adapter proves Windows write denial, disables inherited MCP entries, verifies their disabled inventory, selects no environments or tools, and requires native ChatGPT account status. Selected text and instructions are sent through that account. There is no API-key fallback, environment-tool access, command execution, or provider fallback. Ask returns text. Plan saves returned text through History. Work prepares explicit file proposals which require approval before this service applies the captured changes.

**LocalAI supervisor:** observational `GET http://127.0.0.1:8080/localai/status` only. Availability and resident readiness are reported without starting, stopping, loading, pinning, or generating through the existing service.

**AionCore:** not installed or adopted. The native adapter is a bounded fallback described in the foundation reconciliation. Native Claude, OpenCode, Hermes work execution, local generation, remote pairing, and arbitrary tool connections are not implemented.

## Storage and scope

- Code: this `diomedes` directory.
- App state: `.data/`, configurable with `DIOMEDES_DATA_DIR`.
- Default new projects: `fixtures/projects/`, configurable with `DIOMEDES_PROJECTS_DIR`.
- Browser draft backup: local storage for this loopback origin.
- Ports: `DIOMEDES_PORT` and `DIOMEDES_CLIENT_PORT`.

Projects use ordinary folders. Text/Markdown writes, task records, and decisions are persisted. History stores before/after content objects and a durable pending-write journal. A restarted service reconciles interrupted writes and marks active work stopped. Changes from other applications are detected on read; intermediate external edits cannot be reconstructed.

Files must be valid UTF-8 text, no larger than 8 MB, and inside a registered project. Credential paths, production LocalAI folders, path traversal, and symbolic links/junctions are rejected. Binary document editing and automatic history pruning are not implemented. No Git commit, branch, push, or external message is performed by the app.

This is a local prototype, not a remote multi-user service. Other processes on this computer can access its loopback API. Origin/Host checks and a required mutation header block unrelated websites; there is no account pairing or local bearer-token authentication.

## Verify

```powershell
npm run check
npm test
npm run build
npm run test:ui
```

Browser tests use installed Microsoft Edge and isolated data/ports; no browser download is needed. `npm run verify:native-work` is a separate **subscription-backed** synthetic integration check, not part of the normal test suite. It requires native runtime setup and ChatGPT sign-in. It creates only its own test project, verifies preview/approval/write/history/restore, and closes its own service.

See `evidence/BUILD-REPORT.md` for exact verification results, known limits, and source precedence. Original planning documents are preserved. Font license texts are in `licenses/`.
