import { ipcMain } from 'electron';

import {
  type SkillWorkshopDecision,
  SkillWorkshopIpc,
  type SkillWorkshopResult,
} from '../../../shared/plugins/skillWorkshop';
import type { SkillWorkshopService } from '../../plugins/skills/skillWorkshopService';

export function registerSkillWorkshopHandlers(service: SkillWorkshopService): void {
  const run = async <T>(operation: () => Promise<T>): Promise<SkillWorkshopResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'skillWorkshopUnavailable',
      };
    }
  };
  ipcMain.handle(SkillWorkshopIpc.List, (_event, agentId: string) => run(() => service.list(agentId)));
  ipcMain.handle(SkillWorkshopIpc.Inspect, (_event, agentId: string, proposalId: string) =>
    run(() => service.inspect(agentId, proposalId)),
  );
  ipcMain.handle(SkillWorkshopIpc.Decide, (_event, input: SkillWorkshopDecision) =>
    run(() => service.decide(input)),
  );
}
