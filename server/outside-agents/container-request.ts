/**
 * OA2: the operating-system box an outside agent runs in.
 *
 * A paid person can bring their own signed-in agent (Claude Code, Codex) and
 * still work through Nectovia's tools. The agent's own tools are switched off
 * by its flags, but flags are the agent's promise, not ours; this request is
 * what the operating system holds it to (Windows process containers through
 * the MXC SDK, qualified on 26200 on 2026-10-09).
 *
 * `containerRequest` turns a plan into the one request shape this host sends
 * and refuses, with a stable code, anything that would widen the box:
 *
 * - One read-write folder: the run's own root. The agent's home, config,
 *   temp and work folders all live under it, so its sign-in and settings are
 *   per run. The person's real profile, and the agent homes inside it
 *   (`.claude`, `.codex` and the like), are never granted, even read-only: an
 *   agent that can write its own settings can install a hook that runs outside
 *   any flag, and the real homes hold long-lived credentials.
 * - Read-only: the agent's install folder and any folder the plan names.
 * - Network: nothing in, nothing to the host's loopback, and out only to the
 *   named host addresses and ports. A hostname rule needs a proxy this build
 *   cannot contain yet, so only single addresses are accepted.
 * - The window station is granted because user32 will not start without one
 *   (0xC0000142); the clipboard and input injection are not.
 * - The environment is built here, whole. The SDK's default environment is the
 *   Windows user's registry block, which carries every user-level secret, so
 *   it is never inherited. The one sign-in variable is passed by name from an
 *   allow-list; any other secret-looking or route-changing name is refused.
 * - Only a `.exe` starts: a `.cmd` or `.bat` would go through `cmd.exe`, which
 *   re-reads the command line.
 * - A denial report (what the box refused, written into the run's folder) is
 *   asked for only when the plan says so. The box refuses the same things
 *   without it; see `launchContained` for why a streaming run does not ask.
 */
import path from 'node:path';
import { HarnessError } from '../harness/policy.js';

export type OutsideAgentCode =
  | 'containment_refused'
  | 'containment_unavailable'
  | 'admission_expired'
  | 'tool_unknown'
  | 'protocol_refused';

export const refuseOutside = (code: OutsideAgentCode, message: string) => new HarnessError(code, message);

/** Credentials an agent signs in with, by variable name. Nothing else that looks like a secret is passed. */
export const SIGN_IN_VARIABLES = ['CLAUDE_CODE_OAUTH_TOKEN'] as const;
export type SignInVariable = (typeof SIGN_IN_VARIABLES)[number];

/** The agent homes inside a person's profile that a contained run never sees. */
export const AGENT_HOMES = ['.claude', '.claude.json', '.codex', '.config', '.opencode', '.cursor', '.gemini'] as const;

// Mirrors the H12 spawn rule (`containment.ts`), plus names that would move an agent's route or code.
const SECRETISH = /(TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE|AUTH|COOKIE|SESSION|(^|_)KEYS?(_|$))/i;
const ROUTE_CHANGING = /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|SSL_CERT_|ELECTRON_)/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface EgressRule {
  /** One host address: an IPv4 `/32` or IPv6 `/128`. */
  readonly cidr: string;
  readonly port: number;
}

export interface ContainedAgentPlan {
  /** The agent's own installed `.exe`. Its folder is granted read-only. */
  readonly executable: string;
  readonly args: readonly string[];
  /** This run's own folder, and the only read-write grant. */
  readonly runRoot: string;
  /** The person's real profile folder. Checked against every grant, never granted. */
  readonly profile: string;
  /** `%SystemRoot%`, for the environment Windows needs to start a process. */
  readonly systemRoot: string;
  readonly readonly?: readonly string[];
  readonly egress: readonly EgressRule[];
  /** Ordinary settings the agent reads from its environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly signIn?: { readonly name: SignInVariable; readonly value: string };
  readonly timeoutMs: number;
  /** Ask the box to record what it refused. Off unless set. */
  readonly denialReport?: boolean;
}

