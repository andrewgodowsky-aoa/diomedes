import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  Conversation,
  MailboxMessage,
  Session,
  Slot,
  TeamMember,
  TeamRun,
} from '../../shared/types';
import type { TeamProps } from './types';
import './team.css';

const KIND_WORDS = new Set([
  'read',
  'wrote',
  'ran',
  'asked',
  'found',
  'sent',
  'opened',
  'changed',
  'checked',
  'start',
  'stop',
]);
const PAGE = 60;
const EASE_ARRIVE = 'cubic-bezier(.16,1,.3,1)';

type LaneClass = 'working' | 'waiting' | 'blocked' | 'idle' | 'stopped';

function laneClassOf(status: TeamMember['status']): LaneClass {
  if (status === 'working') return 'working';
  if (status === 'waiting') return 'waiting';
  if (status === 'error') return 'blocked';
  if (status === 'stopped') return 'stopped';
  return 'idle';
}

const STATE_WORD: Record<LaneClass, string> = {
  working: 'Working',
  waiting: 'Waiting',
  blocked: 'Blocked',
  idle: 'Idle',
  stopped: 'Stopped',
};

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16) || iso;
  return d.toTimeString().slice(0, 5);
}

function fmtLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16) || '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}

function timeOf(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} m`;
  if (m > 0) return `${m} m ${sec} s`;
  return `${sec} s`;
}

function kindOf(sentence: string): { kind: string; detail: string } {
  const m = sentence.match(/^([A-Za-z]+)\b\s*(.*)$/s);
  if (m) {
    const first = m[1].toLowerCase();
    if (KIND_WORDS.has(first)) return { kind: first, detail: (m[2] || '').trim() || sentence };
  }
  return { kind: 'note', detail: sentence };
}

function motionReduced(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced')
    return true;
  return (
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface StreamRow {
  key: string;
  at: number;
  clock: string;
  kind: string;
  detail: string;
  handoffId?: string;
}

function memberName(slots: Map<Slot, string>, slot: Slot): string {
  if (slot === 'owner') return 'Diomedes';
  return slots.get(slot) ?? slot;
}

function buildStream(
  member: TeamMember,
  sessions: Session[],
  mail: MailboxMessage[],
  runs: TeamRun[],
  slots: Map<Slot, string>,
): StreamRow[] {
  const rows: StreamRow[] = [];
  for (const s of sessions) {
    for (let i = 0; i < s.log.length; i++) {
      const line = s.log[i];
      const { kind, detail } = kindOf(line.sentence);
      rows.push({
        key: `log-${s.id}-${i}`,
        at: timeOf(line.time),
        clock: fmtClock(line.time),
        kind,
        detail,
      });
    }
  }
  for (const m of mail) {
    const toucher = m.to === member.slotId || m.from === member.slotId;
    if (!toucher) continue;
    const bothMembers = slots.has(m.from) && slots.has(m.to);
    if (m.type === 'message' && bothMembers) {
      const incoming = m.to === member.slotId;
      rows.push({
        key: `msg-${m.id}`,
        at: timeOf(m.createdAt),
        clock: fmtClock(m.createdAt),
        kind: 'handoff',
        detail: incoming
          ? `from ${memberName(slots, m.from)}`
          : `to ${memberName(slots, m.to)}`,
        handoffId: m.id,
      });
    } else {
      const text = (m.summary ?? m.content ?? '').trim();
      rows.push({
        key: `msg-${m.id}`,
        at: timeOf(m.createdAt),
        clock: fmtClock(m.createdAt),
        kind: 'mail',
        detail: text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text,
      });
    }
  }
  for (const r of runs) {
    rows.push({
      key: `run-${r.id}-start`,
      at: timeOf(r.startedAt),
      clock: fmtClock(r.startedAt),
      kind: 'run',
      detail: 'started',
    });
    if (r.endedAt) {
      rows.push({
        key: `run-${r.id}-end`,
        at: timeOf(r.endedAt),
        clock: fmtClock(r.endedAt),
        kind: 'run',
        detail: 'finished',
      });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

/**
 * The multi-worker view: one lane per member on a shared subgrid, a handoff
 * polyline between the two lanes that last passed responsibility, and one
 * composer that routes through Diomedes.
 */
export function TeamView({
  project,
  state,
  members,
  mail,
  runs,
  focusTaskId,
  busy,
  onMessage,
  onStop,
  onWake,
  onOpenThread,
  onAddMember,
}: TeamProps) {
  const ordered = useMemo(
    () =>
      [...members].sort((a, b) => {
        if (a.role !== b.role) return a.role === 'lead' ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      }),
    [members],
  );
  const slots = useMemo(() => new Map(members.map((m) => [m.slotId, m.name])), [members]);
  const convById = useMemo(
    () => new Map((state.conversations ?? []).map((c) => [c.id, c])),
    [state.conversations],
  );
  const lead = ordered.find((m) => m.role === 'lead') ?? ordered[0] ?? null;
  const leadConv: Conversation | null =
    lead?.threadId != null ? (convById.get(lead.threadId) ?? null) : null;
  const focusTask =
    (focusTaskId ? state.tasks.find((t) => t.id === focusTaskId) : undefined) ??
    (leadConv?.taskId ? state.tasks.find((t) => t.id === leadConv.taskId) : undefined) ??
    null;
  const taskName = focusTask?.name ?? project.name;

  const handoffs = useMemo(
    () =>
      mail
        .filter((m) => m.type === 'message' && slots.has(m.from) && slots.has(m.to))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [mail, slots],
  );
  const latestHandoff = handoffs.at(-1) ?? null;

  // Ticking clock for the working lanes' elapsed readout (10 s cadence).
  const [now, setNow] = useState(() => Date.now());
  const anyWorking = ordered.some((m) => m.status === 'working');
  useEffect(() => {
    if (!anyWorking) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [anyWorking]);

  // Composer state lives here so lane "Message" verbs can select + focus it.
  const [to, setTo] = useState<Slot | 'diomedes'>('diomedes');
  const [text, setText] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const focusComposer = (slot: Slot) => {
    setTo(slot);
    requestAnimationFrame(() => boxRef.current?.focus());
  };

  // Handoff overlay geometry.
  const lanesRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [poly, setPoly] = useState('');
  const prevHandoffId = useRef<string | null>(null);

  const draw = () => {
    const lanesEl = lanesRef.current;
    const svg = svgRef.current;
    if (!lanesEl || !svg) return;
    if (!latestHandoff) {
      svg.innerHTML = '';
      setPoly('');
      return;
    }
    const laneEls = [...lanesEl.querySelectorAll(':scope > .lane')];
    const giverLane = lanesEl.querySelector(`:scope > .lane[data-lane="${latestHandoff.from}"]`);
    const receiverLane = lanesEl.querySelector(`:scope > .lane[data-lane="${latestHandoff.to}"]`);
    const giverRow = giverLane?.querySelector(`[data-handoff="${latestHandoff.id}"]`) ?? null;
    const receiverRow =
      receiverLane?.querySelector(`[data-handoff="${latestHandoff.id}"]`) ?? null;
    if (!giverLane || !receiverLane || !giverRow || !receiverRow) {
      svg.innerHTML = '';
      return;
    }
    const box = lanesEl.getBoundingClientRect();
    if (!box.width) return;
    const gl = (giverLane as Element).getBoundingClientRect();
    const rl = (receiverLane as Element).getBoundingClientRect();
    const gi = laneEls.indexOf(giverLane);
    const ri = laneEls.indexOf(receiverLane);
    const x1 = gl.left - box.left + (gi === 0 ? 4.5 : 9.5);
    const x2 = rl.left - box.left + (ri === 0 ? 4.5 : 9.5);
    const y1 = giverRow.getBoundingClientRect().bottom - box.top + 1;
    const y2 = receiverRow.getBoundingClientRect().bottom - box.top + 1;
    const level = Math.abs(y2 - y1) < 3;
    const points = level ? `${x1},${y1} ${x2},${y1}` : `${x1},${y1} ${x2},${y1} ${x2},${y2}`;
    svg.innerHTML = `<polyline class="live" points="${points}"/>`;
    setPoly(points);
  };

  useEffect(() => {
    draw();
    const onResize = () => requestAnimationFrame(draw);
    window.addEventListener('resize', onResize);
    const lanesEl = lanesRef.current;
    // Stream scrolls move the recorded rows; the thread follows them.
    lanesEl?.addEventListener('scroll', onResize, true);
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    if (fonts) void fonts.ready.then(() => draw());
    return () => {
      window.removeEventListener('resize', onResize);
      lanesEl?.removeEventListener('scroll', onResize, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestHandoff?.id, ordered.length, mail.length, runs.length]);

  // A new member-to-member message while mounted: the record is already in
  // both streams; the traveller only shows where responsibility went.
  useEffect(() => {
    const id = latestHandoff?.id ?? null;
    const prev = prevHandoffId.current;
    prevHandoffId.current = id;
    if (!id || prev === id || prev === null) {
      if (prev === null) prevHandoffId.current = id;
      return;
    }
    if (motionReduced() || !poly || !latestHandoff) return;
    const lanesEl = lanesRef.current;
    if (!lanesEl) return;
    const box = lanesEl.getBoundingClientRect();
    const pts = poly.split(' ').map((p) => p.split(',').map(Number));
    if (pts.some((p) => p.some(Number.isNaN))) return;
    const dot = document.createElement('span');
    dot.className = 'traveller';
    // Inside `.console`, not on the body: team.css scopes `.traveller` to the
    // console root, and a body-level span would never pick the rule up.
    (lanesEl.closest('.console') ?? document.body).append(dot);
    const P = (x: number, y: number) => `translate(${x + box.left}px, ${y + box.top}px)`;
    const frames =
      pts.length === 2
        ? [{ transform: P(pts[0][0], pts[0][1]) }, { transform: P(pts[1][0], pts[1][1]) }]
        : [
            { transform: P(pts[0][0], pts[0][1]) },
            { transform: P(pts[1][0], pts[1][1]), offset: 0.7 },
            { transform: P(pts[2][0], pts[2][1]) },
          ];
    const anim = dot.animate(frames, { duration: 480, easing: EASE_ARRIVE, fill: 'forwards' });
    anim.onfinish = () => {
      dot.remove();
      const pt = lanesEl.querySelector(`[data-pt="${latestHandoff.to}"]`);
      if (pt) {
        pt.classList.remove('landed');
        void (pt as HTMLElement).offsetWidth;
        pt.classList.add('landed');
      }
    };
    anim.oncancel = () => dot.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestHandoff?.id, poly]);

  const send = () => {
    const v = text.trim();
    if (!v || busy) return;
    void onMessage(to, v).then(() => setText(''));
  };

  const handsLabel =
    handoffs.length === 0
      ? '0 handoffs'
      : `${handoffs.length} handoff${handoffs.length === 1 ? '' : 's'}, last ${fmtLong(latestHandoff!.createdAt)} ${memberName(slots, latestHandoff!.from)} to ${memberName(slots, latestHandoff!.to)}`;

  return (
    <div className="team" aria-label="Team">
      <div className="task">
        <span
          className={`pt${anyWorking ? ' live' : ''}`}
          data-focus-point
          aria-hidden="true"
        />
        <h1>{taskName}</h1>
        <span className="mono">
          {ordered.length} lane{ordered.length === 1 ? '' : 's'}
          {lead ? ` · ${lead.name} leads` : ''}
        </span>
        <span className="hands">{handsLabel}</span>
      </div>
      {ordered.length === 0 ? (
        <div className="lane-empty" aria-label="No team yet">
          <p className="caption">No team yet. Add a leader, then members.</p>
          {onAddMember && (
            <button type="button" onClick={onAddMember}>
              Add
            </button>
          )}
        </div>
      ) : (
        <div
          className="lanes"
          ref={lanesRef}
          style={{ ['--lane-count' as string]: String(ordered.length) } as CSSProperties}
        >
          <svg className="handsvg" ref={svgRef} aria-hidden="true" />
          {ordered.map((m) => (
            <Lane
              key={m.slotId}
              member={m}
              state={state}
              convById={convById}
              mail={mail}
              runs={runs}
              slots={slots}
              leadName={lead?.name ?? ''}
              now={now}
              busy={busy}
              onStop={onStop}
              onWake={onWake}
              onOpenThread={onOpenThread}
              onMessageFocus={focusComposer}
            />
          ))}
        </div>
      )}
      <div className="teamcompose">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            ref={boxRef}
            rows={1}
            placeholder="Tell the team"
            aria-label="Tell the team"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="to">
            <span>to</span>
            <select
              aria-label="Recipient"
              value={to}
              onChange={(e) => setTo(e.target.value as Slot | 'diomedes')}
            >
              <option value="diomedes">Diomedes routes it</option>
              {ordered.map((m) => (
                <option key={m.slotId} value={m.slotId}>
                  {m.name}
                </option>
              ))}
            </select>
            <span style={{ marginLeft: 'auto' }}>
              Members talk through the Diomedes team service.
            </span>
          </div>
          <div className="bar">
            <span className="cap" style={{ marginLeft: 6 }}>
              One task, one record; every message lands in the streams above.
            </span>
            <button className={`send${text.trim() ? ' ready' : ''}`} type="submit">
              Send
            </button>
            <span className="hint">Enter</span>
          </div>
        </form>
      </div>
    </div>
  );
}

function Lane({
  member,
  state,
  convById,
  mail,
  runs,
  slots,
  leadName,
  now,
  busy,
  onStop,
  onWake,
  onOpenThread,
  onMessageFocus,
}: {
  member: TeamMember;
  state: TeamProps['state'];
  convById: Map<string, Conversation>;
  mail: MailboxMessage[];
  runs: TeamRun[];
  slots: Map<Slot, string>;
  leadName: string;
  now: number;
  busy: boolean;
  onStop(m: TeamMember): Promise<void>;
  onWake(m: TeamMember): Promise<void>;
  onOpenThread(m: TeamMember): void;
  onMessageFocus(slot: Slot): void;
}) {
  const lane = laneClassOf(member.status);
  const unread = member.unread ?? 0;
  const thread: Conversation | null =
    member.threadId != null ? (convById.get(member.threadId) ?? null) : null;
  const model = member.model ?? thread?.helper?.model ?? 'default';

  const taskSessions = useMemo(
    () =>
      thread?.taskId
        ? state.sessions.filter((s) => s.taskId === thread.taskId)
        : [],
    [state.sessions, thread?.taskId],
  );
  const latestSession = useMemo(
    () =>
      taskSessions.length
        ? [...taskSessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)!
        : null,
    [taskSessions],
  );
  const liveSession = useMemo(
    () =>
      [...taskSessions]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .find((s) => ['queued', 'working', 'waiting'].includes(s.state)) ?? null,
    [taskSessions],
  );
  const ctx = latestSession?.engine.context ?? null;

  const memberMail = useMemo(
    () => mail.filter((m) => m.to === member.slotId || m.from === member.slotId),
    [mail, member.slotId],
  );
  const memberRuns = useMemo(
    () => runs.filter((r) => r.slotId === member.slotId),
    [runs, member.slotId],
  );
  const stream = useMemo(
    () => buildStream(member, taskSessions, mail, memberRuns, slots),
    [member, taskSessions, mail, memberRuns, slots],
  );
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [stream.length]);
  const visible = stream.slice(-shown);
  const earlier = stream.length - visible.length;

  const latestMail = useMemo(
    () =>
      memberMail.length
        ? [...memberMail].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!
        : null,
    [memberMail],
  );

  const ptClass = lane === 'working' ? 'pt live' : lane === 'blocked' ? 'pt attn' : 'pt';
  const liveStream = lane === 'working' || lane === 'waiting' || lane === 'blocked';

  return (
    <div className={`lane ${lane}`} data-lane={member.slotId}>
      <header>
        <span className={ptClass} data-pt={member.slotId} aria-hidden="true" />
        <b>{member.name}</b>
        <span className="role">{member.role === 'lead' ? 'leads' : 'member'}</span>
        <span className="mono">
          {member.engine} · {model}
        </span>
        <span className="state">{STATE_WORD[lane]}</span>
      </header>
      <div className="ctx">
        <span className="bar">
          <i style={{ ['--f' as string]: typeof ctx === 'number' ? ctx / 100 : 0 }} />
        </span>
        <span className="mono">
          {typeof ctx === 'number' ? `context ${ctx}%` : 'context unknown'}
          {unread > 0 ? ` · ${unread} message${unread === 1 ? '' : 's'} waiting` : ''}
        </span>
      </div>
      <Action
        lane={lane}
        member={member}
        leadName={leadName}
        unread={unread}
        liveSession={liveSession}
        latestSession={latestSession}
        now={now}
        onWake={onWake}
        onMessageFocus={onMessageFocus}
      />
      <ol className="ev3">
        {earlier > 0 && (
          <li className="more">
            <button type="button" onClick={() => setShown((n) => n + PAGE)}>
              {earlier} earlier event{earlier === 1 ? '' : 's'}
            </button>
          </li>
        )}
        {visible.map((row, i) => {
          const last = i === visible.length - 1;
          const cls = [last && liveStream ? 'now' : '', row.handoffId ? 'hand' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <li key={row.key} className={cls || undefined} data-handoff={row.handoffId}>
              <b>{row.clock}</b>
              <span className="k">{row.kind}</span>
              <span>{row.detail}</span>
            </li>
          );
        })}
      </ol>
      {latestMail ? (
        <div className="msg">
          <span className="mono">
            {latestMail.from === member.slotId
              ? `to ${memberName(slots, latestMail.to)}`
              : `from ${memberName(slots, latestMail.from)}`}
          </span>
          {latestMail.content}
        </div>
      ) : (
        <div className="msg quiet">No messages yet.</div>
      )}
      <div className="ctl">
        {member.status !== 'stopped' && (
          <button type="button" disabled={busy} onClick={() => void onStop(member)}>
            Stop
          </button>
        )}
        {lane === 'waiting' && unread > 0 && (
          <button type="button" disabled={busy} onClick={() => void onWake(member)}>
            Start
          </button>
        )}
        <button type="button" onClick={() => onMessageFocus(member.slotId)}>
          Message
        </button>
        <button type="button" onClick={() => onOpenThread(member)}>
          Thread
        </button>
      </div>
    </div>
  );
}

function Action({
  lane,
  member,
  leadName,
  unread,
  liveSession,
  latestSession,
  now,
  onWake,
  onMessageFocus,
}: {
  lane: LaneClass;
  member: TeamMember;
  leadName: string;
  unread: number;
  liveSession: Session | null;
  latestSession: Session | null;
  now: number;
  onWake(m: TeamMember): Promise<void>;
  onMessageFocus(slot: Slot): void;
}) {
  if (lane === 'working') {
    const plain = [...(liveSession?.log ?? [])].reverse().find((l) => l.level === 'plain');
    const sentence = plain?.sentence ?? liveSession?.log.at(-1)?.sentence ?? 'Working';
    const elapsed = liveSession ? formatElapsed(now - timeOf(liveSession.startedAt)) : '';
    return (
      <div className="action">
        <span>{sentence}</span>
        <span className="mono">{elapsed}</span>
      </div>
    );
  }
  if (lane === 'waiting') {
    return (
      <div className="action">
        <span>{unread > 0 ? `${unread} message${unread === 1 ? '' : 's'} waiting` : `Waiting for ${leadName}`}</span>
        <span className="mono">WAITING</span>
        {unread > 0 && (
          <span className="acts">
            <button type="button" className="go" onClick={() => void onWake(member)}>
              Start
            </button>
          </span>
        )}
      </div>
    );
  }
  if (lane === 'blocked') {
    const last = latestSession?.log.at(-1)?.sentence ?? liveSession?.log.at(-1)?.sentence ?? 'Blocked';
    return (
      <div className="action">
        <span>{last}</span>
        <span className="mono">blocked</span>
        <span className="acts">
          <button type="button" className="go" onClick={() => void onWake(member)}>
            Start again
          </button>
          <button type="button" onClick={() => onMessageFocus(member.slotId)}>
            Message
          </button>
        </span>
      </div>
    );
  }
  if (lane === 'stopped') {
    return (
      <div className="action quiet">
        <span>Stopped</span>
      </div>
    );
  }
  return (
    <div className="action quiet">
      <span>Nothing assigned</span>
    </div>
  );
}
