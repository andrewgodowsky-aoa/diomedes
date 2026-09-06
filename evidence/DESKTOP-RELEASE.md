# Windows desktop and typography correction

2026-09-05

## Delivered

- `release/Diomedes-win32-x64/Diomedes.exe`: portable Windows x64 desktop application.
  Keep its adjacent resources and DLLs with it. Electron 44.2.0 manages the window
  and local service; no separately launched server or browser is required.
- UI defaults: 16px body, 15px captions/buttons, 18px task titles. Interface scaling
  applies consistently to UI controls, headings, and responsive layouts. Reading
  and code scales remain independent. Secondary text is brighter, and actual serif
  semibold fonts are bundled. No interface wording was changed.
- Desktop data and projects live in user-writable folders outside the release.
  The browser prototype remains intact and is not automatically migrated.
- Native runtime files are verified against the existing prepare-native hashes.
  Credentials, app settings, history, fixtures, and project documents are excluded.

## Verification

- TypeScript check and production Vite build passed.
- 62 backend/integration unit tests passed.
- 10 browser workflow tests passed.
- Packaged executable smoke test passed: real window and task board, renderer
  Node access disabled, 124% font scaling, service termination on close, data lock
  release, and persisted task state after restart. See `desktop-proof.json`.
- Rendered desktop screenshots inspected directly: `screenshots/desktop-tasks.png`
  and `screenshots/desktop-tasks-large.png`.

## Limits

This is an unsigned portable local release, with no installer or updater. Existing
feature limits from README still apply. The desktop smoke test uses a sample project
and does not spend subscription quota. Native model generation is not newly proven
inside this packaged release. The local API retains the prototype's loopback trust
model; it is not a remote multi-user service.

## Source changes

- `client/styles.css`, `client/main.tsx`
- `server/integrations.ts`
- `desktop/main.mjs`, `desktop/service.ts`
- `scripts/package-desktop.mjs`, `scripts/desktop-smoke.mjs`
- `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`
- This report, `desktop-proof.json`, and desktop screenshots

No Git repository exists in this workspace, and nothing was committed or pushed.
Suggested future commit: `Add Windows desktop release and consistent UI typography`.
