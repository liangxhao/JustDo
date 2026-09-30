import fs from 'fs';
import path from 'path';

import { resolveManagedAgentWorkspace } from './agentWorkspace';

const TEMPLATE_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md'] as const;

/** Seed main from the same packaged templates OpenClaw uses for new workspaces. */
export function seedMainRoleFiles(stateDir: string, runtimeRoot: string | null): void {
  if (!runtimeRoot) return;
  const target = resolveManagedAgentWorkspace(stateDir, 'main');
  const marker = path.join(target, '.justdo-main-role-seeded');
  if (fs.existsSync(marker)) return;
  const templateDir = path.join(runtimeRoot, 'docs', 'reference', 'templates');

  const sourceFiles = TEMPLATE_FILES.filter(name => {
    try {
      return fs.lstatSync(path.join(templateDir, name)).isFile();
    } catch {
      return false;
    }
  });
  if (sourceFiles.length === 0) return;

  fs.mkdirSync(target, { recursive: true });
  for (const name of sourceFiles) {
    const content = fs.readFileSync(path.join(templateDir, name), 'utf8').replace(
      /^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/,
      '',
    );
    try {
      fs.writeFileSync(path.join(target, name), content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  fs.writeFileSync(marker, '', { flag: 'wx' });
}
