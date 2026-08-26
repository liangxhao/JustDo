'use strict';

// Capability: transfer unfinished explicit managed joins into terminal guards without losing ownership.
// Target: patched openclaw@2026.7.1-2 after patches 041-043.
// Scope: explicit-to-implicit join handoff, atomic in-memory rollback, Codex terminal continuation.
// Safety: exact controller/run provenance is required; committed results and foreign joins stay fenced.
// Remove when: upstream atomically joins unfinished explicit waits across every terminal backend.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, writeIfChanged } = require('./_patch-utils.js');
const core = require('./_managed-terminal-handoff-core.js');
const codex = require('./_managed-terminal-handoff-codex.js');
const {
  isJustDoExplicitWaitingHandoff,
  canCorrelateJustDoCompletionSourceEntry,
  mutateJustDoManagedJoinEntriesAtomically,
  restoreJustDoManagedJoinSnapshotsInPlace,
  mutateJustDoSubagentRegistryAtomically,
  shouldAttemptJustDoCodexTerminalHandoff,
  resolveJustDoCodexTerminalHandoffOutcome,
  transformTools,
  transformEmbeddedAttempt,
  transformRegistry,
} = core;
const {
  transformCodexAttempt,
  transformCodexMirror,
  verifyJustDoCodexPluginTransforms,
  patchJustDoOfficialCodexPlugin,
  transformPluginLoader,
  transformRuntimePluginInstall,
  computeJustDoCodexTransformInputFingerprint,
  CODEX_PLUGIN_TRANSFORM_INPUT_SHA256,
} = codex;

const MARKER = 'JUSTDO_MANAGED_TERMINAL_HANDOFF_V2026_7_1_2';

