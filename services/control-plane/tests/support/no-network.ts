import { beforeEach, vi } from 'vitest';

// Normal unit tests never contact providers implicitly. The explicitly opted-in
// real database suite uses pg/WebSockets rather than this HTTP fixture seam.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected HTTP request in offline tests.'); }));
});
