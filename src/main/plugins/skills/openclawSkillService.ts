import type { GatewaySkillStatus, SkillRpcResult, SkillUpdateParams } from '../../engine/types';

export interface OpenClawSkillGateway {
  requestGateway<T>(method: string, params?: unknown): Promise<T>;
}

export type OpenClawSkillGatewayResolver = () => OpenClawSkillGateway | null;

export class OpenClawSkillService {
  constructor(private readonly resolveGateway: OpenClawSkillGatewayResolver) {}

  getStatus(agentId?: string): Promise<GatewaySkillStatus> {
    return this.requireGateway().requestGateway('skills.status', { agentId });
  }

  updateConfig(params: SkillUpdateParams): Promise<SkillRpcResult> {
    return this.requireGateway().requestGateway('skills.update', params);
  }

  private requireGateway(): OpenClawSkillGateway {
    const gateway = this.resolveGateway();
    if (!gateway) {
      throw new Error('Gateway not connected');
    }
    return gateway;
  }
}
