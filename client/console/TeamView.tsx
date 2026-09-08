import type { TeamMember } from '../../shared/types';
import type { TeamProps } from './types';

/**
 * Placeholder team view: the member roster with Thread/Start/Stop wired to
 * the Shell callbacks. The full lane view arrives in a later pass.
 */
export function TeamView({ members, busy, onStop, onWake, onOpenThread }: TeamProps) {
  if (!members.length) {
    return (
      <div className="col team-placeholder" aria-label="Team">
        <p className="caption">No team yet. The full lane view arrives in the next pass.</p>
      </div>
    );
  }
  return (
    <div className="col team-placeholder" aria-label="Team">
      {members.map((m) => (
        <MemberRow
          key={m.slotId}
          member={m}
          busy={busy}
          onStop={onStop}
          onWake={onWake}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}

function MemberRow({
  member,
  busy,
  onStop,
  onWake,
  onOpenThread,
}: {
  member: TeamMember;
  busy: boolean;
  onStop(m: TeamMember): Promise<void>;
  onWake(m: TeamMember): Promise<void>;
  onOpenThread(m: TeamMember): void;
}) {
  return (
    <div className="team-row">
      <span>
        {member.name} ({member.role}, {member.engine}
        {member.model ? `, ${member.model}` : ''}) — {member.status}
      </span>
      <span className="actions">
        {member.threadId && (
          <button type="button" onClick={() => onOpenThread(member)}>
            Thread
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void onWake(member)}>
          Start
        </button>
        <button type="button" disabled={busy} onClick={() => void onStop(member)}>
          Stop
        </button>
      </span>
    </div>
  );
}
