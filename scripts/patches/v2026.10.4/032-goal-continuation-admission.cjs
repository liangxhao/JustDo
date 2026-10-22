'use strict';

// Capability: admit automatic Goal turns only after exact native settlement and handoff arbitration.
// Target: locked pristine openclaw@2026.10.4 agent ingress and native session lifecycle owners.
// Scope: backend-only conditional agent requests; existing session metadata and native admissions.
// Safety: preserve Stop, dedupe, native wake ownership and uncertain commit outcomes.
// Remove when: native agent ingress supplies an atomic conditional Goal acceptance and exact observation.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const {
  findFilesContaining,
  isGatewayBundlePath,
  nativeSupportModule,
  nativeSupportImport,
  writeIfChanged,
} = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same, prepend, assertTargetPaths } = require('./prepared-read-patch-shapes.js');
const { createGoalContinuationRuntime } = require('../../../src/main/openclaw/runtime/native-support/goal-continuation.mjs');

const CONTRACT = 'RUNTIME_GOAL_CONTINUATION_ADMISSION_V2026_10_4';
const SUPPORT = 'goal-continuation.mjs';
const SUPPORT_SOURCE = path.resolve(__dirname, '../../../src/main/openclaw/runtime/native-support', SUPPORT);
const TARGETS = {
  schema: 'dist/src-l2dWvEsN.mjs',
  preflight: 'dist/agent-request-preflight-FZXZl9w-.mjs',
  turn: 'dist/agent-turn-service-CVZmpyt7.mjs',
  terminal: 'dist/session-event-payload-XAYqqAQG.mjs',
  lock: 'dist/session-lifecycle-admission-GoxISURZ.mjs',
  registry: 'dist/subagent-registry-Bz1huk54.mjs',
  describe: 'dist/sessions-read-DziXtPpO.mjs',
  private: 'dist/session-accessor.sqlite-transcript-write-tYk0mJFG.mjs',
};
const ANCHORS = {
  schema: 'const AgentParamsSchema = closedObject(',
  preflight: 'function prepareAgentRequestPreflight(',
  turn: 'function prepareAgentRunDispatch(',
  terminal: 'function persistGatewaySessionLifecycleEvent(',
  lock: 'function runExclusiveSessionLifecycle(',
  registry: 'const subagentLifecycleController = new SubagentLifecycleController(',
  describe: 'const sessionByKeyReadHandlers =',
  private: 'const PRIVATE_SESSION_ENTRY_KEYS =',
};
const BINDINGS = {
  preflight: 'const goalPreflight = createGoalContinuationRuntime(null);',
  turn: `const goalAdmission = createGoalContinuationRuntime({
    admissionError: error => new SessionMutationAuthorizationChangedError(error),
    generation: () => getAgentEventLifecycleGeneration(),
    competingWork: isCompetingSessionWorkAdmissionActive,
    pendingQueue: hasPendingFollowupQueueWork,
    replyActive: key => replyRunRegistry.isActive(key),
    nativeHandoff: hasGoalContinuationNativeHandoff,
    patchEntry: patchSessionEntryTarget,
    withLifecycleLock: goalContinuationLifecycle
  });`,
  terminal: 'const goalTerminal = createGoalContinuationRuntime({ generation: () => getAgentEventLifecycleGeneration() });',
  registry: 'const goalRegistry = createGoalContinuationRuntime(null);',
  describe: 'const goalObservation = createGoalContinuationRuntime({ generation: () => getAgentEventLifecycleGeneration() });',
};
const IMPORTS = {
  turn: [
    'import { p as isCompetingSessionWorkAdmissionActive, goalContinuationLifecycle } from "./session-lifecycle-admission-GoxISURZ.mjs";',
    'import { c as hasPendingFollowupQueueWork } from "./state-22A-PMUF.mjs";',
    'import { g as replyRunRegistry } from "./reply-run-registry.registry-5e3UVXZS.mjs";',
    'import { hasGoalContinuationNativeHandoff } from "./subagent-registry-Bz1huk54.mjs";',
  ],
  describe: ['import { l as getAgentEventLifecycleGeneration } from "./agent-events-GvNTkbe3.mjs";'],
};
const NATIVE_ACCEPTED = `followupCompletion?.markAccepted(params.runId);
  params.markAgentRunAccepted(true);
  adoptedParentResume = undefined;
  setGatewayDedupeEntries({ dedupe: params.context.dedupe, keys: params.agentDedupeKeys,
    entry: { ts: Date.now(), ok: true, payload: { ...accepted, controlUiVisible,
      dedupeKeys: params.agentDedupeKeys, ownerConnId: params.ownerConnId, ownerDeviceId: params.ownerDeviceId } } });
  assertInputAdmissionCurrent = undefined;
  params.io.emitAcceptance([true, accepted, undefined], { runId: params.runId });
  capturedOperator.armCancellation();`;
