'use strict';

// Capability: recover transient Windows refusal of an uncommitted plugin-directory publication.
// Target: pristine openclaw@2026.10.4 and @openclaw/fs-safe@0.24.2 copied-directory publication.
// Scope: explicit native extension installs; the same copied tree, transaction and owner only.
// Safety: local NTFS, exact syscall/source/destination, bounded wait and complete artifact revalidation.
// Remove when: native plugin installs provide equivalent bounded, receipt-bound Windows publication recovery.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  canonicalHelper,
  verifyNativeSupportBindings,
} = require('../../openclaw/native-support-contract.cjs');
const {
  findMatchingDelimiter,
  nativeSupportModule,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'RUNTIME_WINDOWS_PLUGIN_PUBLICATION_V2026_10_4';
const SUPPORT = 'plugin-directory-publication.mjs';
const SUPPORT_SOURCE = path.resolve(__dirname, '../../../src/main/openclaw/runtime/native-support', SUPPORT);
const HELPER = 'createPluginDirectoryPublicationRecovery';
const TARGETS = {
  move: 'node_modules/@openclaw/fs-safe/dist/move-path.js',
  guard: 'node_modules/@openclaw/fs-safe/dist/guarded-mutation.js',
  install: 'dist/install-package-dir-Bloi0nzp.mjs',
  plugin: 'dist/npm-managed-root-6UK0hDBu.mjs',
};
const NATIVE_BINDINGS = {
  sameIdentity: 'function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }',
  modeBits: 'function modeBits(mode) { return Number(mode & 511n); }',
  pathExists: 'async function pathExists(file) { try { fsSync.statSync(pathForWindowsFilesystem(file)); return true; } catch { return false; } }',
};
const CHANGES = {
  move: [
    ['import { randomUUID } from "node:crypto";', `import { randomUUID } from "node:crypto";\nimport { execFile } from "node:child_process";\nimport { ${HELPER} } from "../../../../dist/native-support/${SUPPORT}";`],
    ['options.onCreated?.(fsSync.lstatSync(to, { bigint: true }));', 'const created = fsSync.lstatSync(to, { bigint: true });\n        options.onCreated?.(created);\n        options.recordCreated?.(to, created);', 2],
    ['aliases: options.aliases,', 'aliases: options.aliases, recordCreated: options.recordCreated,'],
    ['onCreated: options.onCreated,', 'onCreated: created => { options.onCreated?.(created); options.recordCreated?.(to, created); },'],
    ['const stage = await createMoveStageOwner(staged);', 'const stage = await createMoveStageOwner(staged);\n    const copied = options.windowsPluginPublicationRecovery === true && process.platform === "win32" ? new Map() : undefined;'],
    ['onCreated: stage.record,', 'onCreated: stage.record,\n            recordCreated: copied ? (file, identity) => copied.set(file, { dev: identity.dev, ino: identity.ino }) : undefined,'],
    ['assertBeforeRename: () => { assertBeforeRename(); stage.assertCurrent(); },', `assertBeforeRename: () => { assertBeforeRename(); stage.assertCurrent(); },
            recoverRename: copied ? ${HELPER}({ sourcePath, staged, targetPath, manifest, copied,
                assertCurrent: () => { assertSourceParent?.(); assertBeforeRename(); stage.assertCurrent(); }
            }, { fs: fsSync, path, execFile, platform: process.platform, env: process.env }) : undefined,`],
  ],
  guard: [[
    'await fs.rename(params.from, params.to);',
    `try { await fs.rename(params.from, params.to); }
        catch (error) {
            if (!params.recoverRename) throw error;
            await params.recoverRename(error, () => {
                assertSyncDirectoryGuard(sourceGuard);
                assertSyncDirectoryGuard(targetGuard);
                params.assertBeforeRename?.();
                return fs.rename(params.from, params.to);
            });
        }`,
  ]],
  install: [[
    'from: stageDir,\n\t\t\tsourceHardlinks,',
    'from: stageDir,\n\t\t\twindowsPluginPublicationRecovery: params.windowsPluginPublicationRecovery === true,\n\t\t\tsourceHardlinks,',
  ]],
  plugin: [[
    'omitOpenClawHostDependency: true,',
    'omitOpenClawHostDependency: true,\n\t\twindowsPluginPublicationRecovery: true,',
  ]],
};

function occurrences(source, text) { return source.split(text).length - 1; }
function transform(source, kind, file = TARGETS[kind]) {
  let next = source;
  let current = 0;
  let pristine = 0;
  for (const [before, after, count = 1] of CHANGES[kind]) {
    const replaced = occurrences(next, after);
    if (replaced === count && occurrences(next.split(after).join(''), before) === 0) current++;
    else if (replaced === 0 && occurrences(next, before) === count) {
      next = next.split(before).join(after);
      pristine++;
    } else throw new Error(`${file}: historical or partial Windows plugin publication shape`);
  }
  if (current && pristine) throw new Error(`${file}: mixed Windows plugin publication shape`);
  if (current) {
    if (occurrences(source, CONTRACT) !== 1) throw new Error(`${file}: publication marker missing or duplicated`);
    return source;
  }
  if (source.includes(CONTRACT)) throw new Error(`${file}: partial Windows plugin publication marker`);
  return `// ${CONTRACT}\n${next}`;
}

function functionBody(source, name) {
  const matches = [...source.matchAll(new RegExp(`\\bfunction ${name}\\(`, 'g'))];
  if (matches.length !== 1) throw new Error(`Bundled publication owner ${name} changed`);
  const start = matches[0].index;
  const parameters = source.indexOf('(', start);
  const close = findMatchingDelimiter(source, parameters, '(', ')', name);
  const open = source.indexOf('{', close);
  const end = findMatchingDelimiter(source, open, '{', '}', name) + 1;
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end);
}

