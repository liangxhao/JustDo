import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { CoworkPlanArtifactReference } from '../../../shared/cowork/interactions/planHandoff';
import { PRODUCT_NAME_LOWERCASE } from '../../../shared/productMetadata';

export const APPROVED_PLAN_ARTIFACT_DIRECTORY = path.join(`.${PRODUCT_NAME_LOWERCASE}`, 'plans');
export const MAX_APPROVED_PLAN_ARTIFACT_BYTES = 2 * 1024 * 1024;

const MANAGED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANAGED_PLAN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.md$/;
const MANAGED_TEMPORARY_FILE_PATTERN =
  /^\.[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.\d+\.[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/i;
const DEFAULT_STALE_TEMPORARY_FILE_AGE_MS = 24 * 60 * 60 * 1000;
const HARD_LINK_UNAVAILABLE_CODES = new Set(['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

export type ApprovedPlanArtifactReference = CoworkPlanArtifactReference;

export interface PublishApprovedPlanArtifactInput {
  workspaceRoot: string;
  sessionId: string;
  planId: string;
  markdown: string;
}

export interface CleanupStaleApprovedPlanArtifactsOptions {
  now?: number;
  minimumAgeMs?: number;
}

export class ApprovedPlanArtifactError extends Error {
  constructor(
    readonly code:
      | 'invalid_id'
      | 'invalid_content'
      | 'content_too_large'
      | 'invalid_reference'
      | 'content_conflict'
      | 'integrity_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovedPlanArtifactError';
  }
}

const normalizeMarkdown = (markdown: string): string => markdown.replace(/\r\n?/g, '\n');

const digest = (content: Buffer): string =>
  crypto.createHash('sha256').update(content).digest('hex');

const assertManagedId = (value: string, name: 'sessionId' | 'planId'): void => {
  if (!MANAGED_ID_PATTERN.test(value)) {
    throw new ApprovedPlanArtifactError('invalid_id', `Invalid approved plan ${name}.`);
  }
};

const assertPlainDirectory = (directory: string): void => {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ApprovedPlanArtifactError(
      'invalid_reference',
      'Approved plan storage contains an unsafe directory.',
    );
  }
};

const syncDirectoryBestEffort = (directory: string): void => {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some supported platforms and filesystems.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

export class ApprovedPlanArtifactStore {
  publish(input: PublishApprovedPlanArtifactInput): ApprovedPlanArtifactReference {
    const workspaceRoot = this.assertWorkspaceRoot(input.workspaceRoot);
    assertManagedId(input.sessionId, 'sessionId');
    assertManagedId(input.planId, 'planId');
    if (typeof input.markdown !== 'string') {
      throw new ApprovedPlanArtifactError(
        'invalid_content',
        'Approved plan content must be a string.',
      );
    }

    const normalized = normalizeMarkdown(input.markdown);
    const content = Buffer.from(normalized, 'utf8');
    if (content.byteLength === 0) {
      throw new ApprovedPlanArtifactError('invalid_content', 'Approved plan content is empty.');
    }
    if (content.byteLength > MAX_APPROVED_PLAN_ARTIFACT_BYTES) {
      throw new ApprovedPlanArtifactError(
        'content_too_large',
        'Approved plan content exceeds the supported size.',
      );
    }

    const reference = this.buildReference(workspaceRoot, input.sessionId, input.planId, content);
    const targetPath = this.resolveReferencePath(workspaceRoot, reference);
    const targetDirectory = path.dirname(targetPath);
    this.ensureManagedDirectory(targetDirectory);

    if (fs.existsSync(targetPath)) {
      this.assertExistingContent(targetPath, reference);
      return reference;
    }

    const temporaryPath = path.join(
      targetDirectory,
      `.${input.planId}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;

      // A hard link publishes the fully synced inode atomically and fails if a
      // concurrent publisher already created the immutable destination.
      try {
        fs.linkSync(temporaryPath, targetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          this.assertExistingContent(targetPath, reference);
        } else if (code && HARD_LINK_UNAVAILABLE_CODES.has(code)) {
          this.publishByExclusiveCopy(temporaryPath, targetPath, reference);
        } else {
          throw error;
        }
      }
      syncDirectoryBestEffort(targetDirectory);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // A stale unpublished temporary file is safe to remove during startup cleanup.
      }
    }

    this.assertExistingContent(targetPath, reference);
    return reference;
  }

  readVerified(workspaceRoot: string, reference: ApprovedPlanArtifactReference): string {
    const targetPath = this.resolveReferencePath(
      this.assertWorkspaceRoot(workspaceRoot),
      reference,
    );
    const content = this.readRegularFile(targetPath);
    this.assertIntegrity(content, reference);
    return content.toString('utf8');
  }

  removeSessionArtifacts(workspaceRoot: string, sessionId: string): boolean {
    const resolvedWorkspaceRoot = this.assertWorkspaceRoot(workspaceRoot);
    assertManagedId(sessionId, 'sessionId');
    const artifactRoot = path.join(resolvedWorkspaceRoot, APPROVED_PLAN_ARTIFACT_DIRECTORY);
    if (!fs.existsSync(artifactRoot)) return false;
    this.assertStorageRoot(resolvedWorkspaceRoot);
    return this.removeManagedSessionDirectory(artifactRoot, sessionId);
  }

  private removeManagedSessionDirectory(artifactRoot: string, sessionId: string): boolean {
    const sessionDirectory = path.join(artifactRoot, sessionId);
    if (!fs.existsSync(sessionDirectory)) return false;
    assertPlainDirectory(sessionDirectory);

    const entries = fs.readdirSync(sessionDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        (!MANAGED_PLAN_FILE_PATTERN.test(entry.name) &&
          !MANAGED_TEMPORARY_FILE_PATTERN.test(entry.name))
      ) {
        throw new ApprovedPlanArtifactError(
          'invalid_reference',
          'Approved plan session storage contains an unmanaged entry.',
        );
      }
    }
    for (const entry of entries) {
      fs.rmSync(path.join(sessionDirectory, entry.name));
    }
    fs.rmdirSync(sessionDirectory);
    syncDirectoryBestEffort(artifactRoot);
    return true;
  }

  cleanupStaleTemporaryFiles(
    workspaceRoot: string,
    options: CleanupStaleApprovedPlanArtifactsOptions = {},
  ): number {
    const resolvedWorkspaceRoot = this.assertWorkspaceRoot(workspaceRoot);
    const artifactRoot = path.join(resolvedWorkspaceRoot, APPROVED_PLAN_ARTIFACT_DIRECTORY);
    if (!fs.existsSync(artifactRoot)) return 0;
    this.assertStorageRoot(resolvedWorkspaceRoot);
    const now = options.now ?? Date.now();
    const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_STALE_TEMPORARY_FILE_AGE_MS;
    if (!Number.isFinite(now) || !Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
      throw new ApprovedPlanArtifactError(
        'invalid_reference',
        'Approved plan temporary-file cleanup options are invalid.',
      );
    }

    let removed = 0;
    for (const sessionEntry of fs.readdirSync(artifactRoot, { withFileTypes: true })) {
      if (!MANAGED_ID_PATTERN.test(sessionEntry.name)) continue;
      const sessionDirectory = path.join(artifactRoot, sessionEntry.name);
      if (sessionEntry.isSymbolicLink() || !sessionEntry.isDirectory()) {
        throw new ApprovedPlanArtifactError(
          'invalid_reference',
          'Approved plan storage contains an unsafe session directory.',
        );
      }
      assertPlainDirectory(sessionDirectory);
      for (const entry of fs.readdirSync(sessionDirectory, { withFileTypes: true })) {
        if (!MANAGED_TEMPORARY_FILE_PATTERN.test(entry.name)) continue;
        const temporaryPath = path.join(sessionDirectory, entry.name);
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new ApprovedPlanArtifactError(
            'invalid_reference',
            'Approved plan storage contains an unsafe temporary artifact.',
          );
        }
        const stats = fs.lstatSync(temporaryPath);
        if (now - stats.mtimeMs < minimumAgeMs) continue;
        fs.rmSync(temporaryPath);
        removed += 1;
      }
    }
    return removed;
  }

  private buildReference(
    workspaceRoot: string,
    sessionId: string,
    planId: string,
    content: Buffer,
  ): ApprovedPlanArtifactReference {
    return {
      sessionId,
      planId,
      workspaceRoot,
      relativePath: path.join(APPROVED_PLAN_ARTIFACT_DIRECTORY, sessionId, `${planId}.md`),
      sha256: digest(content),
      byteLength: content.byteLength,
    };
  }

  private resolveReferencePath(
    workspaceRoot: string,
    reference: ApprovedPlanArtifactReference,
  ): string {
    assertManagedId(reference.sessionId, 'sessionId');
    assertManagedId(reference.planId, 'planId');
    if (
      !/^[a-f0-9]{64}$/.test(reference.sha256) ||
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength <= 0 ||
      reference.byteLength > MAX_APPROVED_PLAN_ARTIFACT_BYTES
    ) {
      throw new ApprovedPlanArtifactError(
        'invalid_reference',
        'Approved plan artifact metadata is invalid.',
      );
    }
    const artifactWorkspaceRoot = this.assertWorkspaceRoot(reference.workspaceRoot);
    const expectedRelativePath = path.join(
      APPROVED_PLAN_ARTIFACT_DIRECTORY,
      reference.sessionId,
      `${reference.planId}.md`,
    );
    if (reference.relativePath !== expectedRelativePath) {
      throw new ApprovedPlanArtifactError(
        'invalid_reference',
        'Approved plan artifact path does not match its identifiers.',
      );
    }
    const resolved = path.resolve(artifactWorkspaceRoot, reference.relativePath);
    const relativeToWorkspace = path.relative(artifactWorkspaceRoot, resolved);
    if (
      relativeToWorkspace.startsWith(`..${path.sep}`) ||
      relativeToWorkspace === '..' ||
      path.isAbsolute(relativeToWorkspace)
    ) {
      throw new ApprovedPlanArtifactError(
        'invalid_reference',
        'Approved plan artifact path leaves the managed storage directory.',
      );
    }
    return resolved;
  }

  private ensureManagedDirectory(targetDirectory: string): void {
    const sessionDirectory = targetDirectory;
    const artifactRoot = path.dirname(sessionDirectory);
    const productDirectory = path.dirname(artifactRoot);
    for (const directory of [productDirectory, artifactRoot, sessionDirectory]) {
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      assertPlainDirectory(directory);
    }
  }

  private assertStorageRoot(workspaceRoot: string): void {
    assertPlainDirectory(path.join(workspaceRoot, `.${PRODUCT_NAME_LOWERCASE}`));
    assertPlainDirectory(path.join(workspaceRoot, APPROVED_PLAN_ARTIFACT_DIRECTORY));
  }

  private assertWorkspaceRoot(workspaceRoot: string): string {
    if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
      throw new ApprovedPlanArtifactError(
        'invalid_reference',
        'Approved plan storage requires an absolute workspace path.',
      );
    }
    return path.resolve(workspaceRoot);
  }

  private readRegularFile(targetPath: string): Buffer {
    const stats = fs.lstatSync(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ApprovedPlanArtifactError(
        'invalid_reference',
        'Approved plan artifact is not a regular file.',
      );
    }
    return fs.readFileSync(targetPath);
  }

  private publishByExclusiveCopy(
    temporaryPath: string,
    targetPath: string,
    reference: ApprovedPlanArtifactReference,
  ): void {
    let copied = false;
    try {
      fs.copyFileSync(temporaryPath, targetPath, fs.constants.COPYFILE_EXCL);
      copied = true;
      const descriptor = fs.openSync(targetPath, 'r+');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.assertExistingContent(targetPath, reference);
        return;
      }
      if (copied) {
        try {
          fs.rmSync(targetPath, { force: true });
        } catch {
          // Preserve the publication failure; integrity checks reject any partial file.
        }
      }
      throw error;
    }
  }

  private assertExistingContent(
    targetPath: string,
    reference: ApprovedPlanArtifactReference,
  ): void {
    const content = this.readRegularFile(targetPath);
    if (content.byteLength !== reference.byteLength || digest(content) !== reference.sha256) {
      throw new ApprovedPlanArtifactError(
        'content_conflict',
        'An approved plan artifact with different content already exists.',
      );
    }
  }

  private assertIntegrity(content: Buffer, reference: ApprovedPlanArtifactReference): void {
    if (content.byteLength !== reference.byteLength || digest(content) !== reference.sha256) {
      throw new ApprovedPlanArtifactError(
        'integrity_mismatch',
        'Approved plan artifact integrity verification failed.',
      );
    }
  }
}