const NATIVE_EXPORTS = {
  lock: '{ normalizeSessionIdentities as C, clearSessionStoreCacheForTest as S, startSessionWorkAdmissionInterruption as _, collectActiveSessionLifecycleMutationIdentities as a, consumeSessionWorkAdmissionHandoff as b, getActiveSessionWorkAdmissionCount as c, hasOnlySessionLifecycleMutationKindActive as d, interruptSessionWorkAdmissions as f, runExclusiveSessionLifecycleMutation as g, isSessionWorkAdmissionActive as h, closeSessionWorkAdmissions as i, getSessionWorkAdmissionOwnerRelease as l, isSessionLifecycleMutationActive as m, beginSessionWorkAdmission as n, collectActiveSessionWorkAdmissions as o, isCompetingSessionWorkAdmissionActive as p, captureGatewaySessionWorkAdmissions as r, getActiveSessionLifecycleMutationCount as s, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS as t, getSessionWorkAdmissionRelease as u, waitForSessionWorkAdmissionRelease as v, runExclusiveSessionStoreWrite as x, cancelSessionWorkAdmissionHandoff as y }',
  registry: '{ settleRequesterAfterSessionSpawns as A, prependAgentSteeringPrompt as B, registerSubagentRun as C, resumeSubagentRun as D, replaceSubagentRunAfterSteerCore as E, createStructuredOutputTool as F, captureSubagentExecution as I, getSubagentExecutionCleanup as L, SubagentSessionCleanupRevocationChangedError as M, persistSubagentAbortedLastRun as N, scheduleSubagentRegistrySweep as O, prepareSubagentKillSession as P, resolveSubagentKillTargetState as R, recordSwarmStructuredOutput as S, releaseSubagentRunKillClaim as T, listUnsettledRequesterChildren as _, adoptSubagentRunForRequesterTurn as a, prepareSubagentRunsByRunIds as b, claimSubagentYield as c, finalizeInterruptedSubagentRun as d, getSubagentRunByRunId as f, listSwarmRunsForGroup as g, leasePendingAgentSteeringItems as h, adoptPausedSubagentRunIntoSuccessor as i, startQueuedSubagentRun as j, settleFailedQueuedSubagentLaunch as k, completeCollectorLaunchCleanup as l, initSubagentRegistry as m, activateSubagentRegistry as n, cancelSubagentRequesterSettleWake as o, getSwarmRunByLaunchReplayKey as p, adoptPausedSubagentRunForFollowUp as r, claimSubagentRunKill as s, ackPendingAgentSteeringItems as t, countActiveRunsForSession as u, markRequesterTurnYielded as v, releasePendingAgentSteeringItems as w, prepareSubagentSessionCleanupRevocation as x, markSubagentRunTerminated as y, SUBAGENT_KILL_TASK_ERROR as z }',
};
const PLUGIN_EXECUTION_EXPORTS = '{ justDoCreatePluginExecution, justDoPluginExecutionCurrent, justDoDescribePluginRun, justDoObservePluginLifecycle, justDoUpdatePluginExecution, justDoRegisterManagedToolCleanup, justDoManagedToolCleanups, justDoRequireManagedHarness, justDoAssertManagedPlacement, justDoManagedRunEnabled, justDoValidateManagedExecPolicy, justDoFinishManagedRun, justDoPreparePluginCancel }';