/** Where a run's folders are, all under its root. The launcher makes them before the request is sent. */
export function runLayout(runRoot: string) {
  const home = path.join(runRoot, 'home');
  return {
    root: runRoot,
    home,
    local: path.join(home, 'AppData', 'Local'),
    roaming: path.join(home, 'AppData', 'Roaming'),
    temp: path.join(runRoot, 'tmp'),
    work: path.join(runRoot, 'work'),
    denials: path.join(runRoot, 'denials.json'),
  };
}

/** The request this host sends to the MXC SDK's `spawn` (a subset of its v1 `ContainerRequest`). */
export interface ContainerRequest {
  command: string;
  filesystem: { readwritePaths: string[]; readonlyPaths: string[] };
  network: {
    egress: { default: 'deny'; allow?: { to: { cidr: string }[]; ports: { protocol: 'tcp'; port: number }[] }[] };
    ingress: { default: 'deny'; hostLoopback: 'deny' };
  };
  ui: { disable: false; clipboard: 'none'; allowInputInjection: false };
  containment?: { type: 'processcontainer'; config: { captureDenials: { mode: 'block'; outputPath: string } } };
  environment: Record<string, string>;
  inheritDefaultEnvironment: false;
  workingDirectory: string;
  timeoutMs: number;
}

const refused = (message: string) => refuseOutside('containment_refused', message);
const key = (value: string) => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
/** Whether `inner` is `outer` or under it, compared the way Windows compares paths. */
const within = (inner: string, outer: string) => {
  const a = key(inner);
  const b = key(outer);
  return a === b || a.startsWith(`${b}\\`);
};

function absolute(value: string, what: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.win32.isAbsolute(value) || value.startsWith('\\\\'))
    throw refused(`${what} must be a local absolute path.`);
  // Judged as spelled: normalising first would fold a climb away before it is seen.
  if (value.split(/[\\/]/).includes('..')) throw refused(`${what} must not climb.`);
  const normal = path.win32.normalize(value);
  if (/^[A-Za-z]:\\?$/.test(normal)) throw refused(`${what} cannot be a drive root.`);
  return normal.replace(/[\\/]+$/, '');
}

