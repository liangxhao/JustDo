'use strict';
const ts = require('typescript');
const esbuild = require('esbuild');

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
  const bindings = new Map();
  const bind = name => {
    if (ts.isIdentifier(name) && !bindings.has(name.text))
      bindings.set(name.text, `local${bindings.size}`);
    else if (ts.isBindingPattern(name))
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
    return normalizeAfterMinify ? canonicalHelper(normalized, false) : normalized;
  } finally {
    result.dispose();
  }
}

module.exports = { canonicalHelper };
