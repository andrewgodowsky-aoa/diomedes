const base = new URL(
  process.env.DIOMEDES_SERVICE_URL ?? `http://127.0.0.1:${process.env.DIOMEDES_PORT ?? '47631'}`,
);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('The sample project can only be created through a local Diomedes service.');
}

const response = await fetch(new URL('/api/projects/sample', base), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
  body: '{}',
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok)
  throw new Error(`Sample project failed (${response.status}): ${await response.text()}`);
console.log(JSON.stringify(await response.json(), null, 2));

export {};
