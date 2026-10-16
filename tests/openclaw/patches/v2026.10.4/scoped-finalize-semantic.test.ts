import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

const { transformTypes } =
  require('../../../../scripts/patches/v2026.10.4/026-scoped-finalize-hook-admission.cjs').__testing;
const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;
const frozen = process.env.JUSTDO_EXECUTION_RUNTIME;
const sdkRoot = frozen ?? pristine;

function exportedName(source: string, localName: string): string | undefined {
  const ast = ts.createSourceFile('sdk.d.ts', source, ts.ScriptTarget.Latest, true);
  for (const node of ast.statements)
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
      for (const entry of node.exportClause.elements)
        if ((entry.propertyName ?? entry.name).text === localName) return entry.name.text;
  return undefined;
}

it.skipIf(!sdkRoot)(
  'semantically validates the real core API and all four SDK admission surfaces',
  () => {
    const repo = path.resolve('.');
    const dist = path.join(sdkRoot!, 'dist');
    const targets = fs
      .readdirSync(dist)
      .filter(name => name.endsWith('.d.ts'))
      .map(name => ({
        name,
        file: path.join(dist, name),
        source: fs.readFileSync(path.join(dist, name), 'utf8'),
      }))
      .filter(file =>
        file.source.includes('type PluginHookRegistrationOptions<K extends PluginHookName> = {'),
      );
    expect(targets).toHaveLength(4);
    const lines = [
      "import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';",
      'declare const core: OpenClawPluginApi;',
      "core.on('before_agent_finalize', async () => {}, {priority: 3, timeoutMs: 100, appliesToAgentRun: ctx => Boolean(ctx.runId)});",
      "const exact: NonNullable<Parameters<typeof core.on<'before_agent_finalize'>>[2]> = {appliesToAgentRun: () => false};",
      "core.on('before_agent_finalize', async () => {}, exact);",
    ];
    for (const [index, file] of targets.entries()) {
      const api = exportedName(file.source, 'OpenClawPluginApi');
      if (api)
        lines.push(
          `import type { ${api} as Api${index} } from 'sdk-surface-${index}';`,
          `declare const api${index}: Api${index};`,
          `api${index}.on('before_agent_finalize', async () => {}, {appliesToAgentRun: ctx => Boolean(ctx.sessionKey)});`,
        );
      else {
        const options = exportedName(file.source, 'PluginHookRegistrationOptions');
        expect(options).toBeDefined();
        lines.push(
          `import type { ${options} as Options${index} } from 'sdk-surface-${index}';`,
          `const options${index}: Options${index}<'before_agent_finalize'> = {appliesToAgentRun: ctx => Boolean(ctx.sessionId)};`,
        );
      }
    }
    for (const [index, relative] of [
      'openclaw-extensions/runtime-services/agent-team/launch/agent-team-launch-guard.ts',
      'openclaw-extensions/swarm-workflow/service/hooks.ts',
    ].entries()) {
      const text = fs.readFileSync(path.join(repo, relative), 'utf8');
      const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
      let options: ts.TypeNode | undefined;
      let identity = '';
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'finalizeOptions')
          options = node.type;
        if (ts.isTypeAliasDeclaration(node) && node.name.text === 'Identity')
          identity = node.getText(ast);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(options).toBeDefined();
      lines.push(
        `namespace Product${index} {`,
        'declare const api: OpenClawPluginApi;',
        identity,
        `const finalizeOptions: ${options!.getText(ast)} = {appliesToAgentRun: () => false};`,
        "api.on('before_agent_finalize', async () => {}, finalizeOptions);",
        'type AssertFalse<T extends false> = T;',
        'type OptionsNotNever = AssertFalse<[typeof finalizeOptions] extends [never] ? true : false>;',
        'type ApiNotAny = AssertFalse<0 extends (1 & typeof api.on) ? true : false>;',
        '}',
      );
    }
    lines.push(
      '// @ts-expect-error non-finalize hooks cannot declare an admission selector',
      "core.on('agent_end', async () => {}, {appliesToAgentRun: () => false});",
      '// @ts-expect-error selectors must remain synchronous',
      "core.on('before_agent_finalize', async () => {}, {appliesToAgentRun: async () => false});",
      "core.on('before_agent_finalize', async () => {}, {appliesToAgentRun: ctx => {",
      '// @ts-expect-error the stable identity snapshot is readonly',
      "ctx.runId = 'replacement';",
      '// @ts-expect-error the selector receives only declared identity fields',
      'return ctx.sandboxed === true; }});',
      'declare const broad: NonNullable<Parameters<typeof core.on>[2]>;',
      '// @ts-expect-error generic hook options contain incompatible tool-authority alternatives',
      "core.on('before_agent_finalize', async () => {}, broad);",
    );
    const fixture = path.join(repo, 'tests', 'finalize-semantic-virtual.ts');
    const compilerOptions: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ['node'],
      typeRoots: [path.join(repo, 'node_modules', '@types')],
      baseUrl: repo,
      paths: {
        'openclaw/plugin-sdk/*': [path.join(dist, 'plugin-sdk', '*')],
        ...Object.fromEntries(targets.map((file, index) => [`sdk-surface-${index}`, [file.file]])),
      },
    };
    const overlays = new Map(
      targets.map(file => {
        const patched = transformTypes(file.source, file.file);
        // Final mode verifies and executes the exact published declarations; it never repairs them.
        if (frozen) expect(patched).toBe(file.source);
        return [path.resolve(file.file), frozen ? file.source : patched];
      }),
    );
    const host = ts.createCompilerHost(compilerOptions);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    host.readFile = file =>
      path.resolve(file) === fixture
        ? lines.join('\n')
        : (overlays.get(path.resolve(file)) ?? read(file));
    host.fileExists = file => path.resolve(file) === fixture || exists(file);
    const program = ts.createProgram([fixture], compilerOptions, host);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
      .map(diagnostic => ({
        code: diagnostic.code,
        file: path.basename(diagnostic.file?.fileName ?? ''),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      }));
    expect(errors).toEqual([]);
  },
  60_000,
);
