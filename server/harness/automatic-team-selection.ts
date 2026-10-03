import type { AutomaticWorkRequest } from '../../shared/automatic-work.js';
import type { AutomaticTeamCandidate, AutomaticTeamDecision } from '../../shared/automatic-team.js';
import { digest } from './policy.js';
import { isModelApiRoute, NECTOVIA_ROUTE } from '../../shared/model-api.js';

const sha = /^[a-f0-9]{64}$/;
const money = (value:number) => Number.isSafeInteger(value) && value >= 0;

/** A bounded initial decomposition of the original request; later model plans grant nothing. */
export function planAutomaticWork(request:AutomaticWorkRequest):{requestDigest:string;items:string[];independentReview:boolean} {
  const verbs = /^(?:build|create|make|implement|fix|repair|update|edit|write|generate|prepare|produce|draft|design|organize|reconcile|analyse|analyze|review|audit|test|investigate)\b/i;
  const pieces = request.goal.split(/(?:\r?\n(?:[-*]|\d+[.)])\s*|[.;]\s+|\s+(?:and then|then|and)\s+(?=(?:build|create|make|implement|fix|repair|update|edit|write|generate|prepare|produce|draft|design|organize|reconcile|analyse|analyze|review|audit|test|investigate)\b))/i)
    .map(piece=>piece.trim()).filter(Boolean);
  const items = pieces.filter((piece,index)=>index === 0 || verbs.test(piece)).slice(0,8).map(piece=>piece.slice(0,240));
  return {requestDigest:request.requestDigest,items,independentReview:/\b(?:independent(?:ly)?|separate)\s+(?:review|check|audit)|\b(?:review|verify|audit|test)\s+(?:the\s+)?(?:result|output|implementation|build|changes)\b/i.test(request.goal)};
}

function qualified(candidate:AutomaticTeamCandidate, now:number): boolean {
  const q = candidate.qualification;
  return Boolean(candidate.authorized && candidate.available && q && q.scope === 'bounded-work'
    && sha.test(q.evidenceSha) && Number.isFinite(Date.parse(q.validUntil)) && Date.parse(q.validUntil) > now
    && q.benchmark.accepted && q.benchmark.independent && Number.isFinite(q.benchmark.score)
    && q.id && q.benchmark.id && q.bounds.qualificationId === q.id
    && isModelApiRoute(candidate.route) && candidate.route !== NECTOVIA_ROUTE
    && q.route === candidate.route && q.model === candidate.model && q.effort === candidate.effort
    && q.accountRoute === candidate.accountRoute && q.connectionId === candidate.connectionId
    && q.connectionRevision === candidate.connectionRevision && q.payerId === candidate.payerId
    && q.profileDigest === candidate.profileDigest && sha.test(candidate.profileDigest)
    && Object.values(q.bounds).filter(value=>typeof value === 'number').every(value=>money(value)));
}