function canonical(value) {
  return canonicalHelper(`function seam(){${value}}`);
}

function tokens(value) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard,
    value.replace(/\bundefined\b/g, 'void 0'));
  const result = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    result.push(token === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText());
  if (result.at(-1) === ';') result.pop();
  return result.join('\0');
}

function editNode(source, scope, original, replacement, state, label) {
  let range = scope ? (scope.startsWith('variable:') ? null : functionRange(source, scope)) : { start: 0, text: source };
  if (!range) {
    const tree = parse(source);
    const variable = one(collect(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === scope.slice(9)), scope);
    range = { start: variable.initializer.getStart(tree), text: variable.initializer.getText(tree) };
  }
  const ast = parse(range.text);
  const originalCanonical = tokens(original);
  const replacementCanonical = tokens(replacement);
  const matches = [];
  const prefixes = [original, replacement].map(value => value.trim().match(/^(?:[\w$]+|\.\.\.|\S)/)[0]);
  const add = (start, end) => {
    const text = range.text.slice(start, end);
    if (!prefixes.some(prefix => text.startsWith(prefix))) return;
    if (text.length > Math.max(original.length, replacement.length) * 3 + 100) return;
    const value = tokens(text);
    if (value === originalCanonical || value === replacementCanonical)
      matches.push({ start, end, current: value === replacementCanonical });
  };
  collect(ast, node => {
    add(node.getStart(ast), node.end);
    const children = node.statements ?? node.properties ?? node.elements;
    if (children && typeof children.length === 'number')
      for (let from = 0; from < children.length; from++)
        for (let to = from + 1; to < Math.min(children.length, from + 4); to++)
          add(children[from].getStart(ast), children[to].end);
    return false;
  });
  const unique = [...new Map(matches.map(match => [`${match.start}:${match.end}`, match])).values()];
  const maximal = unique.filter(match => !unique.some(other => other !== match && other.start <= match.start && other.end >= match.end));
  const node = one(maximal, label);
  const current = node.current;
  state.push(current);
  return current
    ? source
    : source.slice(0, range.start + node.start) + replacement + source.slice(range.start + node.end);
}

function addExport(source, name, local = name) {
  const ast = parse(source);
  const kind = local === 'runExclusiveSessionLifecycle' ? 'lock' : 'registry';
  const declarations = ast.statements.filter(ts.isExportDeclaration);
  const owners = [], additions = [];
  for (const candidate of declarations) {
    if (candidate.moduleSpecifier || candidate.isTypeOnly || !candidate.exportClause || !ts.isNamedExports(candidate.exportClause))
      throw new Error(`${name}: native named export owner changed`);
    const base = `{ ${candidate.exportClause.elements.filter(entry => entry.name.text !== name).map(entry => entry.getText(ast)).join(', ')} }`;
    if (tokens(base) === tokens(NATIVE_EXPORTS[kind])) owners.push(candidate);
    else if (kind === 'registry' && tokens(candidate.exportClause.getText(ast)) === tokens(PLUGIN_EXECUTION_EXPORTS)) additions.push(candidate);
    else throw new Error(`${name}: unknown native export topology`);
  }
  const statement = one(owners, `${name} export owner`);
  if (additions.length > 1) throw new Error(`${name}: duplicate plugin execution exports`);
  const entries = statement.exportClause.elements;
  const matching = entries.filter(entry => entry.name.text === name);
  if (matching.length) {
    if (matching.length !== 1 || (matching[0].propertyName?.text ?? matching[0].name.text) !== local)
      throw new Error(`${name}: partial export`);
    return { source, current: true };
  }
  const at = statement.exportClause.getStart(ast) + 1;
  return { source: source.slice(0, at) + ` ${local}${local === name ? '' : ` as ${name}`},` + source.slice(at), current: false };
}

