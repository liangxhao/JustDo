import fs from 'node:fs';
import path from 'node:path';

import { transformSync } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';

const { transformTypes } =
  require('../../../../scripts/patches/v2026.10.4/026-scoped-finalize-hook-admission.cjs').__testing;
const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;
const frozen = process.env.JUSTDO_EXECUTION_RUNTIME;
const sdkRoot = frozen ?? pristine;
const { canonicalHelper, verifyNativeSupportBindings, extractNativeFunction } =
  require('../../../../scripts/openclaw/native-support-contract.cjs');
const { findMatchingDelimiter } = require('../../../../scripts/patches/v2026.10.4/_patch-utils.js');

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
      'plugins/extensions/runtime-services/agent-team/launch/agent-team-launch-guard.ts',
      'plugins/extensions/swarm-workflow/service/hooks.ts',
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

const supportFunction = 'export function support(input) { return input; }';
const verifySupport = (source: string, expected = supportFunction) =>
  verifyNativeSupportBindings(source, expected, findMatchingDelimiter);

it.each(['value', 'local0', '__canonicalLocal0', '__canonicalLocal0_'])(
  'preserves alpha equivalence for a real parameter named %s',
  name => {
    const actual = `function support(${name}) { return ${name}; }`;
    expect(canonicalHelper(actual)).toBe(canonicalHelper(supportFunction.replace('export ', '')));
    expect(() => verifySupport(actual)).not.toThrow();
  },
);

it('verifies complete functions and constants after syntax minification', () => {
  const expected = `export const LIMIT = 2;
    const check = value => Number.isSafeInteger(value) && value >= 0;
    export function support(input) { return check(input) ? input : 0; }`;
  const actual = transformSync(expected, {
    format: 'esm', minifySyntax: true, minifyWhitespace: true, target: 'node24',
  }).code;
  expect(() => verifySupport(actual, expected)).not.toThrow();
});

it('distinguishes synchronous and asynchronous support while preserving the native extractor API', () => {
  const actual = 'async function support(input) { return input; }';
  expect(() => verifySupport(actual)).toThrow(/function.*partial or stale/);
  expect(() => verifySupport(actual, 'export ' + actual)).not.toThrow();
  expect(extractNativeFunction(actual, 'support', findMatchingDelimiter).body).toBe(
    'function support(input) { return input; }',
  );
});

it.each([
  ['comment', '/* function support(input) { return input; } */ const support = () => false;'],
  ['string', 'const decoy = "function support(input) { return input; }";'],
  ['template', 'const decoy = `function support(input) { return input; }`;'],
  ['regex', 'const decoy = /function support(input) { return input; }/;'],
  ['nested function', 'function owner() { function support(input) { return input; } }'],
  ['nested block', '{ function support(input) { return input; } }'],
  ['arrow', 'const support = input => input;'],
  ['initializer function', 'const owner = function support(input) { return input; };'],
  ['alias', 'function replacement(input) { return input; } const support = replacement;'],
  ['duplicate', 'function support(input) { return input; } function support(input) { return input; }'],
])('rejects %s evidence instead of a real unique top-level function', (_label, source) => {
  expect(() => verifySupport(source)).toThrow(/function binding changed/);
});

it.each([
  ['comment', '/* LIMIT = 2; */'],
  ['string', 'const decoy = "LIMIT = 2;";'],
  ['regex', 'const decoy = /LIMIT = 2/;'],
  ['nested', 'function owner() { const LIMIT = 2; }'],
  ['duplicate', 'var LIMIT = 2; var LIMIT = 2;'],
])('rejects %s evidence instead of a real unique top-level constant', (_label, source) => {
  expect(() => verifySupport(source, 'export const LIMIT = 2;')).toThrow(/constant binding changed/);
});

it('ignores declaration-shaped comments, literals and nested functions around a real binding', () => {
  expect(() => verifySupport(`/* function support(input) { return false; } */
    const string = "function support(input) { return false; }";
    const regex = /function support(input) { return false; }/;
    function owner() { function support(input) { return false; } }
    function support(value) { return value; }`)).not.toThrow();
});

it('does not capture a free identifier as a generated parameter name', () => {
  expect(() => verifySupport('function support(value) { return local0; }')).toThrow(/partial or stale/);
  expect(() => verifySupport('function support(value) { return __canonicalLocal0; }')).toThrow(/partial or stale/);
});

it('rejects the real recovery policy with a free local0 substituted for input', () => {
  const expected = fs.readFileSync(path.resolve(
    'plugins/extensions/runtime-services/tool-call-recovery/policy.mjs',
  ), 'utf8');
  const actual = expected.replaceAll('export ', '').replace('input === null', 'local0 === null');
  expect(actual).toContain('local0 === null');
  expect(() => verifySupport(actual, expected)).toThrow(/function.*partial or stale/);
});
