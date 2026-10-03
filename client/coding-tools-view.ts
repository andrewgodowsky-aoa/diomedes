/**
 * Settings' "Your coding tools" (subscription-aware orchestration S3) as plain data: whether the
 * section is offered, what the person's saved choice shows, what a change saves and the order of
 * their tools. The server checks every save; nothing here decides what it accepts.
 */
import type {
  SubscriptionReserve,
  SubscriptionWorkersView,
  SubscriptionWorkersWrite,
  WhenUnavailable,
} from '../shared/subscription-workers';
import type { ExternalWorkerRoute } from '../shared/team-delegation';

export const CODING_TOOLS_SECTION = 'Your coding tools';

/** The share of each tool's limit the reserve offers to keep until the person types another. */
export const DEFAULT_KEEP_PERCENT = 20;

/** The section is offered only when this build offers the feature; a failed or missing read is no offer. */
export function codingToolsOffered(view: SubscriptionWorkersView | null | undefined): boolean {
  return view?.available === true;
}

export interface CodingToolsForm {
  /** On as saved, under the consent text shown now. A choice saved under an older text shows off. */
  readonly on: boolean;
  /** Every tool, first choice at the top. */
  readonly order: readonly ExternalWorkerRoute[];
  /** The tools a task may go to. Their order is their place in `order`. */
  readonly chosen: readonly ExternalWorkerRoute[];
  readonly reserve: SubscriptionReserve;
  readonly whenUnavailable: WhenUnavailable;
}

/** Saved on under an older consent text: the person reads the new one and confirms before it's on again. */
export function consentChanged(view: SubscriptionWorkersView): boolean {
  return view.preference?.enabled === true && view.preference.consentRevision !== view.consent.revision;
}

/**
 * The controls as the view has them saved. Given an order (the one on screen when a save
 * answered), the tools keep their places; otherwise the saved tools lead in the person's order
 * and the rest follow in the server's. With nothing saved it's off, with no tools, no reserve and
 * Nectovia doing the task itself when no tool can.
 */
export function codingToolsForm(view: SubscriptionWorkersView, order?: readonly ExternalWorkerRoute[]): CodingToolsForm {
  const known = view.tools.map((tool) => tool.route);
  const saved = view.preference;
  const chosen = (saved?.engines ?? []).filter((route) => known.includes(route));
  const lead = (order ?? chosen).filter((route) => known.includes(route));
  return {
    on: saved?.enabled === true && saved.consentRevision === view.consent.revision,
    order: [...lead, ...known.filter((route) => !lead.includes(route))],
    chosen,
    reserve: saved?.reserve ?? { kind: 'none' },
    whenUnavailable: saved?.whenUnavailable ?? 'single-agent',
  };
}

/**
 * What a change saves. On is saved under the consent text shown now. The write names a revision
 * even while off, though nothing reads one from a choice that's off: it keeps the saved one, or
 * names the text shown when nothing is saved yet.
 */
export function codingToolsWrite(form: CodingToolsForm, view: SubscriptionWorkersView): SubscriptionWorkersWrite {
  return {
    enabled: form.on,
    engines: form.order.filter((route) => form.chosen.includes(route)),
    reserve: form.reserve,
    whenUnavailable: form.whenUnavailable,
    consentRevision: form.on ? view.consent.revision : (view.preference?.consentRevision ?? view.consent.revision),
  };
}

/** The form with one tool ticked or unticked. It keeps its place in the order either way. */
export function chooseTool(form: CodingToolsForm, route: ExternalWorkerRoute, on: boolean): CodingToolsForm {
  const others = form.chosen.filter((item) => item !== route);
  return { ...form, chosen: on ? [...others, route] : others };
}

/** The order with one tool moved a place up (-1) or down (1). At either end it stays put. */
export function moveTool(
  order: readonly ExternalWorkerRoute[],
  route: ExternalWorkerRoute,
  by: -1 | 1,
): ExternalWorkerRoute[] {
  const next = [...order];
  const from = next.indexOf(route);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The share typed for the reserve when it's a whole number from 1 to 90, else null. */
export function keepPercent(text: string): number | null {
  const typed = text.trim();
  if (!/^\d{1,2}$/.test(typed)) return null;
  const value = Number(typed);
  return value >= 1 && value <= 90 ? value : null;
}
