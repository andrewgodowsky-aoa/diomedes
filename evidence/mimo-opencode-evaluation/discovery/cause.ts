// Cause experiment: same adapter, same isolated server; the only difference is
// that the adapter's model-list /provider call waits DELAY ms after the server
// reports ready. If OpenCode's background models.dev refresh is the reason the
// route sees an old catalogue, MiMo 2.6 appears only in the delayed run.
// Prints model identities only.
import { OpenCodeAdapter } from '../../server/engines/opencode.js';

const exe =
  'C:/Users/andre/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.14.1-win-x64/node_modules/opencode-ai/bin/opencode.exe';
const delay = Number(process.argv[2] ?? '0');

let ready = false;
const fetcher: typeof fetch = async (url, init) => {
  if (String(url).endsWith('/provider') && ready && delay) await new Promise((r) => setTimeout(r, delay));
  const response = await fetch(url, init);
  if (String(url).endsWith('/provider') && response.ok) ready = true;
  return response;
};

const adapter = new OpenCodeAdapter(exe, process.cwd(), {
  fetch: fetcher,
  startupTimeoutMs: 170_000,
  requestTimeoutMs: 120_000,
});
const result = await adapter.inspect();
console.log(
  JSON.stringify({
    delayMs: delay,
    count: result.models.length,
    mimo: result.models.filter((m) => /mimo/i.test(m.slug)).map((m) => `${m.slug} (${m.name})`),
  }),
);
