import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import * as esbuild from 'esbuild';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const patch27 = require('../../../../scripts/patches/v2026.10.4/027-canonical-readiness-owner-path.cjs');
const patch28 = require('../../../../scripts/patches/v2026.10.4/028-prepared-history-response-publication.cjs');
const ownerName = 'session-canonical-key-D1TSJMmX.mjs';
const cacheName = 'openclaw-agent-db-validation-cache-_HDeZNQr.mjs';
const handlerName = 'chat-history-handler-BKMKq528.mjs';
const workerName = 'state/openclaw-state-read.worker.js';
const canonical = `function deferCanonicalSessionValidation(database) {
 const scope = deferral.current; if (!scope) return;
 const pathname = database.db.location(); if (!pathname) return;
 scope.pending ??= { agentId: database.agentId, path: pathname };
 throw new CanonicalSessionValidationDeferred();
}
function assertCanonicalSqliteSessionKeysCurrent(database) { return findOpenClawAgentDatabaseIdentity(database); }
function withCanonicalSessionValidationDeferral(read) { return read(); }
`;
const cache = `function canonicalValidationReceipt(database) {
 if (!database.db.isOpen || !findOpenClawAgentDatabaseIdentity(database)) return;
 const pathname = database.path ?? database.db.location(); if (!pathname) return;
 const validation = validatedPaths.get(path.resolve(pathname))?.validation;
 if (!validation || !matchesValidation({...database,path:pathname},validation)) return;
 bindValidationLifetime({...database,path:pathname},validation); return validation;
}`;
const handler = `async function handleChatHistoryRequest({params,respond,signal}) {
 const value = params.value, other = params.other;
 if (!params.ok) { respond(false,undefined,{code:'UNAVAILABLE'}); return; }
 await prepare({respond,signal}); respond(true,{value,other});
}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('prepared-read-contract-')
    )
      throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture(bundle: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-read-contract-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist'));
  const entries = [
    [ownerName, canonical],
    [cacheName, cache],
    [handlerName, handler],
  ];
  for (const [name, value] of entries) fs.writeFileSync(path.join(root, 'dist', name), value);
  fs.mkdirSync(path.join(root, 'dist', 'state'));
  fs.writeFileSync(
    path.join(root, 'dist', workerName),
    canonical.slice(0, canonical.indexOf('function withCanonicalSessionValidationDeferral(')) +
      '\n' +
      cache,
  );
  if (bundle)
    fs.writeFileSync(
      path.join(root, 'gateway-bundle.mjs'),
      '#!/usr/bin/env node\n' + canonical + '\n' + cache + '\n' + handler,
    );
  return root;
}
function files(root: string) {
  const pending = [path.join(root, 'dist')];
  const native: string[] = [];
  while (pending.length)
    for (const entry of fs.readdirSync(pending.pop()!, { withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else native.push(file);
    }
  return [
    ...native.sort(),
    ...(fs.existsSync(path.join(root, 'gateway-bundle.mjs'))
      ? [path.join(root, 'gateway-bundle.mjs')]
      : []),
  ];
}
function expectNoWrites(root: string, patch: any, targets = files(root)) {
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = targets.map(hash);
  for (const method of ['applyPatch', 'verifyPatch']) {
    expect(() => patch[method](root)).toThrow();
    expect(targets.map(hash)).toEqual(before);
  }
}

for (const [name, patch, family, nativeNames] of [
  ['027', patch27, 'CANONICAL_READINESS_OWNER_PATH', [ownerName, cacheName]],
  ['028', patch28, 'PREPARED_HISTORY_PUBLICATION', [ownerName, handlerName]],
] as const) {
  describe(name + ' public source and bundle contract', () => {
    it.each([false, true])(
      'applies pristine and verifies exact current shape: bundle=%s',
      bundle => {
        const root = fixture(bundle);
        expect(() => patch.verifyPatch(root)).toThrow();
        expect(patch.applyPatch(root)).toHaveLength((name === '027' ? 3 : 2) + (bundle ? 1 : 0));
        expect(patch.applyPatch(root)).toEqual([]);
        expect(() => patch.verifyPatch(root)).not.toThrow();
        if (bundle) {
          const file = path.join(root, 'gateway-bundle.mjs');
          const compiled = transformSync(fs.readFileSync(file, 'utf8'), {
            format: 'esm',
            minifySyntax: true,
          }).code;
          fs.writeFileSync(file, compiled);
          expect(() => patch.verifyPatch(root)).not.toThrow();
        }
      },
    );
    it.each(['source', 'bundle'])('rejects %s-only current state atomically', group => {
      const root = fixture(true);
      const original = new Map(files(root).map(file => [file, fs.readFileSync(file)]));
      patch.applyPatch(root);
      for (const file of files(root))
        if ((group === 'source') === (path.basename(file) === 'gateway-bundle.mjs'))
          fs.writeFileSync(file, original.get(file)!);
      expectNoWrites(root, patch);
    });
    it('rejects partial native groups before writing another file', () => {
      const root = fixture(false);
      const file = path.join(root, 'dist', nativeNames[0]);
      const original = fs.readFileSync(file);
      patch.applyPatch(root);
      fs.writeFileSync(file, original);
      expectNoWrites(root, patch);
    });
    it.each(['missing', 'extra', 'renamed'])(
      'rejects %s native targets, even with plausible counts',
      change => {
        const root = fixture(false);
        const selected = path.join(root, 'dist', nativeNames[0]);
        if (change === 'missing') fs.unlinkSync(selected);
        else if (change === 'extra')
          fs.copyFileSync(selected, path.join(root, 'dist', 'extra.mjs'));
        else fs.renameSync(selected, path.join(root, 'dist', 'renamed.mjs'));
        expectNoWrites(root, patch);
      },
    );
    for (const prefix of ['JUSTDO', 'RUNTIME'])
      for (const current of [false, true]) {
        it(`rejects ${prefix} historical markers outside functions, current=${current}`, () => {
          const root = fixture(true);
          if (current) patch.applyPatch(root);
          fs.appendFileSync(
            path.join(root, 'gateway-bundle.mjs'),
            `\n/*${prefix}_${family}_V2026_9_8*/`,
          );
          expectNoWrites(root, patch);
        });
      }
  });
}

describe('028 real import/export bindings', () => {
  for (const kind of ['import', 'export'])
    for (const mutation of ['comment', 'alias', 'duplicate', 'foreign-module']) {
      it(`rejects ${kind} ${mutation} instead of accepting string-shaped declarations`, () => {
        const root = fixture(false);
        patch28.applyPatch(root);
        const file = path.join(root, 'dist', kind === 'import' ? handlerName : ownerName);
        const source = fs.readFileSync(file, 'utf8');
        const expression =
          kind === 'import'
            ? /import \{ assertSessionReadPublicationReady \} from "[^"]+";/
            : /export \{ assertSessionReadPublicationReady \};/;
        const declaration = source.match(expression)![0];
        let replacement = declaration;
        if (mutation === 'comment') replacement = '// ' + declaration;
        if (mutation === 'alias')
          replacement = declaration.replace(
            'assertSessionReadPublicationReady',
            'assertSessionReadPublicationReady as differentBinding',
          );
        if (mutation === 'duplicate') replacement += '\n' + declaration;
        if (mutation === 'foreign-module')
          replacement =
            kind === 'import'
              ? declaration.replace(ownerName, 'foreign.mjs')
              : declaration.replace(';', ' from "./foreign.mjs";');
        fs.writeFileSync(file, source.replace(expression, replacement));
        expectNoWrites(root, patch28);
      });
    }
  it('rejects a missing assertion in a current wrapper', () => {
    const root = fixture(true);
    patch28.applyPatch(root);
    const file = path.join(root, 'gateway-bundle.mjs');
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('assertSessionReadPublicationReady();', ''),
    );
    expectNoWrites(root, patch28);
  });
});

it.each(['missing', 'extra', 'renamed'])(
  'rejects a %s native state-read worker before any write',
  change => {
    const root = fixture(true);
    const selected = path.join(root, 'dist', workerName);
    if (change === 'missing') fs.unlinkSync(selected);
    else if (change === 'extra')
      fs.copyFileSync(selected, path.join(root, 'dist', 'state', 'extra.worker.js'));
    else fs.renameSync(selected, path.join(root, 'dist', 'state', 'renamed.worker.js'));
    expectNoWrites(root, patch27);
  },
);

it.skipIf(!process.env.JUSTDO_EXECUTION_PRISTINE_DIR)(
  'applies all patches to the complete pristine package after real facade preparation, including native workers',
  async () => {
    const {
      patchFacadeRuntime,
      verifyFacadeRuntime,
    } = require('../../../../scripts/openclaw/openclaw-facade-runtime-patch.cjs');
    const {
      patchOpenClawRuntime,
    } = require('../../../../scripts/openclaw/patch-openclaw-runtime.cjs');
    const {
      findFilesContaining,
    } = require('../../../../scripts/patches/v2026.10.4/_patch-utils.js');
    const {
      functionRange,
    } = require('../../../../scripts/patches/v2026.10.4/prepared-read-patch-shapes.js');
    const {
      createSharedSdkModulesPlugin,
    } = require('../../../../scripts/openclaw/openclaw-shared-sdk-modules.cjs');
    const {
      rewriteRuntimeWorkerImportMetaUrls,
    } = require('../../../../scripts/openclaw/openclaw-runtime-companions.cjs');
    const ts = require('typescript');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-read-contract-'));
    roots.push(root);
    const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR!;
    fs.cpSync(pristine, root, {
      recursive: true,
      filter: (file: string) => path.resolve(file) !== path.resolve(pristine, 'node_modules'),
    });
    const expected = [
      ['dist/' + ownerName, 'dist/' + workerName],
      ['dist/' + cacheName, 'dist/' + workerName],
    ];
    for (const [index, name] of [
      'deferCanonicalSessionValidation',
      'canonicalValidationReceipt',
    ].entries()) {
      const relative = findFilesContaining(root, `function ${name}(`).map((file: string) =>
        path.relative(root, file).replaceAll(path.sep, '/'),
      );
      expect(relative.sort()).toEqual(expected[index].sort());
      expect(new Set(relative).size).toBe(2);
    }
    expect(patchFacadeRuntime(root)).toHaveLength(1);
    expect(() => verifyFacadeRuntime(root)).not.toThrow();
    const results = patchOpenClawRuntime(root, {
      repoRoot: path.resolve('.'),
      version: 'v2026.10.4',
      pristineInstallPass: true,
      writeManifest: false,
    });
    expect(results).toHaveLength(28);
    expect(patch27.applyPatch(root)).toEqual([]);
    expect(patch28.applyPatch(root)).toEqual([]);
    expect(() => patch27.verifyPatch(root)).not.toThrow();
    expect(() => patch28.verifyPatch(root)).not.toThrow();
    // Run the complete native entry graph with the production resolver plugins and external list.
    // Reuse installed dependency files read-only; no installation, Gateway or ABI changes occur.
    const recipe = fs.readFileSync(
      path.resolve('scripts/openclaw/bundle-openclaw-gateway.cjs'),
      'utf8',
    );
    const recipeAst = ts.createSourceFile(
      'recipe.cjs',
      recipe,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let externalExpression: string | undefined;
    const visit = (node: any) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(recipeAst) === 'EXTERNAL_PACKAGES')
        externalExpression = node.initializer.getText(recipeAst);
      ts.forEachChild(node, visit);
    };
    visit(recipeAst);
    expect(externalExpression).toBeDefined();
    const external = vm.runInNewContext(externalExpression!);
    const pluginCode = ['toPosixPath', 'isPathInside', 'createRuntimeImportMetaUrlPlugin']
      .map(name => functionRange(recipe, name).text)
      .join('\n');
    const createImportMetaPlugin = new Function(
      'fs',
      'path',
      'rewriteRuntimeWorkerImportMetaUrls',
      pluginCode + ';return createRuntimeImportMetaUrlPlugin;',
    )(fs, path, rewriteRuntimeWorkerImportMetaUrls);
    const built = await esbuild.build({
      entryPoints: [
        path.join(
          root,
          'dist',
          fs.existsSync(path.join(root, 'dist', 'gateway-entry.js'))
            ? 'gateway-entry.js'
            : 'entry.js',
        ),
      ],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      external,
      logLevel: 'silent',
      nodePaths: [
        path.join(pristine, 'node_modules'),
        path.resolve('vendor/openclaw-runtime/win-x64/node_modules'),
      ],
      plugins: [createSharedSdkModulesPlugin(root, esbuild), createImportMetaPlugin(root)],
    });
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), built.outputFiles[0].text);
    expect(() => patch27.verifyPatch(root)).not.toThrow();
    expect(() => patch28.verifyPatch(root)).not.toThrow();
    const worker = path.join(root, 'dist', workerName);
    const currentWorker = fs.readFileSync(worker, 'utf8');
    fs.writeFileSync(
      worker,
      fs.readFileSync(path.join(process.env.JUSTDO_EXECUTION_PRISTINE_DIR!, 'dist', workerName)),
    );
    expectNoWrites(root, patch27, [
      path.join(root, 'dist', ownerName),
      path.join(root, 'dist', cacheName),
      worker,
      path.join(root, 'gateway-bundle.mjs'),
    ]);
    fs.writeFileSync(worker, currentWorker);
    expect(() => patch27.verifyPatch(root)).not.toThrow();
  },
  300_000,
);

const configured = Boolean(
  process.env.JUSTDO_EXECUTION_RUNTIME || process.env.JUSTDO_EXECUTION_PRISTINE_DIR,
);
it.skipIf(!configured)(
  'executes isolated native SQLite, cache, deferral and retry/publication behavior',
  () => {
    const probe = path.resolve('tests/openclaw/patches/v2026.10.4/canonical-readiness-probe.mjs');
    const output = execFileSync(process.execPath, [probe], {
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
    expect(result.checks).toBeGreaterThanOrEqual(26);
    expect(result.actualSqlite).toBe(true);
    expect(result.workerCovered).toBe(true);
    expect(result.finalBundle).toBe(Boolean(process.env.JUSTDO_EXECUTION_RUNTIME));
  },
);
