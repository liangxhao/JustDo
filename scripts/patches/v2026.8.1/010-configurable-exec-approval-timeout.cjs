'use strict';

// Capability: let the JustDo host configure native exec approval wait time.
// Target: openclaw@2026.8.1 exec runtime, agent Gateway client, and approval manager.
// Scope: the native exec approval request/wait deadline only.
// Safety: finite waits remain bounded; zero is an explicit no-expiry sentinel.
// Remove when: upstream exposes an exec approval timeout configuration setting.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  isGatewayBundlePath,
  normalizeJustDoGatewayBundle,
  writeIfChanged,
} = require('./_patch-utils.js');

const ENV_NAME = 'JUSTDO_EXEC_APPROVAL_TIMEOUT_MS';
const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
const INDEFINITE_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
const MARKERS = {
  defaults: 'JUSTDO_CONFIGURABLE_EXEC_APPROVAL_TIMEOUT_DEFAULTS_V2026_8_1',
  gateway: 'JUSTDO_CONFIGURABLE_EXEC_APPROVAL_TIMEOUT_GATEWAY_V2026_8_1',
  manager: 'JUSTDO_CONFIGURABLE_EXEC_APPROVAL_TIMEOUT_MANAGER_V2026_8_1',
  request: 'JUSTDO_CONFIGURABLE_EXEC_APPROVAL_REQUEST_TIMEOUT_V2026_8_1',
  wait: 'JUSTDO_CONFIGURABLE_EXEC_APPROVAL_TIMEOUT_WAIT_V2026_8_1',
};

const DEFAULT_TIMEOUT_PATTERN =
  /DEFAULT_APPROVAL_TIMEOUT_MS\s*=\s*DEFAULT_EXEC_APPROVAL_TIMEOUT_MS/g;
const REQUEST_TIMEOUT_PATTERN =
  /DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS\s*=\s*DEFAULT_APPROVAL_TIMEOUT_MS\s*\+\s*1e4/g;
