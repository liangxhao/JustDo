import { ipcMain } from 'electron';

import {
  type SkillWorkshopArchiveInput,
  type SkillWorkshopChangesInput,
  SkillWorkshopIpc,
  type SkillWorkshopReadInput,
  type SkillWorkshopRestoreInput,
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
  ipcMain.handle(SkillWorkshopIpc.List, (_event, agentId: string) =>
    run(() => service.list(agentId)),
  );
  ipcMain.handle(SkillWorkshopIpc.Changes, (_event, input: SkillWorkshopChangesInput) =>
    run(() => service.changes(input)),
  );
  ipcMain.handle(SkillWorkshopIpc.Read, (_event, input: SkillWorkshopReadInput) =>
    run(() => service.read(input)),
  );
  ipcMain.handle(SkillWorkshopIpc.Archive, (_event, input: SkillWorkshopArchiveInput) =>
    run(() => service.archive(input)),
  );
  ipcMain.handle(SkillWorkshopIpc.Restore, (_event, input: SkillWorkshopRestoreInput) =>
    run(() => service.restore(input)),
  );
}
