'use strict';

// Capability: keep an existing MCP App interactive after changing the session's model.
// Target: pristine openclaw@2026.10.7 pins manual App view grants to the opening model.
// Scope: manual App view authority in the exact same embedded session MCP runtime.
// Safety: retain native origin, access and policy checks; fence pending actions and cached approvals.
// Remove when: upgrading past OpenClaw 2026.10.7; follow the MCP Apps upgrade checklist.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const {
  assertCurrentPatchContract,
  countOccurrences,
  findFilesContaining,
  isGatewayBundlePath,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');
const {
  assertTargetPaths, collect, functionRange, one, parse, prepend,
} = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_MCP_APP_MODEL_CONTINUITY_V2026_10_7';
const WORKSPACE_CONTRACT = 'RUNTIME_MCP_APP_SESSION_WORKSPACE_V2026_10_7';
const NATIVE = 'dist/mcp-app-extensions-abaft4XG.mjs';
const FILES = 'dist/mcp-app-host-files-CYEqGNXR.mjs';
const FILE_SELECTION = 'captureMcpAppFileSelection';
const UTIL = 'import { isDeepStrictEqual as mcpAppDeepEqual } from "node:util";';
const MANAGER = 'from "./agent-bundle-mcp-manager-api-MgM2jUv6.mjs";';
const ORIGINAL_IMPORT = `import { n as acquireSessionMcpRuntime } ${MANAGER}`;
const UPDATED_IMPORT = `import { h as sessionMcpRuntimeOwners, n as acquireSessionMcpRuntime, o as peekSessionMcpRuntime } ${MANAGER}`;
const HELPERS = `const mcpAppSelectionObservers = new WeakMap();
function observeMcpAppSelection(projection, agentId, refresh) {
  let observers = mcpAppSelectionObservers.get(projection);
  if (!observers) {
    observers = new Set();
    mcpAppSelectionObservers.set(projection, observers);
    projection.onSelectionChange((change) => {
      for (const observer of observers) {
        if (change.kind === "reset" || change.agentId === observer.agentId) observer.refresh();
      }
    });
  }
  const registration = { agentId, refresh };
  observers.add(registration);
  return () => observers.delete(registration);
}
function mcpAppConfigWithoutModelPrimaries(config) {
  if (!config.agents) return config;
  const agents = { ...config.agents };
  const withoutPrimary = (agent) => {
    if (!agent) return agent;
    const { model, ...rest } = agent;
    if (model && typeof model === "object") {
      const { primary, ...modelPolicy } = model;
      if (Object.keys(modelPolicy).length) rest.model = modelPolicy;
    }
    return rest;
  };
  if (agents.defaults) agents.defaults = withoutPrimary(agents.defaults);
  if (agents.entries) agents.entries = Object.fromEntries(
    Object.entries(agents.entries).map(([id, agent]) => [id, withoutPrimary(agent)])
  );
  return { ...config, agents };
}
function mcpAppStableViewSelection(entry, harnessId) {
  return runtimeSelection(
    { ...entry, providerOverride: undefined, modelOverride: undefined },
    {},
    harnessId
  );
}
`;