/** Planning proposes decomposition; host facts and the existing admission decide who can join. */
export function selectAutomaticTeam(input:{
  request:AutomaticWorkRequest;
  plan:{requestDigest:string;items:readonly string[];independentReview:boolean};
  candidates:readonly AutomaticTeamCandidate[];
  leadRoute:string;leadModel:string;leadAccountRoute:string;
  remainingMicroUsd:number;now:number;
}): AutomaticTeamDecision {
  const single = (reason:string):AutomaticTeamDecision=>({mode:'single',reason});
  if (input.plan.requestDigest !== input.request.requestDigest) return single('The plan does not belong to this request.');
  if (input.plan.items.length < 2 && !input.plan.independentReview) return single('This request has no useful separate work or independent check.');
  if (input.plan.items.length > 8 || input.plan.items.some(item=>!item.trim() || item.length > 240)) return single('The proposed work exceeds the bounded plan.');
  if (!money(input.remainingMicroUsd)) return single('The remaining root budget is not known.');
  if (input.leadRoute === NECTOVIA_ROUTE) return single('This managed route admits one agent.');
  const choices = input.candidates.filter(candidate=>qualified(candidate,input.now));
  const leads = choices.filter(candidate=>candidate.role === 'lead' && candidate.route === input.leadRoute
    && candidate.model === input.leadModel && candidate.accountRoute === input.leadAccountRoute);
  const teams:{lead:AutomaticTeamCandidate;worker:AutomaticTeamCandidate;saved:number;reserve:{workerMicroUsd:number;verificationMicroUsd:number;correctionMicroUsd:number;coordinationMicroUsd:number;totalMicroUsd:number}}[] = [];
  for (const lead of leads) for (const worker of choices) {
    if (worker.role !== 'member' || worker.effort !== 'medium' || worker.slotId === lead.slotId || worker.profileId === lead.profileId
      || worker.payerId !== lead.payerId || worker.qualification!.benchmark.id !== lead.qualification!.benchmark.id
      || worker.qualification!.benchmark.score >= lead.qualification!.benchmark.score) continue;
    const l = lead.qualification!.bounds,w = worker.qualification!.bounds;
    if (w.workerMicroUsd >= l.workerMicroUsd || l.verificationMicroUsd <= 0 || l.correctionMicroUsd <= 0) continue;
    const reserve = {workerMicroUsd:w.workerMicroUsd,verificationMicroUsd:l.verificationMicroUsd,
      correctionMicroUsd:l.correctionMicroUsd,coordinationMicroUsd:l.coordinationMicroUsd,
      totalMicroUsd:w.workerMicroUsd+l.verificationMicroUsd+l.correctionMicroUsd+l.coordinationMicroUsd};
    const saved = l.workerMicroUsd-reserve.totalMicroUsd;
    if (saved <= 0 || !money(reserve.totalMicroUsd) || reserve.totalMicroUsd > input.remainingMicroUsd) continue;
    teams.push({lead,worker,saved,reserve});
  }
  teams.sort((a,b)=>b.saved-a.saved || a.reserve.totalMicroUsd-b.reserve.totalMicroUsd || a.worker.slotId.localeCompare(b.worker.slotId));
  const pick = teams[0];
  if (!pick) return single('No authorized, qualified stronger lead and cheaper worker fit this request and its remaining root budget.');
  const pinDigest = digest({requestDigest:input.request.requestDigest,lead:pick.lead,worker:pick.worker,reserve:pick.reserve});
  return {mode:'team',reason:'Separate work is useful; measured quality and bounded cost support this pair, with budget kept for lead checks and correction.',
    requestDigest:input.request.requestDigest,lead:structuredClone(pick.lead),worker:structuredClone(pick.worker),reserve:pick.reserve,pinDigest};
}

/** Fresh facts must still match the admitted immutable decision at every dispatch and acceptance. */
export function automaticTeamStillCurrent(decision:Extract<AutomaticTeamDecision,{mode:'team'}>,candidates:readonly AutomaticTeamCandidate[],now:number):boolean {
  if (decision.pinDigest !== digest({requestDigest:decision.requestDigest,lead:decision.lead,worker:decision.worker,reserve:decision.reserve})) return false;
  const l=decision.lead.qualification?.bounds,w=decision.worker.qualification?.bounds,r=decision.reserve;
  if (!l || !w || r.workerMicroUsd !== w.workerMicroUsd || r.verificationMicroUsd !== l.verificationMicroUsd
    || r.correctionMicroUsd !== l.correctionMicroUsd || r.coordinationMicroUsd !== l.coordinationMicroUsd
    || r.totalMicroUsd !== r.workerMicroUsd+r.verificationMicroUsd+r.correctionMicroUsd+r.coordinationMicroUsd
    || !money(r.totalMicroUsd) || r.verificationMicroUsd <= 0 || r.correctionMicroUsd <= 0
    || r.totalMicroUsd >= l.workerMicroUsd || decision.worker.effort !== 'medium'
    || decision.lead.qualification!.benchmark.id !== decision.worker.qualification!.benchmark.id
    || decision.lead.qualification!.benchmark.score <= decision.worker.qualification!.benchmark.score
    || decision.lead.payerId !== decision.worker.payerId) return false;
  return [decision.lead,decision.worker].every(pinned=>candidates.some(current=>current.slotId === pinned.slotId
    && qualified(current,now) && digest(current) === digest(pinned)));
}
