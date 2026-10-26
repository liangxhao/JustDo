'use strict';

// Capability: publish history responses only from a canonical-ready synchronous read frame.
// Target: pristine openclaw@2026.10.7 canonical deferral owner and chat history/startup handler.
// Scope: reject publication after an inner reader swallowed the native deferred signal.
// Safety: reuse the same scope and private signal; preserve native sharing, cancellation and retry.
// Remove when: upstream gates response publication on its current canonical-read frame.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');
const {
  functionRange,
  parse,
  one,
  same,
  prepend,
  assertTargetPaths,
} = require('./prepared-read-patch-shapes.js');
const CONTRACT = 'RUNTIME_PREPARED_HISTORY_PUBLICATION_V2026_10_7';
const HELPER = 'assertSessionReadPublicationReady';
const HANDLER = 'handleChatHistoryRequest';
const HELPER_BODY = `function ${HELPER}() { if (deferral.current?.pending) throw new CanonicalSessionValidationDeferred(); }`;
const RESPOND = /^respond(?:\d+|\$\d+)?$/;
const PREPARED_RESPOND = /^preparedRespond(?:\d+|\$\d+)?$/;

function assertBinding(source, kind, modulePath, file) {
  const ast = parse(source);
  const matches = ast.statements.filter(node => {
    if (kind === 'import') {
      if (!ts.isImportDeclaration(node)) return false;
      const bindings = node.importClause?.namedBindings;
      return (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          element =>
            (element.propertyName ?? element.name).text === HELPER || element.name.text === HELPER,
        )
      );
    }
    return (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.some(
        element =>
          (element.propertyName ?? element.name).text === HELPER || element.name.text === HELPER,
      )
    );
  });
  const declaration = one(matches, `${file}: prepared publication ${kind}`);
  const elements =
    kind === 'import'
      ? declaration.importClause.namedBindings.elements
      : declaration.exportClause.elements;
  const binding = one(
    elements.filter(
      element =>
        (element.propertyName ?? element.name).text === HELPER || element.name.text === HELPER,
    ),
    file,
  );
  if (
    binding.name.text !== HELPER ||
    (binding.propertyName && binding.propertyName.text !== HELPER) ||
    (kind === 'import'
      ? declaration.moduleSpecifier.text !== modulePath
      : declaration.moduleSpecifier !== undefined)
  )
    throw new Error(`${file}: prepared publication ${kind} binding changed`);
}

