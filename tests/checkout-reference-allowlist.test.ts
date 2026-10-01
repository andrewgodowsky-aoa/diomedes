/**
 * The shipped app opens a payment page only through the desktop shell's external-link allowlist
 * (desktop/main.mjs asks the service, `app.locals`, before it hands an address to the system browser).
 * Without a check for payment pages the Buy button on the Usage screen would open nothing. This is
 * that check, on the real host over the faux account service: the processor's own page passes, so does
 * the test service's own page, and nothing else does. The host holds the check only while an account
 * service is there to sell credits.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { EngineService } from '../server/engines/service';
import { testOnlySecretBox } from '../server/connection-secrets';
import { ControlPlaneClient } from '../server/accounts/client';
import type { AccountBackend } from '../server/accounts/backend';
import { createFauxCloud, FAUX_BACKEND_LABEL, type FauxCloud } from '../services/control-plane/src/faux/cloud';
import { seedDemo } from '../services/control-plane/src/faux/seed';

let root: string;
let cloud: FauxCloud;
let backend: AccountBackend;
let app: Awaited<ReturnType<typeof createApp>> | undefined;

const open = async (accounts: { backend: AccountBackend } | null) => {
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: new EngineService(path.join(root, 'engines'), { discover: async () => [] }),
    reviewerAdapter: null,
    secretBox: testOnlySecretBox(),
    accounts,
  });
  return app.locals.allowsCheckoutReference as ((destination: string) => boolean) | undefined;
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-checkout-ref-'));
  cloud = await createFauxCloud({ file: null, passwordIterations: 1_000 });
  await seedDemo(cloud);
  backend = {
    client: new ControlPlaneClient('http://faux.local', (req) => cloud.handle(req)),
    view: () => ({ kind: 'faux', label: FAUX_BACKEND_LABEL, url: null, reason: null, signIn: 'password' }),
    close: async () => {},
  };
});
afterEach(async () => {
  await app?.locals.close();
  app = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

const faux = `http://faux.local/faux/checkout/cs_faux_${'a1b2c3d4'.repeat(3)}`;

describe('which payment pages the desktop shell may open', () => {
  test('the processor’s own checkout page and the test service’s own page, and nothing else', async () => {
    const allows = await open({ backend });
    expect(allows).toBeTypeOf('function');
    expect(allows!('https://checkout.stripe.com/c/pay/cs_test_a1B2c3')).toBe(true);
    expect(allows!(faux)).toBe(true);
    for (const refused of [
      'https://evil.example/pay',
      'https://checkout.stripe.com.evil.example/c/pay/x',
      'http://checkout.stripe.com/c/pay/x',
      'https://user:pw@checkout.stripe.com/c/pay/x',
      'http://faux.local/faux/checkout/not-a-session',
      'http://faux.local.evil.example/faux/checkout/cs_faux_' + 'a1b2c3d4'.repeat(3),
      'http://127.0.0.1:5199/faux/checkout/cs_faux_' + 'a1b2c3d4'.repeat(3),
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      '',
    ])
      expect(allows!(refused), refused).toBe(false);
  });

  test('with no account service there is nothing to sell, so nothing opens', async () => {
    const allows = await open(null);
    expect(allows).toBeTypeOf('function');
    expect(allows!('https://checkout.stripe.com/c/pay/cs_test_a1B2c3')).toBe(false);
  });
});
