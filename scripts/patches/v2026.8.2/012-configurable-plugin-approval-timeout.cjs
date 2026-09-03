'use strict';

// Capability: apply the host-selected wait time to native plugin approvals.
// Target: openclaw@2026.8.2 plugin approval bounds and native approval callers.
// Scope: before-tool, CLI-native-tool, and native-hook-relay Gateway waits.
// Safety: finite values stay timer-safe; registration stays bounded; zero is no-expiry.
// Remove when: upstream exposes a host plugin approval timeout/no-expiry setting.

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
const MARKERS = {
  default: 'JUSTDO_CONFIGURABLE_PLUGIN_APPROVAL_DEFAULT_V2026_8_2',
  max: 'JUSTDO_CONFIGURABLE_PLUGIN_APPROVAL_MAX_V2026_8_2',
  cliGateway: 'JUSTDO_CONFIGURABLE_CLI_PLUGIN_APPROVAL_GATEWAY_V2026_8_2',
  cliRegistration: 'JUSTDO_CONFIGURABLE_CLI_PLUGIN_APPROVAL_REGISTRATION_V2026_8_2',
  cliTimeout: 'JUSTDO_CONFIGURABLE_CLI_PLUGIN_APPROVAL_TIMEOUT_V2026_8_2',
  relayRegistration: 'JUSTDO_CONFIGURABLE_RELAY_PLUGIN_APPROVAL_REGISTRATION_V2026_8_2',
  relayTimeout: 'JUSTDO_CONFIGURABLE_RELAY_PLUGIN_APPROVAL_TIMEOUT_V2026_8_2',
  relayWait: 'JUSTDO_CONFIGURABLE_RELAY_PLUGIN_APPROVAL_WAIT_V2026_8_2',
  registration: 'JUSTDO_CONFIGURABLE_PLUGIN_APPROVAL_REGISTRATION_V2026_8_2',
  transport: 'JUSTDO_CONFIGURABLE_PLUGIN_APPROVAL_TRANSPORT_V2026_8_2',
};

const DEFAULT_PATTERN = /(DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS(?:\$\d+)?\s*=\s*)(?:12e4|120_000)/g;
const MAX_PATTERN = /(MAX_PLUGIN_APPROVAL_TIMEOUT_MS(?:\$\d+)?\s*=\s*)(?:6e5|600_000)/g;
const TRANSPORT_PATTERN =
  /(function\s+resolvePluginToolApprovalGatewayTimeoutMs\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+)(addTimerTimeoutGraceMs\(\2\s*,\s*(?:1e4|10_000)\)\s*\?\?\s*(?:13e4|DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS\s*\+\s*(?:1e4|10_000)))(\s*;?\s*\})/g;
