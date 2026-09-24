import { createHash, randomUUID } from 'node:crypto';

import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import {
  type SkillProposalInspection,
  SkillProposalStatus,
  type SkillProposalSummary,
  type SkillWorkshopDecision,
} from '../../../shared/plugins/skillWorkshop';

type Request = <T>(method: string, params?: unknown) => Promise<T>;
export class SkillWorkshopService {
  private readonly decisions = new Set<string>();

  constructor(private readonly request: Request) {}

  private checkAgent(agentId: string): void {
    // Product conversations belong to main. Do not silently author for another profile.
    if (agentId !== MAIN_USER_AGENT_ID) throw new Error('skillWorkshopMainOnly');
  }

  async list(agentId: string): Promise<SkillProposalSummary[]> {
    this.checkAgent(agentId);
    const result = await this.request<{ proposals: SkillProposalSummary[] }>(
      'skills.proposals.list',
      { agentId },
    );
    if (!Array.isArray(result.proposals)) throw new Error('skillWorkshopUnavailable');
    return result.proposals;
  }

  async inspect(agentId: string, proposalId: string): Promise<SkillProposalInspection> {
    this.checkAgent(agentId);
    this.checkId(proposalId);
    const result = await this.request<SkillProposalInspection>('skills.proposals.inspect', {
      agentId,
      proposalId,
    });
    if (
      result.record?.id !== proposalId ||
      (result.record.origin?.agentId && result.record.origin.agentId !== agentId)
    ) {
      throw new Error('skillWorkshopOwnershipMismatch');
    }
    if (result.record.kind === 'create') return { ...result, currentContent: '' };
    try {
      const current = await this.request<{ content: string }>('skills.workshop.read', {
        agentId,
        name: result.record.target.skillName,
      });
      if (typeof current.content !== 'string') throw new Error('skillWorkshopUnavailable');
      const hash = createHash('sha256').update(current.content).digest('hex');
      return {
        ...result,
        currentContent: current.content,
        targetChanged: Boolean(
          result.record.target.currentContentHash &&
          hash !== result.record.target.currentContentHash,
        ),
      };
    } catch {
      return { ...result, currentContent: null, comparisonUnavailable: true };
    }
  }

  async decide(input: SkillWorkshopDecision): Promise<void> {
    this.checkAgent(input?.agentId);
    this.checkId(input?.proposalId);
    if (
      !['apply', 'reject'].includes(input?.action) ||
      !/^[a-f0-9]{64}$/.test(input?.expectedRevisionHash ?? '')
    ) {
      throw new Error('skillWorkshopRefreshRequired');
    }
    const key = `${input.agentId}:${input.proposalId}`;
    if (this.decisions.has(key)) throw new Error('skillWorkshopBusy');
    this.decisions.add(key);
    try {
      const current = await this.inspect(input.agentId, input.proposalId);
      if (
        current.record.status !== SkillProposalStatus.Pending ||
        current.revisionHash !== input.expectedRevisionHash
      ) {
        throw new Error('skillWorkshopRefreshRequired');
      }
      if (input.action === 'apply' && (current.comparisonUnavailable || current.targetChanged)) {
        throw new Error('skillWorkshopTargetChanged');
      }
      await this.request(`skills.proposals.${input.action}`, {
        agentId: input.agentId,
        proposalId: input.proposalId,
        expectedRevisionHash: input.expectedRevisionHash,
        correlationId: randomUUID(),
      });
    } finally {
      this.decisions.delete(key);
    }
  }

  private checkId(id: string): void {
    if (typeof id !== 'string' || !id.trim() || id.length > 256)
      throw new Error('skillWorkshopInvalidProposal');
  }
}
