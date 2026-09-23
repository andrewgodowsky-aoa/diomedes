import { config } from 'zod';

// The built app runs under a Content-Security-Policy that allows no eval
// (scripts/app-csp.ts). The first time Zod builds an object schema it probes
// for eval with `new Function('')`; the policy refuses the probe and reports a
// violation, though Zod catches the refusal and parses without eval. Jitless
// mode skips the probe, and parses the same way the policy already makes it.
//
// Each entry imports this module first (client/main.tsx and
// client/inventory/main.tsx), so it runs before any module that builds a
// schema, and the bundler keeps it ahead of them in the chunk they share.
config({ jitless: true });