const VIEW_SELECTION = `
      const sameOwner = () =>
        peekSessionMcpRuntime({ sessionId, sessionKey: sessionKey }) === runtime &&
        sessionMcpRuntimeOwners.get(runtime)?.isCurrent() === true &&
        !runtime.mcpAppModelContextRevoked && !runtime.retiredCatalog &&
        runtime.workspaceDir === workspaceDir;
      const continuity = allowModelContinuity && harnessId === "openclaw" && sameOwner();
      const stableSelection = mcpAppStableViewSelection(target.entry, harnessId);
      const toolOverrides = target.entry.toolOverrides;
      const stableConfig = continuity ? mcpAppConfigWithoutModelPrimaries(cfg) : undefined;
      let latestConfig = cfg;
      let fingerprint = selected.fingerprint;
      let generation = 0;
      let modelGeneration = 0;
      const approvalGenerations = new WeakMap();
      let observing = false;
      const changed = () => new Error("MCP App session runtime selection changed; reopen the App");
      const readViewTarget = () => {
        const live = projection.sharingTarget(query);
        if (!live || live.entry.sessionId !== sessionId) throw changed();
        const liveConfig = options.context.getRuntimeConfig();
        if (liveConfig !== latestConfig &&
            !mcpAppDeepEqual(stableConfig, mcpAppConfigWithoutModelPrimaries(liveConfig))) {
          throw new Error("MCP App configuration changed; reopen the App");
        }
        const selection = selectRuntime(live.entry, liveConfig);
        if (selection.harnessId !== "openclaw" || !sameOwner() ||
            mcpAppStableViewSelection(live.entry, selection.harnessId) !== stableSelection ||
            live.entry.permissionMode !== target.entry.permissionMode ||
            !mcpAppDeepEqual(live.entry.toolOverrides, toolOverrides)) throw changed();
        if (selection.fingerprint !== fingerprint) modelGeneration++;
        if (selection.fingerprint !== fingerprint || liveConfig !== latestConfig) generation++;
        fingerprint = selection.fingerprint;
        latestConfig = liveConfig;
        return live;
      };
      const stopObserving = continuity ? observeMcpAppSelection(projection, agentId, () => {
        if (observing) return;
        observing = true;
        try {
          readViewTarget();
        } catch {
          generation++;
          modelGeneration++;
        } finally {
          observing = false;
        }
      }) : undefined;
      const assertViewTarget = (strict = false) => {
        if (strict || !continuity) return current(retained.assertCurrent);
        retained.assertCurrent();
        return readViewTarget();
      };
      const assertViewTools = (strict) => {
        const live = assertViewTarget(strict);
        if (live.entry.permissionMode !== target.entry.permissionMode)
          throw new Error("MCP App permission mode changed; reopen the App");
        for (const tool of viewTools) assertTool(tool, false, retained.assertCurrent, () => live);
      };
      const captureSelection = () => {
        assertViewTarget();
        const capturedGeneration = generation;
        return () => {
          const currentTarget = assertViewTarget();
          if (generation !== capturedGeneration) throw changed();
          return currentTarget;
        };
      };
`.trimEnd();

const VIEW_APPROVAL = `
        const approvalView = request.view;
        if (approvalView && (approvalGenerations.get(approvalView) ?? 0) !== modelGeneration) {
          approvalView.toolApprovalGrants?.clear();
          approvalGenerations.set(approvalView, modelGeneration);
        }
`.trimEnd();

const VIEW_AUTHORITY_METHODS = `
        assertStrictCurrent: () => assertViewTools(true),
        captureSelection,
        release: () => {
          stopObserving?.();
          retained.release();
        },
        assertCurrent: () => assertViewTools(false)
`.trimEnd();

function nativeIndent(block) {
  return block.replace(/^ +/gm, spaces => '\t'.repeat(spaces.length / 2));
}

function sourceSeam(file, patched) {
  return (body, before, after, label) => {
    if (!patched) return replaceUnique(body, before, after, `${file}: ${label}`);
    if (countOccurrences(body, after) !== 1 ||
        countOccurrences(body, before) !== countOccurrences(after, before))
      throw new Error(`${file}: partial ${label}`);
    return body;
  };
}

