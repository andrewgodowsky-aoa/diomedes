/** Measured host facts, not a model name, establish suitability and cost. No authority is granted. */
export interface AutomaticTeamQualification {
  readonly id: string;
  readonly evidenceSha: string;
  readonly scope: 'bounded-work';
  readonly validUntil: string;
  readonly route: string;
  readonly model: string;
  readonly effort: string | null;
  readonly accountRoute: string;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly payerId: string;
  readonly profileDigest: string;
  readonly benchmark: { readonly id:string;readonly accepted:boolean;readonly score:number;readonly independent:boolean };
  readonly bounds: {
    readonly qualificationId:string;
    readonly workerMicroUsd:number;
    readonly verificationMicroUsd:number;
    readonly correctionMicroUsd:number;
    readonly coordinationMicroUsd:number;
  };
}

export interface AutomaticTeamCandidate {
  readonly slotId:string;
  readonly role:'lead'|'member';
  readonly profileId:string;
  readonly profileRevision:number;
  readonly profileDigest:string;
  readonly route:string;
  readonly model:string;
  readonly effort:string|null;
  readonly accountRoute:string;
  readonly connectionId:string;
  readonly connectionRevision:number;
  readonly payerId:string;
  readonly authorized:boolean;
  readonly available:boolean;
  readonly qualification:AutomaticTeamQualification|null;
}

export type AutomaticTeamDecision =
  | { readonly mode:'single';readonly reason:string }
  | {
      readonly mode:'team';readonly reason:string;
      readonly requestDigest:string;
      readonly lead:AutomaticTeamCandidate;
      readonly worker:AutomaticTeamCandidate;
      readonly reserve:{readonly workerMicroUsd:number;readonly verificationMicroUsd:number;readonly correctionMicroUsd:number;readonly coordinationMicroUsd:number;readonly totalMicroUsd:number};
      readonly pinDigest:string;
    };