const REGISTRATION_PATTERN =
  /(callGatewayTool\(\s*(["'\x60])plugin\.approval\.request\2\s*,\s*\{\s*timeoutMs\s*:\s*)([A-Za-z_$][\w$]*)(\s*\}\s*,\s*\{\s*title\s*:\s*([A-Za-z_$][\w$]*)\.title\s*,\s*description\s*:\s*\5\.description\s*,\s*\.\.\.\5\.scope)/g;
const CLI_TIMEOUT_PATTERN =
  /((?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*)DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS(\s*[,;])/g;
const CLI_GATEWAY_PATTERN =
  /((?:(?:const|let)\s+)?([A-Za-z_$][\w$]*)\s*=\s*)(addTimerTimeoutGraceMs\(\s*([A-Za-z_$][\w$]*)\s*,\s*CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS\s*\)\s*\?\?\s*\4\s*\+\s*CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS)/g;
const CLI_REGISTRATION_PATTERN =
  /(raceCliNativeToolApprovalAbort\(\s*callGatewayTool\(\s*(["'\x60])plugin\.approval\.request\2\s*,\s*\{\s*timeoutMs\s*:\s*)([A-Za-z_$][\w$]*)(\s*\})/g;
const RELAY_TIMEOUT_PATTERN =
  /((?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*)DEFAULT_PERMISSION_TIMEOUT_MS(\s*[,;])/g;

const BUNDLE_IDENTIFIER = '[A-Za-z_$][\\w$]*';

const resolveConfiguredTimeoutExpression = fallback =>
  `(()=>{const justDoPluginApprovalTimeout=process.env.${ENV_NAME};if(justDoPluginApprovalTimeout==="0")return Number.MAX_SAFE_INTEGER;const justDoPluginApprovalTimeoutMs=Number(justDoPluginApprovalTimeout);return Number.isFinite(justDoPluginApprovalTimeoutMs)&&justDoPluginApprovalTimeoutMs>0?Math.min(Math.floor(justDoPluginApprovalTimeoutMs),${MAX_TIMER_TIMEOUT_MS}):${fallback}})()`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchCount(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function bundleConfiguredTimeoutExpressionPattern(fallback) {
  return (
    '\\(\\(\\)=>\\{constjustDoPluginApprovalTimeout=' +
    'process\\.env\\.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS;' +
    'if\\(justDoPluginApprovalTimeout===["\x27]0["\x27]\\)' +
    'returnNumber\\.MAX_SAFE_INTEGER;' +
    'constjustDoPluginApprovalTimeoutMs=Number\\(justDoPluginApprovalTimeout\\);' +
    'returnNumber\\.isFinite\\(justDoPluginApprovalTimeoutMs\\)&&' +
    'justDoPluginApprovalTimeoutMs>0\\?Math\\.min\\(' +
    'Math\\.floor\\(justDoPluginApprovalTimeoutMs\\),(?:2147000000|2147e6)\\):' +
    `${escapeRegExp(fallback)};?\\}\\)\\(\\)`
  );
}

function bundleConfiguredAssignmentPattern(targetPattern, fallback) {
  return new RegExp(`${targetPattern}=${bundleConfiguredTimeoutExpressionPattern(fallback)}`, 'g');
}

const BUNDLE_DEFAULT_PATTERN = bundleConfiguredAssignmentPattern(
  'DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS(?:\\d+)?',
  '12e4',
);
const BUNDLE_MAX_PATTERN = bundleConfiguredAssignmentPattern(
  'MAX_PLUGIN_APPROVAL_TIMEOUT_MS(?:\\d+)?',
  '6e5',
);
const BUNDLE_TRANSPORT_PATTERN = new RegExp(
  `functionresolvePluginToolApprovalGatewayTimeoutMs\\((${BUNDLE_IDENTIFIER})\\)\\{` +
    `return\\1===Number\\.MAX_SAFE_INTEGER\\?null:` +
    `addTimerTimeoutGraceMs\\(\\1,(?:1e4|10000)\\)\\?\\?` +
    `(?:13e4|DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS\\+(?:1e4|10000));?\\}`,
  'g',
);
const BUNDLE_REGISTRATION_PATTERN = new RegExp(
  `callGatewayTool\\((["'\x60])plugin\\.approval\\.request\\1,\\{timeoutMs:` +
    `(${BUNDLE_IDENTIFIER})===null\\?3e4:\\2\\},\\{title:` +
    `(${BUNDLE_IDENTIFIER})\\.title,description:\\3\\.description,\\.\\.\\.\\3\\.scope`,
  'g',
);
const BUNDLE_CLI_TIMEOUT_PATTERN = bundleConfiguredAssignmentPattern(
  BUNDLE_IDENTIFIER,
  'DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS',
);
const BUNDLE_CLI_GATEWAY_PATTERN = new RegExp(
  `(${BUNDLE_IDENTIFIER})=(${BUNDLE_IDENTIFIER})===Number\\.MAX_SAFE_INTEGER\\?null:` +
    `addTimerTimeoutGraceMs\\(\\2,CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS\\)\\?\\?` +
    `\\2\\+CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS`,
  'g',
);
const BUNDLE_CLI_REGISTRATION_PATTERN = new RegExp(
  `raceCliNativeToolApprovalAbort\\(callGatewayTool\\(` +
    `(["'\x60])plugin\\.approval\\.request\\1,\\{timeoutMs:` +
    `(${BUNDLE_IDENTIFIER})===null\\?3e4:\\2\\}`,
  'g',
);
const BUNDLE_RELAY_TIMEOUT_PATTERN = bundleConfiguredAssignmentPattern(
  BUNDLE_IDENTIFIER,
  'DEFAULT_PERMISSION_TIMEOUT_MS',
);
const BUNDLE_RELAY_REGISTRATION_PATTERN = new RegExp(
  `callGatewayTool\\((["'\x60])plugin\\.approval\\.request\\1,\\{timeoutMs:` +
    `(${BUNDLE_IDENTIFIER})===Number\\.MAX_SAFE_INTEGER\\?3e4:\\2\\+(?:1e4|10000)\\},` +
    `\\{pluginId:\x60openclaw-native-hook-relay-`,
  'g',
);
const BUNDLE_RELAY_WAIT_PATTERN = new RegExp(
  `callGatewayTool\\((["'\x60])plugin\\.approval\\.waitDecision\\1,\\{timeoutMs:` +
    `(${BUNDLE_IDENTIFIER})\\.timeoutMs===Number\\.MAX_SAFE_INTEGER\\?null:` +
    `\\2\\.timeoutMs\\+(?:1e4|10000)\\},\\{id:\\2\\.approvalId`,
  'g',
);

function verifyGatewayBundleContracts(content, filePath, contracts) {
  if (!isGatewayBundlePath(filePath)) return false;
  const normalized = normalizeJustDoGatewayBundle(content, filePath);
  for (const { expected = 1, label, pattern } of contracts) {
    const count = matchCount(normalized, pattern);
    if (count !== expected) {
      throw new Error(
        `${filePath}: historical or partial ${label} bundle contract detected; ` +
          `target count is ${count}, expected ${expected}`,
      );
    }
  }
  return true;
}

function assertExactContract({
  content,
  filePath,
  marker,
  patchedPattern,
  originalPattern,
  label,
}) {
  const markerCount = countOccurrences(content, marker);
  const patchedCount = matchCount(content, patchedPattern);
  const originalCount = matchCount(content, originalPattern);
  if (markerCount > 0 || patchedCount > 0) {
    if (markerCount === 1 && patchedCount === 1 && originalCount === 0) return true;
    throw new Error(`${filePath}: historical or partial ${label} patch detected`);
  }
  if (originalCount !== 1) {
    throw new Error(`${filePath}: ${label} target count is ${originalCount}, expected 1`);
  }
  return false;
}

function assertRepeatedExactContract({
  content,
  filePath,
  marker,
  patchedPattern,
  originalPattern,
  label,
}) {
  const markerCount = countOccurrences(content, marker);
  const patchedCount = matchCount(content, patchedPattern);
  const originalCount = matchCount(content, originalPattern);
  if (markerCount > 0 || patchedCount > 0) {
    if (markerCount > 0 && markerCount === patchedCount && originalCount === 0) return true;
    throw new Error(`${filePath}: historical or partial ${label} patch detected`);
  }
  if (originalCount < 1) {
    throw new Error(`${filePath}: ${label} target is missing`);
  }
  return false;
}

function exactConfiguredAssignmentPattern(constantName, marker) {
  return new RegExp(
    `((?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*)${escapeRegExp(resolveConfiguredTimeoutExpression(constantName))}\\/\\*${marker}\\*\\/(\\s*[,;])`,
    'g',
  );
}

function transformBounds(content, filePath) {
  if (
    verifyGatewayBundleContracts(content, filePath, [
      { label: 'plugin approval default timeout', pattern: BUNDLE_DEFAULT_PATTERN },
      { expected: 2, label: 'plugin approval max-timeout', pattern: BUNDLE_MAX_PATTERN },
    ])
  ) {
    return content;
  }
  const patchedDefaultPattern = new RegExp(
    `(DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS(?:\\$\\d+)?\\s*=\\s*)${escapeRegExp(resolveConfiguredTimeoutExpression('12e4'))}\\/\\*${MARKERS.default}\\*\\/`,
    'g',
  );
  const patchedMaxPattern = new RegExp(
    `(MAX_PLUGIN_APPROVAL_TIMEOUT_MS(?:\\$\\d+)?\\s*=\\s*)${escapeRegExp(resolveConfiguredTimeoutExpression('6e5'))}\\/\\*${MARKERS.max}\\*\\/`,
    'g',
  );
  const hasDefaultContract =
    countOccurrences(content, MARKERS.default) > 0 ||
    matchCount(content, patchedDefaultPattern) > 0 ||
    matchCount(content, DEFAULT_PATTERN) > 0;
  const defaultPatched = hasDefaultContract
    ? assertExactContract({
        content,
        filePath,
        marker: MARKERS.default,
        patchedPattern: patchedDefaultPattern,
        originalPattern: DEFAULT_PATTERN,
        label: 'plugin approval default timeout',
      })
    : null;
  const maxPatched = assertRepeatedExactContract({
    content,
    filePath,
    marker: MARKERS.max,
    patchedPattern: patchedMaxPattern,
    originalPattern: MAX_PATTERN,
    label: 'plugin approval max-timeout',
  });
  if (defaultPatched !== null && defaultPatched !== maxPatched) {
    throw new Error(`${filePath}: partial plugin approval bounds patch detected`);
  }
  if ((defaultPatched === null || defaultPatched) && maxPatched) return content;
  return content
    .replace(
      DEFAULT_PATTERN,
      `$1${resolveConfiguredTimeoutExpression('12e4')}/*${MARKERS.default}*/`,
    )
    .replace(MAX_PATTERN, `$1${resolveConfiguredTimeoutExpression('6e5')}/*${MARKERS.max}*/`);
}

function transformTransport(content, filePath) {
  if (
    verifyGatewayBundleContracts(content, filePath, [
      { label: 'plugin approval wait transport', pattern: BUNDLE_TRANSPORT_PATTERN },
      {
        label: 'plugin approval registration transport',
        pattern: BUNDLE_REGISTRATION_PATTERN,
      },
    ])
  ) {
    return content;
  }
  const patchedTransportPattern = new RegExp(
    `(function\\s+resolvePluginToolApprovalGatewayTimeoutMs\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)\\s*\\{\\s*return\\s+)\\2===Number\\.MAX_SAFE_INTEGER\\?null:(addTimerTimeoutGraceMs\\(\\2\\s*,\\s*(?:1e4|10_000)\\)\\s*\\?\\?\\s*(?:13e4|DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS\\s*\\+\\s*(?:1e4|10_000)))\\/\\*${MARKERS.transport}\\*\\/(\\s*;?\\s*\\})`,
    'g',
  );
  const patchedRegistrationPattern = new RegExp(
    `(callGatewayTool\\(\\s*(["'\\x60])plugin\\.approval\\.request\\2\\s*,\\s*\\{\\s*timeoutMs\\s*:\\s*)([A-Za-z_$][\\w$]*)===null\\?3e4:\\3\\/\\*${MARKERS.registration}\\*\\/(\\s*\\}\\s*,\\s*\\{\\s*title\\s*:\\s*([A-Za-z_$][\\w$]*)\\.title\\s*,\\s*description\\s*:\\s*\\5\\.description\\s*,\\s*\\.\\.\\.\\5\\.scope)`,
    'g',
  );
  const transportPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.transport,
    patchedPattern: patchedTransportPattern,
    originalPattern: TRANSPORT_PATTERN,
    label: 'plugin approval wait transport',
  });
  const registrationPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.registration,
    patchedPattern: patchedRegistrationPattern,
    originalPattern: REGISTRATION_PATTERN,
    label: 'plugin approval registration transport',
  });
  if (transportPatched !== registrationPatched) {
    throw new Error(`${filePath}: partial plugin approval transport patch detected`);
  }
  if (transportPatched && registrationPatched) return content;
  return content
    .replace(TRANSPORT_PATTERN, `$1$2===Number.MAX_SAFE_INTEGER?null:$3/*${MARKERS.transport}*/$4`)
    .replace(REGISTRATION_PATTERN, `$1$3===null?3e4:$3/*${MARKERS.registration}*/$4`);
}

function transformCliNativeToolApproval(content, filePath) {
  if (
    verifyGatewayBundleContracts(content, filePath, [
      { label: 'CLI plugin approval timeout', pattern: BUNDLE_CLI_TIMEOUT_PATTERN },
      { label: 'CLI plugin approval wait transport', pattern: BUNDLE_CLI_GATEWAY_PATTERN },
      {
        label: 'CLI plugin approval registration transport',
        pattern: BUNDLE_CLI_REGISTRATION_PATTERN,
      },
    ])
  ) {
    return content;
  }
  const timeoutPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.cliTimeout,
    patchedPattern: exactConfiguredAssignmentPattern(
      'DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS',
      MARKERS.cliTimeout,
    ),
    originalPattern: CLI_TIMEOUT_PATTERN,
    label: 'CLI plugin approval timeout',
  });
  const patchedGatewayPattern = new RegExp(
    `((?:(?:const|let)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*)([A-Za-z_$][\\w$]*)===Number\\.MAX_SAFE_INTEGER\\?null:(addTimerTimeoutGraceMs\\(\\s*\\3\\s*,\\s*CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS\\s*\\)\\s*\\?\\?\\s*\\3\\s*\\+\\s*CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS)\\/\\*${MARKERS.cliGateway}\\*\\/`,
    'g',
  );
  const gatewayPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.cliGateway,
    patchedPattern: patchedGatewayPattern,
    originalPattern: CLI_GATEWAY_PATTERN,
    label: 'CLI plugin approval wait transport',
  });
  const patchedRegistrationPattern = new RegExp(
    `(raceCliNativeToolApprovalAbort\\(\\s*callGatewayTool\\(\\s*(["'\\x60])plugin\\.approval\\.request\\2\\s*,\\s*\\{\\s*timeoutMs\\s*:\\s*)([A-Za-z_$][\\w$]*)===null\\?3e4:\\3\\/\\*${MARKERS.cliRegistration}\\*\\/(\\s*\\})`,
    'g',
  );
  const registrationPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.cliRegistration,
    patchedPattern: patchedRegistrationPattern,
    originalPattern: CLI_REGISTRATION_PATTERN,
    label: 'CLI plugin approval registration transport',
  });
  if (new Set([timeoutPatched, gatewayPatched, registrationPatched]).size !== 1) {
    throw new Error(`${filePath}: partial CLI plugin approval timeout patch detected`);
  }
  if (timeoutPatched && gatewayPatched && registrationPatched) return content;
  return content
    .replace(
      CLI_TIMEOUT_PATTERN,
      `$1${resolveConfiguredTimeoutExpression('DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS')}/*${MARKERS.cliTimeout}*/$3`,
    )
    .replace(CLI_GATEWAY_PATTERN, `$1$4===Number.MAX_SAFE_INTEGER?null:$3/*${MARKERS.cliGateway}*/`)
    .replace(CLI_REGISTRATION_PATTERN, `$1$3===null?3e4:$3/*${MARKERS.cliRegistration}*/$4`);
}

function relayRequestPattern(timeoutName, patched = false) {
  const value = patched
    ? `${escapeRegExp(timeoutName)}===Number\\.MAX_SAFE_INTEGER\\?3e4:${escapeRegExp(timeoutName)}\\s*\\+\\s*(?:1e4|10_000)\\/\\*${MARKERS.relayRegistration}\\*\\/`
    : `(?:13e4|${escapeRegExp(timeoutName)}\\s*\\+\\s*(?:1e4|10_000))`;
  return new RegExp(
    `(callGatewayTool\\(\\s*(["'\\x60])plugin\\.approval\\.request\\2\\s*,\\s*\\{\\s*timeoutMs\\s*:\\s*)${value}(\\s*\\}\\s*,\\s*\\{\\s*pluginId\\s*:\\s*\\x60openclaw-native-hook-relay-)`,
    'g',
  );
}

function relayWaitPattern(patched = false) {
  const value = patched
    ? `([A-Za-z_$][\\w$]*)\\.timeoutMs===Number\\.MAX_SAFE_INTEGER\\?null:\\3\\.timeoutMs\\s*\\+\\s*(?:1e4|10_000)\\/\\*${MARKERS.relayWait}\\*\\/`
    : `([A-Za-z_$][\\w$]*)\\.timeoutMs\\s*\\+\\s*(?:1e4|10_000)`;
  return new RegExp(
    `(callGatewayTool\\(\\s*(["'\\x60])plugin\\.approval\\.waitDecision\\2\\s*,\\s*\\{\\s*timeoutMs\\s*:\\s*)${value}(\\s*\\}\\s*,\\s*\\{\\s*id\\s*:\\s*\\3\\.approvalId)`,
    'g',
  );
}

function transformNativeHookRelayApproval(content, filePath) {
  if (
    verifyGatewayBundleContracts(content, filePath, [
      {
        label: 'native-hook-relay plugin approval timeout',
        pattern: BUNDLE_RELAY_TIMEOUT_PATTERN,
      },
      {
        label: 'native-hook-relay plugin approval registration transport',
        pattern: BUNDLE_RELAY_REGISTRATION_PATTERN,
      },
      {
        label: 'native-hook-relay plugin approval wait transport',
        pattern: BUNDLE_RELAY_WAIT_PATTERN,
      },
    ])
  ) {
    return content;
  }
  const patchedTimeoutPattern = exactConfiguredAssignmentPattern(
    'DEFAULT_PERMISSION_TIMEOUT_MS',
    MARKERS.relayTimeout,
  );
  const patchedTimeoutMatch = [...content.matchAll(patchedTimeoutPattern)];
  const originalTimeoutMatch = [...content.matchAll(RELAY_TIMEOUT_PATTERN)];
  const timeoutName = (patchedTimeoutMatch[0] ?? originalTimeoutMatch[0])?.[2];
  if (!timeoutName) {
    throw new Error(`${filePath}: native-hook-relay plugin approval timeout target is missing`);
  }
  const timeoutPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.relayTimeout,
    patchedPattern: patchedTimeoutPattern,
    originalPattern: RELAY_TIMEOUT_PATTERN,
    label: 'native-hook-relay plugin approval timeout',
  });
  const requestOriginalPattern = relayRequestPattern(timeoutName);
  const requestPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.relayRegistration,
    patchedPattern: relayRequestPattern(timeoutName, true),
    originalPattern: requestOriginalPattern,
    label: 'native-hook-relay plugin approval registration transport',
  });
  const waitOriginalPattern = relayWaitPattern();
  const waitPatched = assertExactContract({
    content,
    filePath,
    marker: MARKERS.relayWait,
    patchedPattern: relayWaitPattern(true),
    originalPattern: waitOriginalPattern,
    label: 'native-hook-relay plugin approval wait transport',
  });
  if (new Set([timeoutPatched, requestPatched, waitPatched]).size !== 1) {
    throw new Error(
      `${filePath}: partial native-hook-relay plugin approval timeout patch detected`,
    );
  }
  if (timeoutPatched && requestPatched && waitPatched) return content;
  return content
    .replace(
      RELAY_TIMEOUT_PATTERN,
      `$1${resolveConfiguredTimeoutExpression('DEFAULT_PERMISSION_TIMEOUT_MS')}/*${MARKERS.relayTimeout}*/$3`,
    )
    .replace(
      requestOriginalPattern,
      `$1${timeoutName}===Number.MAX_SAFE_INTEGER?3e4:${timeoutName}+1e4/*${MARKERS.relayRegistration}*/$3`,
    )
    .replace(
      waitOriginalPattern,
      `$1$3.timeoutMs===Number.MAX_SAFE_INTEGER?null:$3.timeoutMs+1e4/*${MARKERS.relayWait}*/$4`,
    );
}

function expectedBoundsTargetCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 4 : 3;
}

function expectedTransportTargetCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function locateTargets(runtimeDir, terms, markerValues, expected, label) {
  const targets = new Set(findFilesContaining(runtimeDir, terms));
  for (const marker of markerValues) {
    for (const filePath of findFilesContaining(runtimeDir, [marker])) targets.add(filePath);
  }
  if (targets.size !== expected) {
    throw new Error(`${label} target count is ${targets.size}, expected ${expected}`);
  }
  return [...targets];
}

function locateBoundsTargets(runtimeDir) {
  const candidates = new Set(findFilesContaining(runtimeDir, ['MAX_PLUGIN_APPROVAL_TIMEOUT_MS']));
  for (const marker of [MARKERS.default, MARKERS.max]) {
    for (const filePath of findFilesContaining(runtimeDir, [marker])) candidates.add(filePath);
  }
  const targets = [...candidates].filter(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return (
      [...content.matchAll(MAX_PATTERN)].length > 0 ||
      content.includes(MARKERS.default) ||
      content.includes(MARKERS.max) ||
      (isGatewayBundlePath(filePath) && content.includes(ENV_NAME))
    );
  });
  const expected = expectedBoundsTargetCount(runtimeDir);
  if (targets.length !== expected) {
    throw new Error(
      `Configurable plugin approval bounds target count is ${targets.length}, expected ${expected}`,
    );
  }
  return targets;
}