function transformKind(input, kind, file) {
  let source = input;
  const state = [];
  const edit = (scope, original, replacement, label) => {
    source = editNode(source, scope, original, replacement, state, `${kind}: ${label}`);
  };
  if (kind === 'schema') {
    const tree = parse(source);
    const schema = one(collect(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'AgentParamsSchema'), 'native agent schema');
    const existingCondition = collect(schema, node => ts.isPropertyAssignment(node) && node.name.getText(tree) === 'goalContinuation');
    edit('variable:AgentParamsSchema', 'message: NonEmptyString', `message: NonEmptyString,
      goalContinuation: Type.Optional(closedObject({
        goalId: NonEmptyString,
        predecessorRunId: NonEmptyString,
        maxAutomaticContinuations: Type.Integer({ minimum: 0, maximum: 1000 }),
        automatic: Type.Literal(true)
      }))`, 'closed agent condition');
    if (existingCondition.length && (existingCondition.length !== 1 || state[0] !== true))
      throw new Error('Partial native Goal continuation schema');
  } else if (kind === 'preflight') {
    edit('prepareAgentRequestPreflight',
      'if (!expectedSessionResult.ok) return rejectInvalidRequest(expectedSessionResult.error);',
      `if (!expectedSessionResult.ok) return rejectInvalidRequest(expectedSessionResult.error);
       try { goalPreflight.validate(request, canUseInternalRuntimeHandoff); }
       catch (error) { return rejectInvalidRequest(error.message); }`,
      'backend restriction');
  } else if (kind === 'terminal') {
    edit('persistGatewaySessionLifecycleEvent',
      'const patch = derivePersistedSessionLifecyclePatch({ entry, event: params.event });',
      `const patch = derivePersistedSessionLifecyclePatch({ entry, event: params.event });
       if (Object.keys(patch).length > 0) Object.assign(patch, goalTerminal.terminal(
         { entry, event: params.event }, phase, eventClientRunId ?? eventRunId));`,
      'exact terminal receipt in the owned native writer');
  } else if (kind === 'turn') {
    const range = functionRange(source, 'prepareAgentRunDispatch');
    const ast = parse(range.text);
    const starts = collect(ast, node => ts.isExpressionStatement(node) && tokens(node.getText(ast)) === tokens('followupCompletion?.markAccepted(params.runId);'));
    const first = one(starts, 'native final acceptance');
    const block = first.parent;
    if (!ts.isBlock(block)) throw new Error('Native acceptance block changed');
    const statements = block.statements;
    const from = statements.indexOf(first);
    const arm = statements.findIndex(node => ts.isExpressionStatement(node) && tokens(node.getText(ast)) === tokens('capturedOperator.armCancellation();'));
    if (arm < from) throw new Error('Native accepted publication order changed');
    const original = range.text.slice(first.getStart(ast), statements[arm].end);
    if (tokens(original) !== tokens(NATIVE_ACCEPTED)) throw new Error('Native accepted publication changed');
    const already = source.includes('const publishGoalAdmission =');
    if (!already) {
      const replacement = `const publishGoalAdmission = () => { ${original} };
        const replayedGoalAdmission = params.request.goalContinuation ? await goalAdmission.commit({
          ...params,
          lifecycleStorePath,
          admission: activeGatewayWorkAdmission,
          signal: activeRunAbort.controller.signal,
          readEntry: params.assertGatewayWorkAdmissionAllowed,
          assertCurrent: () => {
            assertInputOwnerCurrent();
            capturedOperator.authority?.assertCurrent();
            if (!activeGatewayWorkAdmission.isActive()) throw new Error("Goal admission lease ended");
          }
        }, accepted, publishGoalAdmission).catch(error => {
          if (error instanceof SessionMutationAuthorizationChangedError) return { deferred: error.error };
          throw error;
        }) : (publishGoalAdmission(), undefined);
        if (replayedGoalAdmission?.deferred) return rejectPreaccept(replayedGoalAdmission.deferred);
        if (replayedGoalAdmission) {
          await cleanupPreaccept();
          params.markAgentRunAccepted(true);
          params.io.emitAcceptance([true, {
            runId: replayedGoalAdmission.runId,
            sessionKey: replayedGoalAdmission.sessionKey,
            agentId: replayedGoalAdmission.agentId,
            status: "accepted",
            acceptedAt: replayedGoalAdmission.acceptedAt,
            goalContinuation: { ...goalAdmission.publicReceipt(replayedGoalAdmission), replayed: true }
          }, undefined], { cached: true, runId: replayedGoalAdmission.runId });
          return undefined;
        }`;
      const start = range.start + first.getStart(ast);
      source = source.slice(0, start) + replacement + source.slice(range.start + statements[arm].end);
    } else {
      // Verify the complete wrapper, not merely its marker, on current source and bundles.
      const declaration = one(collect(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'replayedGoalAdmission'), 'conditional commit');
      if (tokens(declaration.initializer.getText(ast)) !== tokens(`params.request.goalContinuation ? await goalAdmission.commit({
        ...params, lifecycleStorePath, admission: activeGatewayWorkAdmission,
        signal: activeRunAbort.controller.signal,
        readEntry: params.assertGatewayWorkAdmissionAllowed,
        assertCurrent: () => {
          assertInputOwnerCurrent(); capturedOperator.authority?.assertCurrent();
          if (!activeGatewayWorkAdmission.isActive()) throw new Error("Goal admission lease ended");
        }
      }, accepted, publishGoalAdmission).catch(error => {
        if (error instanceof SessionMutationAuthorizationChangedError) return { deferred: error.error };
        throw error;
      }) : (publishGoalAdmission(), undefined)`)) throw new Error('Partial Goal final admission guard');
      const replayBranch = one(collect(ast, node => ts.isIfStatement(node) && tokens(node.expression.getText(ast)) === tokens('replayedGoalAdmission')), 'cached Goal receipt branch');
      if (!tokens(replayBranch.getText(ast)).includes(tokens('return undefined;')))
        throw new Error('Goal receipt replay must not dispatch');
    }
    state.push(already);
  } else if (kind === 'describe') {
    edit(null, 'presentation.present(record, params)',
      '{ ...presentation.present(record, params), lifecycleRevision: record.entry.lifecycleRevision, goalContinuation: goalObservation.describe(record.entry) }', 'authorized observation');
  } else if (kind === 'private') {
    const ast = parse(source);
    for (const name of ['SESSION_ENTRY_PRIVATE_CLEAR_PATCH', 'PRIVATE_SESSION_ENTRY_KEYS']) {
      const variable = one(collect(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name), name);
      const initializer = variable.initializer;
      const text = initializer.getText(ast);
      const current = text.includes('goalContinuationTerminal') && text.includes('goalContinuationAccepted');
      if (text.includes('goalContinuationTerminal') !== text.includes('goalContinuationAccepted')) throw new Error('Partial private Goal metadata');
      if (current)
        for (const key of ['goalContinuationTerminal', 'goalContinuationAccepted']) {
          const values = name === 'PRIVATE_SESSION_ENTRY_KEYS'
            ? initializer.elements.filter(node => ts.isStringLiteral(node) && node.text === key)
            : initializer.properties.filter(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === key && tokens(node.initializer.getText(ast)) === tokens('undefined'));
          if (values.length !== 1) throw new Error('Partial private Goal metadata values');
        }
      state.push(current);
      if (!current) {
        const at = initializer.getStart(ast) + 1;
        const fields = name === 'PRIVATE_SESSION_ENTRY_KEYS'
          ? '"goalContinuationTerminal", "goalContinuationAccepted",'
          : 'goalContinuationTerminal: undefined, goalContinuationAccepted: undefined,';
        // Both original positions come from the same AST; apply in reverse below.
        state.privateEdits ??= [];
        state.privateEdits.push({ at, fields });
      }
    }
    for (const { at, fields } of (state.privateEdits ?? []).sort((a, b) => b.at - a.at))
      source = source.slice(0, at) + fields + source.slice(at);
  } else if (kind === 'lock') {
    if (!isGatewayBundlePath(file)) {
      const exported = addExport(source, 'goalContinuationLifecycle', 'runExclusiveSessionLifecycle');
      source = exported.source;
      state.push(exported.current);
    }
  } else if (kind === 'registry') {
    const implementation = `function hasGoalContinuationNativeHandoff(sessionKey, agentId) {
      return goalRegistry.hasNativeHandoff(sessionKey, agentId, subagentRuns,
        subagentLifecycleController, listUnsettledRequesterChildrenInRuns, subagentRestorer.canResumeWakes(),
        entry => isRequesterCompletionCohortCurrent(entry, getLatestLiveSubagentRunByChildSessionKey));
    }`;
    const current = source.includes('function hasGoalContinuationNativeHandoff(');
    if (current) {
      if (canonical(functionRange(source, 'hasGoalContinuationNativeHandoff').text) !== canonical(implementation))
        throw new Error('Partial native handoff owner binding');
    } else source = prepend(source, implementation + '\n');
    state.push(current);
    if (!isGatewayBundlePath(file)) {
      const exported = addExport(source, 'hasGoalContinuationNativeHandoff');
      source = exported.source;
      state.push(exported.current);
    }
  }
  if (state.some(Boolean) && state.some(value => !value)) throw new Error(`${kind}: partial Goal continuation seams`);
  const current = state.length ? state.every(Boolean) : input.includes(CONTRACT);
  if (current !== input.includes(CONTRACT)) throw new Error(`${kind}: partial Goal continuation contract marker`);
  const binding = BINDINGS[kind];
  if (binding) {
    const ast = parse(source);
    const name = binding.match(/const (\w+)/)[1];
    const declarations = collect(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
    if (declarations.length) {
      if (!current) throw new Error(`${kind}: partial native Goal binding`);
      if (declarations.length !== 1 || !same(`const ${declarations[0].getText(ast)};`, binding))
        throw new Error(`${kind}: native Goal dependencies changed`);
    } else if (current) throw new Error(`${kind}: missing native Goal binding`);
    else source = prepend(source, binding + '\n');
    if (!isGatewayBundlePath(file)) {
      const imports = [
        `import { createGoalContinuationRuntime } from "${nativeSupportImport(file, SUPPORT)}";`,
        ...(IMPORTS[kind] ?? []),
      ];
      for (const value of imports) {
        if (current && !source.includes(value)) throw new Error(`${kind}: native Goal import changed`);
        if (!current) source = prepend(source, value + '\n');
      }
    }
  }
  return source;
}

function transform(source, kinds, file) {
  if (isGatewayBundlePath(file)) {
    verifyBundle(source);
    return source;
  }
  const current = source.includes(CONTRACT);
  let next = source;
  for (const kind of kinds) next = transformKind(next, kind, file);
  if (current && next !== source) throw new Error(`${file}: partial Goal continuation capability`);
  if (!current) next = prepend(next, `// ${CONTRACT}\n`);
  return next;
}

function verifyBundle(source) {
  const ast = parse(source);
  const declaration = name => one(collect(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name), `bundle ${name}`);
  const value = name => {
    const declared = declaration(name);
    return declared.initializer ?? one(collect(ast, node => ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(ast) === name), `bundle ${name} initializer`).right;
  };
  const helper = functionRange(source, 'createGoalContinuationRuntime').text;
  if (canonical(helper) !== canonical(createGoalContinuationRuntime.toString()))
    throw new Error('Goal support implementation differs in final bundle');
  for (const [kind, expected] of Object.entries(BINDINGS)) {
    const name = expected.match(/const (\w+)/)[1];
    const expectedBundle = expected.replace(/\bgoalContinuationLifecycle\b/g, 'runExclusiveSessionLifecycle');
    if (!same(`const ${name} = ${value(name).getText(ast)};`, expectedBundle))
      throw new Error(`bundle ${kind}: native Goal dependencies changed`);
  }
  const schema = value('AgentParamsSchema');
  const condition = one(collect(schema, node => ts.isPropertyAssignment(node) && node.name.getText(ast) === 'goalContinuation'), 'bundle closed Goal condition');
  // esbuild can retain Type as an import alias or inline the TypeBox namespace.
  // Resolve the owner from the unchanged native agentId schema in this same object.
  const agentId = one(collect(schema, node => ts.isPropertyAssignment(node) && node.name.getText(ast) === 'agentId'), 'bundle native agentId schema');
  const typeOwner = agentId.initializer.expression?.expression;
  const typeAlias = typeOwner?.getText(ast);
  if (!typeOwner || !ts.isIdentifier(typeOwner) ||
      !same(agentId.initializer.getText(ast), `${typeAlias}.Optional(NonEmptyString)`))
    throw new Error('bundle TypeBox owner changed');
  if (!same(condition.initializer.getText(ast), `Type.Optional(closedObject({
    goalId: NonEmptyString, predecessorRunId: NonEmptyString,
    maxAutomaticContinuations: Type.Integer({ minimum: 0, maximum: 1000 }), automatic: Type.Literal(true)
  }))`.replace(/\bType\b/g, typeAlias))) throw new Error('bundle Goal schema changed');
  for (const [owner, object, method] of [
    ['prepareAgentRequestPreflight', 'goalPreflight', 'validate'],
    ['persistGatewaySessionLifecycleEvent', 'goalTerminal', 'terminal'],
  ]) {
    const fn = parse(functionRange(source, owner).text);
    one(collect(fn, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(fn) === object && node.expression.name.text === method), `bundle ${owner} support edge`);
  }
  const turnText = functionRange(source, 'prepareAgentRunDispatch').text;
  const turn = parse(turnText);
  const fn = turn.statements[0];
  const parameter = fn.parameters[0].name.getText(turn);
  const publish = one(collect(turn, node => ts.isVariableDeclaration(node) && node.name.getText(turn) === 'publishGoalAdmission'), 'bundle native publication');
  if (canonicalHelper(`async function seam(${parameter}) ${publish.initializer.body.getText(turn)}`) !==
      canonicalHelper(`async function seam(params) { ${NATIVE_ACCEPTED} }`))
    throw new Error('bundle native accepted publication changed');
  const commit = one(collect(turn, node => ts.isVariableDeclaration(node) && node.name.getText(turn) === 'replayedGoalAdmission'), 'bundle conditional acceptance');
  const currentCall = commit.initializer.getText(turn);
  const expectedCall = `params.request.goalContinuation ? await goalAdmission.commit({
    ...params, lifecycleStorePath, admission: activeGatewayWorkAdmission,
    signal: activeRunAbort.controller.signal, readEntry: params.assertGatewayWorkAdmissionAllowed,
    assertCurrent: () => { assertInputOwnerCurrent(); capturedOperator.authority?.assertCurrent();
      if (!activeGatewayWorkAdmission.isActive()) throw new Error("Goal admission lease ended"); }
  }, accepted, publishGoalAdmission).catch(error => {
    if (error instanceof SessionMutationAuthorizationChangedError) return { deferred: error.error };
    throw error;
  }) : (publishGoalAdmission(), undefined)`;
  if (canonicalHelper(`async function seam(${parameter}) { return ${currentCall}; }`) !==
      canonicalHelper(`async function seam(params) { return ${expectedCall}; }`))
    throw new Error('bundle final Goal guard changed');
  const replay = one(collect(turn, node => ts.isIfStatement(node) && node.expression.getText(turn) === 'replayedGoalAdmission'), 'bundle receipt replay');
  if (!collect(replay, node => ts.isReturnStatement(node) && (!node.expression || tokens(node.expression.getText(turn)) === tokens('undefined'))).length)
    throw new Error('bundle receipt replay dispatches again');
  const describe = value('sessionByKeyReadHandlers');
  const observation = one(collect(describe, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(ast) === 'goalObservation' && node.expression.name.text === 'describe'), 'bundle authorized Goal observation');
  const revision = one(collect(describe, node => ts.isPropertyAssignment(node) && node.name.getText(ast) === 'lifecycleRevision'), 'bundle authorized lifecycle revision');
  if (tokens(revision.initializer.getText(ast)) !== tokens(`${observation.arguments[0].getText(ast)}.lifecycleRevision`))
    throw new Error('bundle Goal observation lifecycle revision changed');
  const handoff = functionRange(source, 'hasGoalContinuationNativeHandoff').text;
  if (canonical(handoff) !== canonical(`function hasGoalContinuationNativeHandoff(sessionKey, agentId) {
    return goalRegistry.hasNativeHandoff(sessionKey, agentId, subagentRuns,
      subagentLifecycleController, listUnsettledRequesterChildrenInRuns, subagentRestorer.canResumeWakes(),
      entry => isRequesterCompletionCohortCurrent(entry, getLatestLiveSubagentRunByChildSessionKey));
  }`)) throw new Error('bundle native handoff owner changed');
  functionRange(source, 'runExclusiveSessionLifecycle');
  for (const name of ['SESSION_ENTRY_PRIVATE_CLEAR_PATCH', 'PRIVATE_SESSION_ENTRY_KEYS']) {
    // The real Gateway entry does not consume the CLI-only clear constant.
    // Its companion source remains mandatory; only a fully unreferenced bundle
    // declaration may be removed by tree shaking.
    if (name === 'SESSION_ENTRY_PRIVATE_CLEAR_PATCH' &&
        !collect(ast, node => ts.isIdentifier(node) && /^SESSION_ENTRY_PRIVATE_CLEAR_PATCH\d*$/.test(node.text)).length)
      continue;
    const initializer = value(name);
    for (const key of ['goalContinuationTerminal', 'goalContinuationAccepted']) {
      const entries = name === 'PRIVATE_SESSION_ENTRY_KEYS'
        ? initializer.elements.filter(node => ts.isStringLiteral(node) && node.text === key)
        : initializer.properties.filter(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === key && tokens(node.initializer.getText(ast)) === tokens('undefined'));
      if (entries.length !== 1) throw new Error('bundle private Goal metadata changed');
    }
  }
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs'));
  const plans = new Map();
  for (const [kind, anchor] of Object.entries(ANCHORS)) {
    const files = findFilesContaining(root, anchor).filter(file => !isGatewayBundlePath(file));
    assertTargetPaths(root, files, [TARGETS[kind]], `Goal ${kind}`);
    for (const file of files) {
      let plan = plans.get(file);
      if (!plan) {
        const source = fs.readFileSync(file, 'utf8');
        plans.set(file, plan = { file, source, kinds: [] });
      }
      plan.kinds.push(kind);
    }
  }
  if (bundle) {
    const file = path.join(root, 'gateway-bundle.mjs');
    plans.set(file, { file, source: fs.readFileSync(file, 'utf8'), kinds: Object.keys(ANCHORS) });
  }
  for (const plan of plans.values()) plan.next = transform(plan.source, plan.kinds, plan.file);
  const support = path.join(root, 'dist/native-support', SUPPORT);
  const states = [...plans.values()].map(plan => plan.source === plan.next);
  states.push(fs.existsSync(support));
  if (states.some(Boolean) && states.some(value => !value)) throw new Error('Mixed Goal continuation capability; rebuild pristine runtime');
  if (fs.existsSync(support)) nativeSupportModule(root, SUPPORT, SUPPORT_SOURCE, true);
  if (verify && states.some(value => !value)) throw new Error('Native Goal continuation admission missing');
  nativeSupportModule(root, SUPPORT, SUPPORT_SOURCE, verify);
  return [...plans.values()].flatMap(plan =>
    !verify && writeIfChanged(plan.file, plan.source, plan.next) ? [path.relative(root, plan.file)] : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, transformKind, verifyBundle, TARGETS, CONTRACT, ANCHORS, BINDINGS, NATIVE_ACCEPTED, NATIVE_EXPORTS, PLUGIN_EXECUTION_EXPORTS },
};
