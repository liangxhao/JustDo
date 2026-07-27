import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const WORKSPACE_ATTESTATION_HEADER = 'openclaw-workspace-attestation:v1';
const WORKSPACE_ATTESTATION_DIR = 'workspace-attestations';
const WORKSPACE_STATE_FILE = 'openclaw-workspace-state.json';
const WORKSPACE_STATE_VERSION = 1;
const MAX_ATTESTATION_AGE_MS = 24 * 60 * 60 * 1000;

export type OpenClawWorkspaceStateRepairResult =
  | 'none'
  | 'state-repaired'
  | 'reset-attestation-removed';

const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

const resolveAttestationPath = (workspaceDir: string, stateDir: string): string => {
  const key = sha256(path.resolve(workspaceDir));
  return path.join(stateDir, WORKSPACE_ATTESTATION_DIR, `${key}.attested`);
};

/**
 * Reconciles OpenClaw's workspace attestation with the user's workspace.
 *
 * A missing or empty workspace is treated as an intentional reset, so its
 * attestation is removed and OpenClaw can initialize it again. A non-empty
 * workspace remains protected: missing setup state is repaired only when every
 * generated file recorded by OpenClaw is still byte-for-byte intact.
 */
export const repairOpenClawWorkspaceState = (
  workspaceDir: string,
  stateDir: string,
  now = new Date(),
): OpenClawWorkspaceStateRepairResult => {
  const workspaceStatePath = path.join(workspaceDir, WORKSPACE_STATE_FILE);
  const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
  const attestationPath = resolveAttestationPath(workspaceDir, stateDir);

  if (
    fs.existsSync(workspaceStatePath) ||
    fs.existsSync(bootstrapPath) ||
    !fs.existsSync(attestationPath)
  ) {
    return 'none';
  }

  try {
    const stat = fs.statSync(attestationPath);
    if (!stat.isFile() || now.getTime() - stat.mtimeMs > MAX_ATTESTATION_AGE_MS) {
      return 'none';
    }

    const lines = fs.readFileSync(attestationPath, 'utf8').split(/\r?\n/);
    if (lines[0] !== WORKSPACE_ATTESTATION_HEADER) return 'none';

    const workspaceWasReset =
      !fs.existsSync(workspaceDir) || fs.readdirSync(workspaceDir).length === 0;
    if (workspaceWasReset) {
      fs.rmSync(attestationPath, { force: true });
      return 'reset-attestation-removed';
    }

    const generatedFiles = lines.flatMap(line => {
      const match = /^generated:([^/\\:]+):([a-f0-9]{64})$/.exec(line);
      return match ? [{ name: match[1], hash: match[2] }] : [];
    });
    if (generatedFiles.length === 0) return 'none';

    const allGeneratedFilesIntact = generatedFiles.every(file => {
      const filePath = path.join(workspaceDir, file.name);
      return fs.existsSync(filePath) && sha256(fs.readFileSync(filePath)) === file.hash;
    });
    if (!allGeneratedFilesIntact) return 'none';

    const content = `${JSON.stringify(
      {
        version: WORKSPACE_STATE_VERSION,
        setupCompletedAt: now.toISOString(),
      },
      null,
      2,
    )}\n`;
    const tmpPath = `${workspaceStatePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpPath, workspaceStatePath);
    return 'state-repaired';
  } catch (error) {
    console.warn('[WorkspaceStateRepair] Failed to repair OpenClaw workspace state', error);
    return 'none';
  }
};
