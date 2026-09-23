/**
 * One public web page, read for an Ask or Plan turn on a model-API route.
 *
 * GET only, no credentials, no cookies. Every address a host name resolves to
 * must be public: loopback, private, link-local, carrier-grade NAT, multicast,
 * documentation and reserved ranges are refused, and so is an IPv6 form that
 * embeds an IPv4 address (mapped, NAT64, 6to4, Teredo). The connection is
 * pinned to the addresses that passed the check, so the name is not resolved a
 * second time between the check and the connect. Each redirect is a new URL and
 * is checked the same way, at most three times. The body is read up to a byte
 * cap within a time limit, only for a text content type, and reduced to text.
 *
 * Nothing here decides whether a turn may use the web; the host's `ReadScope`
 * does, and the tool is only registered when it allows it.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export interface VettedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it names. */
export type PageResolve = (host: string, signal: AbortSignal) => Promise<VettedAddress[]>;

export interface PageAnswer {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Stops reading and closes the connection. */
  cancel(): void;
}

/** One GET to a URL whose host already passed the check, connecting only to `addresses`. */
export type PageRequest = (input: {
  url: URL;
  addresses: readonly VettedAddress[];
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<PageAnswer>;

export interface PageFetchOptions {
  signal: AbortSignal;
  resolve?: PageResolve;
  request?: PageRequest;
  /** Bytes read from the body at most. */
  maxBytes?: number;
  /** Characters of extracted text returned at most. */
  maxChars?: number;
  timeoutMs?: number;
}

export type PageResult =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      status: number;
      contentType: string;
      title: string | null;
      text: string;
      truncated: boolean;
    }
  | { ok: false; url: string; reason: string };

export class PageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRefused';
  }
}

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const TEXT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'application/xml',
  'application/json',
  'application/ld+json',
];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const blockedV4 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(prefix, bits, 'ipv4');

const blockedV6 = new net.BlockList();
for (const [prefix, bits] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible block
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const)
  blockedV6.addSubnet(prefix, bits, 'ipv6');

/** Whether an address is one a page fetch may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return !blockedV6.check(address, 'ipv6');
  return false;
}

const bareHost = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** The URL rules that need no network: scheme, credentials and obviously local names. */
export function checkPageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PageRefused('That is not a complete web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new PageRefused('Only http and https pages can be opened.');
  if (url.username || url.password) throw new PageRefused('A web address with a user name or password is not opened.');
  const host = bareHost(url.hostname);
  if (
    !host ||
    host === 'localhost' ||
    /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host) ||
    (!net.isIP(host) && !host.includes('.'))
  )
    throw new PageRefused('That address names this computer or a private network, which is never opened.');
  if (net.isIP(host) && !isPublicAddress(host))
    throw new PageRefused('That address is on this computer or a private network, which is never opened.');
  url.hash = '';
  return url;
}

const systemResolve: PageResolve = async (host, signal) => {
  signal.throwIfAborted();
  const found = await dns.promises.lookup(host, { all: true, verbatim: true });
  signal.throwIfAborted();
  return found.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

/** Every address the host resolves to, each public, or a refusal. An IP literal is its own answer. */
async function vetHost(url: URL, resolve: PageResolve, signal: AbortSignal): Promise<VettedAddress[]> {
  const host = bareHost(url.hostname);
  const literal = net.isIP(host);
  if (literal) return [{ address: host, family: literal === 6 ? 6 : 4 }];
  let addresses: VettedAddress[];
  try {
    addresses = await resolve(host, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PageRefused(`${host} could not be found.`);
  }
  if (!addresses.length) throw new PageRefused(`${host} could not be found.`);
  if (addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new PageRefused(`${host} points at this computer or a private network, which is never opened.`);
  return addresses;
}

/**
 * The default transport: Node's own http and https with a lookup that answers
 * only with the vetted addresses, so the connect cannot reach anything else.
 */
export const pinnedRequest: PageRequest = ({ url, addresses, headers, signal }) =>
  new Promise((resolve, reject) => {
    const lookup = ((
      _hostname: string,
      options: { all?: boolean } | number | undefined,
      callback: (error: Error | null, address: unknown, family?: number) => void,
    ) => {
      const all = typeof options === 'object' && options?.all;
      if (all) callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
      else callback(null, addresses[0].address, addresses[0].family);
    }) as unknown as net.LookupFunction;
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, { method: 'GET', headers, signal, lookup, agent: false }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]),
        ),
        body: response,
        cancel: () => response.destroy(),
      });
    });
    request.on('error', reject);
    request.end();
  });

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

/** Readable text from an HTML document: no scripts, styles or markup. */
export function htmlText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) || null : null;
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

async function readBody(answer: PageAnswer, maxBytes: number, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of answer.body) {
    signal.throwIfAborted();
    const piece = Buffer.from(chunk);
    if (size + piece.byteLength > maxBytes) {
      chunks.push(piece.subarray(0, maxBytes - size));
      truncated = true;
      break;
    }
    chunks.push(piece);
    size += piece.byteLength;
  }
  answer.cancel();
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated };
}

/**
 * Opens one page. A refusal (a private address, a non-text page, too many
 * redirects) is a result the model reads, never an exception; a stop or the
 * time limit is an abort and propagates.
 */
export async function fetchPage(value: string, options: PageFetchOptions): Promise<PageResult> {
  const resolve = options.resolve ?? systemResolve;
  const request = options.request ?? pinnedRequest;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
  options.signal.throwIfAborted();
  let url: URL;
  try {
    url = checkPageUrl(value);
  } catch (error) {
    if (error instanceof PageRefused) return { ok: false, url: value, reason: error.message };
    throw error;
  }
  try {
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const addresses = await vetHost(url, resolve, signal);
      const answer = await request({
        url,
        addresses,
        signal,
        headers: {
          accept: 'text/html, text/plain;q=0.9, application/json;q=0.8, */*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'Diomedes-ReadOnly/1 (a page opened to answer a question)',
        },
      });
      if (REDIRECTS.has(answer.status)) {
        answer.cancel();
        const location = answer.headers.location;
        if (!location) throw new PageRefused('The page redirected without saying where.');
        if (hop >= MAX_REDIRECTS) throw new PageRefused('The page redirected too many times.');
        url = checkPageUrl(new URL(location, url).toString());
        continue;
      }
      const contentType = (answer.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!TEXT_TYPES.includes(contentType)) {
        answer.cancel();
        throw new PageRefused(`The page is not text (${contentType || 'no content type'}), so it was not read.`);
      }
      const body = await readBody(answer, maxBytes, signal);
      const html = contentType === 'text/html' || contentType === 'application/xhtml+xml';
      const extracted = html ? htmlText(body.text) : { title: null, text: body.text.trim() };
      const clipped = extracted.text.length > maxChars;
      return {
        ok: true,
        url: value,
        finalUrl: url.toString(),
        status: answer.status,
        contentType,
        title: extracted.title,
        text: clipped ? extracted.text.slice(0, maxChars) : extracted.text,
        truncated: body.truncated || clipped,
      };
    }
  } catch (error) {
    if (error instanceof PageRefused) return { ok: false, url: value, reason: error.message };
    // The person's stop ends the turn; the page's own time limit is only this page's failure.
    if (options.signal.aborted) throw options.signal.reason ?? error;
    if (signal.aborted) return { ok: false, url: value, reason: 'The page did not answer in time.' };
    return { ok: false, url: value, reason: 'The page could not be opened.' };
  }
}
