import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../../../../scripts/patches/v2026.7.1-2/008-chrome-mcp-empty-page-recovery.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

const temporaryRoots: string[] = [];
const nativeFunction = `async function listChromeMcpPages(profileName, profileOptions, options = {}) {
\treturn extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
}`;

function createRuntime(source: string): { root: string; target: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-chrome-mcp-patch-'));
  temporaryRoots.push(root);
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  const target = path.join(dist, 'chrome-mcp.js');
  fs.writeFileSync(target, source);
  return { root, target };
}

function checkSyntax(target: string): void {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('replaces an async function with an object default parameter without corrupting its syntax', () => {
  const { root, target } = createRuntime(nativeFunction);

  expect(applyPatch(root)).toEqual([path.join('dist', 'chrome-mcp.js')]);
  verifyPatch(root);
  checkSyntax(target);

  const patched = fs.readFileSync(target, 'utf8');
  expect(patched).toContain('async function listChromeMcpPages');
  expect(patched).not.toContain('async async function');
  expect(applyPatch(root)).toEqual([]);
});
