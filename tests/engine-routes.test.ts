import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_ENGINES } from '../shared/engines.js';
import { ENGINE_ROUTE_PROFILES, routeCaption } from '../shared/engine-routes.js';
import { OPENCODE_ACCOUNT_ROUTE } from '../server/engines/opencode.js';
import { TESTED_VERSIONS } from '../server/engines/service.js';

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;

/** Every string a route profile can put in front of a person. */
const sentences = (engine: (typeof EXTERNAL_ENGINES)[number]): string[] => {
  const profile = ENGINE_ROUTE_PROFILES[engine];
  return [
    profile.routeLabel,
    profile.taskScope,
    profile.billing,
    ...profile.reuses,
    ...profile.doesNotReuse,
  ];
};

describe('engine route profiles', () => {
  it('says what every route is, reuses and does not reuse', () => {
    for (const engine of EXTERNAL_ENGINES) {
      const profile = ENGINE_ROUTE_PROFILES[engine];
      expect(profile.routeLabel.trim(), engine).not.toBe('');
      expect(profile.taskScope.trim(), engine).not.toBe('');
      expect(profile.billing.trim(), engine).not.toBe('');
      expect(profile.reuses.length, engine).toBeGreaterThan(0);
      expect(profile.doesNotReuse.length, engine).toBeGreaterThan(0);
      for (const entry of sentences(engine)) expect(entry.trim(), engine).not.toBe('');
    }
  });

  it('names the account route the OpenCode adapter actually accepts', () => {
    const provider = OPENCODE_ACCOUNT_ROUTE.split(':')[1];
    expect(provider).toBe('opencode-go');
    const label = ENGINE_ROUTE_PROFILES.opencode.routeLabel.toLowerCase().replace(/\s+/g, '-');
    expect(label).toContain(provider);
    // The one provider the adapter enables is the one the label promises; no
    // other provider may be presented as usable through this route.
    expect(ENGINE_ROUTE_PROFILES.opencode.doesNotReuse.join(' ')).toMatch(/zen/i);
  });

  it('states the billing boundary without promising what a provider charges', () => {
    for (const engine of EXTERNAL_ENGINES) {
      const billing = ENGINE_ROUTE_PROFILES[engine].billing;
      expect(billing, engine).toMatch(/billed|billing/i);
      expect(billing, engine).not.toMatch(/\bno (additional |extra |further )?charges?\b/i);
      expect(billing, engine).not.toMatch(/never (be )?charged|free of charge|without charge/i);
    }
  });

  it('claims no shipped engine of its own and keeps a settings voice', () => {
    for (const engine of EXTERNAL_ENGINES) {
      for (const entry of sentences(engine)) {
        // Diomedes drives tools a person already has through adapters. Naming a
        // shipped engine here would be the claim AGENTS.md forbids.
        expect(entry, `${engine}: ${entry}`).not.toMatch(/codex/i);
        expect(entry, `${engine}: ${entry}`).not.toContain('!');
      }
    }
  });

  it('builds the caption from the label and the task scope', () => {
    for (const engine of EXTERNAL_ENGINES) {
      const profile = ENGINE_ROUTE_PROFILES[engine];
      expect(routeCaption(engine)).toBe(`${profile.routeLabel} · ${profile.taskScope}`);
    }
  });
});

describe('README', () => {
  const readme = read('README.md');

  it('states this application version and no other', () => {
    expect(readme).toContain(`Diomedes ${packageVersion}`);
    const claimed = [...readme.matchAll(/(?:Diomedes|[Vv]ersion)\s+v?(\d+\.\d+\.\d+)/g)].map(
      (match) => match[1],
    );
    expect(claimed.length).toBeGreaterThan(0);
    for (const version of claimed) expect(version).toBe(packageVersion);
  });

  it('lists the reviewed version of every adapter route', () => {
    for (const [engine, version] of Object.entries(TESTED_VERSIONS))
      expect(readme, engine).toContain(version);
  });

  it('keeps the unsigned installer honest and tells nobody to lower protection', () => {
    expect(readme).toMatch(/\bunsigned\b/i);
    // A checksum is about bytes. Saying so beside it is the whole point.
    expect(readme).toMatch(/SHA-256/);
    expect(readme).toMatch(/does not prove who built them/i);
    expect(readme).toMatch(/never turn off windows protection/i);
  });
});
