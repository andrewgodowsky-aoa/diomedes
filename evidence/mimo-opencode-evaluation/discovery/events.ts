process.on('unhandledRejection', () => {});
// Observe the event shapes the route receives for one text-only turn:
// event type, part id, part type and delta field. Content lengths only.
import { OpenCodeAdapter, OPENCODE_ACCOUNT_ROUTE } from '../../server/engines/opencode.js';

const exe =
  'C:/Users/andre/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.14.1-win-x64/node_modules/opencode-ai/bin/opencode.exe';
const model = process.argv[2] ?? 'opencode-go/mimo-v2.6-flash';
const partTypes = new Map<string, string>();
const seen: string[] = [];
const fetcher: typeof fetch = async (url, init) => {
  const response = await fetch(url, init);
  if (!String(url).includes('/event') || !response.body) return response;
  const [a, b] = response.body.tee();
  (async () => {
    try {
    const reader = b.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
        try {
          const ev = JSON.parse(data);
          const p = ev.properties ?? {};
          if (ev.type === 'message.part.updated') {
            partTypes.set(p.part?.id, p.part?.type);
            seen.push(`updated part=${p.part?.id} type=${p.part?.type} len=${(p.part?.text ?? '').length}`);
          } else if (ev.type === 'message.part.delta') {
            seen.push(`delta part=${p.partID} type=${partTypes.get(p.partID)} field=${p.field} len=${String(p.delta ?? '').length}`);
          } else if (ev.type === 'message.updated') {
            seen.push(`message.updated role=${p.info?.role} provider=${p.info?.providerID} model=${p.info?.modelID} finish=${p.info?.finish ?? ''} tokens=${JSON.stringify(p.info?.tokens ?? null)} cost=${p.info?.cost ?? ''}`);
          } else seen.push(ev.type);
        } catch {
          /* ignore */
        }
      }
    }
    } catch { /* stream closed */ }
  })();
  return new Response(a, { status: response.status, headers: response.headers });
};
const adapter = new OpenCodeAdapter(exe, process.cwd(), { fetch: fetcher, startupTimeoutMs: 20_000 });
const result = await adapter.generate({
  projectId: 'p', threadId: 't', requestId: 'r', model, accountRoute: OPENCODE_ACCOUNT_ROUTE,
  instructions: 'Answer plainly.', prompt: 'Reply with exactly the text MIMO-ROUTE-OK-7431 and nothing else.', documents: [],
});
// collapse consecutive identical lines
const out: string[] = [];
for (const line of seen) {
  const key = line.replace(/len=\d+/, 'len=*');
  const last = out[out.length - 1];
  if (last && last.replace(/ x\d+$/, '').replace(/len=\d+/, 'len=*') === key) {
    const m = last.match(/ x(\d+)$/);
    out[out.length - 1] = last.replace(/ x\d+$/, '') + ` x${m ? Number(m[1]) + 1 : 2}`;
  } else out.push(line);
}
console.log(out.join('\n'));
console.log('RESULT length', result.text.length, 'attributed', result.model);
console.log('RESULT tail', JSON.stringify(result.text.slice(-40)));
