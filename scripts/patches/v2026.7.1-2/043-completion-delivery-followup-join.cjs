'use strict';

// Capability: keep new required children joined when a completion delivery run spawns follow-up work.
// Target: patched openclaw@2026.7.1-2 after patches 041 and 042.
// Scope: completion-source exclusion in the implicit terminal join path.
// Safety: the child currently being announced stays on native delivery; uncorrelated provenance fails closed.
// Remove when: upstream joins follow-up children without recursively consuming the announcing child.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_COMPLETION_DELIVERY_FOLLOWUP_JOIN_V2026_7_1_2';

function resolveJustDoCompletionSourceSessionKey(inputProvenance) {
  if (
    inputProvenance?.kind !== 'inter_session' ||
    inputProvenance?.sourceTool?.trim().toLowerCase() !== 'subagent_announce'
  )
    return undefined;
  return typeof inputProvenance.sourceSessionKey === 'string'
    ? inputProvenance.sourceSessionKey.trim()
    : '';
}

function resolveJustDoCompletionFollowupJoin(
  entries,
  controllerSessionKey,
  completionSourceSessionKey,
  registeredRuns,
) {
  if (completionSourceSessionKey === undefined) return { kind: 'ordinary', entries };
  const controller = typeof controllerSessionKey === 'string' ? controllerSessionKey.trim() : '';
  const source =
    typeof completionSourceSessionKey === 'string' ? completionSourceSessionKey.trim() : '';
  if (!controller || !source) return { kind: 'malformed', entries: [] };
  // Descendant settlement wakes a subagent through a synthetic announce whose source is itself.
  // Require its parent-owned registry row before accepting that exception; a root self-source or
  // stale/forged provenance must not bypass direct-source correlation.
  if (source === controller) {
    for (const entry of registeredRuns ?? []) {
      const requester = entry?.requesterSessionKey?.trim();
      if (
        entry?.runId &&
        entry?.childSessionKey?.trim() === controller &&
        requester &&
        requester !== controller
      )
        return { kind: 'descendant_wake', entries };
    }
    return { kind: 'malformed', entries: [] };
  }
  // Direct announce provenance is runtime-owned. Correlate it with the exact still-native
  // completion obligation before transferring ownership of any sibling/follow-up entry.
  const sourceEntry = entries.find(
    entry =>
      entry?.childSessionKey?.trim() === source &&
      entry?.requesterSessionKey?.trim() === controller &&
      entry?.expectsCompletionMessage === true &&
      entry?.completion?.required !== false &&
      entry?.delivery?.status !== 'delivered' &&
      entry?.delivery?.status !== 'discarded' &&
      !entry?.delivery?.justDoManagedJoin,
  );
  if (!sourceEntry) return { kind: 'malformed', entries: [] };
  return {
    kind: 'direct_completion',
    entries: entries.filter(entry => entry?.childSessionKey?.trim() !== source),
  };
}

function transformTools(content, filePath) {
  const contracts = [
    'function resolveJustDoCompletionFollowupJoin(',
    'completionFollowupJoin.entries',
    'subagentRuns.values()',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial completion-delivery follow-up tools patch detected`);
  let updated = replaceUnique(
    content,
    'async function waitForJustDoRequiredSubagentsAtTerminalCore(params) {',
    `// ${MARKER}\n${resolveJustDoCompletionFollowupJoin.toString()}\nasync function waitForJustDoRequiredSubagentsAtTerminalCore(params) {`,
    `${filePath}: completion-delivery source correlation helper`,
  );
  return replaceUniquePattern(
    updated,
    /const visibleRuns = selectJustDoImplicitJoinRuns\(listControlledSubagentRuns\(controllerSessionKey\), controllerSessionKey\);/,
    'const selectedRuns = selectJustDoImplicitJoinRuns(listControlledSubagentRuns(controllerSessionKey), controllerSessionKey);\n\tconst completionFollowupJoin = resolveJustDoCompletionFollowupJoin(selectedRuns, controllerSessionKey, params?.excludedChildSessionKey, subagentRuns.values());\n\tconst visibleRuns = completionFollowupJoin.entries;',
    `${filePath}: completion-delivery terminal join correlation`,
  );
}

