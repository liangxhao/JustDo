import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it } from 'vitest';

import { seedMainRoleFiles } from './mainRoleFiles';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it('seeds main from runtime templates once while preserving existing edits', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-main-role-'));
  directories.push(state);
  const runtime = path.join(state, 'runtime');
  const templates = path.join(runtime, 'docs', 'reference', 'templates');
  const role = path.join(state, 'agent-workspaces', 'main');
  fs.mkdirSync(templates, { recursive: true });
  fs.mkdirSync(role, { recursive: true });
  fs.writeFileSync(path.join(templates, 'AGENTS.md'), '---\ntitle: Rules\n---\n\nTemplate rules');
  fs.writeFileSync(path.join(templates, 'SOUL.md'), 'Template soul');
  fs.writeFileSync(path.join(role, 'SOUL.md'), 'Edited soul');

  seedMainRoleFiles(state, runtime);
  expect(fs.readFileSync(path.join(role, 'AGENTS.md'), 'utf8')).toBe('Template rules');
  expect(fs.readFileSync(path.join(role, 'SOUL.md'), 'utf8')).toBe('Edited soul');

  fs.rmSync(path.join(role, 'AGENTS.md'));
  seedMainRoleFiles(state, runtime);
  expect(fs.existsSync(path.join(role, 'AGENTS.md'))).toBe(false);
});

it.each([false, true])(
  'does not seed native onboarding while preserving an existing bootstrap: %s',
  existingBootstrap => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-role-'));
    directories.push(state);
    const runtime = path.join(state, 'runtime');
    const templates = path.join(runtime, 'docs', 'reference', 'templates');
    const role = path.join(state, 'agent-workspaces', 'main');
    fs.mkdirSync(templates, { recursive: true });
    for (const file of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md']) {
      fs.writeFileSync(path.join(templates, file), `Template ${file}`);
    }
    fs.writeFileSync(path.join(templates, 'BOOTSTRAP.md'), 'Native onboarding');
    if (existingBootstrap) {
      fs.mkdirSync(role, { recursive: true });
      fs.writeFileSync(path.join(role, 'BOOTSTRAP.md'), 'User onboarding');
    }

    seedMainRoleFiles(state, runtime);

    for (const file of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md']) {
      expect(fs.readFileSync(path.join(role, file), 'utf8')).toBe(`Template ${file}`);
    }
    const bootstrap = path.join(role, 'BOOTSTRAP.md');
    if (existingBootstrap) {
      expect(fs.readFileSync(bootstrap, 'utf8')).toBe('User onboarding');
    } else {
      expect(fs.existsSync(bootstrap)).toBe(false);
    }
  },
);
