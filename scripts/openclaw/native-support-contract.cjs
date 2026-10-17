'use strict';
const ts = require('typescript');
const esbuild = require('esbuild');
const acorn = require('acorn');

function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}
// esbuild removes comments, changes quotes and renames local bindings in the
// Gateway bundle. Compare the complete helper semantics after deterministic
// alpha-renaming, rather than accepting a marker or a few substrings.
function canonicalHelper(body, normalizeAfterMinify = true) {
  const sf = ts.createSourceFile(
    'helper.mjs',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const identifiers = new Set(nodes(sf, ts.isIdentifier).map(node => node.text));
  const bindings = new Map();
  const bind = name => {
    if (ts.isIdentifier(name) && !bindings.has(name.text)) {
      let generated = `__canonicalLocal${bindings.size}`;
      while (identifiers.has(generated)) generated += '_';
      identifiers.add(generated);
      bindings.set(name.text, generated);
    } else if (ts.isBindingPattern(name))
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  nodes(sf, node => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) bind(node.name);
    if (ts.isFunctionDeclaration(node) && node.parent !== sf && node.name) bind(node.name);
    return false;
  });
  const result = ts.transform(sf, [
    context => {
      const visit = node => {
        if (
          ts.isBindingElement(node) &&
          !node.propertyName &&
          !node.dotDotDotToken &&
          ts.isIdentifier(node.name) &&
          ts.isObjectBindingPattern(node.parent)
        )
          return ts.factory.updateBindingElement(
            node,
            node.dotDotDotToken,
            ts.factory.createIdentifier(node.name.text),
            ts.factory.createIdentifier(bindings.get(node.name.text) ?? node.name.text),
            node.initializer && ts.visitNode(node.initializer, visit),
          );
        if (ts.isShorthandPropertyAssignment(node))
          return ts.factory.createPropertyAssignment(
            node.name.text,
            ts.factory.createIdentifier(bindings.get(node.name.text) ?? node.name.text),
          );
        if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text);
        if (ts.isIdentifier(node) && node.text === 'undefined') return ts.factory.createVoidZero();
        if (
          ts.isIdentifier(node) &&
          bindings.has(node.text) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
          !(ts.isBindingElement(node.parent) && node.parent.propertyName === node)
        )
          return ts.factory.createIdentifier(bindings.get(node.text));
        return ts.visitEachChild(node, visit, context);
      };
      return root => ts.visitNode(root, visit);
    },
  ]);
  try {
    const normalized = esbuild.transformSync(
      ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]),
      { minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: false, target: 'node24' },
    ).code;
    // Syntax minification can remove intermediate bindings. Renumber the
    // retained bindings once more so source and already-minified code agree.
    if (normalizeAfterMinify) return canonicalHelper(normalized, false);
    // The comparison key uses non-JavaScript binding tokens. Fresh temporary
    // names avoid capturing free identifiers; token replacement then makes
    // that key independent of the temporary names chosen for either input.
    const generated = new Map([...bindings.values()].map((name, index) => [name, index]));
    const edits = [];
    for (const token of acorn.tokenizer(normalized, { ecmaVersion: 'latest', sourceType: 'module' })) {
      if (token.type.label === 'name' && generated.has(token.value))
        edits.push({ start: token.start, end: token.end, text: `\0${generated.get(token.value)}\0` });
    }
    return editNativeSource(normalized, edits);
  } finally {
    result.dispose();
  }
}

