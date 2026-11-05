'use strict';

// Capability: retire active work accepted before the current JustDo app process.
// Target: openclaw@2026.10.7 main-session recovery. The upstream durable task registry was removed.
// Scope: running main sessions; one host epoch survives Gateway restarts.
// Safety: prior-app work becomes terminal before OpenClaw can dispatch model recovery.
// Remove when: upstream exposes a host-instance recovery epoch in durable session state.

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { collect, one, parse } = require('./prepared-read-patch-shapes.js');
const {
  countOccurrences,
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  writeIfChanged,
} = require('./_patch-utils.js');

const MAIN_CONTRACT = 'RUNTIME_APP_STARTUP_MAIN_RECOVERY_BOUNDARY_V2026_10_7';
const APP_STARTED_AT_ENV = 'JUSTDO_APP_STARTED_AT_MS';
const MAIN_READ_HELPER = 'readJustDoMainAppStartedAtMs';
const MAIN_PRIOR_HELPER = 'isJustDoPriorAppMainSession';
const MAIN_SETTLE_HELPER = 'settleJustDoPriorAppMainSession';

const MAIN_HELPER_BLOCK = `// Only Gateway restarts inside this host epoch recover.
function ${MAIN_READ_HELPER}() {
  const value = Number(process.env.${APP_STARTED_AT_ENV});
  return Number.isFinite(value) && value > 0 ? value : void 0;
}
function ${MAIN_PRIOR_HELPER}(entry) {
  const appStartedAtMs = ${MAIN_READ_HELPER}();
  if (appStartedAtMs === void 0) return false;
  const startedAt = Number(entry?.startedAt);
  return !Number.isFinite(startedAt) || startedAt < appStartedAtMs;
}
async function ${MAIN_SETTLE_HELPER}(params) {
  const endedAt = Date.now();
  let settled = false;
  await applySessionEntryExactReplacements({
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (!entry || entry.sessionId !== params.sessionId || entry.status !== "running" ||
          entry.abortedLastRun !== true || !${MAIN_PRIOR_HELPER}(entry)) {
        return { result: false };
      }
      Object.assign(entry, {
        ...buildMainSessionRecoverySettlementPatch({ entry, recordTerminalSource: false }),
        status: "failed",
        activeWriterRunId: void 0,
        lifecycleRunId: void 0,
        lastRunId: resolveRestartRecoveryTerminalClientRunId(entry),
        abortedLastRun: false,
        endedAt,
        lastRunError: "interrupted by JustDo app restart",
        runtimeMs: typeof entry.startedAt === "number" ? Math.max(0, endedAt - entry.startedAt) : void 0,
        updatedAt: endedAt
      });
      settled = true;
      return { result: true, replacements: [{ sessionKey: params.sessionKey, entry }] };
    }
  });
  return settled;
}
${MAIN_READ_HELPER}.${MAIN_CONTRACT} = true;
`;

function isPriorAppMainSession(entry, appStartedAtMs) {
  if (appStartedAtMs === undefined) return false;
  const startedAt = Number(entry?.startedAt);
  return !Number.isFinite(startedAt) || startedAt < appStartedAtMs;
}

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}

function mainTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'async function recoverStore(',
    'buildMainSessionRecoverySettlementPatch',
    'resolveRestartRecoveryTerminalClientRunId',
  ]);
}

function transformMain(content, filePath) {
  assertCurrentPatchContract(content, MAIN_CONTRACT, filePath, false);
  const markerCount = countOccurrences(content, MAIN_CONTRACT);
  const hasReadHelper = content.includes(`function ${MAIN_READ_HELPER}(`);
  const hasPriorHelper = content.includes(`function ${MAIN_PRIOR_HELPER}(`);
  const hasSettleHelper = content.includes(`async function ${MAIN_SETTLE_HELPER}(`);
  if (markerCount === 1 && hasReadHelper && hasPriorHelper && hasSettleHelper) {
    assertMainContracts(content, filePath);
    return content;
  }
  if (markerCount > 0 || hasReadHelper || hasPriorHelper || hasSettleHelper) {
    throw new Error(`${filePath}: historical or partial app-start main recovery patch detected`);
  }

  const bindings = recoverStoreBindings(content, filePath);
  const { range, observedIndex } = bindings;
  const guard = mainRecoveryGuard(bindings);
  const updated =
    content.slice(0, range.signatureIndex) +
    MAIN_HELPER_BLOCK +
    content.slice(range.signatureIndex, observedIndex) +
    guard +
    '\n' +
    content.slice(observedIndex);
  assertMainContracts(updated, filePath);
  return updated;
}

