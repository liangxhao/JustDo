import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { syncBundledSkills } = require('../../scripts/sync-bundled-skills.cjs') as {
  syncBundledSkills: (repoRoot: string, runtimeRoot: string, label?: string) => string[];
};

test('fully replaces OpenClaw defaults with the enabled custom skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-bundled-skills-'));
  const runtimeRoot = path.join(root, 'runtime');

  try {
    fs.mkdirSync(path.join(root, 'resources', 'skills', 'custom-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'resources', 'builtin-skills.json'),
      JSON.stringify({
        skills: [
          { id: 'custom-skill', enabled: true },
          { id: 'disabled-skill', enabled: false },
        ],
        disableOpenClawDefaults: true,
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'resources', 'skills', 'custom-skill', 'SKILL.md'),
      'custom',
      'utf8',
    );
    fs.mkdirSync(path.join(runtimeRoot, 'skills', 'openclaw-default'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, 'skills', 'openclaw-default', 'SKILL.md'),
      'default',
      'utf8',
    );

    expect(syncBundledSkills(root, runtimeRoot, 'test')).toEqual(['custom-skill']);
    expect(fs.existsSync(path.join(runtimeRoot, 'skills', 'openclaw-default'))).toBe(false);
    expect(
      fs.readFileSync(path.join(runtimeRoot, 'skills', 'custom-skill', 'SKILL.md'), 'utf8'),
    ).toBe('custom');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
