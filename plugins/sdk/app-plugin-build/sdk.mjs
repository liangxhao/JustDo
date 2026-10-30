import { copyFile, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

async function resolvedOutput(location) {
  try { return await realpath(location); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    if (parent === location) throw error;
    return path.join(await resolvedOutput(parent), path.basename(location));
  }
}

/** Emit an explicitly supplied SDK source package as portable ESM and declarations. */
export async function buildSdkPackage({ source, destination, licenseFile }) {
  source = await realpath(path.resolve(source));
  destination = path.resolve(destination);
  const relativeSource = path.relative(await resolvedOutput(destination), source);
  if (relativeSource === '' || (relativeSource !== '..' && !relativeSource.startsWith('..' + path.sep) && !path.isAbsolute(relativeSource)))
    throw new Error('SDK output must not contain its source directory.');
  const entries = (await readdir(source))
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .map(name => path.join(source, name));
  if (!entries.length) throw new Error('SDK package has no TypeScript entries');
  await mkdir(destination, { recursive: true });
  const compilerOptions = {
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
  const compilerHost = ts.createCompilerHost(compilerOptions);
  compilerHost.getCurrentDirectory = () => source;
  const program = ts.createProgram(entries, compilerOptions, compilerHost);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 25), {
        getCurrentDirectory: () => source,
        getCanonicalFileName: name => name,
        getNewLine: () => '\n',
      }) +
        (diagnostics.length > 25
          ? `\n${diagnostics.length} diagnostics total; showing the first 25.\n`
          : ''),
    );
  // A removed public contract must not survive in the next packed SDK.
  const outputs = new Set(entries.flatMap(file => {
    const name = path.basename(file, '.ts');
    return [name + '.js', name + '.d.ts'];
  }));
  for (const file of await readdir(destination)) {
    if (/\.(?:js|d\.ts)$/u.test(file) && !outputs.has(file))
      await unlink(path.join(destination, file));
  }
  if (program.emit().emitSkipped) throw new Error('SDK declaration build failed');
  await build({
    entryPoints: entries,
    outdir: destination,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    bundle: false,
  });
  for (const file of await readdir(destination)) {
    if (!/\.(?:js|d\.ts)$/u.test(file)) continue;
    const location = path.join(destination, file);
    const text = await readFile(location, 'utf8');
    await writeFile(
      location,
      text.replace(
        /((?:from\s*|import\s*\(|export\s*\*\s*from\s*)['"])(\.\/[a-z-]+)(['"])/gu,
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
        files: ['*.js', '*.d.ts', 'README.md', 'LICENSE'],
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
  await copyFile(licenseFile ?? path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
  return destination;
}
