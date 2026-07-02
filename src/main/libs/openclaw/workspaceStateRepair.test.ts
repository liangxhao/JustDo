import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { repairOpenClawWorkspaceState } from './workspaceStateRepair';

const tempDirs: string[] = [];

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-workspace-repair-'));
  tempDirs.push(root);
  const workspaceDir = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspaceDir);
  fs.mkdirSync(path.join(stateDir, 'workspace-attestations'), { recursive: true });

  const content = '# Agent instructions\n';
  fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), content);
  const workspaceKey = crypto.createHash('sha256').update(path.resolve(workspaceDir)).digest('hex');
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const attestationPath = path.join(
    stateDir,
    'workspace-attestations',
    `${workspaceKey}.attested`,
  );
  fs.writeFileSync(
    attestationPath,
    `openclaw-workspace-attestation:v1\n2026-07-02T00:00:00.000Z\ngenerated:AGENTS.md:${contentHash}\n`,
  );

  return { workspaceDir, stateDir };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('repairOpenClawWorkspaceState', () => {
  test('repairs missing state when all attested generated files are intact', () => {
    const fixture = createFixture();
    const now = new Date('2026-07-02T01:00:00.000Z');

    expect(repairOpenClawWorkspaceState(fixture.workspaceDir, fixture.stateDir, now)).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.workspaceDir, 'openclaw-workspace-state.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      version: 1,
      setupCompletedAt: now.toISOString(),
    });
  });

  test('does not repair when an attested generated file was deleted', () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.workspaceDir, 'AGENTS.md'));

    expect(
      repairOpenClawWorkspaceState(
        fixture.workspaceDir,
        fixture.stateDir,
        new Date('2026-07-02T01:00:00.000Z'),
      ),
    ).toBe(false);
  });

  test('does not repair when an attested generated file was modified', () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.workspaceDir, 'AGENTS.md'), '# changed\n');

    expect(
      repairOpenClawWorkspaceState(
        fixture.workspaceDir,
        fixture.stateDir,
        new Date('2026-07-02T01:00:00.000Z'),
      ),
    ).toBe(false);
  });
});
