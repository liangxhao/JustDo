'use strict';

// Capability: separate a peer turn's transcript writer from its sending turn.
// Target: pristine openclaw@2026.9.8 bound agent-tool Gateway dispatcher.
// Scope: exit only the native transcript/CLI-history writer scopes for agent RPC.
// Safety: preserve the captured caller, opaque authority, guards, signal and arguments.
// Remove when: upstream detaches source transcript ownership after restoring caller context.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_PEER_TRANSCRIPT_SCOPE_V2026_9_8';
const NAME = 'callAgentToolGatewayRequestBound';
const NATIVE = 'justDoNativeCallAgentToolGatewayRequestBound';
const DETACH = 'justDoWithoutSourceTranscriptWriter';
const signature = `async function ${NAME}(`;
const wrapper = `async function ${NAME}(...args) {
  const dispatch = () => ${NATIVE}(...args);
  return args[0]?.method === "agent" ? ${DETACH}(dispatch) : dispatch();
}`;

function parse(source) {
  return ts.createSourceFile('runtime.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function canonical(node) {
  const transformed = ts.transform(node, [context => {
    const visit = item => {
      if (ts.isStringLiteral(item)) return ts.factory.createStringLiteral(item.text);
      if (ts.isIdentifier(item)) {
        const text = item.text.replace(/^(justDo\w+?|args|dispatch)\d+$/, '$1');
        if (text !== item.text) return ts.factory.createIdentifier(text);
      }
      return ts.visitEachChild(item, visit, context);
    };
    return visit;
  }]);
  try {
    return ts.createPrinter({ removeComments: true }).printNode(
      ts.EmitHint.Unspecified, transformed.transformed[0], parse(''),
    );
  } finally { transformed.dispose(); }
}

function nativeOwner(root) {
  const files = findFilesContaining(root, 'function captureOwnedTranscriptWriteAssertion(', { includeBundle: false })
    .filter(file => path.basename(file).startsWith('transcript-write-context-'));
  if (files.length !== 1) throw new Error('Peer transcript scope: native writer owner changed');
  const ast = parse(fs.readFileSync(files[0], 'utf8'));
  const aliases = ast.statements.flatMap(statement =>
    ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.filter(item => item.propertyName?.text === 'runWithoutOwnedSessionTranscriptWrites').map(item => item.name.text)
      : [],
  );
  if (aliases.length !== 1) throw new Error('Peer transcript scope: native detach export changed');
  return { module: './' + path.basename(files[0]), exportName: aliases[0] };
}

function verifyDetachBinding(ast, owner, file) {
  const module = isGatewayBundlePath(file) ? './dist/' + path.basename(owner.module) : owner.module;
  const bindings = ast.statements.flatMap(statement => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === module && statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)) {
      return statement.importClause.namedBindings.elements.filter(item =>
        item.propertyName?.text === owner.exportName && new RegExp(`^${DETACH}\\d*$`).test(item.name.text),
      );
    }
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.filter(item =>
      item.name.getText(ast) === DETACH && item.initializer?.getText(ast) === 'runWithoutOwnedSessionTranscriptWrites',
    );
    return [];
  });
  if (bindings.length !== 1) throw new Error(`${file}: partial peer transcript detach binding`);
}

function transform(source, file = '<runtime>', owner = { module: './transcript-write-context-native.mjs', exportName: 'l' }) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const ast = parse(source);
  const functions = name => ast.statements.filter(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  const entries = functions(NAME);
  const originals = functions(NATIVE);
  if (entries.length !== 1) throw new Error(`${file}: peer dispatch topology changed`);
  if (originals.length) {
    if (originals.length !== 1 || canonical(entries[0]) !== canonical(parse(wrapper).statements[0]))
      throw new Error(`${file}: historical or partial peer transcript scope`);
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    verifyDetachBinding(ast, owner, file);
    verifyNative(originals[0], ast, file);
    return source;
  }
  if (source.includes(CONTRACT) || source.includes(DETACH) || source.includes(NATIVE))
    throw new Error(`${file}: partial peer transcript scope; rebuild pristine runtime`);
  const entry = entries[0];
  verifyNative(entry, ast, file);
  const hasLocalOwner = functions('runWithoutOwnedSessionTranscriptWrites').length === 1;
  const binding = hasLocalOwner
    ? `const ${DETACH} = runWithoutOwnedSessionTranscriptWrites;\n`
    : `import { ${owner.exportName} as ${DETACH} } from ${JSON.stringify(owner.module)};\n`;
  const nameStart = entry.name.getStart(ast);
  const nameEnd = entry.name.end;
  const patched = source.slice(0, nameStart) + NATIVE + source.slice(nameEnd);
  const insertion = entry.getStart(ast);
  const result = patched.slice(0, insertion) + binding + wrapper + '\n' + patched.slice(insertion);
  const headerEnd = result.startsWith('#!') ? result.indexOf('\n') + 1 : 0;
  return result.slice(0, headerEnd) + `// ${CONTRACT}\n` + result.slice(headerEnd);
}

function verifyNative(entry, ast, file) {
  const body = entry.body?.getText(ast) ?? '';
  const request = entry.parameters[0]?.name.getText(ast);
  if (entry.parameters.length !== 6 || !request ||
      !body.includes(`${request}.assertDispatchCurrent`) || !body.includes(`${request}.sessionMutationCommitGuard`) ||
      !body.includes(`${request}.signal`) || !body.includes('dispatchGatewayMethodInProcess') ||
      !body.includes('runBoundInProcessGatewayCall') || !body.includes('withInProcessAgentRuntimeIdentity')) {
    throw new Error(`${file}: native peer dispatch safety boundary changed`);
  }
}

function processTargets(root, verify) {
  const owner = nativeOwner(root);
  const files = findFilesContaining(root, signature);
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 5 : 4;
  if (files.length !== expected) throw new Error(`Peer transcript scope topology changed: ${files.length}, expected ${expected}`);
  const changes = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    const next = transform(source, file, owner);
    if (verify && next !== source) throw new Error(`${file}: peer transcript scope patch missing`);
    return { file, source, next };
  });
  return changes.flatMap(({ file, source, next }) =>
    !verify && writeIfChanged(file, source, next) ? [path.relative(root, file)] : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT },
};
