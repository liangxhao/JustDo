import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, test } from 'vitest';

const chromePatch =
  require('../../../../scripts/patches/v2026.7.1-2/007-chrome-mcp-launch-diagnostics.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
    __testing: {
      resolveJustDoChromeMcpLaunch: (
        command: string,
        args: string[],
        platform: string,
        environment: Record<string, string | undefined>,
      ) => { command: string; args: string[]; env?: Record<string, string> };
    };
  };

const windowsMcpPackageRunnerPatch =
  require('../../../../scripts/patches/v2026.7.1-2/006-windows-mcp-package-runner.cjs') as {
    __testing: { WINDOWS_PREPARE: string };
  };

const contextBudgetPatch =
  require('../../../../scripts/patches/v2026.7.1-2/034-live-context-budget-publication.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
    __testing: {
      shouldPublishJustDoLiveContextBudgetStatus: (
        entry: { sessionId?: string; contextBudgetStatus?: { updatedAt?: number } },
        params: {
          sessionId?: string;
          status?: { updatedAt?: number };
          inputProvenance?: { kind?: string; sourceTool?: string };
        },
      ) => boolean;
    };
  };

const managedPipPatch =
  require('../../../../scripts/patches/v2026.7.1-2/001-managed-pip-config-environment.cjs') as {
    applyPatch: (runtimeRoot: string) => string[];
    verifyPatch: (runtimeRoot: string) => void;
    __testing: {
      resolveJustDoManagedPipConfigFile: (
        baseEnv: Record<string, string | undefined>,
      ) => string | undefined;
    };
  };

const historyProjectionPatch =
  require('../../../../scripts/patches/v2026.7.1-2/004-history-display-projection.cjs') as {
    __testing: { PROJECT_MIXED_CONTENT: string };
  };

const temporaryRoots: string[] = [];

