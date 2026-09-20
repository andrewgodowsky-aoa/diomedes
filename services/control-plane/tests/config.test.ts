import { describe, expect, it } from 'vitest';
import { configuration } from '../src/config.js';

import { validEnv } from './support/fixtures.js';

describe('strict configuration', () => {
  it('accepts an explicit local loopback origin', () => {
    expect(configuration(validEnv).origins).toEqual(['http://127.0.0.1:8791']);
  });
  it.each(Object.keys(validEnv))('refuses a missing %s before any provider call', (key) => {
    expect(() => configuration({ ...validEnv, [key]: undefined })).toThrow();
  });
  it.each(['*', 'null', 'https://good.example/path', 'https://good.example/', 'https://u:p@good.example', 'https://good.example,https://good.example'])('refuses origin %s', (value) => {
    expect(() => configuration({ ...validEnv, ALLOWED_ORIGINS: value })).toThrow();
  });
  it('refuses insecure staging origins and invalid secrets', () => {
    expect(() => configuration({ ...validEnv, ENVIRONMENT: 'staging' })).toThrow();
    expect(() => configuration({ ...validEnv, WORKOS_API_KEY: 'placeholder' })).toThrow();
    expect(() => configuration({ ...validEnv, DATABASE_URL: 'postgresql://user:pw@attacker.example/db' })).toThrow();
    expect(() => configuration({ ...validEnv, DATABASE_URL: validEnv.DATABASE_URL + '&options=-csearch_path%3Dpublic' })).toThrow();
  });
});