function mainRecoveryGuard({
  entryName,
  sessionKeyName,
  parameter,
  dedupeName,
  resultName,
  decisionName,
}) {
  return `if (${MAIN_PRIOR_HELPER}(${entryName})) {
      const priorAppSettled = await ${MAIN_SETTLE_HELPER}({
        sessionId: ${entryName}.sessionId,
        sessionKey: ${sessionKeyName},
        storePath: ${parameter}.storePath
      });
      if (priorAppSettled) {
        ${parameter}.handledSessionKeys.add(${dedupeName});
        ${resultName}.settled++;
        ${decisionName} = { decision: "settled", reason: "prior_app_interrupted", nextOwner: "none" };
        mainSessionRecoveryLog.info(\`interrupted prior-app main session: \${${sessionKeyName}}\`);
      } else {
        ${resultName}.failed++;
        ${decisionName} = { decision: "blocked", reason: "prior_app_settlement_unconfirmed", nextOwner: "operator" };
      }
      continue;
    }`;
}

function recoverStoreBindings(content, filePath) {
  const range = findRecoverStoreRange(content, filePath);
  const source = parse(content.slice(range.signatureIndex, range.bodyEnd + 1));
  const owner = source.statements[0];
  const exact = (values, label) => one(values, `${filePath}: recovery ${label}`);
  if (
    !ts.isFunctionDeclaration(owner) ||
    !owner.body ||
    owner.parameters.length !== 1 ||
    !ts.isIdentifier(owner.parameters[0].name)
  ) {
    throw new Error(`${filePath}: recovery parameter binding changed`);
  }
  const declarations = block =>
    block.statements.flatMap(statement =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
  const hasProperties = (node, names) =>
    node &&
    ts.isObjectLiteralExpression(node) &&
    names.every(name =>
      node.properties.some(
        property => ts.isPropertyAssignment(property) && property.name.getText(source) === name,
      ),
    );
  const result = exact(
    declarations(owner.body).filter(
      declaration =>
        ts.isIdentifier(declaration.name) &&
        hasProperties(declaration.initializer, ['started', 'settled', 'failed', 'skipped']),
    ),
    'result binding',
  );
  const loop = exact(
    owner.body.statements.filter(
      statement =>
        ts.isForOfStatement(statement) &&
        ts.isVariableDeclarationList(statement.initializer) &&
        statement.initializer.declarations.length === 1 &&
        ts.isObjectBindingPattern(statement.initializer.declarations[0].name),
    ),
    'session loop',
  );
  if (!ts.isBlock(loop.statement)) throw new Error(`${filePath}: recovery loop body changed`);
  const pattern = loop.initializer.declarations[0].name;
  const element = property =>
    exact(
      pattern.elements.filter(
        binding =>
          ts.isIdentifier(binding.name) &&
          (binding.propertyName?.getText(source) ?? binding.name.text) === property,
      ),
      `${property} binding`,
    );
  const sessionKeyName = element('sessionKey').name.text;
  const loadedEntryName = element('entry').name.text;
  // Follow the loop's actual entry source, never the first unrelated declaration
  // after a stop check (the native dispatch target has no sessionId/startedAt).
  const entry = exact(
    declarations(loop.statement).filter(
      declaration =>
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isIdentifier(declaration.initializer) &&
        declaration.initializer.text === loadedEntryName,
    ),
    'entry binding',
  );
  const bindingNames = name =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap(element =>
          ts.isBindingElement(element) ? bindingNames(element.name) : [],
        );
  exact(
    collect(
      loop.statement,
      node => ts.isVariableDeclaration(node) && bindingNames(node.name).includes(entry.name.text),
    ),
    'unshadowed entry binding',
  );
  const decision = exact(
    declarations(loop.statement).filter(
      declaration =>
        ts.isIdentifier(declaration.name) &&
        hasProperties(declaration.initializer, ['decision', 'reason', 'nextOwner']),
    ),
    'decision binding',
  );
  const attempt = exact(loop.statement.statements.filter(ts.isTryStatement), 'attempt block');
  const observed = exact(
    attempt.tryBlock.statements.filter(
      statement =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          declaration =>
            declaration.initializer &&
            ts.isAwaitExpression(declaration.initializer) &&
            ts.isCallExpression(declaration.initializer.expression) &&
            ts.isIdentifier(declaration.initializer.expression.expression) &&
            declaration.initializer.expression.expression.text === 'commitMainSessionRecovery',
        ),
    ),
    'native observe statement',
  );
  const dedupe = exact(
    collect(
      attempt.tryBlock,
      node =>
        ts.isCallExpression(node) &&
        node.getStart(source) < observed.getStart(source) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'has' &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === 'handledSessionKeys' &&
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0]),
    ),
    'dedupe binding',
  );
  return {
    range,
    source,
    attempt,
    observedIndex: range.signatureIndex + observed.getStart(source),
    observedStart: observed.getStart(source),
    parameter: owner.parameters[0].name.text,
    resultName: result.name.text,
    entryName: entry.name.text,
    sessionKeyName,
    dedupeName: dedupe.arguments[0].text,
    decisionName: decision.name.text,
  };
}

