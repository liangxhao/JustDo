import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [];
for (const name of await readdir(path.join(repo, 'plugins/extensions'))) {
  try {
    const source = path.join(repo, 'plugins/extensions', name);
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    if (pkg.app) roots.push(path.join(source, pkg.app.main), path.join(source, pkg.app.browser));
    if (pkg.app?.presentation) roots.push(path.join(source, pkg.app.presentation));
  } catch {
    /* Other native extensions have no app entry. */
  }
}
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  jsx: ts.JsxEmit.ReactJSX,
  resolveJsonModule: true,
  types: ['node'],
  baseUrl: repo,
  paths: { '@app-plugin/sdk/*': ['packages/app-plugin-sdk/*'] },
};
const program = ts.createProgram(roots, options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => repo,
      getCanonicalFileName: name => name,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
} else console.log('Independent app plugin types passed.');
