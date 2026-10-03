import type { InteractionDecision } from '../shared/interaction.js';
import { automaticWorkRequestSchema, AUTOMATIC_WORK_POLICY, type AutomaticWorkRequest } from '../shared/automatic-work.js';
import { digest } from './harness/policy.js';
import { relativeName } from './paths.js';
import { conversationCommandIds, proposalDigest, type AdmissionVerdict, type Restriction } from './interaction-admission.js';

/** A conservative grammar for an explicit request, read from the person's bytes only. */
export function isExplicitWorkRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (/\b(?:answer only|plan only|only (?:answer|plan)|read.only)\b/i.test(normalized)
    || /\bwithout\s+(?:modifying|changing|editing|writing|creating|building|implementing)\s+(?:any(?:thing)?|(?:the\s+)?(?:files?|code))\b/i.test(normalized)
    || /\b(?:do not|don't|never)\s+(?:modify|change|edit|write|create|build|implement)(?:(?:\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)(?:modify|change|edit|write|create|build|implement))*\s+(?:(?:any|the|new|project)\s+)?(?:files?|code|anything)\b/i.test(normalized)) return false;
  const verb = '(?:build|create|make|implement|fix|repair|update|edit|write|generate|prepare|produce|draft|design|organize|reconcile|analyse|analyze|review|audit|test|investigate)\\b';
  return new RegExp('^(?:please\\s+)?' + verb, 'i').test(normalized)
    || new RegExp('^(?:please\\s+)?(?:can|could|would|will) you\\s+(?:please\\s+)?' + verb, 'i').test(normalized)
    || new RegExp('^(?:please\\s+)?help me\\s+(?:to\\s+)?' + verb, 'i').test(normalized)
    || new RegExp('^I (?:want|need)(?: you)? to\\s+' + verb, 'i').test(normalized);
}

export function automaticRequestDigest(input: Pick<AutomaticWorkRequest,'goal'|'sources'>): string {
  return digest({action:'message',text:input.goal,mode:'auto',sources:input.sources.map(source=>({path:source.path,sha:source.sha}))});
}

/** Called only by the conversation host, before generation. Never built from a model proposal. */
export function mintAutomaticWorkRequest(input: {
  projectId:string;threadId:string;commandId:string;sourceMessageId:string;
  mode:string;text:string;sources:readonly {path:string;sha:string}[];
  homeProjectId:string|null;requestDigest:string;
}): AutomaticWorkRequest | null {
  if (input.mode !== 'auto' || input.projectId === input.homeProjectId || input.sources.length > 8 || !isExplicitWorkRequest(input.text)) return null;
  const parsed = automaticWorkRequestSchema.safeParse({
    v:1,kind:'explicit-request',policyRevision:AUTOMATIC_WORK_POLICY,
    sourceProjectId:input.projectId,threadId:input.threadId,commandId:input.commandId,
    sourceMessageId:input.sourceMessageId,requestDigest:input.requestDigest,
    goal:input.text,sources:input.sources.map(source=>({...source})),
    targetProjectId:input.projectId,operationCeiling:'write_internal',
  });
  if (!parsed.success || automaticRequestDigest(parsed.data) !== input.requestDigest) return null;
  try {
    const paths = parsed.data.sources.map(source=>relativeName(source.path));
    if (paths.some((name,index)=>name !== parsed.data.sources[index]!.path) || new Set(paths.map(name=>name.toLowerCase())).size !== paths.length) return null;
  } catch { return null; }
  return structuredClone(parsed.data);
}

/** Separate admission for an already requested action. It never records a human selection. */
export function admitAutomaticWork(input: {
  request:AutomaticWorkRequest;decision:InteractionDecision;restriction:Restriction;
  conversationProjectId:string;homeProjectId:string|null;targetableProjectIds:readonly string[];
}): AdmissionVerdict {
  const parsed = automaticWorkRequestSchema.safeParse(input.request);
  if (!parsed.success) return {outcome:'blocked',reason:'stale-request'};
  const request = parsed.data, decision = input.decision;
  if (input.restriction !== 'automatic') return {outcome:'blocked',reason:'above-ceiling'};
  if (request.sourceProjectId !== input.conversationProjectId || request.sourceMessageId !== decision.sourceMessageId
    || request.targetProjectId !== request.sourceProjectId || automaticRequestDigest(request) !== request.requestDigest
    || !isExplicitWorkRequest(request.goal)) return {outcome:'blocked',reason:'stale-request'};
  if (request.targetProjectId === input.homeProjectId) return {outcome:'blocked',reason:'home-is-not-a-target'};
  if (!input.targetableProjectIds.includes(request.targetProjectId)) return {outcome:'blocked',reason:'unknown-target'};
  if (decision.requestedProjectId !== null && decision.requestedProjectId !== request.targetProjectId)
    return {outcome:'blocked',reason:'request-out-of-scope'};
  if (decision.disposition === 'respond' || decision.disposition === 'clarify' || decision.disposition === 'blocked') return {outcome:'inert'};
  if (decision.disposition === 'retrieve' || (decision.disposition === 'act' && decision.operationClass === 'read')) return {outcome:'read',projectId:request.targetProjectId};
  if (decision.disposition === 'control') return {outcome:'blocked',reason:'control-not-reachable'};
  if (decision.disposition === 'build_capability') return {outcome:'blocked',reason:'build-not-reachable'};
  if (decision.operationClass === 'send_external') return {outcome:'blocked',reason:'send-not-reachable'};
  if (decision.disposition === 'plan' && decision.operationClass === 'none') return {outcome:'inert'};
  // The action's instruction is the original goal. A proposal cannot widen its source set.
  const sourceNames = new Set(request.sources.map(source=>source.path));
  if (decision.sourceRefs.some(name=>!sourceNames.has(name))) return {outcome:'blocked',reason:'request-out-of-scope'};
  if ((decision.disposition === 'act' || decision.disposition === 'plan')
    && (decision.operationClass === 'prepare_artifact' || decision.operationClass === 'write_internal')) {
    return {outcome:'escalate',projectId:request.targetProjectId,operationClass:decision.operationClass,
      proposalDigest:proposalDigest(decision,request.targetProjectId),...conversationCommandIds(request.sourceMessageId)};
  }
  return {outcome:'blocked',reason:'request-out-of-scope'};
}
