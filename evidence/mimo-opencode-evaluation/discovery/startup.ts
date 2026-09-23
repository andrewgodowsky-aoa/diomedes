// Startup diagnosis: the production adapter, with the child's own log printed.
// Prints log lines with message= only, never env or headers.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { OpenCodeAdapter } from '../../server/engines/opencode.js';

const exe =
  'C:/Users/andre/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.14.1-win-x64/node_modules/opencode-ai/bin/opencode.exe';
const t0 = Date.now();
const buf: string[] = [];
const adapter = new OpenCodeAdapter(exe, process.cwd(), {
  startupTimeoutMs: 45_000,
  spawn: (command, args, options) => {
    const child = spawn(command, [...args, '--print-logs', '--log-level', 'INFO'], options) as ChildProcessWithoutNullStreams;
    const tap = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const msg = line.match(/message=("[^"]*"|\S+)/)?.[1];
        const service = line.match(/service=(\S+)/)?.[1];
        const level = line.match(/level=(\S+)/)?.[1] ?? line.slice(0, 5);
        if (line.trim()) buf.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + line.replace(/(password|token|key|authorization)=\S+/gi, '$1=[x]').slice(0, 260));
        if (msg && false) console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${level} ${service ?? ''} ${msg}`);
      }
    };
    const pw = String(options?.env?.OPENCODE_SERVER_PASSWORD ?? '');
    const dir = process.cwd();
    const port = args[args.indexOf('--port') + 1];
    setTimeout(async () => {
      for (const route of ['/global/health', '/path', '/provider']) {
        const t = Date.now();
        try {
          const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + pw).toString('base64'), 'x-opencode-directory': dir }, signal: AbortSignal.timeout(8000) });
          buf.push(`PROBE ${route} status=${r.status} ms=${Date.now() - t}`);
        } catch (e) { buf.push(`PROBE ${route} error=${(e as Error).name} ms=${Date.now() - t}`); }
      }
    }, 15000);
    child.stderr.on('data', tap);
    child.stdout.on('data', tap);
    return child;
  },
});
try {
  const r = await adapter.inspect();
  console.log('OK', r.models.length, ((Date.now() - t0) / 1000).toFixed(1));
} catch (e) {
  console.log(buf.join(String.fromCharCode(10)));
  console.log('FAIL', (e as Error).message, ((Date.now() - t0) / 1000).toFixed(1));
}
