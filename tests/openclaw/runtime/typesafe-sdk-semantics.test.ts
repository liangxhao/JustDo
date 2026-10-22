import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

const repository = path.resolve('.');
const requestedRuntime = process.env.OPENCLAW_RUNTIME ?? process.env.JUSTDO_EXECUTION_RUNTIME;
const runtime = requestedRuntime ?? path.join(repository, 'vendor/openclaw-runtime/current');
const declarations = path.join(runtime, 'dist/plugin-sdk');
const available = fs.existsSync(path.join(declarations, 'core.d.ts'));

it.skipIf(!requestedRuntime && !available)(
  'type-checks the TypeSafe production entry against the actual host SDK',
  () => {
    expect(
      available,
      'the explicitly selected runtime must contain published SDK declarations',
    ).toBe(true);
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      // Some public helper exports ship JavaScript without declarations. Resolve
      // their real implementations; never invent ambient SDK declarations.
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ['node'],
      typeRoots: [path.join(repository, 'node_modules/@types')],
      baseUrl: repository,
      paths: { 'openclaw/plugin-sdk/*': [path.join(declarations, '*')] },
    };
    const sources = [path.join(repository, 'plugins/extensions/typesafe/index.ts')];
    const program = ts.createProgram(sources, options);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
      .map(diagnostic => ({
        code: diagnostic.code,
        file: path.relative(repository, diagnostic.file?.fileName ?? ''),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      }));
    expect(errors).toEqual([]);
  },
  60_000,
);
