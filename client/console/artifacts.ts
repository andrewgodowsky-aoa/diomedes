// The parser lives in shared/artifacts.ts now, so the server can read it too.
// This file re-exports it, unchanged, so every existing import here keeps
// working.
export * from '../../shared/artifacts';
