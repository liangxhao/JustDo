import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import { describe, expect, test } from 'vitest';

type PatchModule = {
  applyPatch: (runtimeDir: string) => string[];
  verifyPatch: (runtimeDir: string) => void;
  __testing?: Record<string, unknown>;
};

const patchRoot = path.resolve('scripts/patches/v2026.8.2');
const runtimeRoot = path.resolve('vendor/openclaw-runtime/win-x64');
const patchFiles = fs
  .readdirSync(patchRoot)
  .filter(name => /^\d{3}-.*\.cjs$/u.test(name))
  .sort();
const patches = new Map(
  patchFiles.map(name => [name.slice(0, 3), require(path.join(patchRoot, name)) as PatchModule]),
);

const runtimeIsV2026_8_2 = (() => {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'),
    ) as { openclawVersion?: string };
    return info.openclawVersion === 'v2026.8.2';
  } catch {
    return false;
  }
})();

const runtimePatchSetIsCurrent = (() => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'), 'utf8'),
    ) as { patches?: Array<{ file?: string }> };
    return JSON.stringify(
      (manifest.patches ?? []).map(patch => path.basename(patch.file ?? '')),
    ) === JSON.stringify(patchFiles);
  } catch {
    return false;
  }
})();

describe('OpenClaw v2026.8.2 capability patches', () => {
  test('contains exactly the twelve retained capability patches', () => {
    expect(patchFiles).toEqual([
      '001-managed-pip-config-environment.cjs',
      '002-windows-mcp-package-runner.cjs',
      '003-chrome-mcp-launch-diagnostics.cjs',
      '004-chrome-mcp-empty-page-recovery.cjs',
      '005-final-system-prompt-replacements.cjs',
      '006-agent-request-metadata.cjs',
      '007-request-purpose-metadata.cjs',
      '008-app-startup-task-recovery-boundary.cjs',
      '009-memory-force-reembed-opt-in.cjs',
      '010-configurable-exec-approval-timeout.cjs',
      '011-plugin-approval-detail-forwarding.cjs',
      '012-configurable-plugin-approval-timeout.cjs',
    ]);
  });

  test('accepts only exact app-proven managed Python values', () => {
    const testing = patches.get('001')?.__testing as {
      resolveJustDoManagedPipConfigFile: (env: Record<string, string>) => string | undefined;
      resolveJustDoManagedPythonUserBase: (
        env: Record<string, string>,
      ) => string | undefined;
    };
    expect(
      testing.resolveJustDoManagedPipConfigFile({
        PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }),
    ).toBe('C:\\managed\\pip.ini');
    expect(
      testing.resolveJustDoManagedPipConfigFile({
        PIP_CONFIG_FILE: 'C:\\attacker\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }),
    ).toBeUndefined();
    expect(
      testing.resolveJustDoManagedPythonUserBase({
        PYTHONUSERBASE: 'C:\\managed\\python',
        JUSTDO_MANAGED_PYTHON_USER_BASE: 'C:\\managed\\python',
      }),
    ).toBe('C:\\managed\\python');
  });

  test('rewrites only Windows npm and npx Chrome launchers', () => {
    const testing = patches.get('003')?.__testing as {
      resolveJustDoChromeMcpLaunch: (
        command: string,
        args: string[],
        platform: string,
        environment: Record<string, string>,
      ) => { command: string; args: string[]; env?: Record<string, string> };
    };
    const environment = {
      JUSTDO_NPM_BIN_DIR: 'C:\\runtime\\npm',
      JUSTDO_ELECTRON_PATH: 'C:\\app\\electron.exe',
      JUSTDO_WINDOWS_HIDE_PRELOAD: 'C:\\app\\hide-child-process-windows.cjs',
    };
    expect(
      testing.resolveJustDoChromeMcpLaunch('npx.cmd', ['chrome-devtools-mcp'], 'win32', environment),
    ).toMatchObject({
      command: 'C:\\app\\electron.exe',
      args: ['C:\\runtime\\npm\\npx-cli.js', 'chrome-devtools-mcp'],
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    });
    expect(
      testing.resolveJustDoChromeMcpLaunch('npx', ['chrome-devtools-mcp'], 'linux', environment),
    ).toEqual({ command: 'npx', args: ['chrome-devtools-mcp'], env: undefined });
  });

  test('keeps Gateway restarts but retires tasks from a prior JustDo app start', () => {
    const testing = patches.get('008')?.__testing as {
      readJustDoAppStartedAtMs: (value: unknown) => number | undefined;
      isPriorAppActiveTask: (
        task: { status?: string; createdAt?: unknown },
        startedAt: number | undefined,
      ) => boolean;
    };
    expect(testing.readJustDoAppStartedAtMs('200')).toBe(200);
    expect(testing.readJustDoAppStartedAtMs('invalid')).toBeUndefined();
    expect(testing.isPriorAppActiveTask({ status: 'running', createdAt: 100 }, 200)).toBe(true);
    expect(testing.isPriorAppActiveTask({ status: 'queued', createdAt: 200 }, 200)).toBe(false);
    expect(testing.isPriorAppActiveTask({ status: 'completed', createdAt: 100 }, 200)).toBe(
      false,
    );
  });

  test('manual no-cache reindex transform is idempotent and rejects ambiguity', () => {
    const testing = patches.get('009')?.__testing as {
      CACHE_SEED: string;
      FUNCTION_SIGNATURE: string;
      OPT_IN_ENV: string;
      transformMemoryManager: (content: string, filePath: string) => string;
    };
    const source = `class MemoryManager {\n  ${testing.FUNCTION_SIGNATURE}\n    ${testing.CACHE_SEED}\n  }\n}`;
    const transformed = testing.transformMemoryManager(source, 'memory.js');
    expect(transformed).toContain(`process.env.${testing.OPT_IN_ENV} !== "1"`);
    expect(testing.transformMemoryManager(transformed, 'memory.js')).toBe(transformed);
    expect(() =>
      testing.transformMemoryManager(`${source}\n${source}`, 'ambiguous-memory.js'),
    ).toThrow('ambiguous');
  });

  test('configurable exec approval timeout supports finite and true no-expiry waits', () => {
    const testing = patches.get('010')?.__testing as {
      ENV_NAME: string;
      INDEFINITE_EXPIRES_AT_MS: number;
      MARKERS: Record<string, string>;
      resolveJustDoExecApprovalTimeoutMs: (value: unknown, fallback: number) => number;
      transformDefaults: (content: string, filePath: string) => string;
      transformGateway: (content: string, filePath: string) => string;
      transformManager: (content: string, filePath: string) => string;
      transformWait: (content: string, filePath: string) => string;
    };
    expect(testing.resolveJustDoExecApprovalTimeoutMs('600000', 123)).toBe(600_000);
    expect(testing.resolveJustDoExecApprovalTimeoutMs('0', 123)).toBe(
      testing.INDEFINITE_EXPIRES_AT_MS,
    );

    const defaults = [
      'DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;',
      'DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;',
    ].join('\n');
    const patchedDefaults = testing.transformDefaults(defaults, 'exec-runtime.js');
    expect(patchedDefaults).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedDefaults).toContain('Number.MAX_SAFE_INTEGER?3e4');
    expect(testing.transformDefaults(patchedDefaults, 'exec-runtime.js')).toBe(patchedDefaults);

    const wait =
      'callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id })';
    const patchedWait = testing.transformWait(wait, 'exec-request.js');
    expect(patchedWait).toContain('Number.MAX_SAFE_INTEGER?null');
    expect(testing.transformWait(patchedWait, 'exec-request.js')).toBe(patchedWait);

    const gateway =
      'const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;';
    const patchedGateway = testing.transformGateway(gateway, 'gateway.js');
    expect(patchedGateway).toContain('opts?.timeoutMs===null?null');
    expect(testing.transformGateway(patchedGateway, 'gateway.js')).toBe(patchedGateway);

    const manager = [
      'const now = Date.now();',
      'const resolvedTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);',
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });',
    ].join('\n');
    const patchedManager = testing.transformManager(manager, 'approval-manager.js');
    expect(patchedManager).toContain('timeoutMs===Number.MAX_SAFE_INTEGER');
    expect(testing.transformManager(patchedManager, 'approval-manager.js')).toBe(patchedManager);
    expect(() =>
      testing.transformDefaults(
        patchedDefaults.replace('Number.MAX_SAFE_INTEGER', 'Number.MAX_VALUE'),
        'damaged-exec-runtime.js',
      ),
    ).toThrow('historical or partial');
  });

  test('forwards reviewer-only plugin approval detail on both dispatch paths', () => {
    const testing = patches.get('011')?.__testing as {
      MARKER: string;
      transformApprovalDispatch: (content: string, filePath: string) => string;
    };
    const dispatch = [
      'allowedDecisions: approval.allowedDecisions, toolName: params.toolName,',
      'allowedDecisions: approval.allowedDecisions, toolName: params.toolName,',
    ].join('\n');
    const patched = testing.transformApprovalDispatch(dispatch, 'approval-dispatch.js');
    expect(patched.match(new RegExp(testing.MARKER, 'gu'))).toHaveLength(2);
    expect(patched).toContain('...(approval.detail ? { detail: approval.detail } : {})');
    expect(testing.transformApprovalDispatch(patched, 'approval-dispatch.js')).toBe(patched);
    expect(() => testing.transformApprovalDispatch(dispatch.split('\n')[0], 'partial.js')).toThrow(
      'expected 2',
    );
    expect(() =>
      testing.transformApprovalDispatch(
        patched.replace('...(approval.detail ? { detail: approval.detail } : {})', '{}'),
        'damaged-detail.js',
      ),
    ).toThrow('historical or partial');
  });

  test('configurable plugin approval timeout supports long and no-expiry waits', () => {
    const testing = patches.get('012')?.__testing as {
      ENV_NAME: string;
      MARKERS: Record<string, string>;
      transformBounds: (content: string, filePath: string) => string;
      transformCliNativeToolApproval: (content: string, filePath: string) => string;
      transformNativeHookRelayApproval: (content: string, filePath: string) => string;
      transformTransport: (content: string, filePath: string) => string;
    };
    const bounds = [
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;',
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      'const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;',
    ].join('\n');
    const patchedBounds = testing.transformBounds(bounds, 'plugin-approvals.js');
    expect(patchedBounds).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedBounds).toContain('Number.MAX_SAFE_INTEGER');
    expect(patchedBounds).not.toContain('DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4');
    expect(testing.transformBounds(patchedBounds, 'plugin-approvals.js')).toBe(patchedBounds);

    const transport = [
      'function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs) {',
      '  return addTimerTimeoutGraceMs(timeoutMs, 1e4) ?? 13e4;',
      '}',
      'callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, {',
      '  title: approval.title, description: approval.description, ...approval.scope',
    ].join('\n');
    const patchedTransport = testing.transformTransport(transport, 'approval-dispatch.js');
    expect(patchedTransport).toContain('timeoutMs===Number.MAX_SAFE_INTEGER?null');
    expect(patchedTransport).toContain('gatewayTimeoutMs===null?3e4:gatewayTimeoutMs');
    expect(testing.transformTransport(patchedTransport, 'approval-dispatch.js')).toBe(
      patchedTransport,
    );

    const cliApproval = [
      'function waitForCliNativeToolApproval(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.gatewayTimeoutMs }, { id: params.id });',
      '}',
      'async function requestCliNativeToolApproval(params) {',
      '  const timeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;',
      '  const gatewayTimeoutMs = addTimerTimeoutGraceMs(timeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ?? timeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;',
      '  const requestResult = await raceCliNativeToolApprovalAbort(callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, { title: "Run tool" }));',
      '}',
    ].join('\n');
    const patchedCli = testing.transformCliNativeToolApproval(cliApproval, 'cli-approval.js');
    expect(patchedCli).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedCli).toContain('timeoutMs===Number.MAX_SAFE_INTEGER?null');
    expect(patchedCli).toContain('gatewayTimeoutMs===null?3e4:gatewayTimeoutMs');
    expect(testing.transformCliNativeToolApproval(patchedCli, 'cli-approval.js')).toBe(patchedCli);

    const relayApproval = [
      'async function requestNativeHookRelayPermissionApproval(request) {',
      '  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;',
      '  const result = await callGatewayTool("plugin.approval.request", { timeoutMs: timeoutMs + 10_000 }, { pluginId: `openclaw-native-hook-relay-${request.provider}` });',
      '}',
      'async function waitForNativeHookRelayApprovalDecision(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 10_000 }, { id: params.approvalId });',
      '}',
    ].join('\n');
    const patchedRelay = testing.transformNativeHookRelayApproval(
      relayApproval,
      'native-hook-relay.js',
    );
    expect(patchedRelay).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedRelay).toContain('timeoutMs===Number.MAX_SAFE_INTEGER?3e4');
    expect(patchedRelay).toContain('params.timeoutMs===Number.MAX_SAFE_INTEGER?null');
    expect(testing.transformNativeHookRelayApproval(patchedRelay, 'native-hook-relay.js')).toBe(
      patchedRelay,
    );
    expect(() =>
      testing.transformCliNativeToolApproval(
        patchedCli.replace(`process.env.${testing.ENV_NAME}`, 'process.env.WRONG_TIMEOUT'),
        'damaged-cli-approval.js',
      ),
    ).toThrow('historical or partial');
  });

  test('applies and verifies approval patches against a portable pristine runtime fixture', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-patches-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(distRoot, { recursive: true });
    const commonSource = [
      'const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;',
      'const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;',
      'async function resolveRegisteredExecApprovalDecision() {',
      '  return callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id });',
      '}',
      'const APPROVAL_RUNTIME_METHODS = [];',
      'function resolveGatewayOptions() {',
      '  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;',
      '}',
      'const approvalWarning = "approval expiry is unavailable";',
      'const now = Date.now();',
      'const resolvedTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);',
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });',
      'async function requestPluginToolApproval() {',
      '  const embedded = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '  const gateway = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '}',
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;',
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      'function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs) {',
      '  return addTimerTimeoutGraceMs(timeoutMs, 1e4) ?? 13e4;',
      '}',
      'callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, { title: approval.title, description: approval.description, ...approval.scope });',
      'function waitForCliNativeToolApproval(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.gatewayTimeoutMs }, { id: params.id });',
      '}',
      'async function requestCliNativeToolApproval(params) {',
      '  const cliTimeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;',
      '  const cliGatewayTimeoutMs = addTimerTimeoutGraceMs(cliTimeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ?? cliTimeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;',
      '  const result = await raceCliNativeToolApprovalAbort(callGatewayTool("plugin.approval.request", { timeoutMs: cliGatewayTimeoutMs }, { title: "Run tool" }));',
      '}',
      'const DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;',
      'async function requestNativeHookRelayPermissionApproval(request) {',
      '  const relayTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;',
      '  return callGatewayTool("plugin.approval.request", { timeoutMs: relayTimeoutMs + 10_000 }, { pluginId: `openclaw-native-hook-relay-${request.provider}` });',
      '}',
      'async function waitForNativeHookRelayApprovalDecision(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 10_000 }, { id: params.approvalId });',
      '}',
    ].join('\n');

    try {
      const commonFiles = [path.join(distRoot, 'runtime-a.js'), path.join(distRoot, 'runtime-b.js')];
      for (const filePath of commonFiles) fs.writeFileSync(filePath, commonSource);
      fs.writeFileSync(
        path.join(distRoot, 'plugin-bounds-only.js'),
        'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS$1 = 6e5;',
      );

      for (const id of ['010', '011', '012']) {
        const patch = patches.get(id);
        expect(patch).toBeDefined();
        expect(patch!.applyPatch(fixtureRoot).length).toBeGreaterThan(0);
        expect(() => patch!.verifyPatch(fixtureRoot)).not.toThrow();
        expect(patch!.applyPatch(fixtureRoot)).toEqual([]);
      }

      const target = commonFiles[0];
      const exactPatched = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(
        target,
        exactPatched.replace('Number.MAX_SAFE_INTEGER', 'Number.MAX_VALUE'),
      );
      expect(() => patches.get('010')!.verifyPatch(fixtureRoot)).toThrow(
        'historical or partial',
      );
      fs.writeFileSync(target, exactPatched);

      fs.writeFileSync(
        target,
        exactPatched.replace('...(approval.detail ? { detail: approval.detail } : {})', '{}'),
      );
      expect(() => patches.get('011')!.verifyPatch(fixtureRoot)).toThrow(
        'historical or partial',
      );
      fs.writeFileSync(target, exactPatched);

      fs.writeFileSync(
        target,
        exactPatched.replace(
          `justDoPluginApprovalTimeout=process.env.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS`,
          'justDoPluginApprovalTimeout=process.env.WRONG_TIMEOUT',
        ),
      );
      expect(() => patches.get('012')!.verifyPatch(fixtureRoot)).toThrow(
        'historical or partial',
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('verifies approval contracts after esbuild reformats the patched sources', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-bundle-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(distRoot, { recursive: true });
    const commonSource = [
      'const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;',
      'const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;',
      'async function resolveRegisteredExecApprovalDecision() {',
      '  return callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id });',
      '}',
      'const APPROVAL_RUNTIME_METHODS = [];',
      'function resolveGatewayOptions() {',
      '  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;',
      '}',
      'const approvalWarning = "approval expiry is unavailable";',
      'const now = Date.now();',
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });',
      'async function requestPluginToolApproval() {',
      '  const embedded = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '  const gateway = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '}',
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;',
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      'function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs) {',
      '  return addTimerTimeoutGraceMs(timeoutMs, 1e4) ?? 13e4;',
      '}',
      'callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, { title: approval.title, description: approval.description, ...approval.scope });',
      'function waitForCliNativeToolApproval(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.gatewayTimeoutMs }, { id: params.id });',
      '}',
      'async function requestCliNativeToolApproval(params) {',
      '  const cliTimeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;',
      '  const cliGatewayTimeoutMs = addTimerTimeoutGraceMs(cliTimeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ?? cliTimeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;',
      '  const result = await raceCliNativeToolApprovalAbort(callGatewayTool("plugin.approval.request", { timeoutMs: cliGatewayTimeoutMs }, { title: "Run tool" }));',
      '}',
      'const DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;',
      'async function requestNativeHookRelayPermissionApproval(request) {',
      '  const relayTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;',
      '  return callGatewayTool("plugin.approval.request", { timeoutMs: relayTimeoutMs + 10_000 }, { pluginId: `openclaw-native-hook-relay-${request.provider}` });',
      '}',
      'async function waitForNativeHookRelayApprovalDecision(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 10_000 }, { id: params.approvalId });',
      '}',
    ].join('\n');

    try {
      const commonFiles = [path.join(distRoot, 'runtime-a.js'), path.join(distRoot, 'runtime-b.js')];
      for (const filePath of commonFiles) fs.writeFileSync(filePath, commonSource);
      fs.writeFileSync(
        path.join(distRoot, 'plugin-bounds-only.js'),
        'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      );

      for (const id of ['010', '011', '012']) {
        const patch = patches.get(id);
        expect(patch).toBeDefined();
        expect(patch!.applyPatch(fixtureRoot).length).toBeGreaterThan(0);
      }

      const entryPath = path.join(fixtureRoot, 'entry.js');
      fs.writeFileSync(
        entryPath,
        [
          "import './dist/runtime-a.js';",
          "import './dist/plugin-bounds-only.js';",
        ].join('\n'),
      );
      const bundle = buildSync({
        bundle: true,
        entryPoints: [entryPath],
        format: 'esm',
        legalComments: 'none',
        platform: 'node',
        treeShaking: false,
        write: false,
      }).outputFiles[0].text;
      fs.writeFileSync(path.join(fixtureRoot, 'gateway-bundle.mjs'), bundle);

      const execTesting = patches.get('010')?.__testing as {
        MARKERS: Record<string, string>;
        transformDefaults: (content: string, filePath: string) => string;
      };
      const detailTesting = patches.get('011')?.__testing as {
        transformApprovalDispatch: (content: string, filePath: string) => string;
      };
      const pluginTimeoutTesting = patches.get('012')?.__testing as {
        transformBounds: (content: string, filePath: string) => string;
      };
      expect(bundle).not.toContain(execTesting.MARKERS.defaults);
      for (const id of ['010', '011', '012']) {
        const patch = patches.get(id)!;
        expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
        expect(patch.applyPatch(fixtureRoot)).toEqual([]);
      }

      expect(() =>
        execTesting.transformDefaults(
          bundle.replace('justDoApprovalTimeout === "0"', 'justDoApprovalTimeout === " 0 "'),
          'gateway-bundle.mjs',
        ),
      ).toThrow('historical or partial');
      expect(() =>
        detailTesting.transformApprovalDispatch(
          bundle.replace(
            '...approval.detail ? { detail: approval.detail } : {}',
            '...{}',
          ),
          'gateway-bundle.mjs',
        ),
      ).toThrow('historical or partial');
      expect(() =>
        pluginTimeoutTesting.transformBounds(
          bundle.replace(
            'justDoPluginApprovalTimeout = process.env.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS',
            'justDoPluginApprovalTimeout = process.env.WRONG_APPROVAL_TIMEOUT_MS',
          ),
          'gateway-bundle.mjs',
        ),
      ).toThrow('historical or partial');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(!runtimeIsV2026_8_2 || !runtimePatchSetIsCurrent)(
    'verifies source, worker, and esbuild bundle contracts idempotently',
    () => {
      for (const patch of patches.values()) {
        expect(() => patch.verifyPatch(runtimeRoot)).not.toThrow();
      }
    },
    120_000,
  );
});
