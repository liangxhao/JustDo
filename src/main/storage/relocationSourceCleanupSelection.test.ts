import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import type { RelocationManifest, RelocationPhysicalIdentity } from './relocationFiles';
import {
  retainedSourceConfigPaths,
  selectCopiedSourceCleanupEntries,
} from './relocationSourceCleanupSelection';

const physical: RelocationPhysicalIdentity = {
  dev: '1', ino: '2', birthtimeNs: '3', size: 4, mtimeNs: '5', ctimeNs: '6',
};

test('selects known copies outside the separately retired OpenClaw directory', () => {
  const sourceRoot = path.resolve('old-storage');
  const archived = 'a'.repeat(64) + '.jsonl.zst';
  const oldFiles = [
    'logs/old.log',
    'local-speech-models/project/result.pdf',
    'Partitions/justdo-browser/Local Storage/old.ldb',
    'Partitions/unknown/profile.ldb',
    'openclaw/state/agents/main/sessions/cold/' + archived,
    'openclaw/state/agents/other/sessions/cold/' + archived,
    'openclaw/state/agents/main/sessions/cold/notes.md',
    'openclaw/state/media/outgoing/originals/report.pdf',
    'openclaw/state/plugin-data/optional/result.sqlite',
    'logs/../login/credentials',
  ];
  const manifest: RelocationManifest = {
    sourceRoot,
    targetRoot: path.resolve('target-storage'),
    sourcePhysical: physical,
    targetPhysical: physical,
    entries: oldFiles.map(relativePath => ({ relativePath, kind: 'file', size: 4, physical })),
    excludeRelativePaths: [],
  };

  const selected = selectCopiedSourceCleanupEntries(manifest, [path.join(sourceRoot, 'local-speech-models/project')]);

  expect(selected.map(entry => entry.relativePath)).toEqual([oldFiles[0], oldFiles[2]]);
});

test('keeps lexical and real old config references without claiming their external parent', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-cleanup-config-'));
  try {
    const sourceRoot = path.join(fixture, 'source');
    const project = path.join(sourceRoot, 'local-speech-models', 'project');
    const alias = path.join(fixture, 'project-alias');
    fs.mkdirSync(project, { recursive: true });
    fs.symlinkSync(project, alias, 'junction');
    const missingSecret = path.join(sourceRoot, 'logs', 'explicit-secret.json');
    const config = {
      agents: { defaults: { cwd: alias, workspace: fixture } },
      secrets: { providers: { custom: { source: 'file', path: missingSecret } } },
    };

    expect(retainedSourceConfigPaths(config, sourceRoot)).toEqual([project, missingSecret]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
