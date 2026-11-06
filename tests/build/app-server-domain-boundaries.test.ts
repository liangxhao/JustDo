import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { build, type BuildOptions } from 'esbuild';
import ts from 'typescript';
import { expect, test } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const coreRoot = path.join(projectRoot, 'src/main/appServer');
const domainToken = /browser|chrome|weblaunch/iu;
const domainPath = /(?:^|\/)(?:browser|chrome|chrome-extension|chrome-extensions|chrome-assistant)(?:\/|$)/iu;

async function sourceFiles(directory = coreRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name) ? [file] : [];
  }))).flat();
}

test('app-server core declarations and tests contain no browser-specific protocol or imports', async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles()) {
    const relative = path.relative(projectRoot, file);
    if (domainToken.test(relative)) violations.push(relative);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      // Inspect code and wire values rather than explanatory comments.
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && domainToken.test(node.text))
        violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

async function runtimeDependencies(input: Pick<BuildOptions, 'entryPoints' | 'stdin'>): Promise<string[]> {
  const result = await build({
    absWorkingDir: projectRoot,
    ...input,
    outdir: 'build/app-server-boundary',
    tsconfig: 'electron-tsconfig.json',
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
  });
  // The bundler traverses value imports/re-exports and static require/import(),
  // while correctly erasing broad type-only runtime contracts.
  return Object.keys(result.metafile!.inputs).map(file =>
    path.relative(projectRoot, path.resolve(projectRoot, file)).replace(/\\/gu, '/'));
}

test('app-server production entry points have no transitive browser runtime dependencies', async () => {
  const files = (await sourceFiles()).filter(file => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
  const dependencies = await runtimeDependencies({ entryPoints: files });
  expect(dependencies.filter(file => domainPath.test(file))).toEqual([]);
});

test('the runtime dependency boundary resolves Main path aliases before classifying modules', async () => {
  const dependencies = await runtimeDependencies({ stdin: {
    contents: "export { BrowserMode } from '@shared/browser/browser';",
    resolveDir: coreRoot,
    sourcefile: 'core-alias-probe.ts',
  } });
  expect(dependencies.filter(file => domainPath.test(file))).toContain('src/shared/browser/browser.ts');
});