function findRecoverStoreRange(content, filePath) {
  const signature = 'async function recoverStore(';
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    throw new Error(`${filePath}: recoverStore target is missing or ambiguous`);
  }
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: recoverStore parameters`,
  );
  let bodyStart = parameterEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: recoverStore body`,
  );
  return { signatureIndex, bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
}

function assertMainContracts(content, filePath) {
  const helperStart = content.indexOf(`async function ${MAIN_SETTLE_HELPER}(`);
  const helperBody = content.indexOf('{', helperStart);
  const helperEnd = findMatchingDelimiter(
    content,
    helperBody,
    '{',
    '}',
    `${filePath}: settle helper`,
  );
  const helper = content.slice(helperBody, helperEnd);
  if (
    !helper.includes('await applySessionEntryExactReplacements({') ||
    /\bapplySessionEntryReplacements\s*\(/u.test(helper)
  ) {
    throw new Error(
      `${filePath}: historical or partial app-start main recovery patch detected; rebuild from pristine`,
    );
  }
  for (const required of [
    MAIN_CONTRACT,
    `process.env.${APP_STARTED_AT_ENV}`,
    `function ${MAIN_PRIOR_HELPER}(`,
    `async function ${MAIN_SETTLE_HELPER}(`,
    'interrupted by JustDo app restart',
    'interrupted prior-app main session',
  ]) {
    if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
  }
  const bindings = recoverStoreBindings(content, filePath);
  const guards = collect(
    bindings.attempt.tryBlock,
    node =>
      ts.isIfStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === MAIN_PRIOR_HELPER,
  );
  if (
    guards.length !== 1 ||
    guards[0].parent !== bindings.attempt.tryBlock ||
    guards[0].getStart(bindings.source) > bindings.observedStart ||
    canonicalHelper(`async function boundary(){for(;;){${guards[0].getText(bindings.source)}}}`) !==
      canonicalHelper(`async function boundary(){for(;;){${mainRecoveryGuard(bindings)}}}`)
  ) {
    throw new Error(
      `${filePath}: historical or partial app-start main recovery patch detected; rebuild from pristine`,
    );
  }
}

function applyPatch(runtimeDir) {
  const files = mainTargets(runtimeDir);
  if (files.length !== expectedCount(runtimeDir))
    throw new Error('main recovery target count changed');
  const plans = files.map(file => {
    const before = fs.readFileSync(file, 'utf8');
    const after = transformMain(before, file);
    return { file, before, after };
  });
  if (plans.some(p => p.before === p.after) && plans.some(p => p.before !== p.after))
    throw new Error('Mixed pristine and patched main recovery targets');
  return plans.flatMap(({ file, before, after }) => {
    return writeIfChanged(file, before, after) ? [path.relative(runtimeDir, file)] : [];
  });
}
function verifyPatch(runtimeDir) {
  const files = mainTargets(runtimeDir);
  if (files.length !== expectedCount(runtimeDir))
    throw new Error('main recovery target count changed');
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (transformMain(content, file) !== content)
      throw new Error(file + ': recovery boundary missing');
  }
}
module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { MAIN_CONTRACT, isPriorAppMainSession, transformMain },
};
