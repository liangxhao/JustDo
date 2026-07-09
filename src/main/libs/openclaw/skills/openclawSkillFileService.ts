import path from 'path';

import type { OpenClawEngineManager } from '../runtime/openclawEngineManager';
import { OpenClawSkillFiles } from './openclawSkillFiles';

type OpenClawSkillFileServiceDeps = {
  getOpenClawEngineManager: () => OpenClawEngineManager;
};

export class OpenClawSkillFileService {
  private readonly deps: OpenClawSkillFileServiceDeps;
  private skillFiles: OpenClawSkillFiles | null = null;

  constructor(deps: OpenClawSkillFileServiceDeps) {
    this.deps = deps;
  }

  getSkillFiles(): OpenClawSkillFiles {
    if (!this.skillFiles) {
      const managedSkillsDir = path.join(this.deps.getOpenClawEngineManager().getStateDir(), 'skills');
      this.skillFiles = new OpenClawSkillFiles(managedSkillsDir);
    }
    return this.skillFiles;
  }
}