function verifyBundle(source, file, nativeSource) {
  functionRange(source, 'peekSessionMcpRuntime');
  if (countOccurrences(source, 'Symbol.for("openclaw.sessionMcpRuntimeOwners")') !== 1 ||
      !/\bsessionMcpRuntimeOwners = resolveGlobalSingleton\(/.test(source))
    throw new Error(`${file}: bundled MCP owner binding changed`);
  const observer = 'mcpAppSelectionObservers';
  if (countOccurrences(source, UTIL) !== 1 ||
      !new RegExp(`\\b${observer} = (?:/\\* @__PURE__ \\*/ )?new WeakMap\\(\\);`).test(source))
    throw new Error(`${file}: bundled model continuity setup changed`);
  for (const name of [
    'observeMcpAppSelection', 'mcpAppConfigWithoutModelPrimaries', 'mcpAppStableViewSelection',
  ]) {
    if (canonicalHelper(functionRange(source, name).text) !==
        canonicalHelper(functionRange(HELPERS, name).text))
      throw new Error(`${file}: bundled ${name} changed`);
  }
  const prepare = functionRange(source, 'prepareMcpAppExtensionRuntime').text;
  const ast = parse('async ' + prepare);
  const fn = ast.statements[0];
  const variable = name => one(collect(
    fn, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name,
  ), `${file}: ${name}`).initializer;
  const read = (regex, label) => {
    const match = prepare.match(regex);
    if (!match) throw new Error(`${file}: bundled ${label} changed`);
    return match.slice(1);
  };
  const [access] = read(/const (\w+) = options\.sessionAccessAuthority;/, 'session access');
  const [agentId, sessionKey] = read(
    /const \{ agentId(?:: (\w+))?, sessionKey(?:: (\w+))?, sessionId \} = \w+\.target;/,
    'session identity',
  );
  const [query] = read(/const initial = projection\.sharingTarget\((\w+)\);/, 'session query');
  const [runtime] = read(/const (\w+) = acquired\.runtime;/, 'leased MCP runtime');
  const [target, current] = read(/const (\w+) = (current\w*)\(\);/, 'strict session target');
  const [harnessId] = read(/const \{ model: selectedModel, harnessId(?:: (\w+))? \} = selected;/, 'embedded harness');
  const expected = authorityRange(nativeSource).body;
  const canonical = (bindings, expression) =>
    canonicalHelper(`function check(${bindings.join(', ')}) { return ${expression}; }`);
  if (canonical(
    [access, agentId ?? 'agentId', sessionKey ?? 'sessionKey', query, runtime, target, current, harnessId ?? 'harnessId'],
    variable('retainViewAuthority').getText(ast),
  ) !== canonical(
    ['access', 'agentId', 'sessionKey', 'query', 'runtime', 'target', 'current', 'harnessId'],
    expected.slice(expected.indexOf(' = ') + 3, -1),
  )) throw new Error(`${file}: bundled retained view authority changed`);
  const select = variable('selectRuntime');
  const config = select.parameters[1];
  if (!config || config.initializer?.getText(ast) !== 'cfg' ||
      countOccurrences(select.getText(ast), `cfg: ${config.name.getText(ast)}`) !== 2)
    throw new Error(`${file}: bundled live selection changed`);
  const assertTool = variable('assertTool');
  const currentTarget = assertTool.parameters[3];
  if (!currentTarget || currentTarget.initializer?.getText(ast) !== current ||
      assertTool.body.statements[0]?.getText(ast) !==
        `const live = ${currentTarget.name.getText(ast)}(${assertTool.parameters[2].name.getText(ast)});`)
    throw new Error(`${file}: bundled live tool policy changed`);
  const launch = functionRange(source, 'launch').text;
  const retained = launch.match(/const (\w+) = (\w+)\.retainViewAuthority\(viewTools, true\);/);
  const lease = launch.match(/const (\w+) = getMcpAppViewLease\(/);
  if (!retained || !launch.includes(
    `uploadResources: await uploadFor(${retained[2]}, tool.serverName, ${retained[1]}.assertStrictCurrent),`) ||
      !lease || !launch.includes(
        `if (extra?.hostFile) ${lease[1]}.${FILE_SELECTION} = ${retained[1]}.captureSelection;`))
    throw new Error(`${file}: bundled launch scope changed`);
  transformFiles(source, file, true);
  return source;
}

function authorityRange(source) {
  const declaration = '\t\tconst retainViewAuthority = ';
  const start = source.indexOf(declaration);
  const end = source.indexOf('\n\t\treturn {\n\t\t\tapproveTool,', start);
  if (countOccurrences(source, declaration) !== 1 || end < 0)
    throw new Error('MCP App retained view authority changed');
  return { start, end, body: source.slice(start, end) };
}

const SOURCE_AUTHORITY_SHA = '50b344f5b3364ee2ed9d21ef5bf427ebb99108c2f1454cbb5a882b2b848bdfee';
const PATCHED_AUTHORITY_SHA = 'a10d6b3c526baa5b5ccf7c5470d85b1cb5f0927d45e18d38e64d4348f9d83fa5';

function patchAuthority(source, file, patched) {
  const range = authorityRange(source);
  let body = range.body;
  const digest = () => createHash('sha256').update(body).digest('hex');
  if (digest() !== (patched ? PATCHED_AUTHORITY_SHA : SOURCE_AUTHORITY_SHA))
    throw new Error(`${file}: partial or changed retained view authority`);
  if (patched) return source;
  const edit = (before, after) => {
    body = replaceUnique(body, nativeIndent(before), nativeIndent(after), `${file}: retained view authority`);
  };
  edit('(viewTools) => {', '(viewTools, allowModelContinuity = false) => {');
  const retain = 'const retained = access.retain();';
  edit(retain, retain + VIEW_SELECTION);
  const guard = '        const assertCurrent = () => {';
  edit(guard, '        request.assertCurrent();\n        const requestTarget = captureSelection();\n' + guard);
  edit(
    '          retained.assertCurrent();\n          assertTool(tool, false, retained.assertCurrent);',
    '          assertTool(tool, false, retained.assertCurrent, requestTarget);',
  );
  const approval = 'const approvalRequired = assertTool(tool, true, retained.assertCurrent';
  edit(approval + ');', approval + ', requestTarget);' + VIEW_APPROVAL);
  // Preserve the exact equivalent object spelling in the verified runtime.
  for (const name of ['agentId', 'sessionKey']) edit(`          ${name},`, `          ${name}: ${name},`);
  edit('view: request.view,', 'view: approvalView,');
  const recheck = 'if (assertTool(tool, true, retained.assertCurrent';
  edit(recheck + ') && !approvalRequired) throw', recheck + ', requestTarget) && !approvalRequired)\n            throw');
  const tail = body.indexOf('\n\t\t\t\tassertCurrent: () => {');
  const end = body.indexOf('\n\t\t\t};', tail);
  if (tail < 0 || end < 0) throw new Error(`${file}: retained view assertion changed`);
  body = body.slice(0, tail) + nativeIndent(VIEW_AUTHORITY_METHODS) + body.slice(end);
  if (digest() !== PATCHED_AUTHORITY_SHA) throw new Error(`${file}: retained view authority output changed`);
  return source.slice(0, range.start) + body + source.slice(range.end);
}

function transform(source, file = NATIVE, nativeSource) {
  if (isGatewayBundlePath(file)) return verifyBundle(source, file, nativeSource);
  if (file.replaceAll(path.sep, '/').endsWith(FILES)) return transformFiles(source, file);
  assertCurrentPatchContract(source, WORKSPACE_CONTRACT, file);
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const { start, end, text: prepare } = functionRange(source, 'prepareMcpAppExtensionRuntime');
  const patched = source.includes(CONTRACT);
  const seam = sourceSeam(file, patched);
  const opening = '\t';
  const oldSelect = 'const selectRuntime = (entry) => {';
  const newSelect = 'const selectRuntime = (entry, selectedConfig = cfg) => {';
  const oldAssert = 'const assertTool = (tool, interaction = false, assertAccess = access.assertCurrent) => {\n\t\t\tconst live = current(assertAccess);';
  const newAssert = 'const assertTool = (tool, interaction = false, assertAccess = access.assertCurrent, currentTarget = current) => {\n\t\t\tconst live = currentTarget(assertAccess);';
  let next = seam(prepare, oldSelect, newSelect, 'live selection');
  for (const selector of ['resolveSessionSelectedModelRef', 'resolveEffectiveAgentRuntime']) {
    const anchor = `${selector}({\n${opening.repeat(3)}cfg,`;
    next = seam(next, anchor, anchor.replace('cfg,', 'cfg: selectedConfig,'), 'selection config');
  }
  next = seam(next, oldAssert, newAssert, 'live tool policy');
  next = patchAuthority(next, file, patched);
  let result = source.slice(0, start) + next + source.slice(end);
  const launch = functionRange(result, 'launch');
  const active = 'active';
  const retained = 'retained';
  let launchBody = seam(
    launch.text,
    `const ${retained} = ${active}.retainViewAuthority(viewTools);`,
    `const ${retained} = ${active}.retainViewAuthority(viewTools, true);`,
    'view launch scope',
  );
  const upload = `uploadFor(${active}, tool.serverName, ${retained}.assertCurrent),`;
  launchBody = seam(launchBody, upload, upload.replace('assertCurrent', 'assertStrictCurrent'), 'strict upload authority');
  const transfer = 'if (lease) {';
  launchBody = seam(
    launchBody, transfer,
    `${transfer}\n\t\t\tif (extra?.hostFile) lease.${FILE_SELECTION} = ${retained}.captureSelection;`,
    'retained host file selection binding',
  );
  result = result.slice(0, launch.start) + launchBody + result.slice(launch.end);
  result = seam(result, ORIGINAL_IMPORT, UPDATED_IMPORT, 'native MCP owner import');
  if (patched) {
    if ([CONTRACT, UTIL, HELPERS].some(fragment => countOccurrences(result, fragment) !== 1))
      throw new Error(`${file}: partial model continuity helpers`);
    return result;
  }
  if (result.includes('const mcpAppSelectionObservers') || result.includes(UTIL))
    throw new Error(`${file}: partial model continuity setup`);
  result = prepend(result, `// ${CONTRACT}\n${UTIL}\n`);
  return replaceUnique(result, 'function runtimeSelection(', HELPERS + 'function runtimeSelection(', file);
}

function transformFiles(source, file, bundle = false) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const patched = bundle || source.includes(CONTRACT);
  const seam = sourceSeam(file, patched);
  const fileOperation = functionRange(source, 'withHostFile');
  const indent = bundle ? '  ' : '\t';
  const mutation = fileOperation.text.match(/\b(mutation\w*) = false/)?.[1];
  if (!mutation) throw new Error(`${file}: file mutation boundary changed`);
  const params = `${mutation} = false) {`;
  let after = seam(
    fileOperation.text, params, params.replace(')', ', selectionCurrent)'),
    'host file operation selection parameter',
  );
  if (after.includes(FILE_SELECTION)) throw new Error(`${file}: host file selection is captured outside a write`);
  const authority = 'const assertCurrent = () => {\n';
  after = seam(
    after, authority, authority + indent + indent + 'selectionCurrent?.();\n',
    'host file commit selection assertion',
  );
  let next = source.slice(0, fileOperation.start) + after + source.slice(fileOperation.end);
  const write = functionRange(next, 'writeMcpAppHostFile');
  const approve = 'await requireMcpAppInteraction(view);';
  let writeBody = seam(
    write.text, approve,
    `const selectionCurrent = view.${FILE_SELECTION}?.();\n${indent}${approve}\n${indent}selectionCurrent?.();`,
    'host file write admission selection capture',
  );
  const mutationArgument = '}, true);';
  writeBody = seam(
    writeBody, mutationArgument, '}, true, selectionCurrent);',
    'host file write selection fence',
  );
  const conflict = writeBody.match(/return (\w+)\.status === "conflict" \?/)?.[1];
  if (!conflict) throw new Error(`${file}: host file write conflict response changed`);
  const response = `return ${conflict}.status === "conflict" ?`;
  writeBody = seam(
    writeBody, response,
    `if (${conflict}.status === "conflict") assertCurrent();\n${indent.repeat(2)}${response}`,
    'host file conflict selection assertion',
  );
  next = next.slice(0, write.start) + writeBody + next.slice(write.end);
  if (!patched && countOccurrences(source, FILE_SELECTION))
    throw new Error(`${file}: partial host file selection setup`);
  return patched ? next : prepend(next, `// ${CONTRACT}\n`);
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const runtimeFiles = findFilesContaining(root, 'function prepareMcpAppExtensionRuntime(');
  const hostFiles = findFilesContaining(root, 'function withHostFile(');
  assertTargetPaths(root, runtimeFiles, [NATIVE, ...bundle], 'MCP App model continuity');
  assertTargetPaths(root, hostFiles, [FILES, ...bundle], 'MCP App host file model continuity');
  const plan = (name, nativeSource) => {
    const file = path.join(root, name);
    const source = fs.readFileSync(file, 'utf8');
    return { file, source, next: transform(source, file, nativeSource) };
  };
  const native = plan(NATIVE);
  const plans = [native, plan(FILES), ...bundle.map(name => plan(name, native.next))];
  if (plans.some(plan => plan.source === plan.next) && plans.some(plan => plan.source !== plan.next))
    throw new Error('Source and bundle MCP App model continuity are partially applied');
  if (verify && plans.some(plan => plan.source !== plan.next))
    throw new Error('MCP App model continuity is missing');
  return plans.flatMap(plan =>
    !verify && writeIfChanged(plan.file, plan.source, plan.next)
      ? [path.relative(root, plan.file)]
      : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT, NATIVE, FILES },
};
