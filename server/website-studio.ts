/**
 * Is the local Website Studio running?
 *
 * The Design Center never edits website pages. All it does is tell a person
 * whether the studio that does is up, and hand them a link to it. That question
 * is asked from the service rather than from the browser for two reasons: the
 * browser would need a cross-origin request to a port it has no business
 * reaching, and a failed `fetch` in a page cannot tell "nothing is listening"
 * apart from "something is listening and said no".
 *
 * The request is deliberately plain:
 *
 * - **Loopback only.** `127.0.0.1` by address, never a name that could resolve
 *   somewhere else. This is the one outward request in the whole Design Center
 *   and it cannot leave this computer.
 * - **No `Origin` header.** This is not a browser request and must not be
 *   mistaken for one: an `Origin` would invite the studio to make a CORS
 *   decision about a caller that is not a web page.
 * - **`Host` set explicitly**, so a studio that checks the header it was
 *   addressed by sees the loopback address it is bound to.
 * - **One second, once.** A studio that is starting up reads as not running;
 *   the person presses the button again. No retry loop, no backoff, no timer.
 *
 * `node:http` rather than `fetch` because the headers are the point: this is
 * the level at which "send exactly these and nothing else" is a statement about
 * the bytes on the wire rather than about a library's defaults.
 */
import http from 'node:http';

export const WEBSITE_STUDIO_HOST = '127.0.0.1';
export const WEBSITE_STUDIO_PORT = 4400;
export const WEBSITE_STUDIO_URL = `http://${WEBSITE_STUDIO_HOST}:${WEBSITE_STUDIO_PORT}/`;
export const WEBSITE_STUDIO_TIMEOUT_MS = 1000;

/** What the studio says about itself, or why the app could not hear it. */
export interface WebsiteStudioProbe {
  reachable: boolean;
  url: string;
  /** The studio's reported version when it answered; null otherwise. */
  version: string | null;
  /** One plain sentence. Always present, because a person always reads one. */
  detail: string;
}

/** Where to ask. Injectable so a test can bind a real server on a free port. */
export interface WebsiteStudioTarget {
  host: string;
  port: number;
  timeoutMs?: number;
}

const NOT_RUNNING =
  'The Website Studio is not running on this computer. Start it, then check again.';

function request(target: WebsiteStudioTarget): Promise<{ status: number; body: string }> {
  const timeout = target.timeoutMs ?? WEBSITE_STUDIO_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.host,
        port: target.port,
        path: '/api/health',
        method: 'GET',
        // The full header set. `Origin` is absent by construction, not by
        // deletion: nothing here adds one.
        headers: { Host: `${target.host}:${target.port}`, Accept: 'application/json' },
        timeout,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        // A studio that answered with a stream of megabytes is still not an
        // answer this route will read: 64 KB is far more than a health line.
        res.on('data', (chunk: string) => {
          if (body.length < 65536) body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Ask the studio whether it is there.
 *
 * Never throws and never reports `reachable` on anything but the exact answer
 * the studio gives: `{ ok: true, studio: 'website' }`. Something else listening
 * on that port is not the Website Studio, and saying it is would send a person
 * to a page that cannot help them.
 */
export async function probeWebsiteStudio(
  target: WebsiteStudioTarget = { host: WEBSITE_STUDIO_HOST, port: WEBSITE_STUDIO_PORT },
): Promise<WebsiteStudioProbe> {
  const url = `http://${target.host}:${target.port}/`;
  try {
    const answer = await request(target);
    if (answer.status !== 200)
      return { reachable: false, url, version: null, detail: NOT_RUNNING };
    const payload = JSON.parse(answer.body) as Record<string, unknown>;
    if (payload.ok !== true || payload.studio !== 'website')
      return {
        reachable: false,
        url,
        version: null,
        detail: 'Something else is using that port on this computer, not the Website Studio.',
      };
    const version = typeof payload.version === 'string' ? payload.version : null;
    return {
      reachable: true,
      url,
      version,
      detail: version
        ? `The Website Studio is running here, version ${version}.`
        : 'The Website Studio is running on this computer.',
    };
  } catch {
    return { reachable: false, url, version: null, detail: NOT_RUNNING };
  }
}
