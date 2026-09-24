export const SkillWorkshopIpc = {
  List: 'skills:workshop:list',
  Inspect: 'skills:workshop:inspect',
  Decide: 'skills:workshop:decide',
} as const;

export const SkillProposalStatus = {
  Pending: 'pending',
  Applied: 'applied',
  Rejected: 'rejected',
  Quarantined: 'quarantined',
  Stale: 'stale',
} as const;
export type SkillProposalStatus = (typeof SkillProposalStatus)[keyof typeof SkillProposalStatus];

export interface SkillProposalSummary {
  id: string;
  kind: 'create' | 'update';
  status: SkillProposalStatus;
  title: string;
  description: string;
  skillName: string;
  skillKey: string;
  createdAt: string;
  updatedAt: string;
  scanState: 'pending' | 'clean' | 'failed' | 'quarantined';
  revisionHash?: string;
  degradedState?: 'draft-missing';
}

export interface SkillProposalInspection {
  record: {
    id: string;
    kind: 'create' | 'update';
    status: SkillProposalStatus;
    title: string;
    description: string;
    target: { skillName: string; skillKey: string; currentContentHash?: string };
    origin?: { agentId?: string; sessionKey?: string; runId?: string };
    evidence?: string;
    goal?: string;
    statusReason?: string;
    scan: {
      state: SkillProposalSummary['scanState'];
      findings: {
        ruleId: string;
        severity: string;
        file: string;
        line: number;
        message: string;
        evidence: string;
      }[];
    };
  };
  revisionHash?: string;
  content: string;
  supportFiles?: { path: string; content: string }[];
  /** Full current instruction body from skills.workshop.read, never a local transcript cache. */
  currentContent: string | null;
  comparisonUnavailable?: boolean;
  targetChanged?: boolean;
}

export type SkillWorkshopResult<T> =
  { success: true; value: T } | { success: false; error: string };

export interface SkillWorkshopDecision {
  agentId: string;
  proposalId: string;
  expectedRevisionHash: string;
  action: 'apply' | 'reject';
}

export interface SkillWorkshopApi {
  list: (agentId: string) => Promise<SkillWorkshopResult<SkillProposalSummary[]>>;
  inspect: (
    agentId: string,
    proposalId: string,
  ) => Promise<SkillWorkshopResult<SkillProposalInspection>>;
  decide: (input: SkillWorkshopDecision) => Promise<SkillWorkshopResult<void>>;
}