const WAIT_TIMEOUT_PATTERN =
  /(callGatewayTool\((["'\x60])exec\.approval\.waitDecision\2,\s*\{\s*timeoutMs:\s*)DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS(\s*\})/g;
const GATEWAY_TIMEOUT_PATTERN =
  /typeof\s+([A-Za-z_$][\w$]*)\?\.timeoutMs\s*={2,3}\s*(["'\x60])number\2\s*&&\s*Number\.isFinite\(\1\.timeoutMs\)\s*\?\s*Math\.max\(1,\s*Math\.floor\(\1\.timeoutMs\)\)\s*:\s*3e4/g;
const MANAGER_EXPIRY_PATTERN =
  /((?:(?:const|let)\s+)?[A-Za-z_$][\w$]*\s*=\s*)resolveExpiresAtMsFromDurationMs\(resolveApprovalTimeoutMs\(([A-Za-z_$][\w$]*)\),\s*\{\s*nowMs:\s*([A-Za-z_$][\w$]*)\s*\}\)/g;

const PATCHED_DEFAULT_TIMEOUT = `DEFAULT_APPROVAL_TIMEOUT_MS=(()=>{const justDoApprovalTimeout=process.env.${ENV_NAME};if(justDoApprovalTimeout==="0")return Number.MAX_SAFE_INTEGER;const justDoApprovalTimeoutMs=Number(justDoApprovalTimeout);return Number.isFinite(justDoApprovalTimeoutMs)&&justDoApprovalTimeoutMs>0?Math.min(Math.floor(justDoApprovalTimeoutMs),${MAX_TIMER_TIMEOUT_MS}):DEFAULT_EXEC_APPROVAL_TIMEOUT_MS})()/*${MARKERS.defaults}*/`;
const PATCHED_REQUEST_TIMEOUT =
  'DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS=DEFAULT_APPROVAL_TIMEOUT_MS===Number.MAX_SAFE_INTEGER?3e4:DEFAULT_APPROVAL_TIMEOUT_MS+1e4';
const PATCHED_WAIT_PATTERN = new RegExp(
  `(callGatewayTool\\((["'\\x60])exec\\.approval\\.waitDecision\\2,\\s*\\{\\s*timeoutMs:\\s*)DEFAULT_APPROVAL_TIMEOUT_MS===Number\\.MAX_SAFE_INTEGER\\?null:DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS\\/\\*${MARKERS.wait}\\*\\/(\\s*\\})`,
  'g',
);
const PATCHED_GATEWAY_PATTERN = new RegExp(
  `([A-Za-z_$][\\w$]*)\\?\\.timeoutMs===null\\?null:typeof\\s+\\1\\?\\.timeoutMs\\s*={2,3}\\s*(["'\\x60])number\\2\\s*&&\\s*Number\\.isFinite\\(\\1\\.timeoutMs\\)\\s*\\?\\s*Math\\.max\\(1,\\s*Math\\.floor\\(\\1\\.timeoutMs\\)\\)\\s*:\\s*3e4\\/\\*${MARKERS.gateway}\\*\\/`,
  'g',
);
const PATCHED_MANAGER_PATTERN = new RegExp(
  `((?:(?:const|let)\\s+)?[A-Za-z_$][\\w$]*\\s*=\\s*)process\\.env\\.${ENV_NAME}===["']0["']&&([A-Za-z_$][\\w$]*)===Number\\.MAX_SAFE_INTEGER\\?Number\\.MAX_SAFE_INTEGER:resolveExpiresAtMsFromDurationMs\\(resolveApprovalTimeoutMs\\(\\2\\),\\s*\\{\\s*nowMs:\\s*([A-Za-z_$][\\w$]*)\\s*\\}\\)\\/\\*${MARKERS.manager}\\*\\/`,
  'g',
);
const BUNDLE_DEFAULT_TIMEOUT_PATTERN =
  /DEFAULT_APPROVAL_TIMEOUT_MS=\(\(\)=>\{constjustDoApprovalTimeout=process\.env\.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS;if\(justDoApprovalTimeout===["']0["']\)returnNumber\.MAX_SAFE_INTEGER;constjustDoApprovalTimeoutMs=Number\(justDoApprovalTimeout\);returnNumber\.isFinite\(justDoApprovalTimeoutMs\)&&justDoApprovalTimeoutMs>0\?Math\.min\(Math\.floor\(justDoApprovalTimeoutMs\),(?:2147000000|2147e6)\):DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;?\}\)\(\)/g;
const BUNDLE_REQUEST_TIMEOUT_PATTERN =
  /DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS=DEFAULT_APPROVAL_TIMEOUT_MS===Number\.MAX_SAFE_INTEGER\?3e4:DEFAULT_APPROVAL_TIMEOUT_MS\+1e4/g;
const BUNDLE_WAIT_TIMEOUT_PATTERN =
  /callGatewayTool\((["'`])exec\.approval\.waitDecision\1,\{timeoutMs:DEFAULT_APPROVAL_TIMEOUT_MS===Number\.MAX_SAFE_INTEGER\?null:DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS\}/g;
const BUNDLE_GATEWAY_TIMEOUT_PATTERN =
  /([A-Za-z_$][\w$]*)\?\.timeoutMs===null\?null:typeof\1\?\.timeoutMs===["'`]number["'`]&&Number\.isFinite\(\1\.timeoutMs\)\?Math\.max\(1,Math\.floor\(\1\.timeoutMs\)\):3e4/g;
const BUNDLE_MANAGER_EXPIRY_PATTERN =
  /[A-Za-z_$][\w$]*=process\.env\.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS===["']0["']&&([A-Za-z_$][\w$]*)===Number\.MAX_SAFE_INTEGER\?Number\.MAX_SAFE_INTEGER:resolveExpiresAtMsFromDurationMs\(resolveApprovalTimeoutMs\(\1\),\{nowMs:[A-Za-z_$][\w$]*\}\)/g;

function resolveJustDoExecApprovalTimeoutMs(value, fallback) {
  if (value === '0') return INDEFINITE_EXPIRES_AT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_TIMER_TIMEOUT_MS)
    : fallback;
}

function matchCount(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function verifyGatewayBundleContract(content, filePath, contracts) {
  if (!isGatewayBundlePath(filePath)) return false;
  const normalized = normalizeJustDoGatewayBundle(content, filePath);
  for (const { label, pattern } of contracts) {
    const count = matchCount(normalized, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: historical or partial ${label} bundle contract detected; ` +
          `target count is ${count}, expected 1`,
      );
    }
  }
  return true;
}

function assertSingleContract(
  content,
  filePath,
  marker,
  originalCount,
  patchedCount,
  label,
  patchedOriginalCount = 0,
) {
  const markerCount = countOccurrences(content, marker);
  if (markerCount > 0 || patchedCount > 0) {
    if (markerCount === 1 && patchedCount === 1 && originalCount === patchedOriginalCount) {
      return true;
    }
    throw new Error(`${filePath}: historical or partial ${label} patch detected`);
  }
  if (originalCount !== 1) {
    throw new Error(`${filePath}: ${label} target count is ${originalCount}, expected 1`);
  }
  return false;
}

function transformDefaults(content, filePath) {
  if (
    verifyGatewayBundleContract(content, filePath, [
      { label: 'approval-timeout defaults', pattern: BUNDLE_DEFAULT_TIMEOUT_PATTERN },
      { label: 'approval request timeout', pattern: BUNDLE_REQUEST_TIMEOUT_PATTERN },
    ])
  ) {
    return content;
  }
  const defaultCount = [...content.matchAll(DEFAULT_TIMEOUT_PATTERN)].length;
  const requestCount = [...content.matchAll(REQUEST_TIMEOUT_PATTERN)].length;
  const alreadyPatched = assertSingleContract(
    content,
    filePath,
    MARKERS.defaults,
    defaultCount,
    countOccurrences(content, PATCHED_DEFAULT_TIMEOUT),
    'approval-timeout defaults',
  );
  const requestMarker = MARKERS.request;
  const requestAlreadyPatched = assertSingleContract(
    content,
    filePath,
    requestMarker,
    requestCount,
    countOccurrences(content, `${PATCHED_REQUEST_TIMEOUT}/*${requestMarker}*/`),
    'approval request timeout',
  );
  if (alreadyPatched !== requestAlreadyPatched) {
    throw new Error(`${filePath}: partial approval-timeout defaults patch detected`);
  }
  if (alreadyPatched && requestAlreadyPatched) return content;
  return content
    .replace(DEFAULT_TIMEOUT_PATTERN, PATCHED_DEFAULT_TIMEOUT)
    .replace(REQUEST_TIMEOUT_PATTERN, `${PATCHED_REQUEST_TIMEOUT}/*${requestMarker}*/`);
}

function transformWait(content, filePath) {
  if (
    verifyGatewayBundleContract(content, filePath, [
      { label: 'approval wait transport timeout', pattern: BUNDLE_WAIT_TIMEOUT_PATTERN },
    ])
  ) {
    return content;
  }
  const originalCount = [...content.matchAll(WAIT_TIMEOUT_PATTERN)].length;
  if (
    assertSingleContract(
      content,
      filePath,
      MARKERS.wait,
      originalCount,
      matchCount(content, PATCHED_WAIT_PATTERN),
      'approval wait transport timeout',
    )
  )
    return content;
  return content.replace(
    WAIT_TIMEOUT_PATTERN,
    `$1DEFAULT_APPROVAL_TIMEOUT_MS===Number.MAX_SAFE_INTEGER?null:DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS/*${MARKERS.wait}*/$3`,
  );
}

function transformGateway(content, filePath) {
  if (
    verifyGatewayBundleContract(content, filePath, [
      { label: 'agent Gateway nullable timeout', pattern: BUNDLE_GATEWAY_TIMEOUT_PATTERN },
    ])
  ) {
    return content;
  }
  const originalCount = [...content.matchAll(GATEWAY_TIMEOUT_PATTERN)].length;
  if (
    assertSingleContract(
      content,
      filePath,
      MARKERS.gateway,
      originalCount,
      matchCount(content, PATCHED_GATEWAY_PATTERN),
      'agent Gateway nullable timeout',
      1,
    )
  )
    return content;
  return content.replace(
    GATEWAY_TIMEOUT_PATTERN,
    (match, optionsName) => `${optionsName}?.timeoutMs===null?null:${match}/*${MARKERS.gateway}*/`,
  );
}

function transformManager(content, filePath) {
  if (
    verifyGatewayBundleContract(content, filePath, [
      { label: 'approval manager indefinite expiry', pattern: BUNDLE_MANAGER_EXPIRY_PATTERN },
    ])
  ) {
    return content;
  }
  const originalCount = [...content.matchAll(MANAGER_EXPIRY_PATTERN)].length;
  if (
    assertSingleContract(
      content,
      filePath,
      MARKERS.manager,
      originalCount,
      matchCount(content, PATCHED_MANAGER_PATTERN),
      'approval manager indefinite expiry',
    )
  )
    return content;
  return content.replace(
    MANAGER_EXPIRY_PATTERN,
    (_match, assignment, timeoutName, nowName) =>
      `${assignment}process.env.${ENV_NAME}==="0"&&${timeoutName}===Number.MAX_SAFE_INTEGER?Number.MAX_SAFE_INTEGER:resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(${timeoutName}),{nowMs:${nowName}})/*${MARKERS.manager}*/`,
  );
}

function expectedTargetCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function locateTargets(runtimeDir, terms, marker, label) {
  const targets = new Set(findFilesContaining(runtimeDir, terms));
  for (const filePath of findFilesContaining(runtimeDir, [marker])) targets.add(filePath);
  const expected = expectedTargetCount(runtimeDir);
  if (targets.size !== expected) {
    throw new Error(`${label} target count is ${targets.size}, expected ${expected}`);
  }
  return [...targets];
}

function locateAllTargets(runtimeDir) {
  return [
    [
      locateTargets(
        runtimeDir,
        ['DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS', 'DEFAULT_EXEC_APPROVAL_TIMEOUT_MS'],
        MARKERS.defaults,
        'Configurable exec approval-timeout defaults',
      ),
      transformDefaults,
    ],
    [
      locateTargets(
        runtimeDir,
        ['resolveRegisteredExecApprovalDecision', 'DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS'],
        MARKERS.wait,
        'Configurable exec approval wait',
      ),
      transformWait,
    ],
    [
      locateTargets(
        runtimeDir,
        ['APPROVAL_RUNTIME_METHODS', 'function resolveGatewayOptions'],
        MARKERS.gateway,
        'Configurable agent Gateway timeout',
      ),
      transformGateway,
    ],
    [
      locateTargets(
        runtimeDir,
        ['approval expiry is unavailable'],
        MARKERS.manager,
        'Configurable approval manager expiry',
      ),
      transformManager,
    ],
  ];
}

function applyPatch(runtimeDir) {
  const changed = new Set();
  for (const [targets, transformer] of locateAllTargets(runtimeDir)) {
    for (const filePath of targets) {
      const original = fs.readFileSync(filePath, 'utf8');
      const updated = transformer(original, filePath);
      if (writeIfChanged(filePath, original, updated)) {
        changed.add(path.relative(runtimeDir, filePath));
      }
    }
  }
  return [...changed];
}

function verifyPatch(runtimeDir) {
  for (const [targets, transformer] of locateAllTargets(runtimeDir)) {
    for (const filePath of targets) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (transformer(content, filePath) !== content) {
        throw new Error(`${filePath}: configurable exec approval-timeout contract is incomplete`);
      }
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    ENV_NAME,
    INDEFINITE_EXPIRES_AT_MS,
    MARKERS,
    MAX_TIMER_TIMEOUT_MS,
    PATCHED_DEFAULT_TIMEOUT,
    PATCHED_REQUEST_TIMEOUT,
    resolveJustDoExecApprovalTimeoutMs,
    transformDefaults,
    transformGateway,
    transformManager,
    transformWait,
  },
};