function moduleAliases(source) {
  const names = new Map();
  for (const match of source.matchAll(/^import\s+(.+?)\s+from\s+["'](node:[^"']+)["'];?$/gm)) {
    const ast = ts.createSourceFile('import.js', match[0], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declaration = ast.statements[0];
    const clause = declaration.importClause;
    if (clause?.name) names.set(clause.name.text, '__native_' + match[2].replace(/\W/g, '_'));
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        names.set(element.name.text, '__native_' + match[2].replace(/\W/g, '_') + '_' + (element.propertyName ?? element.name).text);
  }
  // These three retained native helpers are renamed by the complete Gateway graph.
  // Their complete definitions are independently verified below, never accepted by name alone.
  for (const name of Object.keys(NATIVE_BINDINGS))
    for (const match of source.matchAll(new RegExp(`\\b(${name}(?:\\$\\d+|\\d+)?)(?=\\s*\\()`, 'g')))
      names.set(match[1], '__native_fs_safe_' + name);
  return names;
}

function normalizedOwner(source, name, aliases) {
  const ast = ts.createSourceFile('owner.js', functionBody(source, name), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const transformed = ts.transform(ast, [context => {
    const visit = node => {
      if (ts.isShorthandPropertyAssignment(node) && aliases.has(node.name.text))
        return ts.factory.createPropertyAssignment(node.name.text, ts.factory.createIdentifier(aliases.get(node.name.text)));
      if (ts.isIdentifier(node) && aliases.has(node.text) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node))
        return ts.factory.createIdentifier(aliases.get(node.text));
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit);
  }]);
  try { return canonicalHelper(ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0])); }
  finally { transformed.dispose(); }
}

function verifyBundle(source, expectedSources) {
  verifyNativeSupportBindings(source, fs.readFileSync(SUPPORT_SOURCE, 'utf8'), findMatchingDelimiter);
  const aliases = moduleAliases(source);
  for (const [name, expected] of Object.entries(NATIVE_BINDINGS)) {
    const owner = name === 'pathExists' ? 'installPackageDir' : 'copyEntryWithManifest';
    const matches = [...new Set([...functionBody(source, owner).matchAll(new RegExp(`\\b(${name}(?:\\$\\d+|\\d+)?)(?=\\s*\\()`, 'g'))].map(match => match[1]))];
    if (matches.length !== 1 ||
        normalizedOwner(source, matches[0], aliases) !== normalizedOwner('import fsSync from "node:fs";\n' + expected, name, moduleAliases('import fsSync from "node:fs";\n' + expected)))
      throw new Error(`Bundled publication native binding changed: ${name}`);
  }
  for (const [kind, names] of Object.entries({
    move: ['movePathWithCopyFallback', 'copyEntryWithManifest'],
    guard: ['guardedRename'], install: ['installPackageDir'], plugin: ['installPluginDirectoryIntoExtensions'],
  })) for (const name of names) {
    const expected = expectedSources[kind];
    if (normalizedOwner(source, name, aliases) !== normalizedOwner(expected, name, moduleAliases(expected)))
      throw new Error(`Bundled publication owner changed: ${name}`);
  }
}

function processTargets(root, verify) {
  const packageFile = path.join(root, 'node_modules/@openclaw/fs-safe/package.json');
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  if (metadata.name !== '@openclaw/fs-safe' || metadata.version !== '0.24.2')
    throw new Error('Windows publication requires pristine @openclaw/fs-safe@0.24.2');
  const plans = Object.entries(TARGETS).map(([kind, relative]) => {
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8');
    return { file, kind, source, next: transform(source, kind, relative) };
  });
  const support = path.join(root, 'dist/native-support', SUPPORT);
  const states = plans.map(plan => plan.source === plan.next);
  states.push(fs.existsSync(support));
  if (states.some(Boolean) && states.some(state => !state)) throw new Error('Mixed Windows publication capability; rebuild pristine runtime');
  if (verify && states.some(state => !state)) throw new Error('Windows plugin publication recovery missing');
  const bundle = path.join(root, 'gateway-bundle.mjs');
  if (fs.existsSync(bundle)) {
    if (states.some(state => !state)) throw new Error('Rebuild Gateway bundle from patched pristine dependencies');
    verifyBundle(fs.readFileSync(bundle, 'utf8'), Object.fromEntries(plans.map(plan => [plan.kind, plan.next])));
  }
  if (fs.existsSync(support)) nativeSupportModule(root, SUPPORT, SUPPORT_SOURCE, true);
  if (!verify) nativeSupportModule(root, SUPPORT, SUPPORT_SOURCE);
  return plans.flatMap(plan => !verify && writeIfChanged(plan.file, plan.source, plan.next) ? [path.relative(root, plan.file)] : []);
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, verifyBundle, functionBody, moduleAliases, normalizedOwner, TARGETS, CHANGES, NATIVE_BINDINGS, CONTRACT, SUPPORT, SUPPORT_SOURCE },
};
