import type { Need, Session, Turn } from './types.js';

/** Captured from host/runtime metadata, never from generated prose or a current picker. */
export interface OriginSnapshot {
  readonly protocolVersion: 1;
  readonly mode: 'direct' | 'supervisor' | 'application';
  readonly engine: { readonly id: string; readonly version: string | null } | null;
  readonly model: {
    readonly requested: string | null;
    readonly reported: string | null;
    readonly source: 'runtime' | 'not-recorded';
  };
  readonly worker?: { readonly id: string; readonly name: string };
  readonly producerId?: string;
  readonly executorId?: string;
  readonly accountRoute?: string | null;
}
const names: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  'oh-my-pi': 'oh-my-pi',
  hermes: 'Hermes',
  sample: 'Sample',
};
/** React escapes markup at render time. Strip terminal/bidi controls and cap machine names here. */
export function displayName(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .trim()
    .slice(0, 160);
}
export function directOrigin(input: {
  engine: string;
  requestedModel?: string | null;
  reportedModel?: string | null;
  version?: string | null;
  worker?: OriginSnapshot['worker'];
  producerId?: string;
  executorId?: string;
  accountRoute?: string | null;
}): OriginSnapshot {
  return {
    protocolVersion: 1,
    mode: 'direct',
    engine: { id: input.engine, version: input.version ?? null },
    model: {
      requested: input.requestedModel ?? null,
      reported: input.reportedModel ?? null,
      source: input.reportedModel ? 'runtime' : 'not-recorded',
    },
    ...(input.worker ? { worker: { ...input.worker } } : {}),
    ...(input.producerId ? { producerId: input.producerId } : {}),
    ...(input.executorId ? { executorId: input.executorId } : {}),
    ...(input.accountRoute ? { accountRoute: input.accountRoute } : {}),
  };
}
export function applicationOrigin(): OriginSnapshot {
  return {
    protocolVersion: 1,
    mode: 'application',
    engine: null,
    model: { requested: null, reported: null, source: 'not-recorded' },
    executorId: 'diomedes:recorded-writer',
  };
}
export function originForTurn(turn: Turn): OriginSnapshot | undefined {
  if (turn.origin) return turn.origin;
  if (turn.route === 'sample') return applicationOrigin();
  if (turn.helper)
    return directOrigin({
      engine: turn.helper.engine,
      reportedModel: turn.helper.verified ? turn.helper.model : null,
      version: turn.helper.version,
    });
  if (turn.route) return directOrigin({ engine: turn.route });
  return undefined;
}
export function originForSession(session: Session): OriginSnapshot | undefined {
  if (session.origin) return session.origin;
  if (session.sample) return applicationOrigin();
  // Legacy harness metadata does not prove a native supervisor; do not invent one.
  const engine =
    session.route ??
    (session.engine.name.toLowerCase().startsWith('codex,') ? 'codex' : session.engine.name);
  return engine
    ? directOrigin({
        engine,
        reportedModel: session.engine.verified ? session.engine.model : null,
        version: session.engine.version,
      })
    : undefined;
}
export function originForNeed(need: Need, session?: Session): OriginSnapshot | undefined {
  return need.origin ?? (session ? originForSession(session) : undefined);
}
export function formatOrigin(
  origin?: OriginSnapshot,
  legacy?: { engine?: string; model?: string | null; verified?: boolean; application?: boolean },
) {
  const snapshot =
    origin ??
    (legacy?.application
      ? applicationOrigin()
      : legacy?.engine
        ? directOrigin({
            engine: legacy.engine,
            reportedModel: legacy.verified ? legacy.model : null,
          })
        : undefined);
  const engineId = displayName(snapshot?.engine?.id);
  const engine = names[engineId] ?? engineId;
  const reported = snapshot?.model.source === 'runtime' ? displayName(snapshot.model.reported) : '';
  const primary =
    snapshot?.mode === 'application' || snapshot?.mode === 'supervisor'
      ? 'Diomedes'
      : reported || engine || 'Assistant';
  const secondary =
    snapshot?.mode === 'application'
      ? 'application action'
      : snapshot?.mode === 'supervisor'
        ? reported
          ? `${reported}${engine ? ` via ${engine}` : ''}`
          : 'native supervisor'
        : reported && engine
          ? `via ${engine}`
          : 'model not recorded';
  const detail =
    snapshot?.mode === 'application'
      ? 'Diomedes application action; no model authorship implied.'
      : snapshot?.mode === 'supervisor'
        ? 'Diomedes native supervisor operation.'
        : reported
          ? 'Model identity reported by the runtime.'
          : 'The model identity was not recorded by the runtime.';
  return {
    primary,
    secondary,
    detail,
    actor: primary,
    label: `${primary}${secondary ? ` ${secondary}` : ''}`,
  };
}
