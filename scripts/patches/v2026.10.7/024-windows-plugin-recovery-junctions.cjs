'use strict';

// Capability: retain captured Windows host-directory junctions during plugin recovery.
// Target: pristine openclaw@2026.10.7 copyRecoverySource copy filter.
// Scope: absolute directory links already accepted by the native recovery filter.
// Safety: preserve native references, hardlink guards, capture disposal and lifecycle.
// Remove when: native recovery copies Windows directory junctions without symlink privilege.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { transformSync } = require('esbuild');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'PLUGIN_RECOVERY_JUNCTIONS_V2026_10_7';
const parse = source =>
  ts.createSourceFile('recovery.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const unique = (items, file) => {
  if (items.length !== 1)
    throw new Error(`${file}: plugin recovery topology changed (${items.length}, expected 1)`);
  return items[0];
};
function collect(node, predicate) {
  const result = [];
  const visit = item => {
    if (predicate(item)) result.push(item);
    ts.forEachChild(item, visit);
  };
  visit(node);
  return result;
}
function canonical(source) {
  const ast = parse(`const verification = (${source});`);
  const options = { allowJs: true, noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => (file === ast.fileName ? ast : undefined);
  const checker = ts.createProgram([ast.fileName], options, host).getTypeChecker();
  const bindings = new Map();
  for (const declaration of collect(
    ast,
    node => ts.isVariableDeclaration(node) || ts.isParameter(node),
  )) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (symbol && !bindings.has(symbol)) bindings.set(symbol, `_recoveryVerify${bindings.size}`);
  }
  const transformed = ts.transform(ast, [
    context => {
      const visit = node => {
        if (ts.isIdentifier(node)) {
          const binding = bindings.get(checker.getSymbolAtLocation(node));
          if (binding) return ts.factory.createIdentifier(binding);
        }
        if (ts.isVariableDeclarationList(node))
          return ts.factory.createVariableDeclarationList(
            node.declarations.map(item => ts.visitNode(item, visit)),
            ts.NodeFlags.None,
          );
        return ts.visitEachChild(node, visit, context);
      };
      return visit;
    },
  ]);
  try {
    return transformSync(
      ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]),
      {
        minifySyntax: true,
        minifyWhitespace: true,
        legalComments: 'none',
      },
    ).code;
  } finally {
    transformed.dispose();
  }
}
function recoveryScope(source, file = '<runtime>') {
  const match = unique(
    [...source.matchAll(/\bfunction copyRecoverySource(?:\$\d+|\d+)?\s*\(/g)],
    file,
  );
  const parameters = match.index + match[0].lastIndexOf('(');
  const close = findMatchingDelimiter(source, parameters, '(', ')', file);
  const open = source.indexOf('{', close + 1);
  const end = findMatchingDelimiter(source, open, '{', '}', file) + 1;
  return { start: match.index, end, text: source.slice(match.index, end) };
}
function wrapFilter(nativeFilter, copyFs, copyPath) {
  return `((nativeFilter) => (from, to) => {
    const accepted = nativeFilter(from, to);
    if (!accepted || process.platform !== "win32") return accepted;
    if (!${copyFs}.lstatSync(from).isSymbolicLink()) return true;
    const target = ${copyFs}.readlinkSync(from);
    if (!${copyPath}.isAbsolute(target)) return true;
    let directory;
    try { directory = ${copyFs}.statSync(from).isDirectory(); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return true;
      throw error;
    }
    if (!directory) return true;
    ${copyFs}.mkdirSync(${copyPath}.dirname(to), { recursive: true });
    ${copyFs}.symlinkSync(target, to, "junction");
    return false;
  })(${nativeFilter})`;
}
function nativeFilterContract(filter, ast, file, copyFs, copyPath, directory) {
  if (!ts.isArrowFunction(filter) || filter.parameters.length !== 2)
    throw new Error(`${file}: native recovery filter changed`);
  const [from, to] = filter.parameters.map(item => item.name.getText(ast));
  const factDeclaration = unique(
    collect(
      filter,
      node =>
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) &&
        node.initializer.expression.name.text === 'get' &&
        ts.isPropertyAccessExpression(node.initializer.expression.expression) &&
        node.initializer.expression.expression.name.text === 'references' &&
        node.initializer.expression.expression.questionDotToken &&
        node.initializer.arguments[0]?.getText(ast) === from,
    ),
    file,
  );
  const fact = factDeclaration.name.getText(ast);
  const native = factDeclaration.initializer.expression.expression.expression.getText(ast);
  const retained = unique(
    collect(
      filter,
      node =>
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer),
    ),
    file,
  ).name.getText(ast);
  const link = unique(
    collect(
      filter,
      node =>
        ts.isCallExpression(node) &&
        /^linkPluginNativeReference(?:\$\d+|\d+)?$/.test(node.expression.getText(ast)),
    ),
    file,
  ).expression.getText(ast);
  const targets = unique(
    collect(
      filter,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'set' &&
        !node.expression.expression.getText(ast).endsWith('.references'),
    ),
    file,
  ).expression.expression.getText(ast);
  const relativeDeclaration = unique(collect(filter, node => ts.isVariableDeclaration(node) && node.initializer && ts.isConditionalExpression(node.initializer)), file);
  const relative = relativeDeclaration.name.getText(ast);
  const condition = relativeDeclaration.initializer;
  if (!ts.isCallExpression(condition.condition) || !ts.isCallExpression(condition.whenTrue) || condition.whenTrue.arguments.length !== 2) throw new Error(`${file}: native internal junction relocation changed`);
  const target = condition.condition.arguments[0].getText(ast);
  const boundary = condition.whenTrue.arguments[0].getText(ast);
  const insideRoot = condition.whenTrue.expression.getText(ast);
  const expected = `(${from}, ${to}) => {
    const ${fact} = ${native}?.references.get(${from});
    if (!${fact}) {
      if (${copyFs}.lstatSync(${from}).isSymbolicLink()) {
        const ${target} = ${copyFs}.readlinkSync(${from});
        const ${relative} = ${copyPath}.isAbsolute(${target}) ? ${insideRoot}(${boundary}, ${target}) : void 0;
        if (${relative} !== void 0) {
          ${copyFs}.mkdirSync(${copyPath}.dirname(${to}), { recursive: true, mode: 0o700 });
          ${copyFs}.symlinkSync(${copyPath}.relative(${copyPath}.dirname(${to}), ${copyPath}.join(${directory}, ${relative})), ${to}, ${copyFs}.statSync(${from}).isDirectory() ? "junction" : "file");
          return false;
        }
      }
      return true;
    }
    const ${retained} = { ...${fact}, sourceIdentity: ${fact}.capturedIdentity };
    if (${link}(${fact}.capturedPath, ${to}, ${retained}) === "hardlink") ${targets}.set(${to}, ${retained});
    ${native}.references.set(${from}, ${retained});
    return false;
  }`;
  if (canonical(filter.getText(ast)) !== canonical(expected))
    throw new Error(`${file}: native recovery reference/hardlink filter changed`);
}
function transformRecovery(source, file = '<runtime>') {
  assertCurrentPatchContract(source, MARKER, file, false);
  const scope = recoveryScope(source, file);
  // Validate the original scope before canonicalizing native minifier choices.
  // Verification must reject malformed code instead of repairing a partial patch.
  try {
    transformSync(scope.text, { loader: 'js' });
  } catch (error) {
    throw new Error(`${file}: native recovery syntax changed; rebuild pristine runtime`, {
      cause: error,
    });
  }
  const ast = parse(scope.text);
  const copy = unique(
    collect(
      ast,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'cpSync',
    ),
    file,
  );
  const fields = copy.arguments[2]?.properties;
  if (
    copy.arguments.length !== 3 ||
    fields?.length !== 3 ||
    canonical(
      fields.find(item => item.name?.getText(ast) === 'recursive')?.initializer?.getText(ast) ??
        'undefined',
    ) !== canonical('true') ||
    canonical(
      fields
        .find(item => item.name?.getText(ast) === 'verbatimSymlinks')
        ?.initializer?.getText(ast) ?? 'undefined',
    ) !== canonical('true')
  )
    throw new Error(`${file}: native recovery copy options changed`);
  const filter = unique(
    fields.filter(item => item.name?.getText(ast) === 'filter'),
    file,
  ).initializer;
  const copyFs = copy.expression.expression.getText(ast);
  const destination = copy.arguments[1].getText(ast);
  const directory = unique(collect(ast, node => ts.isVariableDeclaration(node) && node.initializer?.getText(ast) === destination), file).name.getText(ast);
  const pathBindings = [...new Set(collect(ast, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join' && node.arguments[0]?.getText(ast) === directory).map(node => node.expression.expression.getText(ast)))];
  const copyPath = unique(pathBindings, file);
  if (!/^[\w$]+\.directory$/.test(destination) || collect(ast, node => ts.isCallExpression(node) && /^createPluginNativeReferenceValidator(?:\$\d+|\d+)?$/.test(node.expression.getText(ast)) && node.arguments[0]?.getText(ast) === destination && node.arguments[1]?.getText(ast) === 'rootDir').length !== 1 || !scope.text.includes('PluginSourceRecoveryUnavailableError(') || !collect(ast, node => ts.isTryStatement(node) && node.catchClause).length) throw new Error(file + ': native recovery authority/disposal boundary changed');
  let originalFilter = filter;
  const patched = !ts.isArrowFunction(filter);
  if (patched) {
    if (!ts.isCallExpression(filter) || filter.arguments.length !== 1)
      throw new Error(`${file}: partial plugin recovery junction filter`);
    originalFilter = filter.arguments[0];
  }
  nativeFilterContract(originalFilter, ast, file, copyFs, copyPath, directory);
  const expected = wrapFilter(originalFilter.getText(ast), copyFs, copyPath);
  if (patched) {
    if (canonical(filter.getText(ast)) !== canonical(expected))
      throw new Error(
        `${file}: historical or partial plugin recovery junctions; rebuild pristine runtime`,
      );
    assertCurrentPatchContract(source, MARKER, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(MARKER))
    throw new Error(`${file}: partial plugin recovery junctions; rebuild pristine runtime`);
  const start = scope.start + filter.getStart(ast);
  const end = scope.start + filter.end;
  const transformed = source.slice(0, start) + expected + source.slice(end);
  const header = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return transformed.slice(0, header) + `// ${MARKER}\n` + transformed.slice(header);
}
function processTargets(root, verify) {
  const targets = findFilesContaining(root, 'function copyRecoverySource').filter(file =>
    /\bfunction copyRecoverySource(?:\$\d+|\d+)?\s*\(/.test(fs.readFileSync(file, 'utf8')),
  );
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 2 : 1;
  const relative = targets.map(file => path.relative(root, file).replace(/\\/g, '/'));
  if (
    targets.length !== expected ||
    relative.filter(file => /^dist\/plugin-generation-source-lookup-[\w-]+\.mjs$/.test(file)).length !==
      1
  )
    throw new Error(`plugin recovery junction topology changed: ${relative.join(', ')}`);
  const plans = targets.map(file => {
    const original = fs.readFileSync(file, 'utf8');
    const patched = transformRecovery(original, file);
    if (verify && original !== patched)
      throw new Error(`${file}: plugin recovery junction patch missing`);
    return { file, original, patched };
  });
  if (plans.some(plan => plan.original === plan.patched) && plans.some(plan => plan.original !== plan.patched))
    throw new Error('Mixed pristine and patched plugin recovery junctions; rebuild pristine runtime');
  return verify
    ? []
    : plans.flatMap(({ file, original, patched }) =>
        writeIfChanged(file, original, patched) ? [path.relative(root, file)] : [],
      );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { MARKER, recoveryScope, transformRecovery, canonical, wrapFilter },
};
