'use strict';
// Capability: accept Windows servicing ownership for the managed credential launcher.
// Target: pristine openclaw@2026.9.8 exec SecretRef command validation.
// Scope: justdo_login and the exact OS-owned System32 PowerShell executable only.
// Safety: require verified TrustedInstaller ownership and reject every other untrusted writer.
// Remove when: native exec validation recognizes Windows servicing ACLs safely.
const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  findMatchingDelimiter,
  assertCurrentPatchContract,
  writeIfChanged,
  isGatewayBundlePath,
} = require('./_patch-utils.js');
const CONTRACT = 'JUSTDO_WINDOWS_SERVICING_CREDENTIAL_LAUNCHER_V2026_9_8';
const HELPER = `// ${CONTRACT}
async function isJustDoWindowsServicingLauncher(commandPath, params, permissions) {
  if (process.platform !== "win32" || params.label !== "secrets.providers.justdo_login.command" || permissions.source !== "windows-acl") return false;
  const serviceSid = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  if (permissions.ownerSid !== serviceSid) return false;
  const paths = process.getBuiltinModule("node:path");
  const expected = paths.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (paths.resolve(commandPath).toLowerCase() !== paths.resolve(expected).toLowerCase()) return false;
  const { inspectWindowsAcl } = await import("@openclaw/fs-safe/advanced");
  const acl = await inspectWindowsAcl(commandPath);
  return acl.ok && !acl.untrustedWorld.some(entry => entry.canWrite) &&
    acl.untrustedGroup.every(entry => !entry.canWrite || entry.sid === serviceSid);
}
`;
function normalizeHelperShape(source) {
  const aliases = new Map();
  const parameters =
    /function isJustDoWindowsServicingLauncher\(([\w$]+),\s*([\w$]+),\s*([\w$]+)\)/.exec(source);
  if (!parameters) return null;
  ['commandPath', 'params', 'permissions'].forEach((name, index) =>
    aliases.set(parameters[index + 1], name),
  );
  for (const [name, pattern] of [
    [
      'serviceSid',
      /const ([\w$]+) = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"/,
    ],
    ['paths', /const ([\w$]+) = process\.getBuiltinModule\("node:path"\)/],
    ['expected', /const ([\w$]+) = [\w$]+\.join\(process\.env\.SystemRoot/],
    ['acl', /const ([\w$]+) = await [\w$]+\([\w$]+\)/],
  ]) {
    const match = pattern.exec(source);
    if (!match) return null;
    aliases.set(match[1], name);
  }
  source = source.replace(
    /const \{ inspectWindowsAcl(?:: ([\w$]+))? \} = await (?:import\("@openclaw\/fs-safe\/advanced"\)|Promise\.resolve\(\)\.then\(\(\) => \(init_advanced\(\), advanced_exports\)\));/,
    (_match, alias) => {
      aliases.set(alias || 'inspectWindowsAcl', 'inspectWindowsAcl');
      return 'const { inspectWindowsAcl } = SDK_IMPORT;';
    },
  );
  // Arrow callback bindings are local to each predicate; preserve their property
  // accesses and comparison operators while canonicalizing only their names.
  source = source.replace(
    /\.(some|every)\(\(?([\w$]+)\)? => ([^;\n]*?)(?=\)\s*(?:&&|;))/g,
    (_match, method, binding, body) =>
      '.' + method + '(entry => ' + body.replace(new RegExp('\\b' + binding + '\\b', 'g'), 'entry'),
  );
  return source.replace(/\/\/[^\n]*|"(?:\\.|[^"\\])*"|\b[\w$]+\b|\s+/g, token => {
    if (token.startsWith('//') || /^\s+$/.test(token)) return '';
    return aliases.get(token) || token;
  });
}
function verifyHelper(content, file) {
  const start = content.indexOf('async function isJustDoWindowsServicingLauncher(');
  if (start < 0) throw new Error('Incomplete servicing ACL patch');
  const open = content.indexOf('{', start);
  const end = findMatchingDelimiter(content, open, '{', '}', file);
  const shape = normalizeHelperShape(content.slice(start, end + 1));
  if (!shape || shape !== normalizeHelperShape(HELPER))
    throw new Error('Incomplete servicing ACL patch');
}
function transform(content, file) {
  assertCurrentPatchContract(content, CONTRACT, file, false);
  const anchor = 'async function assertSecureExecCommandPath(';
  const start = content.indexOf(anchor),
    open = content.indexOf('{', start);
  const end = findMatchingDelimiter(content, open, '{', '}', file);
  const body = content.slice(start, end + 1);
  if (body.includes('await isJustDoWindowsServicingLauncher(')) {
    assertCurrentPatchContract(content, CONTRACT, file, !isGatewayBundlePath(file));
    verifyHelper(content, file);
    return content;
  }
  const parameter = /assertSecureExecCommandPath\(([\w$]+)\)/.exec(body)?.[1];
  const check = /(?:const|let)\s+([\w$]+)\s*=\s*await inspectPathPermissions\(([\w$]+)\)/.exec(
    body,
  );
  if (!parameter || !check) throw new Error('Credential ACL bindings changed');
  const pattern = new RegExp(
    check[1] + '\\.worldWritable\\s*\\|\\|\\s*' + check[1] + '\\.groupWritable',
    'g',
  );
  if ([...body.matchAll(pattern)].length !== 1) throw new Error('Credential ACL guard changed');
  const next = body.replace(
    pattern,
    match =>
      '(' +
      match +
      ') && !await isJustDoWindowsServicingLauncher(' +
      check[2] +
      ', ' +
      parameter +
      ', ' +
      check[1] +
      ')',
  );
  return content.slice(0, start) + HELPER + next + content.slice(end + 1);
}
function processTargets(root, verify) {
  const files = findFilesContaining(root, 'async function assertSecureExecCommandPath(');
  if (files.length !== (fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 6 : 5))
    throw new Error('Credential ACL target count changed');
  return files.flatMap(file => {
    const before = fs.readFileSync(file, 'utf8'),
      after = transform(before, file);
    if (verify && before !== after) throw new Error('Credential ACL patch missing');
    return !verify && writeIfChanged(file, before, after) ? [path.relative(root, file)] : [];
  });
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, HELPER },
};