function locateAllTargets(runtimeDir) {
  return [
    [locateBoundsTargets(runtimeDir), transformBounds],
    [
      locateTargets(
        runtimeDir,
        ['resolvePluginToolApprovalGatewayTimeoutMs', 'plugin.approval.request'],
        [MARKERS.registration, MARKERS.transport],
        expectedTransportTargetCount(runtimeDir),
        'Configurable plugin approval transport',
      ),
      transformTransport,
    ],
    [
      locateTargets(
        runtimeDir,
        ['requestCliNativeToolApproval', 'CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS'],
        [MARKERS.cliTimeout, MARKERS.cliGateway, MARKERS.cliRegistration],
        expectedTransportTargetCount(runtimeDir),
        'Configurable CLI plugin approval timeout',
      ),
      transformCliNativeToolApproval,
    ],
    [
      locateTargets(
        runtimeDir,
        ['requestNativeHookRelayPermissionApproval', 'DEFAULT_PERMISSION_TIMEOUT_MS'],
        [MARKERS.relayTimeout, MARKERS.relayRegistration, MARKERS.relayWait],
        expectedTransportTargetCount(runtimeDir),
        'Configurable native-hook-relay plugin approval timeout',
      ),
      transformNativeHookRelayApproval,
    ],
  ];
}

function applyPatch(runtimeDir) {
  const changed = new Set();
  for (const [targets, transformer] of locateAllTargets(runtimeDir)) {
    for (const filePath of targets) {
      const original = fs.readFileSync(filePath, 'utf8');
      const updated = transformer(original, filePath);
      if (writeIfChanged(filePath, original, updated))
        changed.add(path.relative(runtimeDir, filePath));
    }
  }
  return [...changed];
}

function verifyPatch(runtimeDir) {
  for (const [targets, transformer] of locateAllTargets(runtimeDir)) {
    for (const filePath of targets) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (transformer(content, filePath) !== content) {
        throw new Error(`${filePath}: configurable plugin approval timeout is incomplete`);
      }
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    ENV_NAME,
    MARKERS,
    MAX_TIMER_TIMEOUT_MS,
    resolveConfiguredTimeoutExpression,
    transformBounds,
    transformCliNativeToolApproval,
    transformNativeHookRelayApproval,
    transformTransport,
  },
};