function createRuntime(): string {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-patch-safety-'));
  temporaryRoots.push(runtimeRoot);
  fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
  return runtimeRoot;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenClaw v2026.7.1-2 patch safety guards', () => {
  test('accepts only an exact non-empty app-managed pip config value', () => {
    const resolveManagedPip = managedPipPatch.__testing.resolveJustDoManagedPipConfigFile;

    expect(
      resolveManagedPip({
        PIP_CONFIG_FILE: 'C:\\JustDo\\dependency-config\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\JustDo\\dependency-config\\pip.ini',
      }),
    ).toBe('C:\\JustDo\\dependency-config\\pip.ini');
    expect(resolveManagedPip({ PIP_CONFIG_FILE: 'C:\\untrusted\\pip.ini' })).toBeUndefined();
    expect(
      resolveManagedPip({
        PIP_CONFIG_FILE: 'C:\\untrusted\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\JustDo\\dependency-config\\pip.ini',
      }),
    ).toBeUndefined();
    expect(
      resolveManagedPip({ PIP_CONFIG_FILE: '', JUSTDO_MANAGED_PIP_CONFIG_FILE: '' }),
    ).toBeUndefined();
    expect(
      resolveManagedPip({
        PIP_CONFIG_FILE: 'C:\\untrusted\\pip.ini',
        justdo_managed_pip_config_file: 'C:\\untrusted\\pip.ini',
      }),
    ).toBeUndefined();
  });

  test('keeps the native pip deny-list and restores only app-proven base environment values', () => {
    const runtimeRoot = createRuntime();
    const target = path.join(runtimeRoot, 'dist', 'host-env-security.js');
    fs.writeFileSync(
      target,
      `const dangerousEnvironment = [
\t\t"PIP_CONFIG_FILE",
];
function sanitizeHostExecEnvWithDiagnostics(params) {
\tconst baseEnv = params?.baseEnv ?? process.env;
\tconst merged = {};
\tfor (const [key, value] of listNormalizedEnvEntries(baseEnv)) {
\t\tconst sanitizedEntry = sanitizeHostInheritedEnvEntry(key, value);
\t\tif (!sanitizedEntry) continue;
\t\tconst [sanitizedKey, sanitizedValue] = sanitizedEntry;
\t\tmerged[sanitizedKey] = sanitizedValue;
\t}
\tconst overrideResult = sanitizeHostEnvOverridesWithDiagnostics({ overrides: params?.overrides });
\tif (overrideResult.acceptedOverrides) for (const [key, value] of Object.entries(overrideResult.acceptedOverrides)) merged[key] = value;
\treturn {
\t\tenv: markOpenClawExecEnv(merged),
\t\trejectedOverrideBlockedKeys: overrideResult.rejectedOverrideBlockedKeys,
\t\trejectedOverrideInvalidKeys: overrideResult.rejectedOverrideInvalidKeys
\t};
}
`,
    );

    expect(managedPipPatch.applyPatch(runtimeRoot)).toEqual([
      path.join('dist', 'host-env-security.js'),
    ]);
    managedPipPatch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target, 'utf8');
    expect(once).toContain('"PIP_CONFIG_FILE",');

    const executeSanitizer = (
      baseEnv: Record<string, string>,
      overrides?: Record<string, string>,
    ) =>
      vm.runInNewContext(`${once}\nsanitizeHostExecEnvWithDiagnostics(params)`, {
        params: { baseEnv, overrides },
        process: { env: {} },
        listNormalizedEnvEntries: Object.entries,
        sanitizeHostInheritedEnvEntry: (key: string, value: string) =>
          key === 'PIP_CONFIG_FILE' ? null : [key, value],
        sanitizeHostEnvOverridesWithDiagnostics: ({
          overrides: candidateOverrides,
        }: {
          overrides?: Record<string, string>;
        }) => ({
          acceptedOverrides: Object.fromEntries(
            Object.entries(candidateOverrides ?? {}).filter(([key]) => key !== 'PIP_CONFIG_FILE'),
          ),
          rejectedOverrideBlockedKeys: candidateOverrides?.PIP_CONFIG_FILE
            ? ['PIP_CONFIG_FILE']
            : [],
          rejectedOverrideInvalidKeys: [],
        }),
        markOpenClawExecEnv: (env: Record<string, string>) => env,
      }) as { env: Record<string, string> };

    expect(executeSanitizer({ PIP_CONFIG_FILE: 'C:\\untrusted\\pip.ini' }).env).not.toHaveProperty(
      'PIP_CONFIG_FILE',
    );
    expect(
      executeSanitizer({
        PIP_CONFIG_FILE: 'C:\\untrusted\\pip.ini',
        justdo_managed_pip_config_file: 'C:\\untrusted\\pip.ini',
      }).env,
    ).toEqual({});
    expect(
      executeSanitizer({
        PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }).env,
    ).toEqual({ PIP_CONFIG_FILE: 'C:\\managed\\pip.ini' });
    expect(
      executeSanitizer(
        {},
        {
          PIP_CONFIG_FILE: 'C:\\override\\pip.ini',
          SAFE_VALUE: 'kept',
        },
      ).env,
    ).toEqual({ SAFE_VALUE: 'kept' });

    expect(managedPipPatch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(once);
  });

  test('preserves every native assistant text content type in mixed tool history', () => {
    const project = vm.runInNewContext(
      `${historyProjectionPatch.__testing.PROJECT_MIXED_CONTENT}\nprojectAssistantTextFromMixedToolContent`,
      {
        isToolHistoryBlockType: (type: string) => type === 'toolCall',
        isAssistantTextContentType: (type: string) =>
          type === 'text' || type === 'input_text' || type === 'output_text',
        truncateChatHistoryText: (text: string) => ({ text }),
        stripInlineDirectiveTagsForDisplay: (text: string) => ({ text }),
      },
    ) as (
      content: Array<Record<string, unknown>>,
      maxChars: number,
    ) => { content: Array<Record<string, unknown>> };

    const result = project(
      [
        { type: 'input_text', text: 'input', source: 'native' },
        { type: 'toolCall', id: 'tool-1' },
        { type: 'output_text', text: 'output', source: 'native' },
      ],
      1_000,
    );

    expect(result.content).toEqual([
      { type: 'input_text', text: 'input', source: 'native' },
      { type: 'toolCall', id: 'tool-1' },
      { type: 'output_text', text: 'output', source: 'native' },
    ]);
  });

  test.each([
    ['npm', 'npm-cli.js'],
    ['npm.cmd', 'npm-cli.js'],
    ['NPX', 'npx-cli.js'],
    ['npx.cmd', 'npx-cli.js'],
  ])('maps the Windows package runner %s to its matching CLI', (command, cliName) => {
    const launch = chromePatch.__testing.resolveJustDoChromeMcpLaunch(
      command,
      ['package-name'],
      'win32',
      {
        JUSTDO_NPM_BIN_DIR: 'C:\\managed-npm\\',
        JUSTDO_ELECTRON_PATH: 'C:\\JustDo\\electron.exe',
        PATH: 'C:\\Windows',
      },
    );

    expect(launch.command).toBe('C:\\JustDo\\electron.exe');
    expect(launch.args).toEqual([`C:\\managed-npm\\${cliName}`, 'package-name']);
    expect(launch.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:\\Windows',
    });
  });

  test('restores the app-owned windows-hide preload for nested npm package bins', () => {
    const resolveLaunch = vm.runInNewContext(
      `(function (process, baseEnv, prepareOomScoreAdjustedSpawn) {
        ${windowsMcpPackageRunnerPatch.__testing.WINDOWS_PREPARE}
        return { spawnCommand, spawnArgs, spawnEnv };
      })`,
    ) as (...args: unknown[]) => {
      spawnCommand: string;
      spawnArgs: string[];
      spawnEnv: Record<string, string>;
    };
    const processValue = {
      platform: 'win32',
      env: {
        JUSTDO_NPM_BIN_DIR: 'C:\\managed-npm',
        JUSTDO_ELECTRON_PATH: 'C:\\JustDo\\electron.exe',
        JUSTDO_WINDOWS_HIDE_PRELOAD: 'C:/JustDo/hide-child-process-windows.cjs',
      },
    };

    const launch = Reflect.apply(
      resolveLaunch,
      { serverParams: { command: 'npx', args: ['-y', 'package'] } },
      [processValue, { PATH: 'C:\\Windows' }, () => ({})],
    );

    expect(launch.spawnCommand).toBe('C:\\JustDo\\electron.exe');
    expect(launch.spawnArgs).toEqual(['C:\\managed-npm\\npx-cli.js', '-y', 'package']);
    expect(launch.spawnEnv).toEqual({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require="C:/JustDo/hide-child-process-windows.cjs"',
    });

    processValue.env.JUSTDO_WINDOWS_HIDE_PRELOAD = 'C:/untrusted/preload.cjs';
    const invalidPreloadLaunch = Reflect.apply(
      resolveLaunch,
      { serverParams: { command: 'npx', args: ['package'] } },
      [processValue, { PATH: 'C:\\Windows' }, () => ({})],
    );
    expect(invalidPreloadLaunch.spawnEnv).toEqual({
      PATH: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  test.each([
    ['node', 'win32', true, true],
    ['npx', 'linux', true, true],
    ['npx', 'win32', false, true],
    ['npx', 'win32', true, false],
  ])(
    'does not inject Electron environment for command=%s platform=%s npmBin=%s electron=%s',
    (command, platform, hasNpmBin, hasElectron) => {
      const launch = chromePatch.__testing.resolveJustDoChromeMcpLaunch(
        command,
        ['arg'],
        platform,
        {
          ...(hasNpmBin ? { JUSTDO_NPM_BIN_DIR: 'C:\\npm' } : {}),
          ...(hasElectron ? { JUSTDO_ELECTRON_PATH: 'C:\\electron.exe' } : {}),
        },
      );

      expect(launch).toEqual({ command, args: ['arg'], env: undefined });
    },
  );

  test('embeds the same Chrome launch resolver and keeps early stderr capture byte-stable', () => {
    const runtimeRoot = createRuntime();
    const target = path.join(runtimeRoot, 'dist', 'chrome-mcp.js');
    fs.writeFileSync(
      target,
      `async function createRealSession(profileName, options) {
\tconst transport = new StdioClientTransport({
\t\tcommand: options.command,
\t\targs: buildChromeMcpArgsFromOptions(options),
\t\tstderr: "pipe"
\t});
\tlet getStderr = () => "";
\tawait client.connect(transport);
\t\t\t\tgetStderr = drainStderr(transport);
\tthrow new Error("Chrome MCP attach failed for profile");
}
`,
    );

    expect(chromePatch.applyPatch(runtimeRoot)).toEqual([path.join('dist', 'chrome-mcp.js')]);
    chromePatch.verifyPatch(runtimeRoot);
    const once = fs.readFileSync(target);
    expect(once.toString()).toContain(
      chromePatch.__testing.resolveJustDoChromeMcpLaunch.toString(),
    );
    expect(once.toString()).toContain('const getStderr = drainStderr(transport);');

    expect(chromePatch.applyPatch(runtimeRoot)).toEqual([]);
    expect(fs.readFileSync(target)).toEqual(once);
  });

  test('rejects missing/replaced sessions and stale or equal-timestamp context status writes', () => {
    const shouldPublish = contextBudgetPatch.__testing.shouldPublishJustDoLiveContextBudgetStatus;
    const current = {
      sessionId: 'session-current',
      contextBudgetStatus: { updatedAt: 200 },
    };

    expect(
      shouldPublish(undefined as never, {
        sessionId: 'session-current',
        status: { updatedAt: 201 },
      }),
    ).toBe(false);
    expect(
      shouldPublish(
        { contextBudgetStatus: { updatedAt: 200 } },
        {
          sessionId: 'session-current',
          status: { updatedAt: 201 },
        },
      ),
    ).toBe(false);
    expect(
      shouldPublish(current, {
        sessionId: 'session-replaced',
        status: { updatedAt: 201 },
      }),
    ).toBe(false);
    expect(
      shouldPublish(current, {
        sessionId: 'session-current',
        status: { updatedAt: 199 },
      }),
    ).toBe(false);
    expect(
      shouldPublish(current, {
        sessionId: 'session-current',
        status: { updatedAt: 200 },
      }),
    ).toBe(false);
    expect(
      shouldPublish(current, {
        sessionId: 'session-current',
        status: { updatedAt: Number.NaN },
      }),
    ).toBe(false);
    expect(
      shouldPublish(current, {
        sessionId: 'session-current',
        status: { updatedAt: 201 },
      }),
    ).toBe(true);
    for (const sourceTool of [
      'agent_harness_task',
      'image_generate',
      'music_generate',
      'video_generate',
      'subagent_announce',
      'subagent_interrupted_resume',
    ]) {
      expect(
        shouldPublish(current, {
          sessionId: 'session-current',
          status: { updatedAt: 201 },
          inputProvenance: { kind: 'inter_session', sourceTool },
        }),
        sourceTool,
      ).toBe(false);
    }
    expect(
      shouldPublish(current, {
        sessionId: 'session-current',
        status: { updatedAt: 201 },
        inputProvenance: { kind: 'external_user', sourceTool: 'subagent_announce' },
      }),
    ).toBe(true);
  });
});
