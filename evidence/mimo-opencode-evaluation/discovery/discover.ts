// Live catalogue discovery through the same adapter path Diomedes uses.
// Prints only model identities and counts; never headers, auth or provider fields.
import { OpenCodeAdapter } from '../../server/engines/opencode.js';

const exe =
  'C:/Users/andre/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.14.1-win-x64/node_modules/opencode-ai/bin/opencode.exe';

let rawCount: number | undefined;
let rawMimo: Array<{ id: string; name: string }> = [];
const fetcher: typeof fetch = async (url, init) => {
  const response = await fetch(url, init);
  if (String(url).endsWith('/provider') && response.ok) {
    const clone = response.clone();
    try {
      const body = (await clone.json()) as { all?: Array<{ id?: string; models?: Record<string, { name?: string }> }> };
      const go = (body.all ?? []).find((p) => p.id === 'opencode-go');
      const models = go?.models ?? {};
      rawCount = Object.keys(models).length;
      rawMimo = Object.entries(models)
        .filter(([id, m]) => /mimo/i.test(id) || /mimo/i.test(String(m?.name ?? '')))
        .map(([id, m]) => ({ id, name: String(m?.name ?? '') }));
    } catch {
      /* ignore */
    }
  }
  return response;
};

const adapter = new OpenCodeAdapter(exe, process.cwd(), { fetch: fetcher, startupTimeoutMs: 170_000, requestTimeoutMs: 120_000 });
const started = Date.now();
const result = await adapter.inspect();
console.log(
  JSON.stringify(
    {
      ms: Date.now() - started,
      authentication: result.authentication,
      accountRoute: result.accountRoute,
      detail: result.detail,
      rawGoModelCount: rawCount,
      adapterModelCount: result.models.length,
      rawMimo,
      adapterMimo: result.models.filter((m) => /mimo/i.test(m.slug + m.name)),
      allSlugs: result.models.map((m) => m.slug),
    },
    null,
    2,
  ),
);
