import path from 'path';

import { t } from '../../core/i18n';
import {
  managedDirectoryFailure,
  managedDirectoryFailureFromError,
  managedDirectoryFailureFromMessage,
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/managedDirectoryOperations';
import { findWindowsLockingProcesses } from '../../core/windowsFileLockDiagnostics';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { type LocalSkillFileResult, OpenClawSkillFiles } from './openclawSkillFiles';

type OpenClawSkillFileServiceDeps = {
  getOpenClawEngineManager: () => OpenClawEngineManager;
  directoryOperations?: ManagedDirectoryOperationCoordinator;
  findLockingProcesses?: typeof findWindowsLockingProcesses;
  createSkillFiles?: (managedSkillsDir: string) => OpenClawSkillFiles;
};

export class OpenClawSkillFileService {
  private readonly deps: OpenClawSkillFileServiceDeps;
  private readonly directoryOperations: ManagedDirectoryOperationCoordinator;
  private skillFiles: OpenClawSkillFiles | null = null;

  constructor(deps: OpenClawSkillFileServiceDeps) {
    this.deps = deps;
    this.directoryOperations =
      deps.directoryOperations ??
      new ManagedDirectoryOperationCoordinator({
        findLockingProcesses: deps.findLockingProcesses,
      });
  }

  getSkillFiles(): OpenClawSkillFiles {
    if (!this.skillFiles) {
      const managedSkillsDir = this.getManagedSkillsDir();
      this.skillFiles =
        this.deps.createSkillFiles?.(managedSkillsDir) ?? new OpenClawSkillFiles(managedSkillsDir);
    }
    return this.skillFiles;
  }

  async importPath(sourcePath: string): Promise<LocalSkillFileResult> {
    let targetPath = this.getManagedSkillsDir();
    const operation = await this.directoryOperations.execute({
      resourceName: t('skillDirectoryResource'),
      targetPath: () => targetPath,
      manageRuntimeOnLock: true,
      operation: async () => {
        const result = await this.getSkillFiles().importPath(sourcePath);
        if (result.success) return managedDirectorySuccess(result);
        targetPath = result.errorPath || targetPath;
        const failure = managedDirectoryFailureFromMessage(
          [result.errorSyscall, result.errorCode, result.error].filter(Boolean).join(': '),
          targetPath,
        );
        return managedDirectoryFailure({
          ...failure,
          message: result.error || failure.message,
          ...(result.errorCode ? { code: result.errorCode } : {}),
          ...(result.errorSyscall ? { syscall: result.errorSyscall } : {}),
        });
      },
    });
    if (!('failure' in operation)) return operation.value;
    return {
      success: false,
      error: operation.failure.message,
      ...(operation.failure.code ? { errorCode: operation.failure.code } : {}),
      ...(operation.failure.syscall ? { errorSyscall: operation.failure.syscall } : {}),
      ...(operation.failure.code ? { errorPath: operation.failure.targetPath } : {}),
    };
  }

  async deleteDirectory(skillDirectory: string): Promise<void> {
    const operation = await this.directoryOperations.execute({
      resourceName: t('skillDirectoryResource'),
      targetPath: skillDirectory,
      manageRuntimeOnLock: true,
      operation: async () => {
        try {
          this.getSkillFiles().deleteDirectory(skillDirectory);
          return managedDirectorySuccess(undefined);
        } catch (error) {
          return managedDirectoryFailure(managedDirectoryFailureFromError(error, skillDirectory));
        }
      },
    });
    if ('failure' in operation) throw new Error(operation.failure.message);
  }

  private getManagedSkillsDir(): string {
    return path.join(this.deps.getOpenClawEngineManager().getStateDir(), 'skills');
  }
}
