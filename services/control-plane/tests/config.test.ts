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

describe('FUNDING_DATABASE_URL, the managed gateway’s funding login', () => {
  const funding = 'postgresql://cp_funding:fixture_password@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const base = configuration(validEnv);

  it('is read beside DATABASE_URL, which it leaves alone', () => {
    expect(base.fundingDatabaseUrl).toBeNull();
    expect(configuration({ ...validEnv, FUNDING_DATABASE_URL: funding })).toEqual({ ...base, fundingDatabaseUrl: funding });
  });
  it.each([
    ['a suffixed login', funding.replace('cp_funding:', 'cp_funding_staging:')],
    ['the pooled host of the same endpoint', funding.replace('ep-fixture.', 'ep-fixture-pooler.')],
    ['channel binding', `${funding}&channel_binding=require`],
    ['port 5432', funding.replace('.neon.tech/', '.neon.tech:5432/')],
  ])('accepts %s', (_name, value) => {
    expect(configuration({ ...validEnv, FUNDING_DATABASE_URL: value }).fundingDatabaseUrl).toBe(value);
  });
  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['padded', ` ${funding}`],
    ['multi-line', `${funding}\n`],
    ['not text', 1],
    ['not a URL', 'cp_funding'],
    ['the Worker login', validEnv.DATABASE_URL],
    ['a login that only starts like it', funding.replace('cp_funding:', 'cp_fundingx:')],
    ['another database', funding.replace('/neondb?', '/otherdb?')],
    ['another Neon endpoint', funding.replace('ep-fixture.', 'ep-other.')],
    ['a host outside Neon', 'postgresql://cp_funding:fixture_password@attacker.example/neondb?sslmode=require'],
    ['another scheme', funding.replace('postgresql:', 'postgres:')],
    ['no TLS', funding.replace('?sslmode=require', '')],
    ['a short password', funding.replace('fixture_password', 'short')],
    ['another port', funding.replace('.neon.tech/', '.neon.tech:6543/')],
    ['an extra parameter', `${funding}&options=-csearch_path%3Dpublic`],
    ['a repeated parameter', `${funding}&sslmode=require`],
  ])('is null, never a refusal of the account routes, when %s', (_name, value) => {
    expect(configuration({ ...validEnv, FUNDING_DATABASE_URL: value })).toEqual(base);
  });
  it('never lets the Worker run as the funding login', () => {
    expect(() => configuration({ ...validEnv, DATABASE_URL: funding })).toThrow();
  });
});