function transform(
  source,
  file = '<runtime>',
  ownerImport = './session-canonical-key-BT9-Ydgk.mjs',
) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const owner = source.includes('function withCanonicalSessionValidationDeferral(');
  const handler = source.includes(`function ${HANDLER}(`);
  if (!owner && !handler) throw new Error(`${file}: prepared history boundary missing`);
  let next = source;
  let current = 0;
  let pristine = 0;
  if (owner) {
    if (source.includes(`function ${HELPER}(`)) {
      if (canonicalHelper(functionRange(source, HELPER).text) !== canonicalHelper(HELPER_BODY))
        throw new Error(`${file}: partial prepared history publication helper`);
      if (!isGatewayBundlePath(file)) assertBinding(source, 'export', undefined, file);
      current++;
    } else {
      if (source.includes(HELPER))
        throw new Error(`${file}: partial prepared history publication owner`);
      const at = functionRange(next, 'withCanonicalSessionValidationDeferral').start;
      next = next.slice(0, at) + HELPER_BODY + '\n' + next.slice(at);
      if (!isGatewayBundlePath(file)) next += `\nexport { ${HELPER} };\n`;
      pristine++;
    }
  }
  if (handler) {
    const range = functionRange(next, HANDLER);
    const ast = parse('async ' + range.text);
    const fn = ast.statements[0];
    const binding = one(
      fn.parameters[0]?.name.elements?.filter(
        e => (e.propertyName ?? e.name).getText(ast) === 'respond',
      ) ?? [],
      file,
    );
    const boundName = binding.name.getText(ast);
    const first = fn.body.statements[0];
    const wrapperName =
      PREPARED_RESPOND.test(boundName) && ts.isVariableStatement(first)
        ? first.declarationList.declarations[0]?.name.getText(ast)
        : boundName;
    const declaration =
      PREPARED_RESPOND.test(boundName) && ts.isVariableStatement(first)
        ? first.declarationList.declarations[0]
        : undefined;
    const responseName =
      declaration && ts.isArrowFunction(declaration.initializer)
        ? declaration.initializer.parameters[0]?.name.getText(ast)
        : 'response';
    const wrapper = `const ${wrapperName} = (...${responseName}) => { ${HELPER}(); return ${PREPARED_RESPOND.test(boundName) ? boundName : 'preparedRespond'}(...${responseName}); };`;
    if (PREPARED_RESPOND.test(boundName)) {
      if (!RESPOND.test(wrapperName)) throw new Error(`${file}: prepared response binding changed`);
      if (!same('(() => {const ' + declaration.getText(ast) + ';})', '(() => {' + wrapper + '})'))
        throw new Error(`${file}: partial prepared history response wrapper`);
      if (!isGatewayBundlePath(file)) assertBinding(source, 'import', ownerImport, file);
      current++;
    } else {
      if (
        !RESPOND.test(boundName) ||
        range.text.includes('preparedRespond') ||
        source.includes(HELPER)
      )
        throw new Error(`${file}: historical or partial prepared history handler`);
      const offset = range.start - 'async '.length;
      const insert = offset + fn.body.statements.pos;
      next = next.slice(0, insert) + '\n' + wrapper + '\n' + next.slice(insert);
      const at = offset + binding.getStart(ast);
      next = next.slice(0, at) + 'respond: preparedRespond' + next.slice(offset + binding.end);
      if (!isGatewayBundlePath(file))
        next = prepend(next, `import { ${HELPER} } from ${JSON.stringify(ownerImport)};\n`);
      pristine++;
    }
  }
  if (current && pristine)
    throw new Error(`${file}: partially applied prepared history publication`);
  if (current) {
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT))
    throw new Error(`${file}: partial prepared history publication marker`);
  return prepend(next, `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundlePaths = fs.existsSync(path.join(root, 'gateway-bundle.mjs'))
    ? ['gateway-bundle.mjs']
    : [];
  const groups = ['withCanonicalSessionValidationDeferral', HANDLER].map(name =>
    findFilesContaining(root, `function ${name}(`),
  );
  for (const [index, files] of groups.entries())
    assertTargetPaths(
      root,
      files,
      [
        index === 0
          ? 'dist/session-canonical-key-BT9-Ydgk.mjs'
          : 'dist/chat-history-handler-DIyNX568.mjs',
        ...bundlePaths,
      ],
      'Prepared history publication',
    );
  const ownerFile = one(
    groups[0].filter(file => !isGatewayBundlePath(file)),
    'prepared history owner',
  );
  const plans = [...new Set(groups.flat())].map(file => {
    const source = fs.readFileSync(file, 'utf8');
    const relative = './' + path.relative(path.dirname(file), ownerFile).replaceAll(path.sep, '/');
    return { file, source, next: transform(source, file, relative) };
  });
  const native = plans.filter(p => !isGatewayBundlePath(p.file));
  if (
    native.some(p => p.source.includes(CONTRACT)) &&
    native.some(p => !p.source.includes(CONTRACT))
  )
    throw new Error('Mixed pristine and patched prepared history publication');
  const bundle = plans.find(p => isGatewayBundlePath(p.file));
  if (bundle && native.every(p => p.source.includes(CONTRACT)) !== (bundle.source === bundle.next))
    throw new Error('Source and bundle prepared history publication are partially applied');
  if (verify && plans.some(p => p.source !== p.next))
    throw new Error('Prepared history publication guard missing');
  return plans.flatMap(p =>
    !verify && writeIfChanged(p.file, p.source, p.next) ? [path.relative(root, p.file)] : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT, HELPER, HELPER_BODY },
};