/** Refuse a grant that is, holds or sits inside the person's profile or one of the agent homes in it. */
function checkGrant(grant: string, plan: ContainedAgentPlan, kind: 'read-write' | 'read-only') {
  if (within(plan.profile, grant)) throw refused(`A ${kind} grant cannot hold the person's profile.`);
  for (const home of AGENT_HOMES)
    if (within(grant, path.win32.join(plan.profile, home)))
      throw refused(`A ${kind} grant cannot reach the person's own agent settings (${home}).`);
  if (kind === 'read-write' && within(grant, plan.systemRoot)) throw refused('A read-write grant cannot reach the Windows folder.');
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
function checkEgress(rule: EgressRule) {
  const [address, bits, extra] = String(rule.cidr).split('/');
  const v4 = IPV4.test(address ?? '');
  const v6 = !v4 && /^[0-9a-f:]+$/i.test(address ?? '') && (address ?? '').includes(':');
  if (extra !== undefined || (!v4 && !v6) || bits !== (v4 ? '32' : '128'))
    throw refused(`Egress is granted to single host addresses only, not ${rule.cidr}.`);
  if ((v4 && /^(0|127|169\.254)\./.test(address!)) || (v6 && /^(::1?|fe80:)/i.test(address!)))
    throw refused(`Egress cannot be granted to a local address (${rule.cidr}).`);
  if (!Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535) throw refused(`Port ${rule.port} is not a port.`);
}

/** One Windows argument, quoted the way `CommandLineToArgvW` reads it back. */
export function windowsArgument(value: string): string {
  if (value.includes('\0') || /[\r\n]/.test(value)) throw refused('An argument cannot hold a NUL or a line break.');
  if (value && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === '\\') {
      slashes += 1;
      continue;
    }
    out += char === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + char;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** The MXC request for a plan, or a `containment_refused` naming the first rule it breaks. */
export function containerRequest(plan: ContainedAgentPlan): ContainerRequest {
  const executable = absolute(plan.executable, 'The agent');
  if (!/\.exe$/i.test(executable)) throw refused('Only an installed .exe can be started in the box.');
  const runRoot = absolute(plan.runRoot, 'The run folder');
  absolute(plan.profile, 'The profile');
  const systemRoot = absolute(plan.systemRoot, 'The Windows folder');
  checkGrant(runRoot, plan, 'read-write');
  const readonly = [path.win32.dirname(executable), ...(plan.readonly ?? []).map((item) => absolute(item, 'A read-only folder'))];
  for (const grant of readonly) checkGrant(grant, plan, 'read-only');
  for (const rule of plan.egress) checkEgress(rule);
  if (!Number.isInteger(plan.timeoutMs) || plan.timeoutMs < 1000 || plan.timeoutMs > 6 * 60 * 60 * 1000)
    throw refused('A contained run needs a timeout between one second and six hours.');

  const layout = runLayout(runRoot);
  const system32 = path.win32.join(systemRoot, 'System32');
  // Presence of SystemRoot and LOCALAPPDATA is what Windows needs; everything here points inside the run.
  const base: Record<string, string> = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    SystemDrive: systemRoot.slice(0, 2),
    ComSpec: path.win32.join(system32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE',
    Path: [path.win32.dirname(executable), system32, systemRoot].join(';'),
    USERPROFILE: layout.home,
    HOME: layout.home,
    LOCALAPPDATA: layout.local,
    APPDATA: layout.roaming,
    TEMP: layout.temp,
    TMP: layout.temp,
  };
  const environment: Record<string, string> = { ...base };
  const taken = new Set(Object.keys(base).map((name) => name.toUpperCase()));
  for (const [name, value] of Object.entries(plan.env ?? {})) {
    if (!NAME.test(name) || typeof value !== 'string' || value.includes('\0'))
      throw refused(`The variable ${name} cannot be passed to the box.`);
    if (taken.has(name.toUpperCase())) throw refused(`The variable ${name} is set by the box itself.`);
    if (SECRETISH.test(name) || ROUTE_CHANGING.test(name))
      throw refused(`The variable ${name} looks like a credential or a route change, so it is not passed.`);
    taken.add(name.toUpperCase());
    environment[name] = value;
  }
  if (plan.signIn) {
    if (!(SIGN_IN_VARIABLES as readonly string[]).includes(plan.signIn.name))
      throw refused(`${plan.signIn.name} is not a sign-in this box accepts.`);
    if (typeof plan.signIn.value !== 'string' || !plan.signIn.value || /[\0\r\n]/.test(plan.signIn.value))
      throw refused('The sign-in is empty or malformed.');
    environment[plan.signIn.name] = plan.signIn.value;
  }

  return {
    command: [executable, ...plan.args].map(windowsArgument).join(' '),
    filesystem: { readwritePaths: [runRoot], readonlyPaths: [...new Set(readonly)] },
    network: {
      egress: {
        default: 'deny',
        ...(plan.egress.length
          ? { allow: plan.egress.map((rule) => ({ to: [{ cidr: rule.cidr }], ports: [{ protocol: 'tcp' as const, port: rule.port }] })) }
          : {}),
      },
      ingress: { default: 'deny', hostLoopback: 'deny' },
    },
    ui: { disable: false, clipboard: 'none', allowInputInjection: false },
    ...(plan.denialReport
      ? { containment: { type: 'processcontainer' as const, config: { captureDenials: { mode: 'block' as const, outputPath: layout.denials } } } }
      : {}),
    environment,
    inheritDefaultEnvironment: false,
    workingDirectory: layout.work,
    timeoutMs: plan.timeoutMs,
  };
}
