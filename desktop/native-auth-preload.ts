import { exposeAuthKit } from '@workos/authkit-electron/preload';

// Bundle as CJS: sandboxed Electron preloads cannot load ESM packages themselves.
// The main-process boundary denies token/org channels and projects display state.
exposeAuthKit();