function transformAttempt(content, filePath) {
  const contracts = [
    'completionDeliveryRun: completionSourceSessionKey',
    'excludedChildSessionKey: completionSourceSessionKey',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial completion-delivery follow-up attempt patch detected`);
  let updated = replaceUniquePattern(
    content,
    /^(?<indent>[ \t]+)let beforeAgentFinalizeRevisionReason;$/m,
    `$<indent>// ${MARKER}\n${resolveJustDoCompletionSourceSessionKey.toString()}\n$<indent>let beforeAgentFinalizeRevisionReason;`,
    `${filePath}: completion-delivery source resolver`,
  );
  updated = replaceUniquePattern(
    updated,
    /(?<indent>[ \t]+)const hasCompletedClientToolCall = clientToolCallSlots\.some\(\(slot\) => slot\.completed\);/,
    '$<indent>const hasCompletedClientToolCall = clientToolCallSlots.some((slot) => slot.completed);\n$<indent>const completionSourceSessionKey = resolveJustDoCompletionSourceSessionKey(params.inputProvenance);',
    `${filePath}: completion-delivery source capture`,
  );
  updated = replaceUnique(
    updated,
    'completionDeliveryRun: isJustDoSubagentCompletionDeliveryRun(params.inputProvenance)',
    'completionDeliveryRun: completionSourceSessionKey === ""',
    `${filePath}: completion-delivery malformed provenance guard`,
  );
  return replaceUniquePattern(
    updated,
    /(?<indent>[ \t]+)runId: params\.runId,\n\k<indent>abortSignal: runAbortController\.signal/,
    '$<indent>runId: params.runId,\n$<indent>excludedChildSessionKey: completionSourceSessionKey,\n$<indent>abortSignal: runAbortController.signal',
    `${filePath}: completion-delivery source exclusion`,
  );
}

function locateTargets(runtimeDir) {
  const unique = files => [...new Set(files)];
  const tools = unique([
    ...findFilesContaining(runtimeDir, [
      'function waitForJustDoRequiredSubagentsAtTerminalCore(params)',
      'function selectJustDoImplicitJoinRuns(entries, controllerSessionKey)',
    ]),
    ...findFilesContaining(runtimeDir, [
      'function resolveJustDoCompletionFollowupJoin(',
      'completionFollowupJoin.entries',
      'subagentRuns.values()',
    ]),
  ]);
  const attempt = unique([
    ...findFilesContaining(runtimeDir, [
      'function shouldAttemptJustDoImplicitJoin(params)',
      'completionDeliveryRun: isJustDoSubagentCompletionDeliveryRun(params.inputProvenance)',
    ]),
    ...findFilesContaining(runtimeDir, [
      'completionDeliveryRun: completionSourceSessionKey',
      'excludedChildSessionKey: completionSourceSessionKey',
    ]),
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (tools.length !== expected || attempt.length !== expected)
    throw new Error(
      `completion-delivery follow-up join target counts are tools=${tools.length}, attempt=${attempt.length}; expected ${expected}`,
    );
  return { tools, attempt };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const [name, transform] of [
    ['tools', transformTools],
    ['attempt', transformAttempt],
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
        'function resolveJustDoCompletionFollowupJoin(',
        'completionFollowupJoin.entries',
        'descendant_wake',
        'subagentRuns.values()',
      ],
    ],
    [
      'attempt',
      targets.attempt,
      [
        'inputProvenance.sourceSessionKey',
        'completionDeliveryRun: completionSourceSessionKey',
        'excludedChildSessionKey: completionSourceSessionKey',
      ],
    ],
  ])
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const contract of contracts)
        if (!content.includes(contract))
          throw new Error(
            `${filePath}: completion-delivery follow-up ${name} contract is missing ${contract}`,
          );
    }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    resolveJustDoCompletionSourceSessionKey,
    resolveJustDoCompletionFollowupJoin,
    transformTools,
    transformAttempt,
  },
};
