import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildAppSdk(destination = path.join(repo, 'build/app-plugin-sdk')) {
  const source = path.join(repo, 'packages/app-plugin-sdk');
  const entries = (await readdir(source))
    .filter(name => name.endsWith('.ts'))
    .map(name => path.join(source, name));
  await mkdir(destination, { recursive: true });
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    declaration: true,
    emitDeclarationOnly: true,
    outDir: destination,
    rootDir: source,
    types: ['node'],
    jsx: ts.JsxEmit.ReactJSX,
  };
  const program = ts.createProgram(entries, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => repo,
        getCanonicalFileName: name => name,
        getNewLine: () => '\n',
      }),
    );
  if (program.emit().emitSkipped) throw new Error('App SDK declaration build failed');
  await build({
    entryPoints: entries,
    outdir: destination,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    bundle: false,
  });
  for (const file of await readdir(destination)) {
    if (!/\.(?:js|d\.ts)$/.test(file)) continue;
    const location = path.join(destination, file);
    const text = await readFile(location, 'utf8');
    await writeFile(
      location,
      text.replace(
        /((?:from\s*|import\s*\(|export\s*\*\s*from\s*)['"])(\.\/[a-z-]+)(['"])/g,
        '$1$2.js$3',
      ),
    );
  }
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  await writeFile(
    path.join(destination, 'package.json'),
    JSON.stringify(
      {
        ...pkg,
        private: undefined,
        exports: Object.fromEntries(
          entries.map(file => {
            const name = path.basename(file, '.ts');
            return ['./' + name, { types: './' + name + '.d.ts', default: './' + name + '.js' }];
          }),
        ),
      },
      null,
      2,
    ) + '\n',
  );
  await copyFile(path.join(source, 'README.md'), path.join(destination, 'README.md'));
  return destination;
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  console.log(await buildAppSdk());
