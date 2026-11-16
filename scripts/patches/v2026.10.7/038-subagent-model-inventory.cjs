'use strict';

// Capability: admit a new subagent model check without borrowing the parent turn's plugin inventory.
// Target: pinned openclaw@2026.10.7 inherits the parent inventory during sessions_spawn model verification.
// Scope: the read-only model preflight for native subagents, in the source chunk and Gateway bundle.
// Safety: reuse native generation isolation and keep the exact config, target, caller and parent model lease.
// Remove when: native sessions_spawn verifies a new child's model from a committed inventory after parent inventory retirement.

const fs = require('node:fs');
const path = require('node:path');
const {
  assertCurrentPatchContract,
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  readRuntimeTextFile,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');
const { assertTargetPaths, functionRange, one, same } = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_SUBAGENT_MODEL_INVENTORY_V2026_10_7';
const TARGET = 'dist/spawn-thread-binding-CKE2AseF.mjs';
const OWNER = 'resolveSubagentModelAndThinkingPlan';
const SCOPE = 'runOutsidePluginRuntimeGenerationScope';
const MODEL_IMPORT = 'import { t as prepareModelChoice } from "./model-runtime-choice-B7hQ9HF8.mjs";';
const SCOPE_IMPORT = `import { ${SCOPE} } from "./generation-scope-k4t_r2fI.mjs";`;
const CALL = 'prepareModelChoice({ cfg: params.cfg, agentId: params.targetAgentId, ' +
  'workspaceDir: params.workspaceDir, raw: rawResolvedModel, ' +
  'source: modelOverrideSource === "user" ? "override" : "automatic", ' +
  '...inheritedModel ? { resolvedRef: inheritedModel } : {}, ' +
  '...modelOverrideSource === "auto" ? { fallbacks: modelFallbackOverrideFromAvailability(' +
  'resolveModelFallbackAvailability({ cfg: params.cfg, agentId: params.targetAgentId, ' +
  'hasSessionModelOverride: true, modelOverrideSource: "auto", subagentSpawnLineage: true })) } : {} })';
const MARKER = `/*${CONTRACT}*/`;

function verifyBundledScope(source, file) {
  const scope = functionRange(source, SCOPE).text;
  const binding = /^function \w+\((\w+)\)\s*\{\s*return ([^;]+);\s*\}$/u.exec(scope);
  if (!binding || !same(binding[2], 'runOutsidePluginRuntimeGenerationRegistryScope(() => ' +
      'runOutsidePluginMetadataSnapshotScope(() => ' +
      `runOutsidePluginRuntimeRegistryScope(${binding[1]})))`)) {
    throw new Error(`${file}: native plugin generation isolation changed`);
  }
  const initializer = one([...source.matchAll(
    /\bvar init_spawn_thread_binding_CKE2AseF = __esm\(\{\s*"[^"]*dist\/spawn-thread-binding-CKE2AseF\.mjs"\(\)\s*\{/gu,
  )], 'subagent model bundle initializer');
  const start = initializer.index + initializer[0].length - 1;
  const end = findMatchingDelimiter(source, start, '{', '}', 'subagent model bundle initializer');
  if (countOccurrences(source.slice(start, end), 'init_generation_scope_k4t_r2fI();') !== 1) {
    throw new Error(`${file}: subagent model bundle is missing its plugin generation initializer`);
  }
}

function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const bundle = isGatewayBundlePath(file);
  if (bundle) {
    verifyBundledScope(source, file);
  } else if (countOccurrences(source, MODEL_IMPORT) !== 1) {
    throw new Error(`${file}: native model verification import changed`);
  }

  const owner = functionRange(source, OWNER);
  const assignment = one([...owner.text.matchAll(/\bchoice = await ([^;]+);/gu)], OWNER);
  const expression = assignment[1];
  const marked = expression.startsWith(MARKER);
  const markerCount = countOccurrences(source, CONTRACT);
  const scopeImports = countOccurrences(source, SCOPE_IMPORT);
  const current = same(marked ? expression.slice(MARKER.length).trimStart() : expression, `${SCOPE}(() => ${CALL})`);
  if (current && markerCount === Number(marked) && (bundle || (marked && scopeImports === 1))) {
    return source;
  }
  if (bundle || markerCount !== 0 || scopeImports !== 0 || !same(expression, CALL)) {
    throw new Error(`${file}: partial or changed subagent model verification; rebuild pristine runtime`);
  }

  const start = owner.start + assignment.index + 'choice = await '.length;
  const updated = source.slice(0, start) + `${MARKER} ${SCOPE}(() => ${expression})` +
    source.slice(start + expression.length);
  return replaceUnique(updated, MODEL_IMPORT,
    `${MODEL_IMPORT}${source.includes('\r\n') ? '\r\n' : '\n'}${SCOPE_IMPORT}`, 'subagent model import');
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, `function ${OWNER}(`);
  assertTargetPaths(root, files, [TARGET, ...bundle], 'subagent model verification');
  const plans = files.map(file => {
    const source = readRuntimeTextFile(file);
    return { file, source, next: transform(source, file) };
  });
  const pending = plans.filter(({ source, next }) => source !== next);
  if (pending.length === 0) return [];
  if (verify) throw new Error('Subagent model verification must acquire its own plugin inventory');
  if (pending.length !== plans.length) {
    throw new Error('Mixed source/bundle subagent model verification; rebuild pristine runtime');
  }
  return pending.filter(({ file, source, next }) => writeIfChanged(file, source, next))
    .map(({ file }) => path.relative(root, file));
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET },
};
