/**
 * Moving a card on the Board is a request to change the work, never a way to set its state.
 *
 * This table is the one answer to "what does this move ask for?". The drag, the card's Move
 * menu and the task inspector's own buttons all read it, so no gesture has a route that the
 * Start, Stop and Reopen buttons do not. It maps a move to one of the commands the Board
 * already sends (Start through the Work start admission, Stop through the task scope, Reopen
 * and Mark done through the task route), or to a refusal in plain words.
 *
 * Pure: it reads the column the task is projected into (client/workbench/task-evidence.ts)
 * and the few facts that decide a move. It admits nothing and it moves nothing. The command
 * still goes through its own route, which can still refuse, and the card moves only when the
 * records say it did. A refusal leaves the card where it is.
 *
 * Three moves are deliberately not chained:
 * - Working to Ready is a Stop and nothing more. A stopped task is not started again on its
 *   own (shared/ready-queue.ts `readyAt`), so no replacement run can start while the old one
 *   might still be finishing. Starting it again is a second, explicit move.
 * - Nothing is moved into Review or Blocked by hand. A run lands there when it has something
 *   for the person, and a card cannot claim that it does.
 * - Done needs a settled task: no active run, no open decision and no waiting changes. The
 *   projection shows Review first while any of those remain, so a Done the task route
 *   accepted would still read as Review.
 */

export const BOARD_COLUMNS = ['Ready', 'Queued', 'Working', 'Review', 'Blocked', 'Done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** The commands a move can ask for. Each one is a route the Board already calls. */
export type BoardCommand = 'start' | 'stop' | 'reopen' | 'done';

export interface BoardMoveFacts {
  /** The column the task is projected into now. */
  from: BoardColumn;
  /** One of this task's runs is queued, working or waiting. */
  active: boolean;
  /** A run of any task holds the project's one work slot. */
  slotBusy: boolean;
  /** The task has a decision waiting on the person. */
  openNeed: boolean;
  /** Changes this task made are waiting to be kept or undone. */
  changesWaiting: boolean;
  /** The task's latest run failed and nothing is active: the Blocked row's Start again. */
  failed: boolean;
  /** Automatic start is on and not paused here, so a task put back in Ready may start on its own. */
  autoStart: boolean;
}

export type BoardMove =
  /** Dropped where it already is. Nothing is sent. */
  | { kind: 'none' }
  | {
      kind: 'command';
      command: BoardCommand;
      /** The button or menu label for this move. */
      label: string;
      /** What the card says while the command is under way. */
      pending: string;
      /**
       * A sentence the person confirms before a dragged or menu move is sent, or null when
       * nothing needs asking: Start keeps the Board's own confirmation setting and the send
       * dialog, and a Reopen asks only when automatic start could run the task straight away.
       * The card's own buttons keep their existing behaviour.
       */
      confirm: string | null;
    }
  | { kind: 'refused'; reason: string };

const REVIEW_BY_HAND =
  'A run moves to Review when it has something for you to decide. Moving the card does not finish the run.';
const BLOCKED_BY_HAND =
  'A card moves to Blocked when its run needs an answer or a route. It cannot be moved there by hand.';
const ONE_SLOT = 'One run at a time in this version. Another task is running.';

const start = (label: string): BoardMove => ({
  kind: 'command',
  command: 'start',
  label,
  pending: 'Starting…',
  confirm: null,
});

/** Why this task cannot be settled yet, or null when nothing holds it open. */
function unsettled(facts: BoardMoveFacts): string | null {
  if (facts.openNeed) return 'Answer the open decision first.';
  if (facts.changesWaiting) return 'Keep or undo the waiting changes first.';
  return null;
}

/**
 * A task put back in Ready asks first only when automatic start could run it straight away.
 * Otherwise it waits in Ready for the person, exactly as the card's own Reopen leaves it.
 */
function reopenSentence(facts: BoardMoveFacts): string | null {
  return facts.autoStart
    ? 'Put this task back in Ready? Automatic start is on here, so it may start again on its own. Its earlier runs and results stay in its record.'
    : null;
}

/**
 * The move a drop into `to` asks for. Queued and Working are one target: a card dropped on
 * either asks for a start, and the task shows Queued until a worker actually picks it up.
 */
export function boardMove(to: BoardColumn, facts: BoardMoveFacts): BoardMove {
  const { from } = facts;
  if (to === from) return { kind: 'none' };
  if (to === 'Review') return { kind: 'refused', reason: REVIEW_BY_HAND };
  if (to === 'Blocked') return { kind: 'refused', reason: BLOCKED_BY_HAND };

  if (to === 'Queued' || to === 'Working') {
    if (from === 'Queued' || from === 'Working')
      return {
        kind: 'refused',
        reason: 'It is already admitted. It shows Working once its run has started.',
      };
    if (facts.active)
      return { kind: 'refused', reason: 'It has a run waiting on you. Open it to see what it needs.' };
    if (from === 'Ready') return facts.slotBusy ? { kind: 'refused', reason: ONE_SLOT } : start('Start');
    if (from === 'Blocked' && facts.failed)
      return facts.slotBusy ? { kind: 'refused', reason: ONE_SLOT } : start('Start again');
    if (from === 'Review') return { kind: 'refused', reason: unsettled(facts) ?? 'Review what it made first.' };
    if (from === 'Done') return { kind: 'refused', reason: 'Move it back to Ready first, then start it.' };
    return { kind: 'refused', reason: 'Move it to Ready first, then start it.' };
  }

  if (to === 'Ready') {
    if (facts.active) {
      // Review with a live run means its changes or a decision are waiting: the person decides
      // those, and Stop stays on the card for ending the run instead.
      if (from === 'Review')
        return {
          kind: 'refused',
          reason: `${unsettled(facts) ?? 'Review what it made first.'} Stop is on the card if you want to end the run.`,
        };
      return {
        kind: 'command',
        command: 'stop',
        label: 'Stop',
        pending: 'Stopping…',
        confirm:
          'Stop this run? The task goes back to Ready and waits for you. Nothing starts in its place.',
      };
    }
    const held = unsettled(facts);
    if (held) return { kind: 'refused', reason: held };
    return {
      kind: 'command',
      command: 'reopen',
      label: from === 'Done' ? 'Reopen' : 'Move to Ready',
      pending: 'Moving…',
      confirm: reopenSentence(facts),
    };
  }

  // to === 'Done'
  if (facts.active) return { kind: 'refused', reason: 'Stop the run first, or let it finish.' };
  const held = unsettled(facts);
  if (held) return { kind: 'refused', reason: held };
  return {
    kind: 'command',
    command: 'done',
    label: 'Mark done',
    pending: 'Marking done…',
    confirm: 'Mark this task done? This records that you finished it; it does not run any check.',
  };
}

/** Every other column with what a move there would ask for, for the card's Move menu. */
export function boardMoveMenu(facts: BoardMoveFacts): { to: BoardColumn; move: BoardMove }[] {
  return BOARD_COLUMNS.filter((column) => column !== facts.from && column !== 'Queued').map(
    (to) => ({ to, move: boardMove(to, facts) }),
  );
}
