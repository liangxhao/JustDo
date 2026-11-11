import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILTIN_SECRET_SOURCE } from '../../../plugins/extensions/runtime-services/contracts/model-auth';
import { MANAGED_PROVIDER_SECRET_SOURCE } from '../openclaw/config/models/providerSecretFile';
import { EXTENSION_SECRET_PROVIDER } from '../plugins/extensions/extensionSecretFile';
import { prepareRelocatedOpenClawConfig } from './relocationPaths';

const source = path.resolve('fixture-source');
const target = path.resolve('fixture-target');
const state = (...segments: string[]) => path.join(source, 'openclaw', 'state', ...segments);
const moved = (...segments: string[]) => path.join(target, 'openclaw', 'state', ...segments);

describe('offline relocation path projection', () => {
  it('reprojects role homes and SecretRef provider paths without changing secret identities', () => {
    const sha = 'a'.repeat(64);
    const input = {
      agents: {
        defaults: { workspace: state('agent-workspaces'), cwd: state('workspace') },
        entries: {
          main: { workspace: state('agent-workspaces', 'main'), cwd: state('workspace'), agentDir: state('custom-agent') },
          worker: {
            workspace: state('agent-workspaces', 'worker'),
            cwd: path.resolve('outside-project'),
          },
        },
      },
      secrets: {
        providers: {
          [MANAGED_PROVIDER_SECRET_SOURCE]: {
            source: 'file',
            path: state('model-provider-secrets.json'),
            mode: 'json',
          },
          [EXTENSION_SECRET_PROVIDER]: {
            source: 'file',
            path: state('extension-secrets.json'),
            mode: 'json',
          },
          [BUILTIN_SECRET_SOURCE]: {
            source: 'exec',
            command: state('credentials', 'runtime', sha, 'node.exe'),
            args: [state('credentials', 'read-builtin.cjs')],
            env: { MODEL_AUTH_SESSION_ID: 'opaque-session' },
          },
        },
      },
      models: {
        providers: {
          acme: {
            apiKey: { source: 'file', provider: MANAGED_PROVIDER_SECRET_SOURCE, id: '/acme' },
          },
        },
      },
      skills: { load: { extraDirs: [state('skills'), path.resolve('outside-skills')] } },
    };
    const original = structuredClone(input);

    const result = prepareRelocatedOpenClawConfig(input, source, target);

    expect(result.agents).toMatchObject({
      defaults: { workspace: moved('agent-workspaces'), cwd: moved('workspace') },
      entries: { main: { workspace: moved('agent-workspaces', 'main'), agentDir: moved('custom-agent') } },
    });
    expect(result.secrets).toMatchObject({
      providers: {
        [MANAGED_PROVIDER_SECRET_SOURCE]: { path: moved('model-provider-secrets.json') },
        [EXTENSION_SECRET_PROVIDER]: { path: moved('extension-secrets.json') },
        [BUILTIN_SECRET_SOURCE]: {
          command: moved('credentials', 'runtime', sha, 'node.exe'),
          args: [moved('credentials', 'read-builtin.cjs')],
          env: { MODEL_AUTH_SESSION_ID: 'opaque-session' },
        },
      },
    });
    expect(result.skills).toEqual({ load: { extraDirs: [moved('skills'), path.resolve('outside-skills')] } });
    expect(result.models).toEqual(input.models);
    expect(input).toEqual(original);
  });

  it('updates secret provider paths within the moved tree without changing other arguments', () => {
    const input = {
      secrets: {
        providers: {
          external: { source: 'file', mode: 'json', path: state('model-provider-secrets.json') },
          [MANAGED_PROVIDER_SECRET_SOURCE]: {
            source: 'file',
            mode: 'json',
            path: state('different.json'),
          },
          [BUILTIN_SECRET_SOURCE]: {
            source: 'exec',
            command: state('credentials', 'custom.exe'),
            args: [state('credentials', 'read-builtin.cjs'), '--custom'],
          },
        },
      },
    };

    const result = prepareRelocatedOpenClawConfig(input, source, target);

    expect(result.secrets).toEqual({
      providers: {
        external: { source: 'file', mode: 'json', path: moved('model-provider-secrets.json') },
        [MANAGED_PROVIDER_SECRET_SOURCE]: {
          source: 'file',
          mode: 'json',
          path: moved('different.json'),
        },
        [BUILTIN_SECRET_SOURCE]: {
          source: 'exec',
          command: moved('credentials', 'custom.exe'),
          args: [moved('credentials', 'read-builtin.cjs'), '--custom'],
        },
      },
    });
  });

  it('keeps project paths outside OpenClaw while moving a configured workspace inside it', () => {
    const input = {
      agents: { defaults: { workspace: state('custom-project'), cwd: path.join(source, 'my-project') } },
      tools: { exec: { command: path.join(source, 'custom.exe') } },
      text: `User text mentioning ${source} must not be rewritten.`,
    };

    const result = prepareRelocatedOpenClawConfig(input, source, target);

    expect(result.agents).toEqual({ defaults: {
      workspace: moved('custom-project'), cwd: path.join(source, 'my-project'),
    } });
    expect(result.tools).toEqual(input.tools);
    expect(result.text).toBe(input.text);
  });

  it('projects plugin locations inside OpenClaw while keeping external locations', () => {
    const relative = path.join('extensions', 'managed');
    const external = path.resolve('external-plugin');
    const original = state(relative);
    const input = {
      plugins: {
        load: { paths: [original, external, state('extensions', 'manual')] },
        installs: {
          managed: { source: 'path', installPath: original, sourcePath: external },
          external: { source: 'path', installPath: external, sourcePath: original },
        },
      },
    };

    const result = prepareRelocatedOpenClawConfig(input, source, target);

    expect(result.plugins).toEqual({
      load: { paths: [moved(relative), external, moved('extensions', 'manual')] },
      installs: {
        managed: { source: 'path', installPath: moved(relative), sourcePath: external },
        external: { source: 'path', installPath: external, sourcePath: moved(relative) },
      },
    });
  });
});
