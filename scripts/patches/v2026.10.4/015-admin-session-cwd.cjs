'use strict';

// Capability: let an authenticated operator.admin client start a sandboxed agent session in an
// explicit task directory while the agent keeps its separate bootstrap workspace.
// Target: openclaw@2026.10.4 sessions.create handler source/bundle.
// Scope: the existing admin-only cwd path; non-admin containment and sandbox runtime policy stay
// unchanged. The native run path already mounts the persisted cwd as the session workspace and
// layers the agent's canonical AGENTS.md/bootstrap files over it.
// Safety: sessions.create already requires operator.admin for cwd paths outside every configured
// agent workspace. This patch only prevents the later per-agent containment check from rejecting
// that already-authorized path.
// Remove when: upstream honors the documented operator.admin cwd contract for sandboxed sessions.

const fs = require('fs');
const path = require('path');
const { countOccurrences, findFilesContaining, isGatewayBundlePath, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'RUNTIME_ADMIN_SESSION_CWD_V2026_10_4';
const NATIVE = 'sessionCwd && !requestedExecNode && p.worktree !== true';
const PATCHED_PATTERN = new RegExp(
  `sessionCwd\\s*&&\\s*!requestedExecNode\\s*&&\\s*!clientScopes\\.includes\\(ADMIN_SCOPE\\)\\s*&&\\s*[A-Za-z_$][\\w$]*\\.worktree\\s*!==\\s*true\\s*\\/\\*${MARKER}\\*\\/`,
);
const NATIVE_PATTERN =
  /sessionCwd\s*&&\s*!requestedExecNode\s*&&\s*([A-Za-z_$][\w$]*)\.worktree\s*!==\s*true/;
const BUNDLED_PATCHED_PATTERN = new RegExp(
  PATCHED_PATTERN.source.replace(`\\s*\\/\\*${MARKER}\\*\\/`, ''),
);

function transform(content, filePath = '<runtime>') {
  const markerCount = countOccurrences(content, MARKER);
  const patchedCount = [...content.matchAll(new RegExp(BUNDLED_PATCHED_PATTERN.source, 'g'))].length;
  const nativeCount = [...content.matchAll(new RegExp(NATIVE_PATTERN.source, 'g'))].length;
  if (markerCount === 1 && patchedCount === 1 && nativeCount === 0 && PATCHED_PATTERN.test(content))
    return content;
  if (markerCount === 0 && patchedCount === 1 && nativeCount === 0 && isGatewayBundlePath(filePath))
    return content;
  if (markerCount !== 0 || patchedCount !== 0) {
    throw new Error(`${filePath}: historical or partial admin session cwd patch`);
  }
  const matches = [...content.matchAll(new RegExp(NATIVE_PATTERN.source, 'g'))];
  if (matches.length !== 1) {
    throw new Error(`${filePath}: admin session cwd anchor count is ${matches.length}, expected 1`);
  }
  return content.replace(
    NATIVE_PATTERN,
    (_match, paramsName) =>
      `sessionCwd && !requestedExecNode && !clientScopes.includes(ADMIN_SCOPE) && ` +
      `${paramsName}.worktree !== true /*${MARKER}*/`,
  );
}

function targets(runtimeDir) {
  const files = new Set(findFilesContaining(runtimeDir, ['enforceSandboxContainment:', NATIVE]));
  for (const filePath of findFilesContaining(runtimeDir, [MARKER])) files.add(filePath);
  for (const filePath of findFilesContaining(runtimeDir, ['enforceSandboxContainment:', '!clientScopes.includes(ADMIN_SCOPE)']))
    if (isGatewayBundlePath(filePath)) files.add(filePath);
  const bundleExists = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  const source = [...files].filter(filePath => path.basename(filePath) !== 'gateway-bundle.mjs');
  const bundle = [...files].filter(filePath => path.basename(filePath) === 'gateway-bundle.mjs');
  if (source.length !== 1 || bundle.length !== (bundleExists ? 1 : 0)) {
    throw new Error(
      `admin session cwd target counts are source=${source.length}, bundle=${bundle.length}; ` +
        `expected source=2, bundle=${bundleExists ? 1 : 0}`,
    );
  }
  return [...source, ...bundle];
}

function applyPatch(runtimeDir) {
  const plans = targets(runtimeDir).map(filePath => {
      const original = fs.readFileSync(filePath, 'utf8');
      return { filePath, original, updated: transform(original, filePath) };
  });
  const current = plans.filter(plan => plan.original === plan.updated);
  if (current.length > 0 && current.length !== plans.length)
    throw new Error('Mixed pristine and patched admin session cwd targets');
  return plans.filter(plan => writeIfChanged(plan.filePath, plan.original, plan.updated))
    .map(plan => path.relative(runtimeDir, plan.filePath));
}

function verifyPatch(runtimeDir) {
  for (const filePath of targets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transform(content, filePath) !== content) {
      throw new Error(`${filePath}: admin session cwd contract is incomplete`);
    }
  }
}

module.exports = { applyPatch, verifyPatch, __testing: { MARKER, PATCHED_PATTERN, transform } };
