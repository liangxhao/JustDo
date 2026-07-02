import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const WORKSPACE_ATTESTATION_HEADER = 'openclaw-workspace-attestation:v1';
const WORKSPACE_ATTESTATION_DIR = 'workspace-attestations';
const WORKSPACE_STATE_FILE = 'openclaw-workspace-state.json';
const WORKSPACE_STATE_VERSION = 1;
const MAX_ATTESTATION_AGE_MS = 24 * 60 * 60 * 1000;

const sha256 = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

const resolveAttestationPath = (workspaceDir: string, stateDir: string): string => {
  const key = sha256(path.resolve(workspaceDir));
  return path.join(stateDir, WORKSPACE_ATTESTATION_DIR, `${key}.attested`);
};

/**
 * Repairs the narrow state mismatch created when OpenClaw attests an existing
 * workspace before it writes the workspace setup state. The repair is allowed
 * only when every generated file recorded by OpenClaw is still byte-for-byte
 * intact, so a genuinely deleted or modified workspace remains protected.
 */
export const repairOpenClawWorkspaceState = (
  workspaceDir: string,
  stateDir: string,
  now = new Date(),
): boolean => {
  const workspaceStatePath = path.join(workspaceDir, WORKSPACE_STATE_FILE);
  const bootstrapPath = path.join(workspaceDir, 'BOOTSTRAP.md');
  const attestationPath = resolveAttestationPath(workspaceDir, stateDir);

  if (
    !fs.existsSync(workspaceDir) ||
    fs.existsSync(workspaceStatePath) ||
    fs.existsSync(bootstrapPath) ||
    !fs.existsSync(attestationPath)
  ) {
    return false;
  }

  try {
    const stat = fs.statSync(attestationPath);
    if (!stat.isFile() || now.getTime() - stat.mtimeMs > MAX_ATTESTATION_AGE_MS) {
      return false;
    }

    const lines = fs.readFileSync(attestationPath, 'utf8').split(/\r?\n/);
    if (lines[0] !== WORKSPACE_ATTESTATION_HEADER) return false;

    const generatedFiles = lines.flatMap(line => {
      const match = /^generated:([^/\\:]+):([a-f0-9]{64})$/.exec(line);
      return match ? [{ name: match[1], hash: match[2] }] : [];
    });
    if (generatedFiles.length === 0) return false;

    const allGeneratedFilesIntact = generatedFiles.every(file => {
      const filePath = path.join(workspaceDir, file.name);
      return fs.existsSync(filePath) && sha256(fs.readFileSync(filePath)) === file.hash;
    });
    if (!allGeneratedFilesIntact) return false;

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
    return true;
  } catch (error) {
    console.warn('[WorkspaceStateRepair] Failed to repair OpenClaw workspace state', error);
    return false;
  }
};