function parseNativeSource(source) {
  return ts.createSourceFile('native.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function oneNativeNode(values, label) {
  if (values.length !== 1) throw new Error(`${label}: native topology changed (${values.length})`);
  return values[0];
}

function extractNativeFunction(source, name, delimiter, suffixes = false) {
  const matches = [...source.matchAll(new RegExp(`\\bfunction ${name}${suffixes ? '(?:\\$\\d+|\\d+)?' : ''}\\(`, 'g'))];
  if (!matches.length) return null;
  const start = oneNativeNode(matches, name).index;
  const close = delimiter(source, source.indexOf('(', start), '(', ')', name);
  const end = delimiter(source, source.indexOf('{', close), '{', '}', name) + 1;
  const body = source.slice(start, end);
  const ast = parseNativeSource(body);
  if (ast.parseDiagnostics.length) throw new Error(`${name}: invalid native syntax`);
  return { start, end, body, ast, fn: oneNativeNode(ast.statements.filter(ts.isFunctionDeclaration), name) };
}

function editNativeSource(source, edits) {
  let end = source.length;
  for (const item of edits.sort((a, b) => b.start - a.start)) {
    if (item.end > end) throw new Error('Overlapping native edits');
    source = source.slice(0, item.start) + item.text + source.slice(item.end);
    end = item.start;
  }
  return source;
}

// Parse and discard one top-level statement at a time. A complete Gateway
// bundle can exceed 70 MB; retaining its full AST is unnecessary for these
// few declarations. Acorn owns statement, regex and template boundaries.
function nativeSupportDeclarations(source, names, lazy) {
  const declarations = new Map();
  const bindings = new Map();
  const initializers = { module: [], owner: [] };
  const bind = name => bindings.set(name, (bindings.get(name) || 0) + 1);
  const record = (name, value) => {
    if (!names.has(name)) return;
    const matches = declarations.get(name) || [];
    matches.push(value);
    declarations.set(name, matches);
  };
  const initializer = item => {
    if (!lazy || item.init?.type !== 'CallExpression') return;
    const call = item.init;
    const object = call.arguments[0];
    if (object?.type !== 'ObjectExpression') return;
    for (const property of object.properties) {
      if (property.key?.type !== 'Literal' || typeof property.key.value !== 'string') continue;
      const filename = property.key.value.replaceAll('\\', '/');
      const kind = filename.endsWith('/dist/native-support/' + lazy.module) ? 'module' :
        filename.endsWith('/dist/' + lazy.owner) ? 'owner' : null;
      if (!kind) continue;
      const callback = property.value;
      if (call.callee.type !== 'Identifier' || call.callee.name !== '__esm' || call.arguments.length !== 1 ||
        object.properties.length !== 1 || property.type !== 'Property' || property.computed || !property.method ||
        callback?.type !== 'FunctionExpression' || callback.async || callback.generator || callback.params.length !== 0)
        throw new Error('Bundled support lazy initializer shape changed');
      initializers[kind].push({ name: item.id.name, body: callback.body });
    }
  };
  class DeclarationParser extends acorn.Parser {
    parseTopLevel(node) {
      const exports = Object.create(null);
      node.body = [];
      while (this.type !== acorn.tokTypes.eof) {
        const statement = this.parseStatement(null, true, exports);
        const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
          bind(declaration.id.name);
          record(declaration.id.name, { type: 'function', start: declaration.start, end: declaration.end });
        } else if (declaration?.type === 'VariableDeclaration')
          for (const item of declaration.declarations)
            if (item.id.type === 'Identifier') {
              bind(item.id.name);
              record(item.id.name, {
                type: 'constant', start: item.init?.start, end: item.init?.end,
              });
              initializer(item);
            }
      }
      for (const name of Object.keys(this.undefinedExports))
        this.raiseRecoverable(this.undefinedExports[name].start, `Export '${name}' is not defined`);
      this.next();
      node.sourceType = this.options.sourceType;
      return this.finishNode(node, 'Program');
    }
  }
  try {
    DeclarationParser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (error) {
    throw new Error(`Bundled support function binding changed: invalid native syntax (${error.message})`);
  }
  return { declarations, bindings, initializers };
}

function verifyLazySupportInitializer(source, expected, declarations, bindings, initializers) {
  const module = oneNativeNode(initializers.module, 'support module initializer');
  const owner = oneNativeNode(initializers.owner, 'support runner initializer');
  if ([module.name, owner.name, '__esm'].some(name => bindings.get(name) !== 1))
    throw new Error('Bundled support lazy initializer binding changed');
  const constants = expected.filter(item => item.type === 'constant');
  const withoutStrictDirective = body => body[0]?.directive === 'use strict' ? body.slice(1) : body;
  const statements = withoutStrictDirective(module.body.body);
  if (statements.length !== constants.length || statements.some((statement, index) => {
    const expression = statement.expression;
    return statement.type !== 'ExpressionStatement' || expression.type !== 'AssignmentExpression' ||
      expression.operator !== '=' || expression.left.type !== 'Identifier' || expression.left.name !== constants[index].name;
  })) throw new Error('Bundled support lazy initialization is partial or stale');
  const actual = 'function initialize()' + source.slice(module.body.start, module.body.end);
  const strictDirective = statements === module.body.body ? '' : '"use strict";';
  const required = `function initialize(){${strictDirective}${constants.map(item => `${item.name}=${item.body};`).join('')}}`;
  if (canonicalHelper(actual) !== canonicalHelper(required))
    throw new Error('Bundled support lazy initialization is partial or stale');
  const ownerStatements = withoutStrictDirective(owner.body.body);
  const calls = ownerStatements.filter(statement => statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'CallExpression' && statement.expression.callee.type === 'Identifier' &&
    statement.expression.callee.name === module.name && statement.expression.arguments.length === 0);
  const references = [...acorn.tokenizer(source.slice(owner.body.start, owner.body.end), { ecmaVersion: 'latest' })]
    .filter(token => token.type.label === 'name' && token.value === module.name);
  const firstNonInit = ownerStatements.findIndex(statement => statement.type !== 'ExpressionStatement' ||
    statement.expression.type !== 'CallExpression' || statement.expression.callee.type !== 'Identifier' ||
    !/^init_[\w$]+$/.test(statement.expression.callee.name) || statement.expression.arguments.length !== 0);
  const prefix = firstNonInit < 0 ? ownerStatements : ownerStatements.slice(0, firstNonInit);
  if (calls.length !== 1 || references.length !== 1 || !prefix.includes(calls[0]))
    throw new Error('Bundled support runner initialization is not unconditional and unique');
  for (const [index, item] of constants.entries()) {
    const matches = declarations.get(item.name) || [];
    if (matches.length !== 1 || matches[0].type !== 'constant' || matches[0].start !== undefined)
      throw new Error(`Bundled support constant binding changed: ${item.name}`);
    const value = statements[index].expression.right;
    matches[0] = { type: 'constant', start: value.start, end: value.end };
  }
}

// Both scoped finalization and recovery require real, complete top-level
// declarations. Comments, nested functions and initializer aliases are not
// evidence of those bindings. The native owner extractor keeps its old API.
function verifyNativeSupportBindings(source, expectedSource, _delimiter, lazy) {
  const ast = parseNativeSource(expectedSource);
  if (ast.parseDiagnostics.length) throw new Error('Invalid native support module syntax');
  const expected = [];
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node)) {
      if (!node.name) throw new Error('Native support function must have a static name');
      expected.push({ name: node.name.text, type: 'function', body: node.getText(ast).replace(/^export\s+/, '') });
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          throw new Error('Native support constant must have a static name and initializer');
        expected.push({ name: declaration.name.text, type: 'constant', body: declaration.initializer.getText(ast) });
      }
    } else throw new Error('Native support must remain a static pure module');
  }
  if (lazy && [lazy.module, lazy.owner].some(name => typeof name !== 'string' || !/^[\w.-]+\.mjs$/.test(name)))
    throw new Error('Native support initializer basenames must be explicit');
  const { declarations, bindings, initializers } = nativeSupportDeclarations(source, new Set(expected.map(item => item.name)), lazy);
  if (expected.some(item => item.type === 'constant' && declarations.get(item.name)?.[0]?.start === undefined)) {
    if (!lazy) throw new Error('Bundled support constant binding changed: missing static initializer');
    verifyLazySupportInitializer(source, expected, declarations, bindings, initializers);
  }
  for (const item of expected) {
    const matches = declarations.get(item.name) || [];
    const actual = matches[0];
    if (matches.length !== 1 || actual.type !== item.type || actual.start === undefined)
      throw new Error(`Bundled support ${item.type} binding changed: ${item.name}`);
    const wrap = body => item.type === 'function' ? body : `function definition(){return (${body});}`;
    if (canonicalHelper(wrap(source.slice(actual.start, actual.end))) !== canonicalHelper(wrap(item.body)))
      throw new Error(`Bundled support ${item.type} is partial or stale: ${item.name}`);
  }
}

module.exports = {
  canonicalHelper,
  nodes,
  parseNativeSource,
  oneNativeNode,
  extractNativeFunction,
  editNativeSource,
  verifyNativeSupportBindings,
};
