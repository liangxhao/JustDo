import path from 'node:path';
import { existsSync } from 'node:fs';
import ts from 'typescript';

import { discoverAppPluginSources, readAppPluginSource, sourceEntry } from './sources.mjs';

/** Each native/app surface is a real root; published SDK exports resolve normally. */
export async function typecheckAppPlugin(source, options = {}) {
  const value = await readAppPluginSource(source);
  const pkg = value.pkg;
  const entries = [pkg.openclaw.extensions[0], pkg.app.main, pkg.app.browser, pkg.app.presentation]
    .filter(Boolean)
    .map(name => sourceEntry(value.source, name));
  const sdkRoot = options.openclawSdkRoot ?? process.env.OPENCLAW_SDK_ROOT;
  if (sdkRoot && !existsSync(path.join(sdkRoot, 'core.d.ts')))
    throw new Error('OPENCLAW_SDK_ROOT must contain the matching public core.d.ts');
  const compilerOptions = {
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
    // Some public prepared facades ship JS without d.ts. Infer their actual
    // exports, while never type-checking the runtime's implementation bundles.
    allowJs: true,
    checkJs: false,
    types: ['node'],
    ...(sdkRoot
      ? { paths: { 'openclaw/plugin-sdk/*': [path.join(path.resolve(sdkRoot), '*')] } }
      : {}),
  };
  const compilerHost = ts.createCompilerHost(compilerOptions);
  compilerHost.getCurrentDirectory = () => value.source;
  const program = ts.createProgram(entries, compilerOptions, compilerHost);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 25), {
        getCurrentDirectory: () => value.source,
        getCanonicalFileName: name => name,
        getNewLine: () => '\n',
      }) +
        (diagnostics.length > 25
          ? `\n${diagnostics.length} diagnostics total; showing the first 25.\n`
          : ''),
    );
  return { id: value.manifest.id };
}

export async function typecheckAppPlugins(options = {}) {
  const sources = await discoverAppPluginSources(
    path.resolve(options.sourceRoot ?? 'plugins/extensions'),
  );
  const result = [];
  for (const { source } of sources) result.push(await typecheckAppPlugin(source, options));
  return result;
}
