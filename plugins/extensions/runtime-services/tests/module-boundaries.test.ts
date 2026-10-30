import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import ts from 'typescript';
import { expect, test } from 'vitest';

const pluginRoot = path.resolve(import.meta.dirname, '..');
const businessToken = /agent[-_]?team|teamdiscussion|teamlaunch|swarm[-_]?workflow|plan[-_]?mode/iu;

async function productionFiles(directory = pluginRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    if (['tests', 'node_modules', 'build', 'dist'].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [file]
      : [];
  }))).flat();
}

test('required native services and public SDK bundle within their own generic implementation', async () => {
  const files = await productionFiles();
  const result = await build({
    absWorkingDir: pluginRoot,
    entryPoints: [path.join(pluginRoot, 'index.ts'), ...files.filter(file => path.dirname(file) === path.join(pluginRoot, 'sdk') && !file.endsWith('.d.ts'))],
    outdir: 'build', tsconfigRaw: {},
    bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', metafile: true,
  });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs.filter(file => path.isAbsolute(file) || path.relative(pluginRoot, path.resolve(pluginRoot, file)).startsWith('..'))).toEqual([]);
  const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
  expect(imports.filter(item => /(?:agent-team|swarm-workflow|@app-plugin\/sdk\/planning)/u.test(item.path))).toEqual([]);
});

test('required services contain no optional-plugin business namespaces, codecs or policies', async () => {
  const violations: string[] = [];
  for (const file of await productionFiles()) {
    const relative = path.relative(pluginRoot, file);
    if (businessToken.test(relative)) violations.push(relative);
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      // Check executable names and protocol strings, not explanatory comments.
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && businessToken.test(node.text))
        violations.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${node.text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});

test('required manifests declare only generic capabilities and public SDK exports', async () => {
  for (const name of ['openclaw.plugin.json', 'sdk/package.json']) {
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, name), 'utf8'));
    expect(JSON.stringify(manifest)).not.toMatch(businessToken);
  }
});