function locateTargets(runtimeDir) {
  const unique = files => [...new Set(files)];
  const tools = unique([
    ...findFilesContaining(runtimeDir, [
      'function selectJustDoImplicitJoinRuns(',
      'function resolveJustDoCompletionFollowupJoin(',
      'function mutateJustDoManagedJoinEntries(',
    ]),
    ...findFilesContaining(runtimeDir, [
      MARKER,
      'function mutateJustDoManagedJoinEntriesAtomically(',
    ]),
  ]);
  const embeddedAttempt = unique([
    ...findFilesContaining(runtimeDir, [
      'implicitJoin?.status === "joined"',
      'return { suppressTerminalDelivery: true };',
    ]),
    ...findFilesContaining(runtimeDir, [
      'promptError = new Error("Managed subagent terminal handoff could not be persisted.")',
    ]),
  ]);
  const pluginLoader = unique([
    ...findFilesContaining(runtimeDir, [
      'function loadOpenClawPlugins(',
      '"cli-metadata", () => loadPluginModule(safeSource)',
    ]),
    ...findFilesContaining(runtimeDir, [
      'function patchJustDoOfficialCodexPlugin(params)',
      'phase: "justdo-codex-runtime-patch"',
    ]),
  ]);
  const runtimePluginInstall = unique([
    ...findFilesContaining(runtimeDir, [
      'async function ensureRuntimePluginForModelSelection(params)',
      'repairRuntimePluginInstallForModelSelection({',
    ]),
    ...findFilesContaining(runtimeDir, [
      'async function ensureRuntimePluginForModelSelection(params)',
      'repair.changes.length > 0',
    ]),
  ]);
  const registry = unique([
    ...findFilesContaining(runtimeDir, [
      'function markJustDoManagedJoinToolResultPersisted(',
      'function commitJustDoManagedJoinContinuation(',
      'function restoreJustDoManagedJoinDelivery(',
    ]),
    ...findFilesContaining(runtimeDir, ['function mutateJustDoSubagentRegistryAtomically(']),
  ]);
  const bundleExpected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  for (const [name, files, expected] of [
    ['tools', tools, bundleExpected],
    ['embeddedAttempt', embeddedAttempt, bundleExpected],
    ['registry', registry, bundleExpected],
    ['pluginLoader', pluginLoader, bundleExpected],
    ['runtimePluginInstall', runtimePluginInstall, bundleExpected],
  ])
    if (files.length !== expected)
      throw new Error(
        `managed terminal handoff ${name} target count is ${files.length}, expected ${expected}`,
      );
  return { tools, embeddedAttempt, registry, pluginLoader, runtimePluginInstall };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const [name, transform] of [
    ['tools', transformTools],
    ['embeddedAttempt', transformEmbeddedAttempt],
    ['registry', transformRegistry],
    ['pluginLoader', transformPluginLoader],
    ['runtimePluginInstall', transformRuntimePluginInstall],
  ])
    for (const filePath of targets[name])
      transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (value, transform) => transform(value, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  for (const [name, files, contracts] of [
    [
      'tools',
      targets.tools,
      [
        MARKER,
        'gatewayRunId: opts.runId',
        'mutateJustDoManagedJoinEntriesAtomically(',
        'function restoreJustDoManagedJoinSnapshotsInPlace(',
        'restoreJustDoManagedJoinSnapshotsInPlace(subagentRuns, snapshots);',
        'canCorrelateJustDoCompletionSourceEntry(',
        'subagentRuns.values(), params?.runId)',
      ],
    ],
    [
      'embeddedAttempt',
      targets.embeddedAttempt,
      [
        'promptError = new Error("Managed subagent terminal handoff could not be persisted.")',
        'promptErrorSource = "prompt"',
      ],
    ],
    [
      'registry',
      targets.registry,
      [
        'function mutateJustDoSubagentRegistryAtomically(',
        'return mutateJustDoSubagentRegistryAtomically(subagentRuns, () => {',
        'deleteRunIds } = mutateJustDoSubagentRegistryAtomically(',
        'restoredRunIds } = mutateJustDoSubagentRegistryAtomically(',
      ],
    ],
    [
      'pluginLoader',
      targets.pluginLoader,
      [
        'function patchJustDoOfficialCodexPlugin(params)',
        'installRecord: installRecords[pluginId]',
        'phase: "justdo-codex-runtime-patch"',
        'CODEX_PLUGIN_PRISTINE_HASHES',
        'CODEX_PLUGIN_PATCHED_HASHES',
      ],
    ],
    ['runtimePluginInstall', targets.runtimePluginInstall, ['repair.changes.length > 0']],
  ])
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const contract of contracts)
        if (!content.includes(contract))
          throw new Error(
            `${filePath}: managed terminal handoff ${name} contract is missing ${contract}`,
          );
      if (name === 'runtimePluginInstall') {
        const cacheContract =
          path.basename(filePath) === 'gateway-bundle.mjs'
            ? /if \(repair\.changes\.length > 0\)[\s\S]{0,240}?clearPluginLoaderCache\d*\(\);/.test(
                content,
              )
            : content.includes('clearPluginLoaderCache();');
        if (!cacheContract)
          throw new Error(
            `${filePath}: managed terminal handoff runtime repair cache contract is missing`,
          );
      }
      if (name === 'tools') {
        const restoreCallCount =
          content.split('restoreJustDoManagedJoinSnapshotsInPlace(subagentRuns, snapshots);')
            .length - 1;
        const restoreDefinitionCount =
          content.split('function restoreJustDoManagedJoinSnapshotsInPlace(').length - 1;
        if (restoreCallCount !== 2 || restoreDefinitionCount !== 1)
          throw new Error(
            `${filePath}: managed join outer rollback contract is definitions=${restoreDefinitionCount}/1, calls=${restoreCallCount}/2`,
          );
        if (
          content.includes(
            'for (const [runId, snapshot] of snapshots) subagentRuns.set(runId, snapshot);',
          )
        )
          throw new Error(`${filePath}: legacy managed join entry-replacing rollback remains`);
      }
    }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    isJustDoExplicitWaitingHandoff,
    canCorrelateJustDoCompletionSourceEntry,
    mutateJustDoManagedJoinEntriesAtomically,
    restoreJustDoManagedJoinSnapshotsInPlace,
    mutateJustDoSubagentRegistryAtomically,
    shouldAttemptJustDoCodexTerminalHandoff,
    resolveJustDoCodexTerminalHandoffOutcome,
    transformTools,
    transformEmbeddedAttempt,
    transformRegistry,
    transformCodexAttempt,
    transformCodexMirror,
    verifyJustDoCodexPluginTransforms,
    patchJustDoOfficialCodexPlugin,
    transformPluginLoader,
    transformRuntimePluginInstall,
    computeJustDoCodexTransformInputFingerprint,
    CODEX_PLUGIN_TRANSFORM_INPUT_SHA256,
  },
};
